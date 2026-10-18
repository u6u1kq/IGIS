// SPDX-License-Identifier: Apache-2.0

import type { LayerSummary, MemoryRef } from "@igis/shared-types";

/**
 * OpenFileGDB 只读会话。
 * 这是逆向工程的读路径，并不与 ArcGIS Pro 完全等价。
 * 接口上没有 Create、CreateCopy、Delete 或写回 gdb/aprx 的方法。
 * 具体打开在 @igis/gdal-wasm-adapter。读失败由 @igis/gis-io 返回。
 * OpenFileGDB 只读，并不与 ArcGIS Pro 完全等价。
 */
export interface OpenFileGdbSession {
  readonly driver: "OpenFileGDB";
  readonly readOnly: true;
  readonly hashAlgorithm: "SHA-256";
  readonly sourceContentHash: string;
  listLayers(): Promise<readonly LayerSummary[]>;
  readLayer(layerName: string): Promise<MemoryRef>;
}

export interface OpenFileGdbReader {
  readonly driver: "OpenFileGDB";
  readonly mode: "readonly";
  readonly openFlags: readonly ["GDAL_OF_READONLY"];
  open(absolutePath: string): Promise<OpenFileGdbSession>;
}
