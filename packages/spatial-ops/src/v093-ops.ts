// SPDX-License-Identifier: Apache-2.0

import type { Feature, LineString, Polygon, Position } from "geojson";
import {
  booleanPointInPolygon,
  difference,
  featureCollection,
  lineIntersect,
  union,
} from "@turf/turf";
import { finishResult, stampFeature } from "@igis/surtgis";
import { SpatialOpError } from "./errors.js";
import type { MapCollection, MapFeature, OpResult } from "./types.js";

export interface GraphEdge {
  readonly to: string;
  readonly weight: number;
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
}
export type Graph = Map<string, GraphEdge[]>;

/** 距离度量。geographic 用球面距离（米）；planar-meters 乘单位系数得米；coordinate 用坐标原值。 */
export interface Measure {
  readonly mode: "geographic" | "planar-meters" | "coordinate";
  readonly unitToMeter: number | null;
}

export const COORDINATE_MEASURE: Measure = { mode: "coordinate", unitToMeter: null };

export function measureDistance(measure: Measure, ax: number, ay: number, bx: number, by: number): number {
  if (measure.mode === "geographic") return haversineMeters(ax, ay, bx, by);
  const planar = Math.hypot(bx - ax, by - ay);
  return measure.mode === "planar-meters" && measure.unitToMeter !== null ? planar * measure.unitToMeter : planar;
}

export function measureUnit(measure: Measure): string {
  return measure.mode === "coordinate" ? "坐标单位" : "米";
}

export function polygonsOf(collection: MapCollection): Feature<Polygon>[] {
  const found: Feature<Polygon>[] = [];
  for (const feature of collection.features) {
    const type = feature.geometry?.type;
    if (type === "Polygon") found.push(feature as Feature<Polygon>);
    if (type === "MultiPolygon") {
      for (const ring of (feature.geometry as { coordinates: Polygon["coordinates"][] }).coordinates) {
        found.push({ type: "Feature", properties: feature.properties, geometry: { type: "Polygon", coordinates: ring } });
      }
    }
  }
  return found;
}

export function linesOf(collection: MapCollection): Feature<LineString>[] {
  const found: Feature<LineString>[] = [];
  for (const feature of collection.features) {
    const type = feature.geometry?.type;
    if (type === "LineString") found.push(feature as Feature<LineString>);
    if (type === "MultiLineString") {
      for (const line of (feature.geometry as { coordinates: Position[][] }).coordinates) {
        found.push({ type: "Feature", properties: feature.properties, geometry: { type: "LineString", coordinates: line } });
      }
    }
  }
  return found;
}

export function pointsOf(collection: MapCollection): Array<{ readonly x: number; readonly y: number; readonly properties: MapFeature["properties"] }> {
  const found: Array<{ readonly x: number; readonly y: number; readonly properties: MapFeature["properties"] }> = [];
  for (const feature of collection.features) {
    if (feature.geometry?.type !== "Point") continue;
    const pair = (feature.geometry as { coordinates: Position }).coordinates;
    const x = pair[0];
    const y = pair[1];
    if (typeof x !== "number" || typeof y !== "number") continue;
    found.push({ x, y, properties: feature.properties });
  }
  return found;
}

export function scalars(value: { readonly [key: string]: unknown } | null | undefined): Record<string, string | number | boolean | null> {
  const next: Record<string, string | number | boolean | null> = {};
  if (!value) return next;
  for (const [name, item] of Object.entries(value)) {
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean" || item === null) next[name] = item;
  }
  return next;
}

function copyScalar(target: Record<string, string | number | boolean | null>, source: { readonly [key: string]: unknown } | null | undefined, skip: ReadonlySet<string>): void {
  for (const [name, value] of Object.entries(source ?? {})) {
    if (skip.has(name) || name in target) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) target[name] = value;
  }
}

