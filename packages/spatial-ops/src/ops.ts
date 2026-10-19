// SPDX-License-Identifier: Apache-2.0

import type { Feature, LineString, MultiLineString, MultiPolygon, Point, Polygon, Position } from "geojson";
import {
  area as turfArea,
  bearing as turfBearing,
  booleanIntersects,
  booleanPointInPolygon,
  centroid as turfCentroid,
  convex as turfConvex,
  distance as turfDistance,
  bbox as turfBbox,
  explode as turfExplode,
  flatten,
  length as turfLength,
  lineIntersect,
  lineSplit,
  lineToPolygon,
  multiPoint,
  nearestPointOnLine,
  pointOnFeature,
  pointToLineDistance,
  polygonize,
  polygonToLine,
  squareGrid,
  transformRotate,
  transformScale,
  transformTranslate,
  voronoi as turfVoronoi,
} from "@turf/turf";
import { bufferFeatures, clipFeatures, finishResult, intersectFeatures, safeValid, stampFeature, unionMask } from "@igis/surtgis";
import { SpatialOpError } from "./errors.js";
import { matchAttribute } from "./text.js";
import type { MapCollection, MapFeature, OpResult, QueryKind, StatsResult } from "./types.js";
import { ui } from "./locale.js";
import { isCoordinateField, numericValue } from "./text.js";

/** 缓冲、相交、裁剪由 SurtGIS 内核提供。这里转出。 */
export { bufferFeatures, clipFeatures, intersectFeatures };

export function queryFeatures(
  collection: MapCollection,
  other: MapCollection | null,
  queryKind: QueryKind,
  attributeFilter: string | null,
): OpResult {
  if (queryKind === "attribute") {
    if (!attributeFilter) throw new SpatialOpError("属性筛选需要填写筛选文字。");
    const features: MapFeature[] = [];
    const notes: string[] = [];
    let skipped = 0;
    for (let index = 0; index < collection.features.length; index += 1) {
      const feature = collection.features[index];
      if (!feature) continue;
      try {
        if (!safeValid(feature)) {
          skipped += 1;
          notes.push(`第 ${index + 1} 个要素几何无效，已跳过。`);
          continue;
        }
        if (!matchAttribute(feature.properties, attributeFilter)) continue;
        const next = stampFeature(feature as Feature, feature.properties, features.length);
        if (next) features.push(next);
      } catch (error) {
        if (error instanceof SpatialOpError) throw error;
        skipped += 1;
        notes.push(`第 ${index + 1} 个要素几何无效，已跳过。`);
      }
    }
    return finishResult(features, skipped, collection.features.length, notes);
  }
  if (!other) throw new SpatialOpError("这个空间查询需要第二个图层。");
  if (queryKind === "point-in-polygon") {
    const mask = unionMask(other);
    const features: MapFeature[] = [];
    const notes: string[] = [];
    let skipped = 0;
    let sawPoint = false;
    for (let index = 0; index < collection.features.length; index += 1) {
      const feature = collection.features[index];
      if (!feature) continue;
      try {
        if (!safeValid(feature)) {
          skipped += 1;
          continue;
        }
        const parts = flatten(feature as Feature).features.filter((part) => part.geometry?.type === "Point");
        if (parts.length === 0) continue;
        sawPoint = true;
        if (attributeFilter && !matchAttribute(feature.properties, attributeFilter)) continue;
        const kept: Point["coordinates"][] = [];
        for (const part of parts) {
          if (part.geometry?.type !== "Point") continue;
          if (booleanPointInPolygon(part as Feature<Point>, mask)) kept.push(part.geometry.coordinates);
        }
        if (kept.length === 0) continue;
        const only = kept[0];
        if (kept.length === 1 && only) {
          features.push({ type: "Feature", properties: { ...feature.properties, _fid: features.length }, geometry: { type: "Point", coordinates: only } });
        } else {
          features.push({
            type: "Feature",
            properties: { ...feature.properties, _fid: features.length },
            geometry: { type: "MultiPoint", coordinates: kept },
          });
        }
      } catch (error) {
        if (error instanceof SpatialOpError) throw error;
        skipped += 1;
        notes.push(`第 ${index + 1} 个要素几何无效，已跳过。`);
      }
    }
    if (!sawPoint && features.length === 0) throw new SpatialOpError("点在面内需要点图层作为输入，面图层作为对照。");
    return finishResult(features, skipped, collection.features.length, notes);
  }
  const features: MapFeature[] = [];
  const notes: string[] = [];
  let skipped = 0;
  for (let index = 0; index < collection.features.length; index += 1) {
    const feature = collection.features[index];
    if (!feature) continue;
    try {
      if (!safeValid(feature)) {
        skipped += 1;
        continue;
      }
      if (attributeFilter && !matchAttribute(feature.properties, attributeFilter)) continue;
      let hit = false;
      for (const candidate of other.features) {
        if (!safeValid(candidate)) continue;
        if (booleanIntersects(feature as Feature, candidate as Feature)) {
          hit = true;
          break;
        }
      }
      if (!hit) continue;
      const next = stampFeature(feature as Feature, feature.properties, features.length);
      if (next) features.push(next);
    } catch (error) {
      if (error instanceof SpatialOpError) throw error;
      skipped += 1;
      notes.push(`第 ${index + 1} 个要素几何无效，已跳过。`);
    }
  }
  return finishResult(features, skipped, collection.features.length, notes);
}

export function summarizeFeatures(collection: MapCollection, fieldName: string | null): StatsResult {
  const featureCount = collection.features.length;
  if (!fieldName || fieldName.trim() === "") {
    return { featureCount, fieldName: null, minimum: null, maximum: null, mean: null, coordinateField: false, numericCount: 0 };
  }
  const name = fieldName.trim();
  if (isCoordinateField(name)) {
    return { featureCount, fieldName: name, minimum: null, maximum: null, mean: null, coordinateField: true, numericCount: 0 };
  }
  const values: number[] = [];
  for (const feature of collection.features) {
    const value = numericValue(feature.properties[name]);
    if (value !== null) values.push(value);
  }
  if (values.length === 0) {
    return { featureCount, fieldName: name, minimum: null, maximum: null, mean: null, coordinateField: false, numericCount: 0 };
  }
  let minimum = values[0] ?? 0;
  let maximum = minimum;
  let sum = 0;
  for (const value of values) {
    if (value < minimum) minimum = value;
    if (value > maximum) maximum = value;
    sum += value;
  }
  return { featureCount, fieldName: name, minimum, maximum, mean: sum / values.length, coordinateField: false, numericCount: values.length };
}

const ACTION_EN: Readonly<Record<string, string>> = {
  "缓冲": "buffer",
  "相交": "intersect",
  "裁剪": "clip",
  "属性筛选": "attribute filter",
  "空间查询": "spatial query",
  "最近距离标注": "nearest distance",
  "线转面": "line to polygon",
  "面转线": "polygon to line",
  "融合": "dissolve",
  "图层合并": "merge",
  "几何简化": "simplify",
  "属性连接": "attribute join",
  "点分割线": "split lines",
  "多部件拆分": "explode",
  "折点转点": "vertices to points",
  "线交点": "line intersections",
  "垂足": "nearest point on line",
  "矩形格网": "square grid",
  "线分割面": "split polygons",
  "空间聚合": "spatial aggregate",
  "精确最近距离标注": "exact nearest distance",
  "Voronoi 剖分": "Voronoi",
  "凸包": "convex hull",
  "最小外接矩形": "minimum bounding box",
  "质心": "centroid",
  "方位角标注": "bearing",
};

function actionLabel(action: string): string {
  const known = ACTION_EN[action];
  if (known) return ui(action, known);
  if (action.startsWith("按 ") && action.endsWith(" 融合")) return ui(action, `dissolve by ${action.slice(2, -3)}`);
  if (action.startsWith("计算字段 ")) return ui(action, `calculate ${action.slice("计算字段 ".length)}`);
  if (action.startsWith("字段 ") && action.endsWith(" 重分类")) return ui(action, `reclassify ${action.slice(3, -4)}`);
  if (action.startsWith("分幅 ")) return ui(action, `grid split ${action.slice(3)}`);
  return action;
}

export function describeOp(action: string, result: OpResult): string {
  const label = actionLabel(action);
  if (result.corrupt) return ui("图层几何无效或已损坏，没有生成结果。", "The geometry is invalid or damaged. No result was created.");
  const skip = result.skipped > 0 ? ui(`跳过 ${result.skipped} 个无效要素。`, `Skipped ${result.skipped} invalid features. `) : "";
  const note = result.notes[0] ? result.notes[0] : "";
  if (result.collection.features.length === 0) return ui(`没有符合条件的要素。${skip}`, `No features matched. ${skip}`);
  return ui(`已完成${label}，得到 ${result.collection.features.length} 个要素。${skip}${note}`, `Finished ${label}: ${result.collection.features.length} features. ${skip}${note}`);
}

