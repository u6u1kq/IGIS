// SPDX-License-Identifier: Apache-2.0

import type { ApprovalState, DataBoundaryLevel, OperationSource, RequestSource } from "@igis/ai-boundary";
import type { ExecutionPolicy } from "./buffer-operation.js";
import { bufferRequestFromResolution } from "./buffer-operation.js";
import { validateBufferOperation } from "./buffer-operation-validate.js";
import { SpatialOpError } from "./errors.js";
import { createOperationId, readOperationRecord, writeOperationRecord } from "./operation-attempt.js";
import type {
  OperationEntry,
  OperationKind,
  OperationRecord,
  OperationRequestSummary,
  OperationRollbackItem,
  OperationSideEffects,
  OperationStatus,
} from "./operation-attempt.js";
import type { SpatialService, SpatialRunResult } from "./service.js";

/**
 * Chat、Map HTTP、GDL、MCP 共用的执行边界。
 * 图层名查找留在各入口。这里只接收已经解析好的图层身份，再调用 SpatialService。
 * ExecutionPolicy 单独保存，不放进几何请求。
 */
export interface OperationBoundaryInput {
  readonly source?: OperationSource;
  readonly aiOrigin?: boolean;
  readonly translationUsed?: boolean;
  readonly dataBoundaryLevel?: DataBoundaryLevel;
  readonly requestSource?: RequestSource;
  /** 授权状态（Authorization 契约）。五种空间分析不需要授权，默认 required:false。 */
  readonly approvalState?: ApprovalState;
}

export type GisOperationCall = OperationBoundaryInput & (
  | {
    readonly entry: OperationEntry;
    readonly operation: "buffer";
    readonly root?: string;
    readonly callerCrs?: string | null;
    readonly policy: ExecutionPolicy;
    readonly sourceLayer: { readonly layerId: string; readonly layerName: string };
    readonly distance: number;
    readonly unit: string;
    readonly outputName?: string | null;
  }
  | {
    readonly entry: OperationEntry;
    readonly operation: "intersect" | "clip";
    readonly root?: string;
    readonly callerCrs?: string | null;
    readonly policy: ExecutionPolicy;
    readonly layerId: string;
    readonly layerName: string;
    readonly otherLayerId: string;
    readonly otherLayerName: string;
    readonly outputName?: string | null;
  }
  | {
    readonly entry: OperationEntry;
    readonly operation: "query";
    readonly root?: string;
    readonly callerCrs?: string | null;
    readonly policy: ExecutionPolicy;
    readonly layerId: string;
    readonly layerName: string;
    readonly otherLayerId?: string | null;
    readonly otherLayerName?: string | null;
    readonly queryKind: string;
    readonly attributeFilter?: string | null;
  }
  | {
    readonly entry: OperationEntry;
    readonly operation: "stats";
    readonly root?: string;
    readonly callerCrs?: string | null;
    readonly policy: ExecutionPolicy;
    readonly layerId: string;
    readonly layerName: string;
    readonly fieldName?: string | null;
  }
  | {
    readonly entry: OperationEntry;
    readonly operation: CapabilityOperation;
    readonly root?: string;
    readonly callerCrs?: string | null;
    readonly policy: ExecutionPolicy;
    readonly layerId: string;
    readonly layerName: string;
    readonly otherLayerId?: string | null;
    readonly otherLayerName?: string | null;
    readonly outputName?: string | null;
    readonly fieldName?: string | null;
    readonly target?: string | null;
    readonly tolerance?: number;
    readonly groupField?: string | null;
    readonly mapping?: string | null;
    readonly columns?: number;
    readonly rows?: number;
    readonly targetCrs?: string | null;
    readonly format?: string | null;
    readonly derivative?: string | null;
    readonly interval?: number;
    readonly op?: string | null;
    readonly limit?: number;
    readonly distance?: number | null;
    readonly bearing?: number | null;
    readonly angle?: number | null;
    readonly factor?: number | null;
    readonly noData?: number;
    readonly lineLayerId?: string | null;
    readonly indexName?: string | null;
    readonly size?: number;
    readonly targetLayerId?: string | null;
    readonly predictors?: string | null;
    readonly adaptive?: boolean;
    readonly beta?: number | null;
    readonly targetMean?: number | null;
    readonly k?: number;
    readonly epsilon?: number;
  }
);

