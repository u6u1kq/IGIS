// SPDX-License-Identifier: Apache-2.0

import proj4 from "proj4";
import type { CoreCollection, CoreFeature } from "./types.js";

/**
 * 本地坐标变换。EPSG:4326 与 EPSG:3857 用注册定义，其他坐标系用 WKT 或 proj 定义。
 * 使用 proj4，不手写投影公式。GeoJSON 轴序保持 [lon, lat]。
 * 相同定义不调用投影，坐标数值不变。
 * 严格基准门：非 WGS84 家族的坐标系必须自带 towgs84，否则不做近似变换。
 */

const GEOGRAPHIC = "+proj=longlat +datum=WGS84 +no_defs +type=crs";
const WEB_MERCATOR = "+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs +type=crs";

proj4.defs("EPSG:4326", GEOGRAPHIC);
proj4.defs("EPSG:3857", WEB_MERCATOR);

const SUPPORTED = new Set<number>([4326, 3857]);

export function canTransformLocally(fromEpsg: number, toEpsg: number): boolean {
  if (fromEpsg === toEpsg) return SUPPORTED.has(fromEpsg);
  return SUPPORTED.has(fromEpsg) && SUPPORTED.has(toEpsg);
}

/** 定义是否可被 proj4 解析。结果有缓存；缓存过大时整体清空。 */
const parsableCache = new Map<string, boolean>();

export function parsableDefinition(definition: string): boolean {
  const cached = parsableCache.get(definition);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    const parsed = proj4.Proj(definition);
    ok = typeof parsed === "object" && parsed !== null;
  } catch {
    ok = false;
  }
  if (parsableCache.size > 64) parsableCache.clear();
  parsableCache.set(definition, ok);
  return ok;
}

/** 与 WGS84 等价、无需基准参数的基准名（proj4 小写形式）。CGCS2000 与 WGS84 差小于 1 米。 */
const EQUIVALENT_DATUMS = new Set(["wgs84", "china_2000"]);

export type DatumGateResult =
  | { readonly ok: true; readonly note?: string }
  | { readonly ok: false; readonly reason: string };

/**
 * 严格基准门。带 towgs84（含 WGS84 的零参数）或基准与 WGS84 等价才允许参与变换。
 * 北京54、西安80等没有统一 towgs84 的老基准会被拒绝，不做百米级近似。
 */
export function datumGate(wkt: string): DatumGateResult {
  let parsed: { datumCode?: string; datum_params?: readonly unknown[] };
  try {
    parsed = proj4.Proj(wkt);
  } catch {
    return { ok: false, reason: "投影定义无法解析。" };
  }
  const params = parsed.datum_params;
  if (Array.isArray(params) && params.length >= 3) return { ok: true };
  const code = (parsed.datumCode ?? "").toLowerCase();
  if (code === "wgs84") return { ok: true };
  if (code === "china_2000") return { ok: true, note: "基准 CGCS2000≈WGS84" };
  return { ok: false, reason: "缺少基准改正参数（towgs84）" };
}

/** 以给定经纬度为心的正射等距方位投影。米制缓冲在它上面按字面米计算。 */
export function aeqdDefinition(lat: number, lon: number): string {
  return `+proj=aeqd +lat_0=${lat.toFixed(6)} +lon_0=${lon.toFixed(6)} +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs`;
}

/**
 * 平面坐标系的长度单位到米的换算系数（WKT 的线性 UNIT/LENGTHUNIT）。
 * 地理坐标系（经纬度）没有长度单位，返回 null。证明不了也返回 null。
 */
