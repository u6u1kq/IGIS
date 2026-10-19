// SPDX-License-Identifier: Apache-2.0

import type { GeometryTypeName, MemoryKind, MemoryRef } from "@igis/shared-types";
import type { ProvenanceLedger } from "@igis/provenance";
import { buildProvenanceRecord } from "@igis/provenance";
import type { GisFieldMetadata, GisIoPorts, GisLayerMetadata, GisReadRequest, GisReadResult } from "./ports.js";
import { readSourceDigestMaterial } from "./source-hash.js";

/**
 * 路由约束。这里没有 child_process，也没有 gdal。读取只走注入的 GDAL-WASM 端口。
 */
export const GIS_IO_ROUTER_CONSTRAINTS = {
  spawnsProcess: false,
  importsGdal: false,
  listensOnTcp: false,
  primary: "gdal-wasm",
  recordsProvenance: true,
} as const;

/** 请求本身不合法。这种情况不转发到另一个端口。 */
export class GisIoRequestError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "GisIoRequestError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function sanitizeRequest(request: GisReadRequest): GisReadRequest {
  if (request === null || typeof request !== "object") {
    throw new GisIoRequestError("读取请求必须是对象。");
  }
  for (const key of Object.keys(request)) {
    if (key !== "absolutePath" && key !== "layerName") {
      throw new GisIoRequestError(`读取请求含有不允许的字段: ${key}`);
    }
  }
  const absolutePath = request.absolutePath;
  if (typeof absolutePath !== "string" || absolutePath.trim() === "") {
    throw new GisIoRequestError("absolutePath 必须是非空字符串。");
  }
  const layerName = request.layerName;
  if (layerName !== null && (typeof layerName !== "string" || layerName.trim() === "")) {
    throw new GisIoRequestError("layerName 必须是字符串或 null。");
  }
  return { absolutePath, layerName };
}

function sanitizeLayerNames(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error("layerNames 必须是字符串数组。");
  }
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") {
      throw new Error("图层名必须是非空字符串。");
    }
    names.push(item);
  }
  return names;
}

function sanitizeMemory(value: unknown): MemoryRef {
  if (value === null || typeof value !== "object") {
    throw new Error("内存引用必须是对象。");
  }
  for (const key of Object.keys(value)) {
    if (key !== "handle" && key !== "kind" && key !== "byteLength" && key !== "crs" && key !== "ephemeral") {
      throw new Error(`内存引用含有不允许的字段: ${key}`);
    }
  }
  const memory = value as MemoryRef;
  if (typeof memory.handle !== "string" || memory.handle.trim() === "") {
    throw new Error("内存句柄无效。");
  }
  const kind = memory.kind;
  if (kind !== "geoarrow" && kind !== "geoparquet" && kind !== "raster-mem" && kind !== "table") {
    throw new Error("内存引用的 kind 无效。");
  }
  if (!Number.isInteger(memory.byteLength) || memory.byteLength < 0) {
    throw new Error("byteLength 必须是非负整数。");
  }
  if (typeof memory.crs !== "string" || memory.crs.trim() === "") {
    throw new Error("crs 无效。");
  }
  if (memory.ephemeral !== true) {
    throw new Error("内存引用必须是会话内临时对象。");
  }
  const narrowed: MemoryKind = kind;
  return {
    handle: memory.handle,
    kind: narrowed,
    byteLength: memory.byteLength,
    crs: memory.crs,
    ephemeral: true,
  };
}

const GEOMETRY_TYPES: readonly GeometryTypeName[] = ["point", "line", "polygon", "raster", "unknown"];

function sanitizeExtent(value: unknown): readonly [number, number, number, number] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error("extent 必须是四个有限数字或 null。");
  }
  const numbers: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isFinite(item)) {
      throw new Error("extent 必须是四个有限数字或 null。");
    }
    numbers.push(item);
  }
  const minX = numbers[0];
  const minY = numbers[1];
  const maxX = numbers[2];
  const maxY = numbers[3];
  if (minX === undefined || minY === undefined || maxX === undefined || maxY === undefined) {
    throw new Error("extent 必须是四个有限数字或 null。");
  }
  return [minX, minY, maxX, maxY];
}