/** 擦除：从第一个面图层去掉与第二个面重叠的部分。 */
export function eraseFeatures(primary: MapCollection, secondary: MapCollection): OpResult {
  const cutters = polygonsOf(secondary);
  if (cutters.length === 0) throw new SpatialOpError("擦除需要面图层作为擦除范围。");
  let mask = cutters[0] as Feature;
  for (const cutter of cutters.slice(1)) {
    try {
      const next = union(featureCollection([mask, cutter]) as never);
      if (next) mask = next as Feature;
    } catch {
      continue;
    }
  }
  const features: MapFeature[] = [];
  let skipped = 0;
  for (const feature of polygonsOf(primary)) {
    try {
      const remain = difference(featureCollection([feature, mask]) as never);
      const next = remain ? stampFeature(remain as Feature, scalars(feature.properties), features.length) : null;
      if (next) features.push(next);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return finishResult(features, skipped, primary.features.length, ["重叠部分已去掉。"]);
}

/** 联合：把两个面图层叠成一体，不是上下拼接。 */
export function unionOverlayFeatures(primary: MapCollection, secondary: MapCollection): OpResult {
  const parts = [...polygonsOf(primary), ...polygonsOf(secondary)];
  if (parts.length === 0) throw new SpatialOpError("联合需要面要素。");
  try {
    const merged = union(featureCollection(parts) as never);
    const next = merged ? stampFeature(merged as Feature, {}, 0) : null;
    return finishResult(next ? [next] : [], next ? 0 : parts.length, parts.length, ["两个面图层已合成一体。"]);
  } catch {
    throw new SpatialOpError("这些面无法联合。");
  }
}

/** 按位置连接：点落在哪个面里，就把面的字段抄到点上。 */
export function spatialJoinLocationFeatures(points: MapCollection, polygons: MapCollection): OpResult {
  const areas = polygonsOf(polygons);
  if (areas.length === 0) throw new SpatialOpError("按位置连接需要面图层。");
  const features: MapFeature[] = [];
  let unmatched = 0;
  for (const point of points.features) {
    if (point.geometry?.type !== "Point") continue;
    const hit = areas.find((area) => {
      try {
        return booleanPointInPolygon(point as never, area as never);
      } catch {
        return false;
      }
    });
    if (!hit) {
      unmatched += 1;
      continue;
    }
    const properties = scalars(point.properties);
    copyScalar(properties, hit.properties, new Set());
    const next = stampFeature(point as Feature, properties, features.length);
    if (next) features.push(next);
  }
  return {
    collection: { type: "FeatureCollection", features },
    skipped: 0,
    notes: [unmatched > 0 ? `${unmatched} 个点没有落在面内。` : "点已带上面的字段。"],
    corrupt: false,
  };
}

function locateOnLine(line: Feature<LineString>, x: number, y: number): { readonly x: number; readonly y: number; readonly loc: number; readonly distance: number } | null {
  const coords = line.geometry.coordinates;
  let best: { readonly x: number; readonly y: number; readonly loc: number; readonly distance: number } | null = null;
  for (let index = 1; index < coords.length; index += 1) {
    const start = coords[index - 1];
    const end = coords[index];
    if (!start || !end) continue;
    const ax = start[0] ?? 0;
    const ay = start[1] ?? 0;
    const bx = end[0] ?? 0;
    const by = end[1] ?? 0;
    const dx = bx - ax;
    const dy = by - ay;
    const length2 = dx * dx + dy * dy;
    const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length2));
    const sx = ax + t * dx;
    const sy = ay + t * dy;
    const distance = Math.hypot(sx - x, sy - y);
    if (!best || distance < best.distance) best = { x: sx, y: sy, loc: index - 1 + t, distance };
  }
  return best;
}

const EARTH_RADIUS = 6371000;
const METERS_PER_DEGREE = (EARTH_RADIUS * Math.PI) / 180;

