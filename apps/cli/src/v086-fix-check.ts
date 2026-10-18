// SPDX-License-Identifier: Apache-2.0

/**
 * V0.86 修复批验证（A1-A6 / C1-C5 / L6）。
 * 行为断言（真实调用代码路径）：A1 分块 UTF-8 解码、C1 反向包含、C2 跨 180° 拒绝、
 * C3 缓存命中如实记 crs、C5 stats 不受 callerCrs 误拒。
 * 代码形状断言（UI/局部函数无法从外部直调）：A2/A3/A4/A6 前端修复、A5 回退永久失败、C4 GDL CRS 规范化、L6 免责文案。
 * 只用操作系统临时目录。不监听端口。
 * 运行：npx tsx --tsconfig tsconfig.json apps/cli/src/v086-fix-check.ts
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bufferFeatures } from "@igis/surtgis";
import type { CoreCollection } from "@igis/surtgis";
import type { SpatialService } from "../../../packages/spatial-ops/src/service.js";
import { openSpatialStack } from "../../../packages/spatial-ops/src/service.js";
import { resolveLayerRef } from "../../../packages/spatial-ops/src/resolve-layer.js";
import { handleV05Request } from "./map-http.js";

const REPO_ROOT = resolve("E:/ai工作区/Igis");

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

function layerMeta(layerId: string, layerName: string) {
  return { layerId, layerName, geometryKind: "polygon", featureCount: 1 };
}

async function main(): Promise<void> {
  // ---- C1：反向包含不再误解析（"湖泊_缓冲" 不得命中 "湖泊"），单向模糊仍工作。
  type CatalogView = Parameters<typeof resolveLayerRef>[0];
  const catalog = { list: () => [layerMeta("lyr-lake", "湖泊"), layerMeta("lyr-buf", "湖泊_缓冲")] } as unknown as CatalogView;
  const reverse = resolveLayerRef(catalog, "湖泊_缓冲");
  check(reverse.status === "ok" && reverse.layerId === "lyr-buf", "精确名称应命中同名图层");
  const narrow = resolveLayerRef({ list: () => [layerMeta("lyr-lake", "湖泊")] } as unknown as CatalogView, "湖泊_缓冲");
  check(narrow.status === "missing", "反向包含（查询串包含图层名）不得静默命中图层");
  const forward = resolveLayerRef({ list: () => [layerMeta("lyr-buf", "湖泊_缓冲")] } as unknown as CatalogView, "缓冲");
  check(forward.status === "ok" && forward.layerId === "lyr-buf", "单向模糊（图层名包含查询串）应仍工作");
  console.log("ok C1 反向包含已修，单向模糊保留");

  // ---- C2：跨经度 180° 的数据明确拒绝并提示分幅，不再静默算错。
  const dateline: CoreCollection = {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [[[179, 10], [-179, 10], [-179, 11], [179, 11], [179, 10]]],
      },
    }],
  } as unknown as CoreCollection;
  let datelineError = "";
  try {
    bufferFeatures(dateline, 100, "meters");
  } catch (error) {
    datelineError = error instanceof Error ? error.message : "";
  }
  check(datelineError.includes("180") && datelineError.includes("分幅"), `跨 180° 应拒绝并提示分幅，实际：${datelineError || "没有拒绝"}`);
  console.log("ok C2 跨 180° 明确拒绝并提示分幅");

  // ---- C3 / C5：带 CRS 的真实栈（createLayer 注入，不依赖 GDAL）。
  const root = await mkdtemp(join(tmpdir(), "igis-v086-fix-"));
  check(!resolve(root).toLowerCase().startsWith(REPO_ROOT.toLowerCase()), "用例目录不能落在仓库里");
  try {
    const stack = await openSpatialStack({
      layerDirectory: join(root, "layers"),
      auditDirectory: join(root, "audit"),
      cacheDirectory: join(root, "cache"),
      modelName: () => "v086-fix",
    });
    const collection = {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: { name: "甲", amount: 4 },
        geometry: {
          type: "Polygon",
          coordinates: [[[116, 39], [116.02, 39], [116.02, 39.02], [116, 39.02], [116, 39]]],
        },
      }],
    } as unknown as Parameters<SpatialService["createLayer"]>[0]["collection"];
    const created = await stack.service.createLayer({
      layerName: "地块",
      collection,
      crsLabel: "EPSG:4326",
      expectedKind: "polygon",
      sourceLabel: "v086-fix",
      writeKnowledge: false,
    });

    // C5：统计不是空间运算，不因 callerCrs 冲突被拒。
    const stats = await stack.service.usingCallerCrs("EPSG:3857", () => stack.service.stats(created.layer.layerId, "amount", false));
    check(stats.ok === true && stats.featureCount === 1, `stats 不应被 callerCrs 误拒，实际：${stats.message}`);

    // C3：米制缓冲 miss 路径有 aeqd 事实；缓存命中路径如实记空，不推断 aeqd。
    const first = await stack.service.buffer(created.layer.layerId, 100, "meters", false, null);
    check(first.cached !== true, "第一次缓冲应是 miss");
    check(first.crs?.bufferProjection === "aeqd", "米制缓冲 miss 应记录 aeqd 投影事实");
    const second = await stack.service.buffer(created.layer.layerId, 100, "meters", false, null);
    check(second.cached === true, "第二次缓冲应命中缓存");
    check(second.crs !== undefined, "缓存命中也必须带 crs 事实");
    check(second.crs?.bufferProjection === undefined, "缓存命中不得推断 aeqd（本次没有做投影）");
    check((second.crs?.transformations ?? []).length === 0, "缓存命中的变换列表应如实为空");
    console.log("ok C3 缓存命中如实记 crs；ok C5 stats 不受 callerCrs 误拒");
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  // ---- A1：TCP 分块切开 UTF-8 多字节序列时中文不再变 U+FFFD（map-http 的 readBody 流式解码）。
  const renamed: string[] = [];
  const a1Root = await mkdtemp(join(tmpdir(), "igis-v086-a1-"));
  try {
    const fakeDeps = {
      spatial: {
        service: {
          rename: async (_layerId: string, layerName: string) => {
            renamed.push(layerName);
            return { layerId: "lyr-1", layerName, featureCount: 1, fieldNames: [] };
          },
        },
        catalog: { list: () => [], get: () => null, order: () => [] },
      },
      vendorRoot: a1Root,
      operationsRoot: a1Root,
    };
    const text = JSON.stringify({ layerId: "lyr-1", layerName: "图层甲" });
    const bytes = Buffer.from(text);
    const cut = text.indexOf("图");
    // 在"图"字（3 字节 UTF-8）中间切开，模拟 TCP 分块。
    const cutBytes = Buffer.from(text.slice(0, cut)).length + 1;
    const request = {
      method: "POST",
      headers: {},
      resume() {},
      async *[Symbol.asyncIterator]() {
        yield bytes.subarray(0, cutBytes);
        yield bytes.subarray(cutBytes, bytes.length);
      },
    } as unknown as IncomingMessage;
    let raw = "";
    const response = {
      writeHead() {},
      end(body?: string) {
        raw = body ?? "";
      },
    } as unknown as ServerResponse;
    const handled = await handleV05Request(fakeDeps as never, request, response, new URL("http://127.0.0.1/api/map/rename"));
    check(handled, "rename 接口应被受理");
    check(renamed[0] === "图层甲", `分块解码后中文应完整，实际：${renamed[0] ?? "无"}（${raw.slice(0, 80)}）`);
    console.log("ok A1 分块 UTF-8 解码保留中文");
  } finally {
    await rm(a1Root, { recursive: true, force: true });
  }

  // ---- 代码形状断言（UI 与局部函数的修复点）。
  const appJs = await readFile(join(REPO_ROOT, "apps/desktop/ui/app.js"), { encoding: "utf8" });
  const i18nJs = await readFile(join(REPO_ROOT, "apps/desktop/ui/i18n.js"), { encoding: "utf8" });
  const turnRollback = await readFile(join(REPO_ROOT, "apps/cli/src/turn-rollback.ts"), { encoding: "utf8" });
  const gdlHttp = await readFile(join(REPO_ROOT, "apps/cli/src/gdl-http.ts"), { encoding: "utf8" });
  const desktopApi = await readFile(join(REPO_ROOT, "apps/cli/src/desktop-api.ts"), { encoding: "utf8" });

  check(appJs.includes("registerLayerInScope"), "A2 图层归属指定对话的修复点不在 app.js");
  check(appJs.includes("switchSeq"), "A3 对话切换竞态守卫不在 app.js");
  check(appJs.includes("document.addEventListener(\"mousemove\"") || appJs.includes("document.addEventListener('mousemove'"), "A4 框选 mousemove 挂 document 的修复点不在 app.js");
  check(appJs.includes("fitted = true"), "A6 用户视角操作置位 fitted 的修复点不在 app.js");
  check(turnRollback.includes("找不到这次操作") && turnRollback.includes("permanent"), "A5 回退永久失败不重试的修复点不在 turn-rollback.ts");
  check(gdlHttp.includes("normalizeGdlCrs"), "C4 GDL 裸数字 CRS 规范化的修复点不在 gdl-http.ts");
  check(i18nJs.includes("结果仅供参考"), "L6 结果免责声明文案不在 i18n.js");
  check(appJs.includes("chat-disclaimer") || appJs.includes("result.disclaimer"), "L6 免责声明没有接到聊天结果");
  check(!desktopApi.includes("confirm: body.confirm === true"), "B1 旧的 confirm 直通下传不应再出现");
  console.log("ok A2/A3/A4/A5/A6/C4/L6 修复点都在位");

  console.log("v086-fix-check passed");
}

let failed: unknown = null;
try {
  await main();
} catch (error) {
  failed = error;
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
}
if (failed) throw new Error("v086-fix-check failed");