/* ---------------- 能力族：度量 / 几何转换 / 融合 / 属性 / 分幅 ---------------- */

/** 一组数值的统计摘要。 */
export interface NumberStats {
  readonly count: number;
  readonly sum: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly mean: number;
}

export function statsOf(values: readonly number[]): NumberStats | null {
  if (values.length === 0) return null;
  let minimum = values[0] ?? 0;
  let maximum = minimum;
  let sum = 0;
  for (const value of values) {
    if (value < minimum) minimum = value;
    if (value > maximum) maximum = value;
    sum += value;
  }
  return { count: values.length, sum, minimum, maximum, mean: sum / values.length };
}

export interface MeasureResult {
  readonly stats: NumberStats | null;
  readonly skipped: number;
  /** map.length 里面要素的周长单独统计。 */
  readonly secondary?: NumberStats;
  readonly notes: readonly string[];
}

/** 平面度量参数：非空时按坐标平面的欧氏几何算（局部/工程坐标系），乘系数得到米。 */
type PlanarUnit = number | null | undefined;

function planarSegDistance(a: Position, b: Position): number {
  return Math.hypot((b[0] ?? 0) - (a[0] ?? 0), (b[1] ?? 0) - (a[1] ?? 0));
}

function planarRingArea(ring: readonly Position[]): number {
  let sum = 0;
  for (let index = 0; index + 1 < ring.length; index += 1) {
    const a = ring[index];
    const b = ring[index + 1];
    if (!a || !b) continue;
    sum += (a[0] ?? 0) * (b[1] ?? 0) - (b[0] ?? 0) * (a[1] ?? 0);
  }
  return Math.abs(sum) / 2;
}

/** 平面面积（坐标单位²）：面外环减内环；多面求和。 */
function planarGeometryArea(geometry: MapFeature["geometry"]): number {
  if (!geometry) return 0;
  if (geometry.type === "Polygon") {
    const rings = geometry.coordinates as readonly (readonly Position[])[];
    let total = 0;
    rings.forEach((ring, index) => {
      total += index === 0 ? planarRingArea(ring) : -planarRingArea(ring);
    });
    return Math.max(0, total);
  }
  if (geometry.type === "MultiPolygon") {
    let total = 0;
    for (const polygon of geometry.coordinates as readonly (readonly (readonly Position[])[])[]) {
      polygon.forEach((ring, index) => {
        total += index === 0 ? planarRingArea(ring) : -planarRingArea(ring);
      });
    }
    return Math.max(0, total);
  }
  return 0;
}

/** 平面折线长度（坐标单位）。 */
function planarCoordsLength(coords: readonly Position[]): number {
  let sum = 0;
  for (let index = 0; index + 1 < coords.length; index += 1) {
    const a = coords[index];
    const b = coords[index + 1];
    if (!a || !b) continue;
    sum += planarSegDistance(a, b);
  }
  return sum;
}

function planarPointSegmentDistance(point: Position, a: Position, b: Position): number {
  const px = point[0] ?? 0;
  const py = point[1] ?? 0;
  const ax = a[0] ?? 0;
  const ay = a[1] ?? 0;
  const dx = (b[0] ?? 0) - ax;
  const dy = (b[1] ?? 0) - ay;
  const span = dx * dx + dy * dy;
  if (span === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / span));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** 点到线的平面最短距离（坐标单位）。 */
function planarPointLineDistance(point: Position, coords: readonly Position[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index + 1 < coords.length; index += 1) {
    const a = coords[index];
    const b = coords[index + 1];
    if (!a || !b) continue;
    const value = planarPointSegmentDistance(point, a, b);
    if (value < best) best = value;
  }
  return best;
}

/** 点到要素的平面最短距离（坐标单位）。点在面内为 0。 */
function planarDistanceToGeometry(point: Position, geometry: MapFeature["geometry"]): number {
  if (!geometry) return Number.POSITIVE_INFINITY;
  let best = Number.POSITIVE_INFINITY;
  for (const part of flatten({ type: "Feature", properties: {}, geometry } as Feature).features) {
    const kind = part.geometry?.type ?? "";
    if (kind === "Point") {
      const coords = (part as Feature<Point>).geometry.coordinates;
      const value = planarSegDistance(point, coords);
      if (value < best) best = value;
    } else if (kind === "LineString") {
      const value = planarPointLineDistance(point, (part as Feature<LineString>).geometry.coordinates);
      if (value < best) best = value;
    } else if (kind === "Polygon") {
      if (booleanPointInPolygon(point, part as unknown as Feature<Polygon>)) return 0;
      for (const ring of (part as Feature<Polygon>).geometry.coordinates) {
        const value = planarPointLineDistance(point, ring);
        if (value < best) best = value;
      }
    }
  }
  return best;
}

/** 面积统计（平方米）。球面精确；平面坐标系按坐标平面计算。只统计面要素。 */
export function measureAreas(collection: MapCollection, planarUnitToMeter: PlanarUnit = null): MeasureResult {
  const planar = typeof planarUnitToMeter === "number" && Number.isFinite(planarUnitToMeter);
  const factor = planar ? (planarUnitToMeter as number) ** 2 : 1;
  const values: number[] = [];
  const notes: string[] = [];
  let skipped = 0;
  for (const feature of collection.features) {
    if (!feature.geometry || !safeValid(feature)) {
      skipped += 1;
      continue;
    }
    const kind = feature.geometry.type;
    if (kind !== "Polygon" && kind !== "MultiPolygon") {
      skipped += 1;
      continue;
    }
    values.push(planar ? planarGeometryArea(feature.geometry) * factor : turfArea(feature as Feature));
  }
  if (skipped > 0) notes.push(`跳过 ${skipped} 个非面或无效要素。`);
  return { stats: statsOf(values), skipped, notes };
}

/** 长度统计（米）：线要素长度；面要素周长单独统计。球面精确；平面坐标系按坐标平面计算。 */
export function measureLengths(collection: MapCollection, planarUnitToMeter: PlanarUnit = null): MeasureResult {
  const planar = typeof planarUnitToMeter === "number" && Number.isFinite(planarUnitToMeter);
  const factor = planar ? (planarUnitToMeter as number) : 1;
  const lineValues: number[] = [];
  const perimeterValues: number[] = [];
  const notes: string[] = [];
  let skipped = 0;
  for (const feature of collection.features) {
    if (!feature.geometry || !safeValid(feature)) {
      skipped += 1;
      continue;
    }
    const kind = feature.geometry.type;
    if (kind === "LineString" || kind === "MultiLineString") {
      if (planar) {
        for (const part of flatten(feature as Feature).features) {
          if (part.geometry?.type === "LineString") {
            lineValues.push(planarCoordsLength((part as Feature<LineString>).geometry.coordinates) * factor);
          }
        }
      } else {
        lineValues.push(turfLength(feature as Feature) * 1000);
      }
      continue;
    }
    if (kind === "Polygon" || kind === "MultiPolygon") {
      if (planar) {
        for (const part of flatten(feature as Feature).features) {
          if (part.geometry?.type !== "Polygon") continue;
          for (const ring of (part as Feature<Polygon>).geometry.coordinates) {
            perimeterValues.push(planarCoordsLength(ring) * factor);
          }
        }
      } else {
        try {
          const boundary = polygonToLine(feature as unknown as Feature<Polygon | MultiPolygon>);
          for (const part of flatten(boundary).features) {
            if (part.geometry?.type === "LineString" || part.geometry?.type === "MultiLineString") {
              perimeterValues.push(turfLength(part as Feature) * 1000);
            }
          }
        } catch {
          skipped += 1;
        }
      }
      continue;
    }
    skipped += 1;
  }
  if (skipped > 0) notes.push(`跳过 ${skipped} 个点或无效要素。`);
  return {
    stats: statsOf(lineValues),
    ...(statsOf(perimeterValues) ? { secondary: statsOf(perimeterValues) as NumberStats } : {}),
    skipped,
    notes,
  };
}

