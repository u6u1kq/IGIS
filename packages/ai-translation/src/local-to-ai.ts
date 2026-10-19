// SPDX-License-Identifier: Apache-2.0

import { AI_SPATIAL_OPERATIONS } from "@igis/ai-boundary";
import type { AiLayerView } from "@igis/ai-boundary";
import { looksLikeGeometryText } from "@igis/shared-types";

/** 本地结果原样交给调用方。 */
export function translateLocalToAi(value: unknown): unknown {
  return value;
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
  return value.relations.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

/** 图层标识摘要。 */
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

/** 操作结果里的标识、状态和数量。 */
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
    ...(textOf(record.message) !== "" ? { message: textOf(record.message) } : {}),
  };
  return context;
}

export type { AiLayerView };
