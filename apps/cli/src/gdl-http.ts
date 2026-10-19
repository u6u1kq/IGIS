// SPDX-License-Identifier: Apache-2.0

import { mkdir, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import {
  GdlGuardError,
  GdlRuntimeError,
  GdlSummaryError,
  GdlSyntaxError,
  executeGdl,
  layerToGdl,
  layerToGdlSummary,
  parseGdl,
  parseGdlOrThrow,
  summarizeGdlProgram,
  validateLlmGdl,
} from "@igis/gdl";
import type { GdlHost, GdlLayerRef, GdlLayerSource, GdlLayerStatement, GdlProgram } from "@igis/gdl";
import type { ScheduledToolCall, ToolAdapterPort } from "@igis/llm-dispatch";
import { SpatialOpError, auditFailureFields, bufferRequestFromResolution, executeGisOperation, geometryIssuesOf, rawBufferInputFromGdl, recordNonSpatialOperation, resolveLayerRef, validateBufferOperation } from "@igis/spatial-ops";
import type { MapCollection, MapFeature, NonSpatialOperationKind, PublicMapLayer, SpatialStack } from "@igis/spatial-ops";
import type { GeometryIssue } from "@igis/surtgis";
import { publicStoreLayer } from "./map-http.js";

export interface GdlDeps {
  readonly spatial: SpatialStack;
  readonly gdlDirectory: string;
  readonly addRag: (input: { readonly title: string; readonly body: string; readonly layerNames: readonly string[]; readonly kind: "gis" }) => Promise<unknown>;
  /** 操作记录写到这个工作区。不传则用进程工作目录。 */
  readonly operationsRoot?: string;
  readonly registerWorkspaceLayers?: (conversationId: string, layerIds: readonly string[]) => Promise<void>;
  readonly inConversation?: <T>(conversationId: string, run: () => Promise<T>) => Promise<T>;
}

type StoreLayerView = ReturnType<typeof publicStoreLayer>;

/** 非空间状态变更的留痕：GDL 入口。 */
function auditGdlChange(
  deps: GdlDeps,
  body: {
    readonly kind: NonSpatialOperationKind;
    readonly action: string;
    readonly inputResources?: readonly string[];
    readonly outputResources?: readonly string[];
    readonly ok: boolean;
    readonly message?: string;
  },
): Promise<string> {
  return recordNonSpatialOperation({
    ...body,
    entry: "gdl",
    source: "local-user",
    aiOrigin: false,
    translationUsed: false,
    requestSource: "internal",
    ...(deps.operationsRoot !== undefined ? { root: deps.operationsRoot } : {}),
  });
}

interface ResolvedBufferLayer {
  readonly layerId: string;
  readonly layerName: string;
}

interface GdlRunOutcome {
  readonly layers: readonly StoreLayerView[];
  readonly summary: string;
  readonly geometryIssues: readonly GeometryIssue[];
  readonly steps: number;
  readonly indexed: boolean;
  /** 本次脚本里每次缓冲实际用到的输入图层。同名仍取最上层，这里把那个 id 写出来。 */
  readonly resolvedBuffers?: readonly ResolvedBufferLayer[];
  readonly resolvedLayerId?: string;
  readonly resolvedLayerName?: string;
  /** 这次脚本里实际执行的 GIS 操作。多步各有自己的 id。 */
  readonly operationIds?: readonly string[];
  readonly operationId?: string;
}

/** GDL 执行失败。带上已经生成的图层，页面可以照常挂到地图上。 */
class GdlRunFailure extends Error {
  constructor(
    readonly original: unknown,
    readonly layers: readonly StoreLayerView[],
    readonly geometryIssues: readonly GeometryIssue[],
    readonly resolvedBuffers: readonly ResolvedBufferLayer[] = [],
    readonly operationIds: readonly string[] = [],
  ) {
    super(original instanceof Error ? original.message : "GDL 执行失败。");
    this.name = "GdlRunFailure";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function operationFields(ids: readonly string[]): { readonly operationIds?: readonly string[]; readonly operationId?: string } {
  if (ids.length === 0) return {};
  const operationId = ids[ids.length - 1];
  return { operationIds: [...ids], ...(operationId ? { operationId } : {}) };
}

function bufferResolutionFields(layers: readonly ResolvedBufferLayer[]): {
  readonly resolvedBuffers?: readonly ResolvedBufferLayer[];
  readonly resolvedLayerId?: string;
  readonly resolvedLayerName?: string;
} {
  if (layers.length === 0) return {};
  const last = layers[layers.length - 1];
  if (!last) return {};
  return {
    resolvedBuffers: layers.map((item) => ({ layerId: item.layerId, layerName: item.layerName })),
    resolvedLayerId: last.layerId,
    resolvedLayerName: last.layerName,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const parts: string[] = [];
  let size = 0;
  // 流式解码：防止 TCP 分块切开 UTF-8 多字节序列（中文）。
  const decoder = new TextDecoder();
  for await (const chunk of request) {
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    size += text.length;
    if (size > 2 * 1024 * 1024) throw new SpatialOpError("请求太大，GDL 文本请控制在 1MB 以内。");
    parts.push(text);
  }
  parts.push(decoder.decode());
  const text = parts.join("");
  if (text.trim() === "") return {};
  return JSON.parse(text) as unknown;
}

/** GDL 的 CRS 语句常写裸数字（CRS 4326）：规范成 EPSG 形式，否则身份被判无效。 */
function normalizeGdlCrs(crs: string | null | undefined): string {
  if (typeof crs !== "string" || crs.trim() === "") return "未声明";
  const trimmed = crs.trim();
  if (/^\d{4,6}$/.test(trimmed)) return `EPSG:${trimmed}`;
  return trimmed;
}

function featureCollection(statement: GdlLayerStatement): MapCollection {
  const features: MapFeature[] = statement.features.map((feature) => ({
    type: "Feature",
    properties: { ...feature.attributes },
    geometry: feature.geometry,
  }));
  return { type: "FeatureCollection", features };
}

/** 把 STYLE order 放到指定位置。1 是最上层。 */
function placeOrder(current: readonly string[], entries: readonly { readonly layer: GdlLayerRef; readonly order: number }[]): string[] {
  const ids = new Set(entries.map((entry) => entry.layer.layerId));
  const rest = current.filter((id) => !ids.has(id));
  for (const entry of [...entries].sort((left, right) => left.order - right.order)) {
    rest.splice(Math.min(entry.order - 1, rest.length), 0, entry.layer.layerId);
  }
  return rest;
}

function layerSource(spatial: SpatialStack, layerId: string): GdlLayerSource {
  const store = spatial.catalog;
  const meta = store.get(layerId);
  const collection = store.collection(layerId);
  if (!meta || !collection) throw new SpatialOpError("找不到这个图层。");
  const position = store.order().indexOf(layerId);
  return {
    name: meta.layerName,
    geometryKind: meta.geometryKind,
    crsLabel: meta.crsLabel,
    style: store.style(layerId),
    order: position >= 0 ? position + 1 : null,
    features: collection.features,
  };
}

/**
 * keep() 只在宿主方法返回之后登记。
 * 插入已经落进图层库、但还没走到 keep() 就抛错的图层，失败载荷也要带上。这里不删除它们。
 */
function failureLayers(deps: GdlDeps, produced: readonly PublicMapLayer[], beforeIds: ReadonlySet<string>): StoreLayerView[] {
  const kept = produced.map((layer) => publicStoreLayer(deps.spatial, layer));
  const seen = new Set(kept.map((layer) => layer.layerId));
  const extras = deps.spatial.catalog.list().filter((meta) => !beforeIds.has(meta.layerId) && !seen.has(meta.layerId));
  return [
    ...kept,
    ...extras.map((meta) => publicStoreLayer(deps.spatial, {
      layerId: meta.layerId,
      layerName: meta.layerName,
      featureCount: meta.featureCount,
      fieldNames: meta.fieldNames,
    })),
  ];
}

/** runGdl 使用的宿主。缓冲在已解析身份上验证，再经操作边界调用 service.buffer。 */
function createGdlHost(
  deps: GdlDeps,
  produced: PublicMapLayer[],
  issues: GeometryIssue[],
  resolvedBuffers: ResolvedBufferLayer[],
  operationIds: string[],
  fromModel: boolean,
): GdlHost {
  const { service, catalog } = deps.spatial;
  const keep = (layer: PublicMapLayer | null, found: readonly GeometryIssue[] | undefined): GdlLayerRef => {
    if (!layer) throw new SpatialOpError("没有生成结果图层。");
    produced.push(layer);
    if (found) issues.push(...found);
    return { layerId: layer.layerId, layerName: layer.layerName };
  };
  return {
    resolveLayer(name) {
      const meta = catalog.findByName(name);
      return meta ? { layerId: meta.layerId, layerName: meta.layerName } : null;
    },
    async createLayer(statement) {
      const { order: _order, ...style } = statement.style;
      const created = await service.createLayer({
        layerName: statement.name,
        collection: featureCollection(statement),
        crsLabel: normalizeGdlCrs(statement.crs),
        expectedKind: statement.geometry === null || statement.geometry === "mixed" ? null : statement.geometry,
        style,
        sourceLabel: "gdl:文本",
        writeKnowledge: false,
      });
      return keep(created.layer, created.issues);
    },
    async buffer(input, distance, unit, output) {
      // executeGdl 已经用脚本作用域或 findByName（同名取最上层）解析过图层名。这里只记下那份身份，不再查找，也不改成 Ambiguous。
      resolvedBuffers.push({ layerId: input.layerId, layerName: input.layerName });
      const raw = rawBufferInputFromGdl({
        layerName: input.layerName,
        distance,
        unit,
        outputName: output,
      });
      const built = bufferRequestFromResolution(
        { layerId: input.layerId, layerName: input.layerName },
        raw.input.distance,
        raw.input.unit,
        raw.input.outputName,
      );
      if (!built.ok) throw new SpatialOpError("图层没有解析成唯一身份。");
      const validation = validateBufferOperation(built.request);
      if (!validation.ok) {
        const message = validation.errors.map((item) => item.message).join("");
        throw new SpatialOpError(message || "缓冲请求不合法。");
      }
      const outcome = await executeGisOperation(service, {
        entry: "gdl",
        operation: "buffer",
        ...(deps.operationsRoot !== undefined ? { root: deps.operationsRoot } : {}),
        ...(fromModel ? { source: "cloud-ai" as const, aiOrigin: true, translationUsed: true, dataBoundaryLevel: "L2" as const, requestSource: "cloud-ai" as const } : {}),
        policy: { writeKnowledge: false },
        sourceLayer: { layerId: input.layerId, layerName: input.layerName },
        distance: built.request.distance,
        unit: built.request.unit,
        outputName: built.request.outputName ?? output,
      });
      operationIds.push(outcome.operationId);
      if (!outcome.ok || !outcome.result) {
        const error = outcome.error instanceof Error ? outcome.error : new SpatialOpError("缓冲没有完成。");
        throw error;
      }
      return keep(outcome.result.layer, outcome.result.geometryIssues);
    },
    async intersect(input, other, output) {
      const outcome = await executeGisOperation(service, {
        entry: "gdl",
        operation: "intersect",
        ...(deps.operationsRoot !== undefined ? { root: deps.operationsRoot } : {}),
        ...(fromModel ? { source: "cloud-ai" as const, aiOrigin: true, translationUsed: true, dataBoundaryLevel: "L2" as const, requestSource: "cloud-ai" as const } : {}),
        policy: { writeKnowledge: false },
        layerId: input.layerId,
        layerName: input.layerName,
        otherLayerId: other.layerId,
        otherLayerName: other.layerName,
        outputName: output,
      });
      operationIds.push(outcome.operationId);
      if (!outcome.ok || !outcome.result) {
        const error = outcome.error instanceof Error ? outcome.error : new SpatialOpError("相交没有完成。");
        throw error;
      }
      return keep(outcome.result.layer, outcome.result.geometryIssues);
    },
    async clip(input, other, output) {
      const outcome = await executeGisOperation(service, {
        entry: "gdl",
        operation: "clip",
        ...(deps.operationsRoot !== undefined ? { root: deps.operationsRoot } : {}),
        ...(fromModel ? { source: "cloud-ai" as const, aiOrigin: true, translationUsed: true, dataBoundaryLevel: "L2" as const, requestSource: "cloud-ai" as const } : {}),
        policy: { writeKnowledge: false },
        layerId: input.layerId,
        layerName: input.layerName,
        otherLayerId: other.layerId,
        otherLayerName: other.layerName,
        outputName: output,
      });
      operationIds.push(outcome.operationId);
      if (!outcome.ok || !outcome.result) {
        const error = outcome.error instanceof Error ? outcome.error : new SpatialOpError("裁剪没有完成。");
        throw error;
      }
      return keep(outcome.result.layer, outcome.result.geometryIssues);
    },
    async setStyle(layer, style) {
      await catalog.updateStyle(layer.layerId, style);
    },
    async query(input, filter, output) {
      const outcome = await executeGisOperation(service, {
        entry: "gdl",
        operation: "query",
        ...(deps.operationsRoot !== undefined ? { root: deps.operationsRoot } : {}),
        ...(fromModel ? { source: "cloud-ai" as const, aiOrigin: true, translationUsed: true, dataBoundaryLevel: "L2" as const, requestSource: "cloud-ai" as const } : {}),
        policy: { writeKnowledge: false },
        layerId: input.layerId,
        layerName: input.layerName,
        queryKind: "attribute",
        attributeFilter: filter,
      });
      operationIds.push(outcome.operationId);
      if (!outcome.ok || !outcome.result) {
        const error = outcome.error instanceof Error ? outcome.error : new SpatialOpError("查询没有完成。");
        throw error;
      }
      return keep(outcome.result.layer, outcome.result.geometryIssues);
    },
    async stats(input, field) {
      const outcome = await executeGisOperation(service, {
        entry: "gdl",
        operation: "stats",
        ...(deps.operationsRoot !== undefined ? { root: deps.operationsRoot } : {}),
        ...(fromModel ? { source: "cloud-ai" as const, aiOrigin: true, translationUsed: true, dataBoundaryLevel: "L2" as const, requestSource: "cloud-ai" as const } : {}),
        policy: { writeKnowledge: false },
        layerId: input.layerId,
        layerName: input.layerName,
        fieldName: field,
      });
      operationIds.push(outcome.operationId);
      if (!outcome.ok || !outcome.result) {
        const error = outcome.error instanceof Error ? outcome.error : new SpatialOpError("统计没有完成。");
        throw error;
      }
      return outcome.result.message;
    },
    async measure(kind, input, other) {
      const operation = kind === "area" ? "area" : kind === "length" ? "length" : "distance";
      const outcome = await executeGisOperation(service, {
        entry: "gdl",
        operation,
        ...(deps.operationsRoot !== undefined ? { root: deps.operationsRoot } : {}),
        ...(fromModel ? { source: "cloud-ai" as const, aiOrigin: true, translationUsed: true, dataBoundaryLevel: "L2" as const, requestSource: "cloud-ai" as const } : {}),
        policy: { writeKnowledge: false },
        layerId: input.layerId,
        layerName: input.layerName,
        ...(other ? { otherLayerId: other.layerId, otherLayerName: other.layerName } : {}),
      });
      operationIds.push(outcome.operationId);
      if (!outcome.ok || !outcome.result) {
        const error = outcome.error instanceof Error ? outcome.error : new SpatialOpError("度量没有完成。");
        throw error;
      }
      return outcome.result.message;
    },
    async setOrder(entries) {
      await catalog.setOrder(placeOrder(catalog.order(), entries));
    },
  };
}

/** 执行 GDL。llm 为 true 时按模型输入规则校验：只能引用图层，不能写几何。 */
export async function runGdl(deps: GdlDeps, text: string, options: { readonly llm: boolean; readonly writeKnowledge: boolean }): Promise<GdlRunOutcome> {
  const program: GdlProgram = options.llm ? validateLlmGdl(text) : parseGdlOrThrow(text);
  const beforeIds = new Set(deps.spatial.catalog.list().map((layer) => layer.layerId));
  const produced: PublicMapLayer[] = [];
  const issues: GeometryIssue[] = [];
  const resolvedBuffers: ResolvedBufferLayer[] = [];
  const operationIds: string[] = [];
  const host = createGdlHost(deps, produced, issues, resolvedBuffers, operationIds, options.llm);
  let execution;
  try {
    execution = await executeGdl(program, host);
  } catch (error) {
    const cause = error instanceof GdlRuntimeError ? error.cause : error;
    throw new GdlRunFailure(
      error,
      failureLayers(deps, produced, beforeIds),
      [...issues, ...geometryIssuesOf(cause)],
      resolvedBuffers.map((item) => ({ layerId: item.layerId, layerName: item.layerName })),
      [...operationIds],
    );
  }
  const summary = summarizeGdlProgram(program);
  let indexed = false;
  if (options.writeKnowledge) {
    const names = [...new Set(execution.layers.map((layer) => layer.layerName))];
    try {
      await deps.addRag({ title: `GDL 摘要 ${names.slice(0, 3).join("、") || "语句"}`, body: summary, layerNames: names, kind: "gis" });
      indexed = true;
    } catch {
      indexed = false;
    }
  }
  return {
    layers: produced.map((layer) => publicStoreLayer(deps.spatial, layer)),
    summary,
    geometryIssues: issues.slice(0, 200),
    steps: execution.steps.length,
    indexed,
    ...bufferResolutionFields(resolvedBuffers),
    ...operationFields(operationIds),
  };
}

/** 图层的 GDL 摘要。只含名称、类型、坐标系标签、字段、样式和数量。 */
export function describeLayerAsGdl(deps: GdlDeps, layerId: string): string {
  return layerToGdlSummary(layerSource(deps.spatial, layerId));
}

function fileStamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function safeFileStem(name: string): string {
  const stem = name.replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^\.+/, "").slice(0, 40);
  return stem === "" ? "layer" : stem;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 写到 var/gdl 下的新文件。重名时加序号，不覆盖任何已有文件。 */
export async function exportLayerAsGdl(deps: GdlDeps, layerId: string): Promise<{ readonly filePath: string; readonly fileName: string; readonly text: string; readonly omitted: number }> {
  const source = layerSource(deps.spatial, layerId);
  const { text, omitted } = layerToGdl(source);
  await mkdir(deps.gdlDirectory, { recursive: true });
  const stem = `${safeFileStem(source.name)}-${fileStamp()}`;
  let fileName = `${stem}.gdl`;
  for (let index = 2; await exists(join(deps.gdlDirectory, fileName)); index += 1) fileName = `${stem}-${index}.gdl`;
  const filePath = join(deps.gdlDirectory, fileName);
  try {
    await writeFile(filePath, text, { encoding: "utf8" });
  } catch {
    const remembered = await deps.spatial.service.recordGdlExport(source.name, layerId, null, false, "GDL 文件没有写出。");
    const failure = new SpatialOpError("GDL 文件没有写出，请检查 var/gdl 是否可写。");
    if (typeof remembered.auditRecordId === "string") failure.auditRecordId = remembered.auditRecordId;
    else if (remembered.auditAppendFailed) failure.auditAppendFailed = true;
    throw failure;
  }
  const note = omitted > 0 ? `已导出为新的 GDL 文件，省略 ${omitted} 个几何集合要素。` : "已导出为新的 GDL 文件。";
  await deps.spatial.service.recordGdlExport(source.name, layerId, filePath, true, note);
  return { filePath, fileName, text, omitted };
}

function failurePayload(error: unknown): { status: number; body: Record<string, unknown> } {
  const original = error instanceof GdlRunFailure ? error.original : error;
  const layers = error instanceof GdlRunFailure ? error.layers : [];
  const geometryIssues = error instanceof GdlRunFailure ? error.geometryIssues : geometryIssuesOf(error);
  const resolved = error instanceof GdlRunFailure ? bufferResolutionFields(error.resolvedBuffers) : {};
  const operations = error instanceof GdlRunFailure ? operationFields(error.operationIds) : {};
  if (original instanceof GdlSyntaxError) {
    return { status: 400, body: { ok: false, kind: "gdl-syntax", message: original.message, errors: original.diagnostics } };
  }
  if (original instanceof GdlGuardError) {
    return { status: 400, body: { ok: false, kind: "gdl-guard", message: original.message, errors: original.diagnostics } };
  }
  if (original instanceof GdlRuntimeError) {
    const cause = original.cause instanceof SpatialOpError ? original.cause : null;
    return {
      status: 400,
      body: {
        ok: false,
        kind: "gdl-runtime",
        message: original.message,
        line: original.line,
        layers,
        geometryIssues,
        ...resolved,
        ...operations,
        ...auditFailureFields(cause),
      },
    };
  }
  if (original instanceof SpatialOpError || original instanceof GdlSummaryError) {
    return {
      status: 400,
      body: {
        ok: false,
        kind: "gis-core",
        message: original.message,
        layers,
        geometryIssues,
        ...resolved,
        ...operations,
        ...auditFailureFields(original),
      },
    };
  }
  return { status: 500, body: { ok: false, kind: "failed", message: "GDL 处理失败，服务仍在运行。", layers, ...resolved, ...operations } };
}

function layerIdentities(value: unknown): { readonly layerId: string; readonly layerName: string }[] {
  if (!Array.isArray(value)) return [];
  const layers: { layerId: string; layerName: string }[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.layerId !== "string" || typeof item.layerName !== "string") continue;
    if (item.layerId.trim() === "" || item.layerName.trim() === "") continue;
    layers.push({ layerId: item.layerId, layerName: item.layerName });
  }
  return layers;
}

/** 工具结果保留 ok 和 message，并带上已经生成的图层和 failurePayload 里的审计字段。 */
function gdlToolFailure(tool: string, error: unknown): Record<string, unknown> {
  const body = failurePayload(error).body;
  const base = typeof body.message === "string" ? body.message : "GDL 处理失败。";
  const layers = layerIdentities(body.layers);
  const listed = layers.map((layer) => `${layer.layerName}（${layer.layerId}）`).join("、");
  const message = listed === "" ? base : `${base} 已生成图层：${listed}。`;
  const only = layers.length === 1 ? layers[0] : undefined;
  const resolvedLayerId = typeof body.resolvedLayerId === "string" ? body.resolvedLayerId : undefined;
  const resolvedLayerName = typeof body.resolvedLayerName === "string" ? body.resolvedLayerName : undefined;
  return {
    ok: false,
    tool,
    message,
    ...(layers.length > 0 ? { layers } : {}),
    ...(only ? { layerId: only.layerId, layerName: only.layerName } : {}),
    ...(Array.isArray(body.resolvedBuffers) ? { resolvedBuffers: body.resolvedBuffers } : {}),
    ...(resolvedLayerId ? { resolvedLayerId } : {}),
    ...(resolvedLayerName ? { resolvedLayerName } : {}),
    ...(typeof body.operationId === "string" ? { operationId: body.operationId } : {}),
    ...(Array.isArray(body.operationIds) ? { operationIds: body.operationIds } : {}),
    ...auditFailureFields(spatialAuditCause(error)),
  };
}

/** GDL 运行错误的 cause 才是 SpatialOpError。直接抛出的空间错误用它自己。 */
function spatialAuditCause(error: unknown): unknown {
  const original = error instanceof GdlRunFailure ? error.original : error;
  if (original instanceof GdlRuntimeError) return original.cause;
  return original;
}

/** V0.7 的 GDL 接口。未识别的路径返回 false。 */
export async function handleGdlRequest(deps: GdlDeps, request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  if (path !== "/api/gdl/parse" && path !== "/api/gdl/load" && path !== "/api/gdl/export" && path !== "/api/gdl/summary") return false;
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, message: "这个接口只接受 POST。" });
    return true;
  }
  let body: unknown;
  try {
    body = await readBody(request);
  } catch (error) {
    sendJson(response, 400, { ok: false, message: error instanceof SpatialOpError ? error.message : "请求正文不是 JSON。" });
    return true;
  }
  if (!isRecord(body)) {
    sendJson(response, 400, { ok: false, message: "请求正文必须是对象。" });
    return true;
  }
  try {
    if (path === "/api/gdl/parse") {
      const text = typeof body.text === "string" ? body.text : "";
      const parsed = parseGdl(text);
      if (!parsed.ok) throw new GdlSyntaxError(parsed.errors);
      sendJson(response, 200, { ok: true, statementCount: parsed.program.statements.length, summary: summarizeGdlProgram(parsed.program) });
      return true;
    }
    if (path === "/api/gdl/load") {
      const text = typeof body.text === "string" ? body.text : "";
      if (text.trim() === "") {
        sendJson(response, 400, { ok: false, kind: "gdl-syntax", message: "请先填写 GDL 文本。", errors: [] });
        return true;
      }
      const conversationId = typeof body.conversationId === "string" ? body.conversationId.trim() : "";
      if (deps.inConversation && conversationId === "") {
        sendJson(response, 400, { ok: false, message: "需要对话编号。" });
        return true;
      }
      const run = () => runGdl(deps, text, { llm: false, writeKnowledge: body.writeKnowledge === true });
      const outcome = await (deps.inConversation ? deps.inConversation(conversationId, run) : run());
      if (conversationId !== "" && outcome.layers.length > 0) {
        await deps.registerWorkspaceLayers?.(conversationId, outcome.layers.map((layer) => layer.layerId));
      }
      // 脚本内的空间步骤各有自己的操作记录；这条是入口级 load 留痕。不覆盖 outcome 的 operationId。
      const loadAuditId = await auditGdlChange(deps, {
        kind: "load",
        action: "run-gdl",
        inputResources: outcome.resolvedLayerId ? [outcome.resolvedLayerId] : [],
        outputResources: outcome.layers.map((layer) => layer.layerId),
        ok: true,
      });
      sendJson(response, 200, { ok: true, ...outcome, auditOperationId: loadAuditId });
      return true;
    }
    const layerId = typeof body.layerId === "string" ? body.layerId.trim() : "";
    if (layerId === "") {
      sendJson(response, 400, { ok: false, message: "需要图层标识。" });
      return true;
    }
    const conversationId = typeof body.conversationId === "string" ? body.conversationId.trim() : "";
    if (deps.inConversation && conversationId === "") {
      sendJson(response, 400, { ok: false, message: "需要对话编号。" });
      return true;
    }
    const inConversation = async <T>(run: () => Promise<T>): Promise<T> => (
      deps.inConversation ? deps.inConversation(conversationId, run) : run()
    );
    if (path === "/api/gdl/export") {
      const exported = await inConversation(() => exportLayerAsGdl(deps, layerId));
      const exportAuditId = await auditGdlChange(deps, {
        kind: "export",
        action: "export-gdl",
        inputResources: [layerId],
        outputResources: [exported.filePath],
        ok: true,
      });
      sendJson(response, 200, { ok: true, ...exported, operationId: exportAuditId, message: `已写出 ${exported.fileName}，没有覆盖源文件。` });
      return true;
    }
    const summarized = await inConversation(async () => ({
      summary: describeLayerAsGdl(deps, layerId),
      meta: deps.spatial.catalog.get(layerId),
    }));
    const summary = summarized.summary;
    let indexed = false;
    if (body.writeKnowledge === true) {
      const meta = summarized.meta;
      await deps.addRag({ title: `GDL 摘要 ${meta?.layerName ?? layerId}`, body: summary, layerNames: meta ? [meta.layerName] : [], kind: "gis" });
      indexed = true;
    }
    sendJson(response, 200, { ok: true, summary, indexed });
    return true;
  } catch (error) {
    const failure = failurePayload(error);
    // 非空间状态变更失败同样留痕。
    const audit = path === "/api/gdl/load"
      ? { kind: "load" as const, action: "run-gdl" }
      : path === "/api/gdl/export"
        ? { kind: "export" as const, action: "export-gdl" }
        : null;
    if (audit) {
      try {
        await auditGdlChange(deps, {
          ...audit,
          ok: false,
          message: error instanceof Error ? error.message : "操作没有完成。",
        });
      } catch {
        // 留痕失败不影响错误返回。
      }
    }
    sendJson(response, failure.status, failure.body);
    return true;
  }
}