/** 点到要素的最短距离（米）。点在面内为 0。Multi* 取各部分最小。平面坐标系按坐标平面计算。 */
export function distanceToGeometry(point: Position, feature: MapFeature, planarUnitToMeter: PlanarUnit = null): number {
  if (!feature.geometry) return Number.POSITIVE_INFINITY;
  if (typeof planarUnitToMeter === "number" && Number.isFinite(planarUnitToMeter)) {
    return planarDistanceToGeometry(point, feature.geometry) * planarUnitToMeter;
  }
  let best = Number.POSITIVE_INFINITY;
  for (const part of flatten(feature as Feature).features) {
    const kind = part.geometry?.type ?? "";
    if (kind === "Point") {
      const coords = (part as Feature<Point>).geometry.coordinates;
      const meters = turfDistance(point, coords) * 1000;
      if (meters < best) best = meters;
    } else if (kind === "LineString") {
      const meters = pointToLineDistance(point, part as unknown as Feature<LineString>) * 1000;
      if (meters < best) best = meters;
    } else if (kind === "Polygon") {
      if (booleanPointInPolygon(point, part as unknown as Feature<Polygon>)) return 0;
      try {
        const boundary = polygonToLine(part as unknown as Feature<Polygon>);
        for (const line of flatten(boundary).features) {
          if (line.geometry?.type !== "LineString") continue;
          const meters = pointToLineDistance(point, line as unknown as Feature<LineString>) * 1000;
          if (meters < best) best = meters;
        }
      } catch {
        // 边界转换失败时跳过这个部分。
      }
    }
  }
  return best;
}

/**
 * 逐要素最近距离（米）：A 按要素代表点（点要素用原坐标）到 B 的最短距离。
 * 点图层为精确值；线/面 A 侧为代表点近似——语义写进工具描述，不假装是精确边界距离。
 */
export function nearestDistances(primary: MapCollection, secondary: MapCollection, planarUnitToMeter: PlanarUnit = null): { readonly distances: number[]; readonly unmatched: number } {
  const distances: number[] = [];
  let unmatched = 0;
  for (const feature of primary.features) {
    if (!feature.geometry || !safeValid(feature)) {
      unmatched += 1;
      continue;
    }
    const point: Position = feature.geometry.type === "Point"
      ? (feature as Feature<Point>).geometry.coordinates
      : pointOnFeature(feature as Feature).geometry.coordinates;
    let best = Number.POSITIVE_INFINITY;
    for (const other of secondary.features) {
      if (!other.geometry || !safeValid(other)) continue;
      const meters = distanceToGeometry(point, other, planarUnitToMeter);
      if (meters < best) best = meters;
    }
    if (!Number.isFinite(best)) unmatched += 1;
    else distances.push(best);
  }
  return { distances, unmatched };
}

/** 给 A 每个要素打上 _dist（到 B 的最近距离，米）。 */
export function nearestFeatures(primary: MapCollection, secondary: MapCollection, planarUnitToMeter: PlanarUnit = null): OpResult {
  const features: MapFeature[] = [];
  const notes: string[] = ["线/面输入按要素代表点计算最近距离。"];
  let skipped = 0;
  for (const feature of primary.features) {
    if (!feature.geometry || !safeValid(feature)) {
      skipped += 1;
      continue;
    }
    const point: Position = feature.geometry.type === "Point"
      ? (feature as Feature<Point>).geometry.coordinates
      : pointOnFeature(feature as Feature).geometry.coordinates;
    let best = Number.POSITIVE_INFINITY;
    for (const other of secondary.features) {
      if (!other.geometry || !safeValid(other)) continue;
      const meters = distanceToGeometry(point, other, planarUnitToMeter);
      if (meters < best) best = meters;
    }
    if (!Number.isFinite(best)) {
      skipped += 1;
      continue;
    }
    const next = stampFeature(feature as Feature, { ...feature.properties, _dist: Math.round(best * 100) / 100 }, features.length);
    if (next) features.push(next);
  }
  return finishResult(features, skipped, primary.features.length, notes);
}

/** 几何转换：线→面（自动闭合）/ 面→线。 */
export function convertFeatures(collection: MapCollection, target: "polygon" | "line"): OpResult {
  const features: MapFeature[] = [];
  const notes: string[] = [];
  let skipped = 0;
  for (const feature of collection.features) {
    if (!feature.geometry || !safeValid(feature)) {
      skipped += 1;
      continue;
    }
    const kind = feature.geometry.type;
    try {
      let pieces: Feature[] = [];
      if (target === "polygon") {
        if (kind === "LineString" || kind === "MultiLineString") {
          pieces = [lineToPolygon(feature as unknown as Feature<LineString | MultiLineString>) as Feature];
        } else {
          notes.push("已是面或点要素，未转换。");
          skipped += 1;
        }
      } else {
        if (kind === "Polygon" || kind === "MultiPolygon") {
          const converted = polygonToLine(feature as unknown as Feature<Polygon | MultiPolygon>);
          pieces = converted.type === "FeatureCollection" ? [...converted.features] : [converted as Feature];
        } else {
          notes.push("已是线或点要素，未转换。");
          skipped += 1;
        }
      }
      for (const piece of pieces) {
        const next = stampFeature(piece, feature.properties, features.length);
        if (next) features.push(next);
      }
    } catch {
      skipped += 1;
    }
  }
  return finishResult(features, skipped, collection.features.length, notes);
}

/** 面融合：全部或按字段分组，各组融合成一个面要素。 */
export function dissolveFeatures(collection: MapCollection, groupField: string | null): OpResult {
  const groups = new Map<string, MapFeature[]>();
  const notes: string[] = [];
  let skipped = 0;
  for (const feature of collection.features) {
    if (!feature.geometry || !safeValid(feature)) {
      skipped += 1;
      continue;
    }
    const kind = feature.geometry.type;
    if (kind !== "Polygon" && kind !== "MultiPolygon") {
      skipped += 1;
      continue;
    }
    const key = groupField ? String(feature.properties[groupField] ?? "（空）") : "__all__";
    const bucket = groups.get(key) ?? [];
    bucket.push(feature);
    groups.set(key, bucket);
  }
  const features: MapFeature[] = [];
  for (const [key, bucket] of groups) {
    try {
      const merged = unionMask({ type: "FeatureCollection", features: bucket });
      const properties = groupField ? { [groupField]: key } : { dissolve: "all" };
      const next = stampFeature(merged, properties, features.length);
      if (next) features.push(next);
    } catch {
      skipped += bucket.length;
      notes.push(`分组「${key}」无法融合，已跳过。`);
    }
  }
  return finishResult(features, skipped, collection.features.length, notes);
}

/** 同类型图层合并。两个图层几何类型不同直接拒绝。 */
export function mergeFeatures(primary: MapCollection, secondary: MapCollection): OpResult {
  const kindsOf = (collection: MapCollection): string => {
    const kinds = new Set<string>();
    for (const feature of collection.features) {
      if (feature.geometry?.type) kinds.add(feature.geometry.type);
    }
    return [...kinds].sort().join(",");
  };
  const leftKinds = kindsOf(primary);
  const rightKinds = kindsOf(secondary);
  if (leftKinds !== rightKinds) {
    throw new SpatialOpError(`两个图层的几何类型不同（${leftKinds || "空"} / ${rightKinds || "空"}），不能合并。`);
  }
  const features: MapFeature[] = [];
  const notes: string[] = [];
  let skipped = 0;
  for (const feature of [...primary.features, ...secondary.features]) {
    if (!feature.geometry || !safeValid(feature)) {
      skipped += 1;
      continue;
    }
    const next = stampFeature(feature as Feature, feature.properties, features.length);
    if (next) features.push(next);
    else skipped += 1;
  }
  return finishResult(features, skipped, primary.features.length + secondary.features.length, notes);
}

/** 解析重分类映射："源=目标;源=目标"（分号或 | 分隔）。 */
export function parseReclassifyMapping(text: string): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const part of text.split(/[;；|]/)) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) throw new SpatialOpError("重分类映射格式是「源=目标」，用分号分隔，例如 1=耕地;2=林地。");
    const from = trimmed.slice(0, index).trim();
    const to = trimmed.slice(index + 1).trim();
    if (from === "" || to === "") throw new SpatialOpError("重分类映射格式是「源=目标」，用分号分隔，例如 1=耕地;2=林地。");
    mapping[from] = to;
  }
  if (Object.keys(mapping).length === 0) throw new SpatialOpError("重分类需要至少一条「源=目标」映射。");
  return mapping;
}

/** 字段重分类：按映射表替换字段值。目标是数字文本且原值是数字时保持数字。 */
export function reclassifyFeatures(collection: MapCollection, fieldName: string, mapping: Record<string, string>): OpResult {
  const features: MapFeature[] = [];
  let matched = 0;
  let skipped = 0;
  for (const feature of collection.features) {
    if (!feature.geometry || !safeValid(feature)) {
      skipped += 1;
      continue;
    }
    const raw = feature.properties[fieldName];
    const from = raw === null || raw === undefined ? "" : String(raw);
    const to = mapping[from];
    const properties: Record<string, string | number | boolean | null> = { ...feature.properties };
    if (to !== undefined) {
      const asNumber = Number(to);
      properties[fieldName] = typeof raw === "number" && Number.isFinite(asNumber) ? asNumber : to;
      matched += 1;
    }
    const next = stampFeature(feature as Feature, properties, features.length);
    if (next) features.push(next);
    else skipped += 1;
  }
  return finishResult(features, skipped, collection.features.length, [`映射命中 ${matched} 个要素。`]);
}

