// SPDX-License-Identifier: Apache-2.0

/**
 * V0.83 CRS 框架检查。
 * 覆盖：.prj 读取与身份、任意 EPSG 变换（WGS84 家族）、严格基准门（无 towgs84 拒绝、
 * 带 towgs84 放行）、CGCS2000≈WGS84、无 EPSG 代码拒绝、缺 .prj 降级说明、
 * aeqd 米制缓冲精度（对比 turf 度换算的 23% 误差）、结果回投与导出 crs 成员。
 * 只用操作系统临时目录，不读仓库 var/，不监听端口。
 * 运行：npx tsx --tsconfig tsconfig.json apps/cli/src/v083-crs-check.ts
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openSpatialStack, readOperationRecord } from "@igis/spatial-ops";
import type { MapCollection, SpatialStack } from "@igis/spatial-ops";
import { executeGisOperation } from "../../../packages/spatial-ops/src/execute-gis-operation.js";

const REPO_ROOT = resolve("E:/ai工作区/Igis");

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

async function expectReject(run: () => Promise<unknown>, parts: readonly string[]): Promise<string> {
  try {
    const value = await run();
    throw new Error(`应当拒绝，却成功返回 ${JSON.stringify(value).slice(0, 160)}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("应当拒绝")) throw error;
    const message = error instanceof Error ? error.message : String(error);
    for (const part of parts) {
      if (!message.includes(part)) throw new Error(`错误文案缺少「${part}」：${message}`);
    }
    return message;
  }
}

const WKT_32650 = 'PROJCS["WGS 84 / UTM zone 50N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",117],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Easting",EAST],AXIS["Northing",NORTH],AUTHORITY["EPSG","32650"]]';

const WKT_21453_NO_TOWGS84 = 'PROJCS["Beijing 1954 / GK CM 117E",GEOGCS["Beijing 1954",DATUM["Beijing_1954",SPHEROID["Krasovsky_1940",6378245,298.3,AUTHORITY["EPSG","7024"]],AUTHORITY["EPSG","6214"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4214"]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",117],PARAMETER["scale_factor",1],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Easting",EAST],AXIS["Northing",NORTH],AUTHORITY["EPSG","21453"]]';

const WKT_21453_TOWGS84 = WKT_21453_NO_TOWGS84.replace('],AUTHORITY["EPSG","6214"]]', '],TOWGS84[-157.89,17.16,78.41],AUTHORITY["EPSG","6214"]]');

const WKT_NO_AUTHORITY = 'PROJCS["Custom Lambert (no epsg)",GEOGCS["Custom GCS",DATUM["D_Custom",SPHEROID["GRS_1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Lambert_Conformal_Conic"],PARAMETER["latitude_of_origin",30],PARAMETER["central_meridian",110],PARAMETER["standard_parallel_1",25],PARAMETER["standard_parallel_2",35],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1],AXIS["Easting",EAST],AXIS["Northing",NORTH]]';

const WKT_4490 = 'GEOGCS["China Geodetic Coordinate System 2000",DATUM["China_2000",SPHEROID["CGCS2000",6378137,298.257222101,AUTHORITY["EPSG","1023"]],AUTHORITY["EPSG","1043"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4490"]]';

function asciiBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code > 127) throw new Error("检查夹具的 WKT 必须是纯 ASCII。");
    bytes[index] = code;
  }
  return bytes;
}

/** 最小 Point shapefile（无 dbf）。检查专用。 */
function pointShapefile(points: readonly (readonly [number, number])[]): { readonly shp: Uint8Array; readonly shx: Uint8Array } {
  const headerLength = 100;
  const recordLength = 28;
  const shp = new ArrayBuffer(headerLength + points.length * recordLength);
  const view = new DataView(shp);
  view.setInt32(0, 9994, false);
  view.setInt32(24, shp.byteLength / 2, false);
  view.setInt32(28, 1000, true);
  view.setInt32(32, 1, true);
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  view.setFloat64(36, Math.min(...xs), true);
  view.setFloat64(44, Math.min(...ys), true);
  view.setFloat64(52, Math.max(...xs), true);
  view.setFloat64(60, Math.max(...ys), true);
  points.forEach((point, index) => {
    const offset = headerLength + index * recordLength;
    view.setInt32(offset, index + 1, false);
    view.setInt32(offset + 4, 10, false);
    view.setInt32(offset + 8, 1, true);
    view.setFloat64(offset + 12, point[0], true);
    view.setFloat64(offset + 20, point[1], true);
  });
  const shx = new ArrayBuffer(100 + points.length * 8);
  const shxView = new DataView(shx);
  shxView.setInt32(0, 9994, false);
  shxView.setInt32(24, shx.byteLength / 2, false);
  shxView.setInt32(28, 1000, true);
  points.forEach((_, index) => {
    const offset = 100 + index * 8;
    shxView.setInt32(offset, (headerLength + index * recordLength) / 2, false);
    shxView.setInt32(offset + 4, 10, false);
  });
  return { shp: new Uint8Array(shp), shx: new Uint8Array(shx) };
}

