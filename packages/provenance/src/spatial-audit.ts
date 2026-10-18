// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { RequestSource } from "@igis/ai-boundary";
import { looksLikeGeometryText } from "@igis/shared-types";
import { ProvenanceLedgerError } from "./guard.js";
import { PROVENANCE_FORBIDDEN_FIELDS } from "./record.js";

/** 空间分析审计与旧的只读账本分开存放，避免旧读取把新记录当成来源记录。 */
export const SPATIAL_AUDIT_DIRECTORY = "var/spatial-audit";

export const SPATIAL_AUDIT_OPERATIONS = [
  "buffer",
  "intersect",
  "clip",
  "spatial-query",
  "stats",
  "map-load",
  "export",
  "gdl-load",
  "gdl-export",
  "report",
  "rollback",
  "area",
  "length",
  "distance",
  "nearest",
  "convert",
  "dissolve",
  "merge",
  "simplify",
  "group-stats",
  "reclassify",
  "quality-check",
  "split-grid",
  "voronoi",
  "convex-hull",
  "min-bbox",
  "centroid",
  "bearing",
  "make-valid",
  "reproject",
  "convert-format",
  "dem-derivative",
  "contour",
  "raster-calc",
  "raster-info",
  "split-line",
  "explode",
  "vertices",
  "line-intersect",
  "transform",
  "nearest-on-line",
  "grid",
  "split-polygon",
  "spatial-aggregate",
  "distance-matrix",
  "nearest-exact",
  "field-calc",
  "join",
  "raster-cast",
  "raster-nodata",
  "raster-smooth",
  "interpolate",
  "erase",
  "union",
  "spatial-join",
  "viewshed",
  "raster-clip",
  "polygonize",
  "rasterize",
  "zonal",
  "resample",
  "raster-index",
  "focal",
  "quadtree",
  "chart",
  "kernel-density",
  "network-snap",
  "network-distance",
  "service-area",
  "aggregate-grid",
  "offset-line",
  "cost-corridor",
  "classify",
  "hotspot",
  "gwr",
  "od-flow",
  "k-anonymity",
  "dp-grid",
  "kriging",
  "watershed",
  "profile",
  "cut-fill",
  "water-level",
  "layer-stack",
  "geology-inputs",
  "rainfall-runoff",
  "rainfall-landslide",
  "geology-model",
] as const;

export type SpatialAuditOperation = (typeof SPATIAL_AUDIT_OPERATIONS)[number];

/** 只保留与坐标无关的参数。距离、单位、属性筛选文字、查询种类，以及 V0.87 能力参数。 */
export interface SpatialAuditParameters {
  readonly distance?: number;
  readonly unit?: string;
  readonly attributeFilter?: string;
  readonly queryKind?: string;
  /** convert 的目标几何（polygon/line）。 */
  readonly target?: string;
  /** simplify 的容差（米）。 */
  readonly tolerance?: number;
  /** dissolve / group-stats 的分组字段名。 */
  readonly groupField?: string;
  /** reclassify / group-stats 的目标字段名。 */
  readonly fieldName?: string;
  /** reclassify 的映射表（"源=目标;源=目标"，安全文字）。 */
  readonly mapping?: string;
  /** split-grid 的列数。 */
  readonly columns?: number;
  /** split-grid 的行数。 */
  readonly rows?: number;
  /** distance-matrix 的对数上限。 */
  readonly limit?: number;
}

/**
 * 空间操作的平行审计记录。
 * 不包含坐标、范围、WKT、WKB 或 GeoJSON 几何。
 * 也不复用旧来源记录的哈希字段，避免改变旧记录形状。
 */
export interface SpatialAuditRecord {
  readonly recordKind: "spatial-audit";
  readonly recordId: string;
  readonly operationType: SpatialAuditOperation;
  readonly inputLayerNames: readonly string[];
  readonly parameters: SpatialAuditParameters;
  readonly outputFilePath: string | null;
  readonly recordedAt: string;
  readonly modelName: string;
  readonly operator: string;
  readonly layerId: string | null;
  readonly success: boolean;
  readonly note: string;
  /** 本地空间运算耗时。不含坐标。旧记录可以没有这个字段。 */
  readonly durationMs?: number;
  /** 请求从桌面、云端对话、MCP 还是内部调用进来。不是用户账号。旧记录可以没有。 */
  readonly requestSource?: RequestSource;
}

const OPERATION_SET = new Set<string>(SPATIAL_AUDIT_OPERATIONS);
const REQUEST_SOURCES = new Set<RequestSource>(["desktop-ui", "cloud-ai", "mcp", "internal"]);

let sequence = 0;

function nextRecordId(): string {
  sequence += 1;
  return `audit-${Date.now().toString(16)}-${sequence}`;
}