/** 能力族：度量 / 几何转换 / 融合 / 属性 / 分幅。增补：分割 / 聚合 / 矩阵 / 精确最近。 */
export const CAPABILITY_OPERATIONS = [
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

export type CapabilityOperation = (typeof CAPABILITY_OPERATIONS)[number];

type CapabilityCall = Extract<GisOperationCall, { readonly operation: CapabilityOperation }>;

function isCapabilityCall(call: GisOperationCall): call is CapabilityCall {
  return (CAPABILITY_OPERATIONS as readonly string[]).includes(call.operation);
}

export interface GisExecuteResult {
  readonly operationId: string;
  readonly ok: boolean;
  readonly record: OperationRecord;
  readonly result?: SpatialRunResult;
  readonly error?: unknown;
}

export interface OperationRollbackPorts {
  readonly root?: string;
  readonly removeLayer: (layerId: string) => Promise<boolean>;
  readonly deleteKnowledge: (id: string) => Promise<boolean>;
  readonly dropCacheKey: (key: string, resultLayerIds: readonly string[]) => Promise<"removed" | "kept" | "missing">;
  readonly deleteSuccessAudit?: (recordId: string) => Promise<boolean>;
}

export interface OperationRollbackResult {
  readonly ok: boolean;
  readonly operationId: string;
  readonly status: "rolled_back" | "rollback_failed";
  readonly cleaned: readonly OperationRollbackItem[];
  readonly remaining: readonly OperationRollbackItem[];
  readonly record: OperationRecord;
}

function boundaryOf(call: GisOperationCall): {
  readonly source: OperationSource;
  readonly aiOrigin: boolean;
  readonly translationUsed: boolean;
  readonly requestSource: RequestSource;
  readonly dataBoundaryLevel?: DataBoundaryLevel;
} {
  // chat 入口不代表调用过模型。没写明来源时按本地解析器，避免把本地计划记成 cloud-ai。
  const byEntry = call.entry === "map"
    ? { source: "local-user" as const, aiOrigin: false, translationUsed: false, requestSource: "desktop-ui" as const }
    : call.entry === "mcp"
      ? { source: "mcp" as const, aiOrigin: true, translationUsed: true, requestSource: "mcp" as const }
      : call.entry === "gdl"
        ? { source: "local-user" as const, aiOrigin: false, translationUsed: false, requestSource: "internal" as const }
        : { source: "local-parser" as const, aiOrigin: false, translationUsed: false, requestSource: "internal" as const };
  const translationUsed = call.translationUsed ?? byEntry.translationUsed;
  const dataBoundaryLevel = call.dataBoundaryLevel ?? (translationUsed ? "L2" as const : undefined);
  return {
    source: call.source ?? byEntry.source,
    aiOrigin: call.aiOrigin ?? byEntry.aiOrigin,
    translationUsed,
    requestSource: call.requestSource ?? byEntry.requestSource,
    ...(dataBoundaryLevel === "L2" ? { dataBoundaryLevel } : {}),
  };
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  return "空间分析没有完成。";
}

function policyOf(policy: ExecutionPolicy): { readonly writeKnowledge: boolean } {
  return { writeKnowledge: policy.writeKnowledge === true };
}

function summaryOf(call: GisOperationCall): OperationRequestSummary {
  if (call.operation === "buffer") {
    return {
      layerIds: [call.sourceLayer.layerId],
      layerNames: [call.sourceLayer.layerName],
      distance: call.distance,
      unit: call.unit,
      outputName: call.outputName ?? null,
    };
  }
  if (call.operation === "intersect" || call.operation === "clip") {
    return {
      layerIds: [call.layerId, call.otherLayerId],
      layerNames: [call.layerName, call.otherLayerName],
      otherLayerId: call.otherLayerId,
      outputName: call.outputName ?? null,
    };
  }
  if (call.operation === "query") {
    return {
      layerIds: call.otherLayerId ? [call.layerId, call.otherLayerId] : [call.layerId],
      layerNames: call.otherLayerName ? [call.layerName, call.otherLayerName] : [call.layerName],
      otherLayerId: call.otherLayerId ?? null,
      queryKind: call.queryKind,
      attributeFilter: call.attributeFilter ?? null,
    };
  }
  if (call.operation === "stats") {
    return {
      layerIds: [call.layerId],
      layerNames: [call.layerName],
      fieldName: call.fieldName ?? null,
    };
  }
  if (isCapabilityCall(call)) {
    return {
      layerIds: [call.layerId, ...(call.otherLayerId ? [call.otherLayerId] : [])],
      layerNames: [call.layerName, ...(call.otherLayerId ? [call.otherLayerName ?? call.otherLayerId] : [])],
      outputName: call.outputName ?? null,
      ...(call.otherLayerId ? { otherLayerId: call.otherLayerId } : {}),
      ...(call.fieldName !== undefined ? { fieldName: call.fieldName ?? null } : {}),
      ...(call.target !== undefined ? { target: call.target ?? null } : {}),
      ...(call.tolerance !== undefined ? { tolerance: call.tolerance } : {}),
      ...(call.groupField !== undefined ? { groupField: call.groupField ?? null } : {}),
      ...(call.mapping !== undefined ? { mapping: call.mapping ?? null } : {}),
      ...(call.columns !== undefined ? { columns: call.columns } : {}),
      ...(call.rows !== undefined ? { rows: call.rows } : {}),
      ...(call.targetCrs !== undefined ? { targetCrs: call.targetCrs ?? null } : {}),
      ...(call.format !== undefined ? { format: call.format ?? null } : {}),
      ...(call.derivative !== undefined ? { derivative: call.derivative ?? null } : {}),
      ...(call.interval !== undefined ? { interval: call.interval } : {}),
      ...(call.op !== undefined ? { op: call.op ?? null } : {}),
      ...(call.limit !== undefined ? { limit: call.limit } : {}),
      ...(typeof call.distance === "number" ? { distance: call.distance } : {}),
      ...(typeof call.noData === "number" ? { noData: call.noData } : {}),
      ...(call.lineLayerId ? { lineLayerId: call.lineLayerId } : {}),
      ...(call.indexName !== undefined ? { indexName: call.indexName ?? null } : {}),
      ...(typeof call.size === "number" ? { size: call.size } : {}),
      ...(call.targetLayerId ? { targetLayerId: call.targetLayerId } : {}),
      ...(call.predictors !== undefined ? { predictors: call.predictors ?? null } : {}),
      ...(typeof call.adaptive === "boolean" ? { adaptive: call.adaptive } : {}),
      ...(typeof call.beta === "number" ? { beta: call.beta } : {}),
      ...(typeof call.targetMean === "number" ? { targetMean: call.targetMean } : {}),
      ...(typeof call.k === "number" ? { k: call.k } : {}),
      ...(typeof call.epsilon === "number" ? { epsilon: call.epsilon } : {}),
    };
  }
  throw new Error("不认识的空间操作。");
}

function withStatus(record: OperationRecord, status: OperationStatus, patch: Partial<OperationRecord> = {}): OperationRecord {
  const statusLog = record.statusLog.at(-1) === status ? record.statusLog : [...record.statusLog, status];
  return { ...record, ...patch, status, statusLog };
}

function sideEffectsOf(result: SpatialRunResult): OperationSideEffects {
  const createdLayerIds = result.cached === true || !result.layer ? [] : [result.layer.layerId];
  const cacheKeys = result.cached === true || typeof result.cacheKey !== "string" ? [] : [result.cacheKey];
  const knowledgeIds = typeof result.ragEntryId === "string" && result.ragEntryId !== "" ? [result.ragEntryId] : [];
  return {
    ...(createdLayerIds.length > 0 ? { createdLayerIds } : {}),
    ...(cacheKeys.length > 0 ? { cacheKeys } : {}),
    ...(knowledgeIds.length > 0 ? { knowledgeIds } : {}),
  };
}

function crsOf(result: SpatialRunResult | undefined, error: unknown): OperationRecord["crs"] | undefined {
  if (result?.crs) return result.crs;
  if (error instanceof SpatialOpError && error.crsFacts) return error.crsFacts;
  return undefined;
}

function auditOf(result: SpatialRunResult): { readonly auditRecordIds: readonly string[]; readonly auditAppendFailed?: true } {
  if (typeof result.auditRecordId === "string" && result.auditRecordId !== "") {
    return { auditRecordIds: [result.auditRecordId] };
  }
  if (result.auditAppendFailed === true) return { auditRecordIds: [], auditAppendFailed: true };
  return { auditRecordIds: [] };
}

function failureAudit(error: unknown): { readonly message: string; readonly auditRecordId?: string; readonly auditAppendFailed?: true } {
  const message = errorText(error);
  if (error instanceof SpatialOpError && typeof error.auditRecordId === "string" && error.auditRecordId !== "") {
    return { message, auditRecordId: error.auditRecordId };
  }
  if (error instanceof SpatialOpError && error.auditAppendFailed === true) {
    return { message, auditAppendFailed: true };
  }
  return { message };
}

function validateCall(call: GisOperationCall): string | null {
  if (call.operation === "buffer") {
    const outputName = call.outputName ?? undefined;
    const built = outputName !== undefined && outputName !== null
      ? bufferRequestFromResolution(call.sourceLayer, call.distance, call.unit as "meters", outputName)
      : bufferRequestFromResolution(call.sourceLayer, call.distance, call.unit as "meters");
    if (!built.ok) return "图层没有解析成唯一身份。";
    const validation = validateBufferOperation(
      typeof call.distance === "number" ? built.request : { ...built.request, distance: call.distance },
    );
    if (!validation.ok) return validation.errors.map((item) => item.message).join("") || "缓冲请求不合法。";
    return null;
  }
  if (isCapabilityCall(call)) return validateCapabilityCall(call);
  const ids = call.operation === "query" || call.operation === "stats"
    ? [call.layerId]
    : [call.layerId, call.otherLayerId];
  if (ids.some((id) => id.trim() === "")) return "图层没有解析成唯一身份。";
  if (call.operation === "query" && call.queryKind.trim() === "") return "空间查询需要查询种类。";
  return null;
}

function validateCapabilityCall(call: CapabilityCall): string | null {
  if (call.layerId.trim() === "") return "图层没有解析成唯一身份。";
  if (call.operation === "distance" || call.operation === "nearest" || call.operation === "merge" || call.operation === "bearing"
    || call.operation === "split-line" || call.operation === "split-polygon" || call.operation === "spatial-aggregate"
    || call.operation === "distance-matrix" || call.operation === "nearest-exact" || call.operation === "nearest-on-line" || call.operation === "join"
    || call.operation === "erase" || call.operation === "union" || call.operation === "spatial-join" || call.operation === "network-snap"
    || call.operation === "network-distance" || call.operation === "raster-clip" || call.operation === "zonal" || call.operation === "raster-index" || call.operation === "viewshed"
    || call.operation === "cost-corridor" || call.operation === "classify" || call.operation === "od-flow" || call.operation === "dp-grid"
    || call.operation === "watershed" || call.operation === "profile" || call.operation === "cut-fill") {
    if (!call.otherLayerId || call.otherLayerId.trim() === "") return "这个操作需要第二个图层。";
  }
  if (call.operation === "water-level" && !(typeof call.distance === "number" && Number.isFinite(call.distance))) {
    return "水位没写。请给出水面高程，程序不会填一个数。";
  }
  if (call.operation === "layer-stack") {
    const count = (call.mapping ?? "").split(",").map((item) => item.trim()).filter((item) => item !== "").length;
    if (count < 2) return "爆炸图需要至少两个已载入的图层。图层不够时不登记，也不出图。";
    if (!(typeof call.distance === "number" && Number.isFinite(call.distance) && call.distance >= 0)) {
      return "爆炸图需要大于或等于 0 的层间竖向间距。没写间距就不登记。";
    }
  }
  if (call.operation === "geology-inputs" && (!(call.fieldName ?? "").trim() || !(call.groupField ?? "").trim() || !(call.target ?? "").trim())) {
    return "地层体需要界面点图层、界面字段、倾角字段和倾向字段。缺了就问，这一步不生成体。";
  }
  if ((call.operation === "rainfall-runoff" || call.operation === "rainfall-landslide") && !(call.target ?? "").trim()) {
    return "降雨情景没写。请向用户问雨强（毫米每小时）和历时（小时），写成 30x2;60x1 这样。程序不会填数。";
  }
  if (call.operation === "rainfall-runoff" && !/(^|;)\s*manning\s*=/.test(call.mapping ?? "")) {
    return "曼宁糙率没写。请向用户问地表糙率，程序不会填一个数。";
  }
  if (call.operation === "geology-model" && !(typeof call.distance === "number" && Number.isFinite(call.distance) && call.distance > 0)) {
    return "模型向下延伸的深度没写。请向用户问要建到最低界面点以下多少米，程序不会填数。";
  }
  if (call.operation === "convert" && call.target !== "polygon" && call.target !== "line") {
    return "几何转换的目标只能是 polygon 或 line。";
  }
  if (call.operation === "simplify" && !(typeof call.tolerance === "number" && Number.isFinite(call.tolerance) && call.tolerance > 0)) {
    return "简化容差必须是大于 0 的米数。";
  }
  if (call.operation === "split-grid") {
    const columns = call.columns;
    const rows = call.rows;
    if (!Number.isInteger(columns) || !Number.isInteger(rows) || (columns ?? 0) < 1 || (rows ?? 0) < 1 || (columns ?? 0) > 6 || (rows ?? 0) > 6) {
      return "分幅的列数和行数必须是 1 到 6 的整数。";
    }
  }
  if (call.operation === "group-stats" && (!(call.groupField ?? "").trim() || !(call.fieldName ?? "").trim())) {
    return "分组统计需要分组字段和统计字段。";
  }
  if (call.operation === "reclassify" && (!(call.fieldName ?? "").trim() || !(call.mapping ?? "").trim())) {
    return "重分类需要字段名和映射表。";
  }
  if (call.operation === "field-calc" && (!(call.fieldName ?? "").trim() || !(call.mapping ?? "").trim())) {
    return "字段计算需要新字段名和计算式。";
  }
  if (call.operation === "join" && (!(call.fieldName ?? "").trim() || !(call.groupField ?? "").trim())) {
    return "属性连接需要两边的字段名。";
  }
  if (call.operation === "raster-cast") {
    const kind = (call.target ?? "").trim().toLowerCase();
    if (kind !== "int16" && kind !== "int32" && kind !== "float32") return "栅格类型只支持 int16、int32、float32。";
  }
  if (call.operation === "raster-nodata" && !(typeof call.noData === "number" && Number.isFinite(call.noData))) {
    return "NoData 必须是有限数值。";
  }
  if (call.operation === "network-distance" && !(call.lineLayerId ?? "").trim()) return "沿路距离还需要线图层。";
  if (call.operation === "service-area" && !(call.lineLayerId ?? call.otherLayerId ?? "").trim()) return "服务范围需要线图层。";
  if (call.operation === "service-area" && !(call.distance && call.distance > 0)) return "服务范围需要大于 0 的距离。";
  if ((call.operation === "rasterize" || call.operation === "resample" || call.operation === "aggregate-grid") && !(call.tolerance && call.tolerance > 0)) {
    return "格网边长必须大于 0。";
  }
  if (call.operation === "focal" && call.size !== 3 && call.size !== 5 && call.size !== 7) return "邻域边长只支持 3、5、7。";
  if (call.operation === "raster-index") {
    const kind = (call.indexName ?? call.target ?? "").trim().toLowerCase();
    if (kind !== "ndvi" && kind !== "ndwi" && kind !== "savi") return "指数只支持 ndvi、ndwi、savi。";
  }
  if (call.operation === "kernel-density" && (!(call.distance && call.distance > 0) || !(call.tolerance && call.tolerance > 0))) {
    return "核密度需要大于 0 的带宽和格网边长。";
  }
  if (call.operation === "chart" && !(call.fieldName ?? "").trim()) return "统计图需要数值字段。";
  if (call.operation === "offset-line" && !(typeof call.distance === "number" && Number.isFinite(call.distance) && call.distance !== 0)) {
    return "平行线需要非零距离。正数在左侧，负数在右侧。";
  }
  if (call.operation === "cost-corridor" && !(call.targetLayerId ?? "").trim()) return "最小费用走廊需要终点图层。";
  if (call.operation === "cost-corridor" && typeof call.tolerance === "number" && !(call.tolerance >= 0 && call.tolerance <= 1)) return "走廊宽容度必须在 0 到 1 之间。";
  if (call.operation === "classify" && !(call.fieldName ?? "").trim()) return "监督分类需要类别字段。";
  if (call.operation === "hotspot" && (!(call.fieldName ?? "").trim() || !(typeof call.distance === "number" && call.distance > 0))) {
    return "热点分析需要数值字段和大于 0 的邻域距离。";
  }
  if (call.operation === "gwr" && (!(call.fieldName ?? "").trim() || !(call.predictors ?? "").trim())) return "地理加权回归需要因变量和自变量。";
  if (call.operation === "od-flow") {
    if (!(call.fieldName ?? "").trim() || !(call.groupField ?? "").trim()) return "OD 流量需要产生量字段和吸引量字段。";
    if ((typeof call.beta === "number") === (typeof call.targetMean === "number")) return "OD 流量的 β 和目标平均距离要给且只给一个。";
  }
  if (call.operation === "k-anonymity" && !(Number.isInteger(call.k) && (call.k ?? 0) >= 2)) return "k 必须是不小于 2 的整数。";
  if (call.operation === "dp-grid" && !(typeof call.epsilon === "number" && Number.isFinite(call.epsilon) && call.epsilon > 0)) return "ε 必须大于 0。";
  if (call.operation === "kriging" && !(call.fieldName ?? "").trim()) return "克里金需要数值字段。";
  if (call.operation === "kriging" && call.tolerance !== undefined && !(Number.isFinite(call.tolerance) && call.tolerance > 0)) return "格网边长必须大于 0。";
  if (call.operation === "interpolate") {
    const kind = (call.target ?? "").trim().toLowerCase();
    if (!(call.fieldName ?? "").trim()) return "插值需要字段名。";
    if (kind !== "invdist" && kind !== "nearest" && kind !== "linear") return "插值只支持 invdist、nearest、linear。";
  }
  if (call.operation === "reproject" && !(call.targetCrs ?? "").trim()) {
    return "重投影需要目标坐标系。";
  }
  if (call.operation === "convert-format" && !(call.format ?? "").trim()) {
    return "格式转换需要目标格式。";
  }
  if (call.operation === "dem-derivative") {
    const kind = (call.derivative ?? "").trim().toLowerCase();
    if (kind !== "slope" && kind !== "aspect" && kind !== "hillshade") {
      return "DEM 衍生只支持 slope、aspect、hillshade。";
    }
  }
  if (call.operation === "contour" && !(typeof call.interval === "number" && Number.isFinite(call.interval) && call.interval > 0)) {
    return "等高距必须大于 0。";
  }
  if (call.operation === "raster-calc") {
    const kind = (call.op ?? "").trim().toLowerCase();
    if (!["add", "subtract", "multiply", "divide", "min", "max"].includes(kind)) {
      return "栅格运算只支持 add、subtract、multiply、divide、min、max。";
    }
    if (!(call.otherLayerId ?? "").trim()) return "栅格运算需要两个栅格。";
  }
  if (call.operation === "distance-matrix") {
    const limit = call.limit;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 10000)) {
      return "距离矩阵上限必须是 1 到 10000 的整数。";
    }
  }
  return null;
}