export interface GroupStatRow {
  readonly group: string;
  readonly count: number;
  readonly sum: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly mean: number;
}

/** 分组统计：按 groupField 分组，统计 fieldName 的数值。 */
export function groupStatsFeatures(collection: MapCollection, groupField: string, fieldName: string): { readonly rows: readonly GroupStatRow[]; readonly truncated: boolean } {
  const groups = new Map<string, number[]>();
  for (const feature of collection.features) {
    const value = numericValue(feature.properties[fieldName]);
    if (value === null) continue;
    const key = String(feature.properties[groupField] ?? "（空）");
    const bucket = groups.get(key) ?? [];
    bucket.push(value);
    groups.set(key, bucket);
  }
  const truncated = groups.size > 50;
  const rows: GroupStatRow[] = [];
  for (const [group, values] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(0, 50)) {
    const stats = statsOf(values);
    if (stats) rows.push({ group, ...stats });
  }
  return { rows, truncated };
}

export interface FieldQuality {
  readonly fieldName: string;
  readonly nullCount: number;
  readonly emptyCount: number;
  readonly distinct: number;
  readonly distinctCapped: boolean;
  readonly numericMinimum: number | null;
  readonly numericMaximum: number | null;
}

/** 数据质量检查：空值/空串/去重计数/数值值域。只出标量，不出值内容。 */
export function qualityCheckFeatures(collection: MapCollection): { readonly fields: readonly FieldQuality[]; readonly fieldCount: number } {
  const names = new Set<string>();
  for (const feature of collection.features) {
    for (const key of Object.keys(feature.properties ?? {})) names.add(key);
  }
  const limited = [...names].sort().slice(0, 30);
  const fields: FieldQuality[] = limited.map((fieldName) => {
    let nullCount = 0;
    let emptyCount = 0;
    let numericMinimum: number | null = null;
    let numericMaximum: number | null = null;
    const distinct = new Set<string>();
    let distinctCapped = false;
    for (const feature of collection.features) {
      const raw = feature.properties?.[fieldName];
      if (raw === null || raw === undefined) {
        nullCount += 1;
        continue;
      }
      if (typeof raw === "string" && raw.trim() === "") {
        emptyCount += 1;
        continue;
      }
      const numeric = numericValue(raw);
      if (numeric !== null) {
        if (numericMinimum === null || numeric < numericMinimum) numericMinimum = numeric;
        if (numericMaximum === null || numeric > numericMaximum) numericMaximum = numeric;
      }
      if (!distinctCapped) {
        distinct.add(String(raw));
        if (distinct.size > 2000) distinctCapped = true;
      }
    }
    return {
      fieldName,
      nullCount,
      emptyCount,
      distinct: distinct.size,
      distinctCapped,
      numericMinimum,
      numericMaximum,
    };
  });
  return { fields, fieldCount: names.size };
}

/**
 * 格网分幅：把图层范围切成 columns×rows 幅，逐幅裁剪，结果带 _sheet 字段（行-列，1 起）。
 * 一个要素跨幅时在多幅各留一份。列/行各 1-6，最多 36 幅。
 */
export function splitGridFeatures(collection: MapCollection, columns: number, rows: number): OpResult {
  if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1 || columns > 6 || rows > 6) {
    throw new SpatialOpError("分幅的列数和行数必须是 1 到 6 的整数。");
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      const first = value[0];
      const second = value[1];
      if (typeof first === "number" && typeof second === "number") {
        minX = Math.min(minX, first);
        maxX = Math.max(maxX, first);
        minY = Math.min(minY, second);
        maxY = Math.max(maxY, second);
        return;
      }
      for (const item of value) visit(item);
      return;
    }
    if (value !== null && typeof value === "object" && "type" in value) {
      visit((value as { coordinates?: unknown }).coordinates);
    }
  };
  for (const feature of collection.features) visit(feature.geometry);
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) throw new SpatialOpError("图层没有可用坐标范围，无法分幅。");
  const cellWidth = (maxX - minX) / columns || 1;
  const cellHeight = (maxY - minY) / rows || 1;
  const features: MapFeature[] = [];
  const notes: string[] = [];
  const filledSheets = new Set<string>();
  let skipped = 0;
  for (const feature of collection.features) {
    if (!feature.geometry || !safeValid(feature)) {
      skipped += 1;
      continue;
    }
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const x0 = minX + column * cellWidth;
        const y0 = minY + row * cellHeight;
        const x1 = column === columns - 1 ? maxX + 1e-9 : minX + (column + 1) * cellWidth;
        const y1 = row === rows - 1 ? maxY + 1e-9 : minY + (row + 1) * cellHeight;
        const cell: MapCollection = {
          type: "FeatureCollection",
          features: [{
            type: "Feature",
            properties: {},
            geometry: { type: "Polygon", coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] },
          }],
        };
        try {
          const clipped = clipFeatures({ type: "FeatureCollection", features: [feature] }, cell);
          for (const piece of clipped.collection.features) {
            const sheet = `${row + 1}-${column + 1}`;
            const next = stampFeature(piece as Feature, { ...piece.properties, _sheet: sheet }, features.length);
            if (next) {
              features.push(next);
              filledSheets.add(sheet);
            }
          }
        } catch {
          // 与本幅不相交或裁剪失败：这一幅跳过该要素。
        }
      }
    }
  }
  notes.push(`共 ${columns * rows} 幅，其中 ${filledSheets.size} 幅有内容。`);
  return finishResult(features, skipped, collection.features.length, notes);
}

/* ---------------- 能力族：几何构造 / 方位 ---------------- */

/** 点图层 Voronoi 剖分：每点一个泰森多边形面。非点要素跳过。 */
export function voronoiFeatures(collection: MapCollection): OpResult {
  const points: MapFeature[] = [];
  const notes: string[] = [];
  let skipped = 0;
  for (const feature of collection.features) {
    if (!feature.geometry || !safeValid(feature)) {
      skipped += 1;
      continue;
    }
    if (feature.geometry.type !== "Point") {
      skipped += 1;
      continue;
    }
    points.push(feature);
  }
  if (points.length < 2) throw new SpatialOpError("Voronoi 剖分至少需要 2 个点要素。");
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    const coords = (point.geometry as { coordinates: Position }).coordinates;
    const x = coords[0] ?? 0;
    const y = coords[1] ?? 0;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const padX = (maxX - minX || 1) * 0.1;
  const padY = (maxY - minY || 1) * 0.1;
  const diagram = turfVoronoi({ type: "FeatureCollection", features: points } as never, {
    bbox: [minX - padX, minY - padY, maxX + padX, maxY + padY],
  });
  const features: MapFeature[] = [];
  for (const cell of diagram?.features ?? []) {
    if (!cell.geometry) continue;
    const source = points[features.length];
    const next = stampFeature(cell as Feature, source?.properties ?? {}, features.length);
    if (next) features.push(next);
  }
  return finishResult(features, skipped, collection.features.length, notes);
}

/** 凸包：整个图层一个凸包面。点数不足 3 时拒绝。 */
export function convexHullFeatures(collection: MapCollection): OpResult {
  const hull = turfConvex({ type: "FeatureCollection", features: collection.features.filter((feature) => feature.geometry && safeValid(feature)) } as never);
  if (!hull) throw new SpatialOpError("无法计算凸包：请检查要素数量与几何。");
  const next = stampFeature(hull as Feature, { hull: "convex" }, 0);
  return finishResult(next ? [next] : [], 0, collection.features.length, []);
}

/** 逐要素最小外接矩形（旋转卡壳，平面近似）。点要素退化为点矩形。 */
export function minBBoxFeatures(collection: MapCollection): OpResult {
  const features: MapFeature[] = [];
  const notes: string[] = ["最小外接矩形按坐标平面近似计算。"];
  let skipped = 0;
  for (const feature of collection.features) {
    if (!feature.geometry || !safeValid(feature)) {
      skipped += 1;
      continue;
    }
    const corners = minBoundingBox(feature);
    if (!corners) {
      skipped += 1;
      continue;
    }
    const next = stampFeature(
      { type: "Feature", properties: feature.properties, geometry: { type: "Polygon", coordinates: [corners] } } as Feature,
      feature.properties,
      features.length,
    );
    if (next) features.push(next);
  }
  return finishResult(features, skipped, collection.features.length, notes);
}

