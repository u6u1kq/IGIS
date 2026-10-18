// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GisIoReadError, routeGisRead } from "@igis/gis-io";
import { InMemoryProvenanceLedger } from "@igis/provenance";
import { createOpenFileGdbReader } from "./openfilegdb.js";
import { createGdalWasmReadPort, probeGdalDrivers } from "./port.js";

function geoTiffBytes(): Uint8Array {
  const entries: readonly (readonly [number, number, number, number])[] = [
    [256, 4, 1, 1],
    [257, 4, 1, 1],
    [258, 3, 1, 8],
    [259, 3, 1, 1],
    [262, 3, 1, 1],
    [273, 4, 1, 0],
    [277, 3, 1, 1],
    [278, 4, 1, 1],
    [279, 4, 1, 1],
    [284, 3, 1, 1],
    [33550, 12, 3, 0],
    [33922, 12, 6, 0],
    [34735, 3, 16, 0],
  ];
  const ifdStart = 8;
  const afterIfd = ifdStart + 2 + entries.length * 12 + 4;
  const scaleOffset = afterIfd;
  const tieOffset = scaleOffset + 24;
  const keyOffset = tieOffset + 48;
  const pixelOffset = keyOffset + 32;
  const bytes = new Uint8Array(pixelOffset + 1);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x49;
  bytes[1] = 0x49;
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdStart, true);
  view.setUint16(ifdStart, entries.length, true);
  const offsets: Readonly<Record<number, number>> = {
    273: pixelOffset,
    33550: scaleOffset,
    33922: tieOffset,
    34735: keyOffset,
  };
  entries.forEach((entry, index) => {
    const at = ifdStart + 2 + index * 12;
    const tag = entry[0];
    const type = entry[1];
    const count = entry[2];
    const value = entry[3];
    view.setUint16(at, tag, true);
    view.setUint16(at + 2, type, true);
    view.setUint32(at + 4, count, true);
    view.setUint32(at + 8, offsets[tag] ?? value, true);
  });
  view.setFloat64(scaleOffset, 1, true);
  view.setFloat64(scaleOffset + 8, 1, true);
  view.setFloat64(scaleOffset + 16, 0, true);
  for (let index = 0; index < 6; index += 1) view.setFloat64(tieOffset + index * 8, 0, true);
  const keys = [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326];
  keys.forEach((value, index) => view.setUint16(keyOffset + index * 2, value, true));
  const pixel = bytes[pixelOffset];
  if (pixel === undefined) throw new Error("合成 GeoTIFF 越界。");
  bytes[pixelOffset] = 7;
  return bytes;
}

function pointShapefile(): { readonly shp: Uint8Array; readonly shx: Uint8Array; readonly dbf: Uint8Array; readonly prj: Uint8Array } {
  const x = 1.5;
  const y = 2.5;
  const shp = new Uint8Array(128);
  const shpView = new DataView(shp.buffer);
  shpView.setInt32(0, 9994, false);
  shpView.setInt32(24, 64, false);
  shpView.setInt32(28, 1000, true);
  shpView.setInt32(32, 1, true);
  shpView.setFloat64(36, x, true);
  shpView.setFloat64(44, y, true);
  shpView.setFloat64(52, x, true);
  shpView.setFloat64(60, y, true);
  shpView.setInt32(100, 1, false);
  shpView.setInt32(104, 10, false);
  shpView.setInt32(108, 1, true);
  shpView.setFloat64(112, x, true);
  shpView.setFloat64(120, y, true);
  const shx = new Uint8Array(108);
  const shxView = new DataView(shx.buffer);
  shxView.setInt32(0, 9994, false);
  shxView.setInt32(24, 54, false);
  shxView.setInt32(28, 1000, true);
  shxView.setInt32(32, 1, true);
  shxView.setFloat64(36, x, true);
  shxView.setFloat64(44, y, true);
  shxView.setFloat64(52, x, true);
  shxView.setFloat64(60, y, true);
  shxView.setInt32(100, 50, false);
  shxView.setInt32(104, 10, false);
  const headerLength = 65;
  const recordLength = 9;
  const dbf = new Uint8Array(headerLength + recordLength + 1);
  dbf[0] = 3;
  dbf[1] = 26;
  dbf[2] = 10;
  dbf[3] = 2;
  const dbfView = new DataView(dbf.buffer);
  dbfView.setUint32(4, 1, true);
  dbfView.setUint16(8, headerLength, true);
  dbfView.setUint16(10, recordLength, true);
  const fieldName = "name";
  for (let index = 0; index < fieldName.length; index += 1) dbf[32 + index] = fieldName.charCodeAt(index);
  dbf[43] = "C".charCodeAt(0);
  dbf[48] = 8;
  dbf[64] = 0x0d;
  dbf[65] = 0x20;
  const value = "synthetic";
  for (let index = 0; index < value.length; index += 1) dbf[66 + index] = value.charCodeAt(index);
  dbf[dbf.length - 1] = 0x1a;
  const prj = new TextEncoder().encode(
    'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]',
  );
  return { shp, shx, dbf, prj };
}

