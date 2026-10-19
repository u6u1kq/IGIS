// SPDX-License-Identifier: Apache-2.0

/**
 * V0.78-Correction：翻译层、本地 CRS 变换、破坏性确认、知识归属、PPT 已删除。
 * 只用操作系统临时目录。不读仓库 var/，不监听端口。
 * 运行：npx tsx --tsconfig tsconfig.json apps/cli/src/v078-correction-check.ts
 */

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { executeMcpTool } from "@igis/mcp-server";
import { isAllowedOrigin, requiresOriginGate } from "./origin-gate.js";
import { payloadHasCoordinateArrays, translateForModel } from "@igis/llm-dispatch";
import type { ToolAdapterPort } from "@igis/llm-dispatch";
import { openSqliteVecRagStore } from "@igis/rag-meta";
import { createSpatialAwareAdapter } from "../../../packages/spatial-ops/src/adapter.js";
import { executeGisOperation, rollbackOperation } from "../../../packages/spatial-ops/src/execute-gis-operation.js";
import { readOperationRecord } from "../../../packages/spatial-ops/src/operation-attempt.js";
import { openSpatialStack } from "../../../packages/spatial-ops/src/service.js";
import type { SpatialStack, SpatialStackOptions } from "../../../packages/spatial-ops/src/service.js";
import type { MapCollection } from "../../../packages/spatial-ops/src/types.js";
import { transformCollection } from "@igis/surtgis";
import type { CoreCollection } from "@igis/surtgis";
import { handleV05Request } from "./map-http.js";

const REPO_ROOT = resolve("E:/ai工作区/Igis");

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

function geographic(): MapCollection {
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { name: "甲", amount: 4 },
      geometry: {
        type: "Polygon",
        coordinates: [[[116, 39], [116.02, 39], [116.02, 39.02], [116, 39.02], [116, 39]]],
      },
    }],
  };
}

function firstOrdinate(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstOrdinate(item);
      if (found !== null) return found;
    }
    return null;
  }
  if (value !== null && typeof value === "object" && "coordinates" in value) {
    return firstOrdinate((value as { readonly coordinates: unknown }).coordinates);
  }
  return null;
}