async function writeFixture(directory: string, name: string, points: readonly (readonly [number, number])[], wkt: string | null): Promise<string> {
  const { shp, shx } = pointShapefile(points);
  await writeFile(join(directory, `${name}.shp`), shp);
  await writeFile(join(directory, `${name}.shx`), shx);
  if (wkt !== null) await writeFile(join(directory, `${name}.prj`), asciiBytes(wkt));
  return join(directory, `${name}.shp`);
}

async function openAt(root: string, name: string): Promise<SpatialStack> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  check(resolve(dir).toLowerCase().startsWith(resolve(root).toLowerCase()), "用例目录必须在临时目录里");
  check(!resolve(dir).toLowerCase().startsWith(REPO_ROOT.toLowerCase()), "用例目录不能落在仓库里");
  return openSpatialStack({
    layerDirectory: join(dir, "layers"),
    auditDirectory: join(dir, "audit"),
    cacheDirectory: join(dir, "cache"),
    modelName: () => "v083-crs-check",
  });
}

function polygonCollection(name: string, ring: readonly (readonly [number, number])[]): MapCollection {
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { name },
      geometry: { type: "Polygon", coordinates: [ring.map(([lon, lat]) => [lon, lat])] },
    }],
  };
}

function lineCollection(name: string, from: readonly [number, number], to: readonly [number, number]): MapCollection {
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { name },
      geometry: { type: "LineString", coordinates: [[from[0], from[1]], [to[0], to[1]]] },
    }],
  };
}

