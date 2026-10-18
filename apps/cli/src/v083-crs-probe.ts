// SPDX-License-Identifier: Apache-2.0

/**
 * V0.83 CRS 探测（T0）。回答五个问题：
 * 1. GDALGetProjectionRef 对带 .prj 的矢量数据集返回什么
 * 2. OGR_L_GetSpatialRef + OSRExportToWkt 在 gdal-js@2.2.0 里能否绑定并取到图层 WKT
 * 3. proj4@2.15 能否直接吃 WKT 做双向变换，环回精度多少
 * 4. 无 towgs84 的北京54变换等于"不做基准移动"（静默误差机制），量级多少；datum_params 能否从 proj4 读出
 * 5. aeqd 局部投影的米制精度（对比 turf 的度线性换算误差）
 * 只用操作系统临时目录，不读仓库 var/，不监听端口。探测结论写入 V0.83 dev-log。
 * 运行：npx tsx --tsconfig tsconfig.json apps/cli/src/v083-crs-probe.ts
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import proj4 from "proj4";

const WKT_4326 = 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]]';

const WKT_32650 = 'PROJCS["WGS 84 / UTM zone 50N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",117],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Easting",EAST],AXIS["Northing",NORTH],AUTHORITY["EPSG","32650"]]';

// 探测夹具：北京54椭球（Krasovsky）。区域参数仅作演示，不影响基准结论。
const WKT_BJ54_NO_TOWGS84 = 'PROJCS["Beijing 1954 / GK CM 117E (probe)",GEOGCS["Beijing 1954",DATUM["Beijing_1954",SPHEROID["Krasovsky_1940",6378245,298.3,AUTHORITY["EPSG","7024"]],AUTHORITY["EPSG","6214"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4214"]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",117],PARAMETER["scale_factor",1],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Easting",EAST],AXIS["Northing",NORTH],AUTHORITY["EPSG","21453"]]';

const WKT_BJ54_TOWGS84 = 'PROJCS["Beijing 1954 / GK CM 117E (probe, towgs84)",GEOGCS["Beijing 1954",DATUM["Beijing_1954",SPHEROID["Krasovsky_1940",6378245,298.3,AUTHORITY["EPSG","7024"]],TOWGS84[-157.89,17.16,78.41],AUTHORITY["EPSG","6214"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4214"]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",117],PARAMETER["scale_factor",1],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Easting",EAST],AXIS["Northing",NORTH],AUTHORITY["EPSG","21453"]]';

const WKT_CGCS2000 = 'GEOGCS["China Geodetic Coordinate System 2000",DATUM["China_2000",SPHEROID["CGCS2000",6378137,298.257222101,AUTHORITY["EPSG","1023"]],AUTHORITY["EPSG","1043"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4490"]]';

function asciiBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code > 127) throw new Error("探测 WKT 必须是纯 ASCII。");
    bytes[index] = code;
  }
  return bytes;
}

/** 最小 Point shapefile（无 dbf）。探测专用，生产代码不使用。 */
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

interface ProbeModule {
  calledRun?: boolean;
  onRuntimeInitialized?: () => void;
  FS_createPath(parent: string, path: string, canRead: boolean, canWrite: boolean): void;
  FS_createDataFile(parent: string, name: string, data: Uint8Array, canRead: boolean, canWrite: boolean, canOwn: boolean): void;
  FS_unlink(path: string): void;
  cwrap(name: string, returnType: string | null, args: readonly string[]): (...args: readonly unknown[]) => unknown;
  getValue(pointer: number, type: string): number;
}

async function loadGdalModule(): Promise<ProbeModule> {
  const proc = (globalThis as { process?: { cwd(): string; chdir(directory: string): void } }).process;
  if (!proc || typeof proc.chdir !== "function") throw new Error("探测需要 Node。");
  const nodeRequire = createRequire(import.meta.url);
  const packageJson = nodeRequire.resolve("gdal-js/package.json");
  const previous = proc.cwd();
  proc.chdir(dirname(packageJson));
  try {
    const module = nodeRequire("gdal-js") as ProbeModule;
    if (module.calledRun !== true) {
      await new Promise<void>((resolve, reject) => {
        module.onRuntimeInitialized = () => resolve();
        setTimeout(() => reject(new Error("gdal-js 初始化超时。")), 30000);
      });
    }
    return module;
  } finally {
    proc.chdir(previous);
  }
}

function asNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} 没有返回数值。`);
  return value;
}

async function probeGdal(): Promise<void> {
  const module = await loadGdalModule();
  const dir = "/igis-probe";
  module.FS_createPath("/", "igis-probe", true, true);
  const { shp, shx } = pointShapefile([[500000, 0], [500000, 4410000]]);
  module.FS_createDataFile(dir, "probe.shp", shp, true, false, true);
  module.FS_createDataFile(dir, "probe.shx", shx, true, false, true);
  module.FS_createDataFile(dir, "probe.prj", asciiBytes(WKT_32650), true, false, true);
  const allRegister = module.cwrap("GDALAllRegister", null, []);
  allRegister();
  const openEx = module.cwrap("GDALOpenEx", "number", ["string", "number", "number", "number", "number"]);
  const dataset = asNumber(openEx(`${dir}/probe.shp`, 0x02 | 0x04 | 0x40, 0, 0, 0), "GDALOpenEx");
  if (dataset === 0) throw new Error("探测夹具打开失败，后续结论无效。");
  try {
    const projectionRef = module.cwrap("GDALGetProjectionRef", "string", ["number"]);
    const ref = String(projectionRef(dataset));
    console.log(`[1] GDALGetProjectionRef(矢量+prj) => ${ref === "" ? "(空字符串)" : `${ref.slice(0, 90)}… (len=${ref.length})`}`);
    const getLayer = module.cwrap("GDALDatasetGetLayer", "number", ["number", "number"]);
    const layer = asNumber(getLayer(dataset, 0), "GDALDatasetGetLayer");
    const layerName = String(module.cwrap("OGR_L_GetName", "string", ["number"])(layer));
    module.cwrap("OGR_L_ResetReading", null, ["number"])(layer);
    const feature = asNumber(module.cwrap("OGR_L_GetNextFeature", "number", ["number"])(layer), "OGR_L_GetNextFeature");
    const geometry = asNumber(module.cwrap("OGR_F_GetGeometryRef", "number", ["number", "number"])(feature), "OGR_F_GetGeometryRef");
    const geojson = String(module.cwrap("OGR_G_ExportToJson", "string", ["number"])(geometry));
    console.log(`[1b] 夹具有效：图层 ${layerName}，首要素 ${geojson}`);
    try {
      const srs = asNumber(module.cwrap("OGR_L_GetSpatialRef", "number", ["number"])(layer), "OGR_L_GetSpatialRef");
      if (srs === 0) {
        console.log("[2] OGR_L_GetSpatialRef => NULL");
      } else {
        const malloc = module.cwrap("malloc", "number", ["number"]);
        const free = module.cwrap("free", null, ["number"]);
        const ptrPtr = asNumber(malloc(4), "malloc");
        const code = asNumber(module.cwrap("OSRExportToWkt", "number", ["number", "number"])(srs, ptrPtr), "OSRExportToWkt");
        const strPtr = module.getValue(ptrPtr, "i32");
        let wkt = "";
        for (let index = 0; index < 200000; index += 1) {
          const byte = module.getValue(strPtr + index, "i8");
          if (byte === 0) break;
          wkt += String.fromCharCode(byte);
        }
        free(ptrPtr);
        console.log(`[2] OGR_L_GetSpatialRef+OSRExportToWkt => err=${code} len=${wkt.length} ${wkt.slice(0, 90)}…`);
        if (wkt.length === 0) throw new Error("OSRExportToWkt 返回空 WKT。");
      }
    } catch (error) {
      console.log(`[2] OGR_L_GetSpatialRef 绑定/调用失败：${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    module.cwrap("GDALClose", null, ["number"])(dataset);
    for (const name of ["probe.shp", "probe.shx", "probe.prj"]) {
      try {
        module.FS_unlink(`${dir}/${name}`);
      } catch {
        // 探测进程短命，虚拟文件残留无影响。
      }
    }
  }
}

