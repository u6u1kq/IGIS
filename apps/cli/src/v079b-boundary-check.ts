// SPDX-License-Identifier: Apache-2.0

/**
 * V0.79-B 数据边界实现检查。
 * 只用操作系统临时目录，不读仓库 var/，不监听端口，不调用真实模型。
 * 运行：npx tsx --tsconfig tsconfig.json apps/cli/src/v079b-boundary-check.ts
 */

import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GIS_TOOL_REGISTRY, runLlmToolCallLoop, runLocalFirstTurn } from "@igis/llm-dispatch";
import type { DispatchInput, LlmHttp, ToolAdapterPort } from "@igis/llm-dispatch";
import { executeMcpTool } from "@igis/mcp-server";
import { readOperationRecord } from "../../../packages/spatial-ops/src/operation-attempt.js";
import { openSpatialStack } from "../../../packages/spatial-ops/src/service.js";
import type { SpatialService, SpatialStack, SpatialStackOptions } from "../../../packages/spatial-ops/src/service.js";
import type { MapCollection } from "../../../packages/spatial-ops/src/types.js";
import { createSpatialAwareAdapter } from "../../../packages/spatial-ops/src/adapter.js";
import { handleV05Request } from "./map-http.js";

const REPO_ROOT = resolve("E:/ai工作区/Igis");
const WKB = "0101000000000000000000F03F0000000000000040";
const JSON_GEOM = '{"type":"Point","coordinates":[118.75,41.25831]}';
const PATH = "C:\\secret\\data.gpkg";

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

function square(): MapCollection {
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { name: "甲" },
      geometry: { type: "Polygon", coordinates: [[[118.75, 41.25831], [118.75, 41.26831], [118.77, 41.26831], [118.77, 41.25831], [118.75, 41.25831]]] },
    }],
  };
}

function toolResponse(name: string, args: unknown): { ok: true; status: 200; text: () => Promise<string> } {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify({
      choices: [{
        message: {
          content: null,
          tool_calls: [{ id: "call-1", type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
      }],
    })),
  };
}

function textDone(): { ok: true; status: 200; text: () => Promise<string> } {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify({ choices: [{ message: { content: "好" } }] })),
  };
}

function caller(fetchImpl: LlmHttp, adapter: ToolAdapterPort) {
  return {
    providerId: "local" as const,
    model: "fake-model",
    baseUrl: "http://127.0.0.1:9/v1",
    timeoutMs: 2000,
    fetchImpl,
    adapter,
  };
}

function leakInput(): DispatchInput {
  return {
    instruction: `缓冲地块。POINT(118.75 41.25831) ${JSON_GEOM}`,
    originalText: JSON_GEOM,
    pendingSummary: "POINT(118.75 41.25831)",
    metadata: [{
      layerName: "地块",
      fieldNames: ["地块编号", "手机号"],
      crs: "CRS_LEAK_LABEL",
      featureCount: 3,
      extent: [118.75, 41.25831, 118.77, 41.26831],
      style: null,
    }],
    kgHits: [{ operation: "buffer", tool: "map.buffer", issue: "RAG_LEAK_TEXT", resolution: "POINT(1 2)" }],
    mapLayers: [{
      layerId: "lyr-allow",
      layerName: "地块",
      geometryKind: "Polygon",
      featureCount: 3,
      fieldNames: ["地块编号", "手机号"],
      crsLabel: "局部平面",
      visible: true,
      order: 0,
      geometry: { type: "Polygon", coordinates: [[[118.75, 41.25831], [118.76, 41.25831], [118.76, 41.26], [118.75, 41.25831]]] },
      bbox: [118.75, 41.25831, 118.77, 41.26831],
      path: PATH,
      wkt: "POLYGON((118.75 41.25831, 118.77 41.25831, 118.77 41.26831, 118.75 41.25831))",
      wkb: WKB,
      jsonGeom: JSON_GEOM,
      extraLeak: "EXTRA_LEAK_TOKEN",
    }],
    partialEntities: { intentFragments: ["buffer"], layerCandidates: ["地块"], numbers: [20] },
  } as unknown as DispatchInput;
}