function haversineMeters(ax: number, ay: number, bx: number, by: number): number {
  const toRad = Math.PI / 180;
  const dLat = (by - ay) * toRad;
  const dLng = (bx - ax) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(ay * toRad) * Math.cos(by * toRad) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

function nodeKey(x: number, y: number): string {
  const scale = Math.abs(x) <= 180 && Math.abs(y) <= 90 ? 1e6 : 100;
  return `${Math.round(x * scale) / scale},${Math.round(y * scale) / scale}`;
}

/** 由线建立路网。交点按沿线位置切开，不把交点直接连到整条线的端点。 */
export function buildRoadGraph(lines: MapCollection, measure: Measure = COORDINATE_MEASURE): { readonly graph: Graph; readonly edgeCount: number } {
  const pieces = linesOf(lines).slice(0, 800);
  if (pieces.length === 0) throw new SpatialOpError("路网需要线图层。");
  const marks: Array<Array<{ readonly loc: number; readonly x: number; readonly y: number }>> = pieces.map((line) => (
    line.geometry.coordinates.map((coord, index) => ({ loc: index, x: coord[0] ?? 0, y: coord[1] ?? 0 }))
  ));
  const cap = Math.min(pieces.length, 200);
  for (let i = 0; i < cap; i += 1) {
    for (let j = i + 1; j < cap; j += 1) {
      const left = pieces[i];
      const right = pieces[j];
      if (!left || !right) continue;
      let hits;
      try {
        hits = lineIntersect(left as never, right as never);
      } catch {
        continue;
      }
      for (const hit of hits.features) {
        const pair = hit.geometry?.type === "Point" ? hit.geometry.coordinates : null;
        if (!pair) continue;
        const x = pair[0] ?? 0;
        const y = pair[1] ?? 0;
        for (const side of [i, j]) {
          const line = pieces[side];
          const bucket = marks[side];
          if (!line || !bucket) continue;
          const foot = locateOnLine(line, x, y);
          if (foot) bucket.push({ loc: foot.loc, x: foot.x, y: foot.y });
        }
      }
    }
  }
  const graph: Graph = new Map();
  const add = (ax: number, ay: number, bx: number, by: number): void => {
    const weight = measureDistance(measure, ax, ay, bx, by);
    if (!(weight > 0)) return;
    const from = nodeKey(ax, ay);
    const to = nodeKey(bx, by);
    if (from === to) return;
    const left = graph.get(from) ?? [];
    left.push({ to, weight, ax, ay, bx, by });
    graph.set(from, left);
    const right = graph.get(to) ?? [];
    right.push({ to: from, weight, ax: bx, ay: by, bx: ax, by: ay });
    graph.set(to, right);
  };
  for (const group of marks) {
    const ordered = [...group].sort((left, right) => left.loc - right.loc);
    let previous = ordered[0];
    for (const current of ordered.slice(1)) {
      if (!previous) {
        previous = current;
        continue;
      }
      add(previous.x, previous.y, current.x, current.y);
      previous = current;
    }
  }
  return { graph, edgeCount: [...graph.values()].reduce((sum, edges) => sum + edges.length, 0) / 2 };
}

/**
 * 把点落到最近的路网边上，并在垂足处把这条边切成两段。
 * 同一条边上先后落下的点会依次切开子边，彼此按沿线距离相连；交点处的节点也保留在路径上。
 * 地理坐标下求垂足时经度按点所在纬度缩放。
 */
export function snapNode(graph: Graph, x: number, y: number, measure: Measure = COORDINATE_MEASURE): string | null {
  const squeeze = measure.mode === "geographic" ? Math.max(0.01, Math.cos((y * Math.PI) / 180)) : 1;
  let best: { readonly from: string; readonly edge: GraphEdge; readonly fx: number; readonly fy: number; readonly distance: number } | null = null;
  for (const [from, edges] of graph) {
    for (const edge of edges) {
      if (from > edge.to) continue;
      const dx = (edge.bx - edge.ax) * squeeze;
      const dy = edge.by - edge.ay;
      const length2 = dx * dx + dy * dy;
      const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - edge.ax) * squeeze * dx + (y - edge.ay) * dy) / length2));
      const fx = edge.ax + (edge.bx - edge.ax) * t;
      const fy = edge.ay + (edge.by - edge.ay) * t;
      const distance = measureDistance(measure, x, y, fx, fy);
      if (!best || distance < best.distance) best = { from, edge, fx, fy, distance };
    }
  }
  if (!best) return null;
  const node = nodeKey(best.fx, best.fy);
  if (graph.has(node)) return node;
  const { from, edge, fx, fy } = best;
  const forward = graph.get(from) ?? [];
  forward.splice(forward.indexOf(edge), 1);
  const backward = graph.get(edge.to) ?? [];
  const reverse = backward.findIndex((item) => item.to === from && item.weight === edge.weight && item.ax === edge.bx && item.ay === edge.by);
  if (reverse >= 0) backward.splice(reverse, 1);
  const link = (key: string, px: number, py: number): void => {
    const weight = measureDistance(measure, fx, fy, px, py);
    const out = graph.get(node) ?? [];
    out.push({ to: key, weight, ax: fx, ay: fy, bx: px, by: py });
    graph.set(node, out);
    const back = graph.get(key) ?? [];
    back.push({ to: node, weight, ax: px, ay: py, bx: fx, by: fy });
    graph.set(key, back);
  };
  link(from, edge.ax, edge.ay);
  link(edge.to, edge.bx, edge.by);
  return node;
}

