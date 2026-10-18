// SPDX-License-Identifier: Apache-2.0

import { randomFillSync } from "node:crypto";
import type { Feature, Position } from "geojson";
import { booleanPointInPolygon, centroid } from "@turf/turf";
import { finishResult, stampFeature } from "@igis/surtgis";
import { SpatialOpError } from "./errors.js";
import { gwrFit, olsFit, selectBandwidth, type GwrKernel } from "./gwr.js";
import type { MapCollection, MapFeature, OpResult } from "./types.js";
import {
  buildRoadGraph,
  dijkstra,
  linesOf,
  measureDistance,
  measureUnit,
  polygonsOf,
  scalars,
  snapNode,
  type Measure,
} from "./v093-ops.js";

export function numericValue(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string" && /^\s*-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?\s*$/.test(raw)) return Number(raw);
  return null;
}

/** 点用自身，面和线用 Turf 质心（顶点平均）。 */
export function representativePoint(feature: MapFeature): Position | null {
  const geometry = feature.geometry;
  if (!geometry) return null;
  if (geometry.type === "Point") return geometry.coordinates;
  try {
    return centroid(feature as Feature).geometry.coordinates;
  } catch {
    return null;
  }
}

/** 标准正态分布函数。erfc 用 Numerical Recipes 的切比雪夫近似，相对误差小于 1.2e-7。 */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * x);
  const tau = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return z >= 0 ? 1 - tau / 2 : tau / 2;
}

export interface HotspotRow {
  readonly z: number | null;
  readonly p: number | null;
  readonly bin: number;
  readonly neighbors: number;
}

/**
 * Getis-Ord Gi*。权重是二元的：沿路网距离不超过阈值（含自身）为 1。
 * Gi* = (Σw·x − x̄·Σw) / (S·√((nΣw² − (Σw)²)/(n−1)))，S = √(Σx²/n − x̄²)。
 */
export function giStar(values: readonly number[], neighbors: readonly (readonly number[])[]): HotspotRow[] {
  const n = values.length;
  const mean = values.reduce((total, value) => total + value, 0) / n;
  const spread = Math.sqrt(Math.max(0, values.reduce((total, value) => total + value * value, 0) / n - mean * mean));
  return neighbors.map((list) => {
    const sumW = list.length;
    let sumWX = 0;
    for (const index of list) sumWX += values[index] ?? 0;
    const denominator = spread * Math.sqrt((n * sumW - sumW * sumW) / (n - 1));
    if (!(denominator > 0)) return { z: null, p: null, bin: 0, neighbors: sumW };
    const z = (sumWX - mean * sumW) / denominator;
    const p = 2 * (1 - normalCdf(Math.abs(z)));
    const magnitude = Math.abs(z) >= 2.5758 ? 3 : Math.abs(z) >= 1.96 ? 2 : Math.abs(z) >= 1.6449 ? 1 : 0;
    return { z, p, bin: z >= 0 ? magnitude : -magnitude, neighbors: sumW };
  });
}

/** 网络热点：点落到路网，按路网距离阈值定邻居，再算 Gi*。 */
export function networkHotspotFeatures(points: MapCollection, lines: MapCollection, fieldName: string, threshold: number, measure: Measure): OpResult {
  if (!(threshold > 0)) throw new SpatialOpError("热点的邻域距离必须大于 0。");
  const built = buildRoadGraph(lines, measure);
  const used: Array<{ readonly feature: MapFeature; readonly value: number; readonly node: string }> = [];
  let skipped = 0;
  for (const feature of points.features) {
    if (feature.geometry?.type !== "Point") {
      skipped += 1;
      continue;
    }
    const value = numericValue(feature.properties?.[fieldName]);
    const pair = feature.geometry.coordinates;
    const node = value === null ? null : snapNode(built.graph, pair[0] ?? 0, pair[1] ?? 0, measure);
    if (value === null || node === null) {
      skipped += 1;
      continue;
    }
    used.push({ feature, value, node });
  }
  if (used.length > 500) throw new SpatialOpError("网络热点最多 500 个点。");
  if (used.length < 3) throw new SpatialOpError(`字段 ${fieldName} 有数值且能落到路网的点少于 3 个。`);
  const neighbors = used.map((item) => {
    const reach = dijkstra(built.graph, item.node, threshold);
    const list: number[] = [];
    used.forEach((other, index) => {
      const cost = reach.get(other.node);
      if (cost !== undefined && cost <= threshold) list.push(index);
    });
    return list;
  });
  return hotspotResult(used, neighbors, skipped, points.features.length, `Gi* 按路网距离 ${threshold} ${measureUnit(measure)} 内（含自身）为邻居。点到路的落点距离不计入路网距离。`);
}

