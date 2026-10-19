// SPDX-License-Identifier: Apache-2.0

import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { GeometryTypeName, MemoryKind } from "@igis/shared-types";
import { GisIoReadError } from "@igis/gis-io";
import type { GisFieldMetadata, GisLayerMetadata, GisReadRequest, GisReadResult } from "@igis/gis-io";
import type { GdalRuntime } from "./runtime.js";

const FEATURE_CAP = 1_000_000;
const SHAPE_SIDECARS = [".shp", ".shx", ".dbf", ".prj", ".cpg", ".qpj", ".sbn", ".sbx", ".qix"];
const OFT_NAMES = [
  "OFTInteger",
  "OFTIntegerList",
  "OFTReal",
  "OFTRealList",
  "OFTString",
  "OFTStringList",
  "OFTWideString",
  "OFTWideStringList",
  "OFTBinary",
  "OFTDate",
  "OFTTime",
  "OFTDateTime",
  "OFTInteger64",
  "OFTInteger64List",
] as const;

let virtualSequence = 0;

function filesystemCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function safeCrs(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return "unknown";
  return trimmed;
}

function mapGeometry(code: number): GeometryTypeName {
  let flat = code & 0x7fffffff;
  if (flat >= 3000) flat -= 3000;
  else if (flat >= 2000) flat -= 2000;
  else if (flat >= 1000) flat -= 1000;
  if (flat === 1 || flat === 4) return "point";
  if (flat === 2 || flat === 5) return "line";
  if (flat === 3 || flat === 6) return "polygon";
  return "unknown";
}

function oftName(code: number): string {
  return OFT_NAMES[code] ?? `OFT(${code})`;
}

function requireDriver(present: boolean, driver: string): void {
  if (present) return;
  throw new GisIoReadError(
    "gdal-wasm",
    `gdal-js@2.2.0 未包含 ${driver} 驱动，不能把这次读取当成成功。`,
    "driver-missing",
  );
}

function ensureVirtualDir(runtime: GdalRuntime, directory: string): void {
  const parts = directory.split("/").filter((part) => part.length > 0);
  let parent = "/";
  for (const part of parts) {
    try {
      runtime.createPath(parent, part);
    } catch {
      // 虚拟目录已经存在时继续往下建。
    }
    parent = parent === "/" ? `/${part}` : `${parent}/${part}`;
  }
}

function stageBytes(runtime: GdalRuntime, directory: string, fileName: string, bytes: Uint8Array, staged: string[]): void {
  ensureVirtualDir(runtime, directory);
  runtime.createDataFile(directory, fileName, bytes);
  staged.push(directory === "/" ? `/${fileName}` : `${directory}/${fileName}`);
}

async function stageFile(runtime: GdalRuntime, hostPath: string, directory: string, staged: string[]): Promise<number> {
  const bytes = await readFile(hostPath);
  stageBytes(runtime, directory, basename(hostPath), bytes, staged);
  return bytes.byteLength;
}

async function stageIfExists(
  runtime: GdalRuntime,
  hostPath: string,
  directory: string,
  fileName: string,
  staged: string[],
): Promise<number> {
  try {
    const info = await stat(hostPath);
    if (!info.isFile()) return 0;
    const bytes = await readFile(hostPath);
    stageBytes(runtime, directory, fileName, bytes, staged);
    return bytes.byteLength;
  } catch (error) {
    if (filesystemCode(error) === "ENOENT") return 0;
    throw error;
  }
}

async function stageShapefile(runtime: GdalRuntime, hostPath: string, directory: string, staged: string[]): Promise<number> {
  const folder = dirname(hostPath);
  const stem = basename(hostPath, ".shp");
  let total = 0;
  let sawMain = false;
  for (const ext of SHAPE_SIDECARS) {
    const added = await stageIfExists(runtime, join(folder, `${stem}${ext}`), directory, `${stem}${ext}`, staged);
    total += added;
    if (ext === ".shp" && added > 0) sawMain = true;
  }
  if (!sawMain) {
    throw new GisIoReadError("gdal-wasm", "找不到 shapefile 主文件。", "open-failed");
  }
  return total;
}

