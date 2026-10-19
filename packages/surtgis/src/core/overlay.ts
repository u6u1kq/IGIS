// SPDX-License-Identifier: Apache-2.0

import type { Feature, LineString, MultiPolygon, Point, Polygon } from "geojson";
import {
  booleanIntersects,
  booleanPointInPolygon,
  booleanValid,
  buffer,
  centroid,
  featureCollection,
  flatten,
  intersect,
  lineSplit,
  simplify,
  union,
} from "@turf/turf";
import { SurtGisCoreError } from "./errors.js";
import { TURF_DEGREES_PER_METER, aeqdDefinition, scaleCollection, transformViaDefinitions } from "./crs-transform.js";
import type { CoreCollection, CoreDistanceUnit, CoreFeature, CoreOpResult, CoreScalarProps } from "./types.js";

/**
 * 内核算子：缓冲、相交、裁剪。几何计算全部交给 Turf，不手写几何引擎。
 * 这里的逻辑与 的 spatial-ops 相同，只是搬进内核；map.* 工具的结果不变。
 */
export const PAIR_CAP = 600;
export const BUFFER_CAP = 2000;

export function safeValid(feature: CoreFeature): boolean {
  try {
    return Boolean(booleanValid(feature as Feature));
  } catch {
    return false;
  }
}

export function stampFeature(feature: Feature, properties: CoreScalarProps, index: number): CoreFeature | null {
  if (!feature.geometry) return null;
  return { type: "Feature", properties: { ...properties, _fid: index }, geometry: feature.geometry };
}

export function finishResult(features: CoreFeature[], skipped: number, inputCount: number, notes: string[]): CoreOpResult {
  const corrupt = features.length === 0 && skipped > 0 && inputCount > 0 && skipped >= inputCount;
  return { collection: { type: "FeatureCollection", features }, skipped, notes: notes.slice(0, 8), corrupt };
}

export function isPolygonal(feature: CoreFeature): feature is CoreFeature & { geometry: Polygon | MultiPolygon } {
  return feature.geometry.type === "Polygon" || feature.geometry.type === "MultiPolygon";
}

const METERS_PER_UNIT: Readonly<Record<CoreDistanceUnit, number>> = {
  meters: 1,
  kilometers: 1000,
  miles: 1609.344,
  feet: 0.3048,
  degrees: 0,
};

function bboxCenter(collection: CoreCollection): { readonly lat: number; readonly lon: number } | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      const first = value[0];
      const second = value[1];
      if (typeof first === "number" && typeof second === "number") {
        minX = Math.min(minX, first);
        maxX = Math.max(maxX, first);
        minY = Math.min(minY, second);
        maxY = Math.max(maxY, second);
        return;
      }
      for (const item of value) visit(item);
      return;
    }
    if (value !== null && typeof value === "object" && "type" in value) {
      const record = value as { coordinates?: unknown; geometries?: readonly unknown[] };
      if (Array.isArray(record.geometries)) {
        for (const item of record.geometries) visit(item);
        return;
      }
      visit(record.coordinates);
    }
  };
  for (const feature of collection.features) visit(feature.geometry);
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  // 经度是环形的：跨 180° 接缝时 min/max 平均会把中心算到地球另一侧，缓冲静默算错。
  // 与主流 GIS 一致——明确拒绝并建议分幅，不做近似。
  if (maxX - minX > 180) {
    throw new SurtGisCoreError("数据跨经度 180°（日界线），平面缓冲无法正确计算。请把数据分幅处理后再试。");
  }
  return { lat: (minY + maxY) / 2, lon: (minX + maxX) / 2 };
}

/**
 * 米制缓冲在图层外接框中心的正射等距方位投影（aeqd）里按地面真米计算，
 * 避免经纬度度圆的各向异性（纬度 40° 东西向误差约 23%）。
 * aeqd 的米平面先线性换算成「伪度」平面：Turf 的 meters→degrees 线性换算
 * 在等距平面上各向同性，缓冲半径就是地面真距离；缓冲后再换回并逆变换。
 * degrees 单位保持字面度数缓冲。圆形近似用 64 边形（steps 16）。
 */