/** 参数若像坐标或几何文本，调用方应省略它，不能写进审计。 */
export function omitCoordinateParameter(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (looksLikeGeometryText(trimmed)) return undefined;
  if (/"coordinates"\s*:/.test(trimmed)) return undefined;
  if (/\b(bbox|extent|wkt|wkb)\b/i.test(trimmed)) return undefined;
  if (/^-?\d+(?:\.\d+)?\s*[,，\s]\s*-?\d+(?:\.\d+)?$/.test(trimmed)) return undefined;
  return trimmed;
}

function assertSafeText(value: string, fieldPath: string): void {
  if (looksLikeGeometryText(value) || /"coordinates"\s*:/.test(value)) {
    throw new ProvenanceLedgerError("forbidden-geometry", fieldPath);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readParameters(value: unknown): SpatialAuditParameters {
  if (!isRecord(value)) throw new ProvenanceLedgerError("invalid-record", "parameters");
  const parameters: {
    distance?: number; unit?: string; attributeFilter?: string; queryKind?: string;
    target?: string; tolerance?: number; groupField?: string; fieldName?: string; mapping?: string; columns?: number; rows?: number;
  } = {};
  for (const key of Object.keys(value)) {
    if (!(PROVENANCE_FORBIDDEN_FIELDS as readonly string[]).includes(key.toLowerCase())) continue;
    throw new ProvenanceLedgerError("forbidden-geometry", `parameters.${key}`);
  }
  if (value.distance !== undefined) {
    if (typeof value.distance !== "number" || !Number.isFinite(value.distance)) {
      throw new ProvenanceLedgerError("invalid-record", "parameters.distance");
    }
    parameters.distance = value.distance;
  }
  for (const key of ["unit", "attributeFilter", "queryKind", "target", "groupField", "fieldName", "mapping"] as const) {
    const raw = value[key];
    if (raw === undefined) continue;
    if (typeof raw !== "string") throw new ProvenanceLedgerError("invalid-record", `parameters.${key}`);
    const kept = omitCoordinateParameter(raw);
    if (kept) parameters[key] = kept;
  }
  for (const key of ["tolerance", "columns", "rows"] as const) {
    const raw = value[key];
    if (raw === undefined) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw)) throw new ProvenanceLedgerError("invalid-record", `parameters.${key}`);
    parameters[key] = raw;
  }
  return parameters;
}

/** 只复制审计允许的字段。几何键直接拒绝。 */
export function prepareSpatialAuditRecord(value: unknown): SpatialAuditRecord {
  if (!isRecord(value)) throw new ProvenanceLedgerError("invalid-record", "record");
  for (const key of Object.keys(value)) {
    if ((PROVENANCE_FORBIDDEN_FIELDS as readonly string[]).includes(key.toLowerCase())) {
      throw new ProvenanceLedgerError("forbidden-geometry", key);
    }
  }
  if (value.recordKind !== "spatial-audit") throw new ProvenanceLedgerError("invalid-record", "recordKind");
  if (typeof value.recordId !== "string" || !/^[A-Za-z0-9._-]+$/.test(value.recordId)) {
    throw new ProvenanceLedgerError("invalid-record", "recordId");
  }
  assertSafeText(value.recordId, "recordId");
  if (typeof value.operationType !== "string" || !OPERATION_SET.has(value.operationType)) {
    throw new ProvenanceLedgerError("invalid-record", "operationType");
  }
  if (!Array.isArray(value.inputLayerNames)) throw new ProvenanceLedgerError("invalid-record", "inputLayerNames");
  const inputLayerNames: string[] = [];
  for (let index = 0; index < value.inputLayerNames.length; index += 1) {
    const name: unknown = value.inputLayerNames[index];
    if (typeof name !== "string" || name.trim() === "") {
      throw new ProvenanceLedgerError("invalid-record", `inputLayerNames[${index}]`);
    }
    assertSafeText(name, `inputLayerNames[${index}]`);
    inputLayerNames.push(name);
  }
  if (value.outputFilePath !== null && typeof value.outputFilePath !== "string") {
    throw new ProvenanceLedgerError("invalid-record", "outputFilePath");
  }
  if (typeof value.outputFilePath === "string") assertSafeText(value.outputFilePath, "outputFilePath");
  if (typeof value.recordedAt !== "string" || Number.isNaN(Date.parse(value.recordedAt))) {
    throw new ProvenanceLedgerError("invalid-record", "recordedAt");
  }
  if (typeof value.modelName !== "string" || value.modelName.trim() === "") {
    throw new ProvenanceLedgerError("invalid-record", "modelName");
  }
  assertSafeText(value.modelName, "modelName");
  if (typeof value.operator !== "string" || value.operator.trim() === "") {
    throw new ProvenanceLedgerError("invalid-record", "operator");
  }
  assertSafeText(value.operator, "operator");
  if (value.layerId !== null && (typeof value.layerId !== "string" || !/^[A-Za-z0-9._-]+$/.test(value.layerId))) {
    throw new ProvenanceLedgerError("invalid-record", "layerId");
  }
  if (typeof value.layerId === "string") assertSafeText(value.layerId, "layerId");
  if (typeof value.success !== "boolean") throw new ProvenanceLedgerError("invalid-record", "success");
  if (typeof value.note !== "string") throw new ProvenanceLedgerError("invalid-record", "note");
  assertSafeText(value.note, "note");
  let durationMs: number | undefined;
  if (value.durationMs !== undefined) {
    if (typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs) || value.durationMs < 0) {
      throw new ProvenanceLedgerError("invalid-record", "durationMs");
    }
    durationMs = Math.round(value.durationMs);
  }
  let requestSource: RequestSource | undefined;
  if (value.requestSource !== undefined) {
    if (!REQUEST_SOURCES.has(value.requestSource as RequestSource)) {
      throw new ProvenanceLedgerError("invalid-record", "requestSource");
    }
    requestSource = value.requestSource as RequestSource;
  }
  return Object.freeze({
    recordKind: "spatial-audit",
    recordId: value.recordId,
    operationType: value.operationType as SpatialAuditOperation,
    inputLayerNames: Object.freeze(inputLayerNames),
    parameters: readParameters(value.parameters),
    outputFilePath: typeof value.outputFilePath === "string" ? value.outputFilePath : null,
    recordedAt: value.recordedAt,
    modelName: value.modelName.trim(),
    operator: value.operator.trim(),
    layerId: typeof value.layerId === "string" ? value.layerId : null,
    success: value.success,
    note: value.note,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(requestSource ? { requestSource } : {}),
  });
}