/** 直线距离带的 Gi*。 */
export function euclideanHotspotFeatures(points: MapCollection, fieldName: string, threshold: number, measure: Measure): OpResult {
  if (!(threshold > 0)) throw new SpatialOpError("热点的邻域距离必须大于 0。");
  const used: Array<{ readonly feature: MapFeature; readonly value: number; readonly x: number; readonly y: number }> = [];
  let skipped = 0;
  for (const feature of points.features) {
    const value = numericValue(feature.properties?.[fieldName]);
    const point = representativePoint(feature);
    if (value === null || !point) {
      skipped += 1;
      continue;
    }
    used.push({ feature, value, x: point[0] ?? 0, y: point[1] ?? 0 });
  }
  if (used.length > 3000) throw new SpatialOpError("热点分析最多 3000 个要素。");
  if (used.length < 3) throw new SpatialOpError(`字段 ${fieldName} 有数值的要素少于 3 个。`);
  const neighbors = used.map((item) => {
    const list: number[] = [];
    used.forEach((other, index) => {
      if (measureDistance(measure, item.x, item.y, other.x, other.y) <= threshold) list.push(index);
    });
    return list;
  });
  return hotspotResult(used, neighbors, skipped, points.features.length, `Gi* 按直线距离 ${threshold} ${measureUnit(measure)} 内（含自身）为邻居。`);
}

function hotspotResult(
  used: readonly { readonly feature: MapFeature; readonly value: number }[],
  neighbors: readonly (readonly number[])[],
  skipped: number,
  total: number,
  note: string,
): OpResult {
  const rows = giStar(used.map((item) => item.value), neighbors);
  const features: MapFeature[] = [];
  rows.forEach((row, index) => {
    const source = used[index];
    if (!source) return;
    const next = stampFeature(source.feature as Feature, {
      ...scalars(source.feature.properties),
      _gi_z: row.z,
      _gi_p: row.p,
      _gi_bin: row.bin,
      _gi_n: row.neighbors,
    }, features.length);
    if (next) features.push(next);
  });
  const hot = rows.filter((row) => row.bin > 0).length;
  const cold = rows.filter((row) => row.bin < 0).length;
  const isolated = rows.filter((row) => row.z === null).length;
  return finishResult(features, skipped, total, [
    `${note}热点 ${hot} 个，冷点 ${cold} 个（90% 以上置信）。${isolated > 0 ? `${isolated} 个要素的邻居是全部或无法算 z，_gi_z 为空。` : ""}_gi_bin 为 ±1、±2、±3，对应 90%、95%、99% 置信，未做多重检验校正。`,
  ]);
}

