// SPDX-License-Identifier: Apache-2.0

/**
 * V0.94.1：水面抬高、爆炸图登记、地层输入核对、三维页只含图层标识和栅格句柄、权重安装。
 * 运行（仓库根目录）：npx --yes tsx --tsconfig tsconfig.json apps/cli/src/v0941-check.ts
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cwd, env as nodeEnv } from "node:process";
import { createProcessBackend, ExternalCapabilityBoundary, managedPythonPath } from "@igis/external-gateway";
import { canonicalToolName, GIS_TOOL_REGISTRY, toApiToolName } from "@igis/llm-dispatch";
import { createSpatialAwareAdapter } from "../../../packages/spatial-ops/src/adapter.js";
import { installProModel, ProModelError } from "../../../packages/spatial-ops/src/pro-model.js";
import { readSceneFile, sceneForPage } from "../../../packages/spatial-ops/src/scene.js";
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
out, kind = sys.argv[1], sys.argv[2]
srs = osr.SpatialReference()
srs.ImportFromEPSG(3857 if kind == "projected" else 4326)
dem = numpy.array([[10, 20], [30, 5]], dtype="float64")
ds = gdal.GetDriverByName("GTiff").Create(os.path.join(out, "dem.tif" if kind == "projected" else "dem-geo.tif"), 2, 2, 1, gdal.GDT_Float32)
ds.SetGeoTransform([0, 10, 0, 20, 0, -10])
ds.SetProjection(srs.ExportToWkt())
ds.GetRasterBand(1).SetNoDataValue(-9999)
ds.GetRasterBand(1).WriteArray(dem.astype("float32"))
ds = None
`;

const READER = `
import os, sys
for p in (os.path.join(sys.prefix, "Library", "bin"),):
    if os.path.isdir(p):
        os.environ["PATH"] = p + os.pathsep + os.environ.get("PATH", "")
from osgeo import gdal
gdal.UseExceptions()
ds = gdal.Open(sys.argv[1])
if ds is None:
    raise SystemExit("打不开水深栅格")
band = ds.GetRasterBand(1)
array = band.ReadAsArray()
print(",".join(f"{float(value):.6g}" for value in array.reshape(-1)))
ds = None
`;

function polygon(x: number, name: string): MapFeature {
  return {
    type: "Feature",
    properties: { name },
    geometry: { type: "Polygon", coordinates: [[[x, 0], [x + 10, 0], [x + 10, 10], [x, 10], [x, 0]]] },
  };
}

async function main(): Promise<void> {
  for (const [api, internal] of [["water_level", "map.waterLevel"], ["layer_stack", "map.layerStack"], ["geology_inputs", "map.geologyInputs"]] as const) {
    check(GIS_TOOL_REGISTRY.some((tool) => tool.name === internal), `登记表里应有 ${internal}`);
    check(canonicalToolName(api) === internal, `别名 ${api} 应指向 ${internal}`);
    check(toApiToolName(internal) === api, `${internal} 的接口名应是 ${api}`);
  }
  const page = sceneForPage({
    layers: [{ layerId: "lyr-1", layerName: "地面" }],
    handles: ["ras-0123456789"],
    collided: false,
    scene: { stack: null, geology: null, series: [], geologyModel: null },
  });
  const pageText = JSON.stringify(page);
  check(!pageText.includes("coordinates") && !pageText.includes(".tif") && pageText.includes("ras-0123456789") && pageText.includes("lyr-1"), `三维页只能有标识和句柄：${pageText}`);

  const python = managedPythonPath(REPO_ROOT);
  if (python === null) throw new Error("托管 Python 不在，检查不能跑。");
  const root = await mkdtemp(join(tmpdir(), "igis-v0941-"));
  const processApi = (globalThis as unknown as { process: { cwd(): string; chdir(directory: string): void } }).process;
  const previousDirectory = processApi.cwd();
  processApi.chdir(root);
  await mkdir(join(root, "rasters"), { recursive: true });
  await mkdir(join(root, "models"), { recursive: true });
  const modelDir = join(root, "models");
  const writerPath = join(root, "write.py");
  const readerPath = join(root, "read.py");
  await writeFile(writerPath, WRITER, { encoding: "utf8" });
  await writeFile(readerPath, READER, { encoding: "utf8" });
  await run(python, [writerPath, join(root, "rasters"), "projected"]);
  await run(python, [writerPath, join(root, "rasters"), "geographic"]);
  try {
    let installed = false;
    try {
      await installProModel(modelDir, { format: "nope" });
    } catch (error) {
      check(error instanceof ProModelError, "坏权重应拒绝");
      installed = false;
    }
    check(await stat(join(modelDir, "model.json")).then(() => false, () => true), "坏权重不应落盘");
    const weights = await installProModel(modelDir, {
      format: "igis-pro-model",
      version: 1,
      name: "v0941-check",
      kriging: { model: "spherical", nuggetRatio: 0.1, rangeRatio: 0.4, priorWeight: 8, neighbors: 8 },
      watershed: { streamArea: 1000, snapDistance: 20 },
      trainingSets: 2,
    });
    installed = weights.name === "v0941-check";
    check(installed, "合格权重应安装并留下名称");

    const bridge = resolve(REPO_ROOT, "packages/external-gateway/scripts/gdal-bridge.py");
    const boundary = new ExternalCapabilityBoundary({
      enabled: true,
      backend: createProcessBackend({ name: "python-osgeo-gdal", command: python, args: [bridge], availabilityArgs: [bridge, "--check"], env: { IGIS_BACKEND_ROOT: root } }),
    });
    const stack = await openSpatialStack({
      layerDirectory: join(root, "layers"),
      auditDirectory: join(root, "audit"),
      cacheDirectory: join(root, "cache"),
      modelName: () => "v0941",
      external: boundary,
      modelDirectory: modelDir,
    });
    const adapter = createSpatialAwareAdapter({ execute: async () => ({ ok: true }) }, stack.service, { entry: "chat", operationsRoot: root });
    const call = async (tool: string, args: Record<string, string | number | boolean>): Promise<Record<string, unknown>> => adapter.execute({ tool: tool as never, args }) as Promise<Record<string, unknown>>;
    const makeLayer = async (name: string, features: readonly MapFeature[], kind: "point" | "polygon" | "line"): Promise<string> => {
      const made = await stack.service.createLayer({ layerName: name, collection: { type: "FeatureCollection", features: [...features] }, crsLabel: "EPSG:3857", expectedKind: kind, sourceLabel: "v0941", writeKnowledge: false });
      return made.layer.layerId;
    };
    await stack.service.usingConversationWorkspace(root, async () => {
      const lower = await makeLayer("下层", [polygon(0, "下")], "polygon");
      const upper = await makeLayer("上层", [polygon(20, "上")], "polygon");
      const line = await makeLayer("界线", [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[0, 0], [10, 0]] } }], "line");
      const contacts = await makeLayer("界面点", [{ type: "Feature", properties: { formation: "砂层", dip: 25, azimuth: 140 }, geometry: { type: "Point", coordinates: [5, 5] } }], "point");

      const missingLevel = await call("map.waterLevel", { rasterName: "dem.tif" });
      check(missingLevel.ok === false && String(missingLevel.message ?? "").includes("水位没写"), `没写水位应追问：${JSON.stringify(missingLevel)}`);
      const geographic = await call("map.waterLevel", { rasterName: "dem-geo.tif", waterLevel: 15 });
      check(geographic.ok === false && String(geographic.message ?? "").includes("投影"), `地理坐标应拒绝：${JSON.stringify(geographic)}`);
      const flooded = await call("map.waterLevel", { rasterName: "dem.tif", waterLevel: 15 });
      const floodedText = String(flooded.message ?? "");
      check(flooded.ok === true && floodedText.includes("最高水深 10") && floodedText.includes("淹没面积 200"), `水深应为最高 10、面积 200：${floodedText}`);
      const handle = rasterHandle("dem-depth.tif");
      check(floodedText.includes(handle) && !floodedText.includes(".tif") && !floodedText.includes("coordinates"), `结果只给句柄：${floodedText}`);
      const depthValues = await run(python, [readerPath, join(root, "rasters", "dem-depth.tif")]);
      check(depthValues === "5,0,0,10", `水深像元应为 5,0,0,10，实际 ${depthValues}`);
      const chained = await call("map.waterLevel", { rasterName: handle, waterLevel: 3 });
      check(chained.ok === true && String(chained.message ?? "").includes("ras-"), `句柄应能接着做水面抬高：${JSON.stringify(chained)}`);

      const oneLayer = await call("map.layerStack", { layerIds: "下层", gap: 10 });
      check(oneLayer.ok === false && String(oneLayer.message ?? "").includes("至少两个"), `一层不应登记爆炸图：${JSON.stringify(oneLayer)}`);
      check((await readSceneFile(root)).stack === null, "一层失败后不应留下爆炸图登记");
      const stacked = await call("map.layerStack", { layerIds: `${lower},上层`, gap: 12.5 });
      check(stacked.ok === true && String(stacked.message ?? "").includes("下层") && String(stacked.message ?? "").includes("12.5") && String(stacked.message ?? "").includes("三维页"), `两层应只登记：${JSON.stringify(stacked)}`);
      const sceneText = await readFile(join(root, "scene.json"), { encoding: "utf8" });
      const scene = await readSceneFile(root);
      check(scene.stack?.gap === 12.5 && scene.stack.order.map((item) => item.layerId).join(",") === `${lower},${upper}`, `登记顺序应为下到上：${sceneText}`);
      check(!sceneText.includes("coordinates") && !sceneText.includes("Polygon"), `登记文件不能有几何：${sceneText}`);

      const notPoints = await call("map.geologyInputs", { layerId: line, fieldName: "formation", groupField: "dip", target: "azimuth" });
      check(notPoints.ok === false && String(notPoints.message ?? "").includes("界面点"), `线图层不能当地层输入：${JSON.stringify(notPoints)}`);
      const missingField = await call("map.geologyInputs", { layerId: contacts, fieldName: "formation", groupField: "missing", target: "azimuth" });
      check(missingField.ok === false && String(missingField.message ?? "").includes("字段"), `缺字段应追问：${JSON.stringify(missingField)}`);
      check((await readSceneFile(root)).geology === null, "缺字段时不登记地层输入");
      const geology = await call("map.geologyInputs", { layerId: "界面点", fieldName: "formation", groupField: "dip", target: "azimuth" });
      const geologyText = String(geology.message ?? "");
      check(geology.ok === true && geologyText.includes("不生成地层体") && geologyText.includes("formation") && !geologyText.includes("coordinates"), `应只登记字段名：${geologyText}`);
      const recorded = await readSceneFile(root);
      check(recorded.geology?.contactField === "formation" && recorded.geology.dipField === "dip" && recorded.geology.azimuthField === "azimuth" && recorded.geology.layerId === contacts, `地层输入应记下字段：${JSON.stringify(recorded.geology)}`);

      const listed = sceneForPage({
        layers: [{ layerId: lower, layerName: "下层" }, { layerId: upper, layerName: "上层" }],
        handles: [handle],
        collided: false,
        scene: recorded,
      });
      const listedText = JSON.stringify(listed);
      check(listed.rasters[0]?.handle === handle && listed.stack?.gap === 12.5 && !listedText.includes("dem-depth") && !listedText.includes("coordinates"), `三维页载荷不能带文件名或坐标：${listedText}`);
    });
  } finally {
    processApi.chdir(previousDirectory);
    await rm(root, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    throw new Error(`v0941-check 失败 ${failures.length} 项`);
  }
  console.log("v0941-check passed");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  (globalThis as { process?: { exitCode?: number } }).process!.exitCode = 1;
});