function minBoundingBox(feature: MapFeature): Position[] | null {
  const ring = turfConvex({
    type: "FeatureCollection",
    features: [feature],
  } as never);
  let points: Position[] = [];
  if (ring?.geometry) {
    const coords = ring.geometry.coordinates[0] ?? [];
    points = coords.slice(0, -1) as Position[];
  } else {
    for (const part of flatten(feature as Feature).features) {
      if (part.geometry?.type === "Point") points.push((part as Feature<Point>).geometry.coordinates);
    }
  }
  if (points.length === 0) return null;
  let best: { area: number; corners: Position[] } | null = null;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index] ?? [0, 0];
    const b = points[(index + 1) % points.length] ?? [0, 0];
    const angle = Math.atan2((b[1] ?? 0) - (a[1] ?? 0), (b[0] ?? 0) - (a[0] ?? 0));
    const cos = Math.cos(-angle);
    const sin = Math.sin(-angle);
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const point of points) {
      const x = point[0] ?? 0;
      const y = point[1] ?? 0;
      const rx = x * cos - y * sin;
      const ry = x * sin + y * cos;
      minX = Math.min(minX, rx);
      maxX = Math.max(maxX, rx);
      minY = Math.min(minY, ry);
      maxY = Math.max(maxY, ry);
    }
    const area = (maxX - minX) * (maxY - minY);
    if (best === null || area < best.area) {
      const cosBack = Math.cos(angle);
      const sinBack = Math.sin(angle);
      const corners: Position[] = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]].map(([rx, ry]) => [
        (rx ?? 0) * cosBack - (ry ?? 0) * sinBack,
        (rx ?? 0) * sinBack + (ry ?? 0) * cosBack,
      ]);
      best = { area, corners: [...corners, corners[0] as Position] };
    }
  }
  return best?.corners ?? null;
}

/** 逐要素质心（点图层）。 */
export function centroidFeatures(collection: MapCollection): OpResult {
  const features: MapFeature[] = [];
  let skipped = 0;
  for (const feature of collection.features) {
    if (!feature.geometry || !safeValid(feature)) {
      skipped += 1;
      continue;
    }
    const center = turfCentroid(feature as Feature);
    const next = stampFeature(center as Feature, feature.properties, features.length);
    if (next) features.push(next);
    else skipped += 1;
  }
  return finishResult(features, skipped, collection.features.length, []);
}

/**
 * 逐要素方位角标注（度 0-360）：A 代表点 → 最近 B 要素代表点。
 * 与 nearest 同一代表点语义；点图层 A 用原坐标。
 */
export function bearingFeatures(primary: MapCollection, secondary: MapCollection): OpResult {
  const features: MapFeature[] = [];
  const notes: string[] = ["方位角按要素代表点计算（度，正北为 0）。"];
  let skipped = 0;
  for (const feature of primary.features) {
    if (!feature.geometry || !safeValid(feature)) {
      skipped += 1;
      continue;
    }
    const from: Position = feature.geometry.type === "Point"
      ? (feature as Feature<Point>).geometry.coordinates
      : pointOnFeature(feature as Feature).geometry.coordinates;
    let best = Number.POSITIVE_INFINITY;
    let target: Position | null = null;
    for (const other of secondary.features) {
      if (!other.geometry || !safeValid(other)) continue;
      const to: Position = other.geometry.type === "Point"
        ? (other as Feature<Point>).geometry.coordinates
        : pointOnFeature(other as Feature).geometry.coordinates;
      const meters = turfDistance(from, to) * 1000;
      if (meters < best) {
        best = meters;
        target = to;
      }
    }
    if (!target) {
      skipped += 1;
      continue;
    }
    const degrees = ((turfBearing(from, target) % 360) + 360) % 360;
    const next = stampFeature(feature as Feature, { ...feature.properties, _bearing: Math.round(degrees * 100) / 100 }, features.length);
    if (next) features.push(next);
  }
  return finishResult(features, skipped, primary.features.length, notes);
}

/* ---------------- 能力族：分割 / 空间聚合 / 距离矩阵 / 精确最近 ---------------- */

/** 点分割线：B 的点把 A 的线切成多段。点不在线上时按最近位置切。 */
export function splitLineAtPoints(lines: MapCollection, points: MapCollection): OpResult {
  const features: MapFeature[] = [];
  const notes: string[] = [];
  let skipped = 0;
  const splitterPoints: Position[] = [];
  for (const feature of points.features) {
    if (!feature.geometry || !safeValid(feature)) continue;
    for (const part of flatten(feature as Feature).features) {
      if (part.geometry?.type === "Point") splitterPoints.push((part as Feature<Point>).geometry.coordinates);
    }
  }
  if (splitterPoints.length === 0) throw new SpatialOpError("点分割线需要至少 1 个分割点。");
  for (const feature of lines.features) {
    if (!feature.geometry || !safeValid(feature)) {
      skipped += 1;
      continue;
    }
    const kind = feature.geometry.type;
    if (kind !== "LineString" && kind !== "MultiLineString") {
      skipped += 1;
      continue;
    }
    let pieces = 0;
    for (const part of flatten(feature as Feature).features) {
      if (part.geometry?.type !== "LineString") continue;
      let segments: Feature[] = [part as Feature];
      for (const position of splitterPoints) {
        const splitter = { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: position } } as Feature;
        const next: Feature[] = [];
        for (const segment of segments) {
          try {
            const cut = lineSplit(segment as never, splitter as never);
            if (cut && cut.features.length > 0) next.push(...cut.features);
            else next.push(segment);
          } catch {
            next.push(segment);
          }
        }
        segments = next;
      }
      for (const segment of segments) {
        const next = stampFeature(segment, feature.properties, features.length);
        if (next) {
          features.push(next);
          pieces += 1;
        }
      }
    }
    if (pieces <= 1) notes.push(`有线要素没有被分割点切开（点可能不在线上）。`);
  }
  return finishResult(features, skipped, lines.features.length, notes);
}

/** 面或线的每个坐标变成一个点。环上重复存储的闭合点会各成一点。 */
export function verticesToPoints(collection: MapCollection): OpResult {
  const features: MapFeature[] = [];
  const notes: string[] = ["每个节点一个点。环上重复的闭合点会各保留一点。"];
  let skipped = 0;
  for (const feature of collection.features) {
    if (!feature.geometry || !safeValid(feature)) {
      skipped += 1;
      continue;
    }
    const kind = feature.geometry.type;
    if (kind !== "Polygon" && kind !== "MultiPolygon" && kind !== "LineString" && kind !== "MultiLineString") {
      skipped += 1;
      continue;
    }
    let exploded: ReturnType<typeof turfExplode>;
    try {
      exploded = turfExplode(feature as Feature);
    } catch {
      skipped += 1;
      continue;
    }
    for (const point of exploded.features) {
      if (point.geometry?.type !== "Point") continue;
      const next = stampFeature(point as Feature, feature.properties, features.length);
      if (next) features.push(next);
    }
  }
  return finishResult(features, skipped, collection.features.length, notes);
}

/** 多部件拆分：Multi* 拆成单部件，单部件原样保留。 */
export function explodeParts(collection: MapCollection): OpResult {
  const features: MapFeature[] = [];
  const notes: string[] = [];
  let skipped = 0;
  let splitCount = 0;
  for (const feature of collection.features) {
    if (!feature.geometry || !safeValid(feature)) {
      skipped += 1;
      continue;
    }
    const parts = flatten(feature as Feature).features;
    if (parts.length > 1) splitCount += 1;
    for (const part of parts) {
      const next = stampFeature(part as Feature, feature.properties, features.length);
      if (next) features.push(next);
    }
  }
  notes.push(`拆出 ${features.length} 个单部件，其中 ${splitCount} 个源要素被拆开。`);
  return finishResult(features, skipped, collection.features.length, notes);
}

