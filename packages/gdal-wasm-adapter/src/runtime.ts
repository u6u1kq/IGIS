// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { dirname } from "node:path";
import { GisIoReadError } from "@igis/gis-io";

/** 预编译包。GEOS 未链入。写入类符号不允许绑定。 */
export const GDAL_JS_PACKAGE = "gdal-js";
export const GDAL_JS_VERSION = "2.2.0";

/** 只读打开。不设置 GDAL_OF_UPDATE。 */
export const GDAL_OPEN_FLAGS = 0x02 | 0x04 | 0x40;

const DENIED_SYMBOLS = new Set([
  "GDALCreate",
  "GDALCreateCopy",
  "GDALWriteBlock",
  "GDALSetProjection",
  "GDALSetGeoTransform",
  "GDALTranslate",
  "GDALWarp",
  "GDALVectorTranslate",
  "GDALRasterize",
  "GDALDEMProcessing",
  "GDALBuildVRT",
  "GDALPolygonize",
  "GDALSieveFilter",
]);

export interface GdalDriverAvailability {
  readonly packageName: typeof GDAL_JS_PACKAGE;
  readonly packageVersion: typeof GDAL_JS_VERSION;
  readonly gTiff: boolean;
  readonly shapefile: boolean;
  readonly openFileGdb: boolean;
  readonly fileGdbSdk: boolean;
}

interface EmscriptenModule {
  calledRun?: boolean;
  onRuntimeInitialized?: () => void;
  onAbort?: (reason: unknown) => void;
  FS_createPath: (parent: string, path: string, canRead: boolean, canWrite: boolean) => void;
  FS_createDataFile: (
    parent: string,
    name: string,
    data: Uint8Array,
    canRead: boolean,
    canWrite: boolean,
    canOwn: boolean,
  ) => void;
  FS_unlink: (path: string) => void;
  cwrap: (name: string, returnType: string | null, args: readonly string[]) => (...args: readonly unknown[]) => unknown;
  getValue: (pointer: number, type: string) => number;
}

export interface GdalRuntime {
  readonly drivers: GdalDriverAvailability;
  createPath(parent: string, path: string): void;
  createDataFile(parent: string, name: string, data: Uint8Array): void;
  unlink(path: string): void;
  malloc(size: number): number;
  free(pointer: number): void;
  readDoubles(pointer: number, count: number): readonly number[];
  allRegister(): void;
  driverPointer(name: string): number;
  openEx(path: string): number;
  close(dataset: number): void;
  rasterWidth(dataset: number): number;
  rasterHeight(dataset: number): number;
  rasterBands(dataset: number): number;
  projection(dataset: number): string;
  geoTransform(dataset: number, buffer: number): number;
  layerCount(dataset: number): number;
  layer(dataset: number, index: number): number;
  layerName(layer: number): string;
  layerDefinition(layer: number): number;
  fieldCount(definition: number): number;
  fieldDefinition(definition: number, index: number): number;
  fieldName(field: number): string;
  fieldType(field: number): number;
  resetReading(layer: number): void;
  nextFeature(layer: number): number;
  featureGeometry(feature: number): number;
  geometryType(geometry: number): number;
  destroyFeature(feature: number): void;
  featureFieldAsString(feature: number, index: number): string;
  layerExtent(layer: number, buffer: number): number;
  resetError(): void;
  lastError(): string;
  /** 把单个几何导出成 GeoJSON 文本。只给地图用，不写入来源账本。 */
  geometryJson(geometry: number): string;
}

interface HostProcess {
  cwd(): string;
  chdir(directory: string): void;
}

function hostProcess(): HostProcess {
  const candidate = (globalThis as { process?: HostProcess }).process;
  if (!candidate || typeof candidate.cwd !== "function" || typeof candidate.chdir !== "function") {
    throw new GisIoReadError("gdal-wasm", "GDAL-WASM 预编译包需要在 Node 中加载。", "read-failed");
  }
  return candidate;
}

function asModule(value: unknown): EmscriptenModule {
  if (value === null || typeof value !== "object") {
    throw new GisIoReadError("gdal-wasm", "gdal-js 没有导出可用的运行时。", "read-failed");
  }
  return value as EmscriptenModule;
}

function asNumber(value: unknown, symbol: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new GisIoReadError("gdal-wasm", `${symbol} 返回了无法使用的数值。`, "read-failed");
  }
  return value;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * DBF 字段名/属性值按字节解码：先严格 UTF-8，再 GBK（中文 .dbf 常见），最后 Latin-1。
 * 不依赖 GDAL 的编码探测，避免乱码字段名进入图层库。
 */
function decodeDbfBytes(bytes: readonly number[]): string {
  const data = Uint8Array.from(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    // 不是合法 UTF-8。
  }
  try {
    return new TextDecoder("gbk", { fatal: true }).decode(data);
  } catch {
    // 不是合法 GBK。
  }
  return new TextDecoder("latin1").decode(data);
}

