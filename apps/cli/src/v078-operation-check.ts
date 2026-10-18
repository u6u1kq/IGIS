// SPDX-License-Identifier: Apache-2.0

/**
 * V0.78 操作记录、执行边界和回退。
 * 只用操作系统临时目录，不读仓库 var/，不监听端口。
 * 运行：npx tsx --tsconfig tsconfig.json apps/cli/src/v078-operation-check.ts
 */

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { executeMcpTool } from "@igis/mcp-server";
import type { ToolAdapterPort } from "@igis/llm-dispatch";
import { createSpatialAwareAdapter } from "../../../packages/spatial-ops/src/adapter.js";
import { rollbackOperation } from "../../../packages/spatial-ops/src/execute-gis-operation.js";
import { readOperationRecord } from "../../../packages/spatial-ops/src/operation-attempt.js";
import type { OperationRecord } from "../../../packages/spatial-ops/src/operation-attempt.js";
import { openSpatialStack } from "../../../packages/spatial-ops/src/service.js";
import type { SpatialStack, SpatialStackOptions } from "../../../packages/spatial-ops/src/service.js";
import type { MapCollection } from "../../../packages/spatial-ops/src/types.js";
import { assistantChatMessage, ConversationStore } from "./conversations.js";
import { runGdl } from "./gdl-http.js";
import type { GdlDeps } from "./gdl-http.js";
import { handleV05Request } from "./map-http.js";
import { rollbackChatTurn } from "./turn-rollback.js";

const REPO_ROOT = resolve("E:/ai工作区/Igis");

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

function square(name: string, dx: number, value = 1): MapCollection {
  const x0 = dx;
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { name, amount: value },
      geometry: { type: "Polygon", coordinates: [[[x0, 0], [x0, 1], [x0 + 1, 1], [x0 + 1, 0], [x0, 0]]] },
    }],
  };
}

async function openAt(root: string, name: string, extra: Partial<SpatialStackOptions> = {}): Promise<SpatialStack & { readonly dir: string }> {
  const dir = join(root, name);
  check(resolve(dir).toLowerCase().startsWith(resolve(root).toLowerCase()), "用例目录必须在临时目录里");
  check(!resolve(dir).toLowerCase().startsWith(REPO_ROOT.toLowerCase()), "用例目录不能落在仓库里");
  const stack = await openSpatialStack({
    layerDirectory: join(dir, "layers"),
    auditDirectory: join(dir, "audit"),
    cacheDirectory: join(dir, "cache"),
    modelName: () => "v078-check",
    ...extra,
  });
  return { ...stack, dir };
}

function innerAdapter(): ToolAdapterPort {
  return { execute: () => Promise.resolve({ ok: false, message: "内层工具没有执行。" }) };
}

function toolBody(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "工具结果应是对象");
  return value as Record<string, unknown>;
}

async function readRecord(root: string, operationId: string): Promise<OperationRecord> {
  const record = await readOperationRecord(operationId, root);
  check(record, `找不到操作记录 ${operationId}`);
  const file = join(root, "var", "operations", `${operationId}.json`);
  const text = await readFile(file, { encoding: "utf8" });
  check(!text.includes('"coordinates"'), "操作记录不能含坐标");
  check(resolve(file).toLowerCase().startsWith(resolve(root).toLowerCase()), "记录必须在临时目录");
  return record;
}

function assertIdentity(record: OperationRecord, layerId?: string): void {
  check(record.operationId.startsWith("op-") && record.operationId.split("-").length >= 3, "operationId 不能只是时间戳");
  check(!record.auditRecordIds.includes(record.operationId), "operationId 不能等于审计 id");
  check(record.error?.auditRecordId !== record.operationId, "错误里的审计 id 不能等于 operationId");
  if (layerId) check(record.operationId !== layerId, "operationId 不能等于图层 id");
  for (const id of record.sideEffects.createdLayerIds ?? []) check(id !== record.operationId, "新建图层不能拿 operationId 当标识");
}

async function auditExists(dir: string, auditRecordId: string): Promise<boolean> {
  try {
    await stat(join(dir, "audit", `${auditRecordId}.json`));
    return true;
  } catch {
    return false;
  }
}