/** 线分割面：B 的线网把 A 的面切成多块（节点化后 polygonize，保留落在原面内的块）。 */
export function splitPolygonByLine(polygons: MapCollection, cutLines: MapCollection): OpResult {
  const features: MapFeature[] = [];
  const notes: string[] = [];
  let skipped = 0;
  const cuts: Feature[] = [];
  for (const feature of cutLines.features) {
    if (!feature.geometry || !safeValid(feature)) continue;
    for (const part of flatten(feature as Feature).features) {
      if (part.geometry?.type === "LineString") cuts.push(part as Feature);
    }
  }
  if (cuts.length === 0) throw new SpatialOpError("线分割面需要至少 1 条分割线。");
  for (const feature of polygons.features) {
    if (!feature.geometry || !safeValid(feature)) {
      skipped += 1;
      continue;
    }
    const kind = feature.geometry.type;
    if (kind !== "Polygon" && kind !== "MultiPolygon") {
      skipped += 1;
      continue;
    }
    let pieces = 0;
    for (const part of flatten(feature as Feature).features) {
      if (part.geometry?.type !== "Polygon") continue;
      const boundary = polygonToLine(part as unknown as Feature<Polygon>);
      const lines: Feature[] = [];
      for (const line of flatten(boundary).features) {
        if (line.geometry?.type === "LineString") lines.push(line as Feature);
      }
      const inside = (candidate: Feature): boolean => {
        const center = turfCentroid(candidate as Feature);
        return booleanPointInPolygon(center as never, part as unknown as Feature<Polygon>);
      };
      const network = [...lines, ...cuts];
      const nodes: Position[] = [];
      for (let i = 0; i < network.length; i += 1) {
        for (let j = i + 1; j < network.length; j += 1) {
          const hit = lineIntersect(network[i] as never, network[j] as never);
          for (const point of hit.features) nodes.push(point.geometry.coordinates);
        }
      }
      const nodeSplitter = nodes.length > 0 ? multiPoint(nodes) : null;
      const segments: Feature[] = [];
      for (const line of network) {
        if (!nodeSplitter) {
          segments.push(line);
          continue;
        }
        try {
          const cut = lineSplit(line as never, nodeSplitter as never);
          if (cut && cut.features.length > 0) segments.push(...cut.features);
          else segments.push(line);
        } catch {
          segments.push(line);
        }
      }
      let blocks: Feature[] = [];
      try {
        const merged = polygonize({ type: "FeatureCollection", features: segments } as never);
        blocks = (merged?.features ?? []).filter((item) => inside(item));
      } catch {
        blocks = [];
      }
      for (const block of blocks) {
        const next = stampFeature(block as Feature, feature.properties, features.length);
        if (next) {
          features.push(next);
          pieces += 1;
        }
      }
    }
    if (pieces === 0) {
      skipped += 1;
      notes.push("有面要素没有被分割线切开（线可能不穿过面）。");
    }
  }
  return finishResult(features, skipped, polygons.features.length, notes);
}

export interface SpatialAggregateRow {
  readonly group: string;
  readonly count: number;
  readonly sum: number | null;
  readonly mean: number | null;
}

/** 空间聚合：B 的点落进 A 的面，逐面计数并按可选数值字段求和/均值。输出图层 + 摘要。 */
export function spatialAggregate(
  polygons: MapCollection,
  points: MapCollection,
  fieldName: string | null,
): { readonly result: OpResult; readonly rows: readonly SpatialAggregateRow[] } {
  const features: MapFeature[] = [];
  const rows: SpatialAggregateRow[] = [];
  const notes: string[] = [];
  let skipped = 0;
  const validPoints: MapFeature[] = [];
  for (const feature of points.features) {
    if (!feature.geometry || !safeValid(feature)) continue;
    for (const part of flatten(feature as Feature).features) {
      if (part.geometry?.type === "Point") validPoints.push(part as unknown as MapFeature);
    }
  }
  for (const feature of polygons.features) {
    if (!feature.geometry || !safeValid(feature)) {
      skipped += 1;
      continue;
    }
    const kind = feature.geometry.type;
    if (kind !== "Polygon" && kind !== "MultiPolygon") {
      skipped += 1;
      continue;
    }
    let count = 0;
    const values: number[] = [];
    for (const point of validPoints) {
      const coords = (point.geometry as unknown as { coordinates: Position }).coordinates;
      if (!booleanPointInPolygon(coords as never, feature as unknown as Feature<Polygon>)) continue;
      count += 1;
      if (fieldName) {
        const value = numericValue((point.properties as Record<string, unknown> | null | undefined)?.[fieldName]);
        if (value !== null) values.push(value);
      }
    }
    const sum = values.length > 0 ? values.reduce((total, value) => total + value, 0) : null;
    const mean = values.length > 0 ? sum !== null ? sum / values.length : null : null;
    const group = typeof feature.properties?.[fieldName ?? ""] === "string" ? String(feature.properties[fieldName ?? ""]) : `要素${features.length + 1}`;
    rows.push({ group, count, sum, mean });
    const next = stampFeature(feature as Feature, {
      ...feature.properties,
      _count: count,
      ...(sum !== null ? { _sum: Math.round(sum * 100) / 100 } : {}),
      ...(mean !== null ? { _mean: Math.round(mean * 100) / 100 } : {}),
    }, features.length);
    if (next) features.push(next);
  }
  notes.push(`聚合 ${rows.length} 个面，点总数 ${validPoints.length}。`);
  return { result: finishResult(features, skipped, polygons.features.length, notes), rows };
}

/** 距离矩阵：A 每要素代表点到 B 每要素的最短距离（米）。超过上限直接拒绝。 */
export function distanceMatrix(
  primary: MapCollection,
  secondary: MapCollection,
  limit: number,
  planarUnitToMeter: PlanarUnit = null,
): { readonly matrix: readonly (readonly number[])[]; readonly unmatched: number } {
  const rows = primary.features.length;
  const columns = secondary.features.length;
  if (rows * columns > limit) {
    throw new SpatialOpError(`距离矩阵规模 ${rows}×${columns} 超过上限 ${limit}。请先筛选或分组后再算。`);
  }
  const matrix: number[][] = [];
  let unmatched = 0;
  for (const feature of primary.features) {
    const row: number[] = [];
    if (!feature.geometry || !safeValid(feature)) {
      unmatched += 1;
      matrix.push(row);
      continue;
    }
    const point: Position = feature.geometry.type === "Point"
      ? (feature as Feature<Point>).geometry.coordinates
      : pointOnFeature(feature as Feature).geometry.coordinates;
    for (const other of secondary.features) {
      if (!other.geometry || !safeValid(other)) {
        row.push(Number.NaN);
        continue;
      }
      row.push(distanceToGeometry(point, other, planarUnitToMeter));
    }
    matrix.push(row);
  }
  return { matrix, unmatched };
}

/** 精确最近距离：A 每要素按全部顶点到 B、B 每个顶点到 A 双向采样取最短（米），优于单代表点。 */
export function nearestVertexFeatures(primary: MapCollection, secondary: MapCollection, planarUnitToMeter: PlanarUnit = null): OpResult {
  const features: MapFeature[] = [];
  const notes: string[] = ["最近距离按双方全部顶点采样计算，线/面之间为顶点采样下界近似。"];
  let skipped = 0;
  for (const feature of primary.features) {
    if (!feature.geometry || !safeValid(feature)) {
      skipped += 1;
      continue;
    }
    const vertices: Position[] = [];
    walkPositions((feature.geometry as { coordinates?: unknown }).coordinates, (position) => vertices.push(position));
    if (vertices.length === 0) {
      skipped += 1;
      continue;
    }
    let best = Number.POSITIVE_INFINITY;
    for (const vertex of vertices) {
      for (const other of secondary.features) {
        if (!other.geometry || !safeValid(other)) continue;
        const meters = distanceToGeometry(vertex, other, planarUnitToMeter);
        if (meters < best) best = meters;
      }
    }
    // 反向：B 的顶点到 A 的几何最短距离（B 是点时得到点到线/面的精确值）。
    for (const other of secondary.features) {
      if (!other.geometry || !safeValid(other)) continue;
      const otherVertices: Position[] = [];
      walkPositions((other.geometry as { coordinates?: unknown }).coordinates, (position) => otherVertices.push(position));
      for (const vertex of otherVertices) {
        const meters = distanceToGeometry(vertex, feature, planarUnitToMeter);
        if (meters < best) best = meters;
      }
    }
    if (!Number.isFinite(best)) {
      skipped += 1;
      continue;
    }
    const next = stampFeature(feature as Feature, { ...feature.properties, _dist: Math.round(best * 100) / 100 }, features.length);
    if (next) features.push(next);
  }
  return finishResult(features, skipped, primary.features.length, notes);
}

function walkPositions(value: unknown, visit: (position: Position) => void): void {
  if (!Array.isArray(value)) return;
  if (typeof value[0] === "number" && typeof value[1] === "number") {
    visit(value as Position);
    return;
  }
  for (const item of value) walkPositions(item, visit);
}

/** 两组线（或面边界）的交点。只给一组时求它自己的交点。 */
export function lineIntersectFeatures(primary: MapCollection, secondary: MapCollection | null): OpResult {
  const other = secondary ?? primary;
  let crossed: ReturnType<typeof lineIntersect>;
  try {
    crossed = lineIntersect(primary as never, other as never);
  } catch {
    throw new SpatialOpError("求交点需要线，或面的边界。");
  }
  const features: MapFeature[] = [];
  for (const point of crossed.features) {
    if (point.geometry?.type !== "Point") continue;
    const next = stampFeature(point as Feature, point.properties ?? {}, features.length);
    if (next) features.push(next);
  }
  return finishResult(features, 0, primary.features.length, ["交点按原坐标写出。"]);
}