export function buildSpatialAuditRecord(draft: {
  readonly operationType: SpatialAuditOperation;
  readonly inputLayerNames: readonly string[];
  readonly parameters: SpatialAuditParameters;
  readonly outputFilePath: string | null;
  readonly modelName: string;
  readonly layerId: string | null;
  readonly success: boolean;
  readonly note: string;
  readonly recordedAt?: string;
  readonly recordId?: string;
  readonly durationMs?: number;
  readonly requestSource?: RequestSource;
}): SpatialAuditRecord {
  return prepareSpatialAuditRecord({
    recordKind: "spatial-audit",
    recordId: draft.recordId ?? nextRecordId(),
    operationType: draft.operationType,
    inputLayerNames: draft.inputLayerNames,
    parameters: draft.parameters,
    outputFilePath: draft.outputFilePath,
    recordedAt: draft.recordedAt ?? new Date().toISOString(),
    modelName: draft.modelName,
    operator: "local",
    layerId: draft.layerId,
    success: draft.success,
    note: draft.note,
    ...(typeof draft.durationMs === "number" ? { durationMs: draft.durationMs } : {}),
    ...(draft.requestSource ? { requestSource: draft.requestSource } : {}),
  });
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function recordPath(directory: string, recordId: string): string {
  return `${directory.replace(/[\\/]+$/, "")}/${recordId}.json`;
}

/** 空间操作审计。与 InMemoryProvenanceLedger 并列，不改旧记录的读写。 */
export class SpatialAuditLedger {
  private readonly records: SpatialAuditRecord[] = [];
  private readonly directory: string;

  constructor(directory: string = SPATIAL_AUDIT_DIRECTORY) {
    this.directory = directory;
  }

  async append(record: SpatialAuditRecord): Promise<void> {
    const stored = prepareSpatialAuditRecord(record);
    await mkdir(this.directory, { recursive: true });
    const json = JSON.stringify(stored, (key, item: unknown) => {
      if (key && (PROVENANCE_FORBIDDEN_FIELDS as readonly string[]).includes(key.toLowerCase())) {
        throw new ProvenanceLedgerError("forbidden-geometry", key);
      }
      return item;
    }, 2);
    await writeFile(recordPath(this.directory, stored.recordId), `${json}\n`, { encoding: "utf8" });
    this.records.push(stored);
  }

  async load(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (isEnoent(error)) return;
      throw error;
    }
    const known = new Set(this.records.map((item) => item.recordId));
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const text = await readFile(recordPath(this.directory, name.slice(0, -".json".length)), { encoding: "utf8" });
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        continue;
      }
      try {
        const record = prepareSpatialAuditRecord(parsed);
        if (known.has(record.recordId)) continue;
        this.records.push(record);
        known.add(record.recordId);
      } catch {
        // 坏掉的审计文件跳过，不影响旧来源账本，也不让进程退出。
      }
    }
  }

  async remove(recordId: string): Promise<boolean> {
    if (!/^[A-Za-z0-9._-]+$/.test(recordId)) return false;
    const index = this.records.findIndex((item) => item.recordId === recordId);
    let removed = index >= 0;
    if (index >= 0) this.records.splice(index, 1);
    try {
      await rm(recordPath(this.directory, recordId), { recursive: true, force: true });
      removed = true;
    } catch {
      // 文件已经不在时，只要内存里删过就算成功。
    }
    return removed;
  }

  async list(): Promise<readonly SpatialAuditRecord[]> {
    return [...this.records].sort((left, right) => right.recordedAt.localeCompare(left.recordedAt));
  }
}