export function bufferFeatures(collection: CoreCollection, distance: number, unit: CoreDistanceUnit, planarUnitToMeter: number | null = null): CoreOpResult {
  if (collection.features.length > BUFFER_CAP) {
    throw new SurtGisCoreError("图层要素超过 2000，缓冲请先缩小图层。");
  }
  let source = collection;
  let radius = distance;
  let units: "degrees" | "meters" = "degrees";
  let back: ((buffered: CoreCollection) => CoreCollection) | null = null;
  if (unit !== "degrees" && typeof planarUnitToMeter === "number" && Number.isFinite(planarUnitToMeter) && planarUnitToMeter > 0) {
    const scale = planarUnitToMeter * TURF_DEGREES_PER_METER;
    source = scaleCollection(collection, scale);
    radius = distance * (METERS_PER_UNIT[unit] ?? 1);
    units = "meters";
    back = (buffered) => scaleCollection(buffered, 1 / scale);
  } else if (unit !== "degrees") {
    const center = bboxCenter(collection);
    if (!center) {
      // 米制距离必须在投影平面计算：没有可用中心时不静默回退成"度"。
      throw new SurtGisCoreError("无法确定图层位置，米制缓冲需要有效坐标范围。请检查数据坐标。");
    }
    const aeqd = aeqdDefinition(center.lat, center.lon);
    const planar = transformViaDefinitions(collection, "EPSG:4326", aeqd);
    source = scaleCollection(planar, TURF_DEGREES_PER_METER);
    radius = distance * (METERS_PER_UNIT[unit] ?? 1);
    units = "meters";
    back = (buffered) => transformViaDefinitions(
      scaleCollection(buffered, 1 / TURF_DEGREES_PER_METER),
      aeqd,
      "EPSG:4326",
    );
  }
  const features: CoreFeature[] = [];
  const notes: string[] = [];
  let skipped = 0;
  for (let index = 0; index < source.features.length; index += 1) {
    const feature = source.features[index];
    if (!feature) continue;
    try {
      if (!safeValid(feature)) {
        skipped += 1;
        notes.push(`第 ${index + 1} 个要素几何无效，已跳过。`);
        continue;
      }
      const buffered = buffer(feature as Feature, radius, { units, steps: 16 });
      const next = buffered ? stampFeature(buffered, feature.properties, features.length) : null;
      if (!next) {
        skipped += 1;
        notes.push(`第 ${index + 1} 个要素几何无效，已跳过。`);
        continue;
      }
      features.push(next);
    } catch {
      skipped += 1;
      notes.push(`第 ${index + 1} 个要素几何无效，已跳过。`);
    }
  }
  const result = finishResult(features, skipped, collection.features.length, notes);
  return back ? { ...result, collection: back(result.collection) } : result;
}

/**
 * 几何简化。容差是地面米：与米制缓冲同一套 aeqd 伪度平面机制（各向同性）。
 * 点要素原样保留；简化只减少顶点，不改变要素数量语义。
 */
export function simplifyFeatures(collection: CoreCollection, tolerance: number): CoreOpResult {
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    throw new SurtGisCoreError("简化容差必须是大于 0 的米数。");
  }
  if (collection.features.length > BUFFER_CAP) {
    throw new SurtGisCoreError("图层要素超过 2000，简化请先缩小图层。");
  }
  const center = bboxCenter(collection);
  if (!center) {
    throw new SurtGisCoreError("无法确定图层位置，简化需要有效坐标范围。请检查数据坐标。");
  }
  const aeqd = aeqdDefinition(center.lat, center.lon);
  const planar = transformViaDefinitions(collection, "EPSG:4326", aeqd);
  const source = scaleCollection(planar, TURF_DEGREES_PER_METER);
  const features: CoreFeature[] = [];
  const notes: string[] = [];
  let skipped = 0;
  for (let index = 0; index < source.features.length; index += 1) {
    const feature = source.features[index];
    if (!feature) continue;
    try {
      if (!safeValid(feature)) {
        skipped += 1;
        notes.push(`第 ${index + 1} 个要素几何无效，已跳过。`);
        continue;
      }
      const kind = feature.geometry?.type ?? "";
      const simplified = kind === "Point" || kind === "MultiPoint"
        ? (feature as Feature)
        : simplify(feature as Feature, { tolerance, highQuality: true });
      const next = simplified ? stampFeature(simplified, feature.properties, features.length) : null;
      if (!next) {
        skipped += 1;
        notes.push(`第 ${index + 1} 个要素几何无效，已跳过。`);
        continue;
      }
      features.push(next);
    } catch {
      skipped += 1;
      notes.push(`第 ${index + 1} 个要素几何无效，已跳过。`);
    }
  }
  const result = finishResult(features, skipped, collection.features.length, notes);
  return {
    ...result,
    collection: transformViaDefinitions(scaleCollection(result.collection, 1 / TURF_DEGREES_PER_METER), aeqd, "EPSG:4326"),
  };
}