export interface TransformRequest {
  readonly kind: "translate" | "rotate" | "scale";
  readonly distance: number | null;
  readonly bearing: number | null;
  readonly angle: number | null;
  readonly factor: number | null;
  /** geographic：距离是米，走 transformTranslate。planar-meters：距离是米，按单位换到原坐标。coordinate：距离就是坐标单位。 */
  readonly distanceMode: "geographic" | "planar-meters" | "coordinate";
  readonly unitToMeter: number | null;
}

/** 在原坐标上平移、旋转或缩放。旋转和缩放用 Turf；经纬度上的平移用 transformTranslate。 */
export function transformFeatures(collection: MapCollection, request: TransformRequest): OpResult {
  if (request.kind === "rotate") {
    if (request.angle === null || !Number.isFinite(request.angle)) throw new SpatialOpError("旋转需要角度。");
    const rotated = transformRotate(collection as never, request.angle);
    return finishResult((rotated as { features: MapFeature[] }).features, 0, collection.features.length, ["绕中心按原坐标旋转。"]);
  }
  if (request.kind === "scale") {
    if (request.factor === null || !Number.isFinite(request.factor) || request.factor <= 0) {
      throw new SpatialOpError("缩放倍数必须大于 0。");
    }
    const scaled = transformScale(collection as never, request.factor);
    return finishResult((scaled as { features: MapFeature[] }).features, 0, collection.features.length, ["绕中心按原坐标缩放。"]);
  }
  if (request.distance === null || !Number.isFinite(request.distance)) throw new SpatialOpError("平移需要距离。");
  const bearing = request.bearing ?? 0;
  if (request.distanceMode === "geographic") {
    const moved = transformTranslate(collection as never, request.distance / 1000, bearing, { units: "kilometers" });
    return finishResult((moved as { features: MapFeature[] }).features, 0, collection.features.length, ["按米在经纬度上平移。"]);
  }
  const unit = request.distanceMode === "planar-meters" ? request.unitToMeter : 1;
  if (unit === null || !(unit > 0)) throw new SpatialOpError("这个平面坐标系没有可证明的长度单位，不能按米平移。");
  const step = request.distance / unit;
  const radians = bearing * Math.PI / 180;
  const dx = step * Math.sin(radians);
  const dy = step * Math.cos(radians);
  const features: MapFeature[] = [];
  for (const feature of collection.features) {
    if (!feature.geometry) continue;
    const geometry = feature.geometry as { type?: string; coordinates?: unknown };
    if (!geometry.coordinates) continue;
    const moved = {
      type: "Feature" as const,
      properties: feature.properties,
      geometry: offsetGeometry({ type: geometry.type ?? "Point", coordinates: geometry.coordinates }, dx, dy),
    };
    const next = stampFeature(moved as Feature, feature.properties, features.length);
    if (next) features.push(next);
  }
  const note = request.distanceMode === "coordinate" ? "平移距离是坐标单位，不是米。" : "按米换算到原坐标后平移。";
  return finishResult(features, 0, collection.features.length, [note]);
}

function offsetGeometry(geometry: { type: string; coordinates: unknown }, dx: number, dy: number): { type: string; coordinates: unknown } {
  return { type: geometry.type, coordinates: offsetPositions(geometry.coordinates, dx, dy) };
}

function offsetPositions(value: unknown, dx: number, dy: number): unknown {
  if (!Array.isArray(value)) return value;
  if (typeof value[0] === "number" && typeof value[1] === "number") {
    return [value[0] + dx, value[1] + dy, ...value.slice(2)];
  }
  return value.map((item) => offsetPositions(item, dx, dy));
}

function lineParts(feature: MapFeature): Feature<LineString>[] {
  if (!feature.geometry) return [];
  if (feature.geometry.type === "LineString") return [feature as Feature<LineString>];
  if (feature.geometry.type === "MultiLineString") {
    return flatten(feature as Feature).features.filter((part) => part.geometry?.type === "LineString") as Feature<LineString>[];
  }
  if (feature.geometry.type === "Polygon" || feature.geometry.type === "MultiPolygon") {
    try {
      const boundary = polygonToLine(feature as Feature<Polygon | MultiPolygon>);
      return flatten(boundary).features.filter((part) => part.geometry?.type === "LineString") as Feature<LineString>[];
    } catch {
      return [];
    }
  }
  return [];
}

/** 每个点落到线上的最近点。经纬度上的距离用 nearestPointOnLine 的结果；平面和未声明坐标系用原坐标距离。 */
export function nearestOnLineFeatures(
  points: MapCollection,
  lines: MapCollection,
  distanceMode: "geographic" | "planar-meters" | "coordinate",
  unitToMeter: number | null,
): OpResult {
  const linePieces = lines.features.flatMap((feature) => lineParts(feature));
  if (linePieces.length === 0) throw new SpatialOpError("垂足需要至少 1 条线，或一个面的边界。");
  const features: MapFeature[] = [];
  let skipped = 0;
  for (const feature of points.features) {
    if (!feature.geometry || feature.geometry.type !== "Point" || !safeValid(feature)) {
      skipped += 1;
      continue;
    }
    const origin = (feature as Feature<Point>).geometry.coordinates;
    let best: Feature<Point> | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const line of linePieces) {
      let hit: ReturnType<typeof nearestPointOnLine>;
      try {
        hit = nearestPointOnLine(line, origin, { units: "kilometers" });
      } catch {
        continue;
      }
      const footX = hit.geometry.coordinates[0] ?? origin[0] ?? 0;
      const footY = hit.geometry.coordinates[1] ?? origin[1] ?? 0;
      const originX = origin[0] ?? 0;
      const originY = origin[1] ?? 0;
      const turfMeters = (typeof hit.properties.dist === "number" ? hit.properties.dist : Number.POSITIVE_INFINITY) * 1000;
      const planar = Math.hypot(footX - originX, footY - originY);
      const distance = distanceMode === "geographic"
        ? turfMeters
        : distanceMode === "planar-meters"
          ? planar * (unitToMeter ?? Number.NaN)
          : planar;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = hit;
      }
    }
    if (!best || !Number.isFinite(bestDistance)) {
      skipped += 1;
      continue;
    }
    const next = stampFeature(best, { ...feature.properties, _dist: Math.round(bestDistance * 100) / 100 }, features.length);
    if (next) features.push(next);
  }
  const note = distanceMode === "coordinate"
    ? "_dist 是坐标单位，不是米。"
    : "_dist 是米。";
  return finishResult(features, skipped, points.features.length, [note]);
}

/** 按图层范围生成矩形格网。经纬度用 squareGrid，边长是米；其他坐标系在原坐标上画格。 */
export function gridFeatures(
  collection: MapCollection,
  cellSize: number,
  distanceMode: "geographic" | "planar-meters" | "coordinate",
  unitToMeter: number | null,
): OpResult {
  if (!Number.isFinite(cellSize) || cellSize <= 0) throw new SpatialOpError("格网边长必须大于 0。");
  const box = turfBbox(collection as never);
  if (distanceMode === "geographic") {
    const grid = squareGrid([box[0], box[1], box[2], box[3]], cellSize / 1000, { units: "kilometers" });
    if (grid.features.length > 10000) throw new SpatialOpError("格网数量超过 10000。请加大边长。");
    return finishResult(grid.features as MapFeature[], 0, collection.features.length, ["格网边长是米。"]);
  }
  const unit = distanceMode === "planar-meters" ? unitToMeter : 1;
  if (unit === null || !(unit > 0)) throw new SpatialOpError("这个平面坐标系没有可证明的长度单位，不能按米生成格网。");
  const cell = cellSize / unit;
  const minX = box[0] ?? 0;
  const minY = box[1] ?? 0;
  const maxX = box[2] ?? 0;
  const maxY = box[3] ?? 0;
  const width = maxX - minX;
  const height = maxY - minY;
  if (!(width > 0) || !(height > 0)) throw new SpatialOpError("图层没有可用范围。");
  const columns = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  if (!Number.isFinite(columns) || !Number.isFinite(rows) || columns * rows > 10000) {
    throw new SpatialOpError("格网数量超过 10000。请加大边长。");
  }
  const features: MapFeature[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x0 = minX + column * cell;
      const y0 = minY + row * cell;
      const x1 = Math.min(x0 + cell, maxX);
      const y1 = Math.min(y0 + cell, maxY);
      const polygon: Feature = {
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] },
      };
      const next = stampFeature(polygon, {}, features.length);
      if (next) features.push(next);
    }
  }
  const note = distanceMode === "coordinate" ? "格网边长是坐标单位，不是米。" : "格网边长按米换算到原坐标。";
  return finishResult(features, 0, collection.features.length, [note]);
}