export function gwrFeatures(
  collection: MapCollection,
  fieldName: string,
  predictors: readonly string[],
  kernel: GwrKernel,
  adaptive: boolean,
  bandwidth: number | null,
  measure: Measure,
): OpResult {
  const rows: Array<{ readonly feature: MapFeature; readonly x: number; readonly y: number; readonly target: number; readonly values: number[] }> = [];
  let skipped = 0;
  for (const feature of collection.features) {
    const target = numericValue(feature.properties?.[fieldName]);
    const values = predictors.map((name) => numericValue(feature.properties?.[name]));
    const point = representativePoint(feature);
    if (target === null || values.some((value) => value === null) || !point) {
      skipped += 1;
      continue;
    }
    rows.push({ feature, x: point[0] ?? 0, y: point[1] ?? 0, target, values: values as number[] });
  }
  const n = rows.length;
  const p = predictors.length + 1;
  if (n > 1000) throw new SpatialOpError("地理加权回归最多 1000 个要素。");
  if (n < Math.max(10, p + 3)) throw new SpatialOpError(`可用要素只有 ${n} 个，不够做地理加权回归。`);
  if (adaptive && bandwidth !== null && (!Number.isInteger(bandwidth) || bandwidth < p + 1 || bandwidth > n)) {
    throw new SpatialOpError(`自适应带宽是邻居个数，必须是 ${p + 1} 到 ${n} 的整数。`);
  }
  const design = rows.map((row) => [1, ...row.values]);
  const response = rows.map((row) => row.target);
  const distances = new Float64Array(n * n);
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const a = rows[i];
      const b = rows[j];
      if (!a || !b) continue;
      const value = measureDistance(measure, a.x, a.y, b.x, b.y);
      distances[i * n + j] = value;
      distances[j * n + i] = value;
    }
  }
  const chosen = bandwidth ?? selectBandwidth(design, response, distances, kernel, adaptive).bandwidth;
  const fit = gwrFit(design, response, distances, kernel, adaptive, chosen);
  const ols = olsFit(design, response);
  const names = ["0", ...predictors.map((name) => `_${name}`)];
  const features: MapFeature[] = [];
  rows.forEach((row, index) => {
    const properties: Record<string, string | number | boolean | null> = { ...scalars(row.feature.properties) };
    names.forEach((suffix, k) => {
      properties[`_b${suffix}`] = fit.betas[index]?.[k] ?? null;
      properties[`_se${suffix}`] = fit.standardErrors[index]?.[k] ?? null;
    });
    properties._yhat = fit.yhat[index] ?? null;
    properties._resid = fit.residuals[index] ?? null;
    properties._localR2 = Number.isFinite(fit.localR2[index] ?? Number.NaN) ? fit.localR2[index] ?? null : null;
    const next = stampFeature(row.feature as Feature, properties, features.length);
    if (next) features.push(next);
  });
  const width = adaptive ? `${fit.bandwidth} 个邻居` : `${fit.bandwidth.toPrecision(6)} ${measureUnit(measure)}`;
  const means = names.map((suffix, k) => `_b${suffix} 均值 ${(fit.betas.reduce((total, beta) => total + (beta[k] ?? 0), 0) / n).toPrecision(6)}`);
  return finishResult(features, skipped, collection.features.length, [
    `GWR（${kernel}${adaptive ? "，自适应" : "，固定"}带宽 ${width}${bandwidth === null ? "，按 AICc 选" : ""}）：n=${n}，AICc ${fit.aicc.toFixed(4)}，R² ${fit.r2.toFixed(4)}，tr(S) ${fit.traceS.toFixed(4)}，σ² ${fit.sigma2.toPrecision(6)}。全局 OLS：AICc ${ols.aicc.toFixed(4)}，R² ${ols.r2.toFixed(4)}。${means.join("，")}。`,
  ]);
}

export function odFlowResult(
  originsLayer: MapCollection,
  destinationsLayer: MapCollection,
  productionField: string,
  attractionField: string,
  lines: MapCollection | null,
  deterrence: "exp" | "power",
  beta: number | null,
  targetMean: number | null,
  measure: Measure,
): OpResult {
  const origins = zonesOf(originsLayer, productionField);
  const destinations = zonesOf(destinationsLayer, attractionField);
  if (origins.zones.length === 0 || destinations.zones.length === 0) throw new SpatialOpError("起点或终点没有可用的数值。");
  if (origins.zones.length * destinations.zones.length > 40000) throw new SpatialOpError("起终点对超过 40000。");
  const produced = origins.zones.reduce((total, zone) => total + zone.weight, 0);
  const attracted = destinations.zones.reduce((total, zone) => total + zone.weight, 0);
  if (!(produced > 0) || !(attracted > 0)) throw new SpatialOpError("产生量或吸引量合计为 0。");
  const scale = produced / attracted;
  const attraction = destinations.zones.map((zone) => zone.weight * scale);
  const costs = odCosts(origins.zones, destinations.zones, measure, lines);
  const production = origins.zones.map((zone) => zone.weight);
  const solution = targetMean !== null
    ? calibrateGravity(production, attraction, costs, deterrence, targetMean)
    : balanceGravity(production, attraction, costs, deterrence, beta ?? 0);
  const features = odFlowFeatures(origins.zones, destinations.zones, solution, costs);
  const notes = [
    `双约束重力模型（${deterrence === "exp" ? "exp(−β·c)" : "c^(−β)"}${lines ? "，费用为路网距离" : "，费用为直线距离"}，单位${measureUnit(measure)}）：β=${solution.beta.toPrecision(8)}，平均出行费用 ${solution.meanCost.toPrecision(8)}，总流量 ${produced.toPrecision(8)}，平衡迭代 ${solution.iterations} 次，最大相对误差 ${solution.maxError.toExponential(2)}。`,
  ];
  if (Math.abs(scale - 1) > 1e-12) notes.push(`吸引量合计与产生量不等，已按 ${scale.toPrecision(6)} 等比缩放。`);
  if (origins.skipped + destinations.skipped > 0) notes.push(`${origins.skipped + destinations.skipped} 个要素没有可用数值，未参与。`);
  if (deterrence === "power") notes.push("power 时零距离的起终点对不分配流量。");
  if (features.length >= 5000) notes.push("只输出流量最大的 5000 条。");
  return finishResult(features, 0, originsLayer.features.length + destinationsLayer.features.length, notes);
}

