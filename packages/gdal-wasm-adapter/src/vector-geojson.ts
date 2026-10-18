// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { looksLikeGeometryText } from "@igis/shared-types";
import { GisIoReadError } from "@igis/gis-io";
import { withReadonlyDataset } from "./read.js";
import type { GdalRuntime } from "./runtime.js";

/** 地图载入上限。超出的要素不进入结果，避免把进程撑垮。 */
const MAP_FEATURE_CAP = 8000;

const GEOMETRY_TYPES = new Set([
  "Point",
  "LineString",
  "Polygon",
  "MultiPoint",
  "MultiLineString",
  "MultiPolygon",
  "GeometryCollection",
]);

export interface VectorGeoJsonFeature {
  readonly type: "Feature";
  readonly properties: Readonly<Record<string, string | number | boolean | null>>;
  readonly geometry: { readonly type: string; readonly coordinates?: unknown; readonly geometries?: unknown };
}

export interface VectorGeoJsonLayer {
  readonly layerName: string;
  readonly warnings: readonly string[];
  readonly features: readonly VectorGeoJsonFeature[];
  /** 载入时从 .prj 读到的 WKT 投影定义。读不到就是 null。 */
  readonly crsWkt: string | null;
}

function isGeometry(value: unknown): value is { type: string; coordinates?: unknown; geometries?: unknown } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.type !== "string" || !GEOMETRY_TYPES.has(record.type)) return false;
  if (record.type === "GeometryCollection") return Array.isArray(record.geometries);
  return Array.isArray(record.coordinates);
}

function cleanGeometry(value: { type: string; coordinates?: unknown; geometries?: unknown }): VectorGeoJsonFeature["geometry"] {
  if (value.type === "GeometryCollection") return { type: value.type, geometries: value.geometries };
  return { type: value.type, coordinates: value.coordinates };
}

function attributeValue(raw: string): string | number | boolean | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  if (/^-?\d+\.\d+$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return trimmed;
}

function readAttributes(runtime: GdalRuntime, feature: number, layer: number): Record<string, string | number | boolean | null> {
  const definition = runtime.layerDefinition(layer);
  const count = runtime.fieldCount(definition);
  const attributes: Record<string, string | number | boolean | null> = {};
  for (let index = 0; index < count; index += 1) {
    const field = runtime.fieldDefinition(definition, index);
    const name = runtime.fieldName(field).trim();
    if (name === "" || looksLikeGeometryText(name)) continue;
    if (runtime.fieldType(field) === 8) continue;
    try {
      attributes[name] = attributeValue(runtime.featureFieldAsString(feature, index));
    } catch {
      // 单个字段读失败就跳过，不中断整层。
    }
  }
  return attributes;
}

function readOneLayer(runtime: GdalRuntime, layer: number, layerName: string): VectorGeoJsonLayer {
  const warnings: string[] = [];
  const features: VectorGeoJsonFeature[] = [];
  runtime.resetReading(layer);
  let index = 0;
  for (;;) {
    if (index >= MAP_FEATURE_CAP) {
      const extra = runtime.nextFeature(layer);
      if (extra !== 0) {
        runtime.destroyFeature(extra);
        warnings.push("要素超过 8000，超出部分没有载入。");
      }
      break;
    }
    const feature = runtime.nextFeature(layer);
    if (feature === 0) break;
    const displayIndex = index + 1;
    index += 1;
    try {
      const geometryPointer = runtime.featureGeometry(feature);
      if (geometryPointer === 0) {
        warnings.push(`第 ${displayIndex} 个要素没有几何，已跳过。`);
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(runtime.geometryJson(geometryPointer)) as unknown;
      } catch {
        warnings.push(`第 ${displayIndex} 个要素几何无效，已跳过。`);
        continue;
      }
      if (!isGeometry(parsed)) {
        warnings.push(`第 ${displayIndex} 个要素几何无效，已跳过。`);
        continue;
      }
      const properties = readAttributes(runtime, feature, layer);
      features.push({
        type: "Feature",
        properties: { ...properties, _fid: features.length },
        geometry: cleanGeometry(parsed),
      });
    } catch {
      warnings.push(`第 ${displayIndex} 个要素几何无效，已跳过。`);
    } finally {
      try {
        runtime.destroyFeature(feature);
      } catch {
        // 销毁失败不影响源文件。
      }
    }
  }
  return { layerName, warnings, features, crsWkt: null };
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

/** Shapefile 的坐标系从同名 .prj 直读。GDALGetProjectionRef 对矢量数据集返回空。 */
async function readPrjWkt(absolutePath: string): Promise<string | null> {
  if (!absolutePath.toLowerCase().endsWith(".shp")) return null;
  const dot = absolutePath.lastIndexOf(".");
  const prjPath = dot <= 0 ? `${absolutePath}.prj` : `${absolutePath.slice(0, dot)}.prj`;
  let text: string;
  try {
    text = await readFile(prjPath, { encoding: "utf8" });
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
  const trimmed = text.trim();
  if (trimmed.length < 16 || trimmed.length > 8192) return null;
  if (!/^(PROJCS|GEOGCS)\[/i.test(trimmed)) return null;
  return trimmed;
}

/**
 * 单独的几何读取。元数据接口保持原样。
 * 几何只出现在返回的 GeoJSON 里，本函数不写账本。
 */
export async function readVectorLayersAsGeoJson(
  runtime: GdalRuntime,
  absolutePath: string,
  layerName: string | null,
): Promise<readonly VectorGeoJsonLayer[]> {
  const opened = await withReadonlyDataset(runtime, absolutePath);
  const crsWkt = await readPrjWkt(resolve(absolutePath));
  try {
    const count = runtime.layerCount(opened.dataset);
    if (count <= 0) {
      throw new GisIoReadError("gdal-wasm", "这个文件没有矢量图层，不能载入地图。", "read-failed");
    }
    const layers: VectorGeoJsonLayer[] = [];
    for (let index = 0; index < count; index += 1) {
      const layer = runtime.layer(opened.dataset, index);
      if (layer === 0) continue;
      const name = runtime.layerName(layer).trim() || opened.displayName;
      if (looksLikeGeometryText(name)) {
        throw new GisIoReadError("gdal-wasm", "图层名无效，已停止。", "read-failed");
      }
      if (layerName !== null && name !== layerName) continue;
      layers.push({ ...readOneLayer(runtime, layer, name), crsWkt });
    }
    if (layers.length === 0) {
      throw new GisIoReadError("gdal-wasm", layerName ? "请求的图层不存在。" : "没有可读的矢量图层。", "read-failed");
    }
    return layers;
  } catch (error) {
    if (error instanceof GisIoReadError) throw error;
    throw new GisIoReadError("gdal-wasm", "读取矢量几何失败。文件可能已损坏。", "read-failed");
  } finally {
    opened.close();
  }
}