type FieldExpr =
  | { readonly kind: "num"; readonly value: number }
  | { readonly kind: "str"; readonly value: string }
  | { readonly kind: "field"; readonly name: string }
  | { readonly kind: "neg"; readonly value: FieldExpr }
  | { readonly kind: "bin"; readonly op: "+" | "-" | "*" | "/" | "==" | "!=" | ">" | "<" | ">=" | "<="; readonly left: FieldExpr; readonly right: FieldExpr }
  | { readonly kind: "if"; readonly cond: FieldExpr; readonly yes: FieldExpr; readonly no: FieldExpr };

/** 窄字段计算：加减乘除、比较和 if。只用已有字段和常数，不执行脚本。 */
export function calculateFieldFeatures(collection: MapCollection, expression: string, outputField: string): OpResult {
  const field = outputField.trim();
  if (field === "" || isCoordinateField(field)) throw new SpatialOpError("新字段名不能为空，也不能是坐标字段。");
  if (expression.trim() === "" || expression.length > 200) throw new SpatialOpError("计算式为空或超过 200 个字符。");
  const parsed = parseFieldExpr(expression.trim());
  const features: MapFeature[] = [];
  let skipped = 0;
  for (const feature of collection.features) {
    let value: string | number;
    try {
      value = materialize(evalFieldExpr(parsed, feature.properties ?? {}));
    } catch (error) {
      if (error instanceof SpatialOpError) throw error;
      skipped += 1;
      continue;
    }
    const next = stampFeature(feature as Feature, { ...feature.properties, [field]: value }, features.length);
    if (next) features.push(next);
    else skipped += 1;
  }
  return finishResult(features, skipped, collection.features.length, [`新字段 ${field}。`]);
}

/** 按字段等值内连接。一对多会保留多条，几何来自第一个图层。 */
export function joinAttributeFeatures(primary: MapCollection, secondary: MapCollection, fieldName: string, otherFieldName: string): OpResult {
  const leftKey = fieldName.trim();
  const rightKey = otherFieldName.trim();
  if (leftKey === "" || rightKey === "") throw new SpatialOpError("连接需要两边的字段名。");
  const buckets = new Map<string, MapFeature[]>();
  for (const feature of secondary.features) {
    const key = joinKey(feature.properties?.[rightKey]);
    if (key === null) continue;
    const list = buckets.get(key) ?? [];
    list.push(feature);
    buckets.set(key, list);
  }
  const features: MapFeature[] = [];
  let skipped = 0;
  let unmatched = 0;
  for (const feature of primary.features) {
    const key = joinKey(feature.properties?.[leftKey]);
    const matches = key === null ? [] : buckets.get(key) ?? [];
    if (matches.length === 0) {
      unmatched += 1;
      continue;
    }
    for (const match of matches) {
      const properties = { ...feature.properties };
      for (const [name, value] of Object.entries(match.properties ?? {})) {
        if (name === rightKey || name in properties) continue;
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) properties[name] = value;
      }
      const next = stampFeature(feature as Feature, properties, features.length);
      if (next) features.push(next);
      else skipped += 1;
    }
  }
  const note = unmatched > 0 ? `${unmatched} 条记录没有对上。` : "只保留字段值对上的记录。";
  return {
    collection: { type: "FeatureCollection", features },
    skipped,
    notes: [note],
    corrupt: features.length === 0 && skipped > 0,
  };
}

function joinKey(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function materialize(value: string | number | boolean): string | number {
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

function evalFieldExpr(expr: FieldExpr, properties: Record<string, unknown>): string | number | boolean {
  if (expr.kind === "num") return expr.value;
  if (expr.kind === "str") return expr.value;
  if (expr.kind === "field") {
    if (!Object.prototype.hasOwnProperty.call(properties, expr.name)) throw new SpatialOpError(`没有字段 ${expr.name}。`);
    const raw = properties[expr.name];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string") return raw;
    throw new SpatialOpError(`字段 ${expr.name} 不是数值或文字。`);
  }
  if (expr.kind === "neg") {
    const value = evalFieldExpr(expr.value, properties);
    if (typeof value !== "number") throw new SpatialOpError("负号只能用在数值上。");
    return -value;
  }
  if (expr.kind === "if") {
    return evalFieldExpr(expr.cond, properties) ? evalFieldExpr(expr.yes, properties) : evalFieldExpr(expr.no, properties);
  }
  const left = evalFieldExpr(expr.left, properties);
  const right = evalFieldExpr(expr.right, properties);
  if (expr.op === "+" || expr.op === "-" || expr.op === "*" || expr.op === "/") {
    if (typeof left !== "number" || typeof right !== "number") throw new SpatialOpError("加减乘除只能用于数值。");
    if (expr.op === "/" && right === 0) throw new SpatialOpError("除数不能为 0。");
    if (expr.op === "+") return left + right;
    if (expr.op === "-") return left - right;
    if (expr.op === "*") return left * right;
    return left / right;
  }
  if (typeof left === "number" && typeof right === "number") {
    if (expr.op === "==") return left === right;
    if (expr.op === "!=") return left !== right;
    if (expr.op === ">") return left > right;
    if (expr.op === "<") return left < right;
    if (expr.op === ">=") return left >= right;
    return left <= right;
  }
  if ((expr.op === "==" || expr.op === "!=") && typeof left === "string" && typeof right === "string") {
    return expr.op === "==" ? left === right : left !== right;
  }
  throw new SpatialOpError("比较两边的类型不一致。");
}

function parseFieldExpr(source: string): FieldExpr {
  const tokens = tokenizeFieldExpr(source);
  let index = 0;
  const peek = () => tokens[index];
  const take = () => tokens[index++];
  const parseIf = (): FieldExpr => {
    if (peek() === "if") {
      take();
      if (take() !== "(") throw new SpatialOpError("if 后面要有括号。");
      const cond = parseIf();
      if (take() !== ",") throw new SpatialOpError("if 的参数要用逗号分开。");
      const yes = parseIf();
      if (take() !== ",") throw new SpatialOpError("if 的参数要用逗号分开。");
      const no = parseIf();
      if (take() !== ")") throw new SpatialOpError("if 缺少右括号。");
      return { kind: "if", cond, yes, no };
    }
    return parseCmp();
  };
  const parseCmp = (): FieldExpr => {
    let left = parseAdd();
    while (peek() === "==" || peek() === "!=" || peek() === ">" || peek() === "<" || peek() === ">=" || peek() === "<=") {
      const op = take() as "==" | "!=" | ">" | "<" | ">=" | "<=";
      left = { kind: "bin", op, left, right: parseAdd() };
    }
    return left;
  };
  const parseAdd = (): FieldExpr => {
    let left = parseMul();
    while (peek() === "+" || peek() === "-") {
      const op = take() as "+" | "-";
      left = { kind: "bin", op, left, right: parseMul() };
    }
    return left;
  };
  const parseMul = (): FieldExpr => {
    let left = parseUnary();
    while (peek() === "*" || peek() === "/") {
      const op = take() as "*" | "/";
      left = { kind: "bin", op, left, right: parseUnary() };
    }
    return left;
  };
  const parseUnary = (): FieldExpr => {
    if (peek() === "-") {
      take();
      return { kind: "neg", value: parseUnary() };
    }
    return parsePrimary();
  };
  const parsePrimary = (): FieldExpr => {
    const token = take();
    if (token === undefined) throw new SpatialOpError("计算式不完整。");
    if (token === "(") {
      const inner = parseIf();
      if (take() !== ")") throw new SpatialOpError("缺少右括号。");
      return inner;
    }
    if (token.startsWith("\"")) return { kind: "str", value: token.slice(1, -1) };
    if (/^-?\d+(?:\.\d+)?$/.test(token)) return { kind: "num", value: Number(token) };
    if (/^[\u4e00-\u9fffA-Za-z_][\u4e00-\u9fffA-Za-z0-9_]*$/.test(token)) return { kind: "field", name: token };
    throw new SpatialOpError(`计算式里有不能使用的符号：${token}`);
  };
  const expr = parseIf();
  if (index !== tokens.length) throw new SpatialOpError("计算式没有结束。");
  return expr;
}

function tokenizeFieldExpr(source: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? "";
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    const two = source.slice(index, index + 2);
    if (two === "==" || two === "!=" || two === ">=" || two === "<=") {
      tokens.push(two);
      index += 2;
      continue;
    }
    if ("+-*/(),><".includes(char)) {
      tokens.push(char);
      index += 1;
      continue;
    }
    if (char === "\"") {
      const end = source.indexOf("\"", index + 1);
      if (end < 0) throw new SpatialOpError("文字缺少引号。");
      tokens.push(source.slice(index, end + 1));
      index = end + 1;
      continue;
    }
    const match = /^[\u4e00-\u9fffA-Za-z0-9_.]+/.exec(source.slice(index));
    if (!match) throw new SpatialOpError(`计算式里有不能使用的符号：${char}`);
    tokens.push(match[0]);
    index += match[0].length;
  }
  return tokens;
}
