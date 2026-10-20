// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { cwd } from "node:process";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RequestSource } from "@igis/ai-boundary";
import { loadGdalRuntime, readVectorLayersAsGeoJson } from "@igis/gdal-wasm-adapter";
import type { GdalRuntime } from "@igis/gdal-wasm-adapter";
import { GisIoReadError } from "@igis/gis-io";
import { SpatialAuditLedger, buildSpatialAuditRecord } from "@igis/provenance";
import type { SpatialAuditOperation, SpatialAuditParameters } from "@igis/provenance";
import { DEFAULT_CRS_LABEL, SurtGisCoreError, crsLabelFor, epsgFromWkt, geometryKindOfType, identifyCrs, invalidCrs, isUnusableIssue, planarUnitToMeter, simplifyFeatures, transformViaDefinitions, validateCollection } from "@igis/surtgis";
import type { CoreGeometryKind, CrsIdentity, GeometryIssue, LayerStyleInput } from "@igis/surtgis";
import { MapLayerCatalog } from "./catalog.js";
import type { LayerMeta } from "./catalog.js";
import { CRS_CALLER_CONFLICT, callerConflicts, planCrsExecution, transformDefinitionOf, userCrsMessage } from "./crs-policy.js";
import { ui } from "./locale.js";
import {
  aggregateGridFeatures,
  chartBins,
  eraseFeatures,
  kernelDensityFeatures,
  networkDistanceStats,
  quadtreeFeatures,
  serviceAreaFeatures,
  snapToNetworkFeatures,
  spatialJoinLocationFeatures,
  unionOverlayFeatures,
  measureUnit,
  type Measure,
} from "./v093-ops.js";
import {
  dpGridFeatures,
  euclideanHotspotFeatures,
  gwrFeatures,
  kAnonymityFeatures,
  networkHotspotFeatures,
  odFlowResult,
} from "./v093-models.js";
import { loadProModel, ProModelError } from "./pro-model.js";
import { GEOLOGY_FILE, readSceneFile, writeSceneFile } from "./scene.js";
import type { SceneFile, SceneGeology, SceneSeries, SceneStack } from "./scene.js";
import type { ProModel } from "./pro-model.js";
import type { CrsExecutionPlan, CrsLayerInput, CrsTransformStep } from "./crs-policy.js";
import { SpatialOpError } from "./errors.js";
import { normalizeFeatures, normalizeGeoJsonText } from "./normalize.js";
import {
  bufferFeatures,
  centroidFeatures,
  clipFeatures,
  convexHullFeatures,
  convertFeatures,
  describeOp,
  dissolveFeatures,
  bearingFeatures,
  groupStatsFeatures,
  intersectFeatures,
  measureAreas,
  measureLengths,
  mergeFeatures,
  minBBoxFeatures,
  nearestDistances,
  nearestFeatures,
  parseReclassifyMapping,
  qualityCheckFeatures,
  queryFeatures,
  reclassifyFeatures,
  spatialAggregate,
  distanceMatrix,
  explodeParts,
  verticesToPoints,
  lineIntersectFeatures,
  transformFeatures,
  nearestOnLineFeatures,
  gridFeatures,
  calculateFieldFeatures,
  joinAttributeFeatures,
  nearestVertexFeatures,
  splitGridFeatures,
  splitLineAtPoints,
  splitPolygonByLine,
  statsOf,
  summarizeFeatures,
  voronoiFeatures,
} from "./ops.js";
import type { SpatialAggregateRow } from "./ops.js";
import type { OperationCrsFacts } from "./operation-attempt.js";
import { geometryContentHash, spatialCacheKey, SpatialResultCache } from "./result-cache.js";
import { spatialResultSink } from "./sink.js";
import {
  assertDistance,
  auditParameters,
  isCoordinateField,
  normalizeQueryKind,
  normalizeUnit,
  safeAttributeFilter,
  safeLayerName,
  safeModelName,
} from "./text.js";
import type { DistanceUnit, MapCollection, PublicMapLayer, QueryKind } from "./types.js";

export interface RagSummaryInput {
  readonly title: string;
  readonly body: string;
  readonly layerNames: readonly string[];
  readonly kind: "gis";
}

export interface SpatialStackOptions {
  readonly layerDirectory: string;
  readonly auditDirectory: string;
  readonly modelName: () => string;
  readonly cacheDirectory?: string;
  /** 测试或调用方要替换缓存实现时使用。不传则用 cacheDirectory。 */
  readonly resultCache?: SpatialResultCache;
  /** 外部能力端口。实现由外部网关提供，本模块不打开那个包。 */
  readonly external?: ExternalCapabilityPort;
  /** 计算引擎端口（ANUGA、TRIGRS、LoopStructural）。不传时三个引擎工具不可用。 */
  readonly engines?: ExternalCapabilityPort;
  /** 本地专业模型权重目录（含 model.json）。不传或目录里没有权重时，克里金和汇水分析不可用。 */
  readonly modelDirectory?: string;
}

/** 外部处理后端的最小端口：与 ExternalCapabilityBoundary 的 invoke 结构兼容。 */
export interface ExternalCapabilityPort {
  invoke(request: {
    capability: string;
    inputResources: readonly string[];
    outputHint?: string;
    parameters: Record<string, string | number | boolean | null>;
  }): Promise<{
    ok: boolean;
    facts?: Record<string, unknown>;
    message?: string;
    localOutputResources?: readonly string[];
    code?: string;
  }>;
}

export interface SpatialRunResult {
  readonly ok: true;
  readonly operationType: SpatialAuditOperation;
  readonly message: string;
  readonly layer: PublicMapLayer | null;
  readonly featureCount: number;
  readonly fieldName: string | null;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly mean: number | null;
 /** 度量族的合计（面积/长度/距离）。统计类没有这个字段。 */
  readonly sum?: number | null;
 /** 追加。输入图层的逐要素几何问题。 */
  readonly geometryIssues?: readonly GeometryIssue[];
  readonly durationMs?: number;
  readonly ragEntryId?: string | null;
  readonly auditRecordId?: string | null;
  /** remember 里 audit.append 失败时为 true。没有审计 id，也不另造一个。 */
  readonly auditAppendFailed?: true;
  /** 这次派生写入或读到的缓存键。缓存命中时不记成这次新建。 */
  readonly cacheKey?: string;
  readonly cached?: boolean;
  /** 这次实际使用的坐标系事实。不含几何。 */
  readonly crs?: OperationCrsFacts;
  /** 本地产物文件（栅格类）。只进记录与本地，永不出模型可见面。 */
  readonly localOutputResources?: readonly string[];
}

/** GDL 等文本来源直接给出要素集合时用的输入。 */
export interface FeatureLayerInput {
  readonly layerName: string;
  readonly collection: MapCollection;
  readonly crsLabel: string;
  readonly expectedKind: CoreGeometryKind | null;
  readonly style?: LayerStyleInput;
  readonly sourceLabel: string;
  readonly writeKnowledge: boolean;
}

function asSpatialError(error: unknown): SpatialOpError {
  if (error instanceof SpatialOpError) return error;
  if (error instanceof SurtGisCoreError) return new SpatialOpError(error.message);
  if (error instanceof GisIoReadError) return new SpatialOpError(error.message);
  return new SpatialOpError("几何无效或已损坏，这次分析已停止。请检查图层后再试。");
}

/** 只在这次已经调用 remember 之后使用。append 失败才打标记，不生成新的 id。 */
function attachRememberedAudit(
  failure: SpatialOpError,
  ids: { readonly auditRecordId: string | null; readonly auditAppendFailed: boolean },
): void {
  if (typeof ids.auditRecordId === "string") failure.auditRecordId = ids.auditRecordId;
  else if (ids.auditAppendFailed) failure.auditAppendFailed = true;
}

/** 数值类能力的运行结果。全部是标量。 */
export interface AnalysisNumbers {
  readonly message: string;
  readonly featureCount: number;
  readonly fieldName?: string | null;
  readonly minimum?: number | null;
  readonly maximum?: number | null;
  readonly mean?: number | null;
  readonly sum?: number | null;
}

function fmt(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function numericField(collection: MapCollection, field: string): number | null {
  for (const feature of collection.features) {
    const properties = feature.properties;
    if (!properties || typeof properties !== "object") continue;
    const value = (properties as Record<string, unknown>)[field];
    if (value === undefined || value === null || value === "") continue;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  return null;
}

function distanceModeOf(kind: "known" | "planar" | "unknown" | "invalid", epsg: number | null, planarUnit: number | null): "geographic" | "planar-meters" | "coordinate" {
  if (kind === "unknown" || kind === "invalid") return "coordinate";
  if (kind === "known" && epsg === 4326) return "geographic";
  if (typeof planarUnit === "number" && planarUnit > 0) return "planar-meters";
  return "coordinate";
}

function sig(value: number): string {
  return String(Number(value.toPrecision(4)));
}

interface RainScenario {
  readonly intensity: number;
  readonly hours: number;
}

const MAX_SCENARIOS = 6;

/** "30x2;60x1"：雨强毫米每小时 x 历时小时。没写或写错就问，不补数。 */
function parseRainScenarios(text: string | null): RainScenario[] {
  const items = (text ?? "").split(/[;；]/).map((item) => item.trim()).filter((item) => item !== "");
  if (items.length === 0) throw new SpatialOpError("降雨情景没写。请向用户问雨强（毫米每小时）和历时（小时），写成 30x2;60x1 这样。程序不会填数。");
  if (items.length > MAX_SCENARIOS) throw new SpatialOpError(`一次最多 ${MAX_SCENARIOS} 个降雨情景。`);
  return items.map((item) => {
    const matched = /^(\d+(?:\.\d+)?)\s*[x×X*]\s*(\d+(?:\.\d+)?)$/.exec(item);
    const intensity = matched ? Number(matched[1]) : Number.NaN;
    const hours = matched ? Number(matched[2]) : Number.NaN;
    if (!(intensity > 0) || !(hours > 0)) throw new SpatialOpError(`降雨情景“${item.slice(0, 20)}”看不懂。请写成雨强x历时，例如 30x2。`);
    return { intensity, hours };
  });
}

/** "manning=0.04;steps=4"：只收数字。 */
function parseEngineSettings(text: string | null): Map<string, number> {
  const settings = new Map<string, number>();
  for (const item of (text ?? "").split(/[;；]/)) {
    const [key, value] = item.split("=").map((part) => part.trim());
    if (!key || value === undefined || value === "") continue;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new SpatialOpError(`参数 ${key.slice(0, 20)} 不是数字。`);
    settings.set(key, parsed);
  }
  return settings;
}

const LANDSLIDE_INPUTS: readonly { readonly key: string; readonly label: string }[] = [
  { key: "cohesion", label: "黏聚力（千帕）" },
  { key: "frictionAngle", label: "内摩擦角（度）" },
  { key: "unitWeight", label: "土体重度（千牛每立方米）" },
  { key: "diffusivity", label: "水力扩散系数（平方米每秒）" },
  { key: "ksat", label: "饱和渗透系数（米每秒）" },
  { key: "soilDepth", label: "土层厚度（米）" },
  { key: "waterTableDepth", label: "初始地下水位埋深（米）" },
];

async function readEngineSummary(produced: string | undefined): Promise<Record<string, unknown>> {
  if (!produced) throw new SpatialOpError("计算引擎没有写出摘要。");
  const parsed = JSON.parse(await readFile(resolve(produced), { encoding: "utf8" })) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SpatialOpError("计算引擎的摘要不是对象。");
  return parsed as Record<string, unknown>;
}

function summarySteps(summary: Record<string, unknown>): Record<string, number>[] {
  const steps = Array.isArray(summary.steps) ? summary.steps : [];
  return steps.map((item) => {
    const row: Record<string, number> = {};
    if (item && typeof item === "object") {
      for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
        if (typeof value === "number" && Number.isFinite(value)) row[key] = value;
      }
    }
    return row;
  });
}

function requireFieldName(fieldName: string, label: string): string {
  const name = fieldName.trim();
  if (name === "") throw new SpatialOpError(`${label}需要字段名。`);
  if (isCoordinateField(name)) throw new SpatialOpError(`${label}不能选坐标类字段。`);
  return name;
}

function labelIssues(layerName: string, issues: readonly GeometryIssue[]): GeometryIssue[] {
  return issues.map((issue) => ({ ...issue, message: `图层 ${layerName}：${issue.message}` }));
}

function withIssues<T extends object>(value: T, issues: readonly GeometryIssue[]): T & { readonly geometryIssues?: readonly GeometryIssue[] } {
  return issues.length > 0 ? { ...value, geometryIssues: issues.slice(0, 200) } : value;
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  return "失败";
}

const WORKING_EPSG = 4326;

function requiresSpatialCrs(operationType: string, queryKind: string | undefined): boolean {
  if (operationType === "buffer" || operationType === "intersect" || operationType === "clip") return true;
  if (operationType === "spatial-query") return queryKind !== "attribute";
 // 度量/几何族按坐标计算，走同一套 CRS 对齐；属性族不涉及坐标。
  if (operationType === "area" || operationType === "length" || operationType === "distance" || operationType === "nearest") return true;
  if (operationType === "convert" || operationType === "dissolve" || operationType === "merge" || operationType === "simplify" || operationType === "split-grid") return true;
  if (operationType === "voronoi" || operationType === "convex-hull" || operationType === "min-bbox" || operationType === "centroid" || operationType === "bearing") return true;
 // 分割/聚合/矩阵/精确最近按坐标计算，同一套 CRS 对齐。
  // 两个面或点面图层的叠置要先对齐坐标系。
  if (operationType === "erase" || operationType === "union" || operationType === "spatial-join") return true;
  if (operationType === "split-line" || operationType === "explode" || operationType === "vertices" || operationType === "line-intersect" || operationType === "transform" || operationType === "nearest-on-line" || operationType === "grid" || operationType === "split-polygon" || operationType === "spatial-aggregate" || operationType === "distance-matrix" || operationType === "nearest-exact") return true;
  return false;
}

function coordinateUnitSuffix(plan: CrsExecutionPlan): string {
  return plan.coordinateUnits === true ? " 距离按坐标原值计算，单位是坐标单位，不是米。" : "";
}

function cacheCrsToken(identity: CrsIdentity): string {
  if (identity.kind === "known") return identity.canonical;
  if (identity.kind === "invalid") return `invalid:${identity.raw}`;
  if (identity.kind === "planar") return `planar:${identity.raw}`;
  return "unknown";
}

function crsFacts(plan: CrsExecutionPlan, transformations: readonly CrsTransformStep[], bufferProjection?: "aeqd"): OperationCrsFacts {
  return {
    comparison: plan.comparison,
    inputCrs: plan.inputIdentities.map((identity) => {
      if (identity.kind === "known") return identity.canonical;
      if (identity.kind === "invalid") return "invalid";
      if (identity.kind === "planar") return "planar";
      return "unknown";
    }),
    resultCrs: plan.allow ? plan.resultCrs : null,
    transformations: plan.allow ? transformations : [],
    ...(plan.datumNotes.length > 0 ? { datumNotes: plan.datumNotes } : {}),
    ...(bufferProjection !== undefined && plan.allow ? { bufferProjection } : {}),
  };
}

function copyCollection(collection: MapCollection): MapCollection {
  return JSON.parse(JSON.stringify(collection)) as MapCollection;
}

/** 载入路径的统一结果：身份 + 可选 WKT + 给用户看的降级说明。 */
interface LoadedLayer {
  readonly layerName: string;
  readonly normalized: ReturnType<typeof normalizeFeatures>;
  readonly crsLabel: string;
  readonly crsIdentity: CrsIdentity;
  readonly crsWkt: string | null;
  readonly crsNote: string | null;
}

function prepareOperands(
  primary: MapCollection,
  secondary: MapCollection | null,
  secondaryInput: CrsLayerInput | null,
  plan: CrsExecutionPlan,
): { readonly primary: MapCollection; readonly secondary: MapCollection | null; readonly steps: CrsTransformStep[] } {
  const steps: CrsTransformStep[] = [];
  let nextPrimary = copyCollection(primary);
  let nextSecondary = secondary ? copyCollection(secondary) : null;
  if (!plan.spatial || !plan.allow || plan.targetEpsg === null || plan.targetDefinition === null) {
    return { primary: nextPrimary, secondary: nextSecondary, steps };
  }
  const target = plan.targetEpsg;
  const targetDef = plan.targetDefinition;
  if (nextSecondary && secondaryInput) {
    const identity = secondaryInput.identity;
    if (identity.kind === "known" && identity.epsg !== target) {
      const fromDef = transformDefinitionOf(secondaryInput);
      if (fromDef !== null) {
        nextSecondary = transformViaDefinitions(nextSecondary, fromDef, targetDef);
        steps.push({ from: identity.canonical, to: `EPSG:${target}`, purpose: "align-input" });
      }
    }
  }
  if (target !== WORKING_EPSG) {
    nextPrimary = transformViaDefinitions(nextPrimary, targetDef, "EPSG:4326");
    if (nextSecondary) nextSecondary = transformViaDefinitions(nextSecondary, targetDef, "EPSG:4326");
    steps.push({ from: `EPSG:${target}`, to: `EPSG:${WORKING_EPSG}`, purpose: "to-working" });
  }
  return { primary: nextPrimary, secondary: nextSecondary, steps };
}

/**
 * 进 Turf 之前先按几何类型过滤。空几何、结构无效、自相交和几何集合不交给算子。
 * 自相交与校验文案一致：分析时跳过，不留在结果里。
 * 全部不可用时直接停止，不调用缓冲、相交或裁剪。
 */
function readyForTurf(collection: MapCollection): MapCollection {
  const inspection = validateCollection(collection);
  const skipped = new Set(
    inspection.issues
      .filter((issue) => isUnusableIssue(issue) || issue.kind === "self-intersection")
      .map((issue) => issue.featureIndex),
  );
  const features = collection.features.filter((feature, index) => {
    if (skipped.has(index)) return false;
    const type = feature.geometry?.type ?? "";
    if (type === "GeometryCollection") return false;
    return geometryKindOfType(type) !== null;
  });
  return { type: "FeatureCollection", features };
}

/** 每次操作各一份的执行上下文。随异步链路传播，并发操作互不串扰。 */
interface SpatialCallContext {
  readonly callerCrs: string | null;
  readonly requestSource: RequestSource | null;
  /** 当前对话工作区。栅格只按裸文件名在这里查找，模型不传路径。 */
  readonly conversationWorkspace: string | null;
  /** null 表示没有对话范围，名称仍查整个图层库。空数组只表示这个对话里没有图层。 */
  readonly conversationLayerIds: readonly string[] | null;
}

const callContext = new AsyncLocalStorage<SpatialCallContext>();

function rasterStem(name: string): string {
  const stem = name.trim().replace(/\.(tif|tiff)$/i, "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 40);
  return stem === "" ? "raster" : stem;
}

function rasterBareName(inputName: string, tag: string): string {
  const safeTag = tag.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 48) || "out";
  return `${rasterStem(inputName)}-${safeTag}.tif`;
}

const RASTER_HANDLE = /^ras-[0-9a-f]{10}$/;

/** 这条对话里一张栅格的编号。由文件名算出，形如 ras- 加 10 位十六进制。同名文件编号不变。 */
export function rasterHandle(bareName: string): string {
  return `ras-${createHash("sha256").update(bareName).digest("hex").slice(0, 10)}`;
}

/** 当前对话 rasters 目录里的 GeoTIFF。每项是文件名和栅格编号。 */
export async function listConversationRasterIds(directory: string): Promise<{ readonly fileName: string; readonly id: string }[]> {
  let names: string[] = [];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const counts = new Map<string, number>();
  const rows: { fileName: string; id: string }[] = [];
  for (const name of names) {
    if (!/\.tiff?$/i.test(name)) continue;
    const id = rasterHandle(name);
    counts.set(id, (counts.get(id) ?? 0) + 1);
    rows.push({ fileName: name, id });
  }
  return rows.filter((row) => counts.get(row.id) === 1);
}

function backendResource(absolute: string): string {
  const rel = relative(cwd(), absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) return absolute.split(sep).join("/");
  return rel.split(sep).join("/");
}

async function existingFile(absolute: string): Promise<string | null> {
  try {
    const info = await stat(absolute);
    return info.isFile() ? absolute : null;
  } catch {
    return null;
  }
}

async function findBareRaster(directory: string, name: string): Promise<string | null> {
  const published = await existingFile(join(directory, "rasters", name));
  if (published) return published;
  return walkBareFile(directory, name, 0);
}

async function walkBareFile(directory: string, name: string, depth: number): Promise<string | null> {
  if (depth > 6) return null;
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return null;
  }
  for (const entry of names) {
    if (entry !== name) continue;
    const absolute = join(directory, entry);
    try {
      const info = await lstat(absolute);
      if (!info.isSymbolicLink() && info.isFile()) return absolute;
    } catch {
      // 这一项读不到就继续找同名文件。
    }
  }
  for (const entry of names) {
    if (entry.startsWith(".")) continue;
    const absolute = join(directory, entry);
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink() || !info.isDirectory()) continue;
    } catch {
      continue;
    }
    const found = await walkBareFile(absolute, name, depth + 1);
    if (found) return found;
  }
  return null;
}

