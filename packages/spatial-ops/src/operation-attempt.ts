// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ApprovalIssuer, ApprovalState, DataBoundaryLevel, OperationSource, RequestSource } from "@igis/ai-boundary";

/**
 * 一次 GIS 操作的运行时身份，存在 var/operations。
 * operationId 在执行边界生成，不是 auditRecordId、layerId、ragEntryId 或 conversationId。
 * 旧的 map.buffer 尝试（status 为 success/failure）仍能读回，并看成一条操作记录。
 */

export type OperationKind =
  | "buffer" | "intersect" | "clip" | "query" | "stats"
  | "load" | "delete" | "rename" | "export" | "import"
  | "area" | "length" | "distance" | "nearest" | "convert" | "dissolve" | "merge" | "simplify"
  | "group-stats" | "reclassify" | "quality-check" | "split-grid"
  | "voronoi" | "convex-hull" | "min-bbox" | "centroid" | "bearing"
  | "make-valid" | "reproject" | "convert-format"
  | "dem-derivative" | "contour" | "raster-calc" | "raster-info"
  | "split-line" | "explode" | "vertices" | "line-intersect" | "transform" | "nearest-on-line" | "grid" | "split-polygon" | "spatial-aggregate" | "distance-matrix" | "nearest-exact"
  | "field-calc" | "join" | "raster-cast" | "raster-nodata" | "raster-smooth" | "interpolate"
  | "erase" | "union" | "spatial-join" | "viewshed" | "raster-clip" | "polygonize" | "rasterize" | "zonal" | "resample" | "raster-index" | "focal"
  | "quadtree" | "chart" | "kernel-density" | "network-snap" | "network-distance" | "service-area" | "aggregate-grid"
  | "offset-line" | "cost-corridor" | "classify" | "hotspot" | "gwr" | "od-flow" | "k-anonymity" | "dp-grid"
  | "kriging" | "watershed" | "profile" | "cut-fill"
  | "water-level" | "layer-stack" | "geology-inputs"
  | "rainfall-runoff" | "rainfall-landslide" | "geology-model";

/** 非空间的状态变更（留痕契约 AUDIT_REQUIRED_OPERATIONS 的后五种）。 */
export type NonSpatialOperationKind = Extract<OperationKind, "load" | "delete" | "rename" | "export" | "import">;
export type OperationEntry = "chat" | "map" | "gdl" | "mcp";
export type OperationStatus = "running" | "succeeded" | "failed" | "rolling_back" | "rolled_back" | "rollback_failed";
export type OperationOutcome = "succeeded" | "failed";

export interface OperationRequestSummary {
  readonly layerIds: readonly string[];
  readonly layerNames?: readonly string[];
  readonly distance?: number;
  readonly unit?: string;
  readonly outputName?: string | null;
  readonly otherLayerId?: string | null;
  readonly queryKind?: string | null;
  readonly attributeFilter?: string | null;
  readonly fieldName?: string | null;
 /** 能力参数：convert 目标 / simplify 容差 / 分组字段 / 重分类映射 / 分幅行列。 */
  readonly target?: string | null;
  readonly tolerance?: number;
  readonly groupField?: string | null;
  readonly mapping?: string | null;
  readonly columns?: number;
  readonly rows?: number;
 /** 外部能力参数：重投影目标坐标系 / 格式转换目标格式 / DEM 衍生 / 等高距 / 栅格运算。 */
  readonly targetCrs?: string | null;
  readonly format?: string | null;
  readonly derivative?: string | null;
  readonly interval?: number;
  readonly op?: string | null;
 /** 能力参数：距离矩阵上限。 */
  readonly limit?: number;
 /** ：栅格 NoData 值。 */
  readonly noData?: number;
  /** 路网距离和范围用的线图层。 */
  readonly lineLayerId?: string | null;
  /** 卫星指数名。 */
  readonly indexName?: string | null;
  /** 邻域边长。 */
  readonly size?: number;
  /** 最小费用走廊的终点图层。 */
  readonly targetLayerId?: string | null;
  /** 地理加权回归的自变量，逗号分隔。 */
  readonly predictors?: string | null;
  readonly adaptive?: boolean;
  /** 重力模型的 β，或用来标定 β 的目标平均费用。 */
  readonly beta?: number;
  readonly targetMean?: number;
  /** k 匿名的 k。 */
  readonly k?: number;
  /** 差分隐私的 ε。 */
  readonly epsilon?: number;
}

