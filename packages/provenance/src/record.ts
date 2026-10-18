// SPDX-License-Identifier: Apache-2.0

/**
 * 来源账本基础记录。
 * 默认记录图层名。几何坐标没有对应字段，也不能通过索引签名塞进来。
 * 写入前会拒绝几何字段。哈希与可选落盘由 InMemoryProvenanceLedger 完成。
 */
export interface ProvenanceRecord {
  readonly recordId: string;
  readonly sourceContentHash: string;
  readonly hashAlgorithm: "SHA-256";
  readonly readOnly: true;
  readonly exportPath: string | null;
  readonly layerNames: readonly string[];
  readonly recordedAt: string;
  /** 工具或检索动作名。读盘上的旧记录可以没有它。 */
  readonly toolName?: string;
  /** 这次调用是否成功。 */
  readonly success?: boolean;
  /** 耗时，毫秒。不是坐标。 */
  readonly durationMs?: number;
}

export const PROVENANCE_POLICY = {
  recordLayerNamesByDefault: true,
  recordGeometryCoordinates: false,
  storage: "local",
} as const;

export const PROVENANCE_RECORDED_FIELDS = [
  "sourceContentHash",
  "hashAlgorithm",
  "readOnly",
  "exportPath",
  "layerNames",
  "recordedAt",
] as const;

/** 工具调用和检索可以额外写下这些字段。仍然没有坐标。 */
export const PROVENANCE_CALL_FIELDS = ["toolName", "success", "durationMs"] as const;

export const PROVENANCE_FORBIDDEN_FIELDS = [
  "coordinates",
  "coordinate",
  "wkt",
  "wkb",
  "geojson",
  "geometry",
  "geom",
  "extent",
  "bbox",
  "x",
  "y",
  "lat",
  "lon",
  "latitude",
  "longitude",
  "rings",
  "paths",
  "points",
] as const;

export type ProvenanceForbiddenField = (typeof PROVENANCE_FORBIDDEN_FIELDS)[number];

/** 基础账本 API。 */
export interface ProvenanceLedger {
  append(record: ProvenanceRecord): Promise<void>;
  list(): Promise<readonly ProvenanceRecord[]>;
}