async function runService(service: SpatialService, call: GisOperationCall): Promise<SpatialRunResult> {
  const writeKnowledge = call.policy.writeKnowledge === true;
  if (call.operation === "buffer") {
    return service.buffer(call.sourceLayer.layerId, call.distance, call.unit, writeKnowledge, call.outputName ?? null);
  }
  if (call.operation === "intersect") {
    return service.intersect(call.layerId, call.otherLayerId, writeKnowledge, call.outputName ?? null);
  }
  if (call.operation === "clip") {
    return service.clip(call.layerId, call.otherLayerId, writeKnowledge, call.outputName ?? null);
  }
  if (call.operation === "query") {
    return service.query(call.layerId, call.otherLayerId ?? null, call.queryKind, call.attributeFilter ?? null, writeKnowledge);
  }
  if (call.operation === "stats") {
    return service.stats(call.layerId, call.fieldName ?? null, writeKnowledge);
  }
  if (isCapabilityCall(call)) {
    if (call.operation === "area") return service.area(call.layerId, writeKnowledge);
    if (call.operation === "length") return service.length(call.layerId, writeKnowledge);
    if (call.operation === "distance") return service.distanceStats(call.layerId, call.otherLayerId ?? "", writeKnowledge);
    if (call.operation === "nearest") return service.nearest(call.layerId, call.otherLayerId ?? "", writeKnowledge, call.outputName ?? null);
    if (call.operation === "convert") return service.convert(call.layerId, call.target ?? "", writeKnowledge, call.outputName ?? null);
    if (call.operation === "dissolve") return service.dissolve(call.layerId, call.groupField ?? null, writeKnowledge, call.outputName ?? null);
    if (call.operation === "merge") return service.merge(call.layerId, call.otherLayerId ?? "", writeKnowledge, call.outputName ?? null);
    if (call.operation === "simplify") return service.simplify(call.layerId, call.tolerance ?? 0, writeKnowledge, call.outputName ?? null);
    if (call.operation === "group-stats") return service.groupStats(call.layerId, call.groupField ?? "", call.fieldName ?? "", writeKnowledge);
    if (call.operation === "reclassify") return service.reclassify(call.layerId, call.fieldName ?? "", call.mapping ?? "", writeKnowledge, call.outputName ?? null);
    if (call.operation === "quality-check") return service.qualityCheck(call.layerId, writeKnowledge);
    if (call.operation === "voronoi") return service.voronoi(call.layerId, writeKnowledge, call.outputName ?? null);
    if (call.operation === "convex-hull") return service.convexHull(call.layerId, writeKnowledge, call.outputName ?? null);
    if (call.operation === "min-bbox") return service.minBBox(call.layerId, writeKnowledge, call.outputName ?? null);
    if (call.operation === "centroid") return service.centroid(call.layerId, writeKnowledge, call.outputName ?? null);
    if (call.operation === "bearing") return service.bearing(call.layerId, call.otherLayerId ?? "", writeKnowledge, call.outputName ?? null);
    if (call.operation === "make-valid") return service.makeValid(call.layerId, writeKnowledge, call.outputName ?? null);
    if (call.operation === "reproject") return service.reproject(call.layerId, call.targetCrs ?? "", writeKnowledge, call.outputName ?? null);
    if (call.operation === "convert-format") return service.convertFormat(call.layerId, call.format ?? "", writeKnowledge, call.outputName ?? null);
    if (call.operation === "dem-derivative") return service.demDerivative(call.layerId, call.derivative ?? "");
    if (call.operation === "contour") return service.contour(call.layerId, call.interval ?? 0, writeKnowledge, call.outputName ?? null);
    if (call.operation === "raster-calc") return service.rasterCalc(call.layerId, call.otherLayerId ?? "", call.op ?? "");
    if (call.operation === "raster-info") return service.rasterInfo(call.layerId);
    if (call.operation === "split-line") return service.splitLine(call.layerId, call.otherLayerId ?? "", writeKnowledge, call.outputName ?? null);
    if (call.operation === "explode") return service.explode(call.layerId, writeKnowledge, call.outputName ?? null);
    if (call.operation === "vertices") return service.vertices(call.layerId, writeKnowledge, call.outputName ?? null);
    if (call.operation === "line-intersect") return service.lineIntersect(call.layerId, call.otherLayerId ?? null, writeKnowledge, call.outputName ?? null);
    if (call.operation === "transform") return service.transform(call.layerId, call.target ?? "", call.distance ?? null, call.bearing ?? null, call.angle ?? null, call.factor ?? null, writeKnowledge, call.outputName ?? null);
    if (call.operation === "nearest-on-line") return service.nearestOnLine(call.layerId, call.otherLayerId ?? "", writeKnowledge, call.outputName ?? null);
    if (call.operation === "grid") return service.grid(call.layerId, call.tolerance ?? 0, writeKnowledge, call.outputName ?? null);
    if (call.operation === "split-polygon") return service.splitPolygon(call.layerId, call.otherLayerId ?? "", writeKnowledge, call.outputName ?? null);
    if (call.operation === "spatial-aggregate") return service.spatialAggregate(call.layerId, call.otherLayerId ?? "", call.fieldName ?? null, writeKnowledge, call.outputName ?? null);
    if (call.operation === "distance-matrix") return service.distanceMatrixStats(call.layerId, call.otherLayerId ?? "", call.limit ?? 10000, writeKnowledge);
    if (call.operation === "nearest-exact") return service.nearestExact(call.layerId, call.otherLayerId ?? "", writeKnowledge, call.outputName ?? null);
    if (call.operation === "field-calc") return service.calculateField(call.layerId, call.mapping ?? "", call.fieldName ?? "", writeKnowledge, call.outputName ?? null);
    if (call.operation === "join") return service.joinAttributes(call.layerId, call.otherLayerId ?? "", call.fieldName ?? "", call.groupField ?? "", writeKnowledge, call.outputName ?? null);
    if (call.operation === "raster-cast") return service.rasterCast(call.layerId, call.target ?? "");
    if (call.operation === "raster-nodata") return service.rasterNoData(call.layerId, call.noData ?? Number.NaN);
    if (call.operation === "raster-smooth") return service.rasterSmooth(call.layerId);
    if (call.operation === "interpolate") return service.interpolate(call.layerId, call.fieldName ?? "", call.target ?? "", writeKnowledge);
    if (call.operation === "erase") return service.erase(call.layerId, call.otherLayerId ?? "", writeKnowledge, call.outputName ?? null);
    if (call.operation === "union") return service.unionOverlay(call.layerId, call.otherLayerId ?? "", writeKnowledge, call.outputName ?? null);
    if (call.operation === "spatial-join") return service.spatialJoin(call.layerId, call.otherLayerId ?? "", writeKnowledge, call.outputName ?? null);
    if (call.operation === "viewshed") return service.viewshed(call.layerId, call.otherLayerId ?? "", call.distance ?? 0);
    if (call.operation === "raster-clip") return service.rasterClip(call.layerId, call.otherLayerId ?? "");
    if (call.operation === "polygonize") return service.polygonize(call.layerId, writeKnowledge, call.outputName ?? null);
    if (call.operation === "rasterize") return service.rasterize(call.layerId, call.tolerance ?? 0);
    if (call.operation === "zonal") return service.zonal(call.layerId, call.otherLayerId ?? "");
    if (call.operation === "resample") return service.resample(call.layerId, call.tolerance ?? 0);
    if (call.operation === "raster-index") return service.rasterIndex(call.layerId, call.otherLayerId ?? "", call.indexName ?? call.target ?? "");
    if (call.operation === "focal") return service.focal(call.layerId, call.size ?? 0);
    if (call.operation === "quadtree") return service.quadtree(call.layerId, writeKnowledge, call.outputName ?? null);
    if (call.operation === "chart") return service.chart(call.layerId, call.fieldName ?? "", writeKnowledge);
    if (call.operation === "kernel-density") return service.kernelDensity(call.layerId, call.distance ?? 0, call.tolerance ?? 0, writeKnowledge, call.outputName ?? null);
    if (call.operation === "network-snap") return service.snapToNetwork(call.layerId, call.otherLayerId ?? "", writeKnowledge, call.outputName ?? null);
    if (call.operation === "network-distance") return service.networkDistance(call.layerId, call.otherLayerId ?? "", call.lineLayerId ?? "", writeKnowledge);
    if (call.operation === "service-area") return service.serviceArea(call.layerId, call.lineLayerId ?? call.otherLayerId ?? "", call.distance ?? 0, writeKnowledge, call.outputName ?? null);
    if (call.operation === "aggregate-grid") return service.aggregateGrid(call.layerId, call.tolerance ?? 0, writeKnowledge, call.outputName ?? null);
    if (call.operation === "offset-line") return service.offsetLine(call.layerId, call.distance ?? 0, call.target ?? null, writeKnowledge, call.outputName ?? null);
    if (call.operation === "cost-corridor") return service.costCorridor(call.layerId, call.otherLayerId ?? "", call.targetLayerId ?? "", call.tolerance ?? null, writeKnowledge, call.outputName ?? null);
    if (call.operation === "classify") return service.classify(call.layerId, call.otherLayerId ?? "", call.fieldName ?? "", call.target ?? null, call.tolerance ?? null);
    if (call.operation === "hotspot") return service.hotspot(call.layerId, call.fieldName ?? "", call.distance ?? 0, call.lineLayerId ?? null, writeKnowledge, call.outputName ?? null);
    if (call.operation === "gwr") return service.gwr(call.layerId, call.fieldName ?? "", call.predictors ?? "", call.target ?? null, call.adaptive ?? true, call.distance ?? null, writeKnowledge, call.outputName ?? null);
    if (call.operation === "od-flow") return service.odFlow(call.layerId, call.otherLayerId ?? "", call.fieldName ?? "", call.groupField ?? "", call.lineLayerId ?? null, call.target ?? null, call.beta ?? null, call.targetMean ?? null, writeKnowledge, call.outputName ?? null);
    if (call.operation === "k-anonymity") return service.kAnonymize(call.layerId, call.k ?? 0, writeKnowledge, call.outputName ?? null);
    if (call.operation === "dp-grid") return service.dpGrid(call.layerId, call.otherLayerId ?? "", call.epsilon ?? 0, writeKnowledge, call.outputName ?? null);
    if (call.operation === "kriging") return service.kriging(call.layerId, call.fieldName ?? "", call.tolerance ?? null, writeKnowledge);
    if (call.operation === "watershed") return service.watershed(call.layerId, call.otherLayerId ?? "", writeKnowledge, call.outputName ?? null);
    if (call.operation === "profile") return service.profile(call.layerId, call.otherLayerId ?? "", writeKnowledge, call.outputName ?? null);
    if (call.operation === "cut-fill") return service.cutFill(call.layerId, call.otherLayerId ?? "", writeKnowledge);
    if (call.operation === "water-level") return service.waterLevel(call.layerId, call.distance ?? Number.NaN, writeKnowledge);
    if (call.operation === "layer-stack") {
      const ordered = (call.mapping ?? "").split(",").map((item) => item.trim()).filter((item) => item !== "");
      return service.layerStack(ordered, call.distance ?? Number.NaN, writeKnowledge);
    }
    if (call.operation === "geology-inputs") return service.geologyInputs(call.layerId, call.fieldName ?? "", call.groupField ?? "", call.target ?? "", writeKnowledge);
    if (call.operation === "rainfall-runoff") return service.rainfallRunoff(call.layerId, call.target ?? null, call.mapping ?? null, call.op ?? null, writeKnowledge);
    if (call.operation === "rainfall-landslide") return service.rainfallLandslide(call.layerId, call.target ?? null, call.mapping ?? null, writeKnowledge);
    if (call.operation === "geology-model") return service.geologyModel(call.layerId, call.distance ?? Number.NaN, call.otherLayerId ?? null, writeKnowledge);
    return service.splitGrid(call.layerId, call.columns ?? 1, call.rows ?? 1, writeKnowledge, call.outputName ?? null);
  }
  throw new Error("不认识的空间操作。");
}

