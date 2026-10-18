// SPDX-License-Identifier: Apache-2.0

export type MemoryKind = "geoarrow" | "geoparquet" | "raster-mem" | "table";

/**
 * 会话内的内存引用。
 * handle 是不透明标识，不是文件路径、URL 或 WKT/WKB。
 */
export interface MemoryRef {
  readonly handle: string;
  readonly kind: MemoryKind;
  readonly byteLength: number;
  readonly crs: string;
  readonly ephemeral: true;
}

export type GeometryTypeName = "point" | "line" | "polygon" | "raster" | "unknown";

/** 进程内摘要。范围只留在内存与 RAG 元数据，不进入来源账本。 */
export interface LayerSummary {
  readonly layerName: string;
  readonly geometryType: GeometryTypeName;
  readonly crs: string;
  readonly fieldNames: readonly string[];
  readonly featureCount: number;
  readonly extent: readonly [number, number, number, number];
}