async function stageDirectory(runtime: GdalRuntime, hostDir: string, directory: string, staged: string[]): Promise<number> {
  const entries = await readdir(hostDir, { recursive: true });
  let total = 0;
  for (const entry of entries) {
    const rel = entry.replaceAll("\\", "/");
    if (rel === "" || rel.split("/").includes("..")) continue;
    const hostPath = resolve(hostDir, entry);
    let info;
    try {
      info = await stat(hostPath);
    } catch (error) {
      if (filesystemCode(error) === "ENOENT") continue;
      throw error;
    }
    if (!info.isFile()) continue;
    const parts = rel.split("/");
    const fileName = parts.pop();
    if (!fileName) continue;
    const parent = parts.length === 0 ? directory : `${directory}/${parts.join("/")}`;
    const bytes = await readFile(hostPath);
    stageBytes(runtime, parent, fileName, bytes, staged);
    total += bytes.byteLength;
  }
  return total;
}

function finiteTuple(values: readonly number[]): readonly [number, number, number, number] | null {
  if (values.length !== 4) return null;
  const [minX, minY, maxX, maxY] = values;
  if (
    minX === undefined ||
    minY === undefined ||
    maxX === undefined ||
    maxY === undefined ||
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    return null;
  }
  return [minX, minY, maxX, maxY];
}

function rasterExtent(runtime: GdalRuntime, dataset: number, width: number, height: number): readonly [number, number, number, number] | null {
  if (width <= 0 || height <= 0) return null;
  const buffer = runtime.malloc(48);
  try {
    if (runtime.geoTransform(dataset, buffer) !== 0) return null;
    const gt = runtime.readDoubles(buffer, 6);
    const originX = gt[0];
    const scaleX = gt[1];
    const skewX = gt[2];
    const originY = gt[3];
    const skewY = gt[4];
    const scaleY = gt[5];
    if (
      originX === undefined ||
      scaleX === undefined ||
      skewX === undefined ||
      originY === undefined ||
      skewY === undefined ||
      scaleY === undefined
    ) {
      return null;
    }
    const maxX = originX + width * scaleX + height * skewX;
    const minY = originY + width * skewY + height * scaleY;
    return finiteTuple([
      Math.min(originX, maxX),
      Math.min(originY, minY),
      Math.max(originX, maxX),
      Math.max(originY, minY),
    ]);
  } finally {
    runtime.free(buffer);
  }
}

function vectorExtent(runtime: GdalRuntime, layer: number): readonly [number, number, number, number] | null {
  const buffer = runtime.malloc(32);
  try {
    if (runtime.layerExtent(layer, buffer) !== 0) return null;
    const raw = runtime.readDoubles(buffer, 4);
    const minX = raw[0];
    const maxX = raw[1];
    const minY = raw[2];
    const maxY = raw[3];
    if (minX === undefined || maxX === undefined || minY === undefined || maxY === undefined) return null;
    return finiteTuple([minX, minY, maxX, maxY]);
  } finally {
    runtime.free(buffer);
  }
}

function readFields(runtime: GdalRuntime, layer: number): readonly GisFieldMetadata[] {
  const definition = runtime.layerDefinition(layer);
  const count = runtime.fieldCount(definition);
  const fields: GisFieldMetadata[] = [];
  for (let index = 0; index < count; index += 1) {
    const field = runtime.fieldDefinition(definition, index);
    const name = runtime.fieldName(field).trim();
    if (name === "") {
      throw new GisIoReadError("gdal-wasm", "字段名无效。", "read-failed");
    }
    fields.push({ name, fieldType: oftName(runtime.fieldType(field)) });
  }
  return fields;
}