export class SpatialService {
  private runtime: GdalRuntime | null = null;
  private readonly cache: SpatialResultCache;
  private conversationQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly catalog: MapLayerCatalog,
    private readonly audit: SpatialAuditLedger,
    private readonly options: SpatialStackOptions,
  ) {
    this.cache = options.resultCache ?? new SpatialResultCache(options.cacheDirectory ?? "var/cache");
    this.catalog.bindLifecycle({
      afterRemove: async (layerId) => {
        try {
          await this.cache.invalidateLayer(layerId);
        } catch (error) {
          if (error instanceof SpatialOpError) throw error;
          throw new SpatialOpError(`删除图层时缓存没有清掉：${errorText(error)}`);
        }
      },
      afterRename: async (layerId, layerName) => {
        try {
          await this.cache.renameStoredLayer(layerId, layerName);
        } catch (error) {
          if (error instanceof SpatialOpError) throw error;
          throw new SpatialOpError(`重命名时缓存里的图层名没有改掉：${errorText(error)}`);
        }
      },
    });
  }

  async dropDatabase(): Promise<void> {}

 /* ---- 外部能力（GDAL 薄封装）：经端口执行，结果载入图层库 ---- */

  private async externalLayer(
    operation: "make-valid" | "reproject" | "convert-format",
    action: string,
    capability: string,
    layerId: string,
    parameters: Record<string, string | number | boolean | null>,
    writeKnowledge: boolean,
    outputName: string | null,
  ): Promise<SpatialRunResult> {
    const port = this.options.external;
    if (!port) throw new SpatialOpError("外部能力后端未启用，该能力当前不可用。");
    const meta = this.catalog.get(layerId);
    if (!meta) throw new SpatialOpError("找不到要处理的图层。");
    const outcome = await port.invoke({
      capability,
      inputResources: [meta.outputFilePath ?? meta.layerId],
      outputHint: meta.layerName,
      parameters,
    });
    if (!outcome.ok) throw new SpatialOpError(outcome.message || "外部能力执行失败。");
    const produced = outcome.localOutputResources?.[0];
    if (!produced) throw new SpatialOpError("外部能力没有产出结果文件。");
    const loaded = await this.loadFile(resolve(produced), outputName, writeKnowledge);
    const layer = loaded[0] ?? null;
    let declared = "";
    if (operation === "reproject" && layer) {
      const epsg = /^EPSG:(\d{3,6})$/i.exec(String(parameters.targetCrs ?? "").trim());
      const code = epsg?.[1] ? Number(epsg[1]) : Number.NaN;
      if (Number.isInteger(code) && code > 0) {
        const stamped = await this.catalog.assignKnownEpsg(layer.layerId, code);
        if (stamped) declared = `坐标系已声明为 EPSG:${code}。`;
      }
    }
    const message = `${action}完成，结果已载入图层库。${declared}${outcome.message ?? ""}`;
    return {
      ok: true,
      operationType: operation,
      message,
      layer,
      featureCount: layer?.featureCount ?? 0,
      fieldName: null,
      minimum: null,
      maximum: null,
      mean: null,
    };
  }

  async makeValid(layerId: string, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    return this.externalLayer("make-valid", "几何修复", "vector.makeValid", layerId, {}, writeKnowledge, outputName);
  }

  /* ---- 栅格族：裸文件名。有对话时在该对话工作区里找，否则才用 var/rasters。 ---- */

  private assertBareRasterName(rasterName: string): string {
    const trimmed = rasterName.trim();
    if (trimmed === "" || trimmed.length > 128) throw new SpatialOpError("栅格名不合法。");
    if (/[\\/:*?"<>|]/.test(trimmed) || trimmed.includes("..") || /^[A-Za-z]:/.test(trimmed) || trimmed !== basename(trimmed)) {
      throw new SpatialOpError("栅格名不能包含路径分隔符。");
    }
    return trimmed;
  }

  private conversationWorkspace(): string | null {
    return callContext.getStore()?.conversationWorkspace ?? null;
  }

  /** 编号只在产物目录里找：当前对话的 rasters，没有对话时是 var/rasters。 */
  private async rasterNameOfHandle(handle: string): Promise<string | null> {
    const workspace = this.conversationWorkspace();
    const directory = workspace ? join(workspace, "rasters") : resolve("var", "rasters");
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      return null;
    }
    const matched = names.filter((name) => rasterHandle(name) === handle);
    if (matched.length > 1) throw new SpatialOpError(`栅格编号 ${handle} 对应多个文件，不能确定是哪一个。`);
    return matched[0] ?? null;
  }

  private async requireRaster(rasterName: string): Promise<{ readonly absolute: string; readonly relative: string }> {
    const handle = rasterName.trim().toLowerCase();
    const named = RASTER_HANDLE.test(handle) ? await this.rasterNameOfHandle(handle) : null;
    if (RASTER_HANDLE.test(handle) && !named) throw new SpatialOpError(`当前对话里没有栅格 ${handle}。`);
    const asked = (named ?? rasterName).trim();
    if (asked === "当前图层" || asked === "这些点") {
      throw new SpatialOpError("没有栅格编号。请使用上一次工具结果里的 ras- 编号，不要把「当前图层」当成栅格名。");
    }
    const trimmed = this.assertBareRasterName(named ?? rasterName);
    const workspace = this.conversationWorkspace();
    const absolute = workspace
      ? await findBareRaster(workspace, trimmed)
      : await existingFile(resolve("var", "rasters", trimmed));
    if (!absolute) {
      throw new SpatialOpError(workspace
        ? `当前对话里没有 ${trimmed}。`
        : `var/rasters 里没有 ${trimmed}。请把栅格文件放进该目录后重试。`);
    }
    return { absolute, relative: backendResource(absolute) };
  }

  /** 把栅格产物放到当前对话（或全局 var/rasters），使下一次裸文件名还能找到。不上图。 */
  private async publishRaster(source: string | undefined, bareName: string): Promise<{ readonly absolute: string; readonly relative: string } | null> {
    if (!source || source.trim() === "") return null;
    const trimmed = this.assertBareRasterName(bareName);
    const sourceAbs = isAbsolute(source) ? source : resolve(source);
    try {
      const info = await stat(sourceAbs);
      if (!info.isFile()) return null;
    } catch {
      return null;
    }
    const workspace = this.conversationWorkspace();
    const directory = workspace ? join(workspace, "rasters") : resolve("var", "rasters");
    await mkdir(directory, { recursive: true });
    const absolute = join(directory, trimmed);
    if (resolve(absolute) !== resolve(sourceAbs)) {
      const bytes = await readFile(sourceAbs);
      await writeFile(absolute, bytes);
    }
    return { absolute, relative: backendResource(absolute) };
  }

  private async withPublishedRaster(result: SpatialRunResult, bareName: string): Promise<SpatialRunResult> {
    const published = await this.publishRaster(result.localOutputResources?.[0], bareName);
    if (!published) return result;
    return {
      ...result,
      message: `${result.message} 产物栅格 ${rasterHandle(bareName)}。`,
      localOutputResources: [published.relative],
    };
  }

  private async externalRaster(
    operation: "dem-derivative" | "raster-calc" | "raster-info" | "raster-cast" | "raster-nodata" | "raster-smooth" | "viewshed" | "raster-clip" | "rasterize" | "zonal" | "resample" | "raster-index" | "focal" | "classify",
    action: string,
    capability: string,
    inputResources: readonly string[],
    parameters: Record<string, string | number | boolean | null>,
  ): Promise<SpatialRunResult> {
    const port = this.options.external;
    if (!port) throw new SpatialOpError("外部能力后端未启用，该能力当前不可用。");
    const outcome = await port.invoke({ capability, inputResources, parameters });
    if (!outcome.ok) throw new SpatialOpError(outcome.message || "外部能力执行失败。");
    return {
      ok: true,
      operationType: operation,
      message: `${action}完成。${outcome.message ?? ""}`,
      layer: null,
      featureCount: 0,
      fieldName: null,
      minimum: null,
      maximum: null,
      mean: null,
      ...(outcome.localOutputResources && outcome.localOutputResources.length > 0
        ? { localOutputResources: outcome.localOutputResources }
        : {}),
    };
  }

  /** 栅格信息：只出元数据与统计数字摘要（宽高/波段/最小/最大/平均）。 */
  async rasterInfo(rasterName: string): Promise<SpatialRunResult> {
    const reference = await this.requireRaster(rasterName);
    const port = this.options.external;
    if (!port) throw new SpatialOpError("外部能力后端未启用，该能力当前不可用。");
    const outcome = await port.invoke({ capability: "raster.info", inputResources: [reference.relative], parameters: {} });
    if (!outcome.ok) throw new SpatialOpError(outcome.message || "外部能力执行失败。");
    const facts = outcome.facts ?? {};
    const number = (key: string): string => {
      const value = facts[key];
      return typeof value === "number" ? String(value) : "未知";
    };
    const message = `栅格 ${rasterName.trim()}：${number("width")}×${number("height")}，${number("bands")} 波段；最小值 ${number("minimum")}、最大值 ${number("maximum")}、平均值 ${number("mean")}。`;
    return {
      ok: true,
      operationType: "raster-info",
      message,
      layer: null,
      featureCount: 0,
      fieldName: null,
      minimum: null,
      maximum: null,
      mean: null,
    };
  }

  /** DEM 衍生：坡度/坡向/晕渲。产物是本地栅格文件，摘要只报完成。 */
  async demDerivative(rasterName: string, derivative: string): Promise<SpatialRunResult> {
    const kind = derivative.trim().toLowerCase();
    if (kind !== "slope" && kind !== "aspect" && kind !== "hillshade") {
      throw new SpatialOpError("DEM 衍生只支持 slope、aspect、hillshade。");
    }
    const reference = await this.requireRaster(rasterName);
    const result = await this.externalRaster("dem-derivative", `DEM ${kind}`, "raster.demDerivative", [reference.relative], { derivative: kind });
    return this.withPublishedRaster(result, rasterBareName(rasterName, kind));
  }

  /** 栅格代数：两同尺寸栅格的有限运算（加减乘除/最小/最大），不接受表达式。 */
  async rasterCalc(rasterName: string, otherRasterName: string, op: string): Promise<SpatialRunResult> {
    const kind = op.trim().toLowerCase();
    if (!["add", "subtract", "multiply", "divide", "min", "max"].includes(kind)) {
      throw new SpatialOpError("栅格运算只支持 add、subtract、multiply、divide、min、max。");
    }
    const first = await this.requireRaster(rasterName);
    const second = await this.requireRaster(otherRasterName);
    const result = await this.externalRaster("raster-calc", `栅格 ${kind}`, "raster.calc", [first.relative, second.relative], { op: kind });
    return this.withPublishedRaster(result, rasterBareName(rasterName, `${kind}-${rasterStem(otherRasterName)}`));
  }

  /** 栅格整型或浮点转换。依赖本机 GDAL，不上图。 */
  async rasterCast(rasterName: string, outputType: string): Promise<SpatialRunResult> {
    const kind = outputType.trim().toLowerCase();
    if (kind !== "int16" && kind !== "int32" && kind !== "float32") {
      throw new SpatialOpError("栅格类型只支持 int16、int32、float32。");
    }
    const reference = await this.requireRaster(rasterName);
    const result = await this.externalRaster("raster-cast", `栅格转为 ${kind}`, "raster.cast", [reference.relative], { outputType: kind });
    return this.withPublishedRaster(result, rasterBareName(rasterName, kind));
  }

  /** 设置第一波段的 NoData。依赖本机 GDAL，不上图。 */
  async rasterNoData(rasterName: string, noData: number): Promise<SpatialRunResult> {
    if (!Number.isFinite(noData)) throw new SpatialOpError("NoData 必须是有限数值。");
    const reference = await this.requireRaster(rasterName);
    const result = await this.externalRaster("raster-nodata", "设置 NoData", "raster.nodata", [reference.relative], { noData });
    return this.withPublishedRaster(result, rasterBareName(rasterName, "nodata"));
  }

  /** 3×3 均值平滑。NoData 不参与平均。依赖本机 GDAL，不上图。 */
  async rasterSmooth(rasterName: string): Promise<SpatialRunResult> {
    const reference = await this.requireRaster(rasterName);
    const result = await this.externalRaster("raster-smooth", "邻域平滑", "raster.smooth", [reference.relative], {});
    return this.withPublishedRaster(result, rasterBareName(rasterName, "smooth"));
  }

  /** 可视域。观察点是点图层的第一个点；只传图层文件，坐标由本机桥自己读。 */
  async viewshed(rasterName: string, layerId: string, observerHeight: number): Promise<SpatialRunResult> {
    if (!Number.isFinite(observerHeight) || observerHeight < 0) throw new SpatialOpError("观察点高度必须大于或等于 0。");
    const input = this.requireCollection(layerId);
    if (!input.collection.features.some((feature) => feature.geometry?.type === "Point")) throw new SpatialOpError("可视域需要一个点。");
    const reference = await this.requireRaster(rasterName);
    const result = await this.externalRaster("viewshed", "可视域", "raster.viewshed", [reference.relative, backendResource(input.meta.outputFilePath)], { observerHeight, ...this.layerEpsg(input.meta) });
    return this.withPublishedRaster(result, rasterBareName(rasterName, "viewshed"));
  }

  async rasterClip(rasterName: string, layerId: string): Promise<SpatialRunResult> {
    const input = this.requireCollection(layerId);
    const reference = await this.requireRaster(rasterName);
    const result = await this.externalRaster("raster-clip", "裁剪栅格", "raster.clip", [reference.relative, backendResource(input.meta.outputFilePath)], { ...this.layerEpsg(input.meta) });
    return this.withPublishedRaster(result, rasterBareName(rasterName, "clip"));
  }

  async polygonize(rasterName: string, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    const reference = await this.requireRaster(rasterName);
    const port = this.options.external;
    if (!port) throw new SpatialOpError("外部能力后端未启用，该能力当前不可用。");
    const outcome = await port.invoke({ capability: "raster.polygonize", inputResources: [reference.relative], parameters: {} });
    if (!outcome.ok) throw new SpatialOpError(outcome.message || "外部能力执行失败。");
    const produced = outcome.localOutputResources?.[0];
    if (!produced) throw new SpatialOpError("外部能力没有产出结果文件。");
    const loaded = await this.loadFile(resolve(produced), outputName, writeKnowledge);
    const layer = loaded[0] ?? null;
    return {
      ok: true,
      operationType: "polygonize",
      message: `栅格转面完成。${outcome.message ?? ""}`,
      layer,
      featureCount: layer?.featureCount ?? 0,
      fieldName: null,
      minimum: null,
      maximum: null,
      mean: null,
    };
  }

  async rasterize(layerId: string, cellSize: number): Promise<SpatialRunResult> {
    if (!(cellSize > 0)) throw new SpatialOpError("格网边长必须大于 0。");
    const input = this.requireCollection(layerId);
    const result = await this.externalRaster("rasterize", "面转栅格", "raster.rasterize", [backendResource(input.meta.outputFilePath)], { cellSize, ...this.layerEpsg(input.meta) });
    return this.withPublishedRaster(result, rasterBareName(input.meta.layerName, "raster"));
  }

  async zonal(rasterName: string, layerId: string): Promise<SpatialRunResult> {
    const input = this.requireCollection(layerId);
    const reference = await this.requireRaster(rasterName);
    return this.externalRaster("zonal", "按面统计", "raster.zonal", [reference.relative, backendResource(input.meta.outputFilePath)], { ...this.layerEpsg(input.meta) });
  }

  async resample(rasterName: string, cellSize: number): Promise<SpatialRunResult> {
    if (!(cellSize > 0)) throw new SpatialOpError("格网边长必须大于 0。");
    const reference = await this.requireRaster(rasterName);
    const result = await this.externalRaster("resample", "重采样", "raster.resample", [reference.relative], { cellSize });
    return this.withPublishedRaster(result, rasterBareName(rasterName, "resample"));
  }

  async rasterIndex(rasterName: string, otherRasterName: string, indexName: string): Promise<SpatialRunResult> {
    const kind = indexName.trim().toLowerCase();
    if (kind !== "ndvi" && kind !== "ndwi" && kind !== "savi") throw new SpatialOpError("指数只支持 ndvi、ndwi、savi。");
    const first = await this.requireRaster(rasterName);
    const second = await this.requireRaster(otherRasterName);
    const result = await this.externalRaster("raster-index", kind, "raster.index", [first.relative, second.relative], { index: kind });
    return this.withPublishedRaster(result, rasterBareName(rasterName, kind));
  }

  async focal(rasterName: string, size: number): Promise<SpatialRunResult> {
    if (size !== 3 && size !== 5 && size !== 7) throw new SpatialOpError("邻域边长只支持 3、5、7。");
    const reference = await this.requireRaster(rasterName);
    const result = await this.externalRaster("focal", "邻域统计", "raster.focal", [reference.relative], { size });
    return this.withPublishedRaster(result, rasterBareName(rasterName, `focal${size}`));
  }

  /**
   * 监督分类。rasterNames 是逗号分隔的同网格栅格，训练点图层带类别字段。
   * 分层留出检验样本，在训练样本上做交叉验证选方法，输出类别编码栅格。
   */
  async classify(rasterNames: string, layerId: string, fieldName: string, method: string | null, testFraction: number | null): Promise<SpatialRunResult> {
    const field = requireFieldName(fieldName, "监督分类");
    const kind = (method ?? "auto").trim().toLowerCase() || "auto";
    if (!["auto", "mindist", "maxlike", "knn1", "knn3", "knn5", "knn7"].includes(kind)) {
      throw new SpatialOpError("分类方法只支持 auto、mindist、maxlike、knn1、knn3、knn5、knn7。");
    }
    if (testFraction !== null && !(testFraction > 0 && testFraction < 0.9)) throw new SpatialOpError("检验样本比例必须大于 0 且小于 0.9。");
    const names = rasterNames.split(/[,，]/).map((name) => name.trim()).filter((name) => name !== "");
    if (names.length === 0 || names.length > 16) throw new SpatialOpError("监督分类需要 1 到 16 个栅格名。");
    const rasters = [];
    for (const name of names) rasters.push(await this.requireRaster(name));
    const training = this.requireCollection(layerId);
    const result = await this.externalRaster("classify", "监督分类", "raster.classify", [...rasters.map((item) => item.relative), backendResource(training.meta.outputFilePath)], {
      field,
      method: kind,
      ...(testFraction !== null ? { testFraction } : {}),
      ...this.layerEpsg(training.meta),
    });
    return this.withPublishedRaster(result, rasterBareName(names[0] ?? "raster", "class"));
  }

  /** 本地专业模型权重。每次调用重新读，安装后不用重启。 */
  private async requireProModel(label: string): Promise<ProModel> {
    let model: ProModel | null;
    try {
      model = await loadProModel(this.options.modelDirectory);
    } catch (error) {
      throw new SpatialOpError(`${label}的模型权重不能用：${error instanceof ProModelError ? error.message : "读取失败。"}请重新安装权重。`);
    }
    if (!model) throw new SpatialOpError(`${label}需要本地专业模型权重。本机没有安装，该能力当前不可用。`);
    return model;
  }

  /**
   * 普通克里金。半变异函数以权重里的归一化先验为起点，用这次的点拟合，先验的分量随点数增加而减小。
   * 结果附留一交叉验证误差。克里金值和方差两个栅格发布，不上图。
   */
  async kriging(layerId: string, fieldName: string, cellSize: number | null, writeKnowledge: boolean): Promise<SpatialRunResult> {
    if (cellSize !== null && !(Number.isFinite(cellSize) && cellSize > 0)) throw new SpatialOpError("格网边长必须大于 0。");
    const field = requireFieldName(fieldName, "克里金");
    const input = this.requireCollection(layerId);
    if (input.meta.crsIdentity.kind === "invalid") throw new SpatialOpError("图层坐标系无效，不能做克里金。");
    const weights = await this.requireProModel("克里金");
    const port = this.options.external;
    if (!port) throw new SpatialOpError("外部能力后端未启用，该能力当前不可用。");
    const outcome = await port.invoke({
      capability: "raster.kriging",
      inputResources: [backendResource(input.meta.outputFilePath)],
      outputHint: input.meta.layerName,
      parameters: {
        field,
        variogram: weights.kriging.model,
        nuggetRatio: weights.kriging.nuggetRatio,
        rangeRatio: weights.kriging.rangeRatio,
        priorWeight: weights.kriging.priorWeight,
        neighbors: weights.kriging.neighbors,
        ...(cellSize !== null ? { cellSize } : {}),
        ...this.layerEpsg(input.meta),
      },
    });
    if (!outcome.ok) throw new SpatialOpError(outcome.message || "外部能力执行失败。");
    const facts = outcome.facts ?? {};
    const rmse = typeof facts.rmse === "number" ? facts.rmse : null;
    const mae = typeof facts.mae === "number" ? facts.mae : null;
    const [estimate, variance] = outcome.localOutputResources ?? [];
    const published = await this.publishRaster(estimate, rasterBareName(input.meta.layerName, "kriging"));
    const publishedVariance = await this.publishRaster(variance, rasterBareName(input.meta.layerName, "kriging-variance"));
    const resources = [published?.relative ?? estimate, publishedVariance?.relative ?? variance].filter((item): item is string => typeof item === "string");
    const names = `克里金值栅格 ${rasterHandle(rasterBareName(input.meta.layerName, "kriging"))}，方差栅格 ${rasterHandle(rasterBareName(input.meta.layerName, "kriging-variance"))}。`;
    const ids = await this.remember({
      operationType: "kriging",
      inputLayerNames: [input.meta.layerName],
      parameters: auditParameters({ fieldName: field, target: weights.kriging.model, ...(cellSize !== null ? { tolerance: cellSize } : {}) }),
      outputFilePath: published?.absolute ?? null,
      layerId: input.meta.layerId,
      success: true,
      note: `克里金，权重 ${weights.name}。${rmse !== null ? `留一均方根误差 ${fmt(rmse)}。` : ""}`,
      writeKnowledge,
      featureCount: input.collection.features.length,
      fieldNames: [field],
    });
    return {
      ok: true,
      operationType: "kriging",
      message: `${outcome.message ?? "克里金完成。"} ${names}权重 ${weights.name}。`,
      layer: null,
      featureCount: input.collection.features.length,
      fieldName: field,
      minimum: mae,
      maximum: null,
      mean: rmse,
      ...(resources.length > 0 ? { localOutputResources: resources } : {}),
      ...(typeof ids.auditRecordId === "string" ? { auditRecordId: ids.auditRecordId } : {}),
    };
  }

  /**
   * 汇水分析。D8 流向、Priority-Flood 填洼；河道阈值面积和出水口捕捉半径来自权重。
   * 流域面作为图层入库，汇流累积量和河道两个栅格发布。
   */
  async watershed(rasterName: string, layerId: string, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    const outlets = this.requireCollection(layerId);
    if (!outlets.collection.features.some((feature) => feature.geometry?.type === "Point")) throw new SpatialOpError("汇水分析需要出水口点图层。");
    const reference = await this.requireRaster(rasterName);
    const weights = await this.requireProModel("汇水分析");
    const port = this.options.external;
    if (!port) throw new SpatialOpError("外部能力后端未启用，该能力当前不可用。");
    const outcome = await port.invoke({
      capability: "raster.watershed",
      inputResources: [reference.relative, backendResource(outlets.meta.outputFilePath)],
      outputHint: rasterStem(rasterName),
      parameters: {
        streamArea: weights.watershed.streamArea,
        snapDistance: weights.watershed.snapDistance,
        ...this.layerEpsg(outlets.meta),
      },
    });
    if (!outcome.ok) throw new SpatialOpError(outcome.message || "外部能力执行失败。");
    const [basins, accumulation, streams] = outcome.localOutputResources ?? [];
    if (!basins) throw new SpatialOpError("外部能力没有产出流域面。");
    const accumulationName = rasterBareName(rasterName, "accumulation");
    const streamName = rasterBareName(rasterName, "streams");
    const publishedAccumulation = await this.publishRaster(accumulation, accumulationName);
    const publishedStreams = await this.publishRaster(streams, streamName);
    const result = await this.insertProducedVector(
      "watershed",
      "流域",
      basins,
      outlets.meta,
      auditParameters({ distance: weights.watershed.snapDistance, tolerance: weights.watershed.streamArea, target: weights.name }),
      writeKnowledge,
      outputName,
      `${outcome.message ?? ""} 汇流累积量栅格 ${rasterHandle(accumulationName)}，河道栅格 ${rasterHandle(streamName)}（1 为河道）。权重 ${weights.name}。`,
    );
    const resources = [publishedAccumulation?.relative, publishedStreams?.relative].filter((item): item is string => typeof item === "string");
    return { ...result, ...(resources.length > 0 ? { localOutputResources: resources } : {}) };
  }

  /** 地形剖面。沿线按像元间距采样，双线性插值；采样点作为图层入库，带 distance 和 elevation 字段。 */
  async profile(rasterName: string, layerId: string, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    const input = this.requireCollection(layerId);
    if (!input.collection.features.some((feature) => feature.geometry?.type === "LineString" || feature.geometry?.type === "MultiLineString")) {
      throw new SpatialOpError("剖面需要线图层。");
    }
    const reference = await this.requireRaster(rasterName);
    const port = this.options.external;
    if (!port) throw new SpatialOpError("外部能力后端未启用，该能力当前不可用。");
    const outcome = await port.invoke({
      capability: "raster.profile",
      inputResources: [reference.relative, backendResource(input.meta.outputFilePath)],
      outputHint: input.meta.layerName,
      parameters: { ...this.layerEpsg(input.meta) },
    });
    if (!outcome.ok) throw new SpatialOpError(outcome.message || "外部能力执行失败。");
    const produced = outcome.localOutputResources?.[0];
    if (!produced) throw new SpatialOpError("外部能力没有产出剖面。");
    const facts = outcome.facts ?? {};
    const result = await this.insertProducedVector("profile", "剖面", produced, input.meta, auditParameters({}), writeKnowledge, outputName, outcome.message ?? "");
    return {
      ...result,
      fieldName: "elevation",
      minimum: typeof facts.minimum === "number" ? facts.minimum : null,
      maximum: typeof facts.maximum === "number" ? facts.maximum : null,
    };
  }

  /** 填挖方。第二个栅格减第一个，正为填、负为挖；差值栅格发布。 */
  async cutFill(rasterName: string, otherRasterName: string, writeKnowledge: boolean): Promise<SpatialRunResult> {
    const before = await this.requireRaster(rasterName);
    const after = await this.requireRaster(otherRasterName);
    const port = this.options.external;
    if (!port) throw new SpatialOpError("外部能力后端未启用，该能力当前不可用。");
    const outcome = await port.invoke({ capability: "raster.cutFill", inputResources: [before.relative, after.relative], outputHint: rasterStem(rasterName), parameters: {} });
    if (!outcome.ok) throw new SpatialOpError(outcome.message || "外部能力执行失败。");
    const facts = outcome.facts ?? {};
    const bareName = rasterBareName(rasterName, `cutfill-${rasterStem(otherRasterName)}`);
    const published = await this.publishRaster(outcome.localOutputResources?.[0], bareName);
    const fill = typeof facts.fill === "number" ? facts.fill : null;
    const cut = typeof facts.cut === "number" ? facts.cut : null;
    const ids = await this.remember({
      operationType: "cut-fill",
      inputLayerNames: [rasterStem(rasterName), rasterStem(otherRasterName)],
      parameters: auditParameters({}),
      outputFilePath: published?.absolute ?? null,
      layerId: null,
      success: true,
      note: `填挖方。${fill !== null && cut !== null ? `填 ${fmt(fill)}，挖 ${fmt(cut)}。` : ""}`,
      writeKnowledge,
      featureCount: 0,
      fieldNames: [],
    });
    return {
      ok: true,
      operationType: "cut-fill",
      message: `${outcome.message ?? "填挖方完成。"} 差值栅格 ${rasterHandle(bareName)}。`,
      layer: null,
      featureCount: 0,
      fieldName: null,
      minimum: cut,
      maximum: fill,
      mean: null,
      sum: fill !== null && cut !== null ? fill - cut : null,
      ...(published ? { localOutputResources: [published.relative] } : {}),
      ...(typeof ids.auditRecordId === "string" ? { auditRecordId: ids.auditRecordId } : {}),
    };
  }

  /** 水面高程减地面高程。产物是水深栅格，没有流速，也没有时间。 */
  async waterLevel(rasterName: string, waterLevel: number, writeKnowledge: boolean): Promise<SpatialRunResult> {
    if (!Number.isFinite(waterLevel)) throw new SpatialOpError("水位没写。请给出水面高程，程序不会填一个数。");
    const dem = await this.requireRaster(rasterName);
    const port = this.options.external;
    if (!port) throw new SpatialOpError("外部能力后端未启用，该能力当前不可用。");
    const outcome = await port.invoke({
      capability: "raster.waterLevel",
      inputResources: [dem.relative],
      outputHint: rasterStem(rasterName),
      parameters: { waterLevel },
    });
    if (!outcome.ok) throw new SpatialOpError(outcome.message || "外部能力执行失败。");
    const facts = outcome.facts ?? {};
    const bareName = rasterBareName(rasterName, "depth");
    const published = await this.publishRaster(outcome.localOutputResources?.[0], bareName);
    const maximum = typeof facts.maximum === "number" ? facts.maximum : null;
    const flooded = typeof facts.featureCount === "number" ? facts.featureCount : 0;
    const ids = await this.remember({
      operationType: "water-level",
      inputLayerNames: [rasterStem(rasterName)],
      parameters: auditParameters({ distance: waterLevel }),
      outputFilePath: published?.absolute ?? null,
      layerId: null,
      success: true,
      note: `水面抬高。${maximum !== null ? `最高水深 ${fmt(maximum)}。` : ""}`,
      writeKnowledge,
      featureCount: flooded,
      fieldNames: [],
    });
    return {
      ok: true,
      operationType: "water-level",
      message: `${outcome.message ?? "水面抬高完成。"} 水深栅格 ${rasterHandle(bareName)}。`,
      layer: null,
      featureCount: flooded,
      fieldName: null,
      minimum: null,
      maximum,
      mean: null,
      sum: null,
      ...(published ? { localOutputResources: [published.relative] } : {}),
      ...(typeof ids.auditRecordId === "string" ? { auditRecordId: ids.auditRecordId } : {}),
    };
  }

  /** 只登记从下到上的图层顺序和层间竖向间距。少于两层时不写登记，也不出图。 */
  async layerStack(orderedLayerIds: readonly string[], gap: number, writeKnowledge: boolean): Promise<SpatialRunResult> {
    if (!Number.isFinite(gap) || gap < 0) throw new SpatialOpError("爆炸图需要大于或等于 0 的层间竖向间距。没写间距就不登记。");
    const order: { layerId: string; layerName: string }[] = [];
    const seen = new Set<string>();
    for (const id of orderedLayerIds) {
      const input = this.requireCollection(id);
      if (seen.has(input.meta.layerId)) throw new SpatialOpError("爆炸图里的图层不能重复。");
      seen.add(input.meta.layerId);
      order.push({ layerId: input.meta.layerId, layerName: input.meta.layerName });
    }
    if (order.length < 2) throw new SpatialOpError("爆炸图需要至少两个已载入的图层。图层不够时不登记，也不出图。");
    const stack: SceneStack = { order, gap };
    await this.mergeScene({ stack });
    const ids = await this.remember({
      operationType: "layer-stack",
      inputLayerNames: order.map((item) => item.layerName),
      parameters: auditParameters({ distance: gap }),
      outputFilePath: null,
      layerId: order[0]?.layerId ?? null,
      success: true,
      note: `爆炸图登记 ${order.length} 层，间距 ${fmt(gap)}。`,
      writeKnowledge,
      featureCount: order.length,
      fieldNames: [],
    });
    return {
      ok: true,
      operationType: "layer-stack",
      message: `已登记从下到上的图层 ${order.map((item) => item.layerName).join("、")}，层间竖向间距 ${fmt(gap)}。三维页按这个顺序和间距画分层。`,
      layer: null,
      featureCount: order.length,
      fieldName: null,
      minimum: null,
      maximum: null,
      mean: null,
      sum: null,
      ...(typeof ids.auditRecordId === "string" ? { auditRecordId: ids.auditRecordId } : {}),
    };
  }

  /** 核对界面点和产状字段。缺了就问。不生成地层体。 */
  async geologyInputs(layerId: string, contactField: string, dipField: string, azimuthField: string, writeKnowledge: boolean): Promise<SpatialRunResult> {
    const contact = contactField.trim();
    const dip = dipField.trim();
    const azimuth = azimuthField.trim();
    if (contact === "" || dip === "" || azimuth === "") {
      throw new SpatialOpError("地层体需要界面点图层、界面字段、倾角字段和倾向字段。缺了就问，这一步不生成体。");
    }
    const input = this.requireCollection(layerId);
    if (input.meta.geometryKind !== "point") {
      throw new SpatialOpError("地层体的输入是界面点。这个图层不是点，请换点图层。这一步不生成体。");
    }
    const fields = new Set(input.meta.fieldNames);
    if (!fields.has(contact) || !fields.has(dip) || !fields.has(azimuth)) {
      throw new SpatialOpError("点图层上没有给出的界面、倾角或倾向字段。请指出这三个字段。这一步不生成体。");
    }
    const dipValue = numericField(input.collection, dip);
    const azimuthValue = numericField(input.collection, azimuth);
    if (dipValue === null || azimuthValue === null) {
      throw new SpatialOpError("倾角和倾向需要是数值字段。请指出这两个字段。这一步不生成体。");
    }
    const geology: SceneGeology = {
      layerId: input.meta.layerId,
      layerName: input.meta.layerName,
      contactField: contact,
      dipField: dip,
      azimuthField: azimuth,
    };
    await this.mergeScene({ geology, geologyModel: null });
    const ids = await this.remember({
      operationType: "geology-inputs",
      inputLayerNames: [input.meta.layerName],
      parameters: auditParameters({ fieldName: contact, groupField: dip, target: azimuth }),
      outputFilePath: null,
      layerId: input.meta.layerId,
      success: true,
      note: "已登记地层体输入，未生成体。",
      writeKnowledge,
      featureCount: input.meta.featureCount,
      fieldNames: [contact, dip, azimuth],
    });
    return {
      ok: true,
      operationType: "geology-inputs",
      message: `已记下界面点图层 ${input.meta.layerName}，界面字段 ${contact}，倾角字段 ${dip}，倾向字段 ${azimuth}。这一步只登记输入，不生成地层体。生成要用 map.geologyModel，并给出向下延伸的深度。`,
      layer: null,
      featureCount: input.meta.featureCount,
      fieldName: contact,
      minimum: null,
      maximum: null,
      mean: null,
      sum: null,
      ...(typeof ids.auditRecordId === "string" ? { auditRecordId: ids.auditRecordId } : {}),
    };
  }

  private async invokeEngine(
    capability: string,
    inputResources: readonly string[],
    outputHint: string,
    parameters: Record<string, string | number | boolean | null>,
  ): Promise<{ readonly message: string; readonly outputs: readonly string[] }> {
    const port = this.options.engines;
    if (!port) throw new SpatialOpError("计算引擎没有接上。请在设置里安装计算引擎。");
    const outcome = await port.invoke({ capability, inputResources, outputHint, parameters });
    if (!outcome.ok) {
      if (outcome.code === "external-capability-unavailable") throw new SpatialOpError("计算引擎没装或不可用。请在设置里安装计算引擎。");
      throw new SpatialOpError(outcome.message || "计算引擎执行失败。");
    }
    return { message: outcome.message ?? "", outputs: outcome.localOutputResources ?? [] };
  }

  private requireWorkspace(label: string): string {
    const workspace = this.conversationWorkspace();
    if (!workspace) throw new SpatialOpError(`${label}需要当前对话。`);
    return workspace;
  }

  /**
   * 几个情景逐个算。某个失败就停，已完成的保留并说明，后面的不算。
   * 编号接着本对话已有的同类情景往下排，旧的栅格编号不会被新结果覆盖。
   */
  private async runScenarios(
    kind: SceneSeries["kind"],
    scenarios: readonly RainScenario[],
    run: (scenario: RainScenario, index: number, number: number) => Promise<string>,
  ): Promise<string[]> {
    const existing = (await readSceneFile(this.requireWorkspace("登记情景"))).series
      .filter((item) => item.kind === kind)
      .map((item) => Number(item.seriesId.slice(kind.length + 1)))
      .filter((value) => Number.isInteger(value));
    const base = existing.length > 0 ? Math.max(...existing) : 0;
    const done: string[] = [];
    for (const [offset, scenario] of scenarios.entries()) {
      const index = offset + 1;
      try {
        done.push(await run(scenario, index, base + index));
      } catch (error) {
        const label = `情景 ${index}（${sig(scenario.intensity)}x${sig(scenario.hours)}）`;
        const kept = done.length > 0 ? `已完成的 ${done.length} 个情景保留：${done.join("")}` : "";
        const skipped = scenarios.length - index;
        throw new SpatialOpError(`${label}失败：${errorText(error)}${kept}${skipped > 0 ? `后面 ${skipped} 个情景没有算。` : ""}`);
      }
    }
    return done;
  }

  private async recordSeries(series: SceneSeries): Promise<void> {
    const workspace = this.requireWorkspace("登记情景");
    const current = await readSceneFile(workspace);
    await this.mergeScene({ series: [...current.series.filter((item) => item.seriesId !== series.seriesId), series] });
  }

  /** 降雨径流：ANUGA 浅水方程。每个情景单独跑，逐时刻发布水深栅格，另给最大流速栅格。 */
  async rainfallRunoff(rasterName: string, scenarioText: string | null, settingsText: string | null, boundary: string | null, writeKnowledge: boolean): Promise<SpatialRunResult> {
    const scenarios = parseRainScenarios(scenarioText);
    const settings = parseEngineSettings(settingsText);
    const manning = settings.get("manning");
    if (manning === undefined || !(manning > 0)) throw new SpatialOpError("曼宁糙率没写。请向用户问地表糙率，程序不会填一个数。");
    const edges = (boundary ?? "").trim() === "" ? "open" : (boundary ?? "").trim();
    if (edges !== "open" && edges !== "closed") throw new SpatialOpError("边界只能是 open（四周自由出流）或 closed（四周封闭）。");
    const steps = settings.get("steps") ?? 4;
    if (!Number.isInteger(steps) || steps < 1 || steps > 24) throw new SpatialOpError("输出时刻数要在 1 到 24 之间。");
    const threshold = settings.get("depthThreshold") ?? 0.01;
    if (!(threshold >= 0)) throw new SpatialOpError("统计面积用的水深下限不能为负。");
    const simulation = settings.get("simulationHours");
    this.requireWorkspace("降雨径流");
    const dem = await this.requireRaster(rasterName);
    const terrain = basename(dem.absolute);
    const resources: string[] = [];
    const defaults = [
      ...(settings.has("steps") ? [] : ["输出时刻数按 4"]),
      ...(settings.has("depthThreshold") ? [] : ["统计面积的水深下限按 0.01 米"]),
      ...(simulation === undefined ? ["模拟时长按各情景的降雨历时"] : []),
      ...((boundary ?? "").trim() === "" ? ["四周边界按自由出流"] : []),
    ];
    const lines = await this.runScenarios("runoff", scenarios, async (scenario, index, number) => {
      const total = simulation ?? scenario.hours;
      const ran = await this.invokeEngine("engine.runoff", [dem.relative], rasterStem(rasterName), {
        rainIntensity: scenario.intensity,
        rainHours: scenario.hours,
        simulationHours: total,
        manning,
        steps,
        depthThreshold: threshold,
        boundary: edges,
      });
      const summary = await readEngineSummary(ran.outputs.at(-1));
      const rows = summarySteps(summary);
      const depthFiles = ran.outputs.slice(0, steps);
      if (rows.length !== steps || depthFiles.length !== steps) throw new SpatialOpError("ANUGA 的输出时刻数和要求的不一致。");
      const seriesSteps: { hours: number; handle: string }[] = [];
      for (const [offset, file] of depthFiles.entries()) {
        const bare = rasterBareName(rasterName, `runoff${number}-t${offset + 1}`);
        const published = await this.publishRaster(file, bare);
        if (!published) throw new SpatialOpError("水深栅格没有写出。");
        resources.push(published.relative);
        seriesSteps.push({ hours: rows[offset]?.hours ?? 0, handle: rasterHandle(bare) });
      }
      const speedBare = rasterBareName(rasterName, `runoff${number}-speed`);
      const speed = await this.publishRaster(ran.outputs[steps], speedBare);
      if (speed) resources.push(speed.relative);
      const label = `降雨径流 ${sig(scenario.intensity)} 毫米每小时 ${sig(scenario.hours)} 小时`;
      await this.recordSeries({ seriesId: `runoff-${number}`, kind: "runoff", label, terrain, steps: seriesSteps, peak: speed ? rasterHandle(speedBare) : null });
      const stepText = rows.map((row, offset) => `第 ${sig(row.hours ?? 0)} 小时最大水深 ${sig(row.maxDepth ?? 0)} 米，水深超过 ${sig(threshold)} 米的面积 ${sig(row.wetArea ?? 0)} 平方米，最大流速 ${sig(row.maxSpeed ?? 0)} 米每秒，水深栅格 ${seriesSteps[offset]?.handle ?? ""}。`).join("");
      const last = rows.at(-1) ?? {};
      const rained = last.rained ?? 0;
      const stored = last.volume ?? 0;
      const factor = typeof summary.factor === "number" && summary.factor > 1 ? `高程网格按 ${summary.factor} 倍变粗，计算网格 ${sig(Number(summary.cell))} 米。` : "";
      const balance = `降雨 ${sig(rained)} 立方米，结束时地表存水 ${sig(stored)} 立方米${edges === "open" ? `，从边界流出约 ${sig(Math.max(rained - stored, 0))} 立方米` : ""}。`;
      return `情景 ${index}（${sig(scenario.intensity)}x${sig(scenario.hours)}，模拟 ${sig(total)} 小时）：${stepText}${balance}${factor}最大流速栅格 ${speed ? rasterHandle(speedBare) : "没有写出"}。`;
    });
    const ids = await this.remember({
      operationType: "rainfall-runoff",
      inputLayerNames: [rasterStem(rasterName)],
      parameters: auditParameters({ target: scenarios.map((item) => `${item.intensity}x${item.hours}`).join(";"), mapping: `manning=${manning};steps=${steps};depthThreshold=${threshold}${simulation !== undefined ? `;simulationHours=${simulation}` : ""}`, queryKind: edges }),
      outputFilePath: null,
      layerId: null,
      success: true,
      note: `ANUGA 降雨径流 ${scenarios.length} 个情景。`,
      writeKnowledge,
      featureCount: scenarios.length,
      fieldNames: [],
    });
    return {
      ok: true,
      operationType: "rainfall-runoff",
      message: `ANUGA 浅水方程算完 ${scenarios.length} 个情景，曼宁糙率 ${sig(manning)}。${defaults.length > 0 ? `${defaults.join("，")}。` : ""}${lines.join("")}三维页可以按时刻回放。`,
      layer: null,
      featureCount: scenarios.length,
      fieldName: null,
      minimum: null,
      maximum: null,
      mean: null,
      sum: null,
      ...(resources.length > 0 ? { localOutputResources: resources } : {}),
      ...(typeof ids.auditRecordId === "string" ? { auditRecordId: ids.auditRecordId } : {}),
    };
  }

  /** 降雨滑坡：TRIGRS 无限边坡加一维入渗。土体参数全部要用户给，每个情景单独跑。 */
  async rainfallLandslide(rasterName: string, scenarioText: string | null, settingsText: string | null, writeKnowledge: boolean): Promise<SpatialRunResult> {
    const scenarios = parseRainScenarios(scenarioText);
    const settings = parseEngineSettings(settingsText);
    const missing = LANDSLIDE_INPUTS.filter((item) => settings.get(item.key) === undefined).map((item) => item.label);
    if (missing.length > 0) throw new SpatialOpError(`降雨滑坡还缺：${missing.join("、")}。请向用户问，程序不会填数。`);
    const steps = settings.get("steps") ?? 4;
    if (!Number.isInteger(steps) || steps < 1 || steps > 24) throw new SpatialOpError("输出时刻数要在 1 到 24 之间。");
    const background = settings.get("backgroundRate");
    this.requireWorkspace("降雨滑坡");
    const dem = await this.requireRaster(rasterName);
    const terrain = basename(dem.absolute);
    const soil: Record<string, number> = {};
    for (const item of LANDSLIDE_INPUTS) soil[item.key] = settings.get(item.key) ?? Number.NaN;
    const resources: string[] = [];
    const defaults = [
      ...(settings.has("steps") ? [] : ["输出时刻数按 4"]),
      ...(background === undefined ? ["初始入渗率按 0"] : []),
    ];
    const lines = await this.runScenarios("landslide", scenarios, async (scenario, index, number) => {
      const ran = await this.invokeEngine("engine.landslide", [dem.relative], rasterStem(rasterName), {
        rainIntensity: scenario.intensity,
        rainHours: scenario.hours,
        ...soil,
        backgroundRate: background ?? 0,
        steps,
      });
      const summary = await readEngineSummary(ran.outputs.at(-1));
      const rows = summarySteps(summary);
      const files = ran.outputs.slice(0, steps);
      if (rows.length !== steps || files.length !== steps) throw new SpatialOpError("TRIGRS 的输出时刻数和要求的不一致。");
      const seriesSteps: { hours: number; handle: string }[] = [];
      for (const [offset, file] of files.entries()) {
        const bare = rasterBareName(rasterName, `fs${number}-t${offset + 1}`);
        const published = await this.publishRaster(file, bare);
        if (!published) throw new SpatialOpError("安全系数栅格没有写出。");
        resources.push(published.relative);
        seriesSteps.push({ hours: rows[offset]?.hours ?? 0, handle: rasterHandle(bare) });
      }
      const label = `降雨滑坡 ${sig(scenario.intensity)} 毫米每小时 ${sig(scenario.hours)} 小时`;
      await this.recordSeries({ seriesId: `landslide-${number}`, kind: "landslide", label, terrain, steps: seriesSteps, peak: null });
      const stepText = rows.map((row, offset) => `第 ${sig(row.hours ?? 0)} 小时最小安全系数 ${sig(row.minFs ?? 0)}，安全系数小于 1 的面积 ${sig(row.unstableArea ?? 0)} 平方米，安全系数栅格 ${seriesSteps[offset]?.handle ?? ""}。`).join("");
      return `情景 ${index}（${sig(scenario.intensity)}x${sig(scenario.hours)}）：${stepText}`;
    });
    const soilText = LANDSLIDE_INPUTS.map((item) => `${item.key}=${soil[item.key]}`).join(";");
    const ids = await this.remember({
      operationType: "rainfall-landslide",
      inputLayerNames: [rasterStem(rasterName)],
      parameters: auditParameters({ target: scenarios.map((item) => `${item.intensity}x${item.hours}`).join(";"), mapping: `${soilText};steps=${steps};backgroundRate=${background ?? 0}` }),
      outputFilePath: null,
      layerId: null,
      success: true,
      note: `TRIGRS 降雨滑坡 ${scenarios.length} 个情景。`,
      writeKnowledge,
      featureCount: scenarios.length,
      fieldNames: [],
    });
    return {
      ok: true,
      operationType: "rainfall-landslide",
      message: `TRIGRS 算完 ${scenarios.length} 个情景。土体：黏聚力 ${sig(soil.cohesion ?? 0)} 千帕，内摩擦角 ${sig(soil.frictionAngle ?? 0)} 度，重度 ${sig(soil.unitWeight ?? 0)} 千牛每立方米，土层厚 ${sig(soil.soilDepth ?? 0)} 米，初始水位埋深 ${sig(soil.waterTableDepth ?? 0)} 米。${defaults.length > 0 ? `${defaults.join("，")}。` : ""}没有做径流汇流。${lines.join("")}三维页可以按时刻回放。`,
      layer: null,
      featureCount: scenarios.length,
      fieldName: null,
      minimum: null,
      maximum: null,
      mean: null,
      sum: null,
      ...(resources.length > 0 ? { localOutputResources: resources } : {}),
      ...(typeof ids.auditRecordId === "string" ? { auditRecordId: ids.auditRecordId } : {}),
    };
  }

  /** 地层体：LoopStructural 隐式建模。用 map.geologyInputs 登记的界面点和产状。 */
  async geologyModel(layerId: string, depth: number, rasterName: string | null, writeKnowledge: boolean): Promise<SpatialRunResult> {
    if (!(Number.isFinite(depth) && depth > 0)) throw new SpatialOpError("模型向下延伸的深度没写。请向用户问要建到最低界面点以下多少米，程序不会填数。");
    const workspace = this.requireWorkspace("地层体");
    const scene = await readSceneFile(workspace);
    if (!scene.geology) throw new SpatialOpError("还没有登记地层输入。请先用 map.geologyInputs 指出界面点图层、界面字段、倾角字段和倾向字段。");
    const input = this.requireCollection(layerId);
    if (input.meta.layerId !== scene.geology.layerId) {
      throw new SpatialOpError(`登记的界面点图层是 ${scene.geology.layerName}，不是 ${input.meta.layerName}。请用登记的图层，或先重新登记。`);
    }
    const dem = rasterName && rasterName.trim() !== "" ? await this.requireRaster(rasterName) : null;
    const ran = await this.invokeEngine(
      "engine.geology",
      dem ? [backendResource(input.meta.outputFilePath), dem.relative] : [backendResource(input.meta.outputFilePath)],
      input.meta.layerName,
      {
        contactField: scene.geology.contactField,
        dipField: scene.geology.dipField,
        azimuthField: scene.geology.azimuthField,
        depth,
        ...this.layerEpsg(input.meta),
      },
    );
    const [modelFile, summaryFile] = ran.outputs;
    if (!modelFile) throw new SpatialOpError("LoopStructural 没有写出地层体。");
    const summary = await readEngineSummary(summaryFile);
    const units = Array.isArray(summary.units) ? summary.units.filter((item): item is string => typeof item === "string") : [];
    const volumes = Array.isArray(summary.volumes) ? summary.volumes.filter((item): item is number => typeof item === "number") : [];
    if (units.length < 2 || units.length !== volumes.length) throw new SpatialOpError("LoopStructural 的摘要不完整。");
    await writeFile(join(workspace, GEOLOGY_FILE), await readFile(resolve(modelFile)));
    await this.mergeScene({ geologyModel: { units, volumes, terrain: dem ? basename(dem.absolute) : null } });
    const ids = await this.remember({
      operationType: "geology-model",
      inputLayerNames: [input.meta.layerName],
      parameters: auditParameters({ distance: depth, fieldName: scene.geology.contactField, groupField: scene.geology.dipField, target: scene.geology.azimuthField }),
      outputFilePath: null,
      layerId: input.meta.layerId,
      success: true,
      note: `LoopStructural 地层体 ${units.length - 1} 层。`,
      writeKnowledge,
      featureCount: input.meta.featureCount,
      fieldNames: [scene.geology.contactField, scene.geology.dipField, scene.geology.azimuthField],
    });
    const named = units.slice(1);
    const volumeText = units.map((unit, index) => `${index === 0 ? "最低界面以下" : unit} ${sig(volumes[index] ?? 0)} 立方米`).join("，");
    return {
      ok: true,
      operationType: "geology-model",
      message: `${ran.message} 从下到上：${named.join("、")}。界面点按所标地层的底面处理，法向按倾向倾角取向上。体积：${volumeText}。${dem ? "地面以上的部分已按高程栅格削掉。" : "没有给高程栅格，顶面取最高界面点。"}没有断层。三维页可以看地层体。`,
      layer: null,
      featureCount: input.meta.featureCount,
      fieldName: scene.geology.contactField,
      minimum: null,
      maximum: null,
      mean: null,
      sum: null,
      ...(typeof ids.auditRecordId === "string" ? { auditRecordId: ids.auditRecordId } : {}),
    };
  }

  /** 给三维页用的降采样高程网格。不进模型。名字可以是栅格编号、裸文件名，或已登记情景的地形。 */
  async terrainGrid(rasterName: string, maxSize: number): Promise<Record<string, unknown>> {
    const reference = await this.requireRaster(rasterName);
    const port = this.options.external;
    if (!port) throw new SpatialOpError("外部能力后端未启用，三维地形不可用。");
    const outcome = await port.invoke({ capability: "raster.terrain", inputResources: [reference.relative], outputHint: "terrain", parameters: { maxSize } });
    if (!outcome.ok) throw new SpatialOpError(outcome.message || "三维地形读取失败。");
    const produced = outcome.localOutputResources?.[0];
    if (!produced) throw new SpatialOpError("三维地形没有写出。");
    const parsed = JSON.parse(await readFile(resolve(produced), { encoding: "utf8" })) as Record<string, unknown>;
    await rm(resolve(produced), { recursive: true, force: true });
    return parsed;
  }

  async seriesTerrain(seriesId: string): Promise<string | null> {
    const workspace = this.conversationWorkspace();
    if (!workspace) return null;
    const scene = await readSceneFile(workspace);
    if (seriesId === "geology") return scene.geologyModel?.terrain ?? null;
    return scene.series.find((item) => item.seriesId === seriesId)?.terrain ?? null;
  }

  private async mergeScene(patch: Partial<SceneFile>): Promise<void> {
    const workspace = this.conversationWorkspace();
    if (!workspace) throw new SpatialOpError("没有当前对话，不能登记。");
    const current = await readSceneFile(workspace);
    await writeSceneFile(workspace, {
      stack: patch.stack !== undefined ? patch.stack : current.stack,
      geology: patch.geology !== undefined ? patch.geology : current.geology,
      series: patch.series !== undefined ? patch.series : current.series,
      geologyModel: patch.geologyModel !== undefined ? patch.geologyModel : current.geologyModel,
    });
  }

  /** 读本机桥写出的 GeoJSON，按来源图层的坐标系入库。坐标原样保留。 */
  private async insertProducedVector(
    operationType: SpatialAuditOperation,
    action: string,
    produced: string,
    source: LayerMeta,
    parameters: SpatialAuditParameters,
    writeKnowledge: boolean,
    outputName: string | null,
    detail: string,
  ): Promise<SpatialRunResult> {
    const parsed = JSON.parse(await readFile(resolve(produced), { encoding: "utf8" })) as unknown;
    if (!parsed || typeof parsed !== "object" || (parsed as { type?: unknown }).type !== "FeatureCollection" || !Array.isArray((parsed as { features?: unknown }).features)) {
      throw new SpatialOpError("外部能力的结果不是要素集合。");
    }
    const collection = parsed as MapCollection;
    const requested = outputName ? safeLayerName(outputName) : "";
    const meta = await this.catalog.insert({
      layerName: requested !== "" && requested !== "未命名图层" ? requested : safeLayerName(`${source.layerName}_${action}`),
      sourcePaths: [...source.sourcePaths, source.outputFilePath],
      collection,
      crsLabel: crsLabelFor(source.crsIdentity),
      crsIdentity: source.crsIdentity,
      ...(source.crsWkt !== undefined ? { crsWkt: source.crsWkt } : {}),
      geometryHash: geometryContentHash(collection),
    });
    const message = `${action}完成，${meta.featureCount} 个要素。${detail}`;
    const layer = this.publish(meta, message);
    const ids = await this.remember({
      operationType,
      inputLayerNames: [source.layerName],
      parameters,
      outputFilePath: meta.outputFilePath,
      layerId: meta.layerId,
      success: true,
      note: action,
      writeKnowledge,
      featureCount: meta.featureCount,
      fieldNames: meta.fieldNames,
    });
    return {
      ok: true,
      operationType,
      message,
      layer,
      featureCount: meta.featureCount,
      fieldName: null,
      minimum: null,
      maximum: null,
      mean: null,
      ragEntryId: ids.ragEntryId,
      ...(typeof ids.auditRecordId === "string" ? { auditRecordId: ids.auditRecordId } : {}),
      ...(ids.auditAppendFailed ? { auditAppendFailed: true as const } : {}),
    };
  }

  /**
   * 平行线。GEOS OffsetCurve（shapely）在本机生成，正距离在线的左侧，负距离在右侧。
   * 已知 EPSG 由 GDAL 判断是否为地理坐标；地理坐标拒绝，先投影。距离按米给，未知坐标系按坐标单位。
   */
  async offsetLine(layerId: string, distance: number, join: string | null, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    if (!Number.isFinite(distance) || distance === 0) throw new SpatialOpError("平行线距离必须是非零数值。");
    const style = (join ?? "round").trim().toLowerCase() || "round";
    if (style !== "round" && style !== "mitre" && style !== "bevel") throw new SpatialOpError("拐角只支持 round、mitre、bevel。");
    const input = this.requireCollection(layerId);
    const identity = input.meta.crsIdentity;
    if (identity.kind === "invalid") throw new SpatialOpError("图层坐标系无效，不能生成平行线。");
    if (!input.collection.features.some((feature) => feature.geometry?.type === "LineString" || feature.geometry?.type === "MultiLineString")) {
      throw new SpatialOpError("平行线需要线图层。");
    }
    const unitToMeter = identity.kind === "planar" && input.meta.crsWkt ? planarUnitToMeter(input.meta.crsWkt) : null;
    const port = this.options.external;
    if (!port) throw new SpatialOpError("外部能力后端未启用，该能力当前不可用。");
    const outcome = await port.invoke({
      capability: "vector.offset",
      inputResources: [backendResource(input.meta.outputFilePath)],
      outputHint: input.meta.layerName,
      parameters: {
        distance,
        join: style,
        ...(identity.kind === "known" ? { epsg: identity.epsg } : {}),
        ...(unitToMeter !== null ? { unitToMeter } : {}),
      },
    });
    if (!outcome.ok) throw new SpatialOpError(outcome.message || "外部能力执行失败。");
    const produced = outcome.localOutputResources?.[0];
    if (!produced) throw new SpatialOpError("外部能力没有产出结果文件。");
    return this.insertProducedVector("offset-line", "平行线", produced, input.meta, auditParameters({ distance, target: style }), writeKnowledge, outputName, outcome.message ?? "");
  }

  /** 最小费用走廊。费用栅格、起点图层、终点图层；走廊栅格发布，最小费用路径作为线图层入库。 */
  async costCorridor(rasterName: string, layerId: string, otherLayerId: string, tolerance: number | null, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    if (tolerance !== null && !(tolerance >= 0 && tolerance <= 1)) throw new SpatialOpError("走廊宽容度必须在 0 到 1 之间。");
    const start = this.requireCollection(layerId);
    const end = this.requireCollection(otherLayerId);
    this.requireSameCrs("最小费用走廊", start.meta, end.meta);
    const reference = await this.requireRaster(rasterName);
    const port = this.options.external;
    if (!port) throw new SpatialOpError("外部能力后端未启用，该能力当前不可用。");
    const outcome = await port.invoke({
      capability: "raster.costCorridor",
      inputResources: [reference.relative, backendResource(start.meta.outputFilePath), backendResource(end.meta.outputFilePath)],
      parameters: { ...(tolerance !== null ? { tolerance } : {}), ...this.layerEpsg(start.meta) },
    });
    if (!outcome.ok) throw new SpatialOpError(outcome.message || "外部能力执行失败。");
    const [corridor, path] = outcome.localOutputResources ?? [];
    if (!corridor || !path) throw new SpatialOpError("外部能力没有产出走廊和路径。");
    const bareName = rasterBareName(rasterName, "corridor");
    const published = await this.publishRaster(corridor, bareName);
    const result = await this.insertProducedVector(
      "cost-corridor",
      "最小费用路径",
      path,
      start.meta,
      auditParameters({ ...(tolerance !== null ? { tolerance } : {}) }),
      writeKnowledge,
      outputName,
      `${outcome.message ?? ""} 走廊栅格 ${rasterHandle(bareName)}。`,
    );
    return { ...result, ...(published ? { localOutputResources: [published.relative] } : {}) };
  }

  /** 已知 EPSG 时交给本机桥与栅格坐标系比对。 */
  private layerEpsg(meta: LayerMeta): { readonly layerEpsg?: number } {
    return meta.crsIdentity.kind === "known" ? { layerEpsg: meta.crsIdentity.epsg } : {};
  }

  private requireSameCrs(label: string, ...metas: readonly LayerMeta[]): void {
    const tokens = new Set(metas.map((meta) => cacheCrsToken(meta.crsIdentity)));
    if (tokens.size > 1) throw new SpatialOpError(`${label}的图层坐标系不同。请先用 map.reproject 统一坐标系。`);
  }

  private measureOf(meta: LayerMeta): Measure {
    const identity = meta.crsIdentity;
    const unit = identity.kind === "planar" && meta.crsWkt ? planarUnitToMeter(meta.crsWkt) : null;
    return { mode: distanceModeOf(identity.kind, identity.kind === "known" ? identity.epsg : null, unit), unitToMeter: unit };
  }

  /** 点插值成栅格，并留出一部分点算误差。依赖本机 GDAL。 */
  async interpolate(layerId: string, fieldName: string, algorithm: string, writeKnowledge: boolean): Promise<SpatialRunResult> {
    const kind = algorithm.trim().toLowerCase();
    if (kind !== "invdist" && kind !== "nearest" && kind !== "linear") {
      throw new SpatialOpError("插值只支持 invdist、nearest、linear。");
    }
    const field = requireFieldName(fieldName, "插值");
    const input = this.requireCollection(layerId);
    const port = this.options.external;
    if (!port) throw new SpatialOpError("外部能力后端未启用，该能力当前不可用。");
    const outcome = await port.invoke({
      capability: "raster.grid",
      inputResources: [backendResource(input.meta.outputFilePath)],
      outputHint: input.meta.layerName,
      parameters: { field, algorithm: kind },
    });
    if (!outcome.ok) throw new SpatialOpError(outcome.message || "外部能力执行失败。");
    const facts = outcome.facts ?? {};
    const rmse = typeof facts.rmse === "number" ? facts.rmse : null;
    const mae = typeof facts.mae === "number" ? facts.mae : null;
    const held = typeof facts.heldOut === "number" ? facts.heldOut : 0;
    const accuracy = held > 0 && rmse !== null
      ? `留出 ${held} 个点，均方根误差 ${fmt(rmse)}${mae !== null ? `，平均绝对误差 ${fmt(mae)}` : ""}。`
      : "点数不足，没有做留出检验。";
    const produced = outcome.localOutputResources?.[0];
    const published = await this.publishRaster(produced, rasterBareName(input.meta.layerName, kind));
    const resource = published?.relative ?? produced;
    const handle = published ? rasterHandle(rasterBareName(input.meta.layerName, kind)) : "";
    const handleNote = handle !== "" ? `栅格编号 ${handle}。` : "没有生成栅格编号。";
    const ids = await this.remember({
      operationType: "interpolate",
      inputLayerNames: [input.meta.layerName],
      parameters: auditParameters({ fieldName: field, target: kind }),
      outputFilePath: published?.absolute ?? null,
      layerId: input.meta.layerId,
      success: true,
      note: accuracy,
      writeKnowledge,
      featureCount: input.collection.features.length,
      fieldNames: [field],
    });
    return {
      ok: true,
      operationType: "interpolate",
      message: `插值完成。${accuracy}${handleNote}${outcome.message ?? ""}`,
      layer: null,
      featureCount: input.collection.features.length,
      fieldName: field,
      minimum: mae,
      maximum: null,
      mean: rmse,
      ...(resource ? { localOutputResources: [resource] } : {}),
      ...(typeof ids.auditRecordId === "string" ? { auditRecordId: ids.auditRecordId } : {}),
    };
  }

  /** 等高线：矢量结果入图层库（可上图）。等高距必须大于 0。 */
  async contour(rasterName: string, interval: number, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    if (!(typeof interval === "number" && Number.isFinite(interval) && interval > 0)) {
      throw new SpatialOpError("等高距必须大于 0。");
    }
    const reference = await this.requireRaster(rasterName);
    const port = this.options.external;
    if (!port) throw new SpatialOpError("外部能力后端未启用，该能力当前不可用。");
    const outcome = await port.invoke({
      capability: "raster.contour",
      inputResources: [reference.relative],
      outputHint: rasterName.trim(),
      parameters: { interval },
    });
    if (!outcome.ok) throw new SpatialOpError(outcome.message || "外部能力执行失败。");
    const produced = outcome.localOutputResources?.[0];
    if (!produced) throw new SpatialOpError("外部能力没有产出结果文件。");
    const loaded = await this.loadFile(resolve(produced), outputName, writeKnowledge);
    const layer = loaded[0] ?? null;
    return {
      ok: true,
      operationType: "contour",
      message: `等高线生成完成，结果已载入图层库。${outcome.message ?? ""}`,
      layer,
      featureCount: layer?.featureCount ?? 0,
      fieldName: null,
      minimum: null,
      maximum: null,
      mean: null,
    };
  }

  async reproject(layerId: string, targetCrs: string, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    const crs = targetCrs.trim();
    if (crs === "") throw new SpatialOpError("重投影需要目标坐标系。");
    return this.externalLayer("reproject", "重投影", "vector.reproject", layerId, { targetCrs: crs }, writeKnowledge, outputName);
  }

  async convertFormat(layerId: string, format: string, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    const fmt = format.trim().toLowerCase();
    if (!["gpkg", "geojson", "kml", "gml", "shp"].includes(fmt)) throw new SpatialOpError("不支持的目标格式。");
    return this.externalLayer("convert-format", "格式转换", "vector.convertFormat", layerId, { format: fmt }, writeKnowledge, outputName);
  }

  /** 只在这一次执行里看见调用方坐标系。不写入图层库。上下文随异步链路传播，并发不串扰。 */
  async usingCallerCrs<T>(callerCrs: string | null | undefined, run: () => Promise<T>): Promise<T> {
    const current = callContext.getStore();
    return callContext.run(
      {
        callerCrs: typeof callerCrs === "string" && callerCrs.trim() !== "" ? callerCrs : null,
        requestSource: current?.requestSource ?? null,
        conversationWorkspace: current?.conversationWorkspace ?? null,
        conversationLayerIds: current?.conversationLayerIds ?? null,
      },
      run,
    );
  }

  /** 只在这一次审计里记下请求来源。不是登录。上下文随异步链路传播，并发不串扰。 */
  async usingRequestSource<T>(source: RequestSource | null | undefined, run: () => Promise<T>): Promise<T> {
    const current = callContext.getStore();
    return callContext.run(
      {
        callerCrs: current?.callerCrs ?? null,
        requestSource: source ?? null,
        conversationWorkspace: current?.conversationWorkspace ?? null,
        conversationLayerIds: current?.conversationLayerIds ?? null,
      },
      run,
    );
  }

  /**
   * 这一次调用只使用这条对话自己的图层目录。
   * 矢量图层写在工作区的 layers 下，不写进程共用的总库。
   */
  async inConversation<T>(workspace: string, run: () => Promise<T>): Promise<T> {
    const next = this.conversationQueue.then(async () => {
      await this.catalog.openAt(join(workspace, "layers"));
      return this.usingConversationWorkspace(workspace, run);
    });
    this.conversationQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  /** 对话删除后，放下内存里仍指向该工作区的图层。 */
  releaseConversation(workspace: string): void {
    this.catalog.release(join(workspace, "layers"));
  }

  /** 这一次调用在指定对话工作区里解析栅格。不写入图层库，并发不串扰。 */
  async usingConversationWorkspace<T>(directory: string | null | undefined, run: () => Promise<T>): Promise<T> {
    const current = callContext.getStore();
    const next = typeof directory === "string" && directory.trim() !== "" ? directory : null;
    return callContext.run(
      {
        callerCrs: current?.callerCrs ?? null,
        requestSource: current?.requestSource ?? null,
        conversationWorkspace: next,
        conversationLayerIds: current?.conversationLayerIds ?? null,
      },
      run,
    );
  }

  /**
   * 这一次调用只在这些图层里解析名字。
   * 空数组表示当前对话没有图层，不回退到整个图层库。
   */
  async usingConversationLayers<T>(layerIds: readonly string[], run: () => Promise<T>): Promise<T> {
    const current = callContext.getStore();
    const ids = layerIds.map((id) => id.trim()).filter((id) => id !== "");
    return callContext.run(
      {
        callerCrs: current?.callerCrs ?? null,
        requestSource: current?.requestSource ?? null,
        conversationWorkspace: current?.conversationWorkspace ?? null,
        conversationLayerIds: ids,
      },
      run,
    );
  }

  /** 调用已经限定图层编号时只列出这些图层。没有编号时列出当前打开的那条对话目录。 */
  layerCatalogForResolve(): { list(): readonly LayerMeta[] } {
    const ids = callContext.getStore()?.conversationLayerIds;
    if (ids == null) return this.store;
    const allowed = new Set(ids);
    return { list: () => this.store.list().filter((layer) => allowed.has(layer.layerId)) };
  }

  private rejectCallerOverride(identities: readonly CrsIdentity[], plan: CrsExecutionPlan): void {
    const callerCrs = callContext.getStore()?.callerCrs ?? null;
    if (!callerCrs) return;
    const caller = identifyCrs(callerCrs);
    if (identities.some((identity) => callerConflicts(identity, caller))) {
      const failure = new SpatialOpError(CRS_CALLER_CONFLICT);
      failure.crsFacts = crsFacts(plan, []);
      throw failure;
    }
  }

  private modelName(): string {
    return safeModelName(this.options.modelName());
  }

  private publish(meta: LayerMeta, message: string, issues: readonly GeometryIssue[] = []): PublicMapLayer {
    const layer: PublicMapLayer = withIssues({
      layerId: meta.layerId,
      layerName: meta.layerName,
      featureCount: meta.featureCount,
      fieldNames: meta.fieldNames,
      mapUrl: `/api/map/layers/${meta.layerId}/geojson`,
      message,
    }, issues);
    spatialResultSink.getStore()?.push(layer);
    return layer;
  }

  /** 内核接口：给外部模块（例如 GDL）读取图层库。 */
  get store(): MapLayerCatalog {
    return this.catalog;
  }

  /**
   * 只丢掉指向这些结果图层的缓存键。
   * 键指向别的仍在使用的结果时保留。
   */
  async dropOwnedCacheKey(key: string, resultLayerIds: readonly string[]): Promise<"removed" | "kept" | "missing"> {
    return this.cache.dropIfPointsAt(key, resultLayerIds);
  }

  private async remember(input: {
    readonly operationType: SpatialAuditOperation;
    readonly inputLayerNames: readonly string[];
    readonly parameters: SpatialAuditParameters;
    readonly outputFilePath: string | null;
    readonly layerId: string | null;
    readonly success: boolean;
    readonly note: string;
    readonly writeKnowledge: boolean;
    readonly featureCount: number;
    readonly fieldNames: readonly string[];
    readonly durationMs?: number;
  }): Promise<{ readonly ragEntryId: string | null; readonly auditRecordId: string | null; readonly auditAppendFailed: boolean }> {
    let auditRecordId: string | null = null;
    let ragEntryId: string | null = null;
    let auditAppendFailed = false;
    const note = typeof input.durationMs === "number" ? `${input.note} 耗时 ${input.durationMs}ms` : input.note;
    const requestSource = callContext.getStore()?.requestSource ?? null;
    try {
      const record = buildSpatialAuditRecord({
        operationType: input.operationType,
        inputLayerNames: input.inputLayerNames.map((name) => safeLayerName(name)),
        parameters: input.parameters,
        outputFilePath: input.outputFilePath,
        modelName: this.modelName(),
        layerId: input.layerId,
        success: input.success,
        note,
        ...(typeof input.durationMs === "number" ? { durationMs: input.durationMs } : {}),
        ...(requestSource ? { requestSource } : {}),
      });
      try {
        await this.audit.append(record);
        auditRecordId = record.recordId;
      } catch {
        auditRecordId = null;
        auditAppendFailed = true;
      }
    } catch {
      auditRecordId = null;
      auditAppendFailed = false;
    }
    return { ragEntryId, auditRecordId, auditAppendFailed };
  }

  private requireCollection(layerId: string): { readonly meta: LayerMeta; readonly collection: MapCollection } {
    const meta = this.catalog.get(layerId);
    const collection = this.catalog.collection(layerId);
    if (!meta || !collection) throw new SpatialOpError("找不到输入图层。请先把图层载入地图。");
    return { meta, collection };
  }

  private async gdal(): Promise<GdalRuntime> {
    if (!this.runtime) this.runtime = await loadGdalRuntime();
    return this.runtime;
  }

  /** GeoTIFF 走地图加载。文件放进当前对话的 rasters，平面图记其范围，并给出栅格编号。 */
  private async loadGeotiff(path: string, layerName: string | null, writeKnowledge: boolean): Promise<readonly PublicMapLayer[]> {
    const bare = this.assertBareRasterName(basename(path));
    const published = await this.publishRaster(path, bare);
    if (!published) throw new SpatialOpError("栅格没有放进当前对话。");
    const grid = await this.terrainGrid(bare, 8);
    const extent = Array.isArray(grid.extent) ? grid.extent.filter((item): item is number => typeof item === "number" && Number.isFinite(item)) : [];
    if (extent.length !== 4) throw new SpatialOpError("栅格范围没有读出来。");
    const minX = extent[0] ?? 0;
    const minY = extent[1] ?? 0;
    const maxX = extent[2] ?? 0;
    const maxY = extent[3] ?? 0;
    const epsg = typeof grid.epsg === "number" ? grid.epsg : null;
    const identity = epsg === null ? identifyCrs(DEFAULT_CRS_LABEL) : identifyCrs(`EPSG:${epsg}`);
    const collection: MapCollection = {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: { raster: bare },
        geometry: { type: "Polygon", coordinates: [[[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]]] },
      }],
    };
    const name = safeLayerName(layerName ?? bare.replace(/\.tiff?$/i, ""));
    const meta = await this.catalog.insert({
      layerName: name,
      sourcePaths: [published.absolute],
      collection,
      crsLabel: crsLabelFor(identity),
      crsIdentity: identity,
      geometryHash: geometryContentHash(collection),
    });
    const handle = rasterHandle(bare);
    const crsNote = epsg === null ? " 文件没有写坐标系。" : "";
    const message = `已载入地图。栅格编号 ${handle}。${crsNote}`;
    const layer = this.publish(meta, message);
    await this.remember({
      operationType: "map-load",
      inputLayerNames: [name],
      parameters: auditParameters({}),
      outputFilePath: published.absolute,
      layerId: meta.layerId,
      success: true,
      note: message,
      writeKnowledge,
      featureCount: meta.featureCount,
      fieldNames: meta.fieldNames,
    });
    return [layer];
  }

  async loadFile(absolutePath: string, layerName: string | null, writeKnowledge: boolean): Promise<readonly PublicMapLayer[]> {
    const path = resolve(absolutePath);
    let info;
    try {
      info = await stat(path);
    } catch (error) {
      const missing = isEnoent(error);
      const failure = new SpatialOpError(missing ? "找不到这个路径。" : "无法读取这个路径。");
      const ids = await this.remember({
        operationType: "map-load",
        inputLayerNames: [safeLayerName(layerName ?? basename(path))],
        parameters: auditParameters({}),
        outputFilePath: null,
        layerId: null,
        success: false,
        note: failure.message,
        writeKnowledge: false,
        featureCount: 0,
        fieldNames: [],
      });
      attachRememberedAudit(failure, ids);
      throw failure;
    }
    if (info.isDirectory()) throw new SpatialOpError("请指定 shp 或 GeoJSON 文件，而不是文件夹。");
    try {
      const ext = extname(path).toLowerCase();
      if (ext === ".tif" || ext === ".tiff") return await this.loadGeotiff(path, layerName, writeKnowledge);
      const loaded = ext === ".geojson" || ext === ".json"
        ? [this.readGeoJsonFile(layerName ?? basename(path, ext), normalizeGeoJsonText(await readFile(path, { encoding: "utf8" })))]
        : await this.readWithGdal(path, layerName);
      if (loaded.length === 0) throw new SpatialOpError("没有可读的矢量图层。");
      const published: PublicMapLayer[] = [];
      for (const item of loaded) {
        const name = safeLayerName(item.layerName);
        if (item.normalized.collection.features.length === 0 && item.normalized.warnings.length > 0) {
          throw new SpatialOpError("图层几何无效或已损坏，没有要素可载入。");
        }
        const meta = await this.catalog.insert({
          layerName: name,
          sourcePaths: [path],
          collection: item.normalized.collection,
          crsLabel: item.crsLabel,
          crsIdentity: item.crsIdentity,
          ...(item.crsWkt !== null ? { crsWkt: item.crsWkt } : {}),
          geometryHash: geometryContentHash(item.normalized.collection),
        });
        const warning = item.normalized.warnings[0] ?? "";
        const note = warning === "" && item.crsNote === null
          ? ""
          : ` ${[warning, item.crsNote].filter((text): text is string => typeof text === "string" && text !== "").join(" ")}`;
        const message = note === "" ? "已载入地图。" : `已载入地图。${note}`;
        const skippedIssues: GeometryIssue[] = item.normalized.warnings
          .filter((text) => /第\s*\d+\s*个要素/.test(text))
          .map((text) => ({ featureIndex: Number(/第\s*(\d+)/.exec(text)?.[1] ?? "0") - 1, kind: "invalid" as const, message: text }));
        const issues = labelIssues(name, [...skippedIssues, ...validateCollection(item.normalized.collection).issues]);
        const layer = this.publish(meta, message, issues);
        published.push(layer);
        await this.remember({
          operationType: "map-load",
          inputLayerNames: [name],
          parameters: auditParameters({}),
          outputFilePath: meta.outputFilePath,
          layerId: meta.layerId,
          success: true,
          note: message,
          writeKnowledge,
          featureCount: meta.featureCount,
          fieldNames: meta.fieldNames,
        });
      }
      return published;
    } catch (error) {
      const failure = asSpatialError(error);
      const ids = await this.remember({
        operationType: "map-load",
        inputLayerNames: [safeLayerName(layerName ?? basename(path))],
        parameters: auditParameters({}),
        outputFilePath: null,
        layerId: null,
        success: false,
        note: failure.message,
        writeKnowledge: false,
        featureCount: 0,
        fieldNames: [],
      });
      attachRememberedAudit(failure, ids);
      throw failure;
    }
  }

  private readGeoJsonFile(layerName: string, normalized: ReturnType<typeof normalizeGeoJsonText>): LoadedLayer {
    const identity = normalized.crsIdentity;
    let crsNote: string | null = null;
    if (identity.kind === "known" && identity.epsg !== 4326 && identity.epsg !== 3857) {
      crsNote = `该 GeoJSON 声明了 ${identity.canonical}，但 GeoJSON 不携带投影定义：空间分析不可用；请转换为 EPSG:4326 或 EPSG:3857，或改用带投影文件的 Shapefile。`;
    }
    return { layerName, normalized, crsLabel: normalized.crsLabel, crsIdentity: identity, crsWkt: null, crsNote };
  }

  private async readWithGdal(path: string, layerName: string | null): Promise<readonly LoadedLayer[]> {
    const runtime = await this.gdal();
    const layers = await readVectorLayersAsGeoJson(runtime, path, layerName);
    const isShapefile = path.toLowerCase().endsWith(".shp");
    return layers.map((layer) => {
      let identity: CrsIdentity;
      let crsWkt: string | null = null;
      let crsNote: string | null = null;
      if (layer.crsWkt === null) {
        identity = identifyCrs(DEFAULT_CRS_LABEL);
        crsNote = isShapefile
          ? "未找到坐标系文件（.prj），图层按未声明处理：空间分析不可用；属性查询、统计和显示可用；建议补齐 .prj 后重新导入。"
          : "该文件格式的坐标系未能读取（当前只读 Shapefile 的 .prj），图层按未声明处理：空间分析不可用；属性查询、统计和显示可用；建议转换为带 .prj 的 Shapefile 或带 crs 的 GeoJSON。";
      } else {
        const epsg = epsgFromWkt(layer.crsWkt);
        if (epsg === null) {
          // WKT 写了投影/局部定义但没有标准 EPSG 代码：声明过的平面身份，不是无效。
          const declared = identifyCrs(layer.crsWkt);
          if (declared.kind === "planar") {
            identity = declared;
            crsWkt = layer.crsWkt;
            crsNote = "该文件的坐标系是局部平面坐标系（已声明投影、无标准 EPSG 代码）：平面构造与平面度量可用；缓冲、裁剪、相交、融合、简化、重投影仍需标准 EPSG 坐标系。";
          } else {
            identity = invalidCrs("wkt-no-epsg");
            crsNote = "该文件的坐标系没有标准 EPSG 代码：空间分析不可用；属性查询、统计和显示可用；请转换为标准 EPSG 坐标系后重新导入。";
          }
        } else {
          identity = { kind: "known", canonical: `EPSG:${epsg}`, epsg };
          crsWkt = layer.crsWkt;
        }
      }
      return {
        layerName: layer.layerName,
        normalized: normalizeFeatures(layer.features, layer.warnings),
        crsLabel: crsLabelFor(identity),
        crsIdentity: identity,
        crsWkt,
        crsNote,
      };
    });
  }

  async rename(layerId: string, layerName: string): Promise<LayerMeta> {
    const name = safeLayerName(layerName);
    if (name === "未命名图层" && layerName.trim() !== "" && layerName.trim() !== "未命名图层") {
      throw new SpatialOpError("图层名无效。");
    }
    try {
      return await this.catalog.rename(layerId, name);
    } catch (error) {
      throw asSpatialError(error);
    }
  }

  /**
   * 把已经在内存里的要素集合放进图层库，例如 GDL 文本。
   * 空或结构无效的要素先剔除并逐个报告；自相交和类型不一致只报告，不剔除。
   */
  async createLayer(input: FeatureLayerInput): Promise<{ readonly layer: PublicMapLayer; readonly issues: readonly GeometryIssue[] }> {
    const name = safeLayerName(input.layerName);
    const inspection = validateCollection(input.collection, input.expectedKind);
    const unusable = new Set(inspection.issues.filter(isUnusableIssue).map((issue) => issue.featureIndex));
    const kept = input.collection.features
      .filter((_feature, index) => !unusable.has(index))
      .map((feature, index) => ({ ...feature, properties: { ...feature.properties, _fid: index } }));
    const issues = labelIssues(name, inspection.issues);
    if (input.collection.features.length > 0 && kept.length === 0) {
      const ids = await this.remember({
        operationType: "gdl-load",
        inputLayerNames: [name],
        parameters: auditParameters({}),
        outputFilePath: null,
        layerId: null,
        success: false,
        note: "图层里的要素几何全部无效，没有载入。",
        writeKnowledge: false,
        featureCount: 0,
        fieldNames: [],
      });
      const failure = new SpatialOpError(`图层 ${name} 的要素几何全部无效，没有载入。`);
      attachRememberedAudit(failure, ids);
      throw Object.assign(failure, { geometryIssues: issues });
    }
    try {
      const meta = await this.catalog.insert({
        layerName: name,
        sourcePaths: [input.sourceLabel],
        collection: { type: "FeatureCollection", features: kept },
        crsLabel: input.crsLabel,
        geometryHash: geometryContentHash({ type: "FeatureCollection", features: kept }),
        ...(input.style ? { style: input.style } : {}),
      });
      const skipped = unusable.size > 0 ? `跳过 ${unusable.size} 个无效要素。` : "";
      const message = `已从 GDL 载入 ${meta.featureCount} 个要素。${skipped}`;
      const layer = this.publish(meta, message, issues);
      await this.remember({
        operationType: "gdl-load",
        inputLayerNames: [name],
        parameters: auditParameters({}),
        outputFilePath: meta.outputFilePath,
        layerId: meta.layerId,
        success: true,
        note: message,
        writeKnowledge: input.writeKnowledge,
        featureCount: meta.featureCount,
        fieldNames: meta.fieldNames,
      });
      return { layer, issues };
    } catch (error) {
      throw asSpatialError(error);
    }
  }

  /** 记一条 GDL 导出审计。返回这次 remember 是否写出了 id。 */
  async recordGdlExport(layerName: string, layerId: string, outputFilePath: string | null, success: boolean, note: string): Promise<{ readonly auditRecordId: string | null; readonly auditAppendFailed: boolean }> {
    const ids = await this.remember({
      operationType: "gdl-export",
      inputLayerNames: [safeLayerName(layerName)],
      parameters: auditParameters({}),
      outputFilePath,
      layerId,
      success,
      note,
      writeKnowledge: false,
      featureCount: 0,
      fieldNames: [],
    });
    return { auditRecordId: ids.auditRecordId, auditAppendFailed: ids.auditAppendFailed };
  }

  async buffer(layerId: string, distance: number, unitText: string, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    let unit: DistanceUnit;
    try {
      unit = normalizeUnit(unitText);
      assertDistance(distance, unit);
    } catch (error) {
      const failure = asSpatialError(error);
      const ids = await this.remember({
        operationType: "buffer",
        inputLayerNames: [safeLayerName(layerId)],
        parameters: auditParameters({}),
        outputFilePath: null,
        layerId: null,
        success: false,
        note: failure.message,
        writeKnowledge: false,
        featureCount: 0,
        fieldNames: [],
      });
      attachRememberedAudit(failure, ids);
      throw failure;
    }
    return this.derive("buffer", "缓冲", layerId, null, writeKnowledge, auditParameters({ distance, unit }), (collection, _other, planarUnit) => bufferFeatures(collection, distance, unit, planarUnit), outputName);
  }

  async intersect(layerId: string, otherLayerId: string, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    return this.derive("intersect", "相交", layerId, otherLayerId, writeKnowledge, auditParameters({}), (collection, other) => {
      if (!other) throw new SpatialOpError("相交需要两个图层。");
      return intersectFeatures(collection, other);
    }, outputName);
  }

  async clip(layerId: string, otherLayerId: string, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    return this.derive("clip", "裁剪", layerId, otherLayerId, writeKnowledge, auditParameters({}), (collection, other) => {
      if (!other) throw new SpatialOpError("裁剪需要目标图层和裁剪图层。");
      return clipFeatures(collection, other);
    }, outputName);
  }

  async query(layerId: string, otherLayerId: string | null, queryKindText: string, attributeFilter: string | null, writeKnowledge: boolean): Promise<SpatialRunResult> {
    let queryKind: QueryKind;
    let filter: string | null = null;
    try {
      queryKind = normalizeQueryKind(queryKindText);
      if (queryKind === "attribute") {
        if (!attributeFilter || attributeFilter.trim() === "") throw new SpatialOpError("属性筛选需要填写筛选文字。");
        filter = safeAttributeFilter(attributeFilter);
      } else if (attributeFilter && attributeFilter.trim() !== "") {
        filter = safeAttributeFilter(attributeFilter);
      }
    } catch (error) {
      const failure = asSpatialError(error);
      const ids = await this.remember({
        operationType: "spatial-query",
        inputLayerNames: [safeLayerName(layerId)],
        parameters: auditParameters({}),
        outputFilePath: null,
        layerId: null,
        success: false,
        note: failure.message,
        writeKnowledge: false,
        featureCount: 0,
        fieldNames: [],
      });
      attachRememberedAudit(failure, ids);
      throw failure;
    }
    return this.derive(
      "spatial-query",
      queryKind === "attribute" ? "属性筛选" : "空间查询",
      layerId,
      otherLayerId,
      writeKnowledge,
      auditParameters({ queryKind, ...(filter ? { attributeFilter: filter } : {}) }),
      (collection, other) => queryFeatures(collection, other, queryKind, filter),
    );
  }

  async stats(layerId: string, fieldName: string | null, writeKnowledge: boolean): Promise<SpatialRunResult> {
    const names = [layerId];
    try {
      const input = this.requireCollection(layerId);
      names[0] = input.meta.layerName;
      const plan = planCrsExecution([{ identity: input.meta.crsIdentity, wkt: input.meta.crsWkt ?? null }], false);
      // 统计不是空间运算：不做调用方坐标系冲突检查（与 crs-policy 的非空间语义一致）。
      const facts = crsFacts(plan, []);
      const stats = summarizeFeatures(input.collection, fieldName);
      let message = `要素 ${stats.featureCount} 个。`;
      if (stats.coordinateField) message = `要素 ${stats.featureCount} 个。该字段像坐标，统计值没有返回。`;
      else if (stats.fieldName && stats.numericCount === 0) message = `要素 ${stats.featureCount} 个。字段 ${stats.fieldName} 没有数值。`;
      else if (stats.fieldName && stats.minimum !== null && stats.maximum !== null && stats.mean !== null) {
        message = `要素 ${stats.featureCount} 个，字段 ${stats.fieldName} 最小 ${stats.minimum}、最大 ${stats.maximum}、平均 ${Number(stats.mean.toFixed(4))}。`;
      }
      const ids = await this.remember({
        operationType: "stats",
        inputLayerNames: [input.meta.layerName],
        parameters: auditParameters({ queryKind: "stats" }),
        outputFilePath: null,
        layerId: input.meta.layerId,
        success: true,
        note: stats.coordinateField ? "要素数量已记录。坐标字段的统计值已省略。" : message,
        writeKnowledge,
        featureCount: stats.featureCount,
        fieldNames: stats.fieldName ? [stats.fieldName] : input.meta.fieldNames,
      });
      return {
        ok: true,
        operationType: "stats",
        message,
        layer: null,
        featureCount: stats.featureCount,
        fieldName: stats.fieldName,
        minimum: stats.coordinateField ? null : stats.minimum,
        maximum: stats.coordinateField ? null : stats.maximum,
        mean: stats.coordinateField ? null : stats.mean,
        ...(typeof ids.auditRecordId === "string" ? { auditRecordId: ids.auditRecordId } : {}),
        ...(ids.auditAppendFailed ? { auditAppendFailed: true as const } : {}),
        crs: facts,
      };
    } catch (error) {
      const failure = asSpatialError(error);
      const ids = await this.remember({
        operationType: "stats",
        inputLayerNames: names.map((name) => safeLayerName(name)),
        parameters: auditParameters({ queryKind: "stats" }),
        outputFilePath: null,
        layerId: null,
        success: false,
        note: failure.message,
        writeKnowledge: false,
        featureCount: 0,
        fieldNames: [],
      });
      attachRememberedAudit(failure, ids);
      throw failure;
    }
  }

  /** 数值类能力的结果摘要。 */
  private async analyze(
    operationType: SpatialAuditOperation,
    layerId: string,
    otherLayerId: string | null,
    spatial: boolean,
    writeKnowledge: boolean,
    parameters: SpatialAuditParameters,
    run: (primary: MapCollection, secondary: MapCollection | null, planarUnitToMeter: number | null) => AnalysisNumbers,
  ): Promise<SpatialRunResult> {
    const started = Date.now();
    const inputNames: string[] = [];
    try {
      const input = this.requireCollection(layerId);
      inputNames.push(input.meta.layerName);
      let otherCollection: MapCollection | null = null;
      let otherMeta: LayerMeta | null = null;
      if (otherLayerId) {
        const other = this.requireCollection(otherLayerId);
        otherCollection = other.collection;
        otherMeta = other.meta;
        inputNames.push(other.meta.layerName);
      }
      const identities = [input.meta.crsIdentity, ...(otherMeta ? [otherMeta.crsIdentity] : [])];
      const crsInputs: readonly CrsLayerInput[] = [
        { identity: input.meta.crsIdentity, wkt: input.meta.crsWkt ?? null },
        ...(otherMeta ? [{ identity: otherMeta.crsIdentity, wkt: otherMeta.crsWkt ?? null }] : []),
      ];
      const plan = planCrsExecution(crsInputs, spatial, operationType);
      this.rejectCallerOverride(identities, plan);
      if (!plan.allow) {
        const denied = new SpatialOpError(userCrsMessage(plan.failureReason ?? ui("坐标系不允许这次运算。", "The CRS does not allow this operation.")));
        denied.code = "crs-refused";
        denied.crsFacts = crsFacts(plan, []);
        throw denied;
      }
      // 与 derive 同一套坐标系对齐：度量按坐标计算，先把输入对齐到工作 CRS。平面身份不变换，原坐标直算。
      const prepared = spatial
        ? prepareOperands(input.collection, otherCollection, otherMeta ? { identity: otherMeta.crsIdentity, wkt: otherMeta.crsWkt ?? null } : null, plan)
        : { primary: input.collection, secondary: otherCollection, steps: [] as CrsTransformStep[] };
      const numbers = run(prepared.primary, prepared.secondary, plan.planar ? plan.planarUnitToMeter ?? null : null);
      const facts = crsFacts(plan, prepared.steps);
      const durationMs = Math.max(0, Date.now() - started);
      const body = plan.coordinateUnits === true ? numbers.message.replaceAll(" 米", " 坐标单位") : numbers.message;
      const message = `${body}${coordinateUnitSuffix(plan)}耗时 ${durationMs}ms`;
      const ids = await this.remember({
        operationType,
        inputLayerNames: inputNames,
        parameters,
        outputFilePath: null,
        layerId: input.meta.layerId,
        success: true,
        note: body,
        writeKnowledge,
        featureCount: numbers.featureCount,
        fieldNames: numbers.fieldName ? [numbers.fieldName] : input.meta.fieldNames,
        durationMs,
      });
      return {
        ok: true,
        operationType,
        message,
        layer: null,
        featureCount: numbers.featureCount,
        fieldName: numbers.fieldName ?? null,
        minimum: numbers.minimum ?? null,
        maximum: numbers.maximum ?? null,
        mean: numbers.mean ?? null,
        sum: numbers.sum ?? null,
        durationMs,
        ...(typeof ids.auditRecordId === "string" ? { auditRecordId: ids.auditRecordId } : {}),
        ...(ids.auditAppendFailed ? { auditAppendFailed: true as const } : {}),
        crs: facts,
      };
    } catch (error) {
      const failure = asSpatialError(error);
      const ids = await this.remember({
        operationType,
        inputLayerNames: inputNames.map((name) => safeLayerName(name)),
        parameters,
        outputFilePath: null,
        layerId: null,
        success: false,
        note: failure.message,
        writeKnowledge: false,
        featureCount: 0,
        fieldNames: [],
      });
      attachRememberedAudit(failure, ids);
      throw failure;
    }
  }

 /* ---- 能力族：度量 / 几何转换 / 融合 / 属性 / 分幅 ---- */

  async area(layerId: string, writeKnowledge: boolean): Promise<SpatialRunResult> {
    return this.analyze("area", layerId, null, true, writeKnowledge, auditParameters({}), (primary, _secondary, planarUnit) => {
      const measured = measureAreas(primary, planarUnit);
      const stats = measured.stats;
      return stats
        ? {
            message: `面要素 ${stats.count} 个，面积合计 ${fmt(stats.sum)} 平方米，最小 ${fmt(stats.minimum)}、最大 ${fmt(stats.maximum)}、平均 ${fmt(stats.mean)}。${measured.notes.join("")}`,
            featureCount: stats.count,
            minimum: stats.minimum,
            maximum: stats.maximum,
            mean: stats.mean,
            sum: stats.sum,
          }
        : { message: `没有可统计的面要素。${measured.notes.join("")}`, featureCount: 0 };
    });
  }

  async length(layerId: string, writeKnowledge: boolean): Promise<SpatialRunResult> {
    return this.analyze("length", layerId, null, true, writeKnowledge, auditParameters({}), (primary, _secondary, planarUnit) => {
      const measured = measureLengths(primary, planarUnit);
      const line = measured.stats;
      const perimeter = measured.secondary;
      const parts: string[] = [];
      if (line) parts.push(`线要素 ${line.count} 个，长度合计 ${fmt(line.sum)} 米，平均 ${fmt(line.mean)} 米`);
      if (perimeter) parts.push(`面要素周长合计 ${fmt(perimeter.sum)} 米`);
      return {
        message: `${parts.length > 0 ? parts.join("；") : "没有可统计的线或面要素"}。${measured.notes.join("")}`,
        featureCount: line?.count ?? 0,
        ...(line ? { minimum: line.minimum, maximum: line.maximum, mean: line.mean, sum: line.sum } : {}),
      };
    });
  }

  async distanceStats(layerId: string, otherLayerId: string, writeKnowledge: boolean): Promise<SpatialRunResult> {
    return this.analyze("distance", layerId, otherLayerId, true, writeKnowledge, auditParameters({}), (primary, secondary, planarUnit) => {
      if (!secondary) throw new SpatialOpError("距离统计需要两个图层。");
      const { distances, unmatched } = nearestDistances(primary, secondary, planarUnit);
      const stats = statsOf(distances);
      const note = unmatched > 0 ? `${unmatched} 个要素没有可用距离。` : "";
      return stats
        ? {
            message: `最近距离（线和面按要素代表点）：最小 ${fmt(stats.minimum)} 米、最大 ${fmt(stats.maximum)} 米、平均 ${fmt(stats.mean)} 米。${note}`,
            featureCount: stats.count,
            minimum: stats.minimum,
            maximum: stats.maximum,
            mean: stats.mean,
            sum: stats.sum,
          }
        : { message: `没有可计算的要素距离。${note}`, featureCount: 0 };
    });
  }

  async nearest(layerId: string, otherLayerId: string, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    return this.derive("nearest", "最近距离标注", layerId, otherLayerId, writeKnowledge, auditParameters({}), (collection, other, planarUnit) => {
      if (!other) throw new SpatialOpError("最近距离需要两个图层。");
      return nearestFeatures(collection, other, planarUnit);
    }, outputName);
  }

  async convert(layerId: string, target: string, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    if (target !== "polygon" && target !== "line") {
      throw new SpatialOpError("几何转换的目标只能是 polygon（线转面）或 line（面转线）。");
    }
    return this.derive("convert", target === "polygon" ? "线转面" : "面转线", layerId, null, writeKnowledge, auditParameters({ target }), (collection) => (
      convertFeatures(collection, target)
    ), outputName);
  }

  async dissolve(layerId: string, groupField: string | null, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    const group = groupField && groupField.trim() !== "" ? requireFieldName(groupField, "融合") : null;
    return this.derive("dissolve", group ? `按 ${group} 融合` : "融合", layerId, null, writeKnowledge, auditParameters({ ...(group ? { groupField: group } : {}) }), (collection) => (
      dissolveFeatures(collection, group)
    ), outputName);
  }

  async merge(layerId: string, otherLayerId: string, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    return this.derive("merge", "图层合并", layerId, otherLayerId, writeKnowledge, auditParameters({}), (collection, other) => {
      if (!other) throw new SpatialOpError("合并需要两个图层。");
      return mergeFeatures(collection, other);
    }, outputName);
  }

  async simplify(layerId: string, tolerance: number, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    if (!Number.isFinite(tolerance) || tolerance <= 0) throw new SpatialOpError("简化容差必须是大于 0 的米数。");
    return this.derive("simplify", "几何简化", layerId, null, writeKnowledge, auditParameters({ tolerance }), (collection) => (
      simplifyFeatures(collection, tolerance)
    ), outputName);
  }

  async calculateField(layerId: string, expression: string, outputField: string, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    const field = requireFieldName(outputField, "字段计算");
    const formula = expression.trim();
    if (formula === "") throw new SpatialOpError("字段计算需要计算式。");
    return this.derive("field-calc", `计算字段 ${field}`, layerId, null, writeKnowledge, auditParameters({ fieldName: field, mapping: formula }), (collection) => (
      calculateFieldFeatures(collection, formula, field)
    ), outputName);
  }

  async erase(layerId: string, otherLayerId: string, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    return this.derive("erase", "擦除", layerId, otherLayerId, writeKnowledge, auditParameters({}), (collection, other) => {
      if (!other) throw new SpatialOpError("擦除需要两个图层。");
      return eraseFeatures(collection, other);
    }, outputName);
  }

  async unionOverlay(layerId: string, otherLayerId: string, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    return this.derive("union", "联合", layerId, otherLayerId, writeKnowledge, auditParameters({}), (collection, other) => {
      if (!other) throw new SpatialOpError("联合需要两个图层。");
      return unionOverlayFeatures(collection, other);
    }, outputName);
  }

  async spatialJoin(layerId: string, otherLayerId: string, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    return this.derive("spatial-join", "按位置连接", layerId, otherLayerId, writeKnowledge, auditParameters({}), (collection, other) => {
      if (!other) throw new SpatialOpError("按位置连接需要点图层和面图层。");
      return spatialJoinLocationFeatures(collection, other);
    }, outputName);
  }

  async quadtree(layerId: string, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    return this.derive("quadtree", "四叉树", layerId, null, writeKnowledge, auditParameters({}), (collection) => quadtreeFeatures(collection), outputName);
  }

  async kernelDensity(layerId: string, bandwidth: number, cellSize: number, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    const measure = this.measureOf(this.requireCollection(layerId).meta);
    return this.derive("kernel-density", "核密度", layerId, null, writeKnowledge, auditParameters({ distance: bandwidth, tolerance: cellSize }), (collection) => (
      kernelDensityFeatures(collection, bandwidth, cellSize, measure)
    ), outputName);
  }

  async aggregateGrid(layerId: string, cellSize: number, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    return this.derive("aggregate-grid", "格网聚合", layerId, null, writeKnowledge, auditParameters({ tolerance: cellSize }), (collection) => (
      aggregateGridFeatures(collection, cellSize)
    ), outputName);
  }

  async snapToNetwork(layerId: string, otherLayerId: string, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    const points = this.requireCollection(layerId);
    this.requireSameCrs("点落到线", points.meta, this.requireCollection(otherLayerId).meta);
    const measure = this.measureOf(points.meta);
    return this.derive("network-snap", "点落到线", layerId, otherLayerId, writeKnowledge, auditParameters({}), (collection, other) => {
      if (!other) throw new SpatialOpError("点落到线需要点图层和线图层。");
      return snapToNetworkFeatures(collection, other, measure);
    }, outputName);
  }

  async networkDistance(layerId: string, otherLayerId: string, lineLayerId: string, writeKnowledge: boolean): Promise<SpatialRunResult> {
    const origins = this.requireCollection(layerId);
    const destinations = this.requireCollection(otherLayerId);
    const lines = this.requireCollection(lineLayerId);
    this.requireSameCrs("沿路距离", origins.meta, destinations.meta, lines.meta);
    const measure = this.measureOf(lines.meta);
    return this.analyze("network-distance", layerId, otherLayerId, false, writeKnowledge, auditParameters({}), () => {
      const stats = networkDistanceStats(origins.collection, destinations.collection, lines.collection, measure);
      return {
        message: `每个起点到最近终点的沿路距离：最小 ${stats.minimum.toFixed(2)}、最大 ${stats.maximum.toFixed(2)}、平均 ${stats.mean.toFixed(2)}，单位是${measureUnit(measure)}。`,
        featureCount: stats.count,
        minimum: stats.minimum,
        maximum: stats.maximum,
        mean: stats.mean,
      };
    });
  }

  async serviceArea(layerId: string, lineLayerId: string, distance: number, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    const lines = this.requireCollection(lineLayerId);
    this.requireSameCrs("服务范围", this.requireCollection(layerId).meta, lines.meta);
    const measure = this.measureOf(lines.meta);
    return this.derive("service-area", "服务范围", layerId, null, writeKnowledge, auditParameters({ distance }), (collection) => (
      serviceAreaFeatures(collection, lines.collection, distance, measure)
    ), outputName);
  }

  /** Getis-Ord Gi* 热点。给了线图层按路网距离定邻居，否则按直线距离。 */
  async hotspot(layerId: string, fieldName: string, distance: number, lineLayerId: string | null, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    const field = requireFieldName(fieldName, "热点分析");
    if (!(distance > 0)) throw new SpatialOpError("热点的邻域距离必须大于 0。");
    const points = this.requireCollection(layerId);
    const lines = lineLayerId ? this.requireCollection(lineLayerId) : null;
    if (lines) this.requireSameCrs("热点分析", points.meta, lines.meta);
    const measure = this.measureOf(points.meta);
    return this.derive("hotspot", lines ? "网络热点" : "热点", layerId, null, writeKnowledge, auditParameters({ fieldName: field, distance, ...(lines ? { target: "network" } : {}) }), (collection) => (
      lines
        ? networkHotspotFeatures(collection, lines.collection, field, distance, measure)
        : euclideanHotspotFeatures(collection, field, distance, measure)
    ), outputName);
  }

  /** 地理加权回归。fieldName 是因变量，predictors 是逗号分隔的自变量。 */
  async gwr(
    layerId: string,
    fieldName: string,
    predictors: string,
    kernel: string | null,
    adaptive: boolean,
    bandwidth: number | null,
    writeKnowledge: boolean,
    outputName: string | null = null,
  ): Promise<SpatialRunResult> {
    const field = requireFieldName(fieldName, "地理加权回归");
    const names = predictors.split(/[,，]/).map((name) => name.trim()).filter((name) => name !== "");
    if (names.length === 0 || names.length > 5) throw new SpatialOpError("地理加权回归需要 1 到 5 个自变量。");
    for (const name of names) requireFieldName(name, "地理加权回归");
    if (names.includes(field)) throw new SpatialOpError("因变量不能同时是自变量。");
    const shape = (kernel ?? "bisquare").trim().toLowerCase() || "bisquare";
    if (shape !== "gaussian" && shape !== "bisquare") throw new SpatialOpError("核函数只支持 gaussian、bisquare。");
    if (bandwidth !== null && !(bandwidth > 0)) throw new SpatialOpError("带宽必须大于 0。");
    const measure = this.measureOf(this.requireCollection(layerId).meta);
    return this.derive("gwr", "地理加权回归", layerId, null, writeKnowledge, auditParameters({
      fieldName: field,
      mapping: names.join(","),
      target: `${shape}${adaptive ? "-adaptive" : "-fixed"}`,
      ...(bandwidth !== null ? { distance: bandwidth } : {}),
    }), (collection) => gwrFeatures(collection, field, names, shape, adaptive, bandwidth, measure), outputName);
  }

  /** 双约束重力模型的 OD 流量。起点图层带产生量字段，终点图层带吸引量字段。 */
  async odFlow(
    layerId: string,
    otherLayerId: string,
    fieldName: string,
    otherFieldName: string,
    lineLayerId: string | null,
    deterrence: string | null,
    beta: number | null,
    targetMean: number | null,
    writeKnowledge: boolean,
    outputName: string | null = null,
  ): Promise<SpatialRunResult> {
    const production = requireFieldName(fieldName, "OD 流量");
    const attraction = requireFieldName(otherFieldName, "OD 流量");
    const form = (deterrence ?? "exp").trim().toLowerCase() || "exp";
    if (form !== "exp" && form !== "power") throw new SpatialOpError("距离衰减只支持 exp、power。");
    if ((beta === null) === (targetMean === null)) throw new SpatialOpError("β 和目标平均距离要给且只给一个。");
    if (beta !== null && !(beta >= 0)) throw new SpatialOpError("β 必须不小于 0。");
    if (targetMean !== null && !(targetMean > 0)) throw new SpatialOpError("目标平均距离必须大于 0。");
    const origins = this.requireCollection(layerId);
    const destinations = this.requireCollection(otherLayerId);
    const lines = lineLayerId ? this.requireCollection(lineLayerId) : null;
    this.requireSameCrs("OD 流量", origins.meta, destinations.meta, ...(lines ? [lines.meta] : []));
    const measure = this.measureOf(origins.meta);
    return this.derive("od-flow", "OD 流量", layerId, otherLayerId, writeKnowledge, auditParameters({
      fieldName: production,
      groupField: attraction,
      target: `${form}${lines ? "-network" : ""}`,
      ...(beta !== null ? { distance: beta } : {}),
      ...(targetMean !== null ? { tolerance: targetMean } : {}),
    }), (collection, other) => {
      if (!other) throw new SpatialOpError("OD 流量需要起点和终点两个图层。");
      return odFlowResult(collection, other, production, attraction, lines?.collection ?? null, form, beta, targetMean, measure);
    }, outputName);
  }

  /** k 匿名四叉树隐匿。输出区域面和计数，不输出原始点。 */
  async kAnonymize(layerId: string, k: number, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    if (!Number.isInteger(k) || k < 2) throw new SpatialOpError("k 必须是不小于 2 的整数。");
    return this.derive("k-anonymity", `k=${k} 匿名`, layerId, null, writeKnowledge, auditParameters({ limit: k }), (collection) => kAnonymityFeatures(collection, k), outputName);
  }

  /** 差分隐私格网计数。otherLayerId 是统计格面图层。 */
  async dpGrid(layerId: string, otherLayerId: string, epsilon: number, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    if (!(epsilon > 0) || !Number.isFinite(epsilon)) throw new SpatialOpError("ε 必须是大于 0 的数。");
    this.requireSameCrs("差分隐私计数", this.requireCollection(layerId).meta, this.requireCollection(otherLayerId).meta);
    return this.derive("dp-grid", "差分隐私计数", layerId, otherLayerId, writeKnowledge, auditParameters({ tolerance: epsilon }), (collection, other) => {
      if (!other) throw new SpatialOpError("差分隐私计数需要点图层和统计格面图层。");
      return dpGridFeatures(collection, other, epsilon);
    }, outputName);
  }

  async chart(layerId: string, fieldName: string, writeKnowledge: boolean): Promise<SpatialRunResult> {
    const field = requireFieldName(fieldName, "统计图");
    return this.analyze("chart", layerId, null, false, writeKnowledge, auditParameters({ fieldName: field }), (primary) => {
      const bins = chartBins(primary, field);
      return {
        message: bins.map((bin) => `${bin.label}: ${bin.count}`).join("；"),
        featureCount: bins.reduce((total, bin) => total + bin.count, 0),
        fieldName: field,
      };
    });
  }

  async joinAttributes(layerId: string, otherLayerId: string, fieldName: string, otherFieldName: string, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    const left = requireFieldName(fieldName, "属性连接");
    const right = requireFieldName(otherFieldName, "属性连接");
    return this.derive("join", "属性连接", layerId, otherLayerId, writeKnowledge, auditParameters({ fieldName: left, groupField: right }), (collection, other) => {
      if (!other) throw new SpatialOpError("属性连接需要两个图层。");
      return joinAttributeFeatures(collection, other, left, right);
    }, outputName);
  }

  async groupStats(layerId: string, groupField: string, fieldName: string, writeKnowledge: boolean): Promise<SpatialRunResult> {
    const group = requireFieldName(groupField, "分组统计");
    const field = requireFieldName(fieldName, "分组统计");
    return this.analyze("group-stats", layerId, null, false, writeKnowledge, auditParameters({ groupField: group, fieldName: field }), (primary) => {
      const { rows, truncated } = groupStatsFeatures(primary, group, field);
      const lines = rows.map((row) => `${row.group}：${row.count} 个，合计 ${fmt(row.sum)}，最小 ${fmt(row.minimum)}，平均 ${fmt(row.mean)}`);
      return {
        message: rows.length === 0
          ? "字段没有可统计的数值。"
          : `${lines.join("；")}${truncated ? "（分组超过 50 个，其余省略）" : ""}`,
        featureCount: rows.reduce((total, row) => total + row.count, 0),
        fieldName: field,
      };
    });
  }

  async reclassify(layerId: string, fieldName: string, mappingText: string, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    const field = requireFieldName(fieldName, "重分类");
    const mapping = parseReclassifyMapping(mappingText);
    return this.derive("reclassify", `字段 ${field} 重分类`, layerId, null, writeKnowledge, auditParameters({ fieldName: field, mapping: mappingText }), (collection) => (
      reclassifyFeatures(collection, field, mapping)
    ), outputName);
  }

  async qualityCheck(layerId: string, writeKnowledge: boolean): Promise<SpatialRunResult> {
    return this.analyze("quality-check", layerId, null, false, writeKnowledge, auditParameters({}), (primary) => {
      const { fields, fieldCount } = qualityCheckFeatures(primary);
      const broken = new Set(validateCollection(primary).issues.filter((issue) => isUnusableIssue(issue)).map((issue) => issue.featureIndex));
      const lines = fields.slice(0, 12).map((field) => {
        const range = field.numericMinimum !== null ? `、数值 ${fmt(field.numericMinimum)}~${fmt(field.numericMaximum ?? field.numericMinimum)}` : "";
        return `${field.fieldName}：空值 ${field.nullCount}、空串 ${field.emptyCount}、去重 ${field.distinct}${field.distinctCapped ? "+" : ""}${range}`;
      });
      return {
        message: `字段 ${fieldCount} 个（检查前 30 个），几何无效要素 ${broken.size} 个。${lines.join("；")}${fields.length > 12 ? "（其余字段省略）" : ""}`,
        featureCount: primary.features.length,
      };
    });
  }

  async splitGrid(layerId: string, columns: number, rows: number, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    return this.derive("split-grid", `分幅 ${columns}×${rows}`, layerId, null, writeKnowledge, auditParameters({ columns, rows }), (collection) => (
      splitGridFeatures(collection, columns, rows)
    ), outputName);
  }

 /* ---- 能力族：分割 / 空间聚合 / 距离矩阵 / 精确最近 ---- */

  async splitLine(layerId: string, otherLayerId: string, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    return this.derive("split-line", "点分割线", layerId, otherLayerId, writeKnowledge, auditParameters({}), (collection, other) => {
      if (!other) throw new SpatialOpError("点分割线需要两个图层。");
      return splitLineAtPoints(collection, other);
    }, outputName);
  }

  async explode(layerId: string, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    return this.derive("explode", "多部件拆分", layerId, null, writeKnowledge, auditParameters({}), (collection) => (
      explodeParts(collection)
    ), outputName);
  }

  async vertices(layerId: string, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    return this.derive("vertices", "折点转点", layerId, null, writeKnowledge, auditParameters({}), (collection) => (
      verticesToPoints(collection)
    ), outputName);
  }

  async lineIntersect(layerId: string, otherLayerId: string | null, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    return this.derive("line-intersect", "线交点", layerId, otherLayerId, writeKnowledge, auditParameters({}), (collection, other) => (
      lineIntersectFeatures(collection, other)
    ), outputName);
  }

  async transform(
    layerId: string,
    kind: string,
    distance: number | null,
    bearing: number | null,
    angle: number | null,
    factor: number | null,
    writeKnowledge: boolean,
    outputName: string | null = null,
  ): Promise<SpatialRunResult> {
    if (kind !== "translate" && kind !== "rotate" && kind !== "scale") {
      throw new SpatialOpError("变换只能是 translate（平移）、rotate（旋转）或 scale（缩放）。");
    }
    const identity = this.requireCollection(layerId).meta.crsIdentity;
    const label = kind === "translate" ? "平移" : kind === "rotate" ? "旋转" : "缩放";
    return this.derive("transform", label, layerId, null, writeKnowledge, auditParameters({ target: kind }), (collection, _other, planarUnit) => (
      transformFeatures(collection, {
        kind,
        distance,
        bearing,
        angle,
        factor,
        distanceMode: distanceModeOf(identity.kind, identity.kind === "known" ? identity.epsg : null, planarUnit),
        unitToMeter: typeof planarUnit === "number" ? planarUnit : null,
      })
    ), outputName);
  }

  async nearestOnLine(layerId: string, otherLayerId: string, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    const identity = this.requireCollection(layerId).meta.crsIdentity;
    return this.derive("nearest-on-line", "垂足", layerId, otherLayerId, writeKnowledge, auditParameters({}), (collection, other, planarUnit) => {
      if (!other) throw new SpatialOpError("垂足需要点图层和线图层。");
      const mode = distanceModeOf(identity.kind, identity.kind === "known" ? identity.epsg : null, planarUnit);
      return nearestOnLineFeatures(collection, other, mode, typeof planarUnit === "number" ? planarUnit : null);
    }, outputName);
  }

  async grid(layerId: string, cellSize: number, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    const identity = this.requireCollection(layerId).meta.crsIdentity;
    return this.derive("grid", "矩形格网", layerId, null, writeKnowledge, auditParameters({ tolerance: cellSize }), (collection, _other, planarUnit) => (
      gridFeatures(collection, cellSize, distanceModeOf(identity.kind, identity.kind === "known" ? identity.epsg : null, planarUnit), typeof planarUnit === "number" ? planarUnit : null)
    ), outputName);
  }

  async splitPolygon(layerId: string, otherLayerId: string, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    return this.derive("split-polygon", "线分割面", layerId, otherLayerId, writeKnowledge, auditParameters({}), (collection, other) => {
      if (!other) throw new SpatialOpError("线分割面需要两个图层。");
      return splitPolygonByLine(collection, other);
    }, outputName);
  }

  /** 空间聚合：输出面图层（_count/_sum/_mean）+ 摘要行。 */
  async spatialAggregate(layerId: string, otherLayerId: string, fieldName: string | null, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    const field = fieldName && fieldName.trim() !== "" ? requireFieldName(fieldName, "空间聚合") : null;
    const aggregateRows: SpatialAggregateRow[] = [];
    const outcome = await this.derive("spatial-aggregate", field ? `空间聚合（${field}）` : "空间聚合", layerId, otherLayerId, writeKnowledge, auditParameters({ ...(field ? { fieldName: field } : {}) }), (collection, other) => {
      if (!other) throw new SpatialOpError("空间聚合需要两个图层。");
      const { result, rows } = spatialAggregate(collection, other, field);
      aggregateRows.push(...rows);
      return result;
    }, outputName);
    if (outcome.ok && aggregateRows.length > 0) {
      const summary = aggregateRows
        .slice(0, 20)
        .map((row) => `${row.group}：点数 ${row.count}${row.mean !== null ? `，均值 ${fmt(row.mean)}` : ""}`)
        .join("；");
      return { ...outcome, message: `${outcome.message} 聚合摘要：${summary}${aggregateRows.length > 20 ? "…" : ""}` };
    }
    return outcome;
  }

  /** 距离矩阵：A×B 逐对最近距离（米），规模超过上限拒绝。 */
  async distanceMatrixStats(layerId: string, otherLayerId: string, limit: number, writeKnowledge: boolean): Promise<SpatialRunResult> {
    return this.analyze("distance-matrix", layerId, otherLayerId, true, writeKnowledge, auditParameters({ limit }), (primary, secondary, planarUnit) => {
      if (!secondary) throw new SpatialOpError("距离矩阵需要两个图层。");
      const { matrix, unmatched } = distanceMatrix(primary, secondary, limit, planarUnit);
      const flat: number[] = [];
      for (const row of matrix) {
        for (const value of row) {
          if (Number.isFinite(value)) flat.push(value);
        }
      }
      const stats = statsOf(flat);
      const note = unmatched > 0 ? `${unmatched} 个要素没有可用距离。` : "";
      return stats
        ? {
            message: `距离矩阵 ${matrix.length}×${matrix[0]?.length ?? 0}，最近距离最小 ${fmt(stats.minimum)} 米、最大 ${fmt(stats.maximum)} 米、平均 ${fmt(stats.mean)} 米。${note}`,
            featureCount: stats.count,
            minimum: stats.minimum,
            maximum: stats.maximum,
            mean: stats.mean,
            sum: stats.sum,
          }
        : { message: `没有可计算的距离矩阵。${note}`, featureCount: 0 };
    });
  }

  /** 精确最近距离：A 每要素按全部顶点采样到 B 的最短距离（米），优于代表点近似。 */
  async nearestExact(layerId: string, otherLayerId: string, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    return this.derive("nearest-exact", "精确最近距离标注", layerId, otherLayerId, writeKnowledge, auditParameters({}), (collection, other, planarUnit) => {
      if (!other) throw new SpatialOpError("精确最近距离需要两个图层。");
      return nearestVertexFeatures(collection, other, planarUnit);
    }, outputName);
  }

 /* ---- 能力族：几何构造 / 方位 ---- */

  async voronoi(layerId: string, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    return this.derive("voronoi", "Voronoi 剖分", layerId, null, writeKnowledge, auditParameters({}), (collection) => (
      voronoiFeatures(collection)
    ), outputName);
  }

  async convexHull(layerId: string, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    return this.derive("convex-hull", "凸包", layerId, null, writeKnowledge, auditParameters({}), (collection) => (
      convexHullFeatures(collection)
    ), outputName);
  }

  async minBBox(layerId: string, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    return this.derive("min-bbox", "最小外接矩形", layerId, null, writeKnowledge, auditParameters({}), (collection) => (
      minBBoxFeatures(collection)
    ), outputName);
  }

  async centroid(layerId: string, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    return this.derive("centroid", "质心", layerId, null, writeKnowledge, auditParameters({}), (collection) => (
      centroidFeatures(collection)
    ), outputName);
  }

  async bearing(layerId: string, otherLayerId: string, writeKnowledge: boolean, outputName: string | null = null): Promise<SpatialRunResult> {
    return this.derive("bearing", "方位角标注", layerId, otherLayerId, writeKnowledge, auditParameters({}), (collection, other) => {
      if (!other) throw new SpatialOpError("方位角需要两个图层。");
      return bearingFeatures(collection, other);
    }, outputName);
  }

  /**
   * 坐标值报表：把要素坐标写成本地 CSV 文件（与 GeoJSON 导出同模式）。
   * 坐标只进本地文件，永不出 AI 通道；结果摘要只报行数。
   */
  async exportCoordinates(layerId: string, destinationPath: string): Promise<SpatialRunResult> {
    const meta = this.catalog.get(layerId);
    if (!meta) throw new SpatialOpError("找不到要导出的图层。");
    try {
      const input = this.requireCollection(layerId);
      const rows: string[] = ["fid,index,x,y"];
      let count = 0;
      for (let fid = 0; fid < input.collection.features.length; fid += 1) {
        const feature = input.collection.features[fid];
        const coordinates = feature?.geometry ? (feature.geometry as { coordinates?: unknown }).coordinates : undefined;
        const visit = (value: unknown): void => {
          if (Array.isArray(value)) {
            const x = value[0];
            const y = value[1];
            if (typeof x === "number" && typeof y === "number") {
              rows.push(`${fid},${count},${x},${y}`);
              count += 1;
              return;
            }
            for (const item of value) visit(item);
          }
        };
        visit(coordinates);
      }
      const directory = dirname(resolve(destinationPath));
      await mkdir(directory, { recursive: true });
      await writeFile(resolve(destinationPath), `${rows.join("\n")}\n`, { encoding: "utf8" });
      const message = `已导出坐标表，共 ${count} 行坐标（本地文件，不含在对话中）。`;
      await this.remember({
        operationType: "export",
        inputLayerNames: [meta.layerName],
        parameters: auditParameters({}),
        outputFilePath: meta.outputFilePath,
        layerId: meta.layerId,
        success: true,
        note: message,
        writeKnowledge: false,
        featureCount: meta.featureCount,
        fieldNames: meta.fieldNames,
      });
      return {
        ok: true,
        operationType: "export",
        message,
        layer: null,
        featureCount: meta.featureCount,
        fieldName: null,
        minimum: null,
        maximum: null,
        mean: null,
      };
    } catch (error) {
      throw asSpatialError(error);
    }
  }

  async exportLayer(layerId: string, destinationPath: string): Promise<SpatialRunResult> {
    const meta = this.catalog.get(layerId);
    if (!meta) throw new SpatialOpError("找不到要导出的图层。");
    try {
      const outputFilePath = await this.catalog.exportTo(layerId, destinationPath);
      const message = "已导出为新的 GeoJSON，没有覆盖源文件。";
      await this.remember({
        operationType: "export",
        inputLayerNames: [meta.layerName],
        parameters: auditParameters({}),
        outputFilePath,
        layerId: meta.layerId,
        success: true,
        note: message,
        writeKnowledge: false,
        featureCount: meta.featureCount,
        fieldNames: meta.fieldNames,
      });
      return {
        ok: true,
        operationType: "export",
        message,
        layer: null,
        featureCount: meta.featureCount,
        fieldName: null,
        minimum: null,
        maximum: null,
        mean: null,
      };
    } catch (error) {
      const failure = asSpatialError(error);
      const ids = await this.remember({
        operationType: "export",
        inputLayerNames: [meta.layerName],
        parameters: auditParameters({}),
        outputFilePath: null,
        layerId: meta.layerId,
        success: false,
        note: failure.message,
        writeKnowledge: false,
        featureCount: 0,
        fieldNames: [],
      });
      attachRememberedAudit(failure, ids);
      throw failure;
    }
  }

  private async derive(
    operationType: SpatialAuditOperation,
    action: string,
    layerId: string,
    otherLayerId: string | null,
    writeKnowledge: boolean,
    parameters: SpatialAuditParameters,
    run: (collection: MapCollection, other: MapCollection | null, planarUnitToMeter: number | null) => { collection: MapCollection; skipped: number; notes: readonly string[]; corrupt: boolean },
    outputName: string | null = null,
  ): Promise<SpatialRunResult> {
    const started = Date.now();
    const inputNames: string[] = [];
    let issues: GeometryIssue[] = [];
    try {
      const input = this.requireCollection(layerId);
      inputNames.push(input.meta.layerName);
      let otherCollection: MapCollection | null = null;
      let otherMeta: LayerMeta | null = null;
      if (otherLayerId) {
        const other = this.requireCollection(otherLayerId);
        otherCollection = other.collection;
        otherMeta = other.meta;
        inputNames.push(other.meta.layerName);
      }
      const identities = [input.meta.crsIdentity, ...(otherMeta ? [otherMeta.crsIdentity] : [])];
      const crsInputs: readonly CrsLayerInput[] = [
        { identity: input.meta.crsIdentity, wkt: input.meta.crsWkt ?? null },
        ...(otherMeta ? [{ identity: otherMeta.crsIdentity, wkt: otherMeta.crsWkt ?? null }] : []),
      ];
      const spatial = requiresSpatialCrs(operationType, parameters.queryKind);
      const plan = planCrsExecution(crsInputs, spatial, operationType);
      this.rejectCallerOverride(identities, plan);
      if (!plan.allow) {
        const denied = new SpatialOpError(userCrsMessage(plan.failureReason ?? ui("坐标系不允许这次空间运算。", "The CRS does not allow this spatial operation.")));
        denied.code = "crs-refused";
        denied.crsFacts = crsFacts(plan, []);
        throw denied;
      }
      const crsTokens = identities.map(cacheCrsToken);
      issues = labelIssues(input.meta.layerName, validateCollection(input.collection).issues);
      if (otherMeta && otherCollection) {
        issues = [...issues, ...labelIssues(otherMeta.layerName, validateCollection(otherCollection).issues)];
      }
      // 优先用入库时算好的几何哈希；旧图层没有时现算（结果一致）。
      const primaryHash = input.meta.geometryHash ?? geometryContentHash(input.collection);
      const secondaryHash = otherMeta
        ? (otherMeta.geometryHash ?? (otherCollection ? geometryContentHash(otherCollection) : ""))
        : "";
      const geometryHash = `${primaryHash}${secondaryHash}`;
 // 缓存键带上全部标量参数（含 能力参数），参数不同不得互相命中。
      const paramRecord: Record<string, string | number | boolean> = {};
      for (const [key, value] of Object.entries(parameters)) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") paramRecord[key] = value;
      }
      if (outputName) paramRecord.outputName = outputName;
      const inputLayerIds = [input.meta.layerId, ...(otherMeta ? [otherMeta.layerId] : [])];
      const cacheKey = spatialCacheKey(operationType, inputLayerIds, paramRecord, geometryHash, crsTokens);
      const cachedRef = await this.cache.get(cacheKey);
      const cachedMeta = cachedRef ? this.catalog.get(cachedRef.layerId) : null;
      if (cachedRef && cachedMeta) {
        const durationMs = Math.max(0, Date.now() - started);
        const message = `${action}耗时 ${durationMs}ms${coordinateUnitSuffix(plan)}`;
        // 返回目录里的图层名。缓存文件里的名字只是落盘事实，命中时不拿它覆盖目录。
        const ids = await this.remember({
          operationType,
          inputLayerNames: inputNames,
          parameters,
          outputFilePath: cachedMeta.outputFilePath,
          layerId: cachedMeta.layerId,
          success: true,
          note: message,
          writeKnowledge,
          featureCount: cachedMeta.featureCount,
          fieldNames: cachedMeta.fieldNames,
          durationMs,
        });
        return withIssues({
          ok: true as const,
          operationType,
          message,
          layer: {
            layerId: cachedMeta.layerId,
            layerName: cachedMeta.layerName,
            featureCount: cachedMeta.featureCount,
            fieldNames: cachedMeta.fieldNames,
            mapUrl: `/api/map/layers/${cachedMeta.layerId}/geojson`,
            message,
          },
          featureCount: cachedMeta.featureCount,
          fieldName: null,
          minimum: null,
          maximum: null,
          mean: null,
          durationMs,
          ragEntryId: ids.ragEntryId,
          ...(typeof ids.auditRecordId === "string" ? { auditRecordId: ids.auditRecordId } : {}),
          ...(ids.auditAppendFailed ? { auditAppendFailed: true as const } : {}),
          cacheKey,
          cached: true,
          // 命中路径本次没有做任何变换或投影：如实记空，不按单位推断 aeqd（那是 miss 路径的事实）。
          crs: crsFacts(plan, []),
        }, issues);
      }
      const usable = readyForTurf(input.collection);
      const usableOther = otherCollection ? readyForTurf(otherCollection) : null;
      if (usable.features.length === 0) throw new SpatialOpError("图层几何类型无法运算，已在调用前停止。");
      if (otherLayerId && (!usableOther || usableOther.features.length === 0)) {
        throw new SpatialOpError("对照图层几何类型无法运算，已在调用前停止。");
      }
      const prepared = prepareOperands(usable, usableOther, otherMeta ? { identity: otherMeta.crsIdentity, wkt: otherMeta.crsWkt ?? null } : null, plan);
      const result = run(prepared.primary, prepared.secondary, plan.planar ? plan.planarUnitToMeter ?? null : null);
      if (result.corrupt) throw new SpatialOpError("图层几何无效或已损坏，没有生成结果。");
      const steps = [...prepared.steps];
      let stored = result.collection;
      if (plan.spatial && plan.targetEpsg !== null && plan.targetEpsg !== WORKING_EPSG && plan.targetDefinition !== null) {
        stored = transformViaDefinitions(stored, "EPSG:4326", plan.targetDefinition);
        steps.push({ from: `EPSG:${WORKING_EPSG}`, to: `EPSG:${plan.targetEpsg}`, purpose: "from-working" });
      }
      const bufferProjection = operationType === "buffer" && !plan.planar && typeof parameters.unit === "string" && parameters.unit !== "degrees" ? "aeqd" as const : undefined;
      const facts = crsFacts(plan, steps, bufferProjection);
      const durationMs = Math.max(0, Date.now() - started);
      const message = `${describeOp(action, result)} ${action}耗时 ${durationMs}ms${coordinateUnitSuffix(plan)}`;
      const sourcePaths = [...input.meta.sourcePaths, input.meta.outputFilePath];
      if (otherMeta) sourcePaths.push(...otherMeta.sourcePaths, otherMeta.outputFilePath);
      const requested = outputName ? safeLayerName(outputName) : "";
      const meta = await this.catalog.insert({
        layerName: requested !== "" && requested !== "未命名图层" ? requested : safeLayerName(`${input.meta.layerName}_${action}`),
        sourcePaths,
        collection: stored,
        crsLabel: crsLabelFor(plan.resultIdentity),
        crsIdentity: plan.resultIdentity,
        ...(input.meta.crsWkt !== undefined ? { crsWkt: input.meta.crsWkt } : {}),
        geometryHash: geometryContentHash(stored),
      });
      try {
        await this.cache.put(cacheKey, { layerId: meta.layerId, layerName: meta.layerName, inputLayerIds });
      } catch (cacheError) {
        let cleanupNote = "已撤下刚写入的结果图层。";
        try {
          const removed = await this.catalog.remove(meta.layerId);
          if (!removed) cleanupNote = "撤下刚写入的结果图层也失败了：图层仍在。";
        } catch (cleanupError) {
          cleanupNote = `撤下刚写入的结果图层也失败了：${errorText(cleanupError)}`;
        }
        throw new SpatialOpError(`结果缓存没有写入：${errorText(cacheError)} ${cleanupNote}`);
      }
      const layer = this.publish(meta, message);
      const ids = await this.remember({
        operationType,
        inputLayerNames: inputNames,
        parameters,
        outputFilePath: meta.outputFilePath,
        layerId: meta.layerId,
        success: true,
        note: `${action}耗时 ${durationMs}ms`,
        writeKnowledge,
        featureCount: meta.featureCount,
        fieldNames: meta.fieldNames,
        durationMs,
      });
      return withIssues({
        ok: true as const,
        operationType,
        message,
        layer,
        featureCount: meta.featureCount,
        fieldName: null,
        minimum: null,
        maximum: null,
        mean: null,
        durationMs,
        ragEntryId: ids.ragEntryId,
        ...(typeof ids.auditRecordId === "string" ? { auditRecordId: ids.auditRecordId } : {}),
        ...(ids.auditAppendFailed ? { auditAppendFailed: true as const } : {}),
        cacheKey,
        cached: false,
        crs: facts,
      }, issues);
    } catch (error) {
      const failure = asSpatialError(error);
      if (error instanceof SpatialOpError && error.crsFacts) failure.crsFacts = error.crsFacts;
      if (issues.length > 0) Object.assign(failure, { geometryIssues: issues.slice(0, 200) });
      const ids = await this.remember({
        operationType,
        inputLayerNames: inputNames.length > 0 ? inputNames : [safeLayerName(layerId)],
        parameters,
        outputFilePath: null,
        layerId: null,
        success: false,
        note: failure.message,
        writeKnowledge: false,
        featureCount: 0,
        fieldNames: [],
      });
      attachRememberedAudit(failure, ids);
      throw failure;
    }
  }
}

export interface SpatialStack {
  readonly service: SpatialService;
  readonly catalog: MapLayerCatalog;
  readonly audit: SpatialAuditLedger;
}

export async function openSpatialStack(options: SpatialStackOptions): Promise<SpatialStack> {
  const catalog = new MapLayerCatalog(options.layerDirectory);
  const audit = new SpatialAuditLedger(options.auditDirectory);
  await catalog.restore();
  await audit.load();
  return { service: new SpatialService(catalog, audit, options), catalog, audit };
}

/** 错误对象上挂的逐要素几何问题。没有时返回空数组。 */
export function geometryIssuesOf(error: unknown): readonly GeometryIssue[] {
  if (typeof error !== "object" || error === null || !("geometryIssues" in error)) return [];
  const value = (error as { geometryIssues?: unknown }).geometryIssues;
  return Array.isArray(value) ? (value as GeometryIssue[]) : [];
}