/** 读 C 字符串的原始字节再解码。返回 const char* 的接口都走这里。 */
function readCString(module: EmscriptenModule, pointer: number): string {
  if (!pointer) return "";
  const bytes: number[] = [];
  for (let offset = 0; offset < 1_000_000; offset += 1) {
    const byte = module.getValue(pointer + offset, "i8") & 0xff;
    if (byte === 0) break;
    bytes.push(byte);
  }
  return decodeDbfBytes(bytes);
}

function bind(
  module: EmscriptenModule,
  name: string,
  returnType: string | null,
  args: readonly string[],
): (...params: readonly unknown[]) => unknown {
  if (DENIED_SYMBOLS.has(name)) {
    throw new GisIoReadError("gdal-wasm", `拒绝绑定 GDAL 写入符号 ${name}。`, "read-failed");
  }
  return module.cwrap(name, returnType, args);
}

function waitUntilReady(module: EmscriptenModule): Promise<void> {
  if (module.calledRun === true && typeof module.FS_createDataFile === "function") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const previous = module.onRuntimeInitialized;
    module.onRuntimeInitialized = () => {
      if (previous) previous();
      resolve();
    };
    module.onAbort = (reason: unknown) => {
      const detail = typeof reason === "string" ? reason : "GDAL-WASM 初始化失败。";
      reject(new GisIoReadError("gdal-wasm", detail, "read-failed"));
    };
  });
}

