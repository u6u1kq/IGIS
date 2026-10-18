// SPDX-License-Identifier: Apache-2.0

/**
 * V0.84 地图与缓存检查。
 * 覆盖：入库几何哈希（载入即存、与现算一致、旧图层回退）、缓存命中稳定性、
 * LLM 出站审计日志（var/llm-requests：消息体落盘、目标去查询串、不含密钥）。
 * 图层与审计用临时目录；LLM 审计日志按 var/ 约定写入仓库 var/llm-requests（gitignored）。
 * 运行：npx tsx --tsconfig tsconfig.json apps/cli/src/v084-map-cache-check.ts
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { geometryContentHash, openSpatialStack } from "@igis/spatial-ops";
import type { MapCollection, SpatialStack } from "@igis/spatial-ops";
import { postLlmJson } from "../../../packages/llm-dispatch/src/http.js";

const REPO_ROOT = resolve("E:/ai工作区/Igis");

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

function square(name: string): MapCollection {
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { name },
      geometry: { type: "Polygon", coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]] },
    }],
  };
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "igis-v084-"));
  try {
    const stack: SpatialStack = await openSpatialStack({
      layerDirectory: join(root, "layers"),
      auditDirectory: join(root, "audit"),
      cacheDirectory: join(root, "cache"),
      modelName: () => "v084-map-cache-check",
    });
    const service = stack.service;

    // 1. 载入即存几何哈希，且与现算一致。
    const fixturePath = join(root, "square.geojson");
    await writeFile(fixturePath, JSON.stringify({
      type: "FeatureCollection",
      name: "square",
      crs: { type: "name", properties: { name: "EPSG:4326" } },
      features: square("square").features,
    }), { encoding: "utf8" });
    const loaded = await service.loadFile(fixturePath, null, false);
    const loadedLayer = loaded[0];
    check(loadedLayer !== undefined, "夹具应载入一个图层");
    const meta = stack.catalog.get(loadedLayer.layerId);
    const storedCollection = stack.catalog.collection(loadedLayer.layerId);
    check(meta?.geometryHash !== undefined && /^[0-9a-f]{64}$/.test(meta.geometryHash), "载入图层应保存 64 位十六进制几何哈希");
    check(storedCollection !== null && meta?.geometryHash === geometryContentHash(storedCollection), "入库哈希应与现算一致");

    // 2. 同参数二次缓冲命中缓存（键走入库哈希）。
    const first = await service.buffer(loadedLayer.layerId, 10, "meters", false);
    check(first.ok, "首次缓冲应成功");
    const second = await service.buffer(loadedLayer.layerId, 10, "meters", false);
    check(second.ok && second.cached === true, "同参数二次缓冲应命中缓存");

    // 3. 旧式图层（无入库哈希）回退现算，运算不受影响。
    const legacy = await stack.catalog.insert({
      layerName: "旧式图层",
      sourcePaths: ["v084-fixture"],
      collection: square("旧式"),
      crsLabel: "EPSG:4326",
    });
    const legacyBuffer = await service.buffer(legacy.layerId, 10, "meters", false);
    check(legacyBuffer.ok, "无入库哈希的旧式图层仍可运算（现算回退）");

    // 4. LLM 出站审计：消息体落盘、目标去查询串、密钥不落盘。
    const bodyMarker = `v084-probe-${Date.now()}`;
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      text: async () => "{\"reply\":\"ok\"}",
    })) as unknown as typeof fetch;
    const reply = await postLlmJson(
      fakeFetch,
      "https://model.example.com/v1/chat/completions?apikey=SECRET-KEY",
      { "Content-Type": "application/json" },
      JSON.stringify({ messages: [{ role: "user", content: bodyMarker }] }),
      5000,
    );
    check(typeof reply === "object" && reply !== null, "模型请求应返回 JSON");
    await new Promise((done) => setTimeout(done, 400));
    const auditDir = join(REPO_ROOT, "var", "llm-requests");
    const files = (await readdir(auditDir)).filter((name) => name.endsWith(".json")).sort();
    check(files.length > 0, "出站审计应写入 var/llm-requests");
    const latest = files[files.length - 1];
    check(latest !== undefined, "审计目录非空");
    const auditText = await readFile(join(auditDir, latest), { encoding: "utf8" });
    check(auditText.includes(bodyMarker), "审计应记录消息体");
    check(auditText.includes("https://model.example.com/v1/chat/completions"), "审计应记录目标地址（去查询串）");
    check(!auditText.includes("SECRET-KEY"), "审计不得包含密钥");

    console.log("v084-map-cache-check passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
