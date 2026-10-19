// SPDX-License-Identifier: Apache-2.0

import type { GeometryTypeName, MemoryRef } from "@igis/shared-types";

/**
 * OpenFileGDB 是 ArcGIS FileGDB 的逆向工程只读驱动，并不是 ArcGIS Pro 的完整等价实现。
 * 使用社区预编译包 gdal-js。该驱动只读。
 * 读失败就返回这次失败。路由不派生进程，也不导入 gdal。
 */
export const OPENFILEGDB_READ_NOTE =
  "OpenFileGDB 只读，且与 ArcGIS Pro 并非 100% 等价。GDAL-WASM 读失败后停止。";

/** 一次读取请求。两个端口收到的是同一份字段，不含几何正文。 */
export interface GisReadRequest {
  readonly absolutePath: string;
  readonly layerName: string | null;
}

/** 字段名和字段类型。不是几何。 */
export interface GisFieldMetadata {
  readonly name: string;
  readonly fieldType: string;
}

/**
 * 调用方可见的图层元数据。
 * extent 若存在，只留在这次返回值里，来源账本不接收它。
 * 这里没有坐标数组、WKT/WKB 或 GeoJSON 几何。
 */
export interface GisLayerMetadata {
  readonly layerName: string;
  readonly geometryType: GeometryTypeName;
  readonly crs: string;
  readonly fields: readonly GisFieldMetadata[];
  readonly featureCount: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly bandCount: number | null;
  readonly extent: readonly [number, number, number, number] | null;
}

/** 实际完成这次读取的一端。 */
export type GisIoReaderId = "gdal-wasm";

/** 读取成功后交回内存引用、图层名和非坐标元数据。 */
export interface GisReadResult {
  readonly reader: GisIoReaderId;
  readonly memory: MemoryRef;
  readonly layerNames: readonly string[];
  readonly metadata: readonly GisLayerMetadata[];
}

/**
 * GDAL-WASM 读端口。
 * 实现由调用方注入。本包不导入 gdal，也不调用 wasm。
 */
export interface GdalWasmReadPort {
  readonly id: "gdal-wasm";
  read(request: GisReadRequest): Promise<GisReadResult>;
}

export interface GisIoPorts {
  readonly gdalWasm: GdalWasmReadPort;
}

/** 端口用这个错误表示本次读取失败。 */
export class GisIoReadError extends Error {
  readonly reader: GisIoReaderId;
  readonly detail: string;
  readonly code: "driver-missing" | "open-failed" | "read-failed";
  constructor(
    reader: GisIoReaderId,
    detail: string,
    code: "driver-missing" | "open-failed" | "read-failed" = "read-failed",
  ) {
    super(`${reader} 读取失败: ${detail}`);
    this.name = "GisIoReadError";
    this.reader = reader;
    this.detail = detail;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