function probeProj4(): void {
  const geographic = "+proj=longlat +datum=WGS84 +no_defs";
  proj4.defs("EPSG:4326", geographic);
  const forward = proj4(WKT_32650, "EPSG:4326", [500000, 0]);
  console.log(`[3] WKT 32650 (500000,0) -> 4326 = [${forward[0]?.toFixed(8)}, ${forward[1]?.toFixed(8)}]（期望 lon≈117, lat≈0）`);
  if (Math.abs((forward[0] ?? 0) - 117) > 0.001 || Math.abs(forward[1] ?? 0) > 0.001) throw new Error("WKT 前向变换偏离解析真值。");
  const back = proj4("EPSG:4326", WKT_32650, [forward[0] ?? 0, forward[1] ?? 1]);
  console.log(`[3b] 环回误差 ≈ ${Math.hypot((back[0] ?? 0) - 500000, (back[1] ?? 0) - 0).toFixed(4)} 米`);
  const f2 = proj4(WKT_32650, "EPSG:4326", [500000, 4410000]);
  const b2 = proj4("EPSG:4326", WKT_32650, [f2[0] ?? 0, f2[1] ?? 0]);
  console.log(`[3c] (500000,4410000) -> [${f2[0]?.toFixed(6)}, ${f2[1]?.toFixed(6)}]，环回误差 ≈ ${Math.hypot((b2[0] ?? 0) - 500000, (b2[1] ?? 0) - 4410000).toFixed(4)} 米`);

  const noShift = proj4(WKT_BJ54_NO_TOWGS84, "EPSG:4326", [500000, 4410000]);
  const shifted = proj4(WKT_BJ54_TOWGS84, "EPSG:4326", [500000, 4410000]);
  const deltaMeters = Math.hypot(
    ((shifted[0] ?? 0) - (noShift[0] ?? 0)) * 111320 * Math.cos((40 * Math.PI) / 180),
    ((shifted[1] ?? 0) - (noShift[1] ?? 0)) * 110540,
  );
  console.log(`[4] 北京54 无towgs84 => [${noShift[0]?.toFixed(6)}, ${noShift[1]?.toFixed(6)}]；有towgs84 => [${shifted[0]?.toFixed(6)}, ${shifted[1]?.toFixed(6)}]；位置差 ≈ ${deltaMeters.toFixed(1)} 米（静默误差量级）`);

  const projLib = proj4 as unknown as { Proj(definition: string): { datum_params?: number[]; datumCode?: string } };
  const parsedNo = projLib.Proj(WKT_BJ54_NO_TOWGS84);
  const parsedTowgs = projLib.Proj(WKT_BJ54_TOWGS84);
  const parsedCgcs = projLib.Proj(WKT_CGCS2000);
  console.log(`[4b] datum（无towgs84）: datumCode=${String(parsedNo.datumCode)} datum_params=${JSON.stringify(parsedNo.datum_params ?? null)}`);
  console.log(`[4b] datum（有towgs84）: datumCode=${String(parsedTowgs.datumCode)} datum_params=${JSON.stringify(parsedTowgs.datum_params ?? null)}`);
  console.log(`[4b] datum（CGCS2000）: datumCode=${String(parsedCgcs.datumCode)} datum_params=${JSON.stringify(parsedCgcs.datum_params ?? null)}`);

  const aeqd = "+proj=aeqd +lat_0=40 +lon_0=116 +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs";
  const center = proj4("EPSG:4326", aeqd, [116, 40]);
  const east = proj4("EPSG:4326", aeqd, [116.01, 40]);
  const dxMeters = (east[0] ?? 0) - (center[0] ?? 0);
  const truth = 0.01 * 111320 * Math.cos((40 * Math.PI) / 180);
  console.log(`[5] aeqd 东西 0.01°：地面真值 ≈ ${truth.toFixed(1)} 米，aeqd 平面 dx = ${dxMeters.toFixed(1)} 米，turf 度换算会当成 ${(0.01 * 111195).toFixed(1)} 米`);
  const round = proj4(aeqd, "EPSG:4326", [center[0] ?? 0, center[1] ?? 0]);
  console.log(`[5b] aeqd 环回误差 ≈ ${Math.hypot((round[0] ?? 0) - 116, (round[1] ?? 0) - 40).toExponential(2)} 度`);
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "igis-v083-probe-"));
  try {
    console.log("=== proj4（纯 JS，无 GDAL）===");
    probeProj4();
    console.log("=== gdal-js 2.2.0 运行时 ===");
    await probeGdal();
    console.log("v083-crs-probe 完成。");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