function countFeatures(runtime: GdalRuntime, layer: number): { readonly count: number; readonly geometryType: GeometryTypeName } {
  runtime.resetReading(layer);
  let count = 0;
  let geometryType: GeometryTypeName = "unknown";
  for (;;) {
    const feature = runtime.nextFeature(layer);
    if (feature === 0) break;
    count += 1;
    if (geometryType === "unknown") {
      const geometry = runtime.featureGeometry(feature);
      if (geometry !== 0) geometryType = mapGeometry(runtime.geometryType(geometry));
    }
    runtime.destroyFeature(feature);
    if (count > FEATURE_CAP) {
      throw new GisIoReadError("gdal-wasm", "要素数量超过读取上限，已停止且不返回坐标。", "read-failed");
    }
  }
  return { count, geometryType };
}

function collectMetadata(runtime: GdalRuntime, dataset: number, displayName: string): readonly GisLayerMetadata[] {
  const crs = safeCrs(runtime.projection(dataset));
  const width = runtime.rasterWidth(dataset);
  const height = runtime.rasterHeight(dataset);
  const bandCount = runtime.rasterBands(dataset);
  const layers: GisLayerMetadata[] = [];
  if (width > 0 && height > 0 && bandCount > 0) {
    layers.push({
      layerName: displayName,
      geometryType: "raster",
      crs,
      fields: [],
      featureCount: null,
      width,
      height,
      bandCount,
      extent: rasterExtent(runtime, dataset, width, height),
    });
  }
  const count = runtime.layerCount(dataset);
  for (let index = 0; index < count; index += 1) {
    const layer = runtime.layer(dataset, index);
    if (layer === 0) continue;
    const rawName = runtime.layerName(layer).trim();
    const walked = countFeatures(runtime, layer);
    layers.push({
      layerName: rawName === "" ? displayName : rawName,
      geometryType: walked.geometryType,
      crs,
      fields: readFields(runtime, layer),
      featureCount: walked.count,
      width: null,
      height: null,
      bandCount: null,
      extent: vectorExtent(runtime, layer),
    });
  }
  if (layers.length === 0) {
    throw new GisIoReadError("gdal-wasm", "数据集已打开，但没有可读的图层或栅格波段。", "read-failed");
  }
  return layers;
}

async function applyShapefileCrs(absolutePath: string, layers: readonly GisLayerMetadata[]): Promise<readonly GisLayerMetadata[]> {
  const prjPath = join(dirname(absolutePath), `${basename(absolutePath, ".shp")}.prj`);
  let text: string;
  try {
    text = await readFile(prjPath, { encoding: "utf8" });
  } catch (error) {
    if (filesystemCode(error) === "ENOENT") return layers;
    throw error;
  }
  const crs = safeCrs(text);
  if (crs === "unknown") return layers;
  return layers.map((layer) => (layer.crs === "unknown" ? { ...layer, crs } : layer));
}

function datasetKind(path: string): "geotiff" | "shapefile" | "filegdb" | "other" {
  const ext = extname(path).toLowerCase();
  if (ext === ".gdb") return "filegdb";
  if (ext === ".tif" || ext === ".tiff") return "geotiff";
  if (ext === ".shp") return "shapefile";
  return "other";
}

export interface ReadonlyDatasetSession {
  readonly dataset: number;
  readonly displayName: string;
  readonly byteLength: number;
  readonly kind: "geotiff" | "shapefile" | "filegdb" | "other";
  readonly sequence: number;
  close(): void;
}

/**
 * 把源文件复制进 wasm 内存文件系统，并以只读方式打开。
 * 调用方必须 close。失败时本函数自己清掉虚拟文件。
 */
