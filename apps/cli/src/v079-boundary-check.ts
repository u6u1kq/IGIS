// SPDX-License-Identifier: Apache-2.0

/**
 * V0.79 数据边界。
 * 只用操作系统临时目录，不读仓库 var/，不监听端口。
 * 运行：npx tsx --tsconfig tsconfig.json apps/cli/src/v079-boundary-check.ts
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { toLayerSummary, translateLocalToAi } from "@igis/ai-translation";
import { executeMcpTool, listMcpTools } from "@igis/mcp-server";
import type { ToolAdapterPort } from "@igis/llm-dispatch";
import { executeAiIntent } from "../../../packages/spatial-ops/src/ai-intent.js";
import { readOperationRecord } from "../../../packages/spatial-ops/src/operation-attempt.js";
import { openSpatialStack } from "../../../packages/spatial-ops/src/service.js";
import type { SpatialStack, SpatialStackOptions } from "../../../packages/spatial-ops/src/service.js";
import type { MapCollection } from "../../../packages/spatial-ops/src/types.js";
import { createSpatialAwareAdapter } from "../../../packages/spatial-ops/src/adapter.js";
import { handleV05Request } from "./map-http.js";

const REPO_ROOT = resolve("E:/ai工作区/Igis");
const MARK = "41.25831";

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

function square(name: string): MapCollection {
  const x = 118.75;
  const y = Number(MARK);
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { name, amount: 4 },
      geometry: { type: "Polygon", coordinates: [[[x, y], [x, y + 0.01], [x + 0.02, y + 0.01], [x + 0.02, y], [x, y]]] },
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
    modelName: () => "v079-check",
    ...extra,
  });
  return { ...stack, dir };
}

function innerAdapter(): ToolAdapterPort {
  return { execute: () => Promise.resolve({ ok: false, message: "内层工具没有执行。" }) };
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

function layerIds(stack: SpatialStack): readonly string[] {
  return stack.catalog.list().map((layer) => layer.layerId);
}

async function operationFiles(root: string): Promise<readonly string[]> {
  try {
    const names = await readdir(join(root, "var", "operations"));
    return names.filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
}

function assertNoRaw(payload: unknown, label: string): void {
  const text = JSON.stringify(payload);
  check(!text.includes('"coordinates"'), `${label} 不能含 coordinates`);
  check(!text.includes('"geometry"'), `${label} 不能含 geometry 键`);
  check(!text.includes('"bbox"'), `${label} 不能含 bbox`);
  check(!text.includes('"path"') && !text.includes("C:/data") && !text.includes(".shp"), `${label} 不能含文件路径`);
  check(!text.includes(MARK) && !text.includes("118.75"), `${label} 不能含原始坐标数字`);
  check(!text.includes("POLYGON") && !text.includes("WKB"), `${label} 不能含 WKT/WKB`);
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "igis-v079-"));
  check(!resolve(root).toLowerCase().startsWith(REPO_ROOT.toLowerCase()), "临时目录不能在仓库里");
  try {
    const stack = await openAt(root, "stack");
    const area = await stack.catalog.insert({
      layerName: "地块",
      sourcePaths: ["C:/data/private.shp"],
      collection: square("甲"),
      crsLabel: "EPSG:4326",
    });
    const realistic = {
      layerId: area.layerId,
      layerName: area.layerName,
      geometryType: "Polygon",
      featureCount: 1,
      path: "C:/data/private.shp",
      sourcePaths: ["C:/data/private.shp"],
      bbox: [118.75, Number(MARK), 118.77, Number(MARK) + 0.01],
      wkt: `POLYGON ((118.75 ${MARK}, 118.77 ${MARK}, 118.77 ${Number(MARK) + 0.01}, 118.75 ${MARK}))`,
      collection: square("甲"),
      relations: ["相邻用地"],
    };
    const translated = translateLocalToAi(realistic);
    const summary = toLayerSummary(realistic);
    assertNoRaw(translated, "翻译结果");
    assertNoRaw(summary, "L2 摘要");
    check(summary.level === "L2" && summary.layerId === area.layerId && summary.layerName === "地块", "L2 保留图层名和标识");
    check(summary.featureCount === 1 && summary.geometryType === "Polygon", "L2 保留类型和数量");
    check(summary.availableOperations.includes("buffer"), "L2 带可用操作");
    console.log("ok AI 载荷没有坐标、几何、路径和范围");

    const beforeIds = layerIds(stack);
    const beforeOps = await operationFiles(root);
    const rejected = await executeAiIntent(stack.service, { read: "C:/data/private.shp" }, { root, entry: "chat" });
    check(rejected !== null && typeof rejected === "object" && (rejected as { ok?: boolean }).ok === false, "文件读取意图被拒绝");
    check((rejected as { code?: string }).code === "filesystem-rejected", "拒绝码是文件系统");
    const smuggled = await executeAiIntent(stack.service, {
      operation: "buffer",
      layerId: area.layerId,
      distance: 15,
      unit: "meters",
      read: "C:/data/private.shp",
    }, { root, entry: "chat" });
    check((smuggled as { ok?: boolean }).ok === false, "夹带文件路径的缓冲也被拒绝");
    check(layerIds(stack).join() === beforeIds.join(), "拒绝文件意图时没有改图层库");
    check((await operationFiles(root)).join() === beforeOps.join(), "拒绝文件意图时没有写下操作");
    console.log("ok 文件系统意图被拒绝且未碰图层库");

    const ran = await executeAiIntent(stack.service, {
      operation: "buffer",
      layerId: area.layerId,
      distance: 20,
      unit: "meters",
    }, { root, entry: "chat" });
    const ranBody = ran as { readonly ok?: boolean; readonly operationId?: string };
    check(ranBody.ok === true && typeof ranBody.operationId === "string", "缓冲意图进入现有执行并返回 operationId");
    assertNoRaw(ran, "缓冲返回给模型的载荷");
    const aiRecord = await readOperationRecord(ranBody.operationId, root);
    check(aiRecord !== null, "AI 缓冲写下操作记录");
    check(aiRecord.source === "cloud-ai" && aiRecord.aiOrigin === true, "AI 缓冲来源是 cloud-ai 且 aiOrigin");
    check(aiRecord.translationUsed === true && aiRecord.dataBoundaryLevel === "L2", "AI 缓冲经过翻译且边界是 L2");
    check(aiRecord.requestSource === "cloud-ai" && aiRecord.operation === "buffer", "AI 缓冲记了 requestSource");
    check(aiRecord.operationId.startsWith("op-"), "记录来自现有 operationId");
    console.log("ok AI 缓冲写入带边界字段的操作记录");

    const names = listMcpTools().map((tool) => tool.name);
    check(names.includes("map_buffer"), "MCP 仍暴露缓冲");
    check(!names.some((name) => /load|export|list-layers|list_layers|sample|io_read|read_gis/i.test(name)), "MCP 不暴露打开文件、读几何或导出");
    const mcpAdapter = createSpatialAwareAdapter(innerAdapter(), stack.service, { entry: "mcp", operationsRoot: root });
    const mcp = await executeMcpTool(mcpAdapter, "map_buffer", { layerId: area.layerId, distance: 25, unit: "meters" });
    const mcpBody = JSON.parse(mcp.text) as { readonly ok?: boolean; readonly operationId?: string };
    check(mcp.ok && mcpBody.ok === true && typeof mcpBody.operationId === "string", "MCP 缓冲走操作接口");
    assertNoRaw(JSON.parse(mcp.text), "MCP 缓冲结果");
    const mcpRecord = await readOperationRecord(mcpBody.operationId ?? "", root);
    check(mcpRecord?.source === "mcp" && mcpRecord.translationUsed === true && mcpRecord.aiOrigin === true, "MCP 记录来源是 mcp 且经过翻译");
    check(mcpRecord?.dataBoundaryLevel === "L2", "MCP 记录边界是 L2");
    const beforeLoad = layerIds(stack);
    let loads = 0;
    const originalLoad = stack.service.loadFile.bind(stack.service);
    stack.service.loadFile = async (...args) => {
      loads += 1;
      return originalLoad(...args);
    };
    const blocked = await executeMcpTool(mcpAdapter, "map_load", { absolutePath: "C:/data/private.shp" });
    check(blocked.ok === false && !blocked.text.includes(MARK) && !blocked.text.includes("coordinates"), "MCP 不能通过载入工具返回几何");
    check(loads === 0 && layerIds(stack).join() === beforeLoad.join(), "MCP 载入工具没有打开文件，也没有改图层库");
    const sample = await executeMcpTool(mcpAdapter, "get-sample-feature", { filePath: "C:/data/private.shp", layerName: "地块" });
    check(sample.ok === false && !sample.text.includes("coordinates") && !sample.text.includes(MARK), "MCP 不能读取样例几何");
    check(loads === 0, "样例工具也没有打开文件");
    console.log("ok MCP 不能绕过翻译返回几何");

    const mapCapture = captureResponse();
    const handled = await handleV05Request({
      spatial: stack,
      vendorRoot: join(root, "vendor"),
      operationsRoot: root,
    }, jsonRequest({ operation: "buffer", layerId: area.layerId, distance: 30, unit: "meters", writeKnowledge: false }), mapCapture.response, new URL("http://127.0.0.1/api/spatial/run"));
    const mapBody = mapCapture.read().body;
    check(handled && mapBody.ok === true && typeof mapBody.operationId === "string", "桌面地图缓冲仍走现有接口");
    const mapRecord = await readOperationRecord(String(mapBody.operationId), root);
    check(mapRecord?.source === "local-user" && mapRecord.translationUsed === false && mapRecord.aiOrigin === false, "桌面地图点击是 local-user");
    check(mapRecord?.requestSource === "desktop-ui" && mapRecord.dataBoundaryLevel === undefined, "桌面地图不标成 L2");
    console.log("ok 本地地图执行是 local-user");
    console.log("v079-boundary-check passed");
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
if (failed) throw new Error("v079-boundary-check failed");