/** 二叉堆 Dijkstra。返回每个可达节点的最短距离；给了 limit 时只走到 limit 为止。 */
export function dijkstra(graph: Graph, start: string, limit?: number): Map<string, number> {
  const cost = new Map<string, number>([[start, 0]]);
  const done = new Set<string>();
  const heap: Array<{ readonly node: string; readonly value: number }> = [{ node: start, value: 0 }];
  const push = (item: { readonly node: string; readonly value: number }): void => {
    heap.push(item);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      const above = heap[parent];
      if (!above || above.value <= item.value) break;
      heap[index] = above;
      index = parent;
    }
    heap[index] = item;
  };
  const pop = (): { readonly node: string; readonly value: number } | undefined => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length === 0 || !last) return top;
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      let smallestValue = last.value;
      const leftItem = heap[left];
      const rightItem = heap[right];
      if (leftItem && leftItem.value < smallestValue) {
        smallest = left;
        smallestValue = leftItem.value;
      }
      if (rightItem && rightItem.value < smallestValue) smallest = right;
      if (smallest === index) break;
      const moved = heap[smallest];
      if (!moved) break;
      heap[index] = moved;
      index = smallest;
    }
    heap[index] = last;
    return top;
  };
  for (let item = pop(); item; item = pop()) {
    if (done.has(item.node) || item.value > (cost.get(item.node) ?? Number.POSITIVE_INFINITY)) continue;
    if (limit !== undefined && item.value > limit) break;
    done.add(item.node);
    for (const edge of graph.get(item.node) ?? []) {
      const next = item.value + edge.weight;
      if (limit !== undefined && next > limit) continue;
      if (next < (cost.get(edge.to) ?? Number.POSITIVE_INFINITY)) {
        cost.set(edge.to, next);
        push({ node: edge.to, value: next });
      }
    }
  }
  return cost;
}

/** 把点落到最近的线上。垂足按平面求，_snap 按度量换算。 */
export function snapToNetworkFeatures(points: MapCollection, lines: MapCollection, measure: Measure = COORDINATE_MEASURE): OpResult {
  const roads = linesOf(lines);
  const samples = pointsOf(points);
  const features: MapFeature[] = [];
  let skipped = 0;
  for (const point of samples) {
    let best: Feature | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const line of roads) {
      const foot = locateOnLine(line, point.x, point.y);
      if (!foot) continue;
      const distance = measureDistance(measure, point.x, point.y, foot.x, foot.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [foot.x, foot.y] } };
      }
    }
    if (!best) {
      skipped += 1;
      continue;
    }
    const next = stampFeature(best, { ...point.properties, _snap: Math.round(bestDistance * 100) / 100 }, features.length);
    if (next) features.push(next);
    else skipped += 1;
  }
  return finishResult(features, skipped, points.features.length, [`点已落到线上。_snap 是落到线的距离，单位是${measureUnit(measure)}。`]);
}