function assertNoLeaks(body: string, label: string): void {
  const banned = [
    "手机号",
    "CRS_LEAK_LABEL",
    "RAG_LEAK_TEXT",
    "MEMORY_LEAK_TEXT",
    "EXTRA_LEAK_TOKEN",
    "118.75",
    "41.25831",
    "POINT(",
    "POLYGON",
    "coordinates",
    "data.gpkg",
    "C:\\\\secret",
    "C:\\secret",
    WKB,
    "\"bbox\"",
    "\"wkt\"",
    "\"wkb\"",
  ];
  for (const token of banned) {
    if (body.includes(token)) throw new Error(`${label} 仍含 ${token}`);
  }
}

async function rejectedCall(name: string, args: unknown, code: string): Promise<void> {
  const bodies: string[] = [];
  let calls = 0;
  const result = await runLlmToolCallLoop(caller(async (_url, init) => {
    bodies.push(init.body);
    if (bodies.length === 1) return toolResponse(name, args);
    return textDone();
  }, {
    execute() {
      calls += 1;
      return Promise.resolve({ ok: true, message: "不该执行。" });
    },
  }), { instruction: "测试", metadata: [], kgHits: [] });
  check(calls === 0, `${name} 进入了适配器`);
  check(result.traces[0]?.code === code, `${name} 的拒绝码不是 ${code}，实际是 ${result.traces[0]?.code ?? "无"}`);
  for (const body of bodies) assertNoLeaks(body, name);
}

interface FakeLayers {
  readonly service: SpatialService;
  readonly size: () => number;
  readonly removes: () => number;
  readonly drops: () => number;
}

