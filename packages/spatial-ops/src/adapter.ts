// SPDX-License-Identifier: Apache-2.0

import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { AI_SPATIAL_OPERATIONS, issueAndConsumeApproval } from "@igis/ai-boundary";
import type { ApprovalState } from "@igis/ai-boundary";
import { rejectModelToolCall, releaseToModel } from "@igis/ai-translation";
import { destructiveActionOf, gateDestructive } from "@igis/llm-dispatch";
import type { ScheduledToolCall, ToolAdapterPort } from "@igis/llm-dispatch";
import { bufferRequestFromResolution, rawBufferInputFromToolArgs } from "./buffer-operation.js";
import type { BufferDistanceUnit, ExecutionPolicy } from "./buffer-operation.js";
import { validateBufferOperation } from "./buffer-operation-validate.js";
import { executeGisOperation } from "./execute-gis-operation.js";
import type { GisOperationCall } from "./execute-gis-operation.js";
import { recordNonSpatialOperation } from "./operation-attempt.js";
import type { NonSpatialOperationKind } from "./operation-attempt.js";
import { SpatialOpError, auditFailureFields } from "./errors.js";
import { layerResolvePayload, resolveLayerRef } from "./resolve-layer.js";
import type { SpatialService } from "./service.js";
import type { SpatialRunResult } from "./service.js";