function wrap(module: EmscriptenModule): GdalRuntime {
  const allRegister = bind(module, "GDALAllRegister", null, []);
  const driverByName = bind(module, "GDALGetDriverByName", "number", ["string"]);
  const openEx = bind(module, "GDALOpenEx", "number", ["string", "number", "number", "number", "number"]);
  const close = bind(module, "GDALClose", null, ["number"]);
  const rasterWidth = bind(module, "GDALGetRasterXSize", "number", ["number"]);
  const rasterHeight = bind(module, "GDALGetRasterYSize", "number", ["number"]);
  const rasterBands = bind(module, "GDALGetRasterCount", "number", ["number"]);
  const projection = bind(module, "GDALGetProjectionRef", "string", ["number"]);
  const geoTransform = bind(module, "GDALGetGeoTransform", "number", ["number", "number"]);
  const layerCount = bind(module, "GDALDatasetGetLayerCount", "number", ["number"]);
  const layer = bind(module, "GDALDatasetGetLayer", "number", ["number", "number"]);
  const layerName = bind(module, "OGR_L_GetName", "number", ["number"]);
  const layerDefinition = bind(module, "OGR_L_GetLayerDefn", "number", ["number"]);
  const fieldCount = bind(module, "OGR_FD_GetFieldCount", "number", ["number"]);
  const fieldDefinition = bind(module, "OGR_FD_GetFieldDefn", "number", ["number", "number"]);
  const fieldName = bind(module, "OGR_Fld_GetNameRef", "number", ["number"]);
  const fieldType = bind(module, "OGR_Fld_GetType", "number", ["number"]);
  const resetReading = bind(module, "OGR_L_ResetReading", null, ["number"]);
  const nextFeature = bind(module, "OGR_L_GetNextFeature", "number", ["number"]);
  const featureGeometry = bind(module, "OGR_F_GetGeometryRef", "number", ["number"]);
  const geometryType = bind(module, "OGR_G_GetGeometryType", "number", ["number"]);
  const destroyFeature = bind(module, "OGR_F_Destroy", null, ["number"]);
  const featureFieldAsString = bind(module, "OGR_F_GetFieldAsString", "number", ["number", "number"]);
  const layerExtent = bind(module, "OGR_L_GetExtent", "number", ["number", "number", "number"]);
  const resetError = bind(module, "CPLErrorReset", null, []);
  const lastError = bind(module, "CPLGetLastErrorMsg", "string", []);
  const malloc = bind(module, "malloc", "number", ["number"]);
  const free = bind(module, "free", null, ["number"]);
  let exportGeometryJson: ((geometry: number) => unknown) | null = null;
  allRegister();
  const drivers: GdalDriverAvailability = {
    packageName: GDAL_JS_PACKAGE,
    packageVersion: GDAL_JS_VERSION,
    gTiff: asNumber(driverByName("GTiff"), "GTiff") !== 0,
    shapefile: asNumber(driverByName("ESRI Shapefile"), "ESRI Shapefile") !== 0,
    openFileGdb: asNumber(driverByName("OpenFileGDB"), "OpenFileGDB") !== 0,
    fileGdbSdk: asNumber(driverByName("FileGDB"), "FileGDB") !== 0,
  };
  return {
    drivers,
    createPath(parent: string, path: string): void {
      module.FS_createPath(parent, path, true, true);
    },
    createDataFile(parent: string, name: string, data: Uint8Array): void {
      module.FS_createDataFile(parent, name, data, true, false, true);
    },
    unlink(path: string): void {
      module.FS_unlink(path);
    },
    malloc(size: number): number {
      return asNumber(malloc(size), "malloc");
    },
    free(pointer: number): void {
      free(pointer);
    },
    readDoubles(pointer: number, count: number): readonly number[] {
      const values: number[] = [];
      for (let index = 0; index < count; index += 1) {
        values.push(module.getValue(pointer + index * 8, "double"));
      }
      return values;
    },
    allRegister(): void {
      allRegister();
    },
    driverPointer(name: string): number {
      return asNumber(driverByName(name), name);
    },
    openEx(path: string): number {
      return asNumber(openEx(path, GDAL_OPEN_FLAGS, 0, 0, 0), "GDALOpenEx");
    },
    close(dataset: number): void {
      close(dataset);
    },
    rasterWidth(dataset: number): number {
      return asNumber(rasterWidth(dataset), "GDALGetRasterXSize");
    },
    rasterHeight(dataset: number): number {
      return asNumber(rasterHeight(dataset), "GDALGetRasterYSize");
    },
    rasterBands(dataset: number): number {
      return asNumber(rasterBands(dataset), "GDALGetRasterCount");
    },
    projection(dataset: number): string {
      return asText(projection(dataset));
    },
    geoTransform(dataset: number, buffer: number): number {
      return asNumber(geoTransform(dataset, buffer), "GDALGetGeoTransform");
    },
    layerCount(dataset: number): number {
      return asNumber(layerCount(dataset), "GDALDatasetGetLayerCount");
    },
    layer(dataset: number, index: number): number {
      return asNumber(layer(dataset, index), "GDALDatasetGetLayer");
    },
    layerName(layerPointer: number): string {
      return readCString(module, layerName(layerPointer) as number);
    },
    layerDefinition(layerPointer: number): number {
      return asNumber(layerDefinition(layerPointer), "OGR_L_GetLayerDefn");
    },
    fieldCount(definition: number): number {
      return asNumber(fieldCount(definition), "OGR_FD_GetFieldCount");
    },
    fieldDefinition(definition: number, index: number): number {
      return asNumber(fieldDefinition(definition, index), "OGR_FD_GetFieldDefn");
    },
    fieldName(field: number): string {
      return readCString(module, fieldName(field) as number);
    },
    fieldType(field: number): number {
      return asNumber(fieldType(field), "OGR_Fld_GetType");
    },
    resetReading(layerPointer: number): void {
      resetReading(layerPointer);
    },
    nextFeature(layerPointer: number): number {
      return asNumber(nextFeature(layerPointer), "OGR_L_GetNextFeature");
    },
    featureGeometry(feature: number): number {
      return asNumber(featureGeometry(feature), "OGR_F_GetGeometryRef");
    },
    geometryType(geometry: number): number {
      return asNumber(geometryType(geometry), "OGR_G_GetGeometryType");
    },
    destroyFeature(feature: number): void {
      destroyFeature(feature);
    },
    featureFieldAsString(feature: number, index: number): string {
      return readCString(module, featureFieldAsString(feature, index) as number);
    },
    layerExtent(layerPointer: number, buffer: number): number {
      return asNumber(layerExtent(layerPointer, buffer, 1), "OGR_L_GetExtent");
    },
    resetError(): void {
      resetError();
    },
    lastError(): string {
      return asText(lastError());
    },
    geometryJson(geometry: number): string {
      if (geometry === 0) return "";
      try {
        if (!exportGeometryJson) {
          exportGeometryJson = bind(module, "OGR_G_ExportToJson", "string", ["number"]);
        }
        const text = asText(exportGeometryJson(geometry)).trim();
        if (text === "") {
          throw new GisIoReadError("gdal-wasm", "几何导出为空。", "read-failed");
        }
        return text;
      } catch (error) {
        if (error instanceof GisIoReadError) throw error;
        throw new GisIoReadError("gdal-wasm", "该要素几何无法导出。", "read-failed");
      }
    },
  };
}

let loading: Promise<GdalRuntime> | null = null;

/** 加载 gdal-js。数据文件从其包目录读取，完成后恢复原来的工作目录。 */
export function loadGdalRuntime(): Promise<GdalRuntime> {
  if (!loading) {
    loading = (async () => {
      const proc = hostProcess();
      const nodeRequire = createRequire(import.meta.url);
      const packageJson = nodeRequire.resolve(`${GDAL_JS_PACKAGE}/package.json`);
      const previous = proc.cwd();
      proc.chdir(dirname(packageJson));
      try {
        const module = asModule(nodeRequire(GDAL_JS_PACKAGE));
        await waitUntilReady(module);
        return wrap(module);
      } finally {
        proc.chdir(previous);
      }
    })();
  }
  return loading;
}
