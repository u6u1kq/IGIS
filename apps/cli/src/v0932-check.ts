// SPDX-License-Identifier: Apache-2.0

/**
 * V0.93.2 本地专业模型：克里金、汇水分析、剖面、填挖方。
 * 先在没有权重时确认克里金和汇水返回不可用，再装一份测试权重跑通四个工具。
 * 运行（仓库根目录）：npx --yes tsx --tsconfig tsconfig.json apps/cli/src/v0932-check.ts
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cwd, env as nodeEnv } from "node:process";
import { createProcessBackend, ExternalCapabilityBoundary, managedPythonPath } from "@igis/external-gateway";
import { canonicalToolName, GIS_TOOL_REGISTRY, toApiToolName } from "@igis/llm-dispatch";
import { createSpatialAwareAdapter } from "../../../packages/spatial-ops/src/adapter.js";
import { parseProModel } from "../../../packages/spatial-ops/src/pro-model.js";
import { openSpatialStack, rasterHandle } from "../../../packages/spatial-ops/src/service.js";
import type { MapFeature } from "../../../packages/spatial-ops/src/types.js";

const REPO_ROOT = resolve(cwd());
const failures: string[] = [];

function check(condition: unknown, label: string): void {
  if (!condition) failures.push(label);
}

function run(command: string, args: readonly string[]): Promise<string> {
  return new Promise((done, reject) => {
    const child = spawn(command, [...args], { env: nodeEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => { stdout += typeof chunk === "string" ? chunk : String(chunk); });
    child.stderr.on("data", (chunk: Buffer | string) => { stderr += typeof chunk === "string" ? chunk : String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr.trim() || stdout.trim() || `退出码 ${String(code)}`));
      else done(stdout.trim());
    });
  });
}

const WRITER = `
import os, sys
for p in (os.path.join(sys.prefix, "Library", "bin"),):
    if os.path.isdir(p):
        os.environ["PATH"] = p + os.pathsep + os.environ.get("PATH", "")
import numpy
from osgeo import gdal, osr
gdal.UseExceptions()
out = sys.argv[1]
srs = osr.SpatialReference(); srs.ImportFromEPSG(3857)
xs = (numpy.arange(100) + 0.5) * 100
ys = 10000 - (numpy.arange(100) + 0.5) * 100
gx, gy = numpy.meshgrid(xs, ys)
dem = 0.02 * numpy.abs(gx - 5000) + 0.01 * gy + 50
dem[numpy.hypot(gx - 3000, gy - 6000) < 300] -= 5
after = dem.copy()
after[10:20, 10:20] += 2
after[50:60, 30:50] -= 1
for name, array in (("dem.tif", dem), ("after.tif", after)):
    ds = gdal.GetDriverByName("GTiff").Create(os.path.join(out, name), 100, 100, 1, gdal.GDT_Float32)
    ds.SetGeoTransform([0, 100, 0, 10000, 0, -100])
    ds.SetProjection(srs.ExportToWkt())
    ds.GetRasterBand(1).SetNoDataValue(-9999)
    ds.GetRasterBand(1).WriteArray(array.astype("float32"))
    ds = None
`;

function point(x: number, y: number, properties: Record<string, number> = {}): MapFeature {
  return { type: "Feature", properties, geometry: { type: "Point", coordinates: [x, y] } };
}

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

async function main(): Promise<void> {
  for (const [api, internal] of [["kriging", "map.kriging"], ["watershed", "map.watershed"], ["terrain_profile", "map.profile"], ["cut_fill", "map.cutFill"]] as const) {
    check(GIS_TOOL_REGISTRY.some((tool) => tool.name === internal), `登记表里应有 ${internal}`);
    check(canonicalToolName(api) === internal, `别名 ${api} 应指向 ${internal}`);
    check(toApiToolName(internal) === api, `${internal} 的接口名应是 ${api}`);
  }
  const python = managedPythonPath(REPO_ROOT);
  if (python === null) throw new Error("托管 Python 不在，检查不能跑。");
  const root = await mkdtemp(join(tmpdir(), "igis-v0932-"));
  const processApi = (globalThis as unknown as { process: { cwd(): string; chdir(directory: string): void } }).process;
  const previousDirectory = processApi.cwd();
  processApi.chdir(root);
  try {
    const rasterDir = join(root, "rasters");
    const modelDir = join(root, "models");
    await mkdir(rasterDir, { recursive: true });
    await mkdir(modelDir, { recursive: true });
    const writerPath = join(root, "write.py");
    await writeFile(writerPath, WRITER, { encoding: "utf8" });
    await run(python, [writerPath, rasterDir]);
    const bridge = resolve(REPO_ROOT, "packages/external-gateway/scripts/gdal-bridge.py");
    const boundary = new ExternalCapabilityBoundary({
      enabled: true,
      backend: createProcessBackend({ name: "python-osgeo-gdal", command: python, args: [bridge], availabilityArgs: [bridge, "--check"], env: { IGIS_BACKEND_ROOT: root } }),
    });
    const stack = await openSpatialStack({
      layerDirectory: join(root, "layers"),
      auditDirectory: join(root, "audit"),
      cacheDirectory: join(root, "cache"),
      modelName: () => "v0932",
      external: boundary,
      modelDirectory: modelDir,
    });
    const adapter = createSpatialAwareAdapter({ execute: async () => ({ ok: true }) }, stack.service, { entry: "chat", operationsRoot: root });
    const call = async (tool: string, args: Record<string, string | number | boolean>): Promise<Record<string, unknown>> => adapter.execute({ tool: tool as never, args }) as Promise<Record<string, unknown>>;
    const makeLayer = async (name: string, features: readonly MapFeature[], kind: "point" | "line", crsLabel: string): Promise<string> => {
      const made = await stack.service.createLayer({ layerName: name, collection: { type: "FeatureCollection", features: [...features] }, crsLabel, expectedKind: kind, sourceLabel: "v0932", writeKnowledge: false });
      return made.layer.layerId;
    };

    await stack.service.usingConversationWorkspace(root, async () => {
      const random = seeded(1);
      const samples = Array.from({ length: 200 }, () => {
        const x = random() * 10000;
        const y = random() * 10000;
        return point(x, y, { v: Math.sin(x / 2000) + Math.cos(y / 2500) });
      });
      const points = await makeLayer("采样点", samples, "point", "EPSG:3857");
      const outlets = await makeLayer("出水口", [point(5180, 120), point(5050, 5050)], "point", "EPSG:3857");
      const line = await makeLayer("剖面线", [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[500, 5050], [9500, 5050]] } }], "line", "EPSG:3857");

      const noKriging = await call("map.kriging", { layerId: points, fieldName: "v" });
      check(noKriging.ok === false && String(noKriging.message ?? "").includes("不可用"), `没有权重时克里金应不可用，实际 ${JSON.stringify(noKriging)}`);
      const noWatershed = await call("map.watershed", { rasterName: "dem.tif", layerId: outlets });
      check(noWatershed.ok === false && String(noWatershed.message ?? "").includes("不可用"), `没有权重时汇水应不可用，实际 ${JSON.stringify(noWatershed)}`);

      const profile = await call("map.profile", { rasterName: "dem.tif", layerId: line, outputName: "剖面" });
      check(profile.ok === true, `剖面应成功：${JSON.stringify(profile)}`);
      check(String(profile.message ?? "").includes("累计爬升 89"), `剖面爬升应为 89：${String(profile.message ?? "")}`);
      const profileRows = stack.catalog.collection(String(profile.layerId ?? ""))?.features ?? [];
      check(profileRows.length === 91, `剖面应有 91 个采样点，实际 ${profileRows.length}`);
      const middle = profileRows[45]?.properties ?? {};
      check(Math.abs(Number(middle.elevation) - 101.5) < 1e-6 && Math.abs(Number(middle.distance) - 4500) < 1e-6, `剖面中点应为 4500 米、101.5，实际 ${JSON.stringify(middle)}`);

      const cutFill = await call("map.cutFill", { rasterName: "dem.tif", otherRasterName: "after.tif" });
      check(cutFill.ok === true, `填挖方应成功：${JSON.stringify(cutFill)}`);
      check(String(cutFill.message ?? "").includes("填方 2e+06 立方米") && String(cutFill.message ?? "").includes("挖方 2e+06 立方米"), `填挖方应各 2e+06 立方米：${String(cutFill.message ?? "")}`);
      const difference = /差值栅格 (ras-[0-9a-f]{10})/.exec(String(cutFill.message ?? ""))?.[1] ?? "";
      check(difference === rasterHandle("dem-cutfill-after.tif"), `模型应看到差值栅格的句柄：${String(cutFill.message ?? "")}`);
      const chained = await call("map.profile", { rasterName: difference, layerId: line, outputName: "差值剖面" });
      check(chained.ok === true && String(chained.message ?? "").includes("最低 0，最高 0"), `句柄应能作为下一步的栅格名：${JSON.stringify(chained)}`);
      const missing = await call("map.profile", { rasterName: "ras-0000000000", layerId: line });
      check(missing.ok === false && String(missing.message ?? "").includes("ras-0000000000"), `不存在的句柄应拒绝：${JSON.stringify(missing)}`);

      await writeFile(join(modelDir, "model.json"), JSON.stringify({ format: "other" }), { encoding: "utf8" });
      const badWeights = await call("map.kriging", { layerId: points, fieldName: "v" });
      check(badWeights.ok === false && String(badWeights.message ?? "").includes("重新安装"), `坏权重应拒绝并提示重新安装，实际 ${JSON.stringify(badWeights)}`);

      const weights = parseProModel({
        format: "igis-pro-model",
        version: 1,
        name: "v0932-check",
        kriging: { model: "gaussian", nuggetRatio: 0.05, rangeRatio: 0.3, priorWeight: 20, neighbors: 16 },
        watershed: { streamArea: 1_000_000, snapDistance: 300 },
        trainingSets: 1,
      });
      await writeFile(join(modelDir, "model.json"), JSON.stringify(weights), { encoding: "utf8" });

      const kriging = await call("map.kriging", { layerId: points, fieldName: "v" });
      check(kriging.ok === true, `克里金应成功：${JSON.stringify(kriging)}`);
      const krigingText = String(kriging.message ?? "");
      const rmse = Number(/均方根误差 ([0-9.e+-]+)/.exec(krigingText)?.[1] ?? "NaN");
      check(rmse < 0.1, `克里金留一均方根误差应小于 0.1，实际 ${rmse}：${krigingText}`);
      check(krigingText.includes("v0932-check") && krigingText.includes(`方差栅格 ${rasterHandle("_-kriging-variance.tif")}`), `克里金结果应写明权重和方差栅格句柄：${krigingText}`);
      for (const name of ["采样点-kriging.tif", "采样点-kriging-variance.tif"]) {
        const stem = name.replace(/[^A-Za-z0-9._-]+/g, "_");
        check(await stat(join(rasterDir, stem)).then((info) => info.isFile(), () => false), `克里金应发布 ${stem}`);
      }
      check(!("localOutputResources" in kriging), "克里金的本地产物不应出现在模型可见结果里");

      const geographic = await makeLayer("经纬点", samples.slice(0, 20).map((feature, index) => point(110 + index * 0.01, 30 + (index % 5) * 0.01, { v: Number(feature.properties?.v ?? 0) })), "point", "EPSG:4326");
      const refused = await call("map.kriging", { layerId: geographic, fieldName: "v" });
      check(refused.ok === false && String(refused.message ?? "").includes("投影坐标"), `地理坐标克里金应拒绝：${JSON.stringify(refused)}`);

      const watershed = await call("map.watershed", { rasterName: "dem.tif", layerId: outlets, outputName: "流域" });
      check(watershed.ok === true, `汇水应成功：${JSON.stringify(watershed)}`);
      const watershedText = String(watershed.message ?? "");
      check(watershedText.includes("2 个流域") && watershedText.includes("上游总面积 50 平方千米") && watershedText.includes("汇水面积 14.25 平方千米"), `汇水面积不对：${watershedText}`);
      const basins = stack.catalog.collection(String(watershed.layerId ?? ""))?.features ?? [];
      check(basins.length >= 2 && basins.every((feature) => feature.geometry?.type === "Polygon"), `流域应载入至少 2 个面，实际 ${basins.length}`);
    });
    if (failures.length > 0) throw new Error(failures.join("\n"));
    console.log("v0932-check passed");
  } finally {
    processApi.chdir(previousDirectory);
    await rm(root, { recursive: true, force: true });
  }
}

await main();
