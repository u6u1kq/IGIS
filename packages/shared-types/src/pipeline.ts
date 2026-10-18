// SPDX-License-Identifier: Apache-2.0

import type { LayerSummary, MemoryRef } from "./memory.js";

export type ToolPrefix = "io" | "vector" | "raster" | "map" | "gdl";

/** 注册进现有工具表的三个 GIS 只读查询。名字不含几何参数。 */
export type GisQueryToolName = "list-layers" | "get-layer-metadata" | "get-sample-feature";

export type ToolName = `${ToolPrefix}.${string}` | GisQueryToolName;

export type ScalarArg = string | number | boolean | null;

export const FORBIDDEN_GEOMETRY_ARG_NAMES = [
  "wkt",
  "wkb",
  "geojson",
  "coordinates",
  "coordinate",
  "geometry",
  "geom",
  "rings",
  "paths",
  "points",
] as const;

export type ForbiddenGeometryArgName = (typeof FORBIDDEN_GEOMETRY_ARG_NAMES)[number];

type BanGeometryKeys<T> = T & {
  readonly [K in ForbiddenGeometryArgName]?: never;
};

/** 标量参数。几何格式名称不能作为参数名出现。 */
export type ScalarArgs = BanGeometryKeys<Readonly<Record<string, ScalarArg>>>;

/** 模型侧只放不透明句柄。 */
export type HandleMap = BanGeometryKeys<Readonly<Record<string, string>>>;

/** 内核侧只放内存引用。 */
export type MemoryInputs = BanGeometryKeys<Readonly<Record<string, MemoryRef>>>;

/**
 * 模型可见的工具请求。
 * memoryHandles 的值是不透明句柄，不是几何文本。
 */
export interface LlmToolRequest {
  readonly tool: ToolName;
  readonly scalarArgs: ScalarArgs;
  readonly memoryHandles: HandleMap;
}

/** 内核执行用的 function call。几何只以 MemoryRef 出现，且不出进程。 */
export interface FunctionCall {
  readonly tool: ToolName;
  readonly scalarArgs: ScalarArgs;
  readonly inputs: MemoryInputs;
}

export interface RuntimeStats {
  readonly durationMs: number;
  readonly memoryPeakBytes: number;
}

export interface FunctionResult {
  readonly outputs: readonly MemoryRef[];
  readonly summary: LayerSummary | null;
  readonly stats: RuntimeStats;
}

/** 控制面消息。不含几何字节。 */
export type ControlMessage =
  | {
      readonly kind: "metadata-summary";
      readonly summary: LayerSummary;
      readonly request: null;
    }
  | {
      readonly kind: "tool-request";
      readonly summary: null;
      readonly request: LlmToolRequest;
    }
  | {
      readonly kind: "tool-ack";
      readonly summary: LayerSummary | null;
      readonly request: LlmToolRequest;
    };

export type ExportFormat = "gpkg" | "geojson" | "tif" | "parquet" | "geoparquet";

export interface ExportRequest {
  readonly source: MemoryRef;
  readonly sourceContentHash: string;
  readonly destinationPath: string;
  readonly format: ExportFormat;
}

const WKT_PATTERN =
  /^(POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION)(\s+[ZM]{1,2})?\s*\(/i;

/** 判断文本是不是 WKT 或带 coordinates 的 GeoJSON 几何。不把普通字段名当成几何。 */
export function looksLikeGeometryText(value: string): boolean {
  const trimmed = value.trim().replace(/^SRID\s*=\s*\d+\s*;\s*/i, "");
  if (WKT_PATTERN.test(trimmed)) return true;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  const hasGeometryType =
    /"type"\s*:\s*"(Point|LineString|Polygon|MultiPoint|MultiLineString|MultiPolygon|GeometryCollection)"/i.test(
      trimmed,
    );
  return hasGeometryType && /"coordinates"\s*:/.test(trimmed);
}

function isSkippedBinary(value: object): boolean {
  return value instanceof Uint8Array || value instanceof ArrayBuffer || value instanceof DataView;
}

/**
 * 在对象树上查找禁止出现的键。
 * rejectGeometryText 为 true 时，字符串值里的 WKT / GeoJSON 几何也算命中。
 * 不走入二进制缓冲，避免把源文件字节当成键来扫描。
 */
export function findForbiddenPayloadKey(
  value: unknown,
  forbidden: readonly string[],
  rejectGeometryText = false,
): string | null {
  const banned = new Set(forbidden.map((item) => item.toLowerCase()));
  return walkPayload(value, "", new WeakSet<object>(), banned, rejectGeometryText);
}

function walkPayload(
  value: unknown,
  path: string,
  seen: WeakSet<object>,
  banned: ReadonlySet<string>,
  rejectGeometryText: boolean,
): string | null {
  if (typeof value === "string") {
    if (rejectGeometryText && looksLikeGeometryText(value)) {
      return path.length > 0 ? path : "$";
    }
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  if (isSkippedBinary(value)) return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const item: unknown = value[index];
      const hit = walkPayload(item, `${path}[${index}]`, seen, banned, rejectGeometryText);
      if (hit) return hit;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const next = path.length > 0 ? `${path}.${key}` : key;
    if (banned.has(key.toLowerCase())) return next;
    const hit = walkPayload(record[key], next, seen, banned, rejectGeometryText);
    if (hit) return hit;
  }
  return null;
}

/** 控制面或工具参数里出现几何字节字段时抛出。范围四元组不在这张名单里。 */
export class GeometryByteFieldError extends Error {
  readonly fieldPath: string;
  constructor(fieldPath: string) {
    super(`控制面不允许几何字节字段: ${fieldPath}`);
    this.name = "GeometryByteFieldError";
    this.fieldPath = fieldPath;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * 控制面检查：拒绝 WKT、WKB、GeoJSON、坐标数组这类几何字节字段。
 * 图层摘要上的 extent 仍留在进程内，不进来源账本，也不应发给模型。
 */
export function assertNoGeometryByteFields(value: unknown): void {
  const hit = findForbiddenPayloadKey(value, FORBIDDEN_GEOMETRY_ARG_NAMES, true);
  if (hit) throw new GeometryByteFieldError(hit);
}
