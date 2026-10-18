// SPDX-License-Identifier: Apache-2.0

/**
 * AI GIS Worker Contract 的代码锚点（V0.85）。
 * 四条契约的单一事实源：能力（Capability）、可见面（Visibility）、授权（Authorization）、留痕（Audit）。
 * 与 ARCHITECTURE.md 互相引用；v085-contract-check 验证本文件与运行时现实一致。
 * 新增 GIS 能力必须登记到 CAPABILITY_MANIFEST 并满足四契约，不得产生第二套执行体系。
 */

/** 危险等级：只读可直接执行；写操作创建新图层可回退；变更/删除需用户授权。 */
export type DangerLevel = "read-only" | "derive" | "destructive";

/** 能力条目：一个 AI 可调用的 GIS 能力。 */
export interface CapabilityEntry {
  /** 工具名（与 GIS_TOOL_REGISTRY 一致）。 */
  readonly tool: string;
  /** 能力族（V0.87 起按族扩展：度量/几何转换/属性/格网）。 */
  readonly family: "data-inspect" | "spatial-analysis" | "layer-manage" | "workflow" | "measure" | "geometry-convert" | "attribute" | "grid" | "raster";
  readonly danger: DangerLevel;
  /** 需要用户授权才能执行（AI 不能自产授权）。 */
  readonly requiresApproval: boolean;
  /** 执行必须产生 OperationRecord。 */
  readonly audited: boolean;
  /** 能否与其它操作组合成多步计划（AI 可以看结果继续下一步）。 */
  readonly composable: boolean;
}

/**
 * 能力契约（Capability Contract）。
 * AI 只能调用这里登记的能力；组合执行与结果续查由 composable 表达；
 * 新能力必须先登记再实现，实现必须走 executeGisOperation。
 */
