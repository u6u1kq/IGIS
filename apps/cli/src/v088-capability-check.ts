// SPDX-License-Identifier: Apache-2.0

/**
 * V0.88-T4/T5 能力验证（几何构造 / 方位 / 坐标值报表）。
 * 行为断言（真实执行，临时目录、不监听端口）：
 *   1. voronoi/convexHull/minBBox/centroid 产图层正确（格数/凸性/矩形环/点数）
 *   2. bearing 产图层带 _bearing（正北为 0，量级正确）
 *   3. exportCoordinates 写本地 CSV（行数正确），消息只报行数不带路径
 *   4. 每个能力经 executeGisOperation 写 OperationRecord；契约一致性（注册表↔清单↔留痕）
 * 运行：npx tsx --tsconfig tsconfig.json apps/cli/src/v088-capability-check.ts
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AUDIT_REQUIRED_OPERATIONS, CAPABILITY_MANIFEST } from "@igis/ai-boundary";
import { GIS_TOOL_REGISTRY, findGisTool } from "@igis/llm-dispatch";
import { openSpatialStack } from "../../../packages/spatial-ops/src/service.js";
import { executeGisOperation, CAPABILITY_OPERATIONS } from "../../../packages/spatial-ops/src/execute-gis-operation.js";
import { readOperationRecord } from "../../../packages/spatial-ops/src/operation-attempt.js";
import type { MapCollection } from "../../../packages/spatial-ops/src/types.js";

const REPO_ROOT = resolve("E:/ai工作区/Igis");

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

function points(items: readonly (readonly [number, number])[]): MapCollection {
  return {
    type: "FeatureCollection",
    features: items.map((item, index) => ({
      type: "Feature",
      properties: { seq: index },
      geometry: { type: "Point", coordinates: [item[0], item[1]] },
    })),
  };
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "igis-v088-cap-"));
  check(!resolve(root).toLowerCase().startsWith(REPO_ROOT.toLowerCase()), "用例目录不能落在仓库里");
  try {
    const stack = await openSpatialStack({
      layerDirectory: join(root, "layers"),
      auditDirectory: join(root, "audit"),
      cacheDirectory: join(root, "cache"),
      modelName: () => "v088-cap",
    });
    const add = (layerName: string, collection: MapCollection) => stack.service.createLayer({
      layerName,
      collection,
      crsLabel: "EPSG:4326",
      expectedKind: null,
      sourceLabel: "v088-cap",
      writeKnowledge: false,
    });

    // ---- 1. 几何构造。
    const four = await add("四点", points([[116, 39], [116.02, 39], [116.02, 39.02], [116, 39.02]]));
    const voronoi = await stack.service.voronoi(four.layer.layerId, false, "泰森");
    check(voronoi.ok === true && voronoi.featureCount === 4, `Voronoi 应产出 4 格，实际 ${String(voronoi.featureCount)}`);

    const hull = await stack.service.convexHull(four.layer.layerId, false, "凸包");
    check(hull.ok === true && hull.featureCount === 1, "凸包应产出 1 个面");

    const square = await add("方块", {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: { name: "甲" },
        geometry: { type: "Polygon", coordinates: [[[116, 39], [116.02, 39], [116.02, 39.02], [116, 39.02], [116, 39]]] },
      }],
    });
    const rect = await stack.service.minBBox(square.layer.layerId, false, "外接矩形");
    check(rect.ok === true && rect.featureCount === 1, "逐要素外接矩形应有 1 个");
    const rectCollection = stack.catalog.collection(rect.layer?.layerId ?? "");
    const ring = rectCollection?.features[0]?.geometry.type === "Polygon"
      ? (rectCollection.features[0]?.geometry as { coordinates: number[][][] }).coordinates[0]
      : null;
    check(Array.isArray(ring) && ring.length === 5, "外接矩形应是 5 点闭合环");
    const xs = (ring ?? []).map((position) => position[0] ?? 0);
    const ys = (ring ?? []).map((position) => position[1] ?? 0);
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    check(Math.abs(spanX - 0.02) < 0.001 && Math.abs(spanY - 0.02) < 0.001, `方块外接矩形跨度应约 0.02 度，实际 ${String(spanX)}×${String(spanY)}`);

    const centers = await stack.service.centroid(four.layer.layerId, false, "质心");
    check(centers.ok === true && centers.featureCount === 4, "质心应逐要素产出");

    // ---- 2. bearing。
    const target = await add("目标点", points([[116.02, 39.02]]));
    const bearing = await stack.service.bearing(four.layer.layerId, target.layer.layerId, false, "方位标注");
    check(bearing.ok === true && bearing.featureCount === 4, "方位角标注应逐要素产出");
    const bearingCollection = stack.catalog.collection(bearing.layer?.layerId ?? "");
    const firstBearing = bearingCollection?.features[0]?.properties._bearing;
    check(typeof firstBearing === "number" && firstBearing >= 0 && firstBearing <= 360, `_bearing 应在 0-360：${String(firstBearing)}`);
    // 球面方位角：东北方向（经度方向被 cos(纬度) 压缩），落在东北象限即可。
    check(Number(firstBearing) > 20 && Number(firstBearing) < 70, `东北向方位角应落在东北象限，实际 ${String(firstBearing)}`);
    console.log("ok voronoi/凸包/外接矩形/质心/方位角行为正确");

    // ---- 3. 坐标值报表。
    const csvPath = join(root, "out", "coords.csv");
    const exported = await stack.service.exportCoordinates(four.layer.layerId, csvPath);
    check(exported.ok === true && exported.message.includes("4 行坐标"), `坐标表应报 4 行（4 点），实际：${exported.message}`);
    check(!exported.message.includes(csvPath), "消息不得带文件路径");
    const csv = await readFile(csvPath, { encoding: "utf8" });
    check(csv.split("\n")[0] === "fid,index,x,y", "坐标表表头不对");
    check(csv.includes("116,39") || csv.includes("116.0,39"), "坐标表应含坐标行");

    // ---- 4. 记录 + 契约一致性。
    for (const operation of ["voronoi", "convex-hull", "min-bbox", "centroid"] as const) {
      const outcome = await executeGisOperation(stack.service, {
        entry: "map",
        operation,
        root,
        policy: { writeKnowledge: false },
        layerId: four.layer.layerId,
        layerName: four.layer.layerName,
      });
      const record = await readOperationRecord(outcome.operationId, root);
      check(record?.operation === operation, `${operation} 应写操作记录`);
    }
    const bearingRecord = await executeGisOperation(stack.service, {
      entry: "map",
      operation: "bearing",
      root,
      policy: { writeKnowledge: false },
      layerId: four.layer.layerId,
      layerName: four.layer.layerName,
      otherLayerId: target.layer.layerId,
      otherLayerName: target.layer.layerName,
    });
    check((await readOperationRecord(bearingRecord.operationId, root))?.operation === "bearing", "bearing 应写操作记录");

    const manifested = new Set(CAPABILITY_MANIFEST.map((entry) => entry.tool));
    for (const name of ["map.voronoi", "map.convexHull", "map.minBBox", "map.centroid", "map.bearing", "map.exportCoordinates"]) {
      check(GIS_TOOL_REGISTRY.some((tool) => tool.name === name), `${name} 不在注册表`);
      check(manifested.has(name), `${name} 未登记到 CAPABILITY_MANIFEST`);
    }
    for (const operation of ["voronoi", "convex-hull", "min-bbox", "centroid", "bearing"] as const) {
      check(CAPABILITY_OPERATIONS.includes(operation), `${operation} 不在能力操作清单`);
      check(AUDIT_REQUIRED_OPERATIONS.includes(operation), `${operation} 不在留痕覆盖清单`);
    }
    console.log("ok 记录与契约一致性");

    // ---- 5. T3 外部能力（注入假端口，验证通道与能力可下线）。
    const fakePort = {
      invoke: async (request: { capability: string; parameters: Record<string, string | number | boolean | null> }) => {
        const produced = join(root, "backend-out.geojson");
        await writeFile(produced, JSON.stringify({ type: "FeatureCollection", features: [] }), { encoding: "utf8" });
        return {
          ok: true,
          message: `已执行 ${request.capability}。`,
          localOutputResources: [produced],
          facts: { featureCount: 1 },
        };
      },
    };
    const externalStack = await openSpatialStack({
      layerDirectory: join(root, "layers-external"),
      auditDirectory: join(root, "audit-external"),
      cacheDirectory: join(root, "cache-external"),
      modelName: () => "v088-cap",
      external: fakePort,
    });
    const source = await externalStack.service.createLayer({
      layerName: "待修复",
      collection: { type: "FeatureCollection", features: [] },
      crsLabel: "EPSG:4326",
      expectedKind: null,
      sourceLabel: "v088-cap",
      writeKnowledge: false,
    });
    const repaired = await externalStack.service.makeValid(source.layer.layerId, false, "修复结果");
    check(repaired.ok === true && repaired.layer !== null, "外部能力结果应载入图层库");
    const noExternal = await openSpatialStack({
      layerDirectory: join(root, "layers-noext"),
      auditDirectory: join(root, "audit-noext"),
      cacheDirectory: join(root, "cache-noext"),
      modelName: () => "v088-cap",
    });
    let unavailableMessage = "";
    try {
      await noExternal.service.makeValid(source.layer.layerId, false, null);
    } catch (error) {
      unavailableMessage = error instanceof Error ? error.message : "";
    }
    check(unavailableMessage.includes("未启用"), "后端未启用时能力应明确不可用");
    for (const operation of ["make-valid", "reproject", "convert-format"] as const) {
      check(CAPABILITY_OPERATIONS.includes(operation), `${operation} 不在能力操作清单`);
      check(AUDIT_REQUIRED_OPERATIONS.includes(operation), `${operation} 不在留痕覆盖清单`);
    }
    for (const name of ["map.makeValid", "map.reproject", "map.convertFormat"]) {
      check(GIS_TOOL_REGISTRY.some((tool) => tool.name === name), `${name} 不在注册表`);
      check(manifested.has(name), `${name} 未登记到 CAPABILITY_MANIFEST`);
    }
    console.log("ok T3 外部能力通道与能力可下线");

    // ---- 6. T3b 栅格族（var/rasters 语义引用 + 假端口行为 + 契约一致性）。
    await mkdir(resolve("var", "rasters"), { recursive: true });
    await writeFile(resolve("var", "rasters", "v088-test-dem.tif"), "not-a-real-tif", { encoding: "utf8" });
    await writeFile(resolve("var", "rasters", "v088-test-dem2.tif"), "not-a-real-tif", { encoding: "utf8" });
    const rasterPort = {
      invoke: async (request: { capability: string; parameters: Record<string, string | number | boolean | null> }) => {
        if (request.capability === "raster.info") {
          return { ok: true, facts: { width: 100, height: 80, bands: 1, minimum: 1, maximum: 9, mean: 5 }, message: "已读取。" };
        }
        const produced = request.capability === "raster.contour"
          ? join(root, "contour-out.geojson")
          : join(root, "raster-out.tif");
        if (request.capability === "raster.contour") {
          await writeFile(produced, JSON.stringify({
            type: "FeatureCollection",
            features: [{ type: "Feature", properties: { elev: 10 }, geometry: { type: "LineString", coordinates: [[116, 39], [116.01, 39.01]] } }],
          }), { encoding: "utf8" });
        } else {
          await writeFile(produced, "raster-bytes", { encoding: "utf8" });
        }
        return { ok: true, message: `已执行 ${request.capability}。`, localOutputResources: [produced] };
      },
    };
    const rasterStack = await openSpatialStack({
      layerDirectory: join(root, "layers-raster"),
      auditDirectory: join(root, "audit-raster"),
      cacheDirectory: join(root, "cache-raster"),
      modelName: () => "v088-cap",
      external: rasterPort,
    });
    // 裸文件名纪律：路径与穿越拒绝。
    for (const bad of ["../evil.tif", "C:/data/x.tif", "sub/dir.tif"]) {
      let rejected = false;
      try {
        await rasterStack.service.rasterInfo(bad);
      } catch {
        rejected = true;
      }
      check(rejected, `栅格名 ${bad} 应被拒绝`);
    }
    const info = await rasterStack.service.rasterInfo("v088-test-dem.tif");
    check(info.ok === true && info.message.includes("100×80") && info.message.includes("平均值 5"), `栅格信息摘要不对：${info.message}`);
    check(!info.message.includes("var/rasters"), "摘要不得带路径");
    const slope = await rasterStack.service.demDerivative("v088-test-dem.tif", "slope");
    check(slope.ok === true && slope.layer === null && (slope.localOutputResources?.length ?? 0) === 1, "DEM 衍生产物应是本地文件（不入图层库）");
    const contours = await rasterStack.service.contour("v088-test-dem.tif", 50, false, "等高线");
    check(contours.ok === true && contours.layer !== null && contours.featureCount === 1, "等高线应入图层库");
    const calcOutcome = await executeGisOperation(rasterStack.service, {
      entry: "map",
      operation: "raster-calc",
      root,
      policy: { writeKnowledge: false },
      layerId: "v088-test-dem.tif",
      layerName: "v088-test-dem.tif",
      otherLayerId: "v088-test-dem2.tif",
      op: "add",
    });
    const calcRecord = await readOperationRecord(calcOutcome.operationId, root);
    check(calcRecord?.operation === "raster-calc", "栅格运算应写操作记录");
    check((calcRecord?.outputResources?.length ?? 0) === 1, "栅格产物应入记录的本地资源清单");
    for (const name of ["map.rasterInfo", "map.demDerivative", "map.rasterCalc", "map.contour"]) {
      check(GIS_TOOL_REGISTRY.some((tool) => tool.name === name), `${name} 不在注册表`);
      check(manifested.has(name), `${name} 未登记到 CAPABILITY_MANIFEST`);
    }
    for (const operation of ["dem-derivative", "contour", "raster-calc", "raster-info"] as const) {
      check(CAPABILITY_OPERATIONS.includes(operation), `${operation} 不在能力操作清单`);
      check(AUDIT_REQUIRED_OPERATIONS.includes(operation), `${operation} 不在留痕覆盖清单`);
    }
    const bridgeSource = await readFile(join(REPO_ROOT, "packages/external-gateway/scripts/gdal-bridge.py"), { encoding: "utf8" });
    for (const capability of ["vector.makeValid", "vector.reproject", "raster.demDerivative", "raster.contour", "raster.calc", "raster.info"]) {
      check(bridgeSource.includes(capability), `GDAL 桥缺少 ${capability} 处理器`);
    }
    check(bridgeSource.includes("DEMProcessing") && bridgeSource.includes("ContourGenerate"), "GDAL 桥应使用 GDAL 原生 DEM/等高线算子");
    console.log("ok T3b 栅格族（语义引用/产物留痕/桥形状）");

    // ---- 7. 接口名回程：map_voronoi 这类接口名必须折回内部名（含驼峰与大小写容错）。
    for (const [apiName, internal] of [
      ["map_voronoi", "map.voronoi"],
      ["map_convexHull", "map.convexHull"],
      ["map_centroid", "map.centroid"],
      ["map_dEMDerivative", "map.demDerivative"],
      ["run_buffer", "map.buffer"],
    ] as const) {
      const hit = findGisTool(apiName);
      check(hit?.name === internal, `接口名 ${apiName} 应解析为 ${internal}，实际 ${String(hit?.name)}`);
    }
    console.log("ok 接口名回程（通用规则+大小写容错）");

    console.log("v088-capability-check passed");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(resolve("var", "rasters", "v088-test-dem.tif"), { recursive: true, force: true });
    await rm(resolve("var", "rasters", "v088-test-dem2.tif"), { recursive: true, force: true });
    await rm(resolve("var", "rasters", "v088-test-dem-slope.tif"), { recursive: true, force: true });
    await rm(resolve("var", "rasters", "v088-test-dem-add-v088-test-dem2.tif"), { recursive: true, force: true });
  }
}

let failed: unknown = null;
try {
  await main();
} catch (error) {
  failed = error;
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
}
if (failed) throw new Error("v088-capability-check failed");