/** 每个起点沿路网到最近终点的距离。返回最小、最大、平均。 */
export function networkDistanceStats(origins: MapCollection, destinations: MapCollection, lines: MapCollection, measure: Measure = COORDINATE_MEASURE): { readonly minimum: number; readonly maximum: number; readonly mean: number; readonly count: number } {
  const built = buildRoadGraph(lines, measure);
  const starts = pointsOf(origins).slice(0, 200).map((point) => snapNode(built.graph, point.x, point.y, measure)).filter((item): item is string => item !== null);
  const ends = pointsOf(destinations).slice(0, 200).map((point) => snapNode(built.graph, point.x, point.y, measure)).filter((item): item is string => item !== null);
  const values: number[] = [];
  for (const start of starts) {
    const cost = dijkstra(built.graph, start);
    let best = Number.POSITIVE_INFINITY;
    for (const end of ends) best = Math.min(best, cost.get(end) ?? Number.POSITIVE_INFINITY);
    if (Number.isFinite(best)) values.push(best);
  }
  if (values.length === 0) throw new SpatialOpError("沿路距离没有算出来。点可能没有落到路网上。");
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    minimum: Math.min(...values),
    maximum: Math.max(...values),
    mean: sum / values.length,
    count: values.length,
  };
}

/** 从一个点沿路网走出给定距离内的路段。 */
export function serviceAreaFeatures(points: MapCollection, lines: MapCollection, distance: number, measure: Measure = COORDINATE_MEASURE): OpResult {
  if (!(distance > 0)) throw new SpatialOpError("服务范围的距离必须大于 0。");
  const built = buildRoadGraph(lines, measure);
  const start = pointsOf(points)[0];
  if (!start) throw new SpatialOpError("服务范围需要一个点。");
  const origin = snapNode(built.graph, start.x, start.y, measure);
  if (!origin) throw new SpatialOpError("这个点没有落到路网上。");
  const cost = dijkstra(built.graph, origin, distance);
  const features: MapFeature[] = [];
  const seen = new Set<string>();
  const emit = (ax: number, ay: number, bx: number, by: number, ratio: number, reach: number): void => {
    const line: Feature = { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[ax, ay], [ax + (bx - ax) * ratio, ay + (by - ay) * ratio]] } };
    const next = stampFeature(line, { _reach: Math.round(reach * 100) / 100 }, features.length);
    if (next) features.push(next);
  };
  for (const [node, edges] of built.graph) {
    for (const edge of edges) {
      const id = [node, edge.to].sort().join("|");
      if (seen.has(id)) continue;
      seen.add(id);
      const here = cost.get(node);
      const there = cost.get(edge.to);
      if (here === undefined && there === undefined) continue;
      const fromHere = here ?? Number.POSITIVE_INFINITY;
      const fromThere = there ?? Number.POSITIVE_INFINITY;
      if (Math.min(fromHere, fromThere) + edge.weight <= distance) {
        const [start, end, base] = fromHere <= fromThere ? [[edge.ax, edge.ay], [edge.bx, edge.by], fromHere] as const : [[edge.bx, edge.by], [edge.ax, edge.ay], fromThere] as const;
        emit(start[0], start[1], end[0], end[1], 1, base + edge.weight);
        continue;
      }
      // 两端都走不满整段时，从各自一端各画一截。
      if (fromHere < distance && edge.weight > 0) emit(edge.ax, edge.ay, edge.bx, edge.by, (distance - fromHere) / edge.weight, distance);
      if (fromThere < distance && edge.weight > 0) emit(edge.bx, edge.by, edge.ax, edge.ay, (distance - fromThere) / edge.weight, distance);
    }
  }
  return finishResult(features, 0, lines.features.length, [`服务范围是距离内的路段，_reach 和距离的单位是${measureUnit(measure)}。`]);
}