export const CAPABILITY_MANIFEST: readonly CapabilityEntry[] = [
  { tool: "list-layers", family: "data-inspect", danger: "read-only", requiresApproval: false, audited: true, composable: true },
  { tool: "get-layer-metadata", family: "data-inspect", danger: "read-only", requiresApproval: false, audited: true, composable: true },
  { tool: "get-sample-feature", family: "data-inspect", danger: "read-only", requiresApproval: false, audited: true, composable: true },
  { tool: "io.read", family: "data-inspect", danger: "read-only", requiresApproval: false, audited: true, composable: true },
  { tool: "io.listLayers", family: "data-inspect", danger: "read-only", requiresApproval: false, audited: true, composable: true },
  { tool: "map.list", family: "data-inspect", danger: "read-only", requiresApproval: false, audited: true, composable: true },
  { tool: "map.buffer", family: "spatial-analysis", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.intersect", family: "spatial-analysis", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.clip", family: "spatial-analysis", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.query", family: "spatial-analysis", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.stats", family: "spatial-analysis", danger: "read-only", requiresApproval: false, audited: true, composable: true },
  { tool: "map.load", family: "layer-manage", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.style", family: "layer-manage", danger: "read-only", requiresApproval: false, audited: true, composable: true },
  { tool: "map.setVisibility", family: "layer-manage", danger: "read-only", requiresApproval: false, audited: true, composable: true },
  { tool: "map.setOrder", family: "layer-manage", danger: "read-only", requiresApproval: false, audited: true, composable: true },
  { tool: "map.zoomToLayer", family: "layer-manage", danger: "read-only", requiresApproval: false, audited: true, composable: true },
  { tool: "map.exportGeoJson", family: "layer-manage", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.delete", family: "layer-manage", danger: "destructive", requiresApproval: true, audited: true, composable: true },
  { tool: "map.clearAll", family: "layer-manage", danger: "destructive", requiresApproval: true, audited: true, composable: true },
  { tool: "map.dropDatabase", family: "layer-manage", danger: "destructive", requiresApproval: true, audited: true, composable: false },
  { tool: "gdl.run", family: "workflow", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "gdl.describe", family: "workflow", danger: "read-only", requiresApproval: false, audited: true, composable: true },
  { tool: "map.area", family: "measure", danger: "read-only", requiresApproval: false, audited: true, composable: true },
  { tool: "map.length", family: "measure", danger: "read-only", requiresApproval: false, audited: true, composable: true },
  { tool: "map.distance", family: "measure", danger: "read-only", requiresApproval: false, audited: true, composable: true },
  { tool: "map.nearest", family: "measure", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.convert", family: "geometry-convert", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.dissolve", family: "geometry-convert", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.merge", family: "geometry-convert", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.simplify", family: "geometry-convert", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.groupStats", family: "attribute", danger: "read-only", requiresApproval: false, audited: true, composable: true },
  { tool: "map.reclassify", family: "attribute", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.qualityCheck", family: "attribute", danger: "read-only", requiresApproval: false, audited: true, composable: true },
  { tool: "map.splitByGrid", family: "grid", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.voronoi", family: "geometry-convert", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.convexHull", family: "geometry-convert", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.minBBox", family: "geometry-convert", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.centroid", family: "geometry-convert", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.bearing", family: "measure", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.exportCoordinates", family: "layer-manage", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.makeValid", family: "geometry-convert", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.reproject", family: "geometry-convert", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.convertFormat", family: "layer-manage", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.rasterInfo", family: "raster", danger: "read-only", requiresApproval: false, audited: true, composable: true },
  { tool: "map.demDerivative", family: "raster", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.rasterCalc", family: "raster", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.contour", family: "raster", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.splitLine", family: "geometry-convert", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.explode", family: "geometry-convert", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.vertices", family: "geometry-convert", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.lineIntersect", family: "geometry-convert", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.transform", family: "geometry-convert", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.nearestOnLine", family: "measure", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.grid", family: "grid", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.splitPolygon", family: "geometry-convert", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.spatialAggregate", family: "attribute", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.distanceMatrix", family: "measure", danger: "read-only", requiresApproval: false, audited: true, composable: true },
  { tool: "map.nearestExact", family: "measure", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.calculateField", family: "attribute", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.join", family: "attribute", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.rasterCast", family: "raster", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.rasterNoData", family: "raster", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.rasterSmooth", family: "raster", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.interpolate", family: "raster", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.erase", family: "spatial-analysis", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.union", family: "spatial-analysis", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.spatialJoin", family: "attribute", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.viewshed", family: "raster", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.rasterClip", family: "raster", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.polygonize", family: "raster", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.rasterize", family: "raster", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.zonal", family: "raster", danger: "read-only", requiresApproval: false, audited: true, composable: true },
  { tool: "map.resample", family: "raster", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.rasterIndex", family: "raster", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.focal", family: "raster", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.quadtree", family: "geometry-convert", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.chart", family: "attribute", danger: "read-only", requiresApproval: false, audited: true, composable: true },
  { tool: "map.kernelDensity", family: "raster", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.snapToNetwork", family: "measure", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.networkDistance", family: "measure", danger: "read-only", requiresApproval: false, audited: true, composable: true },
  { tool: "map.serviceArea", family: "measure", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.aggregateGrid", family: "geometry-convert", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.offsetLine", family: "geometry-convert", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.costCorridor", family: "raster", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.classify", family: "raster", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.hotspot", family: "spatial-analysis", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.gwr", family: "spatial-analysis", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.odFlow", family: "spatial-analysis", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.kAnonymize", family: "spatial-analysis", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.dpGrid", family: "spatial-analysis", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.kriging", family: "raster", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.watershed", family: "raster", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.profile", family: "raster", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.cutFill", family: "raster", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.waterLevel", family: "raster", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.layerStack", family: "layer-manage", danger: "read-only", requiresApproval: false, audited: true, composable: false },
  { tool: "map.geologyInputs", family: "layer-manage", danger: "read-only", requiresApproval: false, audited: true, composable: false },
  { tool: "map.rainfallRunoff", family: "raster", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.rainfallLandslide", family: "raster", danger: "derive", requiresApproval: false, audited: true, composable: true },
  { tool: "map.geologyModel", family: "raster", danger: "derive", requiresApproval: false, audited: true, composable: false },
  { tool: "map.exportMap", family: "layer-manage", danger: "read-only", requiresApproval: false, audited: false, composable: false },
];

/**
 * 可见面契约（Visibility Contract）。
 * AI 默认能看到的语义信息：图层标识/名称、几何类型、要素数、字段 schema、统计摘要、可用操作、结果摘要。
 * 默认看不到下列键。设置允许普通工程几何时，`projectForModel` 可以保留普通坐标；路径和范围仍然丢掉。
 * Translation Layer（projectForModel/releaseToModel + allowlist）是唯一的 AI/GIS 数据边界。
 */
export const VISIBILITY_FORBIDDEN_KEYS: readonly string[] = [
  "coordinates",
  "geometry",
  "geojson",
  "wkt",
  "wkb",
  "bbox",
  "bounds",
  "extent",
  "path",
  "filePath",
  "absolutePath",
  "sourcePath",
  "outputFilePath",
  "directory",
  "raster",
  "pixels",
];

/** 允许数字（统计摘要），但数字数组不得递归嵌套坐标结构。 */
export const VISIBILITY_NUMBERS_ALLOWED = true;

/**
 * 授权契约（Authorization Contract）。
 * 只读/分析直接执行；destructive 操作只能由用户确认授权。
 * AI 意图里不得携带授权字段；对话/计划恢复不得恢复授权；
 * 授权是一次性的 ApprovalToken，绑定操作与上下文，用后作废。
 */
export const AUTHORIZATION_REQUIRED_OPERATIONS: readonly string[] = ["map.delete", "map.clearAll", "map.dropDatabase"];

/** AI 意图/计划 schema 里禁止出现的授权字段（V0.86 起从注册表 schema 剥离）。 */
export const AUTHORIZATION_FORBIDDEN_INTENT_FIELDS: readonly string[] = ["confirm", "userConfirmed", "approval", "approved", "token"];

/** 授权来源：谁产生了一次授权。AI 不在其中——AI 永远不能是授权来源。 */
export type ApprovalIssuer = "local-ui" | "chat-ui" | "mcp-client" | "remote-user" | "system";

/**
 * 一次性授权凭据（Authorization 契约）。
 * 字段按可持久化、可过期设计（V0.86 为内存同步消费；部署/MCP 接入时补持久化与过期，字段不变）。
 */
export interface ApprovalToken {
  readonly tokenId: string;
  /** 绑定的操作与资源摘要（如 "map.delete:lyr-xxx"），防跨操作复用。 */
  readonly issuedFor: string;
  readonly issuedBy: ApprovalIssuer;
  readonly issuedAt: string;
  readonly expiresAt?: string;
  readonly consumedAt?: string;
}

const issuedTokens = new Map<string, ApprovalToken>();

/** 用户确认动作产生一次性授权。 */
export function issueApprovalToken(issuedFor: string, issuedBy: ApprovalIssuer): ApprovalToken {
  const token: ApprovalToken = {
    tokenId: `ap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    issuedFor,
    issuedBy,
    issuedAt: new Date().toISOString(),
    ...(issuedBy === "remote-user" ? { expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() } : {}),
  };
  issuedTokens.set(token.tokenId, token);
  return token;
}

/**
 * 消费授权：一次性，用后作废；过期拒绝；绑定操作不符拒绝。
 * 返回的 token 带 consumedAt，可直接写入 OperationRecord.approvalState。
 */
export function consumeApprovalToken(tokenId: string, issuedFor: string): ApprovalToken | null {
  const token = issuedTokens.get(tokenId);
  if (!token) return null;
  if (token.consumedAt !== undefined) return null;
  if (token.issuedFor !== issuedFor) return null;
  if (token.expiresAt !== undefined && Date.parse(token.expiresAt) < Date.now()) {
    issuedTokens.delete(tokenId);
    return null;
  }
  const consumed: ApprovalToken = { ...token, consumedAt: new Date().toISOString() };
  issuedTokens.set(tokenId, consumed);
  return consumed;
}

/** 操作记录里的授权状态。required 而无 approval 表示未授权执行（错误）。 */
export interface ApprovalState {
  readonly required: boolean;
  readonly confirmed: boolean;
  readonly confirmedBy?: ApprovalIssuer;
  readonly tokenId?: string;
  readonly consumedAt?: string;
}

/** 用户确认动作走的统一授权消费：产生一次性 token 并立即消费，返回可写入操作记录的授权状态。 */
export function issueAndConsumeApproval(issuedFor: string, issuedBy: ApprovalIssuer): ApprovalState {
  const token = consumeApprovalToken(issueApprovalToken(issuedFor, issuedBy).tokenId, issuedFor);
  return {
    required: true,
    confirmed: true,
    confirmedBy: issuedBy,
    ...(token ? { tokenId: token.tokenId, ...(token.consumedAt ? { consumedAt: token.consumedAt } : {}) } : {}),
  };
}

/**
 * 留痕契约（Audit Contract）。
 * 一切改变 GIS 状态的操作必须产生 OperationRecord，至少回答：
 * 谁/何时/从哪入口/做了什么/作用于什么/产生什么/删了什么/是否需要授权/谁授权/是否 AI 发起/是否成功。
 */
export const AUDIT_REQUIRED_FIELDS: readonly string[] = [
  "operationId",
  "action",
  "entry",
  "source",
  "aiOrigin",
  "requestSource",
  "inputResources",
  "outputResources",
  "approvalState",
  "executionEnvironment",
  "crs",
  "sideEffects",
  "outcome",
  "createdAt",
];

/** 需要产生 OperationRecord 的状态变更操作（含非空间变更，V0.86 补全实现；V0.87 能力族全量入账）。 */
export const AUDIT_REQUIRED_OPERATIONS: readonly string[] = [
  "buffer",
  "intersect",
  "clip",
  "query",
  "stats",
  "load",
  "delete",
  "rename",
  "export",
  "import",
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
];