export async function withReadonlyDataset(runtime: GdalRuntime, absolutePathInput: string): Promise<ReadonlyDatasetSession> {
  const absolutePath = resolve(absolutePathInput);
  let info;
  try {
    info = await stat(absolutePath);
  } catch (error) {
    const code = filesystemCode(error);
    throw new GisIoReadError(
      "gdal-wasm",
      code === "ENOENT" ? "源路径不存在。" : "无法读取源路径。",
      "open-failed",
    );
  }
  const kind = datasetKind(absolutePath);
  if (kind === "geotiff") requireDriver(runtime.drivers.gTiff, "GTiff");
  if (kind === "shapefile") requireDriver(runtime.drivers.shapefile, "ESRI Shapefile");
  if (kind === "filegdb") requireDriver(runtime.drivers.openFileGdb, "OpenFileGDB");
  virtualSequence += 1;
  const sequence = virtualSequence;
  const directory = `/igis/${sequence}`;
  const staged: string[] = [];
  let dataset = 0;
  try {
    let byteLength = 0;
    let virtualPath = directory;
    if (info.isDirectory()) {
      byteLength = await stageDirectory(runtime, absolutePath, directory, staged);
      virtualPath = directory;
    } else if (kind === "shapefile") {
      byteLength = await stageShapefile(runtime, absolutePath, directory, staged);
      virtualPath = `${directory}/${basename(absolutePath)}`;
    } else {
      byteLength = await stageFile(runtime, absolutePath, directory, staged);
      virtualPath = `${directory}/${basename(absolutePath)}`;
    }
    runtime.resetError();
    dataset = runtime.openEx(virtualPath);
    if (dataset === 0) {
      const detail = runtime.lastError().trim() || "GDAL 未能打开数据集。";
      throw new GisIoReadError("gdal-wasm", detail, "open-failed");
    }
    const opened = dataset;
    const paths = [...staged];
    dataset = 0;
    staged.length = 0;
    const displayName = basename(absolutePath, extname(absolutePath)) || basename(absolutePath);
    return {
      dataset: opened,
      displayName,
      byteLength,
      kind,
      sequence,
      close() {
        try {
          runtime.close(opened);
        } catch {
          // 虚拟数据集关闭失败不改写源文件。
        }
        for (const path of paths) {
          try {
            runtime.unlink(path);
          } catch {
            // 虚拟文件清不掉不影响源文件，源文件没有被写回。
          }
        }
      },
    };
  } catch (error) {
    if (dataset !== 0) {
      try {
        runtime.close(dataset);
      } catch {
        // 打开失败后的关闭同样不改源文件。
      }
    }
    for (const path of staged) {
      try {
        runtime.unlink(path);
      } catch {
        // 虚拟文件清不掉不影响源文件。
      }
    }
    if (error instanceof GisIoReadError) throw error;
    const message = error instanceof Error ? error.message : "GDAL-WASM 读取失败。";
    throw new GisIoReadError("gdal-wasm", message, "read-failed");
  }
}

/**
 * 只读打开用户路径，返回非坐标元数据。
 * 字节会复制进 wasm 的内存文件系统再以 GDAL_OF_READONLY 打开，不调用 Create、CreateCopy，也不改源文件。
 */
export async function readGisMetadata(runtime: GdalRuntime, request: GisReadRequest): Promise<GisReadResult> {
  const absolutePath = resolve(request.absolutePath);
  const opened = await withReadonlyDataset(runtime, absolutePath);
  try {
    let metadata = collectMetadata(runtime, opened.dataset, opened.displayName);
    if (opened.kind === "shapefile") {
      metadata = await applyShapefileCrs(absolutePath, metadata);
    }
    if (request.layerName !== null) {
      metadata = metadata.filter((layer) => layer.layerName === request.layerName);
      if (metadata.length === 0) {
        throw new GisIoReadError("gdal-wasm", "请求的图层不存在。", "read-failed");
      }
    }
    const first = metadata[0];
    const memoryKind: MemoryKind = metadata.some((layer) => layer.geometryType === "raster") ? "raster-mem" : "table";
    return {
      reader: "gdal-wasm",
      memory: {
        handle: `gdal-${opened.sequence.toString(16)}`,
        kind: memoryKind,
        byteLength: opened.byteLength,
        crs: first ? first.crs : "unknown",
        ephemeral: true,
      },
      layerNames: metadata.map((layer) => layer.layerName),
      metadata,
    };
  } catch (error) {
    if (error instanceof GisIoReadError) throw error;
    const message = error instanceof Error ? error.message : "GDAL-WASM 读取失败。";
    throw new GisIoReadError("gdal-wasm", message, "read-failed");
  } finally {
    opened.close();
  }
}