/**
 * 高斯核密度。带宽和格网边长按度量单位给（地理图层是米）。
 * _density = Σ K(d/h) / (2πh²)，是每平方单位的点数估计；地理和米制图层换成每平方公里。
 * 核在 3h 处截断，截掉的权重约 1.1%。
 */
export function kernelDensityFeatures(points: MapCollection, bandwidth: number, cellSize: number, measure: Measure = COORDINATE_MEASURE): OpResult {
  if (!(bandwidth > 0) || !(cellSize > 0)) throw new SpatialOpError("核密度的带宽和格网边长必须大于 0。");
  const samples = pointsOf(points);
  if (samples.length === 0) throw new SpatialOpError("核密度需要点。");
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const sample of samples) {
    minX = Math.min(minX, sample.x);
    minY = Math.min(minY, sample.y);
    maxX = Math.max(maxX, sample.x);
    maxY = Math.max(maxY, sample.y);
  }
  // 地理坐标下，格网在中心纬度按米换算成经纬度步长；距离仍逐点按球面算。
  const centerLat = (minY + maxY) / 2;
  const metersPerUnitY = measure.mode === "geographic" ? METERS_PER_DEGREE : measure.mode === "planar-meters" && measure.unitToMeter !== null ? measure.unitToMeter : 1;
  const metersPerUnitX = measure.mode === "geographic" ? METERS_PER_DEGREE * Math.max(0.01, Math.cos((centerLat * Math.PI) / 180)) : metersPerUnitY;
  const stepX = cellSize / metersPerUnitX;
  const stepY = cellSize / metersPerUnitY;
  // 格网要覆盖到核的截断半径 3h，否则边缘的密度被截掉。
  minX -= (3 * bandwidth) / metersPerUnitX;
  maxX += (3 * bandwidth) / metersPerUnitX;
  minY -= (3 * bandwidth) / metersPerUnitY;
  maxY += (3 * bandwidth) / metersPerUnitY;
  const columns = Math.ceil((maxX - minX) / stepX);
  const rows = Math.ceil((maxY - minY) / stepY);
  if (columns * rows > 40000) throw new SpatialOpError("核密度格网超过 40000 格。请加大边长。");
  const areaScale = measure.mode === "coordinate" ? 1 : 1e6;
  const norm = areaScale / (2 * Math.PI * bandwidth * bandwidth);
  const features: MapFeature[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = minX + (column + 0.5) * stepX;
      const y = minY + (row + 0.5) * stepY;
      let density = 0;
      for (const sample of samples) {
        const distance = measureDistance(measure, sample.x, sample.y, x, y) / bandwidth;
        if (distance > 3) continue;
        density += Math.exp(-0.5 * distance * distance);
      }
      if (!(density > 0)) continue;
      const x0 = minX + column * stepX;
      const y0 = minY + row * stepY;
      const cell: Feature = {
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [[[x0, y0], [x0 + stepX, y0], [x0 + stepX, y0 + stepY], [x0, y0 + stepY], [x0, y0]]] },
      };
      const next = stampFeature(cell, { _density: density * norm }, features.length);
      if (next) features.push(next);
    }
  }
  const unit = measure.mode === "coordinate" ? "每平方坐标单位的点数" : "每平方公里的点数";
  return finishResult(features, 0, samples.length, [`_density 是高斯核密度估计，单位是${unit}，带宽 ${bandwidth} ${measureUnit(measure)}。`]);
}