function maxLon(collection: MapCollection | null): number {
  if (!collection) return Number.NaN;
  let max = Number.NEGATIVE_INFINITY;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      if (typeof value[0] === "number" && typeof value[1] === "number") {
        max = Math.max(max, value[0]);
        return;
      }
      for (const item of value) visit(item);
      return;
    }
    if (value !== null && typeof value === "object" && "type" in value) {
      const record = value as { coordinates?: unknown; geometries?: readonly unknown[] };
      if (Array.isArray(record.geometries)) {
        for (const item of record.geometries) visit(item);
        return;
      }
      visit(record.coordinates);
    }
  };
  for (const feature of collection.features) visit(feature.geometry);
  return max;
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "igis-v083-"));
  try {
    const fixtureDir = join(root, "fixtures");
    await mkdir(fixtureDir, { recursive: true });
    const stack = await openAt(root, "case");
    const service = stack.service;

    // 1. 带 .prj(UTM 50N) 的 shp：身份来自 EPSG 代码，WKT 入库。
    const utmPath = await writeFixture(fixtureDir, "utm50", [[500000, 4410000]], WKT_32650);
    const utmLayers = await service.loadFile(utmPath, null, false);
    check(utmLayers.length === 1, "UTM 夹具应载入一个图层");
    const utmLayer = utmLayers[0];
    check(utmLayer !== undefined, "UTM 图层存在");
    const utmMeta = stack.catalog.get(utmLayer.layerId);
    check(utmMeta?.crsIdentity.kind === "known" && utmMeta.crsIdentity.canonical === "EPSG:32650", `UTM 身份应为 EPSG:32650，实际 ${utmMeta?.crsLabel}`);
    check(utmMeta?.crsWkt !== undefined && utmMeta.crsWkt.includes("Transverse_Mercator"), "UTM 图层应保存 WKT");
    check(!utmLayer.message.includes("不可用"), `正常载入不应带降级说明：${utmLayer.message}`);

    // 2. 32650 缓冲：变换到工作 4326 + aeqd 米制，结果回投 32650。
    const utmBuffered = await executeGisOperation(service, {
      entry: "map",
      operation: "buffer",
      policy: { writeKnowledge: false },
      sourceLayer: { layerId: utmLayer.layerId, layerName: utmLayer.layerName },
      distance: 10,
      unit: "meters",
    });
    check(utmBuffered.ok && utmBuffered.result, `UTM 缓冲应成功：${utmBuffered.ok ? "" : String(utmBuffered.error)}`);
    const utmBufferLayer = utmBuffered.result?.layer;
    check(utmBufferLayer != null && stack.catalog.get(utmBufferLayer.layerId)?.crsLabel === "EPSG:32650", "UTM 缓冲结果应回到 EPSG:32650");
    const utmBufferCollection = stack.catalog.collection(utmBufferLayer?.layerId ?? "");
    const coordinateText = JSON.stringify(utmBufferCollection);
    check(/499\d\d\d\.\d|500\d\d\d\.\d/.test(coordinateText), `UTM 结果坐标应仍在投影空间：${coordinateText.slice(0, 120)}`);
    check(utmBuffered.record.crs?.bufferProjection === "aeqd", "米制缓冲应记录 aeqd 局部投影");
    check(utmBuffered.record.crs?.transformations.some((item) => item.purpose === "to-working" && item.to === "EPSG:4326"), "记录到工作坐标系的变换");
    check(utmBuffered.record.crs?.transformations.some((item) => item.purpose === "from-working" && item.to === "EPSG:32650"), "记录回投 EPSG:32650 的变换");
    const utmReadBack = await readOperationRecord(utmBuffered.operationId);
    check(utmReadBack?.crs?.bufferProjection === "aeqd", "读回的操作记录应保留 bufferProjection");

    // 3. 32650 × 4326 相交：跨坐标系运算，结果跟随第一个图层。
    const maskLayer = await stack.catalog.insert({
      layerName: "面-4326",
      sourcePaths: ["v083-fixture"],
      collection: polygonCollection("面", [[116.9, 39.8], [117.1, 39.8], [117.1, 39.9], [116.9, 39.9], [116.9, 39.8]]),
      crsLabel: "EPSG:4326",
    });
    const crossed = await executeGisOperation(service, {
      entry: "map",
      operation: "intersect",
      policy: { writeKnowledge: false },
      layerId: utmLayer.layerId,
      layerName: utmLayer.layerName,
      otherLayerId: maskLayer.layerId,
      otherLayerName: maskLayer.layerName,
    });
    check(crossed.ok && crossed.result, `跨坐标系相交应成功：${crossed.ok ? "" : String(crossed.error)}`);
    check(stack.catalog.get(crossed.result?.layer?.layerId ?? "")?.crsLabel === "EPSG:32650", "相交结果使用第一个图层的坐标系");
    check(crossed.result?.featureCount === 1, `点在面内应保留 1 个要素，实际 ${crossed.result?.featureCount}`);

    // 4. 北京54 无 towgs84：严格拒绝。
    const bjNoPath = await writeFixture(fixtureDir, "bj54no", [[500500, 4412000]], WKT_21453_NO_TOWGS84);
    const bjNoLayers = await service.loadFile(bjNoPath, null, false);
    const bjNoLayer = bjNoLayers[0];
    check(bjNoLayer !== undefined && stack.catalog.get(bjNoLayer.layerId)?.crsIdentity.kind === "known", "北京54 夹具身份应是已知 EPSG");
    await expectReject(() => executeGisOperation(service, {
      entry: "map",
      operation: "buffer",
      policy: { writeKnowledge: false },
      sourceLayer: { layerId: bjNoLayer.layerId, layerName: bjNoLayer.layerName },
      distance: 10,
      unit: "meters",
    }).then((outcome) => {
      if (outcome.ok) return outcome;
      throw outcome.error ?? new Error("缓冲失败");
    }), ["towgs84", "严格"]);

    // 5. 北京54 带 towgs84：放行。
    const bjYesPath = await writeFixture(fixtureDir, "bj54yes", [[500500, 4412000]], WKT_21453_TOWGS84);
    const bjYesLayers = await service.loadFile(bjYesPath, null, false);
    const bjYesLayer = bjYesLayers[0];
    check(bjYesLayer !== undefined, "带 towgs84 夹具载入成功");
    const bjBuffered = await executeGisOperation(service, {
      entry: "map",
      operation: "buffer",
      policy: { writeKnowledge: false },
      sourceLayer: { layerId: bjYesLayer.layerId, layerName: bjYesLayer.layerName },
      distance: 10,
      unit: "meters",
    });
    check(bjBuffered.ok, `带 towgs84 的北京54缓冲应成功：${bjBuffered.ok ? "" : String(bjBuffered.error)}`);
    check(stack.catalog.get(bjBuffered.result?.layer?.layerId ?? "")?.crsLabel === "EPSG:21453", "结果回到 EPSG:21453");

    // 6. 无 AUTHORITY 的投影且单位为米（V0.89.5）：平面身份，缓冲在该平面上按米放行。
    const customPath = await writeFixture(fixtureDir, "custom", [[500000, 4410000]], WKT_NO_AUTHORITY);
    const customLayers = await service.loadFile(customPath, null, false);
    const customLayer = customLayers[0];
    check(customLayer !== undefined && customLayer.message.includes("局部平面坐标系"), `自定义投影载入应说明局部平面坐标系：${customLayer?.message}`);
    check(stack.catalog.get(customLayer.layerId)?.crsLabel === "局部平面", "自定义投影身份是局部平面");
    const customBuffered = await executeGisOperation(service, {
      entry: "map",
      operation: "buffer",
      policy: { writeKnowledge: false },
      sourceLayer: { layerId: customLayer.layerId, layerName: customLayer.layerName },
      distance: 10,
      unit: "meters",
    });
    check(customBuffered.ok, `米制投影平面上的缓冲应成功：${customBuffered.ok ? "" : String(customBuffered.error)}`);
    check(stack.catalog.get(customBuffered.result?.layer?.layerId ?? "")?.crsLabel === "局部平面", "米制投影缓冲结果仍是局部平面");

    // 7. 缺 .prj：降级为未声明，载入消息给出完整影响说明。
    const barePath = await writeFixture(fixtureDir, "bare", [[116, 40]], null);
    const bareLayers = await service.loadFile(barePath, null, false);
    const bareLayer = bareLayers[0];
    check(bareLayer !== undefined && bareLayer.message.includes(".prj") && bareLayer.message.includes("空间分析不可用"), `缺 prj 应说明影响：${bareLayer?.message}`);
    check(stack.catalog.get(bareLayer.layerId)?.crsLabel === "未声明", "缺 prj 身份是未声明");

    // 8. CGCS2000：等价放行并记录基准说明。
    const cgcsPath = await writeFixture(fixtureDir, "cgcs2000", [[116.5, 40.2]], WKT_4490);
    const cgcsLayers = await service.loadFile(cgcsPath, null, false);
    const cgcsLayer = cgcsLayers[0];
    check(cgcsLayer !== undefined && stack.catalog.get(cgcsLayer.layerId)?.crsLabel === "EPSG:4490", "CGCS2000 身份应为 EPSG:4490");
    const cgcsBuffered = await executeGisOperation(service, {
      entry: "map",
      operation: "buffer",
      policy: { writeKnowledge: false },
      sourceLayer: { layerId: cgcsLayer.layerId, layerName: cgcsLayer.layerName },
      distance: 100,
      unit: "meters",
    });
    check(cgcsBuffered.ok, `CGCS2000 缓冲应成功：${cgcsBuffered.ok ? "" : String(cgcsBuffered.error)}`);
    check((cgcsBuffered.record.crs?.datumNotes ?? []).some((note) => note.includes("CGCS2000≈WGS84")), "应记录 CGCS2000≈WGS84 基准说明");
    const cgcsReadBack = await readOperationRecord(cgcsBuffered.operationId);
    check((cgcsReadBack?.crs?.datumNotes ?? []).some((note) => note.includes("CGCS2000≈WGS84")), "读回应保留 datumNotes");
    check(stack.catalog.get(cgcsBuffered.result?.layer?.layerId ?? "")?.crsLabel === "EPSG:4490", "CGCS2000 结果回到 EPSG:4490");

    // 9. aeqd 米制精度：40°N 东西向 100 米缓冲，地面真值 0.0011726°，容差 ±10%。
    //    修复前 turf 度换算给 0.000899°（差 23%），落在容差外。
    const lineLayer = await stack.catalog.insert({
      layerName: "线-4326",
      sourcePaths: ["v083-fixture"],
      collection: lineCollection("线", [116, 40], [116.01, 40]),
      crsLabel: "EPSG:4326",
    });
    const lineBuffered = await executeGisOperation(service, {
      entry: "map",
      operation: "buffer",
      policy: { writeKnowledge: false },
      sourceLayer: { layerId: lineLayer.layerId, layerName: lineLayer.layerName },
      distance: 100,
      unit: "meters",
    });
    check(lineBuffered.ok && lineBuffered.result, `米制缓冲应成功：${lineBuffered.ok ? "" : String(lineBuffered.error)}`);
    const bufferCollection = stack.catalog.collection(lineBuffered.result?.layer?.layerId ?? "");
    const eastOffset = maxLon(bufferCollection) - 116.01;
    check(eastOffset > 0.001055 && eastOffset < 0.00129, `aeqd 东西向 100 米缓冲应为 0.0011726°±10%，实际 ${eastOffset.toFixed(6)}`);
    check(lineBuffered.record.crs?.bufferProjection === "aeqd", "应记录 aeqd 局部投影");

    // 10. 导出带 crs 成员。
    const exportRoot = join(root, "exports");
    await mkdir(exportRoot, { recursive: true });
    const utmExported = await service.exportLayer(utmBufferLayer?.layerId ?? "", join(exportRoot, "utm.json"));
    check(utmExported.ok, "UTM 结果层导出成功");
    const utmExportText = await readFile(join(exportRoot, "utm.json"), { encoding: "utf8" });
    check(utmExportText.includes("\"crs\"") && utmExportText.includes("EPSG:32650"), "UTM 导出应带 EPSG:32650 的 crs 成员");
    const bareExported = await service.exportLayer(bareLayer.layerId, join(exportRoot, "bare.json"));
    check(bareExported.ok, "未声明层导出成功");
    const bareExportText = await readFile(join(exportRoot, "bare.json"), { encoding: "utf8" });
    check(!bareExportText.includes("\"crs\""), "未声明图层导出不应带 crs 成员");

    console.log("v083-crs-check passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
