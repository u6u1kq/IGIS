// SPDX-License-Identifier: Apache-2.0

/**
 * V0.89.5：米制投影平面上的缓冲放行；没有投影的局部坐标仍拒绝。
 * 运行：npx tsx --tsconfig tsconfig.json apps/cli/src/v0895-check.ts
 */

import { planCrsExecution } from "@igis/spatial-ops";
import { planarCrs } from "@igis/surtgis";

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

const projected = `PROJCS["Local",GEOGCS["GCS",DATUM["D",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",0],PARAMETER["False_Northing",0],PARAMETER["Central_Meridian",117],PARAMETER["Scale_Factor",1],PARAMETER["Latitude_Of_Origin",0],UNIT["metre",1]]`;
const localOnly = `LOCAL_CS["Engineering",LOCAL_DATUM["Site",10000],UNIT["metre",1],AXIS["Easting",EAST],AXIS["Northing",NORTH]]`;

const meterBuffer = planCrsExecution([{ identity: planarCrs(projected), wkt: projected }], true, "buffer");
check(meterBuffer.allow === true && meterBuffer.planarUnitToMeter === 1, "投影且单位为米时缓冲应放行");

const localBuffer = planCrsExecution([{ identity: planarCrs(localOnly), wkt: localOnly }], true, "buffer");
check(localBuffer.allow === false, "没有投影的局部坐标缓冲仍应拒绝");

const meterClip = planCrsExecution([{ identity: planarCrs(projected), wkt: projected }], true, "clip");
check(meterClip.allow === true, "投影且单位为米时裁剪应放行");

console.log("v0895-check passed");