export function intersectFeatures(left: CoreCollection, right: CoreCollection): CoreOpResult {
  if (left.features.length > PAIR_CAP || right.features.length > PAIR_CAP) {
    throw new SurtGisCoreError("图层要素超过 600，相交请先缩小图层。");
  }
  const features: CoreFeature[] = [];
  const notes: string[] = [];
  let skipped = 0;
  let mixed = false;
  for (let leftIndex = 0; leftIndex < left.features.length; leftIndex += 1) {
    const source = left.features[leftIndex];
    if (!source) continue;
    let keptMixed = false;
    for (let rightIndex = 0; rightIndex < right.features.length; rightIndex += 1) {
      const other = right.features[rightIndex];
      if (!other) continue;
      try {
        if (!safeValid(source) || !safeValid(other)) {
          skipped += 1;
          notes.push("有要素几何无效，已跳过。");
          continue;
        }
        if (isPolygonal(source) && isPolygonal(other)) {
          const hit = intersect(featureCollection([source, other]));
          const next = hit ? stampFeature(hit, source.properties, features.length) : null;
          if (next) features.push(next);
          continue;
        }
        if (!keptMixed && booleanIntersects(source as Feature, other as Feature)) {
          const next = stampFeature(source as Feature, source.properties, features.length);
          if (next) features.push(next);
          keptMixed = true;
          mixed = true;
        }
      } catch {
        skipped += 1;
        notes.push("有要素几何无效，已跳过。");
      }
    }
  }
  if (mixed) notes.push("非面要素未切开，只保留相交的原要素。");
  return finishResult(features, skipped, left.features.length, notes);
}

export function unionMask(collection: CoreCollection): Feature<Polygon | MultiPolygon> {
  const polygons = collection.features.filter(isPolygonal).filter((feature) => safeValid(feature));
  const first = polygons[0];
  if (!first) throw new SurtGisCoreError("裁剪或点在面内需要对照图层里有可用的面要素。");
  if (polygons.length === 1) return first;
  try {
    const merged = union(featureCollection(polygons));
    if (!merged?.geometry) throw new SurtGisCoreError("裁剪面无法合并，请检查几何是否损坏。");
    return merged;
  } catch (error) {
    if (error instanceof SurtGisCoreError) throw error;
    throw new SurtGisCoreError("裁剪面无法合并，请检查几何是否损坏。");
  }
}

function clipOne(target: CoreFeature, mask: Feature<Polygon | MultiPolygon>, index: number): CoreFeature | null {
  if (!safeValid(target)) throw new Error("invalid");
  const type = target.geometry.type;
  if (type === "Polygon" || type === "MultiPolygon") {
    const hit = intersect(featureCollection([target as Feature<Polygon | MultiPolygon>, mask]));
    return hit ? stampFeature(hit, target.properties, index) : null;
  }
  if (type === "Point" || type === "MultiPoint") {
    const parts = flatten(target as Feature).features;
    const kept: Point["coordinates"][] = [];
    for (const part of parts) {
      if (part.geometry?.type !== "Point") continue;
      if (booleanPointInPolygon(part as Feature<Point>, mask)) kept.push(part.geometry.coordinates);
    }
    if (kept.length === 0) return null;
    const only = kept[0];
    if (kept.length === 1 && only) {
      return { type: "Feature", properties: { ...target.properties, _fid: index }, geometry: { type: "Point", coordinates: only } };
    }
    return { type: "Feature", properties: { ...target.properties, _fid: index }, geometry: { type: "MultiPoint", coordinates: kept } };
  }
  if (type === "LineString" || type === "MultiLineString") {
    const kept: LineString["coordinates"][] = [];
    for (const part of flatten(target as Feature).features) {
      if (part.geometry?.type !== "LineString") continue;
      const pieces = lineSplit(part as Feature<LineString>, mask);
      const candidates = pieces.features.length > 0 ? pieces.features : [part as Feature<LineString>];
      for (const piece of candidates) {
        if (piece.geometry?.type !== "LineString") continue;
        const middle = centroid(piece);
        if (booleanPointInPolygon(middle, mask)) kept.push(piece.geometry.coordinates);
      }
    }
    if (kept.length === 0) return null;
    const only = kept[0];
    if (kept.length === 1 && only) {
      return { type: "Feature", properties: { ...target.properties, _fid: index }, geometry: { type: "LineString", coordinates: only } };
    }
    return { type: "Feature", properties: { ...target.properties, _fid: index }, geometry: { type: "MultiLineString", coordinates: kept } };
  }
  throw new Error("invalid");
}

export function clipFeatures(target: CoreCollection, clip: CoreCollection): CoreOpResult {
  if (target.features.length > PAIR_CAP || clip.features.length > PAIR_CAP) {
    throw new SurtGisCoreError("图层要素超过 600，裁剪请先缩小图层。");
  }
  const mask = unionMask(clip);
  const features: CoreFeature[] = [];
  const notes: string[] = [];
  let skipped = 0;
  for (let index = 0; index < target.features.length; index += 1) {
    const feature = target.features[index];
    if (!feature) continue;
    try {
      const next = clipOne(feature, mask, features.length);
      if (next) features.push(next);
    } catch {
      skipped += 1;
      notes.push(`第 ${index + 1} 个要素几何无效，已跳过。`);
    }
  }
  return finishResult(features, skipped, target.features.length, notes);
}