function textArg(call: ScheduledToolCall, name: string): string | null {
  const value = call.args[name];
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function numberArg(call: ScheduledToolCall, name: string): number | null {
  const value = call.args[name];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function flagArg(call: ScheduledToolCall, name: string): boolean {
  return call.args[name] === true;
}

function withProvenance<T extends GisOperationCall>(call: ScheduledToolCall, body: T): T {
  const provenance = call.provenance;
  if (!provenance) return body;
  return {
    ...body,
    source: provenance.source,
    aiOrigin: provenance.aiOrigin,
    translationUsed: provenance.translationUsed,
    ...(provenance.requestSource !== undefined ? { requestSource: provenance.requestSource } : {}),
    ...(provenance.dataBoundaryLevel !== undefined ? { dataBoundaryLevel: provenance.dataBoundaryLevel } : {}),
  };
}

/**
 * 破坏性操作的授权消费：用户确认 → 发一次性 token → 立即消费（同步）。
 * token 绑定 action:资源，用后作废。返回的 ApprovalState 写进留痕。
 */
function consumeDestructiveApproval(
  action: string,
  detail: string | undefined,
  issuedBy: "chat-ui" | "mcp-client",
): ApprovalState {
  return issueAndConsumeApproval(`${action}:${detail ?? "all"}`, issuedBy);
}

/** 非空间状态变更的动作归属。留痕契约 load/delete/rename/export/import 五族。 */
function nonSpatialActionOf(tool: string): { readonly kind: NonSpatialOperationKind; readonly action: string } | null {
  if (tool === "map.load" || tool === "io.read") return { kind: "load", action: "load-file" };
  if (tool === "map.delete") return { kind: "delete", action: "delete-layer" };
  if (tool === "map.clearAll") return { kind: "delete", action: "clear-layers" };
  if (tool === "map.dropDatabase") return { kind: "delete", action: "drop-database" };
  if (tool === "map.exportGeoJson") return { kind: "export", action: "export-geojson" };
  return null;
}

function toolPayload(result: SpatialRunResult): Record<string, string | number | boolean | null> {
  const payload: Record<string, string | number | boolean | null> = {
    ok: true,
    operationType: result.operationType,
    message: result.message,
    featureCount: result.featureCount,
  };
  if (result.layer) {
    payload.layerId = result.layer.layerId;
    payload.layerName = result.layer.layerName;
    payload.mapUrl = result.layer.mapUrl;
    payload.fieldNames = result.layer.fieldNames.join("、");
  }
  if (result.fieldName) payload.fieldName = result.fieldName;
  if (result.minimum !== null) payload.minimum = result.minimum;
  if (result.maximum !== null) payload.maximum = result.maximum;
  if (result.mean !== null) payload.mean = result.mean;
  if (typeof result.sum === "number") payload.sum = result.sum;
  if (typeof result.durationMs === "number") payload.durationMs = result.durationMs;
  if (typeof result.ragEntryId === "string") payload.ragEntryId = result.ragEntryId;
  if (typeof result.auditRecordId === "string") payload.auditRecordId = result.auditRecordId;
  if (result.auditAppendFailed === true) payload.auditAppendFailed = true;
  if (result.cached === true) payload.cached = true;
  return payload;
}

function failure(operationType: string, error: unknown): Record<string, string | boolean> {
  const message = error instanceof SpatialOpError ? error.message : "空间分析没有完成。";
  const code = error instanceof SpatialOpError && typeof error.code === "string" && error.code !== ""
    ? { code: error.code }
    : {};
  return { ok: false, operationType, message, ...code, ...auditFailureFields(error) };
}

function resolveRequired(service: SpatialService, query: string | null): { ok: true; layerId: string; layerName: string } | { ok: false; payload: Record<string, unknown> } {
  if (!query) return { ok: false, payload: layerResolvePayload({ status: "empty", query: "" }) };
  const hit = resolveLayerRef(service.layerCatalogForResolve(), query);
  if (hit.status !== "ok") return { ok: false, payload: layerResolvePayload(hit) };
  return { ok: true, layerId: hit.layerId, layerName: hit.layerName };
}

/** 缓冲重名只说明歧义，不挑选图层。相交和裁剪仍用原来的 layerResolvePayload 文案。 */
function explainBufferLookup(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload.code !== "ambiguous-layer") return payload;
  const query = typeof payload.query === "string" ? payload.query : "";
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const listed = candidates.map((item) => {
    if (item === null || typeof item !== "object") return "";
    const record = item as { readonly layerId?: unknown; readonly layerName?: unknown };
    const layerId = typeof record.layerId === "string" ? record.layerId : "";
    const layerName = typeof record.layerName === "string" ? record.layerName : "";
    if (layerName !== "" && layerId !== "") return `${layerName}（${layerId}）`;
    return layerId !== "" ? layerId : layerName;
  }).filter((item) => item !== "").join("、");
  const names = listed === "" ? "" : `候选：${listed}。`;
  return {
    ...payload,
    message: `图层名「${query}」有歧义（ambiguous），同名图层多于一层，没有选用其中任何一层。${names}请改用图层标识。`,
  };
}

function stylePatch(call: ScheduledToolCall): Record<string, string | number | boolean | null> {
  const patch: Record<string, string | number | boolean | null> = {};
  const fill = textArg(call, "fill");
  const outline = textArg(call, "outline");
  const width = numberArg(call, "width");
  const opacity = numberArg(call, "opacity");
  const colorField = textArg(call, "colorField");
  const labelField = textArg(call, "labelField");
  if (fill) patch.fill = fill;
  if (outline) patch.outline = outline;
  if (width !== null) patch.width = width;
  if (opacity !== null) patch.opacity = opacity;
  if (colorField !== null) patch.colorField = colorField;
  if (labelField !== null) patch.labelField = labelField;
  return patch;
}

function defaultExportPath(layerName: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const safe = layerName.replace(/[<>:"/\\|?*]/g, "_").slice(0, 40) || "layer";
  return resolve(join("var", "exports", `${safe}-${stamp}.geojson`));
}

async function finishGis(
  service: SpatialService,
  tool: string,
  call: GisOperationCall,
  extra: Record<string, string> = {},
): Promise<Record<string, string | number | boolean | null>> {
  const outcome = await executeGisOperation(service, call);
  if (!outcome.ok || !outcome.result) {
    return { ...failure(tool, outcome.error), operationId: outcome.operationId, ...extra };
  }
  return { ...toolPayload(outcome.result), operationId: outcome.operationId, ...extra };
}

/** 把空间工具接到现有适配器前面。原来的只读查询仍交给内层适配器。 */
export function createSpatialAwareAdapter(
  inner: ToolAdapterPort,
  service: SpatialService,
  options?: { readonly entry?: "chat" | "mcp"; readonly operationsRoot?: string },
): ToolAdapterPort {
  const entry = options?.entry ?? "chat";
  const operationsRoot = options?.operationsRoot;
  return {
    async execute(call) {
      const rejected = rejectModelToolCall(call.tool, call.args);
      if (rejected) return rejected;
      return releaseToModel(await dispatch(call));
    },
  };

  /** 非空间状态变更的留痕：入口、来源身份和操作记录根都由适配器补全。 */
  async function auditNonSpatial(
    call: ScheduledToolCall,
    body: {
      readonly kind: NonSpatialOperationKind;
      readonly action: string;
      readonly inputResources?: readonly string[];
      readonly outputResources?: readonly string[];
      readonly ok: boolean;
      readonly message?: string;
    },
    approvalState?: ApprovalState,
  ): Promise<string> {
    const provenance = call.provenance;
    return recordNonSpatialOperation({
      ...body,
      entry,
      ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
      ...(approvalState ? { approvalState } : {}),
      ...(provenance
        ? {
            source: provenance.source,
            aiOrigin: provenance.aiOrigin,
            translationUsed: provenance.translationUsed,
            ...(provenance.requestSource !== undefined ? { requestSource: provenance.requestSource } : {}),
          }
        : {}),
    });
  }

  async function dispatch(call: ScheduledToolCall): Promise<unknown> {
      let approvalState: ApprovalState | undefined;
      const action = destructiveActionOf(call.tool);
      if (action) {
        // args.confirm 来自模型或 MCP 时不能授权。只认运行时单独设置的 userConfirmed。
        const gate = gateDestructive(action, call.userConfirmed === true, textArg(call, "layerId") ?? undefined);
        if (!gate.ok) return { ok: false, code: gate.code, message: gate.message, action: "confirm" };
        // 授权契约：用户确认产生一次性 ApprovalToken 并立即消费。AI 永远不是授权来源。
        approvalState = consumeDestructiveApproval(action, textArg(call, "layerId") ?? undefined, entry === "mcp" ? "mcp-client" : "chat-ui");
      }
      const writeKnowledge = flagArg(call, "writeKnowledge");
      try {
        if (call.tool === "map.list") {
          const layers = service.store.list().map((layer) => ({
            layerId: layer.layerId,
            layerName: layer.layerName,
            geometryType: layer.geometryKind,
            featureCount: layer.featureCount,
            relations: [],
            availableOperations: [...AI_SPATIAL_OPERATIONS],
          }));
          return { ok: true, level: "L2", message: layers.length === 0 ? "地图里还没有图层。" : `当前有 ${layers.length} 个图层。`, layers, availableOperations: [...AI_SPATIAL_OPERATIONS] };
        }
        if (call.tool === "map.load" || call.tool === "io.read") {
          const absolutePath = textArg(call, "absolutePath") ?? textArg(call, "filePath");
          if (!absolutePath) return failure(call.tool, new SpatialOpError("载入地图需要文件路径。"));
          const loaded = await service.loadFile(absolutePath, textArg(call, "layerName"), writeKnowledge);
          const names = loaded.map((layer) => layer.layerName).join("、");
          const first = loaded[0];
          const loadAuditId = await auditNonSpatial(call, {
            kind: "load",
            action: "load-file",
            inputResources: [absolutePath],
            outputResources: loaded.map((layer) => layer.layerId),
            ok: true,
          }, approvalState);
          return {
            ok: true,
            message: names ? `已载入：${names}。` : "已载入地图。",
            ...(first ? { layerId: first.layerId, layerName: first.layerName, mapUrl: first.mapUrl } : {}),
            layerNames: names,
            operationId: loadAuditId,
          };
        }
        if (call.tool === "map.buffer") {
          // 图层没解析，或距离单位还没通过结构校验时，不调用执行边界。
          // 真正执行缓冲、相交、裁剪、查询、统计时，都先写下 operationId。
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return explainBufferLookup(layer.payload);
          if (typeof call.args.layerId !== "string") return failure(call.tool, new SpatialOpError("图层名必须是字符串。"));
          const outputName = textArg(call, "outputName");
          const unitText = textArg(call, "unit") ?? "";
          const distanceArg = call.args.distance;
          const numericDistance = typeof distanceArg === "number" ? distanceArg : Number.NaN;
          const knowledgeArg = call.args.writeKnowledge;
          const raw = rawBufferInputFromToolArgs({
            layerRef: call.args.layerId,
            distance: numericDistance,
            unit: unitText as BufferDistanceUnit,
            ...(outputName !== null ? { outputName } : {}),
            ...(typeof knowledgeArg === "boolean" ? { writeKnowledge: knowledgeArg } : {}),
          });
          const identity = { layerId: layer.layerId, layerName: layer.layerName };
          const built = raw.input.outputName !== undefined
            ? bufferRequestFromResolution(identity, raw.input.distance, raw.input.unit, raw.input.outputName)
            : bufferRequestFromResolution(identity, raw.input.distance, raw.input.unit);
          if (!built.ok) return failure(call.tool, new SpatialOpError("图层没有解析成唯一身份。"));
          const validation = validateBufferOperation(
            typeof distanceArg === "number" ? built.request : { ...built.request, distance: distanceArg },
          );
          if (!validation.ok) {
            const message = validation.errors.map((item) => item.message).join("");
            return {
              ...failure(call.tool, new SpatialOpError(message || "缓冲请求不合法。")),
              sourceLayerId: layer.layerId,
              sourceLayerName: layer.layerName,
            };
          }
          const request = built.request;
          const policy: ExecutionPolicy = { writeKnowledge };
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation: "buffer",
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy,
            sourceLayer: request.sourceLayer,
            distance: request.distance,
            unit: request.unit,
            outputName: request.outputName ?? null,
          }), {
            sourceLayerId: request.sourceLayer.layerId,
            sourceLayerName: request.sourceLayer.layerName,
          });
        }
        if (call.tool === "map.delete") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          const removed = await service.store.remove(layer.layerId);
          const deleteAuditId = await auditNonSpatial(call, {
            kind: "delete",
            action: "delete-layer",
            inputResources: [layer.layerId],
            ok: removed,
            ...(removed ? {} : { message: "没有删除这个图层。" }),
          }, approvalState);
          return { ok: removed, message: removed ? `已删除图层 ${layer.layerName}。` : "没有删除这个图层。", layerId: layer.layerId, layerName: layer.layerName, action: "delete-layer", operationId: deleteAuditId, ...(approvalState ? { approvalState } : {}) };
        }
        if (call.tool === "map.clearAll") {
          const ids = service.store.list().map((layer) => layer.layerId);
          for (const id of ids) await service.store.remove(id);
          const clearAuditId = await auditNonSpatial(call, {
            kind: "delete",
            action: "clear-layers",
            inputResources: ids,
            ok: true,
          }, approvalState);
          return { ok: true, message: `已清空 ${ids.length} 个图层。`, action: "clear-all", operationId: clearAuditId, ...(approvalState ? { approvalState } : {}) };
        }
        if (call.tool === "map.dropDatabase") {
          await service.dropDatabase();
          const dropAuditId = await auditNonSpatial(call, {
            kind: "delete",
            action: "drop-database",
            ok: true,
          }, approvalState);
          return { ok: true, message: "已清空本地知识库。源数据文件还在。", action: "drop-database", operationId: dropAuditId, ...(approvalState ? { approvalState } : {}) };
        }
        if (call.tool === "map.intersect") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          const other = resolveRequired(service, textArg(call, "otherLayerId"));
          if (!layer.ok) return layer.payload;
          if (!other.ok) return other.payload;
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation: "intersect",
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
            otherLayerId: other.layerId,
            otherLayerName: other.layerName,
            outputName: textArg(call, "outputName"),
          }));
        }
        if (call.tool === "map.clip") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          const other = resolveRequired(service, textArg(call, "otherLayerId"));
          if (!layer.ok) return layer.payload;
          if (!other.ok) return other.payload;
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation: "clip",
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
            otherLayerId: other.layerId,
            otherLayerName: other.layerName,
            outputName: textArg(call, "outputName"),
          }));
        }
        if (call.tool === "map.query") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          const queryKind = textArg(call, "queryKind");
          if (!queryKind) return failure(call.tool, new SpatialOpError("空间查询需要图层和查询种类。"));
          const otherQuery = textArg(call, "otherLayerId");
          let otherId: string | null = null;
          if (otherQuery) {
            const other = resolveRequired(service, otherQuery);
            if (!other.ok) return other.payload;
            otherId = other.layerId;
          }
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation: "query",
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
            otherLayerId: otherId,
            queryKind,
            attributeFilter: textArg(call, "attributeFilter"),
          }));
        }
        if (call.tool === "map.stats") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation: "stats",
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
            fieldName: textArg(call, "fieldName"),
          }));
        }
        // ---- V0.87 能力族：度量 / 几何转换 / 融合 / 属性 / 分幅 ----
        if (call.tool === "map.area" || call.tool === "map.length" || call.tool === "map.qualityCheck") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          const operation = call.tool === "map.area" ? "area" : call.tool === "map.length" ? "length" : "quality-check";
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation,
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
          }));
        }
        if (call.tool === "map.distance" || call.tool === "map.nearest" || call.tool === "map.merge") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          const other = resolveRequired(service, textArg(call, "otherLayerId"));
          if (!other.ok) return other.payload;
          const operation = call.tool === "map.distance" ? "distance" : call.tool === "map.nearest" ? "nearest" : "merge";
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation,
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
            otherLayerId: other.layerId,
            otherLayerName: other.layerName,
            outputName: textArg(call, "outputName"),
          }));
        }
        if (call.tool === "map.convert") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation: "convert",
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
            target: textArg(call, "target"),
            outputName: textArg(call, "outputName"),
          }));
        }
        if (call.tool === "map.dissolve") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation: "dissolve",
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
            groupField: textArg(call, "groupField"),
            outputName: textArg(call, "outputName"),
          }));
        }
        if (call.tool === "map.simplify") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation: "simplify",
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
            tolerance: numberArg(call, "tolerance") ?? 0,
            outputName: textArg(call, "outputName"),
          }));
        }
        if (call.tool === "map.groupStats") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation: "group-stats",
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
            groupField: textArg(call, "groupField"),
            fieldName: textArg(call, "fieldName"),
          }));
        }
        if (call.tool === "map.reclassify") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation: "reclassify",
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
            fieldName: textArg(call, "fieldName"),
            mapping: textArg(call, "mapping"),
            outputName: textArg(call, "outputName"),
          }));
        }
        if (call.tool === "map.splitByGrid") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation: "split-grid",
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
            columns: numberArg(call, "columns") ?? 0,
            rows: numberArg(call, "rows") ?? 0,
            outputName: textArg(call, "outputName"),
          }));
        }
        if (call.tool === "map.voronoi" || call.tool === "map.convexHull" || call.tool === "map.minBBox" || call.tool === "map.centroid") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          const operation = call.tool === "map.voronoi" ? "voronoi" : call.tool === "map.convexHull" ? "convex-hull" : call.tool === "map.minBBox" ? "min-bbox" : "centroid";
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation,
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
            outputName: textArg(call, "outputName"),
          }));
        }
        if (call.tool === "map.splitLine" || call.tool === "map.splitPolygon" || call.tool === "map.spatialAggregate") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          const other = resolveRequired(service, textArg(call, "otherLayerId"));
          if (!other.ok) return other.payload;
          const operation = call.tool === "map.splitLine" ? "split-line" : call.tool === "map.splitPolygon" ? "split-polygon" : "spatial-aggregate";
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation,
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
            otherLayerId: other.layerId,
            otherLayerName: other.layerName,
            ...(call.tool === "map.spatialAggregate" ? { fieldName: textArg(call, "fieldName") } : {}),
            outputName: textArg(call, "outputName"),
          }));
        }
        if (call.tool === "map.vertices") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation: "vertices",
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
            outputName: textArg(call, "outputName"),
          }));
        }
        if (call.tool === "map.lineIntersect") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          const otherText = textArg(call, "otherLayerId");
          const other = otherText ? resolveRequired(service, otherText) : null;
          if (other && !other.ok) return other.payload;
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation: "line-intersect",
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
            ...(other && other.ok ? { otherLayerId: other.layerId, otherLayerName: other.layerName } : {}),
            outputName: textArg(call, "outputName"),
          }));
        }
        if (call.tool === "map.transform") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation: "transform",
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
            target: textArg(call, "kind"),
            distance: numberArg(call, "distance"),
            bearing: numberArg(call, "bearing"),
            angle: numberArg(call, "angle"),
            factor: numberArg(call, "factor"),
            outputName: textArg(call, "outputName"),
          }));
        }
        if (call.tool === "map.nearestOnLine") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          const other = resolveRequired(service, textArg(call, "otherLayerId"));
          if (!other.ok) return other.payload;
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation: "nearest-on-line",
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
            otherLayerId: other.layerId,
            otherLayerName: other.layerName,
            outputName: textArg(call, "outputName"),
          }));
        }
        if (call.tool === "map.grid") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          const cellSize = numberArg(call, "cellSize");
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation: "grid",
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
            ...(typeof cellSize === "number" ? { tolerance: cellSize } : {}),
            outputName: textArg(call, "outputName"),
          }));
        }
        if (call.tool === "map.explode") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation: "explode",
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
            outputName: textArg(call, "outputName"),
          }));
        }
        if (call.tool === "map.distanceMatrix") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          const other = resolveRequired(service, textArg(call, "otherLayerId"));
          if (!other.ok) return other.payload;
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation: "distance-matrix",
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
            otherLayerId: other.layerId,
            otherLayerName: other.layerName,
            limit: numberArg(call, "limit") ?? 10000,
          }));
        }
        if (call.tool === "map.nearestExact") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          const other = resolveRequired(service, textArg(call, "otherLayerId"));
          if (!other.ok) return other.payload;
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation: "nearest-exact",
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
            otherLayerId: other.layerId,
            otherLayerName: other.layerName,
            outputName: textArg(call, "outputName"),
          }));
        }
        if (call.tool === "map.calculateField") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation: "field-calc",
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
            fieldName: textArg(call, "fieldName"),
            mapping: textArg(call, "expression"),
            outputName: textArg(call, "outputName"),
          }));
        }
        if (call.tool === "map.join") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          const other = resolveRequired(service, textArg(call, "otherLayerId"));
          if (!other.ok) return other.payload;
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation: "join",
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
            otherLayerId: other.layerId,
            otherLayerName: other.layerName,
            fieldName: textArg(call, "fieldName"),
            groupField: textArg(call, "otherFieldName"),
            outputName: textArg(call, "outputName"),
          }));
        }
        if (call.tool === "map.interpolate") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation: "interpolate",
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
            fieldName: textArg(call, "fieldName"),
            target: textArg(call, "algorithm"),
          }));
        }
        if (call.tool === "map.erase" || call.tool === "map.union" || call.tool === "map.spatialJoin" || call.tool === "map.snapToNetwork") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          const other = resolveRequired(service, textArg(call, "otherLayerId"));
          if (!other.ok) return other.payload;
          const operation = call.tool === "map.erase" ? "erase" : call.tool === "map.union" ? "union" : call.tool === "map.spatialJoin" ? "spatial-join" : "network-snap";
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation,
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
            otherLayerId: other.layerId,
            otherLayerName: other.layerName,
            outputName: textArg(call, "outputName"),
          }));
        }
        if (call.tool === "map.quadtree" || call.tool === "map.chart" || call.tool === "map.kernelDensity" || call.tool === "map.aggregateGrid") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          const operation = call.tool === "map.quadtree" ? "quadtree" : call.tool === "map.chart" ? "chart" : call.tool === "map.kernelDensity" ? "kernel-density" : "aggregate-grid";
          const bandwidth = numberArg(call, "bandwidth");
          const cellSize = numberArg(call, "cellSize");
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation,
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
            fieldName: textArg(call, "fieldName"),
            ...(bandwidth !== null ? { distance: bandwidth } : {}),
            ...(cellSize !== null ? { tolerance: cellSize } : {}),
            outputName: textArg(call, "outputName"),
          }));
        }
        if (call.tool === "map.networkDistance" || call.tool === "map.serviceArea") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          const lines = resolveRequired(service, textArg(call, "lineLayerId"));
          if (!lines.ok) return lines.payload;
          const other = call.tool === "map.networkDistance" ? resolveRequired(service, textArg(call, "otherLayerId")) : null;
          if (other && !other.ok) return other.payload;
          const distance = numberArg(call, "distance");
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation: call.tool === "map.networkDistance" ? "network-distance" : "service-area",
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
            ...(other && other.ok ? { otherLayerId: other.layerId, otherLayerName: other.layerName } : {}),
            lineLayerId: lines.layerId,
            ...(distance !== null ? { distance } : {}),
            outputName: textArg(call, "outputName"),
          }));
        }
        if (call.tool === "map.viewshed" || call.tool === "map.rasterClip" || call.tool === "map.zonal") {
          const rasterName = textArg(call, "rasterName");
          if (!rasterName) return failure(call.tool, new SpatialOpError("栅格名不能为空。"));
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          const operation = call.tool === "map.viewshed" ? "viewshed" : call.tool === "map.rasterClip" ? "raster-clip" : "zonal";
          const observerHeight = numberArg(call, "observerHeight");
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation,
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: rasterName,
            layerName: rasterName,
            otherLayerId: layer.layerId,
            otherLayerName: layer.layerName,
            ...(observerHeight !== null ? { distance: observerHeight } : {}),
          }));
        }
        if (call.tool === "map.polygonize" || call.tool === "map.resample" || call.tool === "map.focal" || call.tool === "map.rasterIndex") {
          const rasterName = textArg(call, "rasterName");
          if (!rasterName) return failure(call.tool, new SpatialOpError("栅格名不能为空。"));
          const operation = call.tool === "map.polygonize" ? "polygonize" : call.tool === "map.resample" ? "resample" : call.tool === "map.focal" ? "focal" : "raster-index";
          const cellSize = numberArg(call, "cellSize");
          const size = numberArg(call, "size");
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation,
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: rasterName,
            layerName: rasterName,
            otherLayerId: textArg(call, "otherRasterName"),
            ...(cellSize !== null ? { tolerance: cellSize } : {}),
            ...(size !== null ? { size } : {}),
            indexName: textArg(call, "index"),
            outputName: textArg(call, "outputName"),
          }));
        }
        if (call.tool === "map.offsetLine") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          const distance = numberArg(call, "distance");
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation: "offset-line",
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
            ...(distance !== null ? { distance } : {}),
            target: textArg(call, "join"),
            outputName: textArg(call, "outputName"),
          }));
        }
        if (call.tool === "map.costCorridor" || call.tool === "map.classify") {
          const rasterName = textArg(call, "rasterName");
          if (!rasterName) return failure(call.tool, new SpatialOpError("栅格名不能为空。"));
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          const corridor = call.tool === "map.costCorridor";
          const end = corridor ? resolveRequired(service, textArg(call, "otherLayerId")) : null;
          if (end && !end.ok) return end.payload;
          const tolerance = numberArg(call, corridor ? "tolerance" : "testFraction");
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation: corridor ? "cost-corridor" : "classify",
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: rasterName,
            layerName: rasterName,
            otherLayerId: layer.layerId,
            otherLayerName: layer.layerName,
            ...(end && end.ok ? { targetLayerId: end.layerId } : {}),
            ...(tolerance !== null ? { tolerance } : {}),
            fieldName: textArg(call, "fieldName"),
            target: textArg(call, "method"),
            outputName: textArg(call, "outputName"),
          }));
        }
        if (call.tool === "map.kriging") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          const cellSize = numberArg(call, "cellSize");
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation: "kriging",
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
            fieldName: textArg(call, "fieldName"),
            ...(cellSize !== null ? { tolerance: cellSize } : {}),
          }));
        }
        if (call.tool === "map.watershed" || call.tool === "map.profile" || call.tool === "map.cutFill" || call.tool === "map.waterLevel") {
          const rasterName = textArg(call, "rasterName");
          if (!rasterName) return failure(call.tool, new SpatialOpError("栅格名不能为空。"));
          if (call.tool === "map.cutFill") {
            const otherRasterName = textArg(call, "otherRasterName");
            if (!otherRasterName) return failure(call.tool, new SpatialOpError("填挖方需要第二个栅格名。"));
            return finishGis(service, call.tool, withProvenance(call, {
              entry,
              operation: "cut-fill",
              ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
              policy: { writeKnowledge },
              layerId: rasterName,
              layerName: rasterName,
              otherLayerId: otherRasterName,
              otherLayerName: otherRasterName,
            }));
          }
          if (call.tool === "map.waterLevel") {
            const waterLevel = numberArg(call, "waterLevel");
            return finishGis(service, call.tool, withProvenance(call, {
              entry,
              operation: "water-level",
              ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
              policy: { writeKnowledge },
              layerId: rasterName,
              layerName: rasterName,
              ...(waterLevel !== null ? { distance: waterLevel } : {}),
            }));
          }
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation: call.tool === "map.watershed" ? "watershed" : "profile",
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: rasterName,
            layerName: rasterName,
            otherLayerId: layer.layerId,
            otherLayerName: layer.layerName,
            outputName: textArg(call, "outputName"),
          }));
        }
        if (call.tool === "map.layerStack") {
          const names = (textArg(call, "layerIds") ?? "").split(/[,，;；]/).map((item) => item.trim()).filter((item) => item !== "");
          if (names.length < 2) return failure(call.tool, new SpatialOpError("爆炸图需要至少两个已载入的图层。图层不够时不登记，也不出图。"));
          const gap = numberArg(call, "gap");
          if (gap === null || gap < 0) return failure(call.tool, new SpatialOpError("爆炸图需要大于或等于 0 的层间竖向间距。没写间距就不登记。"));
          const resolved: { layerId: string; layerName: string }[] = [];
          for (const name of names) {
            const layer = resolveRequired(service, name);
            if (!layer.ok) return layer.payload;
            resolved.push({ layerId: layer.layerId, layerName: layer.layerName });
          }
          const first = resolved[0];
          if (!first) return failure(call.tool, new SpatialOpError("爆炸图需要至少两个已载入的图层。图层不够时不登记，也不出图。"));
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation: "layer-stack",
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: first.layerId,
            layerName: first.layerName,
            mapping: resolved.map((item) => item.layerId).join(","),
            distance: gap,
          }));
        }
        if (call.tool === "map.geologyInputs") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation: "geology-inputs",
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
            fieldName: textArg(call, "fieldName"),
            groupField: textArg(call, "groupField"),
            target: textArg(call, "target"),
          }));
        }
        if (call.tool === "map.rainfallRunoff" || call.tool === "map.rainfallLandslide") {
          const rasterName = textArg(call, "rasterName");
          if (!rasterName) return failure(call.tool, new SpatialOpError("栅格名不能为空。"));
          const runoff = call.tool === "map.rainfallRunoff";
          const keys = runoff
            ? ["manning", "simulationHours", "steps", "depthThreshold"]
            : ["cohesion", "frictionAngle", "unitWeight", "diffusivity", "ksat", "soilDepth", "waterTableDepth", "backgroundRate", "steps"];
          const settings = keys.flatMap((key) => {
            const raw = call.args[key];
            const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw.trim()) : Number.NaN;
            return Number.isFinite(value) ? [`${key}=${value}`] : [];
          }).join(";");
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation: runoff ? "rainfall-runoff" : "rainfall-landslide",
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: rasterName,
            layerName: rasterName,
            target: textArg(call, "scenarios"),
            mapping: settings,
            ...(runoff ? { op: textArg(call, "boundary") } : {}),
          }));
        }
        if (call.tool === "map.geologyModel") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          const depth = numberArg(call, "depth");
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation: "geology-model",
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
            otherLayerId: textArg(call, "rasterName"),
            ...(depth !== null ? { distance: depth } : {}),
          }));
        }
        if (call.tool === "map.hotspot" || call.tool === "map.gwr" || call.tool === "map.kAnonymize") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          const lineName = call.tool === "map.hotspot" ? textArg(call, "lineLayerId") : null;
          const lines = lineName ? resolveRequired(service, lineName) : null;
          if (lines && !lines.ok) return lines.payload;
          const distance = numberArg(call, call.tool === "map.gwr" ? "bandwidth" : "distance");
          const k = numberArg(call, "k");
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation: call.tool === "map.hotspot" ? "hotspot" : call.tool === "map.gwr" ? "gwr" : "k-anonymity",
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
            fieldName: textArg(call, "fieldName"),
            ...(distance !== null ? { distance } : {}),
            ...(lines && lines.ok ? { lineLayerId: lines.layerId } : {}),
            predictors: textArg(call, "predictors"),
            target: textArg(call, "kernel"),
            adaptive: call.args.adaptive !== false,
            ...(k !== null ? { k } : {}),
            outputName: textArg(call, "outputName"),
          }));
        }
        if (call.tool === "map.odFlow" || call.tool === "map.dpGrid") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          const other = resolveRequired(service, textArg(call, "otherLayerId"));
          if (!other.ok) return other.payload;
          const lineName = call.tool === "map.odFlow" ? textArg(call, "lineLayerId") : null;
          const lines = lineName ? resolveRequired(service, lineName) : null;
          if (lines && !lines.ok) return lines.payload;
          const beta = numberArg(call, "beta");
          const targetMean = numberArg(call, "targetMean");
          const epsilon = numberArg(call, "epsilon");
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation: call.tool === "map.odFlow" ? "od-flow" : "dp-grid",
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
            otherLayerId: other.layerId,
            otherLayerName: other.layerName,
            fieldName: textArg(call, "fieldName"),
            groupField: textArg(call, "otherFieldName"),
            ...(lines && lines.ok ? { lineLayerId: lines.layerId } : {}),
            target: textArg(call, "deterrence"),
            ...(beta !== null ? { beta } : {}),
            ...(targetMean !== null ? { targetMean } : {}),
            ...(epsilon !== null ? { epsilon } : {}),
            outputName: textArg(call, "outputName"),
          }));
        }
        if (call.tool === "map.rasterize") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          const cellSize = numberArg(call, "cellSize");
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation: "rasterize",
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
            ...(cellSize !== null ? { tolerance: cellSize } : {}),
          }));
        }
        if (call.tool === "map.exportMap") {
          return { ok: true, action: "export-map", message: "已请求导出当前地图。" };
        }
        if (call.tool === "map.bearing") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          const other = resolveRequired(service, textArg(call, "otherLayerId"));
          if (!other.ok) return other.payload;
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation: "bearing",
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
            otherLayerId: other.layerId,
            otherLayerName: other.layerName,
            outputName: textArg(call, "outputName"),
          }));
        }
        if (call.tool === "map.exportCoordinates") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
          const safe = layer.layerName.replace(/[<>:"/\\|?*]/g, "_").slice(0, 40) || "layer";
          const destination = resolve(join("var", "exports", `${safe}-coords-${stamp}.csv`));
          await mkdir(dirname(destination), { recursive: true });
          const result = await service.exportCoordinates(layer.layerId, destination);
          const coordsAuditId = await auditNonSpatial(call, {
            kind: "export",
            action: "export-coordinates",
            inputResources: [layer.layerId],
            outputResources: [destination],
            ok: true,
          }, approvalState);
          return { ...toolPayload(result), operationId: coordsAuditId };
        }
        if (call.tool === "map.makeValid" || call.tool === "map.reproject" || call.tool === "map.convertFormat") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          const operation = call.tool === "map.makeValid" ? "make-valid" : call.tool === "map.reproject" ? "reproject" : "convert-format";
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation,
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: layer.layerId,
            layerName: layer.layerName,
            targetCrs: textArg(call, "targetCrs"),
            format: textArg(call, "format"),
            outputName: textArg(call, "outputName"),
          }));
        }
        if (call.tool === "map.rasterInfo" || call.tool === "map.demDerivative" || call.tool === "map.rasterCalc" || call.tool === "map.contour" || call.tool === "map.rasterCast" || call.tool === "map.rasterNoData" || call.tool === "map.rasterSmooth") {
          // 栅格按裸文件名引用。解析发生在当前对话工作区，模型不传路径。
          const rasterName = textArg(call, "rasterName");
          if (!rasterName) return failure(call.tool, new SpatialOpError("栅格名不能为空。"));
          const operation = call.tool === "map.rasterInfo" ? "raster-info"
            : call.tool === "map.demDerivative" ? "dem-derivative"
              : call.tool === "map.rasterCalc" ? "raster-calc"
                : call.tool === "map.rasterCast" ? "raster-cast"
                  : call.tool === "map.rasterNoData" ? "raster-nodata"
                    : call.tool === "map.rasterSmooth" ? "raster-smooth"
                      : "contour";
          const noData = numberArg(call, "noData");
          return finishGis(service, call.tool, withProvenance(call, {
            entry,
            operation,
            ...(operationsRoot !== undefined ? { root: operationsRoot } : {}),
            policy: { writeKnowledge },
            layerId: rasterName,
            layerName: rasterName,
            otherLayerId: textArg(call, "otherRasterName"),
            derivative: textArg(call, "derivative"),
            ...(call.tool === "map.contour" ? { interval: numberArg(call, "interval") ?? 0 } : {}),
            ...(call.tool === "map.rasterCast" ? { target: textArg(call, "outputType") } : {}),
            ...(typeof noData === "number" ? { noData } : {}),
            op: textArg(call, "op"),
            outputName: textArg(call, "outputName"),
          }));
        }
        if (call.tool === "map.style") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          const patch = stylePatch(call);
          if (Object.keys(patch).length === 0) return failure(call.tool, new SpatialOpError("改样式需要填充色、轮廓色、宽度、透明度、分类字段或注记字段中的至少一项。"));
          const style = await service.store.updateStyle(layer.layerId, patch);
          return { ok: true, message: `已更新图层 ${layer.layerName} 的样式。`, layerId: layer.layerId, layerName: layer.layerName, fill: style.fill, outline: style.outline, width: style.width, opacity: style.opacity };
        }
        if (call.tool === "map.setVisibility") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          const visible = call.args.visible;
          if (typeof visible !== "boolean") return failure(call.tool, new SpatialOpError("需要指定显示或隐藏。"));
          await service.store.updateStyle(layer.layerId, { visible });
          return { ok: true, message: visible ? `已显示图层 ${layer.layerName}。` : `已隐藏图层 ${layer.layerName}。`, layerId: layer.layerId, layerName: layer.layerName, visible };
        }
        if (call.tool === "map.setOrder") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          const place = (textArg(call, "place") ?? "top").toLowerCase();
          const current = [...service.store.order()];
          const index = current.indexOf(layer.layerId);
          const rest = current.filter((id) => id !== layer.layerId);
          let next: string[] = [layer.layerId, ...rest];
          if (place === "bottom") next = [...rest, layer.layerId];
          else if (place === "up" && index > 0) {
            const copy = [...current];
            const [item] = copy.splice(index, 1);
            if (item) copy.splice(index - 1, 0, item);
            next = copy;
          } else if (place === "down" && index >= 0 && index < current.length - 1) {
            const copy = [...current];
            const [item] = copy.splice(index, 1);
            if (item) copy.splice(index + 1, 0, item);
            next = copy;
          }
          const order = await service.store.setOrder(next);
          return { ok: true, message: `已调整图层 ${layer.layerName} 的叠放顺序。`, layerId: layer.layerId, layerName: layer.layerName, order: order.join(",") };
        }
        if (call.tool === "map.zoomToLayer") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          return { ok: true, action: "zoom-to-layer", message: `已请求缩放到图层 ${layer.layerName}。`, layerId: layer.layerId, layerName: layer.layerName };
        }
        if (call.tool === "map.exportGeoJson") {
          const layer = resolveRequired(service, textArg(call, "layerId"));
          if (!layer.ok) return layer.payload;
          const destination = textArg(call, "destinationPath") ?? defaultExportPath(layer.layerName);
          await mkdir(dirname(destination), { recursive: true });
          const result = await service.exportLayer(layer.layerId, destination);
          const exportAuditId = await auditNonSpatial(call, {
            kind: "export",
            action: "export-geojson",
            inputResources: [layer.layerId],
            outputResources: [destination],
            ok: true,
          }, approvalState);
          return { ...toolPayload(result), destinationPath: destination, operationId: exportAuditId };
        }
      } catch (error) {
        // 非空间状态变更失败同样留痕（留痕契约：失败操作同样留痕）。
        const audit = nonSpatialActionOf(call.tool);
        if (audit) {
          try {
            const failedAuditId = await auditNonSpatial(call, {
              kind: audit.kind,
              action: audit.action,
              ok: false,
              message: error instanceof Error ? error.message : "操作没有完成。",
            }, approvalState);
            return { ...failure(call.tool, error), operationId: failedAuditId };
          } catch {
            // 留痕失败不阻断错误返回。
          }
        }
        return failure(call.tool, error);
      }
      return inner.execute(call);
  }
}