export function planarUnitToMeter(wkt: string): number | null {
  const trimmed = wkt.trim();
  if (/^(?:GEOGCS|GEODCRS)\s*\[/i.test(trimmed)) return null;
  const matches = [...wkt.matchAll(/(?:UNIT|LENGTHUNIT)\s*\[\s*"[^"]*"\s*,\s*([0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)\s*\]/gi)];
  const last = matches[matches.length - 1]?.[1];
  if (last === undefined) return null;
  const factor = Number(last);
  return Number.isFinite(factor) && factor > 0 ? factor : null;
}

/** Turf 把 meters 线性换算成 degrees 的因子（helpers：degrees 因子 / 地球半径）。 */
export const TURF_DEGREES_PER_METER = 57.29577951308232 / 6371008.8;

function scaleCoordinates(value: unknown, factor: number): unknown {
  if (!Array.isArray(value)) return value;
  if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
    return [value[0] * factor, value[1] * factor, ...value.slice(2)];
  }
  return value.map((item) => scaleCoordinates(item, factor));
}

/**
 * 线性缩放集合的全部坐标。把 aeqd 米平面换成「伪度」平面：
 * Turf 的 meters→degrees 线性换算在等距平面上各向同性，以此得到地面真距离的缓冲。
 * 返回新集合，不修改输入。
 */
export function scaleCollection(collection: CoreCollection, factor: number): CoreCollection {
  const scaleGeometry = (geometry: CoreFeature["geometry"]): CoreFeature["geometry"] => {
    if (geometry.type === "GeometryCollection") {
      return { type: "GeometryCollection", geometries: geometry.geometries.map(scaleGeometry) };
    }
    return { ...geometry, coordinates: scaleCoordinates(geometry.coordinates, factor) } as CoreFeature["geometry"];
  };
  return {
    type: "FeatureCollection",
    features: collection.features.map((feature) => ({ ...feature, geometry: scaleGeometry(feature.geometry) })),
  };
}

function projectDef(fromDef: string, toDef: string, x: number, y: number): readonly [number, number] {
  const projected = proj4(fromDef, toDef, [x, y]);
  const outX = projected[0];
  const outY = projected[1];
  if (typeof outX !== "number" || typeof outY !== "number" || !Number.isFinite(outX) || !Number.isFinite(outY)) {
    throw new Error(`${fromDef.slice(0, 48)} 到 ${toDef.slice(0, 48)} 的本地变换没有得到有限坐标。`);
  }
  return [outX, outY];
}

function transformCoordinates(value: unknown, fromDef: string, toDef: string): unknown {
  if (!Array.isArray(value)) return value;
  if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
    const [x, y] = projectDef(fromDef, toDef, value[0], value[1]);
    return [x, y, ...value.slice(2)];
  }
  return value.map((item) => transformCoordinates(item, fromDef, toDef));
}

function transformGeometry(geometry: CoreFeature["geometry"], fromDef: string, toDef: string): CoreFeature["geometry"] {
  if (geometry.type === "GeometryCollection") {
    return {
      type: "GeometryCollection",
      geometries: geometry.geometries.map((item) => transformGeometry(item, fromDef, toDef)),
    };
  }
  return {
    ...geometry,
    coordinates: transformCoordinates(geometry.coordinates, fromDef, toDef),
  } as CoreFeature["geometry"];
}

/**
 * 任意两个可解析定义（EPSG 名称、WKT、proj 串）之间的集合变换。
 * 返回新的要素集合，不修改输入，因此不会改写图层库里的坐标。
 * 调用方必须保证两个定义都能解析；WKT 侧必须先过 datumGate。
 */
export function transformViaDefinitions(collection: CoreCollection, fromDef: string, toDef: string): CoreCollection {
  const copy = JSON.parse(JSON.stringify(collection)) as CoreCollection;
  if (fromDef === toDef) return copy;
  return {
    type: "FeatureCollection",
    features: copy.features.map((feature) => ({
      ...feature,
      geometry: transformGeometry(feature.geometry, fromDef, toDef),
    })),
  };
}

/** 兼容既有调用：按 EPSG 代码在 4326 与 3857 之间变换。 */
export function transformCollection(collection: CoreCollection, fromEpsg: number, toEpsg: number): CoreCollection {
  if (!canTransformLocally(fromEpsg, toEpsg)) {
    throw new Error(`当前本地变换不支持 EPSG:${fromEpsg} 与 EPSG:${toEpsg}。`);
  }
  return transformViaDefinitions(collection, `EPSG:${fromEpsg}`, `EPSG:${toEpsg}`);
}
