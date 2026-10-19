// SPDX-License-Identifier: Apache-2.0

import type { GeometryTypeName } from "@igis/shared-types";
import { GisIoReadError } from "@igis/gis-io";
import { PROVENANCE_FORBIDDEN_FIELDS } from "@igis/provenance";
import { withReadonlyDataset } from "./read.js";
import type { GdalRuntime } from "./runtime.js";

/** 样例最多 15 条。读到这个数就停，不把整个图层扫完。 */
export const SAMPLE_FEATURE_LIMIT = 15;

const OMITTED_FIELD_NAMES = new Set(
  [...PROVENANCE_FORBIDDEN_FIELDS, "经度", "纬度", "坐标", "easting", "northing"].map((name) => name.toLowerCase()),
);

const SKIPPED_FIELD_TYPES = new Set([1, 3, 5, 7, 8, 13]);

export interface GisSampleFeature {
  readonly featureId: number;
  readonly geometryType: GeometryTypeName;
  readonly attributes: Readonly<Record<string, string | number | boolean | null>>;
}

export interface GisSampleRead {
  readonly layerName: string;
  readonly geometryType: GeometryTypeName;
  readonly features: readonly GisSampleFeature[];
  readonly stoppedAtLimit: boolean;
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

function attributeValue(raw: string): string | number | boolean | null | undefined {
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

function readAttributes(runtime: GdalRuntime, feature: number, layer: number): Readonly<Record<string, string | number | boolean | null>> {
  const definition = runtime.layerDefinition(layer);
  const count = runtime.fieldCount(definition);
  const attributes: Record<string, string | number | boolean | null> = {};
  for (let index = 0; index < count; index += 1) {
    const field = runtime.fieldDefinition(definition, index);
    const name = runtime.fieldName(field).trim();
    if (name === "" || OMITTED_FIELD_NAMES.has(name.toLowerCase())) continue;
    const fieldType = runtime.fieldType(field);
    if (SKIPPED_FIELD_TYPES.has(fieldType)) continue;
    const value = attributeValue(runtime.featureFieldAsString(feature, index));
    if (value === undefined) continue;
    attributes[name] = value;
  }
  return attributes;
}

/**
 * 只读打开后最多取 15 条要素的属性。
 * 预编译包没有导出 OGR_F_GetFID，featureId 是这次读取的序号。
 * 不调用几何导出，也不返回坐标。
 */
export async function readGisSampleFeatures(
  runtime: GdalRuntime,
  absolutePath: string,
  layerName: string,
): Promise<GisSampleRead> {
  const trimmed = layerName.trim();
  if (trimmed === "") {
    throw new GisIoReadError("gdal-wasm", "图层名无效。", "read-failed");
  }
  const opened = await withReadonlyDataset(runtime, absolutePath);
  try {
    const rasterName = opened.displayName;
    const width = runtime.rasterWidth(opened.dataset);
    const height = runtime.rasterHeight(opened.dataset);
    const bands = runtime.rasterBands(opened.dataset);
    if (width > 0 && height > 0 && bands > 0 && rasterName === trimmed) {
      return { layerName: trimmed, geometryType: "raster", features: [], stoppedAtLimit: false };
    }
    const count = runtime.layerCount(opened.dataset);
    let layer = 0;
    let resolvedName = "";
    for (let index = 0; index < count; index += 1) {
      const candidate = runtime.layer(opened.dataset, index);
      if (candidate === 0) continue;
      const name = runtime.layerName(candidate).trim() || rasterName;
      if (name === trimmed) {
        layer = candidate;
        resolvedName = name;
        break;
      }
    }
    if (layer === 0) {
      throw new GisIoReadError("gdal-wasm", "请求的图层不存在。", "read-failed");
    }
    runtime.resetReading(layer);
    const features: GisSampleFeature[] = [];
    let geometryType: GeometryTypeName = "unknown";
    for (let index = 0; index < SAMPLE_FEATURE_LIMIT; index += 1) {
      const feature = runtime.nextFeature(layer);
      if (feature === 0) {
        return { layerName: resolvedName, geometryType, features, stoppedAtLimit: false };
      }
      const geometry = runtime.featureGeometry(feature);
      const featureType = geometry === 0 ? "unknown" : mapGeometry(runtime.geometryType(geometry));
      if (geometryType === "unknown") geometryType = featureType;
      features.push({
        featureId: index,
        geometryType: featureType,
        attributes: readAttributes(runtime, feature, layer),
      });
      runtime.destroyFeature(feature);
    }
    const extra = runtime.nextFeature(layer);
    if (extra !== 0) runtime.destroyFeature(extra);
    return { layerName: resolvedName, geometryType, features, stoppedAtLimit: extra !== 0 };
  } catch (error) {
    if (error instanceof GisIoReadError) throw error;
    const message = error instanceof Error ? error.message : "GDAL-WASM 读取失败。";
    throw new GisIoReadError("gdal-wasm", message, "read-failed");
  } finally {
    opened.close();
  }
}