async function openAt(root: string, name: string, extra: Partial<SpatialStackOptions> = {}): Promise<SpatialStack & { readonly dir: string }> {
  const dir = join(root, name);
  check(resolve(dir).toLowerCase().startsWith(resolve(root).toLowerCase()), "用例目录必须在临时目录里");
  check(!resolve(dir).toLowerCase().startsWith(REPO_ROOT.toLowerCase()), "用例目录不能落在仓库里");
  const stack = await openSpatialStack({
    layerDirectory: join(dir, "layers"),
    auditDirectory: join(dir, "audit"),
    cacheDirectory: join(dir, "cache"),
    modelName: () => "v078-correction",
    ...extra,
  });
  return { ...stack, dir };
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
  const poisoned = {
    layerId: "lyr-demo",
    layerName: "道路",
    distance: 100,
    unit: "meters",
    featureId: "f-1",
    attributes: { name: "甲" },
    geometry: { type: "Polygon", coordinates: [[[116, 39], [116.1, 39], [116.1, 39.1], [116, 39]]] },
    wkt: "POLYGON ((116 39, 116.1 39, 116.1 39.1, 116 39))",
    bbox: [116, 39, 116.1, 39.1],
  };
  const safe = translateForModel(poisoned);
  const safeText = JSON.stringify(safe);
  check(!payloadHasCoordinateArrays(safe), "翻译后的模型载荷不能含坐标数组");
  check(!safeText.includes("116"), "翻译后不能留下原始经度");
  check(safeText.includes("lyr-demo") && safeText.includes("道路") && safeText.includes("100") && safeText.includes("meters"), "翻译保留图层、距离和单位");
  console.log("ok 翻译层去掉坐标");

  const root = await mkdtemp(join(tmpdir(), "igis-v078c-"));
  check(!resolve(root).toLowerCase().startsWith(REPO_ROOT.toLowerCase()), "临时目录不能在仓库里");
  try {
    const rag = await openSqliteVecRagStore(join(root, "rag"));
    const otherKnowledge = await rag.add({ title: "别的资料", body: "这条不归本次操作。", kind: "text" });
    const stack = await openAt(root, "stack");
    const beforeTranslate = stack.catalog.list().length;
    translateForModel(poisoned);
    check(stack.catalog.list().length === beforeTranslate, "翻译不把临时几何写进图层库");

    const geo = geographic();
    const mercator = transformCollection(geo as CoreCollection, 4326, 3857);
    const geoLayer = await stack.catalog.insert({
      layerName: "地理",
      sourcePaths: ["memory"],
      collection: geo,
      crsLabel: "EPSG:4326",
    });
    const mercLayer = await stack.catalog.insert({
      layerName: "墨卡托",
      sourcePaths: ["memory"],
      collection: mercator,
      crsLabel: "EPSG:3857",
    });
    const unknown = await stack.catalog.insert({
      layerName: "未知",
      sourcePaths: ["memory"],
      collection: geographic(),
      crsLabel: "未声明",
    });
    const invalid = await stack.catalog.insert({
      layerName: "无效",
      sourcePaths: ["memory"],
      collection: geographic(),
      crsLabel: "totally-not-a-crs",
    });
    check(stack.catalog.get(invalid.layerId)?.crsLabel === "无效", "无效元数据保持无效");
    // V0.89：写了投影/地理定义但没有 EPSG 代码不再是无效，是局部平面身份。
    const declared = await stack.catalog.insert({
      layerName: "已声明",
      sourcePaths: ["memory"],
      collection: geographic(),
      crsLabel: "GEOGCS[\"WGS 84\"]",
    });
    check(stack.catalog.get(declared.layerId)?.crsLabel === "局部平面", "证明不了 EPSG 的 WKT 是局部平面，不是无效");

    const beforeGeo = JSON.stringify(stack.catalog.collection(geoLayer.layerId));
    const same = await executeGisOperation(stack.service, {
      entry: "map",
      operation: "buffer",
      root,
      policy: { writeKnowledge: false },
      sourceLayer: { layerId: geoLayer.layerId, layerName: geoLayer.layerName },
      distance: 100,
      unit: "meters",
    });
    check(same.ok && same.result?.layer, "同一 EPSG:4326 可以缓冲");
    check(same.record.crs?.comparison === "same" && same.record.crs.transformations.length === 0, "同一坐标系不记录变换");
    check(same.record.crs?.resultCrs === "EPSG:4326", "结果坐标系是 EPSG:4326");
    check(same.record.request.distance === 100 && same.record.request.unit === "meters", "距离仍是 100 米，没有换成度");
    check(JSON.stringify(stack.catalog.collection(geoLayer.layerId)) === beforeGeo, "同一坐标系不改输入坐标");
    const sameOrdinate = firstOrdinate(stack.catalog.collection(same.result.layer.layerId)?.features[0]?.geometry);
    check(sameOrdinate !== null && Math.abs(sameOrdinate) < 180, "4326 结果坐标仍是经纬度");
    console.log("ok 同一坐标系不变换");

    const beforeMerc = JSON.stringify(stack.catalog.collection(mercLayer.layerId));
    const projected = await executeGisOperation(stack.service, {
      entry: "map",
      operation: "buffer",
      root,
      policy: { writeKnowledge: true },
      sourceLayer: { layerId: mercLayer.layerId, layerName: mercLayer.layerName },
      distance: 100,
      unit: "meters",
    });
    check(projected.ok && projected.result?.layer, "EPSG:3857 缓冲在本地变换后完成");
    check(stack.catalog.get(projected.result.layer.layerId)?.crsLabel === "EPSG:3857", "3857 结果仍存在 3857");
    const mercOrdinate = firstOrdinate(stack.catalog.collection(projected.result.layer.layerId)?.features[0]?.geometry);
    check(mercOrdinate !== null && Math.abs(mercOrdinate) > 100000, "3857 结果坐标是米，不是经纬度");
    check(JSON.stringify(stack.catalog.collection(mercLayer.layerId)) === beforeMerc, "变换不改写输入图层");
    check(projected.record.crs?.transformations.some((item) => item.purpose === "to-working" && item.to === "EPSG:4326"), "记录到工作坐标系的变换");
    check(projected.record.crs?.transformations.some((item) => item.purpose === "from-working" && item.to === "EPSG:3857"), "记录从工作坐标系回到结果坐标系的变换");
    check(!JSON.stringify(projected.record).includes('"coordinates"'), "操作记录没有坐标");
    const knowledgeId = projected.record.sideEffects.knowledgeIds?.[0];
    check(typeof knowledgeId === "string" && knowledgeId !== "", "writeKnowledge 产生的知识 id 记在操作上");
    check((await rag.list()).some((item) => item.entryId === knowledgeId), "知识库里真有这条记录");
    console.log("ok 3857 缓冲与知识归属");

    const crossed = await executeGisOperation(stack.service, {
      entry: "gdl",
      operation: "intersect",
      root,
      policy: { writeKnowledge: false },
      layerId: geoLayer.layerId,
      layerName: geoLayer.layerName,
      otherLayerId: mercLayer.layerId,
      otherLayerName: mercLayer.layerName,
    });
    check(crossed.ok && crossed.result?.layer && crossed.result.featureCount > 0, "4326 与 3857 相交有结果");
    check(stack.catalog.get(crossed.result.layer.layerId)?.crsLabel === "EPSG:4326", "相交结果使用第一个图层的坐标系");
    const crossOrdinate = firstOrdinate(stack.catalog.collection(crossed.result.layer.layerId)?.features[0]?.geometry);
    check(crossOrdinate !== null && Math.abs(crossOrdinate) < 180, "相交结果坐标与 EPSG:4326 一致");
    check(crossed.record.crs?.comparison === "different", "不同坐标系记为 different");
    check(crossed.record.crs?.transformations.some((item) => item.purpose === "align-input"), "另一个输入被变到目标坐标系");
    const clipped = await executeGisOperation(stack.service, {
      entry: "mcp",
      operation: "clip",
      root,
      policy: { writeKnowledge: false },
      layerId: geoLayer.layerId,
      layerName: geoLayer.layerName,
      otherLayerId: mercLayer.layerId,
      otherLayerName: mercLayer.layerName,
    });
    check(clipped.ok && clipped.result?.layer && clipped.result.featureCount > 0, "4326 被 3857 裁剪有结果");
    check(stack.catalog.get(clipped.result.layer.layerId)?.crsLabel === "EPSG:4326", "裁剪结果使用第一个图层的坐标系");
    console.log("ok 跨坐标系相交和裁剪");

    const idsBeforeUnknown = new Set(stack.catalog.list().map((layer) => layer.layerId));
    const unknownRun = await executeGisOperation(stack.service, {
      entry: "chat",
      operation: "buffer",
      root,
      policy: { writeKnowledge: false },
      sourceLayer: { layerId: unknown.layerId, layerName: unknown.layerName },
      distance: 50,
      unit: "meters",
    });
    check(!unknownRun.ok && unknownRun.record.status === "failed", "未知坐标系的空间运算失败");
    check(unknownRun.record.crs?.comparison === "unknown", "失败记录写明未知");
    check(stack.catalog.list().every((layer) => idsBeforeUnknown.has(layer.layerId)), "未知坐标系没有留下结果图层");
    check(typeof unknownRun.record.error?.auditRecordId === "string", "失败保留审计 id");
    await stat(join(stack.dir, "audit", `${unknownRun.record.error?.auditRecordId}.json`));
    const invalidRun = await executeGisOperation(stack.service, {
      entry: "chat",
      operation: "buffer",
      root,
      policy: { writeKnowledge: false },
      sourceLayer: { layerId: invalid.layerId, layerName: invalid.layerName },
      distance: 50,
      unit: "meters",
    });
    check(!invalidRun.ok && invalidRun.record.crs?.comparison === "invalid", "无效坐标系的空间运算失败，且不降成未知");
    const attribute = await executeGisOperation(stack.service, {
      entry: "chat",
      operation: "query",
      root,
      policy: { writeKnowledge: false },
      layerId: unknown.layerId,
      layerName: unknown.layerName,
      queryKind: "属性",
      attributeFilter: "name=甲",
    });
    check(attribute.ok, "未知坐标系仍可做属性查询");
    const stats = await executeGisOperation(stack.service, {
      entry: "chat",
      operation: "stats",
      root,
      policy: { writeKnowledge: false },
      layerId: unknown.layerId,
      layerName: unknown.layerName,
      fieldName: "amount",
    });
    check(stats.ok && stats.result?.mean === 4, "未知坐标系仍可做数值统计");
    console.log("ok 未知失败、属性查询和统计");

    const conflictBefore = JSON.stringify(stack.catalog.collection(geoLayer.layerId));
    const conflict = await executeGisOperation(stack.service, {
      entry: "map",
      operation: "buffer",
      root,
      callerCrs: "EPSG:3857",
      policy: { writeKnowledge: false },
      sourceLayer: { layerId: geoLayer.layerId, layerName: geoLayer.layerName },
      distance: 20,
      unit: "meters",
    });
    check(!conflict.ok, "调用方坐标系与图层冲突时拒绝");
    check(stack.catalog.get(geoLayer.layerId)?.crsLabel === "EPSG:4326", "冲突没有改写图层坐标系");
    check(JSON.stringify(stack.catalog.collection(geoLayer.layerId)) === conflictBefore, "冲突没有改写坐标");
    console.log("ok 调用方不能覆盖图层坐标系");

    const ownedLayer = projected.result.layer.layerId;
    const userFile = join(root, "user-source.geojson");
    await writeFile(userFile, JSON.stringify({
      type: "FeatureCollection",
      crs: { type: "name", properties: { name: "EPSG:4326" } },
      features: geo.features,
    }), { encoding: "utf8" });
    const loaded = await stack.service.loadFile(userFile, "用户源", false);
    const provenanceFile = join(root, "kept-provenance.json");
    await writeFile(provenanceFile, "{}\n", { encoding: "utf8" });
    const rolled = await rollbackOperation(projected.operationId, {
      root,
      removeLayer: (layerId) => stack.catalog.remove(layerId),
      deleteKnowledge: (id) => rag.delete(id),
      dropCacheKey: (key, resultLayerIds) => stack.service.dropOwnedCacheKey(key, resultLayerIds),
    });
    check(rolled.ok && rolled.status === "rolled_back", "回退完成");
    check(stack.catalog.get(ownedLayer) === null, "回退删除本次结果图层");
    check(stack.catalog.get(loaded[0]?.layerId ?? "") !== null, "回退不删除用户载入的图层");
    await stat(userFile);
    await stat(provenanceFile);
    check(!(await rag.list()).some((item) => item.entryId === knowledgeId), "回退删除本次知识 id");
    check((await rag.list()).some((item) => item.entryId === otherKnowledge.entryId), "回退不删除其他知识");
    check((rolled.record.sideEffects.provenanceIds ?? []).length === 0, "没有编造来源账本 id");
    const again = await stack.service.buffer(mercLayer.layerId, 100, "meters", false);
    check(again.layer?.layerId !== ownedLayer && stack.catalog.get(ownedLayer) === null, "回退后缓存不能复活已删除的结果");
    console.log("ok 回退、缓存和来源文件");

    const adapter: ToolAdapterPort = createSpatialAwareAdapter({ execute: async () => ({ ok: true }) }, stack.service, { entry: "mcp", operationsRoot: root });
    const blocked = await executeMcpTool(adapter, "map_delete", { layerId: geoLayer.layerId });
    const blockedBody = JSON.parse(blocked.text) as { readonly ok?: boolean; readonly code?: string };
    check(blocked.ok === false && blockedBody.code === "confirm-required", "MCP 未确认不能删除图层");
    check(stack.catalog.get(geoLayer.layerId) !== null, "未确认时图层还在");
    check(!payloadHasCoordinateArrays(JSON.parse(blocked.text)), "MCP 返回给模型的载荷没有坐标");
    const capture = captureResponse();
    await handleV05Request({
      spatial: stack,
      vendorRoot: join(root, "vendor"),
      operationsRoot: root,
    }, jsonRequest({ layerId: geoLayer.layerId }), capture.response, new URL("http://127.0.0.1/api/map/layer/delete"));
    check(capture.read().body.code === "confirm-required" && stack.catalog.get(geoLayer.layerId) !== null, "地图删除未确认时拒绝");
    const allowed = captureResponse();
    await handleV05Request({
      spatial: stack,
      vendorRoot: join(root, "vendor"),
      operationsRoot: root,
    }, jsonRequest({ layerId: unknown.layerId, confirm: true }), allowed.response, new URL("http://127.0.0.1/api/map/layer/delete"));
    check(allowed.read().body.ok === true && stack.catalog.get(unknown.layerId) === null, "地图删除确认后才执行");
    console.log("ok 破坏性操作共用确认");

    check(isAllowedOrigin("https://foreign.example", 39222) === false, "外来 Origin 仍被拒绝");
    check(isAllowedOrigin(undefined, 39222) === true, "没有 Origin 的本机调用仍允许");
    check(requiresOriginGate("POST", "/api/spatial/run") === true, "改状态的请求仍要过来源门");
    const desktop = await readFile(resolve(REPO_ROOT, "apps/cli/src/desktop-api.ts"), { encoding: "utf8" });
    const page = await readFile(resolve(REPO_ROOT, "apps/desktop/ui/index.html"), { encoding: "utf8" });
    const pkg = await readFile(resolve(REPO_ROOT, "package.json"), { encoding: "utf8" });
    check(!desktop.includes("/api/report/ppt") && !page.includes("/api/report/ppt") && !pkg.includes("pptxgenjs"), "PPT 路由和 pptxgenjs 已删除");
    let pptGone = false;
    try {
      await stat(resolve(REPO_ROOT, "apps/cli/src/report-ppt.ts"));
    } catch {
      pptGone = true;
    }
    check(pptGone, "report-ppt.ts 已删除");
    const reloaded = await readOperationRecord(projected.operationId, root);
    check(reloaded?.operationId === projected.operationId && reloaded.crs?.resultCrs === "EPSG:3857", "操作记录能读回坐标系事实和 operationId");
    console.log("ok 来源门、PPT 和操作记录");
    console.log("v078-correction-check passed");
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
if (failed) throw new Error("v078-correction-check failed");
