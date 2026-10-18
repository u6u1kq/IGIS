// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { GisIoReadError } from "@igis/gis-io";
import { issueAndConsumeApproval } from "@igis/ai-boundary";
import type { ApprovalState } from "@igis/ai-boundary";
import { gateDestructive } from "@igis/llm-dispatch";
import { SpatialOpError, auditFailureFields, bufferRequestFromResolution, executeGisOperation, geometryIssuesOf, rawBufferInputFromMapHttp, recordNonSpatialOperation, validateBufferOperation } from "@igis/spatial-ops";
import type { BufferDistanceUnit, GisOperationCall, NonSpatialOperationKind, PublicMapLayer, SpatialRunResult, SpatialStack } from "@igis/spatial-ops";
import { SurtGisCoreError } from "@igis/surtgis";

interface V05Deps {
  readonly spatial: SpatialStack;
  readonly vendorRoot: string;
  readonly hasConversation?: (conversationId: string) => boolean;
  readonly registerWorkspaceLayers?: (conversationId: string, layerIds: readonly string[]) => Promise<void>;
  /** 操作记录写到这个工作区。不传则用进程工作目录。 */
  readonly operationsRoot?: string;
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
  // 流式解码：防止 TCP 分块切开 UTF-8 多字节序列（中文）。
  const decoder = new TextDecoder();
  for await (const chunk of request) {
    parts.push(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
  }
  parts.push(decoder.decode());
  const text = parts.join("");
  if (text.trim() === "") return {};
  return JSON.parse(text) as unknown;
}

function textField(body: Record<string, unknown>, name: string): string | null {
  const value = body[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** 非空间状态变更的留痕：桌面地图入口（local-user / desktop-ui）。 */
function auditMapChange(
  deps: V05Deps,
  body: {
    readonly kind: NonSpatialOperationKind;
    readonly action: string;
    readonly inputResources?: readonly string[];
    readonly outputResources?: readonly string[];
    readonly ok: boolean;
    readonly message?: string;
    readonly approvalState?: ApprovalState;
  },
): Promise<string> {
  return recordNonSpatialOperation({
    ...body,
    entry: "map",
    source: "local-user",
    aiOrigin: false,
    translationUsed: false,
    requestSource: "desktop-ui",
    ...(deps.operationsRoot !== undefined ? { root: deps.operationsRoot } : {}),
  });
}

/** 留痕契约五族在地图接口上的归属。 */
function nonSpatialPathAction(path: string): { readonly kind: NonSpatialOperationKind; readonly action: string } | null {
  if (path === "/api/map/load") return { kind: "load", action: "load-file" };
  if (path === "/api/map/rename") return { kind: "rename", action: "rename-layer" };
  if (path === "/api/map/layer/delete") return { kind: "delete", action: "delete-layer" };
  if (path === "/api/map/export") return { kind: "export", action: "export-geojson" };
  return null;
}

function contentType(fileName: string): string {
  if (fileName.endsWith(".css")) return "text/css; charset=utf-8";
  if (fileName.endsWith(".js") || fileName.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (fileName.endsWith(".map")) return "application/json; charset=utf-8";
  if (fileName.endsWith(".svg")) return "image/svg+xml";
  if (fileName.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

async function sendVendor(response: ServerResponse, vendorRoot: string, pathname: string): Promise<void> {
  const prefix = "/vendor/maplibre/";
  const rel = decodeURIComponent(pathname.slice(prefix.length));
  if (rel === "" || rel.includes("..") || rel.includes("\\") || rel.includes("\0")) {
    sendJson(response, 400, { ok: false, message: "静态资源路径无效。" });
    return;
  }
  const filePath = resolve(vendorRoot, rel);
  const root = resolve(vendorRoot).replace(/[\\/]+$/, "");
  const comparable = filePath.toLowerCase();
  const base = root.toLowerCase();
  if (comparable !== base && !comparable.startsWith(`${base}\\`) && !comparable.startsWith(`${base}/`)) {
    sendJson(response, 400, { ok: false, message: "静态资源路径无效。" });
    return;
  }
  try {
    const bytes = await readFile(filePath);
    // vendor 文件随安装钉死不变：强缓存，浏览器不再重复下载。
    response.writeHead(200, { "Content-Type": contentType(filePath), "Cache-Control": "public, max-age=31536000, immutable" });
    response.end(bytes);
  } catch {
    sendJson(response, 404, { ok: false, message: "找不到地图库文件。" });
  }
}

function publicLayer(meta: { readonly layerId: string; readonly layerName: string; readonly featureCount: number; readonly fieldNames: readonly string[] }) {
  return {
    layerId: meta.layerId,
    layerName: meta.layerName,
    featureCount: meta.featureCount,
    fieldNames: meta.fieldNames,
    mapUrl: `/api/map/layers/${meta.layerId}/geojson`,
  };
}

function withStoreLayer<T extends { readonly layer: PublicMapLayer | null }>(spatial: SpatialStack, result: T): T {
  return result.layer ? ({ ...result, layer: publicStoreLayer(spatial, result.layer) } as T) : result;
}

function withoutCacheKey(result: SpatialRunResult): Omit<SpatialRunResult, "cacheKey"> {
  const { cacheKey: _cacheKey, ...rest } = result;
  return rest;
}

/** 地图上的缓冲、相交、裁剪、查询、统计都从这里进入操作记录。 */
async function sendSpatial(
  response: ServerResponse,
  deps: V05Deps,
  call: GisOperationCall,
  extra: Record<string, string> = {},
  conversationId?: string,
): Promise<void> {
  const outcome = await executeGisOperation(deps.spatial.service, {
    ...call,
    ...(deps.operationsRoot !== undefined ? { root: deps.operationsRoot } : {}),
  });
  if (!outcome.ok || !outcome.result) {
    const geometryIssues = geometryIssuesOf(outcome.error);
    const message = outcome.error instanceof Error ? outcome.error.message : "空间分析没有完成。";
    sendJson(response, 400, {
      ok: false,
      message,
      operationId: outcome.operationId,
      ...(geometryIssues.length > 0 ? { geometryIssues } : {}),
      ...auditFailureFields(outcome.error),
      ...extra,
    });
    return;
  }
  if (conversationId && outcome.result.layer) {
    await deps.registerWorkspaceLayers?.(conversationId, [outcome.result.layer.layerId]);
  }
  const visible = withoutCacheKey(outcome.result);
  const body = visible.layer ? withStoreLayer(deps.spatial, visible) : visible;
  sendJson(response, 200, { ...body, operationId: outcome.operationId, ...extra });
}

/** V0.7：在旧字段后面追加图层库里的样式、几何类型和坐标系标签。没有坐标。 */
export function publicStoreLayer(spatial: SpatialStack, layer: PublicMapLayer | { readonly layerId: string; readonly layerName: string; readonly featureCount: number; readonly fieldNames: readonly string[] }) {
  const meta = spatial.catalog.get(layer.layerId);
  return {
    ...publicLayer(layer),
    ...layer,
    style: spatial.catalog.style(layer.layerId),
    geometryKind: meta?.geometryKind ?? "unknown",
    crsLabel: meta?.crsLabel ?? "未声明",
  };
}

/**
 * V0.5 追加的地图、空间分析和审计接口。
 * 未识别的路径返回 false，交给原来的桌面接口。
 */
export async function handleV05Request(deps: V05Deps, request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  const vendor = path.startsWith("/vendor/maplibre/");
  const owned = vendor
    || path === "/api/map/layers"
    || path === "/api/map/load"
    || path === "/api/map/rename"
    || path === "/api/map/layer/delete"
    || path === "/api/map/layer/style"
    || path === "/api/map/layer/order"
    || path === "/api/map/export"
    || path === "/api/spatial/run"
    || path === "/api/audit"
    || /^\/api\/map\/layers\/[A-Za-z0-9_-]+\/geojson$/.test(path);
  if (!owned) return false;
  try {
    if (request.method === "GET" && vendor) {
      await sendVendor(response, deps.vendorRoot, path);
      return true;
    }
    if (request.method === "GET" && path === "/api/map/layers") {
      sendJson(response, 200, {
        ok: true,
        layers: deps.spatial.catalog.list().map((layer) => publicStoreLayer(deps.spatial, layer)),
        order: deps.spatial.catalog.order(),
      });
      return true;
    }
    const geojson = /^\/api\/map\/layers\/([A-Za-z0-9_-]+)\/geojson$/.exec(path);
    if (request.method === "GET" && geojson?.[1]) {
      const collection = deps.spatial.catalog.collection(geojson[1]);
      if (!collection) {
        sendJson(response, 404, { ok: false, message: "找不到这个图层。" });
        return true;
      }
      const meta = deps.spatial.catalog.get(geojson[1]);
      const exported = meta !== null && /^EPSG:\d+$/.test(meta.crsLabel)
        ? { ...collection, crs: { type: "name", properties: { name: meta.crsLabel } } }
        : collection;
      // 图层文件入库后不再修改、layerId 不复用：强缓存安全。
      response.writeHead(200, {
        "Content-Type": "application/geo+json; charset=utf-8",
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      response.end(JSON.stringify(exported));
      return true;
    }
    if (request.method === "GET" && path === "/api/audit") {
      const records = await deps.spatial.audit.list();
      sendJson(response, 200, { ok: true, records });
      return true;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { ok: false, message: "这个接口只接受 POST。" });
      return true;
    }
    let body: unknown;
    try {
      body = await readBody(request);
    } catch {
      sendJson(response, 400, { ok: false, message: "请求正文不是 JSON。" });
      return true;
    }
    if (!isRecord(body)) {
      sendJson(response, 400, { ok: false, message: "请求正文必须是对象。" });
      return true;
    }
    const writeKnowledge = body.writeKnowledge === true;
    if (path === "/api/map/load") {
      const absolutePath = textField(body, "absolutePath");
      if (!absolutePath) {
        sendJson(response, 400, { ok: false, message: "需要 GIS 文件路径。" });
        return true;
      }
      const conversationId = textField(body, "conversationId");
      if (conversationId && deps.hasConversation && !deps.hasConversation(conversationId)) {
        sendJson(response, 400, { ok: false, message: "当前对话已失效，请切换对话后重试。" });
        return true;
      }
      const layers = await deps.spatial.service.usingRequestSource("desktop-ui", () => deps.spatial.service.loadFile(absolutePath, textField(body, "layerName"), writeKnowledge));
      if (conversationId) await deps.registerWorkspaceLayers?.(conversationId, layers.map((layer) => layer.layerId));
      const loadAuditId = await auditMapChange(deps, {
        kind: "load",
        action: "load-file",
        inputResources: [absolutePath],
        outputResources: layers.map((layer) => layer.layerId),
        ok: true,
      });
      sendJson(response, 200, { ok: true, layers: layers.map((layer) => publicStoreLayer(deps.spatial, layer)), operationId: loadAuditId });
      return true;
    }
    if (path === "/api/map/rename") {
      const layerId = textField(body, "layerId");
      const layerName = textField(body, "layerName");
      if (!layerId || !layerName) {
        sendJson(response, 400, { ok: false, message: "需要图层标识和新名称。" });
        return true;
      }
      const layer = await deps.spatial.service.rename(layerId, layerName);
      const renameAuditId = await auditMapChange(deps, {
        kind: "rename",
        action: "rename-layer",
        inputResources: [layerId],
        outputResources: [layer.layerName],
        ok: true,
      });
      sendJson(response, 200, { ok: true, layer: publicLayer(layer), operationId: renameAuditId });
      return true;
    }
    if (path === "/api/map/layer/delete") {
      const layerId = textField(body, "layerId");
      if (!layerId) {
        sendJson(response, 400, { ok: false, message: "需要图层标识。" });
        return true;
      }
      // 这个 confirm 来自桌面界面里用户点过确认，不是模型或 MCP 参数。
      const gate = gateDestructive("delete-layer", body.confirm === true, layerId);
      if (!gate.ok) {
        sendJson(response, 409, { ok: false, code: gate.code, message: gate.message });
        return true;
      }
      // 授权契约：用户确认产生一次性 ApprovalToken 并立即消费。
      const approval = issueAndConsumeApproval(`delete-layer:${layerId}`, "local-ui");
      const removed = await deps.spatial.catalog.remove(layerId);
      const deleteAuditId = await auditMapChange(deps, {
        kind: "delete",
        action: "delete-layer",
        inputResources: [layerId],
        ok: removed,
        ...(removed ? {} : { message: "找不到这个图层。" }),
        approvalState: approval,
      });
      if (!removed) {
        sendJson(response, 404, { ok: false, message: "找不到这个图层。", operationId: deleteAuditId });
        return true;
      }
      sendJson(response, 200, { ok: true, layerId, operationId: deleteAuditId });
      return true;
    }
    if (path === "/api/map/layer/style") {
      const updates: [string, Record<string, unknown>][] = [];
      if (isRecord(body.styles)) {
        for (const [id, style] of Object.entries(body.styles)) {
          if (isRecord(style)) updates.push([id, style]);
        }
      } else {
        const layerId = textField(body, "layerId");
        if (layerId && isRecord(body.style)) updates.push([layerId, body.style]);
      }
      if (updates.length === 0) {
        sendJson(response, 400, { ok: false, message: "需要图层标识和样式。" });
        return true;
      }
      const styles: Record<string, unknown> = {};
      for (const [id, style] of updates.slice(0, 200)) {
        if (!deps.spatial.catalog.get(id)) continue;
        styles[id] = await deps.spatial.catalog.updateStyle(id, style);
      }
      sendJson(response, 200, { ok: true, styles });
      return true;
    }
    if (path === "/api/map/layer/order") {
      if (!Array.isArray(body.order) || !body.order.every((id) => typeof id === "string")) {
        sendJson(response, 400, { ok: false, message: "需要图层顺序数组。" });
        return true;
      }
      const order = await deps.spatial.catalog.setOrder(body.order as string[]);
      sendJson(response, 200, { ok: true, order });
      return true;
    }
    if (path === "/api/map/export") {
      const layerId = textField(body, "layerId");
      const destinationPath = textField(body, "destinationPath");
      if (!layerId || !destinationPath) {
        sendJson(response, 400, { ok: false, message: "需要图层标识和导出路径。" });
        return true;
      }
      const result = await deps.spatial.service.usingRequestSource("desktop-ui", () => deps.spatial.service.exportLayer(layerId, destinationPath));
      const exportAuditId = await auditMapChange(deps, {
        kind: "export",
        action: "export-geojson",
        inputResources: [layerId],
        outputResources: [destinationPath],
        ok: true,
      });
      sendJson(response, 200, { ...result, operationId: exportAuditId });
      return true;
    }
    if (path === "/api/spatial/run") {
      const workspaceConversationId = textField(body, "conversationId");
      if (workspaceConversationId && deps.hasConversation && !deps.hasConversation(workspaceConversationId)) {
        sendJson(response, 400, { ok: false, message: "当前对话已失效，请切换对话后重试。" });
        return true;
      }
      const operation = textField(body, "operation");
      const layerId = textField(body, "layerId");
      if (!operation || !layerId) {
        sendJson(response, 400, { ok: false, message: "需要操作类型和图层。" });
        return true;
      }
      const otherLayerId = textField(body, "otherLayerId");
      const conversationId = textField(body, "conversationId") ?? undefined;
      if (operation === "buffer") {
        const distance = body.distance;
        const unit = textField(body, "unit");
        if (typeof distance !== "number" || !unit) {
          sendJson(response, 400, { ok: false, message: "缓冲需要距离和单位。" });
          return true;
        }
        const raw = rawBufferInputFromMapHttp({
          layerId,
          distance,
          unit: unit as BufferDistanceUnit,
          writeKnowledge,
        });
        // 地图缓冲只认请求里的 layerId。不读取 layerName。id 不在库里时不改按同名查找。
        // validateBufferOperation 本身不查找图层。
        const meta = deps.spatial.catalog.get(layerId);
        if (!meta) {
          await sendSpatial(response, deps, {
            entry: "map",
            operation: "buffer",
            policy: { writeKnowledge },
          callerCrs: textField(body, "crs"),
            sourceLayer: { layerId, layerName: layerId },
            distance,
            unit,
          }, {}, conversationId);
          return true;
        }
        const built = bufferRequestFromResolution(
          { layerId: meta.layerId, layerName: meta.layerName },
          raw.input.distance,
          raw.input.unit,
        );
        if (!built.ok) {
          sendJson(response, 400, { ok: false, message: "图层没有解析成唯一身份。" });
          return true;
        }
        const validation = validateBufferOperation(built.request);
        if (!validation.ok) {
          const message = validation.errors.map((item) => item.message).join("");
          sendJson(response, 400, {
            ok: false,
            message: message || "缓冲请求不合法。",
            sourceLayerId: meta.layerId,
            sourceLayerName: meta.layerName,
          });
          return true;
        }
        await sendSpatial(response, deps, {
          entry: "map",
          operation: "buffer",
          policy: { writeKnowledge },
          callerCrs: textField(body, "crs"),
          sourceLayer: { layerId: meta.layerId, layerName: meta.layerName },
          distance: built.request.distance,
          unit: built.request.unit,
        }, {
          sourceLayerId: meta.layerId,
          sourceLayerName: meta.layerName,
        }, conversationId);
        return true;
      }
      if (operation === "intersect") {
        if (!otherLayerId) {
          sendJson(response, 400, { ok: false, message: "相交需要第二个图层。" });
          return true;
        }
        const layerMeta = deps.spatial.catalog.get(layerId);
        const otherMeta = deps.spatial.catalog.get(otherLayerId);
        await sendSpatial(response, deps, {
          entry: "map",
          operation: "intersect",
          policy: { writeKnowledge },
          callerCrs: textField(body, "crs"),
          layerId,
          layerName: layerMeta?.layerName ?? layerId,
          otherLayerId,
          otherLayerName: otherMeta?.layerName ?? otherLayerId,
        }, {}, conversationId);
        return true;
      }
      if (operation === "clip") {
        if (!otherLayerId) {
          sendJson(response, 400, { ok: false, message: "裁剪需要裁剪图层。" });
          return true;
        }
        const layerMeta = deps.spatial.catalog.get(layerId);
        const otherMeta = deps.spatial.catalog.get(otherLayerId);
        await sendSpatial(response, deps, {
          entry: "map",
          operation: "clip",
          policy: { writeKnowledge },
          callerCrs: textField(body, "crs"),
          layerId,
          layerName: layerMeta?.layerName ?? layerId,
          otherLayerId,
          otherLayerName: otherMeta?.layerName ?? otherLayerId,
        }, {}, conversationId);
        return true;
      }
      if (operation === "query") {
        const queryKind = textField(body, "queryKind");
        if (!queryKind) {
          sendJson(response, 400, { ok: false, message: "空间查询需要查询种类。" });
          return true;
        }
        const layerMeta = deps.spatial.catalog.get(layerId);
        const otherMeta = otherLayerId ? deps.spatial.catalog.get(otherLayerId) : null;
        await sendSpatial(response, deps, {
          entry: "map",
          operation: "query",
          policy: { writeKnowledge },
          callerCrs: textField(body, "crs"),
          layerId,
          layerName: layerMeta?.layerName ?? layerId,
          otherLayerId,
          otherLayerName: otherMeta?.layerName ?? null,
          queryKind,
          attributeFilter: textField(body, "attributeFilter"),
        }, {}, conversationId);
        return true;
      }
      if (operation === "stats") {
        const layerMeta = deps.spatial.catalog.get(layerId);
        await sendSpatial(response, deps, {
          entry: "map",
          operation: "stats",
          policy: { writeKnowledge },
          callerCrs: textField(body, "crs"),
          layerId,
          layerName: layerMeta?.layerName ?? layerId,
          fieldName: textField(body, "fieldName"),
        }, {}, conversationId);
        return true;
      }
      sendJson(response, 400, { ok: false, message: "不认识这个空间操作。" });
      return true;
    }
    sendJson(response, 404, { ok: false, message: "没有这个接口。" });
  } catch (error) {
    const known = error instanceof SpatialOpError || error instanceof SurtGisCoreError || error instanceof GisIoReadError;
    const message = known && error instanceof Error ? error.message : "请求失败，服务仍在运行。";
    const geometryIssues = geometryIssuesOf(error);
    // 非空间状态变更失败同样留痕。
    const extra: Record<string, string> = {};
    const audit = nonSpatialPathAction(path);
    if (audit) {
      try {
        extra.operationId = await auditMapChange(deps, { kind: audit.kind, action: audit.action, ok: false, message });
      } catch {
        // 留痕失败不影响错误返回。
      }
    }
    sendJson(response, known ? 400 : 500, {
      ok: false,
      kind: "gis-core",
      message,
      ...extra,
      ...(geometryIssues.length > 0 ? { geometryIssues } : {}),
      ...auditFailureFields(error),
    });
  }
  return true;
}
