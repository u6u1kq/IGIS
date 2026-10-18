// SPDX-License-Identifier: Apache-2.0

/**
 * V0.89 检查：
 *   1. 平面身份放行平面构造与平面度量。已声明投影且单位为米时，缓冲在该平面放行。
 *   2. split 三件 + 空间聚合 + 距离矩阵 + 精确最近的行为正确。
 *   3. GDL QUERY/STATS/MEASURE 三语句可解析可执行。
 *   4. 字段分级：字段名单可见（敏感字段名黑名单过滤），属性值不出现。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isSensitiveFieldName, projectFieldNames } from "@igis/ai-boundary";
import { parseGdlOrThrow } from "@igis/gdl";
import { projectForModel } from "@igis/ai-translation";
import { compareCrs, resolveStoredCrs } from "@igis/surtgis";
import { openSpatialStack } from "../../../packages/spatial-ops/src/service.js";
import { executeGisOperation } from "../../../packages/spatial-ops/src/execute-gis-operation.js";
import type { MapCollection } from "../../../packages/spatial-ops/src/types.js";

const REPO_ROOT = resolve("E:/ai工作区/Igis");

let failures = 0;

function check(condition: boolean, label: string): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${label}`);
    return;
  }
  console.log(`ok ${label}`);
}

const WKT_NO_AUTHORITY = `PROJCS["Local_Grid",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",117.0],PARAMETER["Scale_Factor",1.0],PARAMETER["Latitude_Of_Origin",0.0],UNIT["metre",1.0]]`;

function square(cx: number, cy: number, size: number): MapCollection {
  const half = size / 2;
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { name: "甲" },
      geometry: {
        type: "Polygon",
        coordinates: [[[cx - half, cy - half], [cx + half, cy - half], [cx + half, cy + half], [cx - half, cy + half], [cx - half, cy - half]]],
      },
    }],
  };
}

async function main(): Promise<void> {
  const migrated = resolveStoredCrs("无效", { kind: "invalid", canonical: "invalid", raw: "wkt-no-epsg" }, WKT_NO_AUTHORITY);
  const current = resolveStoredCrs("局部平面", { kind: "planar", canonical: "planar", raw: WKT_NO_AUTHORITY }, WKT_NO_AUTHORITY);
  check(migrated.kind === "planar" && compareCrs([migrated, current]) === "same", "旧版无效 WKT 身份迁移为平面且与新图层同源");
  const root = await mkdtemp(join(tmpdir(), "igis-v089-"));
  check(!resolve(root).toLowerCase().startsWith(REPO_ROOT.toLowerCase()), "用例目录不能落在仓库里");
  try {
    const stack = await openSpatialStack({
      layerDirectory: join(root, "layers"),
      auditDirectory: join(root, "audit"),
      cacheDirectory: join(root, "cache"),
      modelName: () => "v089-check",
    });

    // ---- 1. 平面身份：平面构造/度量放行，缓冲拒绝。
    const made = await stack.service.createLayer({
      layerName: "平面方块",
      collection: square(500000, 4400000, 100),
      crsLabel: WKT_NO_AUTHORITY,
      expectedKind: null,
      sourceLabel: "v089:平面",
      writeKnowledge: false,
    });
    const planar = stack.catalog.get(made.layer.layerId);
    check(planar?.crsIdentity.kind === "planar", "无 EPSG 的投影 WKT 是平面身份");
    const hull = await executeGisOperation(stack.service, {
      entry: "map",
      operation: "convex-hull",
      root,
      policy: { writeKnowledge: false },
      layerId: made.layer.layerId,
      layerName: made.layer.layerName,
    });
    check(hull.ok === true, `平面身份凸包应放行：${hull.ok ? "" : String(hull.error)}`);
    const area = await executeGisOperation(stack.service, {
      entry: "map",
      operation: "area",
      root,
      policy: { writeKnowledge: false },
      layerId: made.layer.layerId,
      layerName: made.layer.layerName,
    });
    check(area.ok === true && (area.result?.sum ?? 0) > 9000 && (area.result?.sum ?? 0) < 11000, `平面面积按平面公式算（100×100=10000）：${area.ok ? String(area.result?.sum) : String(area.error)}`);
    const buffered = await executeGisOperation(stack.service, {
      entry: "map",
      operation: "buffer",
      root,
      policy: { writeKnowledge: false },
      sourceLayer: { layerId: made.layer.layerId, layerName: made.layer.layerName },
      distance: 10,
      unit: "meters",
    });
    check(buffered.ok === true, `米制投影平面上的缓冲应放行：${buffered.ok ? "" : String(buffered.error)}`);
    console.log("ok 平面身份放行平面构造、平面度量，以及米制投影上的缓冲");

    // ---- 2. split 三件 + 聚合 + 距离矩阵 + 精确最近。
    const lineLayer = await stack.service.createLayer({
      layerName: "线",
      collection: {
        type: "FeatureCollection",
        features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[0, 0], [10, 0]] } }],
      },
      crsLabel: "EPSG:4326",
      expectedKind: "line",
      sourceLabel: "v089:线",
      writeKnowledge: false,
    });
    const pointLayer = await stack.service.createLayer({
      layerName: "点",
      collection: {
        type: "FeatureCollection",
        features: [{ type: "Feature", properties: { v: 2 }, geometry: { type: "Point", coordinates: [5, 0] } }],
      },
      crsLabel: "EPSG:4326",
      expectedKind: "point",
      sourceLabel: "v089:点",
      writeKnowledge: false,
    });
    const splitLine = await executeGisOperation(stack.service, {
      entry: "map",
      operation: "split-line",
      root,
      policy: { writeKnowledge: false },
      layerId: lineLayer.layer.layerId,
      layerName: lineLayer.layer.layerName,
      otherLayerId: pointLayer.layer.layerId,
      otherLayerName: pointLayer.layer.layerName,
    });
    const splitParts = splitLine.result?.layer ? stack.catalog.collection(splitLine.result.layer.layerId)?.features.length ?? 0 : 0;
    check(splitLine.ok === true && splitParts === 2, `点分割线应切成 2 段：实际 ${splitParts}`);

    const multiLayer = await stack.service.createLayer({
      layerName: "多部件",
      collection: {
        type: "FeatureCollection",
        features: [{ type: "Feature", properties: {}, geometry: { type: "MultiPoint", coordinates: [[0, 0], [1, 1]] } }],
      },
      crsLabel: "EPSG:4326",
      expectedKind: "point",
      sourceLabel: "v089:多部件",
      writeKnowledge: false,
    });
    const exploded = await executeGisOperation(stack.service, {
      entry: "map",
      operation: "explode",
      root,
      policy: { writeKnowledge: false },
      layerId: multiLayer.layer.layerId,
      layerName: multiLayer.layer.layerName,
    });
    const explodedParts = exploded.result?.layer ? stack.catalog.collection(exploded.result.layer.layerId)?.features.length ?? 0 : 0;
    check(exploded.ok === true && explodedParts === 2, `多部件拆分应得 2 个单部件：实际 ${explodedParts}`);

    const polyLayer = await stack.service.createLayer({
      layerName: "面",
      collection: square(5, 5, 10),
      crsLabel: "EPSG:4326",
      expectedKind: "polygon",
      sourceLabel: "v089:面",
      writeKnowledge: false,
    });
    const cutLayer = await stack.service.createLayer({
      layerName: "切割线",
      collection: {
        type: "FeatureCollection",
        features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[5, 0], [5, 10]] } }],
      },
      crsLabel: "EPSG:4326",
      expectedKind: "line",
      sourceLabel: "v089:切割线",
      writeKnowledge: false,
    });
    const splitPoly = await executeGisOperation(stack.service, {
      entry: "map",
      operation: "split-polygon",
      root,
      policy: { writeKnowledge: false },
      layerId: polyLayer.layer.layerId,
      layerName: polyLayer.layer.layerName,
      otherLayerId: cutLayer.layer.layerId,
      otherLayerName: cutLayer.layer.layerName,
    });
    const polyParts = splitPoly.result?.layer ? stack.catalog.collection(splitPoly.result.layer.layerId)?.features.length ?? 0 : 0;
    check(splitPoly.ok === true && polyParts === 2, `线分割面应切成 2 块：实际 ${polyParts}`);

    const innerPointLayer = await stack.service.createLayer({
      layerName: "面内点",
      collection: {
        type: "FeatureCollection",
        features: [{ type: "Feature", properties: { v: 2 }, geometry: { type: "Point", coordinates: [5, 5] } }],
      },
      crsLabel: "EPSG:4326",
      expectedKind: "point",
      sourceLabel: "v089:面内点",
      writeKnowledge: false,
    });
    const agg = await executeGisOperation(stack.service, {
      entry: "map",
      operation: "spatial-aggregate",
      root,
      policy: { writeKnowledge: false },
      layerId: polyLayer.layer.layerId,
      layerName: polyLayer.layer.layerName,
      otherLayerId: innerPointLayer.layer.layerId,
      otherLayerName: innerPointLayer.layer.layerName,
      fieldName: "v",
    });
    const aggCollection = agg.result?.layer ? stack.catalog.collection(agg.result.layer.layerId) : null;
    check(agg.ok === true && aggCollection?.features[0]?.properties._count === 1, "空间聚合应给 _count=1");
    check(aggCollection?.features[0]?.properties._sum === 2, "空间聚合应给 _sum=2");
    check((agg.result?.message ?? "").includes("聚合摘要"), "空间聚合应带摘要");

    const matrix = await executeGisOperation(stack.service, {
      entry: "map",
      operation: "distance-matrix",
      root,
      policy: { writeKnowledge: false },
      layerId: pointLayer.layer.layerId,
      layerName: pointLayer.layer.layerName,
      otherLayerId: lineLayer.layer.layerId,
      otherLayerName: lineLayer.layer.layerName,
    });
    check(matrix.ok === true, "距离矩阵应成功");
    const overLimit = await executeGisOperation(stack.service, {
      entry: "map",
      operation: "distance-matrix",
      root,
      policy: { writeKnowledge: false },
      layerId: polyLayer.layer.layerId,
      layerName: polyLayer.layer.layerName,
      otherLayerId: lineLayer.layer.layerId,
      otherLayerName: lineLayer.layer.layerName,
      limit: 0,
    });
    check(overLimit.ok === false, "距离矩阵超上限应拒绝");

    const exact = await executeGisOperation(stack.service, {
      entry: "map",
      operation: "nearest-exact",
      root,
      policy: { writeKnowledge: false },
      layerId: lineLayer.layer.layerId,
      layerName: lineLayer.layer.layerName,
      otherLayerId: pointLayer.layer.layerId,
      otherLayerName: pointLayer.layer.layerName,
    });
    const exactCollection = exact.result?.layer ? stack.catalog.collection(exact.result.layer.layerId) : null;
    check(exact.ok === true && (exactCollection?.features[0]?.properties._dist ?? -1) === 0, "精确最近距离（点在线上应为 0）");
    console.log("ok split 三件 / 空间聚合 / 距离矩阵 / 精确最近行为正确");

    // ---- 3. GDL 三语句。
    const program = parseGdlOrThrow([
      "QUERY 点 WITH \"v = 2\" AS 点_筛选",
      "STATS 点 ON v",
      "MEASURE AREA 面",
      "MEASURE DISTANCE 点 TO 线",
    ].join("\n"));
    check(program.statements.length === 4, "GDL QUERY/STATS/MEASURE 应解析 4 条语句");
    check(program.statements.every((statement) => statement.kind === "query" || statement.kind === "stats" || statement.kind === "measure"), "GDL 三语句 kind 正确");
    console.log("ok GDL QUERY/STATS/MEASURE 三语句可解析");

    // ---- 4. 字段分级。
    check(isSensitiveFieldName("手机号") && isSensitiveFieldName("phone") && isSensitiveFieldName("身份证号"), "敏感字段名命中黑名单");
    check(!isSensitiveFieldName("地块编号") && !isSensitiveFieldName("name") && !isSensitiveFieldName("地类"), "常规字段名不误伤");
    const projected = projectFieldNames(["地块编号", "手机号", "name", "家庭住址"]);
    check(projected.includes("地块编号") && projected.includes("name") && !projected.includes("手机号") && !projected.includes("家庭住址"), "字段名单投影过滤敏感字段");
    const payload = projectForModel({ fieldNames: ["地块编号", "手机号"], fieldName: "手机号", featureCount: 3, minimum: 1 });
    const text = JSON.stringify(payload ?? "");
    check(text.includes("地块编号") && !text.includes("手机号"), "模型可见面含普通字段名、不含敏感字段名");
    check(!text.includes("coordinates") && text.includes("featureCount"), "属性值仍只出聚合");
    console.log("ok 字段分级保守默认正确");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

let failed: unknown = null;
try {
  await main();
} catch (error) {
  failed = error;
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
}
if (failed || failures > 0) throw new Error("v089-check failed");
console.log("v089-check passed");
