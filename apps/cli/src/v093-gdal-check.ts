// SPDX-License-Identifier: Apache-2.0

/**
 * V0.93.1 GDAL 实跑：平行线、最小费用走廊、监督分类，以及可视域、裁剪、
 * 栅格转面、面转栅格、按面统计、重采样、指数、邻域。
 * 运行：npx tsx --tsconfig tsconfig.json apps/cli/src/v093-gdal-check.ts
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { env as nodeEnv } from "node:process";
import { kinks, lineOffset } from "@turf/turf";
import { createProcessBackend, ExternalCapabilityBoundary, managedPythonPath } from "@igis/external-gateway";
import { createSpatialAwareAdapter } from "../../../packages/spatial-ops/src/adapter.js";
import { readOperationRecord } from "../../../packages/spatial-ops/src/operation-attempt.js";
import { openSpatialStack } from "../../../packages/spatial-ops/src/service.js";
import type { MapCollection, MapFeature } from "../../../packages/spatial-ops/src/types.js";

const REPO_ROOT = resolve("E:/ai工作区/Igis");

const failures: string[] = [];

function check(condition: unknown, label: string): void {
  if (!condition) failures.push(label);
}

function close(actual: number, expected: number, tolerance: number): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

function lineFeature(coordinates: readonly (readonly [number, number])[]): MapFeature {
  return { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coordinates.map((pair) => [pair[0], pair[1]]) } };
}

function pointFeature(x: number, y: number, properties: Record<string, string | number | boolean | null> = {}): MapFeature {
  return { type: "Feature", properties, geometry: { type: "Point", coordinates: [x, y] } };
}

function square(x: number, y: number, width: number, height: number): MapFeature {
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [[[x, y], [x + width, y], [x + width, y + height], [x, y + height], [x, y]]] },
  };
}

function collection(features: readonly MapFeature[]): MapCollection {
  return { type: "FeatureCollection", features: [...features] };
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

async function catchMessage(body: () => Promise<unknown>): Promise<string> {
  try {
    await body();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function pointSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const length2 = dx * dx + dy * dy;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length2));
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}

function vertexPairs(feature: MapFeature): Array<readonly [number, number]> {
  const geometry = feature.geometry;
  if (!geometry) return [];
  if (geometry.type === "LineString") return geometry.coordinates.map((pair) => [pair[0] ?? 0, pair[1] ?? 0] as const);
  if (geometry.type === "MultiLineString") {
    return geometry.coordinates.flatMap((line) => line.map((pair) => [pair[0] ?? 0, pair[1] ?? 0] as const));
  }
  return [];
}

function distanceToLines(x: number, y: number, lines: readonly MapFeature[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const feature of lines) {
    const pairs = vertexPairs(feature);
    for (let index = 1; index < pairs.length; index += 1) {
      const start = pairs[index - 1];
      const end = pairs[index];
      if (!start || !end) continue;
      best = Math.min(best, pointSegmentDistance(x, y, start[0], start[1], end[0], end[1]));
    }
  }
  return best;
}

interface RasterDump {
  readonly width: number;
  readonly height: number;
  readonly nodata: number | null;
  readonly projection: string;
  readonly gt: number[];
  readonly values: number[][];
}

const READER = String.raw`
import json, os, sys
os.environ["PATH"] = os.path.join(sys.prefix, "Library", "bin") + os.pathsep + os.environ.get("PATH", "")
from osgeo import gdal
gdal.UseExceptions()
dataset = gdal.Open(sys.argv[1])
band = dataset.GetRasterBand(1)
array = band.ReadAsArray()
nodata = band.GetNoDataValue()
json.dump({
    "width": dataset.RasterXSize,
    "height": dataset.RasterYSize,
    "nodata": None if nodata is None else float(nodata),
    "projection": dataset.GetProjection() or "",
    "gt": [float(value) for value in dataset.GetGeoTransform()],
    "values": [[float(value) for value in row] for row in array],
}, sys.stdout)
`;

const WRITER = String.raw`
import json, os, sys
os.environ["PATH"] = os.path.join(sys.prefix, "Library", "bin") + os.pathsep + os.environ.get("PATH", "")
from osgeo import gdal, osr
import numpy as np
gdal.UseExceptions()
out = sys.argv[1]
srs = osr.SpatialReference()
srs.ImportFromEPSG(3857)
wkt = srs.ExportToWkt()

def write(name, array, gt, nodata, dtype):
    dataset = gdal.GetDriverByName("GTiff").Create(os.path.join(out, name), array.shape[1], array.shape[0], 1, dtype)
    dataset.SetGeoTransform(gt)
    dataset.SetProjection(wkt)
    band = dataset.GetRasterBand(1)
    band.WriteArray(array)
    if nodata is not None:
        band.SetNoDataValue(nodata)
    dataset.FlushCache()

write("cost.tif", np.ones((10, 10), np.float32), [0, 1, 0, 10, 0, -1], -9999, gdal.GDT_Float32)
barrier = np.ones((10, 10), np.float32)
barrier[:, 5] = -9999
barrier[8, 5] = 1
write("barrier.tif", barrier, [0, 1, 0, 10, 0, -1], -9999, gdal.GDT_Float32)
dem = np.zeros((50, 50), np.float32)
dem[:, 25] = 100
write("dem.tif", dem, [1000, 10, 0, 1500, 0, -10], -9999, gdal.GDT_Float32)
zones = np.ones((10, 10), np.float32)
zones[:, 5:] = 2
write("zones.tif", zones, [1000, 10, 0, 1100, 0, -10], None, gdal.GDT_Float32)
nir = np.array([[0.6, 1.0], [0.6, -9999.0]], np.float32)
red = np.array([[0.2, -1.0], [0.2, 0.2]], np.float32)
write("nir.tif", nir, [0, 1, 0, 2, 0, -1], -9999, gdal.GDT_Float32)
write("red.tif", red, [0, 1, 0, 2, 0, -1], None, gdal.GDT_Float32)
focal = np.ones((5, 5), np.float32)
focal[2, 2] = 10
write("focal.tif", focal, [0, 1, 0, 5, 0, -1], None, gdal.GDT_Float32)
rng = np.random.default_rng(7)
truth = np.zeros((40, 40), np.int32)
truth[:, 14:27] = 1
truth[:, 27:] = 2
means = np.array([[10.0, 2.0, 2.0], [2.0, 10.0, 2.0], [2.0, 2.0, 10.0]])
cube = means[truth] + rng.uniform(-0.4, 0.4, (40, 40, 3))
for band in range(3):
    write(f"band{band}.tif", cube[:, :, band].astype(np.float32), [0, 1, 0, 40, 0, -1], None, gdal.GDT_Float32)
write("band-shift.tif", cube[:, :, 0].astype(np.float32), [0, 2, 0, 40, 0, -2], None, gdal.GDT_Float32)
write("truth.tif", truth.astype(np.float32), [0, 1, 0, 40, 0, -1], None, gdal.GDT_Float32)
points = []
names = ["forest", "water", "urban"]
for code in range(3):
    cells = np.argwhere(truth == code)
    pick = rng.choice(cells.shape[0], 30, replace=False)
    for row, column in cells[pick]:
        points.append({"kind": names[int(code)], "x": float(column) + 0.5, "y": 40.0 - (float(row) + 0.5)})
json.dump(points, open(os.path.join(out, "train.json"), "w", encoding="utf-8"))
`;

async function main(): Promise<void> {
  const python = managedPythonPath(REPO_ROOT);
  if (python === null) throw new Error("托管 Python 不在，GDAL 检查不能跑。");
  const root = await mkdtemp(join(tmpdir(), "igis-v093g-"));
  check(!resolve(root).toLowerCase().startsWith(REPO_ROOT.toLowerCase()), "用例目录不能落在仓库里");
  // 桌面把工作区设成进程当前目录，桥返回的相对路径按当前目录解析。检查时同样切过去。
  const processApi = (globalThis as unknown as { process: { cwd(): string; chdir(directory: string): void } }).process;
  const previousDirectory = processApi.cwd();
  processApi.chdir(root);
  const locate = (resource: string): string => (isAbsolute(resource) ? resource : join(root, resource));
  try {
    const rasterDir = join(root, "rasters");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(rasterDir, { recursive: true });
    const writerPath = join(root, "write_rasters.py");
    const readerPath = join(root, "read_raster.py");
    await writeFile(writerPath, WRITER, { encoding: "utf8" });
    await writeFile(readerPath, READER, { encoding: "utf8" });
    await run(python, [writerPath, rasterDir]);
    const dump = async (path: string): Promise<RasterDump> => JSON.parse(await run(python, [readerPath, path])) as RasterDump;
    const bridge = resolve(REPO_ROOT, "packages/external-gateway/scripts/gdal-bridge.py");
    const boundary = new ExternalCapabilityBoundary({
      enabled: true,
      backend: createProcessBackend({
        name: "python-osgeo-gdal",
        command: python,
        args: [bridge],
        availabilityArgs: [bridge, "--check"],
        env: { IGIS_BACKEND_ROOT: root },
      }),
    });
    const stack = await openSpatialStack({
      layerDirectory: join(root, "layers"),
      auditDirectory: join(root, "audit"),
      cacheDirectory: join(root, "cache"),
      modelName: () => "v093g",
      external: boundary,
    });
    const adapter = createSpatialAwareAdapter({ execute: async () => ({ ok: true }) }, stack.service, { entry: "chat", operationsRoot: root });
    const call = async (tool: string, args: Record<string, string | number | boolean>): Promise<Record<string, unknown>> => {
      const result = await adapter.execute({ tool: tool as never, args }) as Record<string, unknown>;
      if (result.ok !== true) {
        const record = await readOperationRecord(String(result.operationId ?? ""), root);
        const detail = record ? JSON.stringify(record) : "无操作记录";
        if (result.code === "LOCAL_DATA_ACCESS_ERROR") {
          throw new Error(`${tool} 被当成路径过滤。操作记录 ${record?.status ?? "无"}。返回：${JSON.stringify(result)} 记录：${detail}`);
        }
        throw new Error(`${tool} 失败：${String(result.message ?? "")} 记录：${detail}`);
      }
      return result;
    };
    const makeLayer = async (name: string, features: readonly MapFeature[], kind: "point" | "line" | "polygon", crsLabel: string): Promise<string> => {
      const made = await stack.service.createLayer({
        layerName: name,
        collection: collection(features),
        crsLabel,
        expectedKind: kind,
        sourceLabel: "v093g",
        writeKnowledge: false,
      });
      return made.layer.layerId;
    };

    await stack.service.usingConversationWorkspace(root, async () => {
      const sourceLines = [
        lineFeature([[0, 0], [50, 0], [0, 5]]),
        lineFeature([[0, 20], [30, 20], [30, 40], [60, 40]]),
      ];
      const lines = await makeLayer("折线", sourceLines, "line", "EPSG:3857");
      for (const distance of [2, -2]) {
        const offset = await call("map.offsetLine", { layerId: lines, distance, join: "round", outputName: `平行${distance}` });
        check(offset.ok === true, `平行线 ${distance} 应成功：${String(offset.message ?? "")}`);
        const rows = stack.catalog.collection(String(offset.layerId ?? ""))?.features ?? [];
        check(rows.length === 2, `两条线应各有一条平行线，实际 ${rows.length}`);
        for (const feature of rows) {
          for (const pair of vertexPairs(feature)) {
            const gap = distanceToLines(pair[0], pair[1], sourceLines);
            check(close(gap, 2, 1e-6), `平行线顶点 (${pair[0]}, ${pair[1]}) 到原线应为 2，实际 ${gap}`);
          }
          check(kinks(feature as never).features.length === 0, `round 平行线自相交 ${kinks(feature as never).features.length} 处`);
        }
      }
      const acute = lineFeature([[0, 0], [50, 0], [0, 5]]);
      const turfOffset = lineOffset(acute as never, 2, { units: "degrees" });
      const turfKinks = kinks(turfOffset).features.length;
      console.log(`对照 turf lineOffset（距离 2、单位度）kinks ${turfKinks}`);
      const mitre = await call("map.offsetLine", { layerId: lines, distance: 2, join: "mitre", outputName: "斜接" });
      check(mitre.ok === true, `mitre 应成功：${String(mitre.message ?? "")}`);
      const mitreRows = stack.catalog.collection(String(mitre.layerId ?? ""))?.features ?? [];
      check(mitreRows.every((feature) => kinks(feature as never).features.length === 0), "mitre 平行线不应自相交");
      const geographic = await makeLayer("经纬线", [lineFeature([[0, 0], [0.01, 0]])], "line", "EPSG:4326");
      const geographicMessage = await catchMessage(() => stack.service.offsetLine(geographic, 2, "round", false, "拒"));
      check(geographicMessage.includes("投影坐标"), `地理坐标应拒绝并提到投影坐标，实际 ${geographicMessage}`);
      const unknownLines = [lineFeature([[0, 0], [10, 0]])];
      const unknown = await makeLayer("未声明线", unknownLines, "line", "Unknown");
      const unknownOffset = await stack.service.offsetLine(unknown, 3, "round", false, "坐标单位");
      const unknownRows = stack.catalog.collection(unknownOffset.layer?.layerId ?? "")?.features ?? [];
      check(unknownRows.length === 1, "未知坐标系应仍能按坐标单位出平行线");
      for (const pair of vertexPairs(unknownRows[0] ?? lineFeature([]))) {
        check(close(distanceToLines(pair[0], pair[1], unknownLines), 3, 1e-6), `未知坐标系偏移距离应为 3，顶点 (${pair[0]}, ${pair[1]})`);
      }
      console.log("ok 平行线");

      const start = await makeLayer("起点", [pointFeature(0.5, 9.5)], "point", "EPSG:3857");
      const end = await makeLayer("终点", [pointFeature(9.5, 0.5)], "point", "EPSG:3857");
      const corridor = await call("map.costCorridor", { rasterName: "cost.tif", layerId: start, otherLayerId: end, tolerance: 0, outputName: "对角" });
      check(corridor.ok === true, `均匀费用走廊应成功：${String(corridor.message ?? "")}`);
      const path = stack.catalog.collection(String(corridor.layerId ?? ""))?.features[0];
      const expectedCost = 9 * Math.SQRT2;
      check(close(Number(path?.properties._cost), expectedCost, 1e-6), `均匀费用路径应为 9√2=${expectedCost}，实际 ${String(path?.properties._cost)}`);
      check(path?.properties._cells === 10, `路径应经过 10 个像元，实际 ${String(path?.properties._cells)}`);

      const gapStart = await makeLayer("缺口起", [pointFeature(2.5, 5.5)], "point", "EPSG:3857");
      const gapEnd = await makeLayer("缺口终", [pointFeature(8.5, 5.5)], "point", "EPSG:3857");
      const gap = await stack.service.costCorridor("barrier.tif", gapStart, gapEnd, 0, false, "缺口");
      const gapPath = stack.catalog.collection(gap.layer?.layerId ?? "")?.features[0];
      const gapPairs = vertexPairs(gapPath ?? lineFeature([]));
      check(gapPairs.some((pair) => close(pair[0], 5.5, 1e-6) && close(pair[1], 1.5, 1e-6)), `路径应经过缺口中心 (5.5, 1.5)，实际 ${JSON.stringify(gapPairs)}`);
      const gapRaster = await dump(locate(gap.localOutputResources?.[0] ?? ""));
      for (let row = 0; row < 10; row += 1) {
        if (row === 8) continue;
        check(gapRaster.values[row]?.[5] === -9999, `障碍像元 (${row}, 5) 应为 -9999，实际 ${String(gapRaster.values[row]?.[5])}`);
      }
      check(gapRaster.values[4]?.[2] !== -9999 && gapRaster.values[4]?.[8] !== -9999, "起点和终点像元应在走廊内");
      const blocked = await catchMessage(async () => stack.service.costCorridor("barrier.tif", await makeLayer("障碍上", [pointFeature(5.5, 9.5)], "point", "EPSG:3857"), gapEnd, 0, false, "拒"));
      check(blocked !== "", `起点落在 NoData 上应报错，实际成功`);
      const otherCrs = await makeLayer("经纬点", [pointFeature(0.5, 9.5)], "point", "EPSG:4326");
      const mixed = await catchMessage(() => stack.service.costCorridor("cost.tif", otherCrs, end, 0, false, "拒"));
      check(mixed.includes("坐标系"), `图层和栅格坐标系不同应报错，实际 ${mixed}`);
      console.log("ok 最小费用走廊");

      const trainJson = JSON.parse(await readFile(join(rasterDir, "train.json"), { encoding: "utf8" })) as Array<{ kind: string; x: number; y: number }>;
      const train = await makeLayer("训练", trainJson.map((item) => pointFeature(item.x, item.y, { kind: item.kind })), "point", "EPSG:3857");
      const trainFile = stack.catalog.get(train)?.outputFilePath ?? "";
      const classified = await boundary.invoke({
        capability: "raster.classify",
        inputResources: ["rasters/band0.tif", "rasters/band1.tif", "rasters/band2.tif", trainFile],
        parameters: { field: "kind", method: "auto", testFraction: 0.3, layerEpsg: 3857 },
      });
      check(classified.ok, `auto 分类应成功：${classified.message ?? ""}`);
      const facts = classified.facts ?? {};
      const accuracy = Number(facts.accuracy);
      const kappa = Number(facts.kappa);
      const numbers = Array.isArray(facts.numbers) ? facts.numbers.map((item) => Number(item)) : [];
      check(accuracy >= 0.95, `auto 总体精度应 ≥ 0.95，实际 ${String(facts.accuracy)}。${classified.message ?? ""}`);
      const total = numbers.reduce((sum, value) => sum + value, 0);
      const classes = Math.round(Math.sqrt(numbers.length));
      let trace = 0;
      const rowSum: number[] = [];
      const columnSum: number[] = [];
      for (let row = 0; row < classes; row += 1) {
        let across = 0;
        for (let column = 0; column < classes; column += 1) {
          const value = numbers[row * classes + column] ?? 0;
          across += value;
          columnSum[column] = (columnSum[column] ?? 0) + value;
          if (row === column) trace += value;
        }
        rowSum.push(across);
      }
      const observed = trace / total;
      const expected = rowSum.reduce((sum, value, index) => sum + value * (columnSum[index] ?? 0), 0) / (total * total);
      const recomputed = (observed - expected) / (1 - expected);
      check(close(observed, accuracy, 1e-6), `由 numbers 复算的总体精度 ${observed} 应等于 facts.accuracy ${accuracy}`);
      check(close(recomputed, kappa, 1e-6), `由 numbers 复算的 Kappa ${recomputed} 应等于 facts.kappa ${kappa}`);
      const predicted = await dump(locate(classified.localOutputResources?.[0] ?? ""));
      const truth = await dump(join(rasterDir, "truth.tif"));
      const codeOf = [1, 3, 2];
      let agree = 0;
      for (let row = 0; row < 40; row += 1) {
        for (let column = 0; column < 40; column += 1) {
          const wanted = codeOf[truth.values[row]?.[column] ?? -1];
          if (predicted.values[row]?.[column] === wanted) agree += 1;
        }
      }
      check(agree / 1600 >= 0.95, `分类栅格与真实类别一致率应 ≥ 0.95，实际 ${agree / 1600}`);
      const maxlike = await stack.service.classify("band0.tif,band1.tif,band2.tif", train, "kind", "maxlike", 0.3);
      check((maxlike.localOutputResources?.length ?? 0) === 1, `maxlike 应产出栅格：${maxlike.message}`);
      const knn = await stack.service.classify("band0.tif,band1.tif,band2.tif", train, "kind", "knn5", 0.3);
      check((knn.localOutputResources?.length ?? 0) === 1, `knn5 应产出栅格：${knn.message}`);
      const shifted = await catchMessage(() => stack.service.classify("band0.tif,band-shift.tif", train, "kind", "mindist", 0.3));
      check(shifted.includes("同一网格"), `不同网格应报错，实际 ${shifted}`);
      const oneClass = await makeLayer("单类", [pointFeature(0.5, 39.5, { kind: "forest" }), pointFeature(1.5, 39.5, { kind: "forest" }), pointFeature(2.5, 39.5, { kind: "forest" }), pointFeature(3.5, 39.5, { kind: "forest" }), pointFeature(4.5, 39.5, { kind: "forest" }), pointFeature(5.5, 39.5, { kind: "forest" })], "point", "EPSG:3857");
      const single = await catchMessage(() => stack.service.classify("band0.tif", oneClass, "kind", "mindist", 0.3));
      check(single.includes("2 个类别"), `单一类别应报错，实际 ${single}`);
      console.log(`ok 监督分类（${String(facts.classifier)}，精度 ${accuracy}，Kappa ${kappa}）`);

      const observer = await makeLayer("观察点", [pointFeature(1105, 1255)], "point", "EPSG:3857");
      const viewshed = await stack.service.viewshed("dem.tif", observer, 2);
      const seen = await dump(locate(viewshed.localOutputResources?.[0] ?? ""));
      let westVisible = 0;
      let westHidden = 0;
      let eastVisible = 0;
      let eastHidden = 0;
      for (let row = 0; row < seen.height; row += 1) {
        for (let column = 0; column < 25; column += 1) {
          if (seen.values[row]?.[column] === 255) westVisible += 1;
          else westHidden += 1;
        }
        for (let column = 26; column < seen.width; column += 1) {
          if (seen.values[row]?.[column] === 255) eastVisible += 1;
          else eastHidden += 1;
        }
      }
      const visible = seen.values.reduce((sum, row) => sum + row.filter((value) => value === 255).length, 0);
      check(westHidden === 0, `墙西侧应全部可见，不可见 ${westHidden} 个，可见 ${westVisible} 个`);
      check(eastVisible === 0, `墙东侧应不可见，实际可见 ${eastVisible} 个`);
      check(visible > 1100 && visible < 1500, `可见像元应约为 1300，实际 ${visible}`);
      console.log(`ok 可视域（可见 ${visible}）`);

      const clipBox = await makeLayer("裁剪面", [square(1100, 1100, 200, 200)], "polygon", "EPSG:3857");
      const clipped = await stack.service.rasterClip("dem.tif", clipBox);
      const clipRaster = await dump(locate(clipped.localOutputResources?.[0] ?? ""));
      check(clipRaster.width === 20 && clipRaster.height === 20, `裁剪结果应为 20×20，实际 ${clipRaster.width}×${clipRaster.height}`);
      const outside = clipRaster.values.flat().filter((value) => value === clipRaster.nodata).length;
      check(clipRaster.nodata !== null, "裁剪结果应设置 NoData");
      let outsideValue = 0;
      clipRaster.values.forEach((row, rowIndex) => row.forEach((value, column) => {
        const x = (clipRaster.gt[0] ?? 0) + (column + 0.5) * (clipRaster.gt[1] ?? 0);
        const y = (clipRaster.gt[3] ?? 0) + (rowIndex + 0.5) * (clipRaster.gt[5] ?? 0);
        if (x < 1100 || x > 1300 || y < 1100 || y > 1300) outsideValue += value === clipRaster.nodata ? 0 : 1;
      }));
      check(outsideValue === 0, `面外像元应是 NoData，面外有效像元 ${outsideValue}，NoData 个数 ${outside}`);

      const polygonized = await stack.service.polygonize("zones.tif", false, "分区");
      const polygonMeta = stack.catalog.get(polygonized.layer?.layerId ?? "");
      const polygonRows = stack.catalog.collection(polygonized.layer?.layerId ?? "")?.features ?? [];
      check(polygonRows.length >= 2, `两值栅格应至少产出 2 个面，实际 ${polygonRows.length}`);
      check(polygonMeta?.crsIdentity.kind === "known" && polygonMeta.crsIdentity.epsg === 3857, `栅格转面应保持 EPSG:3857，实际 ${JSON.stringify(polygonMeta?.crsIdentity)}`);
      const firstRing = polygonRows[0]?.geometry?.type === "Polygon" ? polygonRows[0].geometry.coordinates[0] : [];
      const firstX = firstRing?.[0]?.[0] ?? 0;
      check(firstX > 180, `栅格转面坐标应保持投影值，实际首点 x=${firstX}`);
      console.log("ok 裁剪和栅格转面");

      const block = await makeLayer("方块", [square(0, 0, 10, 10)], "polygon", "EPSG:3857");
      const burned = await stack.service.rasterize(block, 1);
      const burnedRaster = await dump(locate(burned.localOutputResources?.[0] ?? ""));
      check(burnedRaster.width === 10 && burnedRaster.height === 10, `面转栅格应为 10×10，实际 ${burnedRaster.width}×${burnedRaster.height}`);
      check(burnedRaster.projection.includes("3857"), `面转栅格应带 EPSG:3857，实际投影 ${burnedRaster.projection.slice(0, 80)}`);

      const zoneBox = await makeLayer("统计面", [square(1240, 1200, 30, 100)], "polygon", "EPSG:3857");
      const zonal = await stack.service.zonal("dem.tif", zoneBox);
      check(zonal.message.includes("像元 30") && zonal.message.includes("33.3333"), `按面统计应为 30 个像元、平均 33.3333，实际 ${zonal.message}`);

      const resampled = await stack.service.resample("dem.tif", 20);
      const resampleRaster = await dump(locate(resampled.localOutputResources?.[0] ?? ""));
      check(resampleRaster.width === 25 && resampleRaster.height === 25, `重采样应为 25×25，实际 ${resampleRaster.width}×${resampleRaster.height}`);

      const index = await stack.service.rasterIndex("nir.tif", "red.tif", "ndvi");
      const indexRaster = await dump(locate(index.localOutputResources?.[0] ?? ""));
      check(close(indexRaster.values[0]?.[0] ?? 0, 0.5, 1e-5), `ndvi 应为 0.5，实际 ${String(indexRaster.values[0]?.[0])}`);
      check(indexRaster.values[0]?.[1] === -9999, `分母为 0 应为 -9999，实际 ${String(indexRaster.values[0]?.[1])}`);
      check(indexRaster.values[1]?.[1] === -9999, `NoData 像元应为 -9999，实际 ${String(indexRaster.values[1]?.[1])}`);

      const focal = await stack.service.focal("focal.tif", 3);
      const focalRaster = await dump(locate(focal.localOutputResources?.[0] ?? ""));
      check(close(focalRaster.values[2]?.[2] ?? 0, 2, 1e-5), `3×3 邻域中心应为 2，实际 ${String(focalRaster.values[2]?.[2])}`);
      console.log("ok 面转栅格、按面统计、重采样、指数和邻域");
    });
    if (failures.length > 0) throw new Error(failures.join("\n"));
    console.log("v093-gdal-check passed");
  } finally {
    processApi.chdir(previousDirectory);
    await rm(root, { recursive: true, force: true });
  }
}

let failed: unknown = null;
try {
  await main();
} catch (error) {
  failed = error;
}
if (failures.length > 0) console.error(failures.map((item) => `FAIL ${item}`).join("\n"));
if (failed) {
  console.error(failed instanceof Error ? failed.stack ?? failed.message : failed);
  throw failed;
}
