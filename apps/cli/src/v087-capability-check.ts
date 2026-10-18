// SPDX-License-Identifier: Apache-2.0

/**
 * V0.87 能力补全验证（度量 / 几何转换 / 融合 / 属性 / 分幅）。
 * 行为断言（真实执行 service 能力方法，临时目录、不监听端口）：
 *   1. 度量：面积/长度/距离的数值量级正确（球面精确），只出标量
 *   2. nearest 产图层带 _dist 字段；convert 线↔面；dissolve 融合；merge 合并/类型不同拒绝
 *   3. simplify 减少顶点；groupStats/reclassify/qualityCheck 摘要正确；splitByGrid 带 _sheet
 *   4. 每个能力经 executeGisOperation 写 OperationRecord（kind + 参数入账）
 *   5. 契约一致性：注册表 12 新工具都登记在 CAPABILITY_MANIFEST，12 个操作都在 AUDIT_REQUIRED_OPERATIONS
 * 运行：npx tsx --tsconfig tsconfig.json apps/cli/src/v087-capability-check.ts
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AUDIT_REQUIRED_OPERATIONS, CAPABILITY_MANIFEST } from "@igis/ai-boundary";
import { GIS_TOOL_REGISTRY } from "@igis/llm-dispatch";
import { openSpatialStack } from "../../../packages/spatial-ops/src/service.js";
import { executeGisOperation, CAPABILITY_OPERATIONS } from "../../../packages/spatial-ops/src/execute-gis-operation.js";
import { readOperationRecord } from "../../../packages/spatial-ops/src/operation-attempt.js";
import type { MapCollection } from "../../../packages/spatial-ops/src/types.js";

const REPO_ROOT = resolve("E:/ai工作区/Igis");

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

function polygon(x: number, y: number, size: number, properties: Record<string, string | number | boolean | null>): MapCollection {
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties,
      geometry: { type: "Polygon", coordinates: [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]] },
    }],
  };
}

function line(points: readonly (readonly [number, number])[], properties: Record<string, string | number | boolean | null>): MapCollection {
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties,
      geometry: { type: "LineString", coordinates: points.map((point) => [point[0], point[1]]) },
    }],
  };
}

function points(items: readonly (readonly [number, number])[], properties: Record<string, string | number | boolean | null>): MapCollection {
  return {
    type: "FeatureCollection",
    features: items.map((item, index) => ({
      type: "Feature",
      properties: { ...properties, seq: index },
      geometry: { type: "Point", coordinates: [item[0], item[1]] },
    })),
  };
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "igis-v087-cap-"));
  check(!resolve(root).toLowerCase().startsWith(REPO_ROOT.toLowerCase()), "用例目录不能落在仓库里");
  try {
    const stack = await openSpatialStack({
      layerDirectory: join(root, "layers"),
      auditDirectory: join(root, "audit"),
      cacheDirectory: join(root, "cache"),
      modelName: () => "v087-cap",
    });
    const add = (layerName: string, collection: MapCollection) => stack.service.createLayer({
      layerName,
      collection,
      crsLabel: "EPSG:4326",
      expectedKind: null,
      sourceLabel: "v087-cap",
      writeKnowledge: false,
    });

    // ---- 1. 度量量级（0.02° 方块在 39°N 约 3.8e6 平方米；0.02° 纬差约 2218 米）。
    const square = await add("方块", polygon(116, 39, 0.02, { name: "甲" }));
    const area = await stack.service.area(square.layer.layerId, false);
    check(area.ok === true && typeof area.sum === "number", "面积统计应返回合计");
    check((area.sum ?? 0) > 3.4e6 && (area.sum ?? 0) < 4.3e6, `面积量级不对：${area.sum}`);
    const seg = await add("线段", line([[116, 39], [116, 39.02]], { name: "线1" }));
    const length = await stack.service.length(seg.layer.layerId, false);
    check((length.sum ?? 0) > 2000 && (length.sum ?? 0) < 2450, `长度量级不对：${length.sum}`);
    const far = await add("远点", points([[116.02, 39]], { name: "远" }));
    const near = await add("近点", points([[116, 39]], { name: "近" }));
    const distance = await stack.service.distanceStats(far.layer.layerId, near.layer.layerId, false);
    check(distance.ok === true && (distance.minimum ?? 0) > 1400 && (distance.minimum ?? 0) < 1900, `距离量级不对：${distance.minimum}`);
    console.log("ok 度量族量级正确（面积/长度/距离，只出标量）");

    // ---- 2. nearest / convert / dissolve / merge。
    const nearest = await stack.service.nearest(far.layer.layerId, near.layer.layerId, false, "最近标注");
    check(nearest.ok === true && nearest.layer !== null, "nearest 应生成图层");
    const nearestCollection = stack.catalog.collection(nearest.layer?.layerId ?? "");
    const distValue = nearestCollection?.features[0]?.properties._dist;
    check(typeof distValue === "number" && distValue > 1400 && distValue < 1900, `nearest 的 _dist 不对：${String(distValue)}`);

    const ring = await add("环线", line([[116, 39], [116.02, 39], [116.02, 39.02], [116, 39.02], [116, 39]], { name: "环" }));
    const toPolygon = await stack.service.convert(ring.layer.layerId, "polygon", false, "线转面");
    check(toPolygon.ok === true && toPolygon.layer !== null, "线转面应生成图层");
    const toLine = await stack.service.convert(square.layer.layerId, "line", false, "面转线");
    check(toLine.ok === true && toLine.layer !== null, "面转线应生成图层");

    const secondSquare = await add("方块2", polygon(116.01, 39, 0.02, { name: "乙" }));
    const dissolved = await stack.service.dissolve(square.layer.layerId, null, false, "融合结果");
    check(dissolved.ok === true && dissolved.layer !== null, "融合应生成图层");
    const twoSquares = await stack.service.merge(square.layer.layerId, secondSquare.layer.layerId, false, "合并结果");
    check(twoSquares.ok === true && twoSquares.featureCount === 2, "合并应有 2 个要素");
    let mergeError = "";
    try {
      await stack.service.merge(square.layer.layerId, seg.layer.layerId, false, null);
    } catch (error) {
      mergeError = error instanceof Error ? error.message : "";
    }
    check(mergeError.includes("几何类型不同"), "类型不同的合并应被拒绝");
    console.log("ok nearest/convert/dissolve/merge 行为正确");

    // ---- 3. simplify / 属性族 / splitByGrid。
    const zigzag = await add("折线", line([[116, 39], [116.005, 39.01], [116.01, 39], [116.015, 39.01], [116.02, 39]], { name: "折" }));
    const simplified = await stack.service.simplify(zigzag.layer.layerId, 200, false, "简化结果");
    check(simplified.ok === true && simplified.layer !== null, "简化应生成图层");
    const simplifiedCollection = stack.catalog.collection(simplified.layer?.layerId ?? "");
    const before = stack.catalog.collection(zigzag.layer.layerId)?.features[0]?.geometry.type === "LineString"
      ? (stack.catalog.collection(zigzag.layer.layerId)?.features[0]?.geometry as { coordinates: unknown[] }).coordinates.length
      : 0;
    const after = simplifiedCollection?.features[0]?.geometry.type === "LineString"
      ? (simplifiedCollection.features[0]?.geometry as { coordinates: unknown[] }).coordinates.length
      : 0;
    check(after < before, `简化应减少顶点（${before} → ${after}）`);

    const parcels = await add("地块组", {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: { kind: "农田", pop: 10 }, geometry: { type: "Polygon", coordinates: [[[116, 39], [116.01, 39], [116.01, 39.01], [116, 39.01], [116, 39]]] } },
        { type: "Feature", properties: { kind: "农田", pop: 20 }, geometry: { type: "Polygon", coordinates: [[[116.02, 39], [116.03, 39], [116.03, 39.01], [116.02, 39.01], [116.02, 39]]] } },
        { type: "Feature", properties: { kind: "林地", pop: 5 }, geometry: { type: "Polygon", coordinates: [[[116.04, 39], [116.05, 39], [116.05, 39.01], [116.04, 39.01], [116.04, 39]]] } },
      ],
    });
    const grouped = await stack.service.groupStats(parcels.layer.layerId, "kind", "pop", false);
    check(grouped.ok === true && grouped.message.includes("农田") && grouped.message.includes("林地"), "分组统计应列出各组");
    check(grouped.message.includes("合计 30"), "农田组合计应是 30");

    const reclassed = await stack.service.reclassify(parcels.layer.layerId, "kind", "农田=耕地;林地=森林", false, "重分类结果");
    check(reclassed.ok === true && reclassed.message.includes("映射命中 3 个"), "重分类应命中全部要素");

    const quality = await stack.service.qualityCheck(parcels.layer.layerId, false);
    check(quality.ok === true && quality.message.includes("空值") && quality.message.includes("kind"), "质量检查应列出字段");

    const split = await stack.service.splitGrid(parcels.layer.layerId, 2, 2, false, "分幅结果");
    check(split.ok === true && split.layer !== null, "分幅应生成图层");
    const splitCollection = stack.catalog.collection(split.layer?.layerId ?? "");
    check((splitCollection?.features ?? []).length > 0, "分幅结果应有要素");
    check(splitCollection?.features.some((feature) => typeof feature.properties._sheet === "string") === true, "分幅结果应带 _sheet 字段");
    console.log("ok simplify/分组统计/重分类/质量检查/分幅行为正确");

    // ---- 4. 全部能力都写 OperationRecord。
    for (const operation of CAPABILITY_OPERATIONS) {
      const outcome = await executeGisOperation(stack.service, {
        entry: "map",
        operation,
        root,
        policy: { writeKnowledge: false },
        layerId: square.layer.layerId,
        layerName: square.layer.layerName,
        ...(operation === "distance" || operation === "nearest" || operation === "merge"
          || operation === "split-line" || operation === "split-polygon" || operation === "spatial-aggregate"
          || operation === "distance-matrix" || operation === "nearest-exact"
          ? { otherLayerId: secondSquare.layer.layerId, otherLayerName: secondSquare.layer.layerName }
          : {}),
        ...(operation === "convert" ? { target: "line" } : {}),
        ...(operation === "simplify" ? { tolerance: 100 } : {}),
        ...(operation === "group-stats" ? { groupField: "name", fieldName: "name" } : {}),
        ...(operation === "reclassify" ? { fieldName: "name", mapping: "甲=乙" } : {}),
        ...(operation === "split-grid" ? { columns: 1, rows: 1 } : {}),
      });
      const record = await readOperationRecord(outcome.operationId, root);
      check(record !== null, `${operation} 应写操作记录`);
      check(record?.operation === operation, `${operation} 的记录族属不对`);
      check((record?.request.layerIds.length ?? 0) > 0, `${operation} 的记录应带输入图层`);
    }
    console.log("ok 全部能力都写 OperationRecord");

    // ---- 5. 契约一致性。
    const manifested = new Set(CAPABILITY_MANIFEST.map((entry) => entry.tool));
    for (const name of ["map.area", "map.length", "map.distance", "map.nearest", "map.convert", "map.dissolve", "map.merge", "map.simplify", "map.groupStats", "map.reclassify", "map.qualityCheck", "map.splitByGrid", "map.splitLine", "map.explode", "map.vertices", "map.lineIntersect", "map.transform", "map.nearestOnLine", "map.grid", "map.splitPolygon", "map.spatialAggregate", "map.distanceMatrix", "map.nearestExact", "map.calculateField", "map.join", "map.rasterCast", "map.rasterNoData", "map.rasterSmooth", "map.interpolate", "map.erase", "map.union", "map.spatialJoin", "map.viewshed", "map.rasterClip", "map.polygonize", "map.rasterize", "map.zonal", "map.resample", "map.rasterIndex", "map.focal", "map.quadtree", "map.chart", "map.kernelDensity", "map.snapToNetwork", "map.networkDistance", "map.serviceArea", "map.aggregateGrid", "map.exportMap", "map.offsetLine", "map.costCorridor", "map.classify", "map.hotspot", "map.gwr", "map.odFlow", "map.kAnonymize", "map.dpGrid", "map.kriging", "map.watershed", "map.profile", "map.cutFill", "map.waterLevel", "map.layerStack", "map.geologyInputs"]) {
      check(GIS_TOOL_REGISTRY.some((tool) => tool.name === name), `${name} 不在注册表`);
      check(manifested.has(name), `${name} 未登记到 CAPABILITY_MANIFEST`);
    }
    for (const operation of CAPABILITY_OPERATIONS) {
      check(AUDIT_REQUIRED_OPERATIONS.includes(operation), `${operation} 不在留痕覆盖清单`);
    }
    console.log("ok 注册表 / 能力清单 / 留痕清单一致");

    console.log("v087-capability-check passed");
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
if (failed) throw new Error("v087-capability-check failed");