export interface OdZone {
  readonly x: number;
  readonly y: number;
  readonly weight: number;
}

export interface OdSolution {
  readonly flows: Float64Array;
  readonly beta: number;
  readonly meanCost: number;
  readonly iterations: number;
  readonly maxError: number;
}

/** 双约束重力模型，Furness 平衡。f = exp(−β·c) 或 c^(−β)。power 时零距离的对不参与。 */
export function balanceGravity(
  production: readonly number[],
  attraction: readonly number[],
  costs: Float64Array,
  deterrence: "exp" | "power",
  beta: number,
): OdSolution {
  const rows = production.length;
  const columns = attraction.length;
  const factor = new Float64Array(rows * columns);
  for (let i = 0; i < rows; i += 1) {
    let floor = Number.POSITIVE_INFINITY;
    for (let j = 0; j < columns; j += 1) {
      const cost = costs[i * columns + j] ?? Number.POSITIVE_INFINITY;
      if (Number.isFinite(cost) && (deterrence === "exp" || cost > 0)) floor = Math.min(floor, cost);
    }
    for (let j = 0; j < columns; j += 1) {
      const cost = costs[i * columns + j] ?? Number.POSITIVE_INFINITY;
      if (!Number.isFinite(cost)) continue;
      // 每行减去最小费用只差一个行常数，会被行平衡系数吸收，用来避免下溢。
      if (deterrence === "exp") factor[i * columns + j] = Math.exp(-beta * (cost - floor));
      else if (cost > 0) factor[i * columns + j] = beta === 0 ? 1 : Math.exp(-beta * (Math.log(cost) - Math.log(floor)));
    }
  }
  const a = new Float64Array(rows).fill(1);
  const b = new Float64Array(columns).fill(1);
  let iterations = 0;
  let maxError = Number.POSITIVE_INFINITY;
  for (; iterations < 10000 && maxError > 1e-10; iterations += 1) {
    for (let i = 0; i < rows; i += 1) {
      let sum = 0;
      for (let j = 0; j < columns; j += 1) sum += (b[j] ?? 0) * (factor[i * columns + j] ?? 0);
      const target = production[i] ?? 0;
      if (target > 0 && !(sum > 0)) throw new SpatialOpError(`第 ${i + 1} 个起点到不了任何终点。`);
      a[i] = target > 0 ? target / sum : 0;
    }
    for (let j = 0; j < columns; j += 1) {
      let sum = 0;
      for (let i = 0; i < rows; i += 1) sum += (a[i] ?? 0) * (factor[i * columns + j] ?? 0);
      const target = attraction[j] ?? 0;
      if (target > 0 && !(sum > 0)) throw new SpatialOpError(`第 ${j + 1} 个终点没有起点能到。`);
      b[j] = target > 0 ? target / sum : 0;
    }
    maxError = 0;
    for (let i = 0; i < rows; i += 1) {
      let sum = 0;
      for (let j = 0; j < columns; j += 1) sum += (a[i] ?? 0) * (b[j] ?? 0) * (factor[i * columns + j] ?? 0);
      const target = production[i] ?? 0;
      if (target > 0) maxError = Math.max(maxError, Math.abs(sum - target) / target);
    }
  }
  if (!(maxError <= 1e-8)) {
    throw new SpatialOpError(`β=${beta} 时行列平衡不收敛（最大相对误差 ${maxError.toExponential(2)}）。β 太大，或费用结构不允许这样的分布。`);
  }
  const flows = new Float64Array(rows * columns);
  let total = 0;
  let weighted = 0;
  for (let i = 0; i < rows; i += 1) {
    for (let j = 0; j < columns; j += 1) {
      const flow = (a[i] ?? 0) * (b[j] ?? 0) * (factor[i * columns + j] ?? 0);
      flows[i * columns + j] = flow;
      total += flow;
      const cost = costs[i * columns + j] ?? 0;
      if (flow > 0) weighted += flow * cost;
    }
  }
  return { flows, beta, meanCost: total > 0 ? weighted / total : 0, iterations, maxError };
}

