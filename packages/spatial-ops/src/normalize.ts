// SPDX-License-Identifier: Apache-2.0

import type { Geometry } from "geojson";
import { crsLabelFor, fieldNamesOf, identifyCrs, invalidCrs, unknownCrs } from "@igis/surtgis";
import type { CrsIdentity } from "@igis/surtgis";
import { SpatialOpError } from "./errors.js";
import type { MapCollection, MapFeature, ScalarProps } from "./types.js";

const GEOMETRY_TYPES = new Set([
  "Point",
  "LineString",
  "Polygon",
  "MultiPoint",
  "MultiLineString",
  "MultiPolygon",
  "GeometryCollection",
]);

const FEATURE_CAP = 8000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scalarProps(value: unknown): ScalarProps {
  if (!isRecord(value)) return {};
  const properties: ScalarProps = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "_fid") continue;
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean" || item === null) {
      if (typeof item === "number" && !Number.isFinite(item)) continue;
      properties[key] = item;
    }
  }
  return properties;
}

function asGeometry(value: unknown): Geometry | null {
  if (!isRecord(value) || typeof value.type !== "string" || !GEOMETRY_TYPES.has(value.type)) return null;
  if (value.type === "GeometryCollection") {
    if (!Array.isArray(value.geometries)) return null;
    return { type: "GeometryCollection", geometries: value.geometries as Geometry[] };
  }
  if (!Array.isArray(value.coordinates) || value.coordinates.length === 0) return null;
  return { type: value.type, coordinates: value.coordinates } as Geometry;
}

export { fieldNamesOf, geometryKindOf } from "@igis/surtgis";

export interface NormalizedLayer {
  readonly collection: MapCollection;
  readonly warnings: readonly string[];
  readonly fieldNames: readonly string[];
}

/** 把 GeoJSON 收成地图图层。损坏的要素跳过，不抛到进程外。 */
export function normalizeFeatures(features: readonly unknown[], presetWarnings: readonly string[] = []): NormalizedLayer {
  const warnings = [...presetWarnings];
  const kept: MapFeature[] = [];
  const limit = Math.min(features.length, FEATURE_CAP);
  if (features.length > FEATURE_CAP) warnings.push("要素超过 8000，超出部分没有载入。");
  for (let index = 0; index < limit; index += 1) {
    const item = features[index];
    if (!isRecord(item) || item.type !== "Feature") {
      warnings.push(`第 ${index + 1} 个要素不是有效要素，已跳过。`);
      continue;
    }
    const geometry = asGeometry(item.geometry);
    if (!geometry) {
      warnings.push(`第 ${index + 1} 个要素几何无效，已跳过。`);
      continue;
    }
    const properties = scalarProps(item.properties);
    properties._fid = kept.length;
    kept.push({ type: "Feature", properties, geometry });
  }
  const collection: MapCollection = { type: "FeatureCollection", features: kept };
  return { collection, warnings, fieldNames: fieldNamesOf(collection) };
}

function simpleCrsName(crs: unknown): string | null {
  if (typeof crs === "string") {
    const trimmed = crs.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (!isRecord(crs)) return null;
  if (typeof crs.name === "string" && crs.name.trim() !== "") return crs.name.trim();
  const properties = crs.properties;
  if (!isRecord(properties) || typeof properties.name !== "string") return null;
  const name = properties.name.trim();
  return name === "" ? null : name;
}

/**
 * 没有 crs 成员是未知。写明的 EPSG 写法收成规范代码。
 * 写了但证明不了的元数据（例如 WKT）是无效，不降成未知，也不猜成 4326。
 */
export function geoJsonCrsIdentity(crs: unknown): CrsIdentity {
  if (crs === undefined || crs === null) return unknownCrs();
  const name = simpleCrsName(crs);
  if (name === null) return invalidCrs("无法读取的坐标系");
  return identifyCrs(name);
}

export function explicitGeoJsonCrsLabel(crs: unknown): string {
  return crsLabelFor(geoJsonCrsIdentity(crs));
}

export function normalizeGeoJsonText(text: string): NormalizedLayer & { readonly crsLabel: string; readonly crsIdentity: CrsIdentity } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new SpatialOpError("这个 GeoJSON 无法解析。请确认文件没有损坏。");
  }
  if (!isRecord(parsed)) throw new SpatialOpError("这不是矢量 GeoJSON。");
  const crsIdentity = geoJsonCrsIdentity(parsed.crs);
  const crsLabel = crsLabelFor(crsIdentity);
  if (parsed.type === "Feature") return { ...normalizeFeatures([parsed]), crsLabel, crsIdentity };
  if (parsed.type === "FeatureCollection" && Array.isArray(parsed.features)) return { ...normalizeFeatures(parsed.features), crsLabel, crsIdentity };
  throw new SpatialOpError("这不是矢量 GeoJSON。地图只接受要素或要素集合。");
}
