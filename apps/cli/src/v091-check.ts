// SPDX-License-Identifier: Apache-2.0

/**
 * V0.91 字段计算、属性连接、栅格整型 / NoData / 平滑、点插值。
 * 运行：npx tsx --tsconfig tsconfig.json apps/cli/src/v091-check.ts
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { env as nodeEnv } from "node:process";
import { AUDIT_REQUIRED_OPERATIONS, CAPABILITY_MANIFEST } from "@igis/ai-boundary";
import { projectForModel } from "@igis/ai-translation";
import { createProcessBackend, ExternalCapabilityBoundary, managedPythonPath } from "@igis/external-gateway";
import { GIS_TOOL_REGISTRY, canonicalToolName } from "@igis/llm-dispatch";
import { CAPABILITY_OPERATIONS, executeGisOperation } from "../../../packages/spatial-ops/src/execute-gis-operation.js";
import { readOperationRecord } from "../../../packages/spatial-ops/src/operation-attempt.js";
import { openSpatialStack } from "../../../packages/spatial-ops/src/service.js";
import type { MapCollection } from "../../../packages/spatial-ops/src/types.js";

const REPO_ROOT = resolve("E:/ai工作区/Igis");

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

function box(x: number, y: number, properties: Record<string, string | number | boolean | null>): MapCollection["features"][number] {
  return {
    type: "Feature",
    properties,
    geometry: { type: "Polygon", coordinates: [[[x, y], [x + 0.01, y], [x + 0.01, y + 0.01], [x, y + 0.01], [x, y]]] },
  };
}

function points(items: readonly (readonly [number, number, number])[]): MapCollection {
  return {
    type: "FeatureCollection",
    features: items.map(([x, y, z]) => ({
      type: "Feature",
      properties: { value: z },
      geometry: { type: "Point", coordinates: [x, y] },
    })),
  };
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

async function main(): Promise<void> {
  const projected = projectForModel({ rmse: 1.25, mae: 0.5, heldOut: 2, message: "留出 2 个点" }) as Record<string, unknown>;
  check(projected.rmse === 1.25 && projected.mae === 0.5 && projected.heldOut === 2, "误差数字应留在模型可见面");
  for (const name of ["map.calculateField", "map.join", "map.rasterCast", "map.rasterNoData", "map.rasterSmooth", "map.interpolate"]) {
    check(GIS_TOOL_REGISTRY.some((tool) => tool.name === name), `${name} 不在注册表`);
    check(CAPABILITY_MANIFEST.some((entry) => entry.tool === name), `${name} 不在能力清单`);
  }
  for (const operation of ["field-calc", "join", "raster-cast", "raster-nodata", "raster-smooth", "interpolate"] as const) {
    check(CAPABILITY_OPERATIONS.includes(operation), `${operation} 不在执行清单`);
    check(AUDIT_REQUIRED_OPERATIONS.includes(operation), `${operation} 不在留痕清单`);
  }
  check(canonicalToolName("calculate_field") === "map.calculateField", "字段计算别名未折回");
  check(canonicalToolName("attribute_join") === "map.join", "属性连接别名未折回");
  console.log("ok 登记、别名和误差字段");

  const root = await mkdtemp(join(tmpdir(), "igis-v091-"));
  check(!resolve(root).toLowerCase().startsWith(REPO_ROOT.toLowerCase()), "用例目录不能落在仓库里");
  try {
    const stack = await openSpatialStack({
      layerDirectory: join(root, "layers"),
      auditDirectory: join(root, "audit"),
      cacheDirectory: join(root, "cache"),
      modelName: () => "v091",
    });
    const added = await stack.service.createLayer({
      layerName: "地块",
      collection: {
        type: "FeatureCollection",
        features: [
          box(116, 39, { kind: "甲", value: 12 }),
          box(116.02, 39, { kind: "乙", value: 4 }),
        ],
      },
      crsLabel: "EPSG:4326",
      expectedKind: null,
      sourceLabel: "v091",
      writeKnowledge: false,
    });
    const calculated = await stack.service.calculateField(added.layer.layerId, "if(kind == \"甲\", if(value > 10, value * 2, 1), 0)", "score", false, "计算");
    const rows = stack.catalog.collection(calculated.layer?.layerId ?? "");
    check(rows?.features.length === 2, "字段计算应保留两个要素");
    check(rows?.features[0]?.properties.score === 24, `甲的新字段应为 24，实际 ${String(rows?.features[0]?.properties.score)}`);
    check(rows?.features[1]?.properties.score === 0, "乙的新字段应为 0");
    let rejected = "";
    try {
      await stack.service.calculateField(added.layer.layerId, "value; drop table", "score", false, null);
    } catch (error) {
      rejected = error instanceof Error ? error.message : "";
    }
    check(rejected.includes("不能使用"), `脚本式计算式应拒绝，实际：${rejected}`);
    let divided = "";
    try {
      await stack.service.calculateField(added.layer.layerId, "value / 0", "score", false, null);
    } catch (error) {
      divided = error instanceof Error ? error.message : "";
    }
    check(divided.includes("除数"), "除零应拒绝");

    const other = await stack.service.createLayer({
      layerName: "对照",
      collection: {
        type: "FeatureCollection",
        features: [
          box(1, 1, { code: 1, extra: 9 }),
          box(2, 2, { code: 1, extra: 8 }),
          box(3, 3, { code: 9, extra: 1 }),
        ],
      },
      crsLabel: "EPSG:4326",
      expectedKind: null,
      sourceLabel: "v091",
      writeKnowledge: false,
    });
    const joined = await stack.service.joinAttributes(added.layer.layerId, other.layer.layerId, "value", "code", false, "连接");
    const joinedRows = stack.catalog.collection(joined.layer?.layerId ?? "");
    check(joinedRows?.features.length === 0, "对不上的值不应留下");
    const keyed = await stack.service.createLayer({
      layerName: "编号",
      collection: {
        type: "FeatureCollection",
        features: [box(116, 39.1, { code: 1, name: "甲" }), box(116.02, 39.1, { code: 2, name: "乙" })],
      },
      crsLabel: "EPSG:4326",
      expectedKind: null,
      sourceLabel: "v091",
      writeKnowledge: false,
    });
    const matched = await stack.service.joinAttributes(keyed.layer.layerId, other.layer.layerId, "code", "code", false, "对上");
    const matchedRows = stack.catalog.collection(matched.layer?.layerId ?? "");
    check(matchedRows?.features.length === 2, `一对多应留下 2 条，实际 ${String(matchedRows?.features.length)}`);
    check(matchedRows?.features.every((feature) => feature.properties.name === "甲") === true, "同名字段应保留第一图层的值");
    const extras = matchedRows?.features.map((feature) => feature.properties.extra).sort();
    check(extras?.[0] === 8 && extras?.[1] === 9, `应对上 8 和 9，实际 ${String(extras)}`);
    const recorded = await executeGisOperation(stack.service, {
      entry: "map",
      operation: "field-calc",
      root,
      policy: { writeKnowledge: false },
      layerId: added.layer.layerId,
      layerName: added.layer.layerName,
      fieldName: "score",
      mapping: "value + 1",
    });
    const record = await readOperationRecord(recorded.operationId, root);
    check(record?.operation === "field-calc" && record.status === "succeeded", "字段计算应写入成功的操作记录");
    console.log("ok 字段计算和属性连接");

    const python = managedPythonPath(REPO_ROOT);
    check(python !== null, "托管 Python 不在，栅格检查不能跑。");
    const rasterDir = join(root, "rasters");
    await mkdir(rasterDir, { recursive: true });
    const sample = join(rasterDir, "sample.tif");
    const smooth = join(rasterDir, "smooth.tif");
    const writer = [
      "import sys",
      "from osgeo import gdal",
      "import numpy",
      "gdal.UseExceptions()",
      "sample, smooth = sys.argv[1], sys.argv[2]",
      "ds = gdal.GetDriverByName('GTiff').Create(sample, 2, 2, 1, gdal.GDT_Float32)",
      "ds.SetGeoTransform([500000, 10, 0, 4000000, 0, -10])",
      "band = ds.GetRasterBand(1)",
      "band.WriteArray(numpy.array([[1.7, 2.2], [3.9, 4.1]], dtype='float32'))",
      "band.SetNoDataValue(-9999)",
      "ds.FlushCache(); ds = None",
      "ds = gdal.GetDriverByName('GTiff').Create(smooth, 4, 4, 1, gdal.GDT_Float32)",
      "ds.SetGeoTransform([0, 1, 0, 4, 0, -1])",
      "arr = numpy.full((4, 4), 2, dtype='float32')",
      "arr[1, 1] = 20",
      "ds.GetRasterBand(1).WriteArray(arr)",
      "ds.FlushCache(); ds = None",
    ].join("\n");
    await run(python, ["-c", writer, sample, smooth]);
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
    const rasterStack = await openSpatialStack({
      layerDirectory: join(root, "layers-raster"),
      auditDirectory: join(root, "audit-raster"),
      cacheDirectory: join(root, "cache-raster"),
      modelName: () => "v091",
      external: boundary,
    });
    await rasterStack.service.usingConversationWorkspace(root, async () => {
      const locate = (resource: string): string => (isAbsolute(resource) ? resource : join(root, resource));
      const cast = await rasterStack.service.rasterCast("sample.tif", "int16");
      check(cast.layer === null && (cast.localOutputResources?.length ?? 0) === 1, "整型转换应只产本地栅格");
      const castPath = locate(cast.localOutputResources?.[0] ?? "");
      const castInfo = (await run(python, ["-c", "import sys; from osgeo import gdal; gdal.UseExceptions(); ds=gdal.Open(sys.argv[1]); b=ds.GetRasterBand(1); print(b.DataType); print(float(b.ReadAsArray()[0][0]))", castPath])).replaceAll("\r\n", "\n");
      check(castInfo === "3\n2.0", `int16 应把 1.7 四舍五入为 2，实际 ${castInfo}`);
      const marked = await rasterStack.service.rasterNoData("sample.tif", -1);
      const markedPath = locate(marked.localOutputResources?.[0] ?? "");
      const nodataInfo = (await run(python, ["-c", "import sys; from osgeo import gdal; gdal.UseExceptions(); ds=gdal.Open(sys.argv[1]); b=ds.GetRasterBand(1); print(b.GetNoDataValue()); print(float(b.ReadAsArray()[0][0]))", markedPath])).replaceAll("\r\n", "\n");
      const nodataLines = nodataInfo.split("\n");
      check(nodataLines[0] === "-1.0" && Math.abs(Number(nodataLines[1]) - 1.7) < 0.001, `NoData 应是 -1 且像元仍约为 1.7，实际 ${nodataInfo}`);
      const smoothed = await rasterStack.service.rasterSmooth("smooth.tif");
      const smoothPath = locate(smoothed.localOutputResources?.[0] ?? "");
      const smoothInfo = (await run(python, ["-c", "import sys; from osgeo import gdal; gdal.UseExceptions(); ds=gdal.Open(sys.argv[1]); print(float(ds.GetRasterBand(1).ReadAsArray()[1][1]))", smoothPath])).replaceAll("\r\n", "\n");
      check(Math.abs(Number(smoothInfo) - 4) < 0.01, `中心平滑后应约为 4，实际 ${smoothInfo}`);
      const spots = await rasterStack.service.createLayer({
        layerName: "样点",
        collection: points([[0, 0, 1], [10, 0, 3], [0, 10, 3], [10, 10, 5], [5, 5, 4], [2, 8, 3]]),
        crsLabel: "EPSG:4326",
        expectedKind: "point",
        sourceLabel: "v091",
        writeKnowledge: false,
      });
      const surface = await rasterStack.service.interpolate(spots.layer.layerId, "value", "invdist", false);
      check(surface.layer === null && surface.message.includes("均方根误差") && surface.message.includes("平均绝对误差"), `插值摘要应带误差：${surface.message}`);
      check((surface.localOutputResources?.length ?? 0) === 1, "插值应产本地栅格");
      await stat(locate(surface.localOutputResources?.[0] ?? ""));
      let kriging = "";
      try {
        await rasterStack.service.interpolate(spots.layer.layerId, "value", "kriging", false);
      } catch (error) {
        kriging = error instanceof Error ? error.message : "";
      }
      check(kriging.includes("invdist"), "克里金应拒绝");
    });
    console.log("ok 栅格整型、NoData、平滑和点插值");
    console.log("v091-check passed");
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
if (failed) throw new Error(failed instanceof Error ? failed.message : "v091-check failed");