export interface OperationPolicy {
  readonly writeKnowledge: boolean;
}

export interface OperationCrsTransform {
  readonly from: string;
  readonly to: string;
  readonly purpose: "align-input" | "to-working" | "from-working";
}

/** 紧凑的坐标系事实。只有规范代码和比较结果，没有几何。 */
export interface OperationCrsFacts {
  readonly comparison: "same" | "different" | "unknown" | "invalid";
  readonly inputCrs: readonly string[];
  readonly resultCrs: string | null;
  readonly transformations: readonly OperationCrsTransform[];
  /** 基准说明，例如 CGCS2000≈WGS84。 */
  readonly datumNotes?: readonly string[];
  /** 米制缓冲使用的局部投影。degrees 单位缓冲没有这个字段。 */
  readonly bufferProjection?: "aeqd";
}

export interface OperationSideEffects {
  readonly createdLayerIds?: readonly string[];
  readonly cacheKeys?: readonly string[];
  readonly knowledgeIds?: readonly string[];
  readonly provenanceIds?: readonly string[];
}

export interface OperationRollbackItem {
  readonly kind: "cache" | "knowledge" | "layer" | "audit" | "provenance";
  readonly id: string;
  readonly state: "removed" | "kept" | "failed" | "already-absent";
  readonly message?: string;
}

export interface OperationRecord {
  readonly operationId: string;
  readonly operation: OperationKind;
  readonly entry: OperationEntry;
  readonly status: OperationStatus;
  /** 写成磁盘的状态顺序。成功文件里应先有 running，再是 succeeded。 */
  readonly statusLog: readonly OperationStatus[];
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly request: OperationRequestSummary;
  readonly policy: OperationPolicy;
  /** GIS 完成时的结果。回退改 status，不改这个字段。 */
  readonly outcome?: OperationOutcome;
  readonly auditRecordIds: readonly string[];
  readonly auditAppendFailed?: true;
  readonly error?: {
    readonly message: string;
    readonly auditRecordId?: string;
  };
  readonly sideEffects: OperationSideEffects;
  readonly crs?: OperationCrsFacts;
  readonly rollback?: {
    readonly cleaned: readonly OperationRollbackItem[];
    readonly remaining: readonly OperationRollbackItem[];
  };
  /** 调用从哪里来。旧记录可以没有。 */
  readonly source?: OperationSource;
  /** 模型或 MCP 进来时为 true。本地解析器不是。 */
  readonly aiOrigin?: boolean;
  /** 是否先经过本地翻译层。桌面地图点击为 false。 */
  readonly translationUsed?: boolean;
  /** 经过翻译层时为 L2。 */
  readonly dataBoundaryLevel?: DataBoundaryLevel;
  /** 请求来源。不是用户账号。 */
  readonly requestSource?: RequestSource;
  /** 授权状态（Authorization 契约）：是否需要授权、谁授权。旧记录可以没有。 */
  readonly approvalState?: ApprovalState;
  /** 具体动作，如 load-file、delete-layer、rename-layer、export-geojson、import-file。旧记录可以没有。 */
  readonly action?: string;
  /** 作用于什么（文件路径、图层标识或名称）。旧记录可以没有。 */
  readonly inputResources?: readonly string[];
  /** 产生什么（图层标识、导出文件路径）。旧记录可以没有。 */
  readonly outputResources?: readonly string[];
}

/** 旧的 map.buffer 尝试。新写入用 OperationRecord。 */
export interface OperationAttemptInput {
  readonly layerIds: readonly string[];
  readonly layerNames: readonly string[];
  readonly distance: number;
  readonly unit: string;
  readonly outputName: string | null;
  readonly writeKnowledge: boolean;
}

export interface OperationAttempt {
  readonly operationId: string;
  readonly entry: "map.buffer";
  readonly operation: "buffer";
  readonly input: OperationAttemptInput;
  readonly status: "success" | "failure";
  readonly resultLayerId?: string;
  readonly auditRecordId?: string;
  readonly ragEntryId?: string;
  readonly durationMs?: number;
}