function textArg(call: ScheduledToolCall, name: string): string | null {
  const value = call.args[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** 把 gdl.run 和 gdl.describe 接到现有适配器前面。其余工具交给内层。 */
export function createGdlAwareAdapter(inner: ToolAdapterPort, deps: GdlDeps): ToolAdapterPort {
  return {
    async execute(call) {
      if (call.tool === "gdl.run") {
        const script = textArg(call, "script");
        if (!script) return { ok: false, tool: call.tool, message: "gdl.run 需要 GDL 语句。" };
        try {
          const outcome = await runGdl(deps, script, { llm: true, writeKnowledge: call.args.writeKnowledge === true });
          const names = outcome.layers.map((layer) => layer.layerName).join("、");
          const resolvedNote = outcome.resolvedLayerId
            ? `缓冲使用的图层：${outcome.resolvedLayerName ?? outcome.resolvedLayerId}（${outcome.resolvedLayerId}）。`
            : "";
          const message = names
            ? `已执行 ${outcome.steps} 条 GDL 语句，生成图层：${names}。${resolvedNote}`
            : `已执行 ${outcome.steps} 条 GDL 语句。${resolvedNote}`;
          return {
            ok: true,
            tool: call.tool,
            message,
            layerNames: names,
            summary: outcome.summary,
            issueCount: outcome.geometryIssues.length,
            ...(outcome.resolvedBuffers ? { resolvedBuffers: outcome.resolvedBuffers } : {}),
            ...(outcome.resolvedLayerId ? { resolvedLayerId: outcome.resolvedLayerId } : {}),
            ...(outcome.resolvedLayerName ? { resolvedLayerName: outcome.resolvedLayerName } : {}),
            ...(outcome.operationId ? { operationId: outcome.operationId } : {}),
            ...(outcome.operationIds ? { operationIds: outcome.operationIds } : {}),
          };
        } catch (error) {
          return gdlToolFailure(call.tool, error);
        }
      }
      if (call.tool === "gdl.describe") {
        const layerName = textArg(call, "layerName") ?? textArg(call, "layerId");
        const hit = resolveLayerRef(deps.spatial.catalog, layerName ?? "");
        if (hit.status !== "ok") {
          return {
            ok: false,
            tool: call.tool,
            message: hit.status === "ambiguous"
              ? `图层「${layerName ?? ""}」有多个候选，请改用完整名称或图层标识。`
              : `找不到图层 ${layerName ?? ""}。`,
            ...(hit.status === "ambiguous" || hit.status === "missing" ? { candidates: hit.candidates } : {}),
          };
        }
        try {
          const summary = describeLayerAsGdl(deps, hit.layerId);
          return { ok: true, tool: call.tool, message: summary, layerName: hit.layerName, layerId: hit.layerId };
        } catch (error) {
          return gdlToolFailure(call.tool, error);
        }
      }
      return inner.execute(call);
    },
  };
}
