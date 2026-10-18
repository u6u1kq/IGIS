// SPDX-License-Identifier: Apache-2.0

/**
 * V0.89.8：双方都未声明时距离按坐标单位放行；折点转点；环境句子按种类给出。
 * 运行：npx tsx --tsconfig tsconfig.json apps/cli/src/v0898-check.ts
 */

import { planCrsExecution, verticesToPoints } from "@igis/spatial-ops";
import { identifyCrs, unknownCrs } from "@igis/surtgis";
import { environmentSummary, tsxEnvironmentItem } from "./environment-check.js";

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

const unknown = { identity: unknownCrs(), wkt: null };
const known = { identity: identifyCrs("EPSG:4326"), wkt: null };

const distance = planCrsExecution([unknown, unknown], true, "distance");
check(distance.allow === true && distance.coordinateUnits === true && distance.planarUnitToMeter === 1, "双方未声明时距离应按坐标原值放行");

const nearest = planCrsExecution([unknown, unknown], true, "nearest");
check(nearest.allow === true && nearest.coordinateUnits === true, "双方未声明时最近距离应放行");

const matrix = planCrsExecution([unknown, unknown], true, "distance-matrix");
check(matrix.allow === true && matrix.coordinateUnits === true, "双方未声明时距离矩阵应放行");

const exact = planCrsExecution([unknown, unknown], true, "nearest-exact");
check(exact.allow === true && exact.coordinateUnits === true, "双方未声明时精确最近应放行");

const mixed = planCrsExecution([unknown, known], true, "distance");
check(mixed.allow === false, "一边有坐标系、一边没有时距离仍应拒绝");

const buffer = planCrsExecution([unknown], true, "buffer");
check(buffer.allow === false, "未声明坐标系的缓冲仍应拒绝");

const vertices = planCrsExecution([unknown], true, "vertices");
check(vertices.allow === true && vertices.coordinateUnits !== true, "未声明坐标系上的折点转点应放行且不标成距离单位");

const points = verticesToPoints({
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    properties: { Id: 1 },
    geometry: { type: "LineString", coordinates: [[0, 0], [3, 4]] },
  }],
});
check(points.collection.features.length === 2, "线的两个节点应变成两个点");
check(points.collection.features.every((feature) => feature.geometry?.type === "Point"), "折点转点的结果应是点");

const devTsx = tsxEnvironmentItem(false, false);
check(devTsx.ok === true && devTsx.required === false, "开发启动缺少仓库内 tsx 不应算故障");
const packagedTsx = tsxEnvironmentItem(false, true);
check(packagedTsx.ok === false && packagedTsx.message.includes("缺少 node_modules/tsx/package.json"), "目录包缺少 tsx 应写出缺少和安装依赖");
const summary = environmentSummary([devTsx, packagedTsx, { name: "osgeo", required: false, ok: false, message: "缺少本机 Python/osgeo，只影响重投影。可等待托管 GDAL 环境，或在设置里填写可用的 Python。" }]);
const osgeoLine = summary[1] ?? "";
check(summary.length === 2 && summary[0] === packagedTsx.message && osgeoLine.includes("只影响重投影"), "环境摘要只保留未通过项，并带上怎么处理");

console.log("v0898-check passed");