const SOURCES = new Set<OperationSource>(["local-user", "local-parser", "cloud-ai", "mcp"]);
const REQUEST_SOURCES = new Set<RequestSource>(["desktop-ui", "cloud-ai", "mcp", "internal"]);
const APPROVAL_ISSUERS = new Set<ApprovalIssuer>(["local-ui", "chat-ui", "mcp-client", "remote-user", "system"]);
const OPERATION_ID = /^op-[a-z0-9]+-[a-z0-9]+$/;
const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const CACHE_KEY = /^[a-f0-9]{64}$/;
const KINDS = new Set<OperationKind>([
  "buffer", "intersect", "clip", "query", "stats",
  "load", "delete", "rename", "export", "import",
  "area", "length", "distance", "nearest", "convert", "dissolve", "merge", "simplify",
  "group-stats", "reclassify", "quality-check", "split-grid",
  "voronoi", "convex-hull", "min-bbox", "centroid", "bearing",
  "make-valid", "reproject", "convert-format",
  "dem-derivative", "contour", "raster-calc", "raster-info",
  "split-line", "explode", "vertices", "line-intersect", "transform", "nearest-on-line", "grid", "split-polygon", "spatial-aggregate", "distance-matrix", "nearest-exact",
  "field-calc", "join", "raster-cast", "raster-nodata", "raster-smooth", "interpolate",
  "erase", "union", "spatial-join", "viewshed", "raster-clip", "polygonize", "rasterize", "zonal", "resample", "raster-index", "focal",
  "quadtree", "chart", "kernel-density", "network-snap", "network-distance", "service-area", "aggregate-grid",
  "offset-line", "cost-corridor", "classify", "hotspot", "gwr", "od-flow", "k-anonymity", "dp-grid",
  "kriging", "watershed", "profile", "cut-fill",
  "water-level", "layer-stack", "geology-inputs",
  "rainfall-runoff", "rainfall-landslide", "geology-model",
]);
const ENTRIES = new Set<OperationEntry>(["chat", "map", "gdl", "mcp"]);
const STATUSES = new Set<OperationStatus>(["running", "succeeded", "failed", "rolling_back", "rolled_back", "rollback_failed"]);

function workspaceRoot(): string {
  const proc = (globalThis as { process?: { cwd?: () => string } }).process;
  if (!proc || typeof proc.cwd !== "function") {
    throw new Error("操作记录需要进程工作目录。");
  }
  return proc.cwd();
}

/** 与桌面和 MCP 相同：相对给定根目录的 var/operations。不写死仓库路径。 */
export function operationsDirectory(root: string = workspaceRoot()): string {
  return resolve(root, "var", "operations");
}