function fakeLayers(): FakeLayers {
  const layers = new Map<string, { layerId: string; layerName: string; geometryKind: string; featureCount: number }>();
  layers.set("lyr-1", { layerId: "lyr-1", layerName: "地块", geometryKind: "polygon", featureCount: 1 });
  let removes = 0;
  let drops = 0;
  const service = {
    store: {
      list: () => [...layers.values()],
      remove: async (id: string) => {
        removes += 1;
        return layers.delete(id);
      },
    },
    dropDatabase: async () => {
      drops += 1;
    },
  };
  return {
    service: service as unknown as SpatialService,
    size: () => layers.size,
    removes: () => removes,
    drops: () => drops,
  };
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

async function openAt(root: string, name: string, extra: Partial<SpatialStackOptions> = {}): Promise<SpatialStack> {
  const dir = join(root, name);
  check(resolve(dir).toLowerCase().startsWith(resolve(root).toLowerCase()), "用例目录必须在临时目录里");
  check(!resolve(dir).toLowerCase().startsWith(REPO_ROOT.toLowerCase()), "用例目录不能落在仓库里");
  return openSpatialStack({
    layerDirectory: join(dir, "layers"),
    auditDirectory: join(dir, "audit"),
    cacheDirectory: join(dir, "cache"),
    modelName: () => "v079b-check",
    ...extra,
  });
}

async function main(): Promise<void> {
  const leakBodies: string[] = [];
  await runLlmToolCallLoop({
    ...caller(async (_url, init) => {
      leakBodies.push(init.body);
      return textDone();
    }, { execute: () => Promise.resolve({ ok: true, message: "未调用工具。" }) }),
    userMemory: `MEMORY_LEAK_TEXT ${PATH}`,
  }, leakInput());
  check(leakBodies.length === 1, "泄漏用例应发出一次模型请求");
  const leaked = leakBodies[0] ?? "";
  assertNoLeaks(leaked, "模型请求");
  check(leaked.includes("lyr-allow"), "允许列表保留图层标识");
  check(leaked.includes("地块"), "允许列表保留图层名");
  check(leaked.includes("Polygon"), "允许列表保留几何类型");
  check(leaked.includes("缓冲地块"), "允许列表保留非几何指令");
  check(/featureCount\\":3/.test(leaked) || leaked.includes("\"featureCount\":3"), "允许列表保留要素数量");
  check(leaked.includes("局部平面") && leaked.includes("\"crsLabel\""), "允许列表保留坐标系标签");
  console.log("ok 模型请求只含允许字段");

  await rejectedCall("readFile", { operation: "readFile", path: PATH }, "filesystem-rejected");
  await rejectedCall("ogr2ogr", { command: "ogr2ogr out.shp in.shp" }, "gdal-rejected");
  await rejectedCall("powershell", { script: "powershell -Command Get-ChildItem" }, "capability-rejected");
  await rejectedCall("eval", { script: "eval(process.mainModule)" }, "capability-rejected");
  await rejectedCall("http://127.0.0.1/secret", { url: "http://127.0.0.1/secret" }, "capability-rejected");
  console.log("ok 读文件、GDAL、外壳、脚本和本机 HTTP 没有进入运行时");

  const errorBodies: string[] = [];
  const errorResult = await runLlmToolCallLoop(caller(async (_url, init) => {
    errorBodies.push(init.body);
    if (errorBodies.length === 1) return toolResponse("list_map_layers", {});
    return textDone();
  }, {
    execute() {
      return Promise.resolve({
        ok: false,
        code: "ENOENT",
        message: "ENOENT: no such file or directory, open 'C:\\Users\\alice\\secret\\data.gpkg'",
      });
    },
  }), { instruction: "列出图层", metadata: [], kgHits: [] });
  const localMessage = errorResult.traces[0]?.message ?? "";
  check(localMessage.includes("data.gpkg") && localMessage.includes("Users"), "本地诊断保留路径");
  const modelError = errorBodies[1] ?? "";
  check(modelError.includes("LOCAL_DATA_ACCESS_ERROR"), "模型看见安全错误码");
  check(!modelError.includes("data.gpkg") && !modelError.includes("Users") && !modelError.includes("C:\\\\Users"), "模型错误没有路径");
  console.log("ok 模型错误没有路径，本地诊断仍有");

  const blocked = fakeLayers();
  const blockedAdapter = createSpatialAwareAdapter({ execute: async () => ({ ok: false }) }, blocked.service, { entry: "mcp" });
  const mcpDelete = await executeMcpTool(blockedAdapter, "map_delete", { layerId: "lyr-1", confirm: true });
  const mcpClear = await executeMcpTool(blockedAdapter, "map_clearAll", { confirm: true });
  const mcpDrop = await executeMcpTool(blockedAdapter, "map_dropDatabase", { confirm: true });
  // V0.86 起授权字段不在工具 schema：模型带 confirm:true 在参数边界即被拒绝（比确认门更早、更硬）。
  check(JSON.parse(mcpDelete.text).ok === false && JSON.parse(mcpDelete.text).message.includes("未知参数"), "MCP confirm:true 不能删除图层");
  check(JSON.parse(mcpClear.text).ok === false && JSON.parse(mcpClear.text).message.includes("未知参数"), "MCP confirm:true 不能清空图层");
  check(JSON.parse(mcpDrop.text).ok === false && JSON.parse(mcpDrop.text).message.includes("未知参数"), "MCP confirm:true 不能删除知识");
  check(blocked.removes() === 0 && blocked.drops() === 0 && blocked.size() === 1, "假图层库没有被模型确认改动");
  const allowed = await executeMcpTool(blockedAdapter, "map_delete", { layerId: "lyr-1" }, GIS_TOOL_REGISTRY, { userConfirmed: true });
  check(JSON.parse(allowed.text).ok === true, "运行时用户确认可以删除");
  check(blocked.removes() === 1 && blocked.size() === 0, "运行时确认后假图层库才删除");

  const chatFake = fakeLayers();
  const chatAdapter = createSpatialAwareAdapter({ execute: async () => ({ ok: false }) }, chatFake.service, { entry: "chat" });
  const asked = await runLocalFirstTurn({
    conversationId: "conv-delete",
    text: "删除地块",
    pending: null,
    knownLayers: [{ layerId: "lyr-1", layerName: "地块" }],
    selectedLayer: null,
    confirm: false,
    adapter: chatAdapter,
    providerId: "local",
    model: "fake-model",
    baseUrl: "http://127.0.0.1:9/v1",
    fetchImpl: async () => {
      throw new Error("本地确认流程不应调用模型");
    },
  });
  check(asked.usedModel === false && asked.confirmRequired === true && chatFake.removes() === 0, "聊天删除先停在确认");
  const confirmed = await runLocalFirstTurn({
    conversationId: "conv-delete",
    text: "确认",
    pending: asked.pending,
    knownLayers: [{ layerId: "lyr-1", layerName: "地块" }],
    selectedLayer: null,
    confirm: true,
    adapter: chatAdapter,
    providerId: "local",
    model: "fake-model",
    baseUrl: "http://127.0.0.1:9/v1",
    fetchImpl: async () => {
      throw new Error("用户确认后的本地计划不应调用模型");
    },
  });
  check(confirmed.usedModel === false && chatFake.removes() === 1 && chatFake.size() === 0, "聊天用户确认后才删除");
  console.log("ok 破坏性操作只认运行时确认");

  const root = await mkdtemp(join(tmpdir(), "igis-v079b-"));
  check(!resolve(root).toLowerCase().startsWith(REPO_ROOT.toLowerCase()), "临时目录不能在仓库里");
  try {
    const stack = await openAt(root, "stack");
    const area = await stack.catalog.insert({
      layerName: "地块",
      sourcePaths: ["memory"],
      collection: square(),
      crsLabel: "EPSG:4326",
    });
    const inner: ToolAdapterPort = { execute: () => Promise.resolve({ ok: false, message: "内层工具没有执行。" }) };
    const localAdapter = createSpatialAwareAdapter(inner, stack.service, { entry: "chat", operationsRoot: root });
    const local = await runLocalFirstTurn({
      conversationId: "conv-buffer",
      text: "把地块缓冲 20 米",
      pending: null,
      knownLayers: [{ layerId: area.layerId, layerName: "地块" }],
      selectedLayer: null,
      confirm: false,
      adapter: localAdapter,
      providerId: "local",
      model: "fake-model",
      baseUrl: "http://127.0.0.1:9/v1",
      fetchImpl: async () => {
        throw new Error("本地解析不应调用模型");
      },
    });
    check(local.usedModel === false, "完整缓冲计划没有调用模型");
    const localId = local.turn.traces.find((item) => typeof item.operationId === "string")?.operationId ?? "";
    const localRecord = await readOperationRecord(localId, root);
    check(localRecord?.source === "local-parser" && localRecord.aiOrigin === false && localRecord.translationUsed === false, "本地解析来源是 local-parser");

    let cloudRound = 0;
    const cloud = await runLlmToolCallLoop(caller(async (_url, init) => {
      cloudRound += 1;
      if (cloudRound === 1) return toolResponse("run_buffer", { layerId: area.layerId, distance: 12, unit: "meters" });
      return textDone();
    }, localAdapter), { instruction: "缓冲地块", metadata: [], kgHits: [] });
    const cloudId = cloud.traces.find((item) => typeof item.operationId === "string")?.operationId ?? "";
    const cloudRecord = await readOperationRecord(cloudId, root);
    check(cloudRecord?.source === "cloud-ai" && cloudRecord.aiOrigin === true && cloudRecord.translationUsed === true, "模型工具调用来源是 cloud-ai");

    const mcpAdapter = createSpatialAwareAdapter(inner, stack.service, { entry: "mcp", operationsRoot: root });
    const mcp = await executeMcpTool(mcpAdapter, "map_buffer", { layerId: area.layerId, distance: 8, unit: "meters" });
    const mcpBody = JSON.parse(mcp.text) as { readonly operationId?: string };
    const mcpRecord = await readOperationRecord(mcpBody.operationId ?? "", root);
    check(mcpRecord?.source === "mcp" && mcpRecord.aiOrigin === true && mcpRecord.translationUsed === true, "MCP 来源是 mcp，不是 cloud-ai");

    const mapCapture = captureResponse();
    await handleV05Request({
      spatial: stack,
      vendorRoot: join(root, "vendor"),
      operationsRoot: root,
    }, jsonRequest({ operation: "buffer", layerId: area.layerId, distance: 6, unit: "meters", writeKnowledge: false }), mapCapture.response, new URL("http://127.0.0.1/api/spatial/run"));
    const mapId = String(mapCapture.read().body.operationId ?? "");
    const mapRecord = await readOperationRecord(mapId, root);
    check(mapRecord?.source === "local-user" && mapRecord.aiOrigin === false && mapRecord.translationUsed === false, "地图界面来源是 local-user");
    console.log("ok 四种来源分别是 local-parser、cloud-ai、mcp、local-user");
    console.log("v079b-boundary-check passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

let failed: unknown = null;
try {
  await main();
} catch (error) {
  failed = error;
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
}
if (failed) throw new Error("v079b-boundary-check failed");