/**
 * 用合成的 1×1 GeoTIFF 和一个点 shapefile 做只读自检。
 * 不连接真实行政区划。无效 .gdb 必须失败，不能返回假图层。
 * 导入本包不会自动执行。
 */
export async function runGdalWasmSelfCheck(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const tifPath = join(directory, "sample.tif");
  const shpPath = join(directory, "sample.shp");
  const tifBytes = geoTiffBytes();
  const shape = pointShapefile();
  await writeFile(tifPath, tifBytes);
  await writeFile(shpPath, shape.shp);
  await writeFile(join(directory, "sample.shx"), shape.shx);
  await writeFile(join(directory, "sample.dbf"), shape.dbf);
  await writeFile(join(directory, "sample.prj"), shape.prj);
  const gdbDir = join(directory, "empty.gdb");
  await mkdir(gdbDir, { recursive: true });
  await writeFile(join(gdbDir, "gdb"), new TextEncoder().encode("not-a-gdb"));
  const drivers = await probeGdalDrivers();
  if (!drivers.gTiff || !drivers.shapefile) {
    throw new Error("GTiff 或 ESRI Shapefile 不在该预编译包中，自检不能假装读取成功。");
  }
  if (drivers.fileGdbSdk) throw new Error("FileGDB SDK 驱动不应出现在这个只读构建中。");
  const port = await createGdalWasmReadPort();
  const ledger = new InMemoryProvenanceLedger({ persistJson: true, directory: join(directory, "ledger") });
  const tif = await routeGisRead({ gdalWasm: port }, { absolutePath: tifPath, layerName: null }, ledger);
  const tifLayer = tif.metadata[0];
  if (!tifLayer || tifLayer.geometryType !== "raster" || tifLayer.width !== 1 || tifLayer.height !== 1 || tifLayer.bandCount !== 1) {
    throw new Error("GeoTIFF 元数据不正确。");
  }
  if (!tifLayer.crs.includes("4326")) throw new Error("GeoTIFF 坐标系没有读出来。");
  const afterTif = await readFile(tifPath);
  if (afterTif.byteLength !== tifBytes.byteLength || afterTif[afterTif.byteLength - 1] !== tifBytes[tifBytes.byteLength - 1]) {
    throw new Error("只读打开改写了源文件。");
  }
  const shp = await routeGisRead({ gdalWasm: port }, { absolutePath: shpPath, layerName: null }, ledger);
  const shpLayer = shp.metadata.find((layer) => layer.geometryType === "point");
  if (!shpLayer || shpLayer.featureCount !== 1 || !shpLayer.crs.includes("WGS 84")) {
    throw new Error("shapefile 要素信息或坐标系不正确。");
  }
  const field = shpLayer.fields[0];
  if (!field || field.name !== "name" || field.fieldType !== "OFTString") throw new Error("shapefile 字段信息不正确。");
  const records = await ledger.list();
  const saved = JSON.stringify(records);
  if (/"extent"|"coordinates"|"wkt"/.test(saved) || /(?<![0-9])1\.5(?![0-9])/.test(saved)) {
    throw new Error("来源账本写入了范围或坐标。");
  }
  if (records.some((record) => record.readOnly !== true || record.exportPath !== null)) {
    throw new Error("只读账本标记不正确。");
  }
  let gdbFailed = false;
  try {
    await routeGisRead({ gdalWasm: port }, { absolutePath: gdbDir, layerName: null }, ledger);
  } catch (error) {
    gdbFailed = error instanceof GisIoReadError;
  }
  if (!gdbFailed) throw new Error("无效 FileGDB 被当成读取成功。");
  if (drivers.openFileGdb) {
    const reader = await createOpenFileGdbReader();
    let readerFailed = false;
    try {
      await reader.open(gdbDir);
    } catch (error) {
      readerFailed = error instanceof GisIoReadError;
    }
    if (!readerFailed) throw new Error("OpenFileGDB 读取器对无效 gdb 返回了成功。");
  }
  await rm(directory, { recursive: true, force: true });
}