function sanitizeFields(value: unknown): readonly GisFieldMetadata[] {
  if (!Array.isArray(value)) throw new Error("fields 必须是数组。");
  const fields: GisFieldMetadata[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object") throw new Error("字段元数据必须是对象。");
    for (const key of Object.keys(item)) {
      if (key !== "name" && key !== "fieldType") throw new Error(`字段元数据含有不允许的字段: ${key}`);
    }
    const field = item as GisFieldMetadata;
    if (typeof field.name !== "string" || field.name.trim() === "") {
      throw new Error("字段名无效。");
    }
    if (typeof field.fieldType !== "string" || field.fieldType.trim() === "") {
      throw new Error("字段类型无效。");
    }
    fields.push({ name: field.name, fieldType: field.fieldType });
  }
  return fields;
}

function sanitizeCount(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} 必须是非负整数或 null。`);
  }
  return value;
}

function sanitizeLayerMetadata(value: unknown): GisLayerMetadata {
  if (value === null || typeof value !== "object") throw new Error("图层元数据必须是对象。");
  for (const key of Object.keys(value)) {
    if (
      key !== "layerName" &&
      key !== "geometryType" &&
      key !== "crs" &&
      key !== "fields" &&
      key !== "featureCount" &&
      key !== "width" &&
      key !== "height" &&
      key !== "bandCount" &&
      key !== "extent"
    ) {
      throw new Error(`图层元数据含有不允许的字段: ${key}`);
    }
  }
  const layer = value as GisLayerMetadata;
  if (typeof layer.layerName !== "string" || layer.layerName.trim() === "") {
    throw new Error("图层名无效。");
  }
  if (!GEOMETRY_TYPES.includes(layer.geometryType)) throw new Error("geometryType 无效。");
  if (typeof layer.crs !== "string" || layer.crs.trim() === "") {
    throw new Error("crs 无效。");
  }
  return {
    layerName: layer.layerName,
    geometryType: layer.geometryType,
    crs: layer.crs,
    fields: sanitizeFields(layer.fields),
    featureCount: sanitizeCount(layer.featureCount, "featureCount"),
    width: sanitizeCount(layer.width, "width"),
    height: sanitizeCount(layer.height, "height"),
    bandCount: sanitizeCount(layer.bandCount, "bandCount"),
    extent: sanitizeExtent(layer.extent),
  };
}

function sanitizeMetadata(value: unknown): readonly GisLayerMetadata[] {
  if (!Array.isArray(value)) throw new Error("metadata 必须是数组。");
  return value.map((item) => sanitizeLayerMetadata(item));
}

function sanitizeResult(result: GisReadResult, expected: GisReadResult["reader"]): GisReadResult {
  if (result === null || typeof result !== "object") {
    throw new Error("读取结果必须是对象。");
  }
  for (const key of Object.keys(result)) {
    if (key !== "reader" && key !== "memory" && key !== "layerNames" && key !== "metadata") {
      throw new Error(`读取结果含有不允许的字段: ${key}`);
    }
  }
  if (result.reader !== expected) {
    throw new Error("读取结果的 reader 与端口不一致。");
  }
  return {
    reader: expected,
    memory: sanitizeMemory(result.memory),
    layerNames: sanitizeLayerNames(result.layerNames),
    metadata: sanitizeMetadata(result.metadata),
  };
}

/**
 * 走注入的 GDAL-WASM。成功则返回，失败则把这次失败抛出去。
 * 每一次到达这里的读取都会写来源账本：源内容 SHA-256、readOnly、exportPath=null、图层名。
 * 账本不接收 extent、坐标、WKT/WKB 或几何。
 */
export async function routeGisRead(
  ports: GisIoPorts,
  request: GisReadRequest,
  ledger: ProvenanceLedger,
): Promise<GisReadResult> {
  if (ports.gdalWasm.id !== "gdal-wasm") {
    throw new GisIoRequestError("GIS 读端口标识不正确。");
  }
  const safeRequest = sanitizeRequest(request);
  const sourceContent = await readSourceDigestMaterial(safeRequest.absolutePath);
  let layerNames: readonly string[] = [];
  try {
    const result = sanitizeResult(await ports.gdalWasm.read(safeRequest), "gdal-wasm");
    layerNames = result.layerNames;
    return result;
  } finally {
    await ledger.append(
      buildProvenanceRecord({
        sourceContent,
        exportPath: null,
        layerNames,
      }),
    );
  }
}
