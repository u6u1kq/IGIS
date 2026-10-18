// SPDX-License-Identifier: Apache-2.0

import {
  AI_SPATIAL_OPERATIONS,
  isFileKey,
  isGeometryKey,
  looksLikeFilePath,
} from "@igis/ai-boundary";
import type { AiLayerView } from "@igis/ai-boundary";
import { PROVENANCE_FORBIDDEN_FIELDS } from "@igis/provenance";
import { looksLikeGeometryText } from "@igis/shared-types";

/**
 * 本地结果到模型的唯一翻译。
 * 去掉坐标、WKT/WKB、范围、几何和文件路径。不打乱坐标，也不另写一份翻译。
 * 不创建图层。距离单位留在本地执行。
 */

const STRIP_KEYS = new Set<string>([
  ...PROVENANCE_FORBIDDEN_FIELDS,
  "geometries",
  "envelope",
  "path",
  "filepath",
  "absolutepath",
  "destinationpath",
  "outputfilepath",
  "sourcepath",
  "sourcepaths",
  "read",
  "file",
  "filename",
]);

function isPosition(value: readonly unknown[]): boolean {
  return value.length >= 2 && value.length <= 4 && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function isCoordinateNest(value: readonly unknown[]): boolean {
  if (isPosition(value)) return true;
  return value.length > 0 && value.every((item) => Array.isArray(item)) && value.some((item) => isCoordinateNest(item as unknown[]));
}

function walk(value: unknown): unknown {
  if (typeof value === "string") {
    if (looksLikeGeometryText(value) || looksLikeFilePath(value)) return "已省略";
    return value;
  }
  if (Array.isArray(value)) {
    if (isCoordinateNest(value)) return "已省略";
    return value.map((item) => walk(item));
  }
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (STRIP_KEYS.has(key.toLowerCase()) || isFileKey(key) || isGeometryKey(key)) {
      if (key.toLowerCase() === "geometry" && item !== null && typeof item === "object" && !Array.isArray(item)) {
        const type = (item as { type?: unknown }).type;
        if (typeof type === "string" && type !== "") out.geometryType = type;
      }
      continue;
    }
    out[key] = walk(item);
  }
  return out;
}

/** 模型可见载荷。重复调用结果稳定，不写图层库。 */
export function translateLocalToAi(value: unknown): unknown {
  return walk(value);
}

export function payloadHasCoordinateArrays(value: unknown): boolean {
  const text = JSON.stringify(value);
  if (typeof text !== "string") return false;
  return /"coordinates"\s*:/.test(text) || looksLikeGeometryText(text);
}

export interface LayerSummary {
  readonly level: "L2";
  readonly layerId: string;
  readonly layerName: string;
  readonly geometryType: string;
  readonly featureCount: number;
  readonly relations: readonly string[];
  readonly availableOperations: readonly string[];
}

export interface OperationContext {
  readonly level: "L2";
  readonly operation: string;
  readonly layerId?: string;
  readonly layerName?: string;
  readonly featureCount?: number;
  readonly status?: string;
  readonly operationId?: string;
  readonly message?: string;
  readonly availableOperations: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function countOf(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (isRecord(value) && Array.isArray(value.features)) return value.features.length;
  if (Array.isArray(value)) return value.length;
  return 0;
}

function typeOf(value: Record<string, unknown>): string {
  const named = textOf(value.geometryType) || textOf(value.geometryKind) || textOf(value.type);
  if (named !== "" && named !== "Feature" && named !== "FeatureCollection") return named;
  return "unknown";
}

function relationsOf(value: Record<string, unknown>): readonly string[] {
  if (!Array.isArray(value.relations)) return [];
  return value.relations.filter((item): item is string => typeof item === "string" && item.trim() !== "" && !looksLikeFilePath(item) && !looksLikeGeometryText(item));
}

/** 把带坐标的图层收成 L2 摘要。没有坐标、范围、几何正文或路径。 */
export function toLayerSummary(value: unknown): LayerSummary {
  const record = isRecord(value) ? value : {};
  const summary: LayerSummary = {
    level: "L2",
    layerId: textOf(record.layerId),
    layerName: textOf(record.layerName) || textOf(record.name),
    geometryType: typeOf(record),
    featureCount: typeof record.featureCount === "number" ? countOf(record.featureCount) : countOf(record.features ?? record.collection ?? record),
    relations: relationsOf(record),
    availableOperations: [...AI_SPATIAL_OPERATIONS],
  };
  return summary;
}

/** 操作结果的模型上下文。只留标识、状态和标量。 */
export function toOperationContext(value: unknown): OperationContext {
  const record = isRecord(value) ? value : {};
  const status = record.ok === true ? "succeeded" : record.ok === false ? "failed" : textOf(record.status);
  const context: OperationContext = {
    level: "L2",
    operation: textOf(record.operation) || textOf(record.operationType) || "operation",
    availableOperations: [...AI_SPATIAL_OPERATIONS],
    ...(textOf(record.layerId) !== "" ? { layerId: textOf(record.layerId) } : {}),
    ...(textOf(record.layerName) !== "" ? { layerName: textOf(record.layerName) } : {}),
    ...(typeof record.featureCount === "number" ? { featureCount: record.featureCount } : {}),
    ...(status !== "" ? { status } : {}),
    ...(textOf(record.operationId) !== "" ? { operationId: textOf(record.operationId) } : {}),
    ...(textOf(record.message) !== "" && !looksLikeGeometryText(textOf(record.message)) && !looksLikeFilePath(textOf(record.message))
      ? { message: textOf(record.message) }
      : {}),
  };
  return context;
}

export type { AiLayerView };
