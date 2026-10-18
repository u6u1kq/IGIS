// SPDX-License-Identifier: Apache-2.0

/**
 * V0.93.1 覆盖面和本机可写的分析：擦除、联合、按位置连接、四叉树、核密度、
 * 格网聚合、路网、统计图、分类设色。
 * 运行：npx tsx --tsconfig tsconfig.json apps/cli/src/v093-check.ts
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AUDIT_REQUIRED_OPERATIONS, CAPABILITY_MANIFEST } from "@igis/ai-boundary";
import { GIS_TOOL_REGISTRY, canonicalToolName } from "@igis/llm-dispatch";
import { defaultLayerStyle, mergeLayerStyle } from "@igis/surtgis";
import { CAPABILITY_OPERATIONS, executeGisOperation } from "../../../packages/spatial-ops/src/execute-gis-operation.js";
import { readOperationRecord } from "../../../packages/spatial-ops/src/operation-attempt.js";
import { openSpatialStack } from "../../../packages/spatial-ops/src/service.js";
import type { MapCollection } from "../../../packages/spatial-ops/src/types.js";

const REPO_ROOT = resolve("E:/ai工作区/Igis");
const NAMES = [
  "map.erase", "map.union", "map.spatialJoin", "map.viewshed", "map.rasterClip", "map.polygonize", "map.rasterize",
  "map.zonal", "map.resample", "map.rasterIndex", "map.focal", "map.quadtree", "map.chart", "map.kernelDensity",
  "map.snapToNetwork", "map.networkDistance", "map.serviceArea", "map.aggregateGrid", "map.exportMap",
] as const;
const OPERATIONS = [
  "erase", "union", "spatial-join", "viewshed", "raster-clip", "polygonize", "rasterize", "zonal", "resample",
  "raster-index", "focal", "quadtree", "chart", "kernel-density", "network-snap", "network-distance", "service-area", "aggregate-grid",
] as const;

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

function polygon(x: number, y: number, size: number, properties: Record<string, string | number | boolean | null>): MapCollection["features"][number] {
  return {
    type: "Feature",
    properties,
    geometry: { type: "Polygon", coordinates: [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]] },
  };
}

function point(x: number, y: number, properties: Record<string, string | number | boolean | null>): MapCollection["features"][number] {
  return { type: "Feature", properties, geometry: { type: "Point", coordinates: [x, y] } };
}

function line(coordinates: readonly (readonly [number, number])[]): MapCollection["features"][number] {
  return { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coordinates.map((pair) => [pair[0], pair[1]]) } };
}

async function main(): Promise<void> {
  for (const name of NAMES) {
    check(GIS_TOOL_REGISTRY.some((tool) => tool.name === name), `${name} 不在注册表`);
    check(CAPABILITY_MANIFEST.some((entry) => entry.tool === name), `${name} 不在能力清单`);
  }
  for (const operation of OPERATIONS) {
    check(CAPABILITY_OPERATIONS.includes(operation), `${operation} 不在执行清单`);
    check(AUDIT_REQUIRED_OPERATIONS.includes(operation), `${operation} 不在留痕清单`);
  }
  check(canonicalToolName("erase_overlay") === "map.erase", "擦除别名未折回");
  check(canonicalToolName("spatial_join") === "map.spatialJoin", "按位置连接别名未折回");
  check(canonicalToolName("export_map") === "map.exportMap", "出图别名未折回");
  const styled = mergeLayerStyle(defaultLayerStyle(0), { colorField: "kind", labelField: "name" });
  check(styled.colorField === "kind" && styled.labelField === "name", "分类字段和注记字段应写入样式");
  check(mergeLayerStyle(styled, { colorField: "" }).colorField === null, "空字符串应取消分类设色");
  console.log("ok 登记、别名和样式字段");

  const root = await mkdtemp(join(tmpdir(), "igis-v093-"));
  check(!resolve(root).toLowerCase().startsWith(REPO_ROOT.toLowerCase()), "用例目录不能落在仓库里");
  try {
    const stack = await openSpatialStack({
      layerDirectory: join(root, "layers"),
      auditDirectory: join(root, "audit"),
      cacheDirectory: join(root, "cache"),
      modelName: () => "v093",
    });
    const unknownBase = await stack.service.createLayer({
      layerName: "未知底",
      collection: { type: "FeatureCollection", features: [polygon(0, 0, 10, { kind: "甲" })] },
      crsLabel: "Unknown",
      expectedKind: "polygon",
      sourceLabel: "v093",
      writeKnowledge: false,
    });
    let refused = "";
    try {
      await stack.service.erase(unknownBase.layer.layerId, unknownBase.layer.layerId, false, "拒");
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error);
    }
    check(refused !== "", "未声明坐标系的擦除应像相交一样被拒绝");
    const base = await stack.service.createLayer({
      layerName: "底",
      collection: { type: "FeatureCollection", features: [polygon(500000, 3000000, 1000, { kind: "甲" })] },
      crsLabel: "EPSG:3857",
      expectedKind: "polygon",
      sourceLabel: "v093",
      writeKnowledge: false,
    });
    const cutter = await stack.service.createLayer({
      layerName: "切",
      collection: { type: "FeatureCollection", features: [polygon(500200, 3000200, 200, { kind: "乙" })] },
      crsLabel: "EPSG:3857",
      expectedKind: "polygon",
      sourceLabel: "v093",
      writeKnowledge: false,
    });
    const erased = await executeGisOperation(stack.service, {
      entry: "map",
      operation: "erase",
      root,
      policy: { writeKnowledge: false },
      layerId: base.layer.layerId,
      layerName: base.layer.layerName,
      otherLayerId: cutter.layer.layerId,
      otherLayerName: cutter.layer.layerName,
    });
    const erasedRecord = await readOperationRecord(erased.operationId, root);
    check(erasedRecord?.status === "succeeded", `擦除应成功，实际 ${erasedRecord?.status ?? ""} ${erasedRecord?.error?.message ?? ""}`);
    const erasedRows = stack.catalog.collection(erased.result?.layer?.layerId ?? "");
    check((erasedRows?.features.length ?? 0) >= 1, "擦除应留下面");
    const erasedArea = await stack.service.area(erased.result?.layer?.layerId ?? "", false);
    const baseArea = await stack.service.area(base.layer.layerId, false);
    const ratio = (erasedArea.sum ?? 0) / (baseArea.sum ?? 1);
    check(Math.abs(ratio - 0.96) < 1e-4, `擦掉中间 4% 后面积比应约为 0.96，实际 ${ratio}`);
    const erasedFirst = erasedRows?.features[0]?.geometry;
    const firstPair = erasedFirst?.type === "Polygon" ? erasedFirst.coordinates[0]?.[0] : null;
    check(Array.isArray(firstPair) && (firstPair[0] ?? 0) > 400000, "擦除结果应按原坐标系保存，不应留在经纬度");

    const united = await stack.service.unionOverlay(base.layer.layerId, cutter.layer.layerId, false, "联合");
    check((stack.catalog.collection(united.layer?.layerId ?? "")?.features.length ?? 0) === 1, "两个重叠面联合后应是一个面");

    const zones = await stack.service.createLayer({
      layerName: "区",
      collection: { type: "FeatureCollection", features: [polygon(500000, 3000000, 20, { name: "东区" })] },
      crsLabel: "EPSG:3857",
      expectedKind: "polygon",
      sourceLabel: "v093",
      writeKnowledge: false,
    });
    const samplePoints = [
      point(500002, 3000002, { value: 1 }),
      point(500008, 3000008, { value: 5 }),
      point(500090, 3000090, { value: 9 }),
    ];
    const projectedSamples = await stack.service.createLayer({
      layerName: "投影点",
      collection: { type: "FeatureCollection", features: samplePoints },
      crsLabel: "EPSG:3857",
      expectedKind: "point",
      sourceLabel: "v093",
      writeKnowledge: false,
    });
    const samples = await stack.service.createLayer({
      layerName: "点",
      collection: { type: "FeatureCollection", features: samplePoints },
      crsLabel: "Unknown",
      expectedKind: "point",
      sourceLabel: "v093",
      writeKnowledge: false,
    });
    const joined = await stack.service.spatialJoin(projectedSamples.layer.layerId, zones.layer.layerId, false, "位置");
    const joinedRows = stack.catalog.collection(joined.layer?.layerId ?? "");
    const named = joinedRows?.features.filter((feature) => feature.properties.name === "东区") ?? [];
    check(named.length === 2, `面内的两个点应带上区名，实际 ${named.length}`);

    const tree = await stack.service.quadtree(samples.layer.layerId, false, "树");
    const treeRows = stack.catalog.collection(tree.layer?.layerId ?? "");
    const counted = (treeRows?.features ?? []).reduce((total, feature) => total + Number(feature.properties._count ?? 0), 0);
    check(counted === 3, `四叉树点数应为 3，实际 ${counted}`);

    const density = await stack.service.kernelDensity(samples.layer.layerId, 10, 10, false, "密度");
    const densityRows = stack.catalog.collection(density.layer?.layerId ?? "");
    check((densityRows?.features.length ?? 0) > 0, "核密度应产出格网");
    check(densityRows?.features.some((feature) => typeof feature.properties._density === "number" && feature.properties._density > 0) === true, "核密度应写下 _density");

    const grid = await stack.service.aggregateGrid(samples.layer.layerId, 20, false, "格网");
    const gridRows = stack.catalog.collection(grid.layer?.layerId ?? "");
    const gridCount = (gridRows?.features ?? []).reduce((total, feature) => total + Number(feature.properties._count ?? 0), 0);
    check(gridCount === 3, `格网计数应为 3，实际 ${gridCount}`);
    check(gridRows?.features.every((feature) => feature.geometry?.type === "Polygon") === true, "格网聚合不应保留原点");

    const chart = await stack.service.chart(samples.layer.layerId, "value", false);
    check(chart.message.includes("1") && chart.featureCount === 3, `统计图应覆盖三个数，实际 ${chart.message}`);

    const roads = await stack.service.createLayer({
      layerName: "路",
      collection: {
        type: "FeatureCollection",
        features: [line([[500000, 3000000], [500010, 3000000], [500010, 3000010]])],
      },
      crsLabel: "Unknown",
      expectedKind: "line",
      sourceLabel: "v093",
      writeKnowledge: false,
    });
    const origins = await stack.service.createLayer({
      layerName: "起",
      collection: { type: "FeatureCollection", features: [point(500000, 3000000, { value: 1 })] },
      crsLabel: "Unknown",
      expectedKind: "point",
      sourceLabel: "v093",
      writeKnowledge: false,
    });
    const destinations = await stack.service.createLayer({
      layerName: "终",
      collection: { type: "FeatureCollection", features: [point(500010, 3000010, { value: 1 })] },
      crsLabel: "Unknown",
      expectedKind: "point",
      sourceLabel: "v093",
      writeKnowledge: false,
    });
    const snapped = await stack.service.snapToNetwork(samples.layer.layerId, roads.layer.layerId, false, "落点");
    const snapRows = stack.catalog.collection(snapped.layer?.layerId ?? "");
    check((snapRows?.features.length ?? 0) === 3, "三个点都应落到线上");
    check(snapRows?.features.every((feature) => typeof feature.properties._snap === "number") === true, "落点应写下 _snap");
    const distance = await stack.service.networkDistance(origins.layer.layerId, destinations.layer.layerId, roads.layer.layerId, false);
    check(Math.abs((distance.minimum ?? 0) - 20) < 0.2, `沿路距离应约为 20，实际 ${String(distance.minimum)}`);
    const area = await stack.service.serviceArea(origins.layer.layerId, roads.layer.layerId, 12, false, "范围");
    const areaRows = stack.catalog.collection(area.layer?.layerId ?? "");
    check((areaRows?.features.length ?? 0) >= 1, "服务范围应留下路段");
    const reached = (areaRows?.features ?? []).reduce((total, feature) => {
      const coords = feature.geometry?.type === "LineString" ? feature.geometry.coordinates : [];
      const a = coords[0];
      const b = coords[1];
      return total + (a && b ? Math.hypot((b[0] ?? 0) - (a[0] ?? 0), (b[1] ?? 0) - (a[1] ?? 0)) : 0);
    }, 0);
    check(Math.abs(reached - 12) < 1e-6, `沿 20 长的路走 12，覆盖长度应为 12，实际 ${reached}`);

    // 环路：两端都可达但都走不满的路段要从两端各画一截。
    const ring = await stack.service.createLayer({
      layerName: "环",
      collection: {
        type: "FeatureCollection",
        features: [line([[0, 0], [10, 0]]), line([[10, 0], [10, 10]]), line([[10, 10], [0, 10]]), line([[0, 10], [0, 0]])],
      },
      crsLabel: "Unknown",
      expectedKind: "line",
      sourceLabel: "v093",
      writeKnowledge: false,
    });
    const corner = await stack.service.createLayer({
      layerName: "角",
      collection: { type: "FeatureCollection", features: [point(0, 0, {})] },
      crsLabel: "Unknown",
      expectedKind: "point",
      sourceLabel: "v093",
      writeKnowledge: false,
    });
    const ringArea = await stack.service.serviceArea(corner.layer.layerId, ring.layer.layerId, 15, false, "环范围");
    const ringReach = (stack.catalog.collection(ringArea.layer?.layerId ?? "")?.features ?? []).reduce((total, feature) => {
      const coords = feature.geometry?.type === "LineString" ? feature.geometry.coordinates : [];
      const a = coords[0];
      const b = coords[1];
      return total + (a && b ? Math.hypot((b[0] ?? 0) - (a[0] ?? 0), (b[1] ?? 0) - (a[1] ?? 0)) : 0);
    }, 0);
    check(Math.abs(ringReach - 30) < 1e-6, `周长 40 的环从一角走 15，两侧共覆盖 30，实际 ${ringReach}`);

    // 十字路口：起点在交点左侧 10，终点在竖路上距交点 30，沿路 40；同一条边上的两点按沿线距离相连。
    const cross = await stack.service.createLayer({
      layerName: "十字",
      collection: { type: "FeatureCollection", features: [line([[0, 0], [100, 0]]), line([[50, -50], [50, 50]])] },
      crsLabel: "Unknown",
      expectedKind: "line",
      sourceLabel: "v093",
      writeKnowledge: false,
    });
    const nearCross = await stack.service.createLayer({
      layerName: "路口西",
      collection: { type: "FeatureCollection", features: [point(40, 1, {})] },
      crsLabel: "Unknown",
      expectedKind: "point",
      sourceLabel: "v093",
      writeKnowledge: false,
    });
    const upCross = await stack.service.createLayer({
      layerName: "路口北",
      collection: { type: "FeatureCollection", features: [point(51, 30, {}), point(20, 0, {})] },
      crsLabel: "Unknown",
      expectedKind: "point",
      sourceLabel: "v093",
      writeKnowledge: false,
    });
    const crossDistance = await stack.service.networkDistance(nearCross.layer.layerId, upCross.layer.layerId, cross.layer.layerId, false);
    check(Math.abs((crossDistance.minimum ?? 0) - 20) < 1e-9, `同一条路上 (40,0) 到 (20,0) 应为 20，实际 ${String(crossDistance.minimum)}`);
    const onlyUp = await stack.service.createLayer({
      layerName: "仅北",
      collection: { type: "FeatureCollection", features: [point(51, 30, {})] },
      crsLabel: "Unknown",
      expectedKind: "point",
      sourceLabel: "v093",
      writeKnowledge: false,
    });
    const turn = await stack.service.networkDistance(nearCross.layer.layerId, onlyUp.layer.layerId, cross.layer.layerId, false);
    check(Math.abs((turn.minimum ?? 0) - 40) < 1e-9, `经交点转弯应为 10+30=40，实际 ${String(turn.minimum)}`);

    // EPSG:4326 下路网距离用球面米：赤道上经度 0.01 度约 1113.2 米。
    const geoRoad = await stack.service.createLayer({
      layerName: "经纬路",
      collection: { type: "FeatureCollection", features: [line([[0, 0], [0.01, 0]])] },
      crsLabel: "EPSG:4326",
      expectedKind: "line",
      sourceLabel: "v093",
      writeKnowledge: false,
    });
    const geoStart = await stack.service.createLayer({
      layerName: "经纬起",
      collection: { type: "FeatureCollection", features: [point(0, 0, {})] },
      crsLabel: "EPSG:4326",
      expectedKind: "point",
      sourceLabel: "v093",
      writeKnowledge: false,
    });
    const geoEnd = await stack.service.createLayer({
      layerName: "经纬终",
      collection: { type: "FeatureCollection", features: [point(0.01, 0, {})] },
      crsLabel: "EPSG:4326",
      expectedKind: "point",
      sourceLabel: "v093",
      writeKnowledge: false,
    });
    const geoDistance = await stack.service.networkDistance(geoStart.layer.layerId, geoEnd.layer.layerId, geoRoad.layer.layerId, false);
    const expectedMeters = 6371000 * 0.01 * Math.PI / 180;
    check(Math.abs((geoDistance.minimum ?? 0) - expectedMeters) < 0.01, `经纬度路网距离应约为 ${expectedMeters.toFixed(3)} 米，实际 ${String(geoDistance.minimum)}`);
    let mixed = "";
    try {
      await stack.service.networkDistance(geoStart.layer.layerId, destinations.layer.layerId, geoRoad.layer.layerId, false);
    } catch (error) {
      mixed = error instanceof Error ? error.message : String(error);
    }
    check(mixed.includes("坐标系不同"), `不同坐标系的路网距离应被拒绝，实际 ${mixed}`);

    // 地理核密度：带宽和边长按米，_density 是每平方公里点数。单点在中心格的估计值约为 1/(2πh²)·1e6。
    const geoDensity = await stack.service.kernelDensity(geoStart.layer.layerId, 500, 50, false, "经纬密度");
    const geoDensityRows = stack.catalog.collection(geoDensity.layer?.layerId ?? "")?.features ?? [];
    const peak = Math.max(...geoDensityRows.map((feature) => Number(feature.properties._density ?? 0)));
    const ideal = 1e6 / (2 * Math.PI * 500 * 500);
    check(geoDensityRows.length > 100 && peak > ideal * 0.98 && peak <= ideal * 1.0000001, `地理核密度峰值应接近 ${ideal.toFixed(4)}，实际 ${peak}`);
    // 单点密度在格网上的积分应接近 1（3h 截断后约 0.989）。
    const cellArea = geoDensityRows.reduce((total, feature) => {
      const ring = feature.geometry?.type === "Polygon" ? feature.geometry.coordinates[0] ?? [] : [];
      const width = Math.abs((ring[1]?.[0] ?? 0) - (ring[0]?.[0] ?? 0)) * (6371000 * Math.PI / 180);
      const height = Math.abs((ring[2]?.[1] ?? 0) - (ring[1]?.[1] ?? 0)) * (6371000 * Math.PI / 180);
      return total + Number(feature.properties._density ?? 0) * (width * height) / 1e6;
    }, 0);
    check(Math.abs(cellArea - 0.989) < 0.02, `单点核密度积分应约为 0.989，实际 ${cellArea}`);
    console.log("ok 擦除、联合、连接、四叉树、核密度、格网、统计图和路网");
    console.log("v093-check passed");
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
if (failed) {
  console.error(failed instanceof Error ? failed.message : failed);
  throw failed;
}
