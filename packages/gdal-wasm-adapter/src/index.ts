// SPDX-License-Identifier: Apache-2.0

import type { GisBackendPlugin } from "@igis/gis-kernel";
import type { LayerSummary, MemoryRef } from "@igis/shared-types";
import { GDAL_JS_PACKAGE, GDAL_JS_VERSION } from "./runtime.js";

/**
 * 只读实现使用社区预编译包 gdal-js@2.2.0（MIT）。
 * GDAL 本体是 MIT/X。该构建未启用 GEOS。
 * wasm 留在 node_modules，不提交进版本库。
 * OpenFileGDB 若能打开，也只是逆向只读，并不与 ArcGIS Pro 等价。
 * 读失败由 @igis/gis-io 原样返回。本包不派生进程。
 */
export const GDAL_WASM_IMPLEMENTATION = `${GDAL_JS_PACKAGE}@${GDAL_JS_VERSION}` as const;

/** 版本已钉死。仓库源码不携带 wasm 二进制。 */
export const GDAL_BUILD = {
  status: "pinned",
  packageName: GDAL_JS_PACKAGE,
  resolvedVersion: GDAL_JS_VERSION,
  gdalUpstreamVersion: "2.4",
  license: "MIT",
  gdalLicense: "MIT/X",
  geosLinked: false,
  wasmBinary: "node_modules/gdal-js/gdal.wasm",
  includeWasmBinary: false,
  openFlags: ["GDAL_OF_READONLY"],
  forbidSpawn: true,
  openFileGdbDriver: "compiled-in",
  fileGdbSdkDriver: "absent",
} as const;

export interface GdalReadOnlyAdapter extends GisBackendPlugin {
  readonly id: "gdal-wasm";
  readonly kind: "io";
  readonly readOnly: true;
  readonly wasmBinaryBundled: false;
  toMemory(layer: LayerSummary, source: MemoryRef): Promise<MemoryRef>;
}

export type { GdalDriverAvailability } from "./runtime.js";
export type { GdalRuntime } from "./runtime.js";
export { GDAL_JS_PACKAGE, GDAL_JS_VERSION, GDAL_OPEN_FLAGS, loadGdalRuntime } from "./runtime.js";
export { createGdalWasmReadPort, probeGdalDrivers } from "./port.js";
export { SAMPLE_FEATURE_LIMIT, readGisSampleFeatures } from "./sample.js";
export { readVectorLayersAsGeoJson } from "./vector-geojson.js";
export type { VectorGeoJsonLayer } from "./vector-geojson.js";
export type { GisSampleFeature, GisSampleRead } from "./sample.js";
export { createOpenFileGdbReader } from "./openfilegdb.js";
export { runGdalWasmSelfCheck } from "./self-check.js";