/** 创建 operationId，先写下 running，再校验已解析身份并调用现有空间服务。 */
export async function executeGisOperation(service: SpatialService, call: GisOperationCall): Promise<GisExecuteResult> {
  const operationId = createOperationId();
  const startedAt = new Date().toISOString();
  const boundary = boundaryOf(call);
  let record: OperationRecord = {
    operationId,
    operation: call.operation,
    entry: call.entry,
    status: "running",
    statusLog: ["running"],
    startedAt,
    request: summaryOf(call),
    policy: policyOf(call.policy),
    auditRecordIds: [],
    sideEffects: {},
    source: boundary.source,
    aiOrigin: boundary.aiOrigin,
    translationUsed: boundary.translationUsed,
    requestSource: boundary.requestSource,
    // 留痕契约：记录必须回答是否需要授权、谁授权。空间分析不需要授权。
    approvalState: call.approvalState ?? { required: false, confirmed: false },
    ...(boundary.dataBoundaryLevel ? { dataBoundaryLevel: boundary.dataBoundaryLevel } : {}),
  };
  await writeOperationRecord(record, call.root);
  const invalid = validateCall(call);
  if (invalid) {
    record = withStatus(record, "failed", {
      finishedAt: new Date().toISOString(),
      outcome: "failed",
      error: { message: invalid },
      auditRecordIds: [],
    });
    await writeOperationRecord(record, call.root);
    return { operationId, ok: false, record, error: new SpatialOpError(invalid) };
  }
  try {
    const result = await service.usingCallerCrs(call.callerCrs, () => service.usingRequestSource(boundary.requestSource, () => runService(service, call)));
    const audit = auditOf(result);
    const crs = crsOf(result, undefined);
    record = withStatus(record, "succeeded", {
      finishedAt: new Date().toISOString(),
      outcome: "succeeded",
      auditRecordIds: audit.auditRecordIds,
      ...(audit.auditAppendFailed ? { auditAppendFailed: true as const } : {}),
      sideEffects: sideEffectsOf(result),
      ...(crs ? { crs } : {}),
      // 栅格类产物只进记录的本地资源清单，永不出可见面。
      ...(result.localOutputResources && result.localOutputResources.length > 0
        ? { outputResources: result.localOutputResources }
        : {}),
    });
    await writeOperationRecord(record, call.root);
    return { operationId, ok: true, record, result };
  } catch (error) {
    const audit = failureAudit(error);
    const crs = crsOf(undefined, error);
    record = withStatus(record, "failed", {
      finishedAt: new Date().toISOString(),
      outcome: "failed",
      auditRecordIds: audit.auditRecordId ? [audit.auditRecordId] : [],
      ...(audit.auditAppendFailed ? { auditAppendFailed: true as const } : {}),
      ...(crs ? { crs } : {}),
      error: {
        message: audit.message,
        ...(audit.auditRecordId ? { auditRecordId: audit.auditRecordId } : {}),
      },
    });
    await writeOperationRecord(record, call.root);
    return { operationId, ok: false, record, error };
  }
}