/** 找 β ≥ 0 使平均出行费用等于目标值。双约束模型的平均费用随 β 单调下降，用二分。 */
export function calibrateGravity(
  production: readonly number[],
  attraction: readonly number[],
  costs: Float64Array,
  deterrence: "exp" | "power",
  targetMean: number,
): OdSolution {
  const free = balanceGravity(production, attraction, costs, deterrence, 0);
  if (targetMean >= free.meanCost) throw new SpatialOpError(`目标平均费用 ${targetMean} 不小于 β=0 时的 ${free.meanCost.toFixed(6)}，无法标定。`);
  const attempt = (beta: number): OdSolution | null => {
    try {
      return balanceGravity(production, attraction, costs, deterrence, beta);
    } catch (error) {
      if (error instanceof SpatialOpError) return null;
      throw error;
    }
  };
  let low = free;
  let high = deterrence === "exp" ? 1 / Math.max(free.meanCost, Number.MIN_VALUE) : 1;
  let bracketed = false;
  for (let step = 0; step < 80; step += 1) {
    const probe = attempt(high);
    if (!probe) break;
    if (probe.meanCost <= targetMean) {
      bracketed = true;
      break;
    }
    low = probe;
    high *= 2;
  }
  // 双约束下平均费用的下限是最小费用运输问题的解；目标低于它时任何 β 都达不到。
  if (!bracketed) {
    throw new SpatialOpError(`目标平均费用 ${targetMean} 达不到：β 增到 ${low.beta.toPrecision(6)} 时平均费用仍为 ${low.meanCost.toPrecision(8)}，再大则平衡不收敛。`);
  }
  let lower = low.beta;
  let upper = high;
  for (let step = 0; step < 200 && upper - lower > 1e-12 * Math.max(1, upper); step += 1) {
    const middle = (lower + upper) / 2;
    const current = attempt(middle);
    if (current && current.meanCost > targetMean) lower = middle;
    else upper = middle;
  }
  const solved = attempt((lower + upper) / 2) ?? attempt(lower);
  if (!solved) throw new SpatialOpError("标定得到的 β 平衡不收敛。");
  return solved;
}

export function zonesOf(collection: MapCollection, fieldName: string): { readonly zones: OdZone[]; readonly skipped: number } {
  const zones: OdZone[] = [];
  let skipped = 0;
  for (const feature of collection.features) {
    const value = numericValue(feature.properties?.[fieldName]);
    const point = representativePoint(feature);
    if (value === null || value < 0 || !point) {
      skipped += 1;
      continue;
    }
    zones.push({ x: point[0] ?? 0, y: point[1] ?? 0, weight: value });
  }
  return { zones, skipped };
}

/** 起终点的费用矩阵。给了线图层时按路网距离，否则按度量的直线距离。不可达为 Infinity。 */
export function odCosts(origins: readonly OdZone[], destinations: readonly OdZone[], measure: Measure, lines: MapCollection | null): Float64Array {
  const costs = new Float64Array(origins.length * destinations.length).fill(Number.POSITIVE_INFINITY);
  if (!lines) {
    origins.forEach((origin, i) => destinations.forEach((destination, j) => {
      costs[i * destinations.length + j] = measureDistance(measure, origin.x, origin.y, destination.x, destination.y);
    }));
    return costs;
  }
  const built = buildRoadGraph(lines, measure);
  const targets = destinations.map((zone) => snapNode(built.graph, zone.x, zone.y, measure));
  origins.forEach((origin, i) => {
    const start = snapNode(built.graph, origin.x, origin.y, measure);
    if (!start) return;
    const reach = dijkstra(built.graph, start);
    targets.forEach((node, j) => {
      if (node === null) return;
      const cost = reach.get(node);
      if (cost !== undefined) costs[i * destinations.length + j] = cost;
    });
  });
  return costs;
}