function jsonRequest(body: unknown): IncomingMessage {
  const text = JSON.stringify(body);
  const request = {
    method: "POST",
    headers: {},
    resume() {},
    async *[Symbol.asyncIterator]() {
      yield text;
    },
  };
  return request as IncomingMessage;
}

function captureResponse(): { readonly response: ServerResponse; readonly read: () => { readonly status: number; readonly body: Record<string, unknown> } } {
  let status = 0;
  let raw = "";
  const response = {
    writeHead(code: number) {
      status = code;
    },
    end(body?: string) {
      raw = body ?? "";
    },
  };
  return {
    response: response as ServerResponse,
    read: () => ({ status, body: JSON.parse(raw) as Record<string, unknown> }),
  };
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "igis-v078-"));
  check(!resolve(root).toLowerCase().startsWith(REPO_ROOT.toLowerCase()), "临时目录不能在仓库里");
  try {
    const stack = await openAt(root, "stack");
    const area = await stack.catalog.insert({
      layerName: "地块",
      sourcePaths: ["memory"],
      collection: square("甲", 0, 4),
      crsLabel: "EPSG:4326",
    });
    const other = await stack.catalog.insert({
      layerName: "用地",
      sourcePaths: ["memory"],
      collection: square("乙", 0.2, 9),
      crsLabel: "EPSG:4326",
    });
    const undeclared = await stack.catalog.insert({
      layerName: "未声明块",
      sourcePaths: ["memory"],
      collection: square("丙", 3, 1),
      crsLabel: "未声明",
    });

    const chat = createSpatialAwareAdapter(innerAdapter(), stack.service, { entry: "chat", operationsRoot: root });
    const buffered = toolBody(await chat.execute({ tool: "map.buffer", args: { layerId: area.layerId, distance: 20, unit: "meters" } }));
    check(buffered.ok === true && typeof buffered.operationId === "string" && typeof buffered.layerId === "string", "聊天缓冲应返回 operationId 和图层");
    check(typeof buffered.message === "string" && buffered.layerId !== "", "聊天缓冲保留 message 和 layer");
    const success = await readRecord(root, buffered.operationId);
    check(success.statusLog[0] === "running" && success.status === "succeeded" && success.statusLog.includes("succeeded"), "缓冲应先 running 再 succeeded");
    check(success.entry === "chat" && success.operation === "buffer", "聊天缓冲记录入口和种类");
    check(success.request.layerIds.includes(area.layerId) && success.request.distance === 20, "请求摘要只有已解析图层和标量");
    check(success.policy.writeKnowledge === false && !("writeKnowledge" in success.request), "策略和几何请求分开");
    check(success.sideEffects.createdLayerIds?.includes(String(buffered.layerId)) === true, "新建图层记在记录上");
    check((success.sideEffects.cacheKeys?.length ?? 0) > 0, "这次写出的缓存键记在记录上");
    assertIdentity(success, String(buffered.layerId));
    const successAudit = success.auditRecordIds[0];
    check(typeof successAudit === "string" && successAudit !== success.operationId, "成功审计 id 和 operationId 分开");
    console.log("ok 缓冲成功 running→succeeded");

    const failedCall = toolBody(await chat.execute({ tool: "map.buffer", args: { layerId: undeclared.layerId, distance: 15, unit: "meters" } }));
    check(failedCall.ok === false && typeof failedCall.operationId === "string", "失败缓冲仍返回 operationId");
    const failed = await readRecord(root, failedCall.operationId);
    check(failed.status === "failed" && failed.outcome === "failed", "GIS 失败状态是 failed");
    check(failed.statusLog[0] === "running", "失败前也写下 running");
    const failedAudit = failed.auditRecordIds[0] ?? failed.error?.auditRecordId;
    check(typeof failedAudit === "string" && failedAudit !== failed.operationId, "失败保留审计 id");
    check(await auditExists(stack.dir, failedAudit), "失败审计文件还在");
    assertIdentity(failed, undeclared.layerId);
    console.log("ok 缓冲失败保留 operationId 和审计");

    const mapCapture = captureResponse();
    const handled = await handleV05Request({
      spatial: stack,
      vendorRoot: join(root, "vendor"),
      operationsRoot: root,
    }, jsonRequest({ operation: "buffer", layerId: area.layerId, distance: 30, unit: "meters", writeKnowledge: false }), mapCapture.response, new URL("http://127.0.0.1/api/spatial/run"));
    const mapBody = mapCapture.read().body;
    check(handled && mapBody.ok === true && typeof mapBody.operationId === "string" && typeof mapBody.message === "string", "地图缓冲返回 operationId，并保留 ok 和 message");
    check(mapBody.layer !== null && typeof mapBody.layer === "object", "地图缓冲保留 layer");
    const mapRecord = await readRecord(root, String(mapBody.operationId));
    check(mapRecord.entry === "map" && mapRecord.status === "succeeded", "地图缓冲写入记录");
    console.log("ok 地图 HTTP 缓冲");

    const gdlDeps: GdlDeps = {
      spatial: stack,
      gdlDirectory: join(root, "gdl"),
      addRag: () => Promise.resolve(undefined),
      operationsRoot: root,
    };
    const gdl = await runGdl(gdlDeps, "BUFFER 地块 25 m AS 地块缓冲", { llm: false, writeKnowledge: false });
    check(typeof gdl.operationId === "string" && gdl.layers.length > 0, "GDL 缓冲返回 operationId 和图层");
    const gdlRecord = await readRecord(root, gdl.operationId ?? "");
    check(gdlRecord.entry === "gdl" && gdlRecord.operation === "buffer" && gdlRecord.status === "succeeded", "GDL 缓冲不再跳过记录");
    console.log("ok GDL 缓冲");

    const mcpAdapter = createSpatialAwareAdapter(innerAdapter(), stack.service, { entry: "mcp", operationsRoot: root });
    const mcp = await executeMcpTool(mcpAdapter, "map_buffer", { layerId: area.layerId, distance: 40, unit: "meters" });
    const mcpBody = JSON.parse(mcp.text) as { readonly ok?: boolean; readonly operationId?: string; readonly message?: string; readonly layerId?: string };
    check(mcp.ok && mcpBody.ok === true && typeof mcpBody.operationId === "string" && typeof mcpBody.message === "string", "MCP 缓冲返回 operationId，并保留 ok 和 message");
    const mcpRecord = await readRecord(root, mcpBody.operationId ?? "");
    check(mcpRecord.entry === "mcp" && mcpRecord.status === "succeeded", "MCP 与聊天共用边界，入口记为 mcp");
    console.log("ok MCP 缓冲");

    const intersected = toolBody(await chat.execute({
      tool: "map.intersect",
      args: { layerId: area.layerId, otherLayerId: other.layerId },
    }));
    check(intersected.ok === true && typeof intersected.operationId === "string" && typeof intersected.layerId === "string", "相交成功带 operationId");
    const intersectRecord = await readRecord(root, intersected.operationId);
    check(intersectRecord.operation === "intersect" && intersectRecord.status === "succeeded", "相交记录已落盘");
    check(intersectRecord.sideEffects.createdLayerIds?.includes(String(intersected.layerId)) === true, "相交结果图层在记录上");
    const intersectFail = toolBody(await chat.execute({
      tool: "map.intersect",
      args: { layerId: area.layerId, otherLayerId: undeclared.layerId },
    }));
    check(intersectFail.ok === false && typeof intersectFail.operationId === "string", "相交失败仍有 operationId");
    const intersectFailed = await readRecord(root, intersectFail.operationId);
    check(intersectFailed.status === "failed" && typeof intersectFailed.error?.auditRecordId === "string", "相交失败保留审计 id");
    console.log("ok 相交成功和失败");

    const clipped = toolBody(await chat.execute({
      tool: "map.clip",
      args: { layerId: area.layerId, otherLayerId: other.layerId },
    }));
    check(clipped.ok === true && typeof clipped.operationId === "string", "裁剪成功带 operationId");
    const clipRecord = await readRecord(root, clipped.operationId);
    check(clipRecord.operation === "clip" && clipRecord.status === "succeeded" && (clipRecord.sideEffects.createdLayerIds?.length ?? 0) > 0, "裁剪记录含新建图层");
    const clipCapture = captureResponse();
    await handleV05Request({
      spatial: stack,
      vendorRoot: join(root, "vendor"),
      operationsRoot: root,
    }, jsonRequest({ operation: "clip", layerId: area.layerId, otherLayerId: "missing-layer" }), clipCapture.response, new URL("http://127.0.0.1/api/spatial/run"));
    const clipFail = clipCapture.read().body;
    check(clipFail.ok === false && typeof clipFail.operationId === "string" && typeof clipFail.auditRecordId === "string", "地图裁剪失败带 operationId 和审计 id");
    const clipFailed = await readRecord(root, String(clipFail.operationId));
    check(clipFailed.status === "failed" && clipFailed.entry === "map", "裁剪失败记录已落盘");
    console.log("ok 裁剪成功和失败");

    const queried = toolBody(await chat.execute({
      tool: "map.query",
      args: { layerId: area.layerId, queryKind: "属性", attributeFilter: "name=甲" },
    }));
    check(queried.ok === true && typeof queried.operationId === "string" && typeof queried.layerId === "string", "查询成功带 operationId 和图层");
    const queryRecord = await readRecord(root, queried.operationId);
    check(queryRecord.operation === "query" && queryRecord.status === "succeeded", "查询记录已落盘");
    const queryCapture = captureResponse();
    await handleV05Request({
      spatial: stack,
      vendorRoot: join(root, "vendor"),
      operationsRoot: root,
    }, jsonRequest({ operation: "query", layerId: area.layerId, queryKind: "不存在的种类" }), queryCapture.response, new URL("http://127.0.0.1/api/spatial/run"));
    const queryFail = queryCapture.read().body;
    check(queryFail.ok === false && typeof queryFail.operationId === "string" && typeof queryFail.auditRecordId === "string", "查询失败保留 operationId 和审计 id");
    const queryFailed = await readRecord(root, String(queryFail.operationId));
    check(queryFailed.status === "failed", "查询失败记录已落盘");
    console.log("ok 查询成功和失败");

    const statsCapture = captureResponse();
    await handleV05Request({
      spatial: stack,
      vendorRoot: join(root, "vendor"),
      operationsRoot: root,
    }, jsonRequest({ operation: "stats", layerId: area.layerId, fieldName: "amount" }), statsCapture.response, new URL("http://127.0.0.1/api/spatial/run"));
    const statsBody = statsCapture.read().body;
    check(statsBody.ok === true && typeof statsBody.operationId === "string" && typeof statsBody.auditRecordId === "string", "统计同时返回 operationId 和 auditRecordId");
    check(typeof statsBody.message === "string", "统计保留 message");
    const statsRecord = await readRecord(root, String(statsBody.operationId));
    check(statsRecord.operation === "stats" && statsRecord.status === "succeeded" && statsRecord.auditRecordIds.includes(String(statsBody.auditRecordId)), "统计记录同时有两个 id");
    check(statsRecord.operationId !== statsBody.auditRecordId, "统计的 operationId 不是审计 id");
    console.log("ok 统计成功");

    const created = success.sideEffects.createdLayerIds?.[0];
    check(typeof created === "string", "回退前记录上有结果图层");
    const rolled = await rollbackOperation(success.operationId, {
      root,
      removeLayer: (layerId) => stack.catalog.remove(layerId),
      deleteKnowledge: async () => false,
      dropCacheKey: (key, resultLayerIds) => stack.service.dropOwnedCacheKey(key, resultLayerIds),
      deleteSuccessAudit: (recordId) => stack.audit.remove(recordId),
    });
    check(rolled.status === "rolled_back" && rolled.ok, "回退完成应为 rolled_back");
    check(stack.catalog.get(created) === null, "回退删掉这次新建的图层");
    const rolledRecord = await readRecord(root, success.operationId);
    check(rolledRecord.status === "rolled_back", "记录状态是 rolled_back");
    const again = await stack.service.buffer(area.layerId, 20, "meters", false);
    check(again.cached !== true && again.layer?.layerId !== created, "再次缓冲不能从缓存复活已回退的图层");
    check(stack.catalog.get(created) === null, "旧结果图层没有回来");
    console.log("ok 回退后缓存不复活图层");

    const keptAudit = await rollbackOperation(failed.operationId, {
      root,
      removeLayer: (layerId) => stack.catalog.remove(layerId),
      deleteKnowledge: async () => false,
      dropCacheKey: (key, resultLayerIds) => stack.service.dropOwnedCacheKey(key, resultLayerIds),
      deleteSuccessAudit: (recordId) => stack.audit.remove(recordId),
    });
    check(keptAudit.status === "rolled_back", "没有可删副作用的失败操作可以 rolled_back");
    check(keptAudit.remaining.some((item) => item.kind === "audit" && item.id === failedAudit && item.state === "kept"), "失败审计列为保留");
    check(await auditExists(stack.dir, failedAudit), "回退不删除失败审计");
    console.log("ok 失败审计保留");

    const doomed = toolBody(await chat.execute({ tool: "map.buffer", args: { layerId: other.layerId, distance: 55, unit: "meters" } }));
    check(typeof doomed.operationId === "string" && typeof doomed.layerId === "string", "注入失败前先有一次成功缓冲");
    const doomedLayer = String(doomed.layerId);
    const broken = await rollbackOperation(String(doomed.operationId), {
      root,
      removeLayer: async (layerId) => {
        throw new Error(`清理失败:${layerId}`);
      },
      deleteKnowledge: async () => false,
      dropCacheKey: (key, resultLayerIds) => stack.service.dropOwnedCacheKey(key, resultLayerIds),
      deleteSuccessAudit: (recordId) => stack.audit.remove(recordId),
    });
    check(broken.status === "rollback_failed" && broken.ok === false, "清理失败是 rollback_failed，不是 GIS failed");
    check(broken.remaining.some((item) => item.kind === "layer" && item.id === doomedLayer && item.state === "failed"), "未完成项点名仍在的图层");
    check(stack.catalog.get(doomedLayer) !== null, "清理失败时图层还在");
    const brokenRecord = await readRecord(root, String(doomed.operationId));
    check(brokenRecord.status === "rollback_failed" && brokenRecord.outcome === "succeeded", "GIS 已成功，回退失败单独标记");
    console.log("ok 注入清理失败");

    const legacyLayer = await stack.catalog.insert({
      layerName: "旧结果",
      sourcePaths: ["memory"],
      collection: square("旧", 8, 2),
      crsLabel: "EPSG:4326",
    });
    const conversations = new ConversationStore(join(root, "conversations"), join(root, "legacy-messages.json"));
    await conversations.load();
    const conversationFile = join(root, "conversations", `${conversations.active().id}.json`);
    await conversations.append([
      { role: "user", text: "旧的一轮", at: new Date().toISOString() },
      assistantChatMessage({
        text: "只按图层清单回退",
        at: new Date().toISOString(),
        createdLayerIds: [legacyLayer.layerId],
        resultLayers: [{ layerId: legacyLayer.layerId, layerName: legacyLayer.layerName }],
      }),
    ]);
    let sawMessageDuringCleanup = false;
    const legacy = await rollbackChatTurn({
      conversations,
      removeLayer: async (layerId) => {
        const text = await readFile(conversationFile, { encoding: "utf8" });
        sawMessageDuringCleanup = text.includes("只按图层清单回退");
        return stack.catalog.remove(layerId);
      },
      deleteRag: async () => false,
      deleteAudit: async () => false,
    });
    check(sawMessageDuringCleanup, "删除图层时对话还没有被截短");
    check(legacy.ok && stack.catalog.get(legacyLayer.layerId) === null, "只有 createdLayerIds 的旧消息仍能删图层");
    check(!conversations.messages().some((item) => item.text === "只按图层清单回退"), "清理完成之后才去掉这一轮");
    console.log("ok 旧消息仍按图层回退");

    check(success.operationId !== intersectRecord.operationId, "多步各自有 operationId，没有合成一个");
    console.log("ok 多步独立 operationId");
    console.log("v078-operation-check passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

let failed: unknown = null;
try {
  await main();
} catch (error) {
  failed = error;
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
}
if (failed) throw new Error("v078-operation-check failed");