async function rollbackItem(
  kind: OperationRollbackItem["kind"],
  id: string,
  run: () => Promise<OperationRollbackItem["state"]>,
): Promise<OperationRollbackItem> {
  try {
    const state = await run();
    return { kind, id, state };
  } catch (error) {
    return { kind, id, state: "failed", message: errorText(error) };
  }
}

/**
 * 按操作记录收回它自己的缓存键、知识条目和新建图层。
 * 先缓存和知识，再图层。失败审计和来源账本保留。
 */
export async function rollbackOperation(operationId: string, ports: OperationRollbackPorts): Promise<OperationRollbackResult> {
  const loaded = await readOperationRecord(operationId, ports.root);
  if (!loaded) throw new Error("找不到这次操作。");
  if (loaded.status === "rolled_back") {
    return {
      ok: true,
      operationId,
      status: "rolled_back",
      cleaned: loaded.rollback?.cleaned ?? [],
      remaining: loaded.rollback?.remaining ?? [],
      record: loaded,
    };
  }
  const gisFailed = loaded.outcome === "failed" || loaded.status === "failed";
  let record = withStatus(loaded, "rolling_back");
  await writeOperationRecord(record, ports.root);
  const items: OperationRollbackItem[] = [];
  const created = record.sideEffects.createdLayerIds ?? [];
  for (const key of record.sideEffects.cacheKeys ?? []) {
    items.push(await rollbackItem("cache", key, async () => {
      const state = await ports.dropCacheKey(key, created);
      if (state === "removed") return "removed";
      if (state === "missing") return "already-absent";
      return "kept";
    }));
  }
  for (const id of record.sideEffects.knowledgeIds ?? []) {
    items.push(await rollbackItem("knowledge", id, async () => {
      const removed = await ports.deleteKnowledge(id);
      return removed ? "removed" : "already-absent";
    }));
  }
  for (const id of created) {
    items.push(await rollbackItem("layer", id, async () => {
      const removed = await ports.removeLayer(id);
      return removed ? "removed" : "already-absent";
    }));
  }
  for (const id of record.auditRecordIds) {
    if (gisFailed || !ports.deleteSuccessAudit) {
      items.push({ kind: "audit", id, state: "kept", message: gisFailed ? "失败审计保留。" : "这次回退没有删除审计。" });
      continue;
    }
    items.push(await rollbackItem("audit", id, async () => {
      const removed = await ports.deleteSuccessAudit?.(id);
      return removed ? "removed" : "already-absent";
    }));
  }
  for (const id of record.sideEffects.provenanceIds ?? []) {
    items.push({ kind: "provenance", id, state: "kept", message: "来源账本保留，回退不删除。" });
  }
  const cleaned = items.filter((item) => item.state === "removed" || item.state === "already-absent");
  const remaining = items.filter((item) => item.state === "failed" || item.state === "kept");
  const failed = items.some((item) => item.state === "failed");
  const status: "rolled_back" | "rollback_failed" = failed ? "rollback_failed" : "rolled_back";
  record = withStatus(record, status, { rollback: { cleaned, remaining } });
  await writeOperationRecord(record, ports.root);
  return { ok: !failed, operationId, status, cleaned, remaining, record };
}

export type { OperationKind };