/** 新的操作身份。前缀 op-，带时间和随机段，不是纯时间戳，也不是 audit-、lyr-、conv-。 */
export function createOperationId(): string {
  const time = Date.now().toString(16);
  const entropy = Math.floor(Math.random() * 0x1_0000_0000).toString(16).padStart(8, "0");
  return `op-${time}-${entropy}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

function stringList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.filter((item): item is string => typeof item === "string");
  return items.length === value.length ? items : null;
}

function idList(value: unknown, pattern: RegExp = SAFE_ID): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const items = stringList(value);
  if (!items || items.some((item) => !pattern.test(item))) return undefined;
  return items;
}

function readInput(value: unknown): OperationAttemptInput | null {
  if (!isRecord(value)) return null;
  const layerIds = stringList(value.layerIds);
  const layerNames = stringList(value.layerNames);
  if (!layerIds || !layerNames) return null;
  if (typeof value.distance !== "number" || !Number.isFinite(value.distance)) return null;
  if (typeof value.unit !== "string" || value.unit.trim() === "") return null;
  if (!(value.outputName === null || typeof value.outputName === "string")) return null;
  if (typeof value.writeKnowledge !== "boolean") return null;
  return {
    layerIds,
    layerNames,
    distance: value.distance,
    unit: value.unit,
    outputName: value.outputName,
    writeKnowledge: value.writeKnowledge,
  };
}

function parseAttempt(value: unknown, operationId: string): OperationAttempt | null {
  if (!isRecord(value)) return null;
  if (value.operationId !== operationId || value.entry !== "map.buffer" || value.operation !== "buffer") return null;
  if (value.status !== "success" && value.status !== "failure") return null;
  const input = readInput(value.input);
  if (!input) return null;
  const attempt: OperationAttempt = {
    operationId,
    entry: "map.buffer",
    operation: "buffer",
    input,
    status: value.status,
  };
  const extra: {
    resultLayerId?: string;
    auditRecordId?: string;
    ragEntryId?: string;
    durationMs?: number;
  } = {};
  if (isSafeId(value.resultLayerId)) extra.resultLayerId = value.resultLayerId;
  if (isSafeId(value.auditRecordId)) extra.auditRecordId = value.auditRecordId;
  if (isSafeId(value.ragEntryId)) extra.ragEntryId = value.ragEntryId;
  if (typeof value.durationMs === "number" && Number.isFinite(value.durationMs) && value.durationMs >= 0) {
    extra.durationMs = value.durationMs;
  }
  return { ...attempt, ...extra };
}

function readSummary(value: unknown): OperationRequestSummary | null {
  if (!isRecord(value)) return null;
  const layerIds = idList(value.layerIds);
  if (!layerIds) return null;
  const summary: OperationRequestSummary = { layerIds };
  const layerNames = stringList(value.layerNames);
  const extra: {
    layerNames?: readonly string[];
    distance?: number;
    unit?: string;
    outputName?: string | null;
    otherLayerId?: string | null;
    queryKind?: string | null;
    attributeFilter?: string | null;
    fieldName?: string | null;
    target?: string | null;
    tolerance?: number;
    groupField?: string | null;
    mapping?: string | null;
    columns?: number;
    rows?: number;
    targetCrs?: string | null;
    format?: string | null;
    derivative?: string | null;
    interval?: number;
    op?: string | null;
    limit?: number;
    noData?: number;
  } = {};
  if (layerNames) extra.layerNames = layerNames;
  if (typeof value.distance === "number" && Number.isFinite(value.distance)) extra.distance = value.distance;
  if (typeof value.unit === "string" && value.unit.trim() !== "") extra.unit = value.unit;
  if (value.outputName === null || typeof value.outputName === "string") extra.outputName = value.outputName;
  if (value.otherLayerId === null || isSafeId(value.otherLayerId)) extra.otherLayerId = value.otherLayerId ?? null;
  if (value.queryKind === null || typeof value.queryKind === "string") extra.queryKind = value.queryKind ?? null;
  if (value.attributeFilter === null || typeof value.attributeFilter === "string") extra.attributeFilter = value.attributeFilter ?? null;
  if (value.fieldName === null || typeof value.fieldName === "string") extra.fieldName = value.fieldName ?? null;
  if (value.target === null || typeof value.target === "string") extra.target = value.target ?? null;
  if (typeof value.tolerance === "number" && Number.isFinite(value.tolerance)) extra.tolerance = value.tolerance;
  if (value.groupField === null || typeof value.groupField === "string") extra.groupField = value.groupField ?? null;
  if (value.mapping === null || typeof value.mapping === "string") extra.mapping = value.mapping ?? null;
  if (typeof value.columns === "number" && Number.isFinite(value.columns)) extra.columns = value.columns;
  if (typeof value.rows === "number" && Number.isFinite(value.rows)) extra.rows = value.rows;
  if (value.targetCrs === null || typeof value.targetCrs === "string") extra.targetCrs = value.targetCrs ?? null;
  if (value.format === null || typeof value.format === "string") extra.format = value.format ?? null;
  if (value.derivative === null || typeof value.derivative === "string") extra.derivative = value.derivative ?? null;
  if (typeof value.interval === "number" && Number.isFinite(value.interval)) extra.interval = value.interval;
  if (value.op === null || typeof value.op === "string") extra.op = value.op ?? null;
  if (typeof value.limit === "number" && Number.isFinite(value.limit)) extra.limit = value.limit;
  if (typeof value.noData === "number" && Number.isFinite(value.noData)) extra.noData = value.noData;
  return { ...summary, ...extra };
}

function readSideEffects(value: unknown): OperationSideEffects | null {
  if (value === undefined) return {};
  if (!isRecord(value)) return null;
  const createdLayerIds = idList(value.createdLayerIds);
  const cacheKeys = idList(value.cacheKeys, CACHE_KEY);
  const knowledgeIds = idList(value.knowledgeIds);
  const provenanceIds = idList(value.provenanceIds);
  if (value.createdLayerIds !== undefined && !createdLayerIds) return null;
  if (value.cacheKeys !== undefined && !cacheKeys) return null;
  if (value.knowledgeIds !== undefined && !knowledgeIds) return null;
  if (value.provenanceIds !== undefined && !provenanceIds) return null;
  return {
    ...(createdLayerIds && createdLayerIds.length > 0 ? { createdLayerIds } : {}),
    ...(cacheKeys && cacheKeys.length > 0 ? { cacheKeys } : {}),
    ...(knowledgeIds && knowledgeIds.length > 0 ? { knowledgeIds } : {}),
    ...(provenanceIds && provenanceIds.length > 0 ? { provenanceIds } : {}),
  };
}

function readRollbackItem(value: unknown): OperationRollbackItem | null {
  if (!isRecord(value)) return null;
  if (value.kind !== "cache" && value.kind !== "knowledge" && value.kind !== "layer" && value.kind !== "audit" && value.kind !== "provenance") return null;
  if (typeof value.id !== "string" || value.id.trim() === "") return null;
  if (value.state !== "removed" && value.state !== "kept" && value.state !== "failed" && value.state !== "already-absent") return null;
  const message = typeof value.message === "string" && value.message.trim() !== "" ? value.message : undefined;
  return { kind: value.kind, id: value.id, state: value.state, ...(message ? { message } : {}) };
}

function readCrsTransform(value: unknown): OperationCrsTransform | null {
  if (!isRecord(value)) return null;
  if (typeof value.from !== "string" || typeof value.to !== "string") return null;
  if (value.purpose !== "align-input" && value.purpose !== "to-working" && value.purpose !== "from-working") return null;
  if (/"coordinates"\s*:/.test(value.from) || /"coordinates"\s*:/.test(value.to)) return null;
  return { from: value.from, to: value.to, purpose: value.purpose };
}

function readCrsFacts(value: unknown): OperationCrsFacts | null {
  if (!isRecord(value)) return null;
  if (value.comparison !== "same" && value.comparison !== "different" && value.comparison !== "unknown" && value.comparison !== "invalid") return null;
  const inputCrs = stringList(value.inputCrs);
  if (!inputCrs) return null;
  if (!(value.resultCrs === null || typeof value.resultCrs === "string")) return null;
  if (!Array.isArray(value.transformations)) return null;
  const transformations = value.transformations.map(readCrsTransform);
  if (transformations.some((item) => item === null)) return null;
  const datumNotes = stringList(value.datumNotes);
  if (value.datumNotes !== undefined && !datumNotes) return null;
  return {
    comparison: value.comparison,
    inputCrs,
    resultCrs: value.resultCrs,
    transformations: transformations.filter((item): item is OperationCrsTransform => item !== null),
    ...(datumNotes && datumNotes.length > 0 ? { datumNotes } : {}),
    ...(value.bufferProjection === "aeqd" ? { bufferProjection: "aeqd" as const } : {}),
  };
}

function readApprovalState(value: unknown): ApprovalState | null {
  if (!isRecord(value)) return null;
  if (typeof value.required !== "boolean" || typeof value.confirmed !== "boolean") return null;
  const extra: {
    confirmedBy?: ApprovalIssuer;
    tokenId?: string;
    consumedAt?: string;
  } = {};
  if (value.confirmedBy !== undefined) {
    if (!APPROVAL_ISSUERS.has(value.confirmedBy as ApprovalIssuer)) return null;
    extra.confirmedBy = value.confirmedBy as ApprovalIssuer;
  }
  if (value.tokenId !== undefined) {
    if (!isSafeId(value.tokenId)) return null;
    extra.tokenId = value.tokenId;
  }
  if (value.consumedAt !== undefined) {
    if (typeof value.consumedAt !== "string" || Number.isNaN(Date.parse(value.consumedAt))) return null;
    extra.consumedAt = value.consumedAt;
  }
  return { required: value.required, confirmed: value.confirmed, ...extra };
}

function readResourceList(value: unknown): readonly string[] | null {
  const items = stringList(value);
  if (!items || items.length > 100 || items.some((item) => item.length > 512)) return null;
  return items;
}

function readRollback(value: unknown): OperationRecord["rollback"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !Array.isArray(value.cleaned) || !Array.isArray(value.remaining)) return undefined;
  const cleaned = value.cleaned.map(readRollbackItem);
  const remaining = value.remaining.map(readRollbackItem);
  if (cleaned.some((item) => item === null) || remaining.some((item) => item === null)) return undefined;
  return {
    cleaned: cleaned.filter((item): item is OperationRollbackItem => item !== null),
    remaining: remaining.filter((item): item is OperationRollbackItem => item !== null),
  };
}

function legacyRecord(attempt: OperationAttempt): OperationRecord {
  const succeeded = attempt.status === "success";
  const status: OperationStatus = succeeded ? "succeeded" : "failed";
  const sideEffects: OperationSideEffects = {
    ...(attempt.resultLayerId ? { createdLayerIds: [attempt.resultLayerId] } : {}),
    ...(attempt.ragEntryId ? { knowledgeIds: [attempt.ragEntryId] } : {}),
  };
  return {
    operationId: attempt.operationId,
    operation: "buffer",
    entry: "chat",
    status,
    statusLog: [status],
    startedAt: new Date(0).toISOString(),
    request: {
      layerIds: attempt.input.layerIds,
      layerNames: attempt.input.layerNames,
      distance: attempt.input.distance,
      unit: attempt.input.unit,
      outputName: attempt.input.outputName,
    },
    policy: { writeKnowledge: attempt.input.writeKnowledge },
    outcome: status,
    auditRecordIds: attempt.auditRecordId ? [attempt.auditRecordId] : [],
    ...(succeeded ? {} : {
      error: {
        message: "较早的缓冲尝试没有留下错误原文。",
        ...(attempt.auditRecordId ? { auditRecordId: attempt.auditRecordId } : {}),
      },
    }),
    sideEffects,
  };
}

function parseRecord(value: unknown, operationId: string): OperationRecord | null {
  if (!isRecord(value) || value.operationId !== operationId) return null;
  if (!KINDS.has(value.operation as OperationKind) || !ENTRIES.has(value.entry as OperationEntry)) {
    const legacy = parseAttempt(value, operationId);
    return legacy ? legacyRecord(legacy) : null;
  }
  if (!STATUSES.has(value.status as OperationStatus)) return null;
  const request = readSummary(value.request);
  const sideEffects = readSideEffects(value.sideEffects);
  if (!request || !sideEffects) return null;
  if (!isRecord(value.policy) || typeof value.policy.writeKnowledge !== "boolean") return null;
  if (typeof value.startedAt !== "string" || Number.isNaN(Date.parse(value.startedAt))) return null;
  const statusLog = stringList(value.statusLog)?.filter((item): item is OperationStatus => STATUSES.has(item as OperationStatus));
  if (!statusLog || statusLog.length === 0) return null;
  const auditRecordIds = idList(value.auditRecordIds) ?? (value.auditRecordIds === undefined ? [] : null);
  if (!auditRecordIds) return null;
  const record: OperationRecord = {
    operationId,
    operation: value.operation as OperationKind,
    entry: value.entry as OperationEntry,
    status: value.status as OperationStatus,
    statusLog,
    startedAt: value.startedAt,
    request,
    policy: { writeKnowledge: value.policy.writeKnowledge },
    auditRecordIds,
    sideEffects,
  };
  const extra: {
    finishedAt?: string;
    outcome?: OperationOutcome;
    auditAppendFailed?: true;
    error?: OperationRecord["error"];
    rollback?: OperationRecord["rollback"];
    crs?: OperationCrsFacts;
    source?: OperationSource;
    aiOrigin?: boolean;
    translationUsed?: boolean;
    dataBoundaryLevel?: DataBoundaryLevel;
    requestSource?: RequestSource;
    approvalState?: ApprovalState;
    action?: string;
    inputResources?: readonly string[];
    outputResources?: readonly string[];
  } = {};
  if (typeof value.finishedAt === "string" && !Number.isNaN(Date.parse(value.finishedAt))) extra.finishedAt = value.finishedAt;
  if (value.outcome === "succeeded" || value.outcome === "failed") extra.outcome = value.outcome;
  if (value.auditAppendFailed === true && auditRecordIds.length === 0) extra.auditAppendFailed = true;
  if (isRecord(value.error) && typeof value.error.message === "string") {
    extra.error = {
      message: value.error.message,
      ...(isSafeId(value.error.auditRecordId) ? { auditRecordId: value.error.auditRecordId } : {}),
    };
  }
  const rollback = readRollback(value.rollback);
  if (value.rollback !== undefined && !rollback) return null;
  if (value.crs !== undefined) {
    const crs = readCrsFacts(value.crs);
    if (!crs) return null;
    extra.crs = crs;
  }
  if (value.source !== undefined) {
    if (!SOURCES.has(value.source as OperationSource)) return null;
    extra.source = value.source as OperationSource;
  }
  if (value.aiOrigin !== undefined) {
    if (typeof value.aiOrigin !== "boolean") return null;
    extra.aiOrigin = value.aiOrigin;
  }
  if (value.translationUsed !== undefined) {
    if (typeof value.translationUsed !== "boolean") return null;
    extra.translationUsed = value.translationUsed;
  }
  if (value.dataBoundaryLevel !== undefined) {
    if (value.dataBoundaryLevel !== "L2") return null;
    extra.dataBoundaryLevel = "L2";
  }
  if (value.requestSource !== undefined) {
    if (!REQUEST_SOURCES.has(value.requestSource as RequestSource)) return null;
    extra.requestSource = value.requestSource as RequestSource;
  }
  if (value.approvalState !== undefined) {
    const approvalState = readApprovalState(value.approvalState);
    if (!approvalState) return null;
    extra.approvalState = approvalState;
  }
  if (value.action !== undefined) {
    if (typeof value.action !== "string" || value.action.trim() === "" || value.action.length > 80) return null;
    extra.action = value.action;
  }
  if (value.inputResources !== undefined) {
    const inputResources = readResourceList(value.inputResources);
    if (!inputResources) return null;
    extra.inputResources = inputResources;
  }
  if (value.outputResources !== undefined) {
    const outputResources = readResourceList(value.outputResources);
    if (!outputResources) return null;
    extra.outputResources = outputResources;
  }
  return {
    ...record,
    ...(typeof extra.finishedAt === "string" ? { finishedAt: extra.finishedAt } : {}),
    ...(extra.outcome ? { outcome: extra.outcome } : {}),
    ...(extra.auditAppendFailed ? { auditAppendFailed: true as const } : {}),
    ...(extra.error ? { error: extra.error } : {}),
    ...(extra.crs ? { crs: extra.crs } : {}),
    ...(rollback ? { rollback } : {}),
    ...(extra.source ? { source: extra.source } : {}),
    ...(typeof extra.aiOrigin === "boolean" ? { aiOrigin: extra.aiOrigin } : {}),
    ...(typeof extra.translationUsed === "boolean" ? { translationUsed: extra.translationUsed } : {}),
    ...(extra.dataBoundaryLevel ? { dataBoundaryLevel: extra.dataBoundaryLevel } : {}),
    ...(extra.requestSource ? { requestSource: extra.requestSource } : {}),
    ...(extra.approvalState ? { approvalState: extra.approvalState } : {}),
    ...(extra.action ? { action: extra.action } : {}),
    ...(extra.inputResources ? { inputResources: extra.inputResources } : {}),
    ...(extra.outputResources ? { outputResources: extra.outputResources } : {}),
  };
}

function assertIdentity(record: OperationRecord): void {
  if (!OPERATION_ID.test(record.operationId)) throw new Error("operationId 无效。");
  const owned = [
    ...record.auditRecordIds,
    ...(record.sideEffects.createdLayerIds ?? []),
    ...(record.sideEffects.knowledgeIds ?? []),
    ...(record.sideEffects.provenanceIds ?? []),
    ...(record.error?.auditRecordId ? [record.error.auditRecordId] : []),
  ];
  if (owned.includes(record.operationId)) throw new Error("operationId 不能等于审计、图层、知识或来源标识。");
  const text = JSON.stringify(record);
  if (/"coordinates"\s*:/.test(text)) throw new Error("操作记录不能写入坐标。");
}

export async function writeOperationRecord(record: OperationRecord, root?: string): Promise<void> {
  assertIdentity(record);
  const directory = root === undefined ? operationsDirectory() : operationsDirectory(root);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${record.operationId}.json`), `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8" });
}

export interface NonSpatialOperationInput {
  readonly kind: NonSpatialOperationKind;
  /** 具体动作，如 load-file、delete-layer、clear-layers、drop-database、rename-layer、export-geojson、import-file。 */
  readonly action: string;
  readonly entry: OperationEntry;
  readonly source?: OperationSource;
  readonly aiOrigin?: boolean;
  readonly translationUsed?: boolean;
  readonly requestSource?: RequestSource;
  readonly inputResources?: readonly string[];
  readonly outputResources?: readonly string[];
  readonly approvalState?: ApprovalState;
  readonly ok: boolean;
  readonly message?: string;
  readonly root?: string;
}

/**
 * 非空间状态变更（load/delete/rename/export/import）的留痕。
 * 与 executeGisOperation 写同一份 var/operations 记录，返回 operationId。
 */
export async function recordNonSpatialOperation(input: NonSpatialOperationInput): Promise<string> {
  const operationId = createOperationId();
  const now = new Date().toISOString();
  const status: OperationStatus = input.ok ? "succeeded" : "failed";
  const record: OperationRecord = {
    operationId,
    operation: input.kind,
    entry: input.entry,
    status,
    statusLog: [status],
    startedAt: now,
    finishedAt: now,
    request: { layerIds: [] },
    policy: { writeKnowledge: false },
    outcome: input.ok ? "succeeded" : "failed",
    auditRecordIds: [],
    sideEffects: {},
    action: input.action.slice(0, 80),
    ...(input.inputResources && input.inputResources.length > 0
      ? { inputResources: input.inputResources.slice(0, 100).map((item) => item.slice(0, 512)) }
      : {}),
    ...(input.outputResources && input.outputResources.length > 0
      ? { outputResources: input.outputResources.slice(0, 100).map((item) => item.slice(0, 512)) }
      : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(input.aiOrigin !== undefined ? { aiOrigin: input.aiOrigin } : {}),
    ...(input.translationUsed !== undefined ? { translationUsed: input.translationUsed } : {}),
    ...(input.requestSource ? { requestSource: input.requestSource } : {}),
    ...(input.approvalState ? { approvalState: input.approvalState } : {}),
    ...(input.ok ? {} : { error: { message: (input.message ?? "操作没有完成。").slice(0, 500) } }),
  };
  await writeOperationRecord(record, input.root);
  return operationId;
}

/** 按 operationId 读回操作记录。旧的缓冲尝试会转换成同一形状。找不到时返回 null。 */
export async function readOperationRecord(operationId: string, root?: string): Promise<OperationRecord | null> {
  if (!OPERATION_ID.test(operationId)) return null;
  const directory = root === undefined ? operationsDirectory() : operationsDirectory(root);
  try {
    const text = await readFile(join(directory, `${operationId}.json`), { encoding: "utf8" });
    return parseRecord(JSON.parse(text) as unknown, operationId);
  } catch {
    return null;
  }
}

export async function writeOperationAttempt(record: OperationAttempt, root?: string): Promise<void> {
  if (!OPERATION_ID.test(record.operationId)) throw new Error("operationId 无效。");
  const directory = root === undefined ? operationsDirectory() : operationsDirectory(root);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${record.operationId}.json`), `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8" });
}

/** 按 operationId 读回旧的缓冲尝试。新的操作记录不从这里返回。 */
export async function readOperationAttempt(operationId: string, root?: string): Promise<OperationAttempt | null> {
  if (!OPERATION_ID.test(operationId)) return null;
  const directory = root === undefined ? operationsDirectory() : operationsDirectory(root);
  try {
    const text = await readFile(join(directory, `${operationId}.json`), { encoding: "utf8" });
    return parseAttempt(JSON.parse(text) as unknown, operationId);
  } catch {
    return null;
  }
}
