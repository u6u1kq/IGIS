// SPDX-License-Identifier: Apache-2.0

/**
 * V0.94.2：降雨径流（ANUGA）、降雨滑坡（TRIGRS）、地层体（LoopStructural）、三维页载荷、引擎锁文件。
 * 需要 var/engines-python 和 var/engines/trigrs（设置里“安装计算引擎”）。
 * 运行（仓库根目录）：npx --yes tsx --tsconfig tsconfig.json apps/cli/src/v0942-check.ts
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cwd, env as nodeEnv } from "node:process";
import { createProcessBackend, enginesPythonPath, ExternalCapabilityBoundary, managedPythonPath, readEnginesLock, trigrsSourceOrder } from "@igis/external-gateway";
import { canonicalToolName, GIS_TOOL_REGISTRY, toApiToolName } from "@igis/llm-dispatch";
import { createSpatialAwareAdapter } from "../../../packages/spatial-ops/src/adapter.js";
import { GEOLOGY_FILE, readSceneFile, sceneForPage } from "../../../packages/spatial-ops/src/scene.js";
import { openSpatialStack } from "../../../packages/spatial-ops/src/service.js";
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
import os, sys, math
for p in (os.path.join(sys.prefix, "Library", "bin"),):
    if os.path.isdir(p):
        os.environ["PATH"] = p + os.pathsep + os.environ.get("PATH", "")
import numpy
from osgeo import gdal, osr
gdal.UseExceptions()
out = sys.argv[1]
def save(name, array, epsg, cell=(10.0, 10.0), nodata=-9999.0):
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(epsg)
    rows, cols = array.shape
    ds = gdal.GetDriverByName("GTiff").Create(os.path.join(out, name), cols, rows, 1, gdal.GDT_Float32)
    ds.SetGeoTransform([1000.0, cell[0], 0, 5000.0, 0, -cell[1]])
    ds.SetProjection(srs.ExportToWkt())
    ds.GetRasterBand(1).SetNoDataValue(nodata)
    ds.GetRasterBand(1).WriteArray(array.astype("float32"))
    ds = None
x = numpy.arange(40) * 10.0
slope = numpy.tile(x * math.tan(math.radians(35)), (40, 1))
save("slope35.tif", slope, 3857)
save("slope35-geo.tif", slope, 4326, cell=(0.0001, 0.0001))
save("slope35-wide.tif", slope[:, :20], 3857, cell=(20.0, 10.0))
yy, xx = numpy.mgrid[0:40, 0:40]
bowl = 0.02 * ((xx - 20) ** 2 + (yy - 20) ** 2)
save("bowl.tif", bowl, 3857)
holed = bowl.copy()
holed[5, 5] = -9999.0
save("bowl-hole.tif", holed, 3857)
ramp = numpy.tile(numpy.arange(400, dtype="float32"), (200, 1))
save("wide.tif", ramp, 3857)
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
    raise SystemExit("打不开栅格")
array = ds.GetRasterBand(1).ReadAsArray()
print(f"{float(array.max()):.6g},{float(array.min()):.6g}")
ds = None
`;

function contact(x: number, y: number, z: number, formation: string, dip: number | null, azimuth: number | null): MapFeature {
  return {
    type: "Feature",
    properties: { formation, dip, azimuth },
    geometry: { type: "Point", coordinates: [x, y, z] },
  };
}

function numberAfter(text: string, label: string): number[] {
  const values: number[] = [];
  const pattern = new RegExp(`${label} ([0-9.eE+-]+)`, "g");
  for (const matched of text.matchAll(pattern)) values.push(Number(matched[1]));
  return values;
}

async function main(): Promise<void> {
  for (const [api, internal] of [["rainfall_runoff", "map.rainfallRunoff"], ["rainfall_landslide", "map.rainfallLandslide"], ["geology_model", "map.geologyModel"]] as const) {
    check(GIS_TOOL_REGISTRY.some((tool) => tool.name === internal), `登记表里应有 ${internal}`);
    check(canonicalToolName(api) === internal, `别名 ${api} 应指向 ${internal}`);
    check(toApiToolName(internal) === api, `${internal} 的接口名应是 ${api}`);
  }
  const lock = await readEnginesLock(REPO_ROOT);
  check(lock.python.noDeps.includes("anuga==4.0.1") && lock.python.packages.includes("LoopStructural==1.8.2") && /^[0-9a-f]{64}$/.test(lock.trigrs.sha256), "锁文件应钉住 ANUGA、LoopStructural 和 TRIGRS 源码哈希");
  const order = trigrsSourceOrder(["trigrs.f90", "grids.f95", "trigrs_p.f90", "calerf.f", "input_vars.f95", "model_vars.f95", "input_file_defs.f95", "rnoff.f95", "modules_p.f90"]);
  check(order.slice(0, 4).join(",") === "grids.f95,input_vars.f95,model_vars.f95,input_file_defs.f95" && !order.some((name) => name.includes("_p")) && order.at(-1) === "calerf.f", `TRIGRS 编译顺序不对：${order.join(",")}`);

  const python = managedPythonPath(REPO_ROOT);
  const enginesPython = enginesPythonPath(REPO_ROOT);
  if (python === null) throw new Error("托管 Python 不在，检查不能跑。");
  if (enginesPython === null) throw new Error("var/engines-python 不在。请先在设置里安装计算引擎。");
  const root = await mkdtemp(join(tmpdir(), "igis-v0942-"));
  const processApi = (globalThis as unknown as { process: { cwd(): string; chdir(directory: string): void } }).process;
  const previousDirectory = processApi.cwd();
  processApi.chdir(root);
  await mkdir(join(root, "rasters"), { recursive: true });
  const writerPath = join(root, "write.py");
  const readerPath = join(root, "read.py");
  await writeFile(writerPath, WRITER, { encoding: "utf8" });
  await writeFile(readerPath, READER, { encoding: "utf8" });
  await run(python, [writerPath, join(root, "rasters")]);
  try {
    const gdalBridge = resolve(REPO_ROOT, "packages/external-gateway/scripts/gdal-bridge.py");
    const engineBridge = resolve(REPO_ROOT, "packages/external-gateway/scripts/engine-bridge.py");
    const external = new ExternalCapabilityBoundary({
      enabled: true,
      backend: createProcessBackend({ name: "python-osgeo-gdal", command: python, args: [gdalBridge], availabilityArgs: [gdalBridge, "--check"], env: { IGIS_BACKEND_ROOT: root } }),
    });
    const engines = new ExternalCapabilityBoundary({
      enabled: true,
      backend: createProcessBackend({ name: "engines-python", command: enginesPython, args: [engineBridge], availabilityArgs: [engineBridge, "--check"], env: { IGIS_BACKEND_ROOT: root, IGIS_ENGINE_DIR: resolve(REPO_ROOT, "var/engines") } }),
    });
    const status = await engines.status();
    check(status.available && status.message.includes("TRIGRS") && status.message.includes("anuga") && status.message.includes("LoopStructural"), `引擎自检应报三个引擎：${status.message}`);
    const stack = await openSpatialStack({
      layerDirectory: join(root, "layers"),
      auditDirectory: join(root, "audit"),
      cacheDirectory: join(root, "cache"),
      modelName: () => "v0942",
      external,
      engines,
    });
    const adapter = createSpatialAwareAdapter({ execute: async () => ({ ok: true }) }, stack.service, { entry: "chat", operationsRoot: root });
    const call = async (tool: string, args: Record<string, string | number | boolean>): Promise<Record<string, unknown>> => adapter.execute({ tool: tool as never, args }) as Promise<Record<string, unknown>>;
    const text = (result: Record<string, unknown>) => String(result.message ?? "");
    const soil = { cohesion: 4, frictionAngle: 32, unitWeight: 20, diffusivity: 5e-5, ksat: 1e-5, soilDepth: 2 };

    await stack.service.usingConversationWorkspace(root, async () => {
      // ---- 降雨径流 ----
      const noManning = await call("map.rainfallRunoff", { rasterName: "bowl.tif", scenarios: "50x0.5" });
      check(noManning.ok === false && text(noManning).includes("曼宁糙率没写"), `没写糙率应追问：${text(noManning)}`);
      const noRain = await call("map.rainfallRunoff", { rasterName: "bowl.tif", manning: 0.04 });
      check(noRain.ok === false && text(noRain).includes("降雨情景没写"), `没写情景应追问：${text(noRain)}`);
      const badRain = await call("map.rainfallRunoff", { rasterName: "bowl.tif", manning: 0.04, scenarios: "大雨" });
      check(badRain.ok === false && text(badRain).includes("看不懂"), `看不懂的情景应追问：${text(badRain)}`);
      check((await readSceneFile(root)).series.length === 0, "追问时不应登记情景");
      const geographic = await call("map.rainfallRunoff", { rasterName: "slope35-geo.tif", manning: 0.04, scenarios: "50x0.5" });
      check(geographic.ok === false && text(geographic).includes("投影"), `地理坐标应拒绝：${text(geographic)}`);
      const holed = await call("map.rainfallRunoff", { rasterName: "bowl-hole.tif", manning: 0.04, scenarios: "50x0.5" });
      check(holed.ok === false && text(holed).includes("空值"), `有空值的 DEM 应拒绝：${text(holed)}`);

      const closed = await call("map.rainfallRunoff", { rasterName: "bowl.tif", manning: 0.04, scenarios: "50x0.5", simulationHours: 1, steps: 2, boundary: "closed" });
      const closedText = text(closed);
      check(closed.ok === true && closedText.includes("降雨 4000 立方米，结束时地表存水 4000 立方米"), `封闭盆地水量应守恒：${closedText}`);
      check(!closedText.includes(".tif") && !closedText.includes("coordinates") && (closedText.match(/ras-[0-9a-f]{10}/g) ?? []).length >= 3, `结果只给句柄：${closedText}`);
      const depths = numberAfter(closedText, "最大水深");
      check(depths.length === 2 && depths[1]! > depths[0]! && depths[0]! > 0, `盆底水深应随时间加深：${depths.join(",")}`);
      const afterClosed = await readSceneFile(root);
      const firstSeries = afterClosed.series.find((item) => item.seriesId === "runoff-1");
      check(firstSeries?.steps.length === 2 && firstSeries.terrain === "bowl.tif" && firstSeries.peak !== null && firstSeries.steps[1]!.hours === 1, `情景应登记两个时刻和地形：${JSON.stringify(afterClosed.series)}`);
      if (firstSeries) {
        const info = await call("map.rasterInfo", { rasterName: firstSeries.steps[1]!.handle });
        check(info.ok === true, `水深句柄应能接着用：${text(info)}`);
        const grid = await stack.service.terrainGrid(firstSeries.steps[1]!.handle, 160);
        check(grid.width === 40 && grid.height === 40 && Array.isArray(grid.values) && (grid.values as unknown[]).length === 1600, `三维网格应是 40x40：${String(grid.width)}x${String(grid.height)}`);
      }
      const downsampled = await stack.service.terrainGrid("wide.tif", 160) as { width?: number; height?: number };
      check(downsampled.width !== undefined && downsampled.height !== undefined && downsampled.width <= 160 && downsampled.height <= 160 && Math.max(downsampled.width, downsampled.height) === 160, `超过 160 的高程应降采样到长边 160：${String(downsampled.width)}x${String(downsampled.height)}`);

      const stopped = await call("map.rainfallRunoff", { rasterName: "bowl.tif", manning: 0.04, scenarios: "40x0.25;50x30;20x0.25", steps: 1 });
      const stoppedText = text(stopped);
      check(stopped.ok === false && stoppedText.includes("情景 2") && stoppedText.includes("失败") && stoppedText.includes("已完成的 1 个情景保留") && stoppedText.includes("后面 1 个情景没有算"), `一个情景失败应停下：${stoppedText}`);
      const afterStop = await readSceneFile(root);
      check(afterStop.series.some((item) => item.seriesId === "runoff-2" && item.steps.length === 1) && !afterStop.series.some((item) => item.seriesId === "runoff-3" || item.seriesId === "runoff-4"), `失败后已完成的保留、后面的不算：${afterStop.series.map((item) => `${item.seriesId}:${item.steps.length}`).join(",")}`);
      const kept = afterStop.series.find((item) => item.seriesId === "runoff-1");
      check(kept?.steps.length === 2 && firstSeries !== undefined && kept.steps.every((step, offset) => step.handle === firstSeries.steps[offset]?.handle) && !firstSeries.steps.some((step) => stoppedText.includes(step.handle)), `再算一次不能覆盖旧句柄：${stoppedText}`);

      // ---- 降雨滑坡 ----
      const missingSoil = await call("map.rainfallLandslide", { rasterName: "slope35.tif", scenarios: "20x6", cohesion: 4 });
      check(missingSoil.ok === false && text(missingSoil).includes("还缺") && text(missingSoil).includes("内摩擦角") && text(missingSoil).includes("初始地下水位埋深") && !text(missingSoil).includes("黏聚力"), `缺土体参数应逐项追问：${text(missingSoil)}`);
      const wide = await call("map.rainfallLandslide", { rasterName: "slope35-wide.tif", scenarios: "20x6", ...soil, waterTableDepth: 1.5 });
      check(wide.ok === false && text(wide).includes("正方形"), `非正方形像元应拒绝：${text(wide)}`);
      const slopeGeo = await call("map.rainfallLandslide", { rasterName: "slope35-geo.tif", scenarios: "20x6", ...soil, waterTableDepth: 1.5 });
      check(slopeGeo.ok === false && text(slopeGeo).includes("投影"), `地理坐标应拒绝：${text(slopeGeo)}`);

      // 地下水位压在滑面上、几乎不下雨时，安全系数等于无限边坡式：tanφ/tanδ + c/(γ z sinδ cosδ) = 1.1052。
      const dryLimit = await call("map.rainfallLandslide", { rasterName: "slope35.tif", scenarios: "0.001x1", ...soil, waterTableDepth: 2, steps: 1 });
      const fsDry = numberAfter(text(dryLimit), "最小安全系数")[0] ?? Number.NaN;
      check(dryLimit.ok === true && Math.abs(fsDry - 1.1052) < 0.01, `水位在滑面时安全系数应为 1.1052：${text(dryLimit)}`);
      const wet = await call("map.rainfallLandslide", { rasterName: "slope35.tif", scenarios: "20x6", ...soil, waterTableDepth: 1.5, steps: 3 });
      const wetText = text(wet);
      const fs = numberAfter(wetText, "最小安全系数");
      check(wet.ok === true && fs.length === 3 && fs[0]! >= fs[1]! && fs[1]! >= fs[2]! && fs[2]! < fs[0]!, `安全系数应随降雨下降：${fs.join(",")}`);
      check(wetText.includes("初始入渗率按 0") && wetText.includes("没有做径流汇流") && !wetText.includes(".tif"), `默认值和局限要写明：${wetText}`);
      const landslideSeries = (await readSceneFile(root)).series.find((item) => item.seriesId === "landslide-2");
      check(landslideSeries?.kind === "landslide" && landslideSeries.steps.length === 3, "第二次滑坡应登记为 landslide-2，三个时刻");
      if (landslideSeries) {
        const values = await run(python, [readerPath, join(root, "rasters", "slope35-fs2-t3.tif")]);
        check(Math.abs(Number(values.split(",")[1]) - fs[2]!) < 0.001, `安全系数栅格最小值应和消息一致：${values}`);
      }

      // ---- 地层体 ----
      const contacts = await stack.service.createLayer({
        layerName: "界面点",
        collection: {
          type: "FeatureCollection",
          features: [
            contact(1000, 4000, 50, "砂岩", 0, 0), contact(1400, 4000, 50, "砂岩", null, null), contact(1000, 4400, 50, "砂岩", null, null), contact(1400, 4400, 50, "砂岩", null, null),
            contact(1100, 4100, 100, "页岩", 0, 0), contact(1300, 4300, 100, "页岩", null, null), contact(1100, 4300, 100, "页岩", null, null),
          ],
        },
        crsLabel: "EPSG:3857",
        expectedKind: "point",
        sourceLabel: "v0942",
        writeKnowledge: false,
      });
      const other = await stack.service.createLayer({
        layerName: "别的点",
        collection: { type: "FeatureCollection", features: [contact(1000, 4000, 50, "砂岩", 0, 0)] },
        crsLabel: "EPSG:3857",
        expectedKind: "point",
        sourceLabel: "v0942",
        writeKnowledge: false,
      });
      const unregistered = await call("map.geologyModel", { layerId: "界面点", depth: 50 });
      check(unregistered.ok === false && text(unregistered).includes("还没有登记"), `没登记应先登记：${text(unregistered)}`);
      const registered = await call("map.geologyInputs", { layerId: "界面点", fieldName: "formation", groupField: "dip", target: "azimuth" });
      check(registered.ok === true && text(registered).includes("map.geologyModel"), `登记应提示下一步：${text(registered)}`);
      const noDepth = await call("map.geologyModel", { layerId: "界面点" });
      check(noDepth.ok === false && text(noDepth).includes("深度没写"), `没写深度应追问：${text(noDepth)}`);
      const wrongLayer = await call("map.geologyModel", { layerId: other.layer.layerId, depth: 50 });
      check(wrongLayer.ok === false && text(wrongLayer).includes("登记的界面点图层"), `换图层应拒绝：${text(wrongLayer)}`);
      const body = await call("map.geologyModel", { layerId: contacts.layer.layerId, depth: 50 });
      const bodyText = text(body);
      check(body.ok === true && bodyText.includes("从下到上：砂岩、页岩") && !bodyText.includes("coordinates") && !bodyText.includes(".json"), `水平地层应从下到上排序：${bodyText}`);
      const model = (await readSceneFile(root)).geologyModel;
      // 范围 400x400，z 从 0 到 100：界面 50 以下 50 米厚，砂岩 50 到 100 米厚，页岩厚度为 0。
      const expected = 400 * 400 * 50;
      check(model !== null && model.units.join(",") === "底部以下,砂岩,页岩" && Math.abs(model.volumes[0]! - expected) / expected < 0.1 && Math.abs(model.volumes[1]! - expected) / expected < 0.1 && model.volumes[2]! < expected * 0.1, `体积应接近面积乘厚度：${JSON.stringify(model)}`);
      const voxels = JSON.parse(await readFile(join(root, GEOLOGY_FILE), { encoding: "utf8" })) as { grid: number[]; cells: number[] };
      check(voxels.cells.length === voxels.grid.reduce((a, b) => a * b, 1), "体素数应等于网格数");

      const reversed = await stack.service.createLayer({
        layerName: "倒序点",
        collection: {
          type: "FeatureCollection",
          features: [
            contact(1000, 4000, 40, "M", 0, 0), contact(1400, 4000, 40, "M", null, null), contact(1000, 4400, 40, "M", null, null), contact(1400, 4400, 40, "M", null, null),
            contact(1100, 4100, 80, "A", 0, 0), contact(1300, 4300, 80, "A", null, null), contact(1100, 4300, 80, "A", null, null),
          ],
        },
        crsLabel: "EPSG:3857",
        expectedKind: "point",
        sourceLabel: "v0942",
        writeKnowledge: false,
      });
      const reversedInputs = await call("map.geologyInputs", { layerId: reversed.layer.layerId, fieldName: "formation", groupField: "dip", target: "azimuth" });
      check(reversedInputs.ok === true, `倒序界面点应能登记：${text(reversedInputs)}`);
      const reversedBody = await call("map.geologyModel", { layerId: reversed.layer.layerId, depth: 20 });
      check(reversedBody.ok === true && text(reversedBody).includes("从下到上：M、A"), `字母顺序和地层顺序相反时仍应按高程从下到上：${text(reversedBody)}`);

      const tan30 = Math.tan((30 * Math.PI) / 180);
      const dipped = await stack.service.createLayer({
        layerName: "倾向点",
        collection: {
          type: "FeatureCollection",
          features: [
            contact(1000, 4000, 100, "底", 30, 90),
            contact(1300, 4000, 100 - tan30 * 300, "底", 30, 90),
            contact(1000, 4300, 100, "底", 30, 90),
            contact(1300, 4300, 100 - tan30 * 300, "底", 30, 90),
            contact(1100, 4100, 130 - tan30 * 100, "顶", 30, 90),
            contact(1250, 4200, 130 - tan30 * 250, "顶", 30, 90),
            contact(1150, 4250, 130 - tan30 * 150, "顶", 30, 90),
          ],
        },
        crsLabel: "EPSG:3857",
        expectedKind: "point",
        sourceLabel: "v0942",
        writeKnowledge: false,
      });
      const dippedInputs = await call("map.geologyInputs", { layerId: dipped.layer.layerId, fieldName: "formation", groupField: "dip", target: "azimuth" });
      check(dippedInputs.ok === true, `倾向界面点应能登记：${text(dippedInputs)}`);
      const dippedBody = await call("map.geologyModel", { layerId: dipped.layer.layerId, depth: 40 });
      check(dippedBody.ok === true && text(dippedBody).includes("从下到上：底、顶"), `倾向 90 度应从下到上是底、顶：${text(dippedBody)}`);
      const dippedModel = JSON.parse(await readFile(join(root, GEOLOGY_FILE), { encoding: "utf8" })) as { grid: number[]; cells: number[] };
      const [nx = 0, ny = 0, nz = 0] = dippedModel.grid;
      const meanK = (column: number): number | null => {
        const row = Math.floor(ny / 2);
        let sum = 0;
        let count = 0;
        for (let k = 0; k < nz; k += 1) {
          if (dippedModel.cells[(k * ny + row) * nx + column] === 1) {
            sum += k;
            count += 1;
          }
        }
        return count > 0 ? sum / count : null;
      };
      const west = meanK(Math.floor(nx * 0.25));
      const east = meanK(Math.floor(nx * 0.75));
      check(west !== null && east !== null && west > east + 1, `倾向正东时底界面应向东降低：西 ${String(west)}，东 ${String(east)}`);

      // ---- 三维页载荷 ----
      const scene = await readSceneFile(root);
      const page = sceneForPage({ layers: [{ layerId: contacts.layer.layerId, layerName: "界面点" }], handles: [], collided: false, scene });
      const pageText = JSON.stringify(page);
      check(page.series.length >= 2 && page.geologyModel?.units.length === 3 && !pageText.includes(".tif") && !pageText.includes("bowl") && !pageText.includes("terrain") && !pageText.includes("coordinates"), `三维页载荷不能带文件名或坐标：${pageText}`);
      const sceneText = await readFile(join(root, "scene.json"), { encoding: "utf8" });
      check(!sceneText.includes("coordinates") && !sceneText.includes(":\\\\") && !sceneText.includes("/rasters/"), `登记文件不能有坐标或路径：${sceneText}`);
    });
    const leftovers = await stat(join(root, "var", "backends")).then(() => true, () => false);
    check(leftovers, "引擎产物应写在 var/backends");
  } finally {
    processApi.chdir(previousDirectory);
    await rm(root, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    throw new Error(`v0942-check 失败 ${failures.length} 项`);
  }
  console.log("v0942-check passed");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  (globalThis as { process?: { exitCode?: number } }).process!.exitCode = 1;
});