export function odFlowFeatures(
  origins: readonly OdZone[],
  destinations: readonly OdZone[],
  solution: OdSolution,
  costs: Float64Array,
  limit = 5000,
): MapFeature[] {
  const pairs: Array<{ readonly i: number; readonly j: number; readonly flow: number }> = [];
  origins.forEach((_origin, i) => destinations.forEach((_destination, j) => {
    const flow = solution.flows[i * destinations.length + j] ?? 0;
    if (flow > 0) pairs.push({ i, j, flow });
  }));
  pairs.sort((left, right) => right.flow - left.flow);
  const features: MapFeature[] = [];
  for (const pair of pairs.slice(0, limit)) {
    const origin = origins[pair.i];
    const destination = destinations[pair.j];
    if (!origin || !destination) continue;
    const line: Feature = { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[origin.x, origin.y], [destination.x, destination.y]] } };
    const next = stampFeature(line, { _flow: pair.flow, _cost: costs[pair.i * destinations.length + pair.j] ?? null, _from: pair.i + 1, _to: pair.j + 1 }, features.length);
    if (next) features.push(next);
  }
  return features;
}

interface Square {
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

/**
 * k 匿名四叉树隐匿。每个输出区域至少含 k 个点：
 * 点数少于 2k 的格子不再分；子格里不足 k 的点和空格并成一个区域；
 * 并起来仍不足 k 时，把点数最少的达标子格整个并进去，不再细分它。
 */
export function kAnonymityFeatures(points: MapCollection, k: number): OpResult {
  if (!Number.isInteger(k) || k < 2) throw new SpatialOpError("k 必须是不小于 2 的整数。");
  const samples: Array<{ readonly x: number; readonly y: number }> = [];
  for (const feature of points.features) {
    if (feature.geometry?.type !== "Point") continue;
    const pair = feature.geometry.coordinates;
    if (typeof pair[0] === "number" && typeof pair[1] === "number") samples.push({ x: pair[0], y: pair[1] });
  }
  if (samples.length < k) throw new SpatialOpError(`点只有 ${samples.length} 个，少于 k=${k}，无法匿名。`);
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
  const span = (Math.max(maxX - minX, maxY - minY) || 1) * (1 + 1e-9);
  const regions: Array<{ readonly squares: readonly Square[]; readonly count: number }> = [];
  const childrenOf = (square: Square, inside: readonly { x: number; y: number }[]): Array<{ readonly square: Square; readonly inside: Array<{ x: number; y: number }> }> => {
    const half = square.size / 2;
    const children = [
      { square: { x: square.x, y: square.y, size: half }, inside: [] as Array<{ x: number; y: number }> },
      { square: { x: square.x + half, y: square.y, size: half }, inside: [] as Array<{ x: number; y: number }> },
      { square: { x: square.x, y: square.y + half, size: half }, inside: [] as Array<{ x: number; y: number }> },
      { square: { x: square.x + half, y: square.y + half, size: half }, inside: [] as Array<{ x: number; y: number }> },
    ];
    for (const sample of inside) {
      const column = sample.x >= square.x + half ? 1 : 0;
      const row = sample.y >= square.y + half ? 1 : 0;
      children[row * 2 + column]?.inside.push(sample);
    }
    return children;
  };
  const walk = (square: Square, inside: readonly { x: number; y: number }[], depth: number): void => {
    if (inside.length < 2 * k || depth >= 20) {
      regions.push({ squares: [square], count: inside.length });
      return;
    }
    const children = childrenOf(square, inside);
    const enough = children.filter((child) => child.inside.length >= k);
    const short = children.filter((child) => child.inside.length < k);
    const leftover = short.reduce((total, child) => total + child.inside.length, 0);
    if (enough.length === 0) {
      regions.push({ squares: [square], count: inside.length });
      return;
    }
    if (leftover === 0) {
      for (const child of enough) walk(child.square, child.inside, depth + 1);
      return;
    }
    if (leftover >= k) {
      regions.push({ squares: short.map((child) => child.square), count: leftover });
      for (const child of enough) walk(child.square, child.inside, depth + 1);
      return;
    }
    const smallest = [...enough].sort((left, right) => left.inside.length - right.inside.length)[0];
    if (!smallest) return;
    regions.push({ squares: [...short.map((child) => child.square), smallest.square], count: leftover + smallest.inside.length });
    for (const child of enough) if (child !== smallest) walk(child.square, child.inside, depth + 1);
  };
  walk({ x: minX, y: minY, size: span }, samples, 0);
  const features: MapFeature[] = [];
  for (const region of regions) {
    const rings = region.squares.map((square) => [[
      [square.x, square.y],
      [square.x + square.size, square.y],
      [square.x + square.size, square.y + square.size],
      [square.x, square.y + square.size],
      [square.x, square.y],
    ]]);
    const geometry = rings.length === 1
      ? { type: "Polygon" as const, coordinates: rings[0] ?? [] }
      : { type: "MultiPolygon" as const, coordinates: rings };
    const next = stampFeature({ type: "Feature", properties: {}, geometry }, { _count: region.count }, features.length);
    if (next) features.push(next);
  }
  const smallest = Math.min(...regions.map((region) => region.count));
  return finishResult(features, 0, points.features.length, [
    `k=${k} 四叉树隐匿：${regions.length} 个区域，最少的区域有 ${smallest} 个点。原始点和属性不输出。只对位置做匿名；属性里的准标识符没有处理。`,
  ]);
}

function secureUniform(): number {
  const view = new DataView(randomFillSync(new Uint8Array(8)).buffer);
  const high = view.getUint32(0) >>> 5;
  const low = view.getUint32(4) >>> 6;
  return (high * 67108864 + low + 0.5) / 9007199254740992;
}

/** 拉普拉斯噪声，尺度 b。u 取开区间 (0,1)。 */
export function laplaceNoise(scale: number, random: () => number = secureUniform): number {
  const u = random() - 0.5;
  return -scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
}

/**
 * 差分隐私格网计数。每个面的真实点数加 Lap(1/ε)，再取整并截到不小于 0（后处理不影响隐私）。
 * 敏感度 1 的前提：每人只贡献一个点，面互不重叠。真实计数不输出。
 */
export function dpGridFeatures(points: MapCollection, cells: MapCollection, epsilon: number, random: () => number = secureUniform): OpResult {
  if (!(epsilon > 0) || !Number.isFinite(epsilon)) throw new SpatialOpError("ε 必须是大于 0 的数。");
  const polygons = polygonsOf(cells);
  if (polygons.length === 0) throw new SpatialOpError("差分隐私计数需要面图层作为统计格。");
  const cellFeatures = cells.features.filter((feature) => feature.geometry?.type === "Polygon" || feature.geometry?.type === "MultiPolygon");
  if (cellFeatures.length > 20000) throw new SpatialOpError("统计格超过 20000 个。");
  const counts = new Array<number>(cellFeatures.length).fill(0);
  for (const feature of points.features) {
    if (feature.geometry?.type !== "Point") continue;
    const index = cellFeatures.findIndex((cell) => booleanPointInPolygon(feature.geometry as never, cell as never));
    if (index >= 0) counts[index] = (counts[index] ?? 0) + 1;
  }
  const scale = 1 / epsilon;
  const features: MapFeature[] = [];
  cellFeatures.forEach((cell, index) => {
    const noisy = (counts[index] ?? 0) + laplaceNoise(scale, random);
    const next = stampFeature(cell as Feature, { ...scalars(cell.properties), _count_dp: Math.max(0, Math.round(noisy)) }, features.length);
    if (next) features.push(next);
  });
  return finishResult(features, 0, cells.features.length, [
    `差分隐私计数：ε=${epsilon}，拉普拉斯尺度 ${scale}，_count_dp 已取整并截到不小于 0。真实计数和落在格外的点数都不输出。每个点只计入第一个包含它的格；前提是每人一个点。同一数据用不同参数多次发布时隐私预算累加。`,
  ]);
}
