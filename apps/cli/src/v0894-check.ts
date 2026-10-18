// SPDX-License-Identifier: Apache-2.0

/**
 * V0.89.4：坐标系拒绝原文能交给模型；对话范围内的图层名不碰到别的对话里的同名层。
 * 不下载 micromamba，不探测 osgeo，不监听桌面端口。
 * 运行：npx tsx --tsconfig tsconfig.json apps/cli/src/v0894-check.ts
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { looksLikeFilePath } from "@igis/ai-boundary";
import { releaseToModel } from "@igis/ai-translation";
import { createSpatialAwareAdapter, openSpatialStack } from "@igis/spatial-ops";

const PLANAR_LIMIT = "该图层是局部平面坐标系（已声明投影、无标准 EPSG 代码）：只支持平面构造与平面度量（Voronoi、凸包、最小外接矩形、质心、分幅、几何转换、分割、空间聚合、距离矩阵、面积/长度/距离/最近距离），本次运算需要标准 EPSG 坐标系。";

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("结果不是对象");
  return value as Record<string, unknown>;
}

async function main(): Promise<void> {
  check(looksLikeFilePath(PLANAR_LIMIT) === false, "平面限制说明里的斜杠不是路径");
  check(looksLikeFilePath("sub/dir.tif") === true, "路径斜杠仍应拒绝");
  check(looksLikeFilePath("E:/data/dem.tif") === true, "盘符路径仍应拒绝");
  check(looksLikeFilePath("C:\\data\\dem.tif") === true, "反斜杠路径仍应拒绝");
  check(looksLikeFilePath("../evil.tif") === true, "上级目录仍应拒绝");
  check(looksLikeFilePath("dem.tif") === false, "裸文件名仍应放行");

  const released = asRecord(releaseToModel({
    ok: false,
    operationType: "map.buffer",
    code: "crs-refused",
    message: PLANAR_LIMIT,
  }));
  const releasedText = JSON.stringify(released);
  check(released.message === PLANAR_LIMIT, "坐标系拒绝原文应原样留下");
  check(released.code === "crs-refused", "错误码应保持坐标系拒绝");
  check(!releasedText.includes("LOCAL_DATA_ACCESS_ERROR") && !releasedText.includes("本地数据暂时无法访问"), "不应改写成文件访问失败");

  const hidden = asRecord(releaseToModel({
    ok: false,
    code: "ENOENT",
    message: "ENOENT: no such file or directory, open 'C:\\Users\\alice\\secret\\data.gpkg'",
  }));
  const hiddenText = JSON.stringify(hidden);
  check(hidden.code === "LOCAL_DATA_ACCESS_ERROR", "真实路径仍应改写成访问失败");
  check(!hiddenText.includes("Users") && !hiddenText.includes("gpkg") && !hiddenText.includes("C:"), "真实路径不应交给模型");

  const root = await mkdtemp(join(tmpdir(), "igis-v0894-"));
  try {
    const geojson = JSON.stringify({
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: { 名称: "甲" }, geometry: { type: "Point", coordinates: [120, 30] } }],
    });
    const fileA = join(root, "points-a.geojson");
    const fileB = join(root, "points-b.geojson");
    await writeFile(fileA, geojson, { encoding: "utf8" });
    await writeFile(fileB, geojson, { encoding: "utf8" });
    const stack = await openSpatialStack({
      layerDirectory: join(root, "layers"),
      auditDirectory: join(root, "audit"),
      cacheDirectory: join(root, "cache"),
      modelName: () => "v0894",
    });
    const loadedA = await stack.service.loadFile(fileA, "points", false);
    const loadedB = await stack.service.loadFile(fileB, "points", false);
    const inside = loadedA[0]?.layerId ?? "";
    const outside = loadedB[0]?.layerId ?? "";
    check(inside !== "" && outside !== "" && inside !== outside, "应载入两个同名图层");
    const adapter = createSpatialAwareAdapter({ execute: () => Promise.resolve({ ok: false }) }, stack.service, { entry: "chat" });
    const call = { tool: "map.buffer" as const, args: { layerId: "points", distance: 10, unit: "meters" } };
    const globalHit = asRecord(await adapter.execute(call));
    const globalText = JSON.stringify(globalHit);
    check(globalHit.code === "ambiguous-layer", "没有对话范围时，同名层仍然歧义");
    check(globalText.includes(inside) && globalText.includes(outside), "全局歧义应同时列出两层");

    const scoped = asRecord(await stack.service.usingConversationLayers([inside], () => adapter.execute(call)));
    const scopedText = JSON.stringify(scoped);
    check(scoped.code !== "ambiguous-layer", "对话范围内的同名层不应再报歧义");
    check(!scopedText.includes(outside), "对话范围不应带上范围外的同名层");

    const empty = asRecord(await stack.service.usingConversationLayers([], () => adapter.execute(call)));
    const emptyText = JSON.stringify(empty);
    check(empty.code === "unknown-layer", "空的对话范围应视为没有图层");
    check(!emptyText.includes(inside) && !emptyText.includes(outside), "空范围不应回退到整个图层库");

    const listed = asRecord(await stack.service.usingConversationLayers([], () => adapter.execute({ tool: "map.list", args: {} })));
    const listedText = JSON.stringify(listed);
    check(Array.isArray(listed.layers) && listed.layers.length === 0, "空的对话范围下列出工具应返回空图层");
    check(!listedText.includes(inside) && !listedText.includes("points"), "列出工具不应带回范围外的旧图层");
    const one = asRecord(await stack.service.usingConversationLayers([inside], () => adapter.execute({ tool: "map.list", args: {} })));
    const oneLayers = one.layers;
    check(Array.isArray(oneLayers) && oneLayers.length === 1, "列出工具只返回对话范围内的图层");
    console.log("v0894-check passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

let failed: unknown = null;
try {
  await main();
} catch (error) {
  failed = error;
}
if (failed) throw failed;
