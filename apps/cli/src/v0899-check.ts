// SPDX-License-Identifier: Apache-2.0

/**
 * V0.89.9：线交点、原坐标变换、垂足、格网，以及分组统计写出最小值。
 * 运行：npx tsx --tsconfig tsconfig.json apps/cli/src/v0899-check.ts
 */

import { gridFeatures, groupStatsFeatures, lineIntersectFeatures, nearestOnLineFeatures, planCrsExecution, transformFeatures } from "@igis/spatial-ops";
import { identifyCrs, unknownCrs } from "@igis/surtgis";

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

const line = {
  type: "FeatureCollection" as const,
  features: [{
    type: "Feature" as const,
    properties: {},
    geometry: { type: "LineString" as const, coordinates: [[0, 0], [2, 2]] },
  }],
};
const cross = {
  type: "FeatureCollection" as const,
  features: [{
    type: "Feature" as const,
    properties: {},
    geometry: { type: "LineString" as const, coordinates: [[0, 2], [2, 0]] },
  }],
};
const hits = lineIntersectFeatures(line, cross);
check(hits.collection.features.length === 1, "两条交叉线应有 1 个交点");
const hit = hits.collection.features[0]?.geometry;
check(hit?.type === "Point" && hit.coordinates[0] === 1 && hit.coordinates[1] === 1, "交点应在 (1,1)");

const square = {
  type: "FeatureCollection" as const,
  features: [{
    type: "Feature" as const,
    properties: { name: "甲" },
    geometry: { type: "Polygon" as const, coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] },
  }],
};
const moved = transformFeatures(square, {
  kind: "translate",
  distance: 1,
  bearing: 90,
  angle: null,
  factor: null,
  distanceMode: "coordinate",
  unitToMeter: null,
});
const ring = moved.collection.features[0]?.geometry;
check(ring?.type === "Polygon" && ring.coordinates[0]?.[0]?.[0] === 1, "向东平移 1 个坐标单位后起点 x 应为 1");

const scaled = transformFeatures(square, {
  kind: "scale",
  distance: null,
  bearing: null,
  angle: null,
  factor: 2,
  distanceMode: "coordinate",
  unitToMeter: null,
});
check(scaled.collection.features.length === 1, "缩放应保留 1 个要素");

const points = {
  type: "FeatureCollection" as const,
  features: [{
    type: "Feature" as const,
    properties: { Id: 1 },
    geometry: { type: "Point" as const, coordinates: [0, 1] },
  }],
};
const feet = nearestOnLineFeatures(points, line, "coordinate", null);
check(feet.collection.features.length === 1, "点到线应得到 1 个垂足");
const dist = feet.collection.features[0]?.properties._dist;
check(dist === 0.71, `垂足距离应是坐标单位 0.71，实际 ${String(dist)}`);

const grid = gridFeatures(square, 1, "coordinate", null);
check(grid.collection.features.length === 4, "边长 1 的 2×2 范围应得到 4 个格子");

const grouped = groupStatsFeatures({
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { Id: "a", value: 3 }, geometry: { type: "Point", coordinates: [0, 0] } },
    { type: "Feature", properties: { Id: "a", value: 1 }, geometry: { type: "Point", coordinates: [1, 1] } },
  ],
}, "Id", "value");
check(grouped.rows[0]?.minimum === 1, "分组统计应算出最小值");

const unknown = { identity: unknownCrs(), wkt: null };
check(planCrsExecution([unknown], true, "grid").allow === true, "未声明坐标系上的格网应放行");
check(planCrsExecution([unknown, unknown], true, "nearest-on-line").coordinateUnits === true, "未声明坐标系上的垂足应按坐标单位");
check(planCrsExecution([{ identity: identifyCrs("EPSG:4326"), wkt: null }], true, "transform").targetEpsg === null, "变换应留在原坐标，不先变到工作坐标系");

console.log("v0899-check passed");