/** 四叉树。点多的格子继续四分，直到深度或每格点数达到上限。 */
export function quadtreeFeatures(points: MapCollection, capacity = 4): OpResult {
  const samples = pointsOf(points);
  if (samples.length === 0) throw new SpatialOpError("四叉树需要点。");
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const sample of samples) {
    minX = Math.min(minX, sample.x);
    minY = Math.min(minY, sample.y);
    maxX = Math.max(maxX, sample.x);
    maxY = Math.max(maxY, sample.y);
  }
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const features: MapFeature[] = [];
  const walk = (x0: number, y0: number, size: number, depth: number, inside: readonly { x: number; y: number }[]): void => {
    if (inside.length === 0) return;
    if (inside.length <= capacity || depth >= 8) {
      const cell: Feature = {
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [[[x0, y0], [x0 + size, y0], [x0 + size, y0 + size], [x0, y0 + size], [x0, y0]]] },
      };
      const next = stampFeature(cell, { _count: inside.length, _depth: depth }, features.length);
      if (next) features.push(next);
      return;
    }
    const half = size / 2;
    const midX = x0 + half;
    const midY = y0 + half;
    const bins: { x: number; y: number }[][] = [[], [], [], []];
    for (const sample of inside) {
      const column = sample.x >= midX ? 1 : 0;
      const row = sample.y >= midY ? 1 : 0;
      bins[row * 2 + column]?.push(sample);
    }
    walk(x0, y0, half, depth + 1, bins[0] ?? []);
    walk(midX, y0, half, depth + 1, bins[1] ?? []);
    walk(x0, midY, half, depth + 1, bins[2] ?? []);
    walk(midX, midY, half, depth + 1, bins[3] ?? []);
  };
  walk(minX, minY, span, 0, samples);
  return finishResult(features, 0, samples.length, ["每格的 _count 是落在里面的点数。"]);
}

/** 把点归到格网并计数。结果里不再保留原始单点。 */
export function aggregateGridFeatures(points: MapCollection, cellSize: number): OpResult {
  if (!(cellSize > 0)) throw new SpatialOpError("格网边长必须大于 0。");
  const buckets = new Map<string, { x: number; y: number; count: number }>();
  for (const point of pointsOf(points)) {
    const column = Math.floor(point.x / cellSize);
    const row = Math.floor(point.y / cellSize);
    const key = `${column},${row}`;
    const current = buckets.get(key) ?? { x: column * cellSize, y: row * cellSize, count: 0 };
    current.count += 1;
    buckets.set(key, current);
  }
  const features: MapFeature[] = [];
  for (const cell of buckets.values()) {
    const polygon: Feature = {
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates: [[[cell.x, cell.y], [cell.x + cellSize, cell.y], [cell.x + cellSize, cell.y + cellSize], [cell.x, cell.y + cellSize], [cell.x, cell.y]]] },
    };
    const next = stampFeature(polygon, { _count: cell.count }, features.length);
    if (next) features.push(next);
  }
  return finishResult(features, 0, points.features.length, ["原始点已收成格子计数。"]);
}

/** 数值字段的等宽分箱，给统计图用。 */
export function chartBins(collection: MapCollection, fieldName: string, bins = 8): readonly { readonly label: string; readonly count: number }[] {
  const values: number[] = [];
  for (const feature of collection.features) {
    const raw = feature.properties?.[fieldName];
    const value = typeof raw === "number" ? raw : typeof raw === "string" && /^-?\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw) : null;
    if (value !== null && Number.isFinite(value)) values.push(value);
  }
  if (values.length === 0) throw new SpatialOpError(`字段 ${fieldName} 没有数值。`);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const width = maximum === minimum ? 1 : (maximum - minimum) / bins;
  const counts = Array.from({ length: bins }, () => 0);
  for (const value of values) {
    const index = Math.min(bins - 1, Math.floor((value - minimum) / width));
    counts[index] = (counts[index] ?? 0) + 1;
  }
  return counts.map((count, index) => {
    const start = minimum + index * width;
    const end = index === bins - 1 ? maximum : start + width;
    return { label: `${start.toFixed(2)}–${end.toFixed(2)}`, count };
  });
}
