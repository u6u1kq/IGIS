// SPDX-License-Identifier: Apache-2.0

import type { Feature } from "geojson";
import { booleanValid, kinks } from "@turf/turf";
import type { CoreCollection, CoreGeometryKind, GeometryIssue } from "./types.js";

const ISSUE_CAP = 200;

const KIND_LABEL: Readonly<Record<CoreGeometryKind, string>> = {
  point: "点",
  line: "线",
  polygon: "面",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPosition(value: unknown): boolean {
  return Array.isArray(value)
    && value.length >= 2
    && value.length <= 4
    && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function samePosition(left: unknown, right: unknown): boolean {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  return left[0] === right[0] && left[1] === right[1];
}

/** 只看结构：坐标数、闭合。返回中文原因，没有问题时返回 null。 */
function structuralProblem(type: string, coordinates: unknown): string | null {
  if (!Array.isArray(coordinates) || coordinates.length === 0) return "empty";
  if (type === "Point") return isPosition(coordinates) ? null : "点的坐标不完整";
  if (type === "MultiPoint" || type === "LineString") {
    if (!coordinates.every(isPosition)) return "坐标里有非数字";
    if (type === "LineString" && coordinates.length < 2) return "线至少需要两个点";
    return null;
  }
  if (type === "MultiLineString") {
    for (const line of coordinates) {
      const problem = structuralProblem("LineString", line);
      if (problem) return problem === "empty" ? "多线里有空的部分" : problem;
    }
    return null;
  }
  if (type === "Polygon") {
    for (const ring of coordinates) {
      if (!Array.isArray(ring) || ring.length === 0) return "面里有空环";
      if (!ring.every(isPosition)) return "坐标里有非数字";
      if (ring.length < 4) return "面的环至少需要四个点（首尾相同）";
      if (!samePosition(ring[0], ring[ring.length - 1])) return "面的环没有闭合";
    }
    return null;
  }
  if (type === "MultiPolygon") {
    for (const polygon of coordinates) {
      const problem = structuralProblem("Polygon", polygon);
      if (problem) return problem === "empty" ? "多面里有空的部分" : problem;
    }
    return null;
  }
  return "不认识的几何类型";
}

export function geometryKindOfType(type: string): CoreGeometryKind | null {
  if (type === "Point" || type === "MultiPoint") return "point";
  if (type === "LineString" || type === "MultiLineString") return "line";
  if (type === "Polygon" || type === "MultiPolygon") return "polygon";
  return null;
}

/**
 * 检查单个要素。返回的问题按严重程度排序：空、结构无效、自相交、类型混杂。
 * 任何异常都转成问题，不向外抛。
 */
export function inspectFeature(feature: unknown, featureIndex: number, expectedKind: CoreGeometryKind | null = null): GeometryIssue[] {
  const label = `第 ${featureIndex + 1} 个要素`;
  if (!isRecord(feature) || !isRecord(feature.geometry)) {
    return [{ featureIndex, kind: "empty", message: `${label}没有几何，已跳过。` }];
  }
  const geometry = feature.geometry;
  const type = typeof geometry.type === "string" ? geometry.type : "";
  if (type === "GeometryCollection") {
    const members = Array.isArray(geometry.geometries) ? geometry.geometries.length : 0;
    if (members === 0) return [{ featureIndex, kind: "empty", message: `${label}是空的几何集合，已跳过。` }];
    return [{ featureIndex, kind: "mixed", message: `${label}是几何集合，混有多种几何类型。缓冲、相交、裁剪会跳过它。` }];
  }
  const problem = structuralProblem(type, geometry.coordinates);
  if (problem === "empty") return [{ featureIndex, kind: "empty", message: `${label}几何为空，已跳过。` }];
  if (problem) return [{ featureIndex, kind: "invalid", message: `${label}几何无效：${problem}。` }];
  const issues: GeometryIssue[] = [];
  const kind = geometryKindOfType(type);
  if (kind === "line" || kind === "polygon") {
    try {
      const found = kinks(feature as unknown as Feature<never>).features.length;
      if (found > 0) {
        issues.push({ featureIndex, kind: "self-intersection", message: `${label}（${KIND_LABEL[kind]}）自相交 ${found} 处。分析时会跳过它，请先修复。` });
      }
    } catch {
      issues.push({ featureIndex, kind: "invalid", message: `${label}几何无法检查，可能已损坏。` });
    }
  }
  if (issues.length === 0) {
    let valid = true;
    try {
      valid = Boolean(booleanValid(feature as unknown as Feature));
    } catch {
      valid = false;
    }
    if (!valid) issues.push({ featureIndex, kind: "invalid", message: `${label}几何无效（例如洞在外环之外或环方向异常）。` });
  }
  if (expectedKind && kind && kind !== expectedKind) {
    issues.push({
      featureIndex,
      kind: "mixed",
      message: `${label}是${KIND_LABEL[kind]}，和图层的几何类型（${KIND_LABEL[expectedKind]}）不一致。`,
    });
  }
  return issues;
}

function dominantKind(collection: CoreCollection): CoreGeometryKind | null {
  const counts = new Map<CoreGeometryKind, number>();
  for (const feature of collection.features) {
    const kind = geometryKindOfType(feature.geometry?.type ?? "");
    if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  if (counts.size < 2) return null;
  let best: CoreGeometryKind | null = null;
  let bestCount = -1;
  for (const [kind, count] of counts) {
    if (count > bestCount) {
      best = kind;
      bestCount = count;
    }
  }
  return best;
}

export interface CollectionInspection {
  readonly issues: readonly GeometryIssue[];
  readonly truncated: boolean;
  readonly mixed: boolean;
}

/**
 * 检查整个图层。expectedKind 为空时，若图层里有多种几何类型，按占多数的类型报告其余要素。
 * 问题最多保留 200 条。
 */
export function validateCollection(collection: CoreCollection, expectedKind: CoreGeometryKind | null = null): CollectionInspection {
  const reference = expectedKind ?? dominantKind(collection);
  const issues: GeometryIssue[] = [];
  let truncated = false;
  for (let index = 0; index < collection.features.length; index += 1) {
    const found = inspectFeature(collection.features[index], index, reference);
    for (const issue of found) {
      if (issues.length >= ISSUE_CAP) {
        truncated = true;
        break;
      }
      issues.push(issue);
    }
    if (truncated) break;
  }
  return { issues, truncated, mixed: reference !== null && issues.some((issue) => issue.kind === "mixed") };
}

/** 空或结构无效的要素不能渲染，也不能进入算子。 */
export function isUnusableIssue(issue: GeometryIssue): boolean {
  return issue.kind === "empty" || issue.kind === "invalid";
}
