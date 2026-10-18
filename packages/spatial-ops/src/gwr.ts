// SPDX-License-Identifier: Apache-2.0

import { SpatialOpError } from "./errors.js";

/**
 * 地理加权回归（GWR）。每个点用核权重做一次加权最小二乘，解法是 Householder QR。
 * AICc = n·ln(2π·RSS/n) + n + 2n(tr(S)+1)/(n − tr(S) − 2)，与 mgwr 的定义一致。
 * 自适应带宽取每点第 k 近（含自身）的距离 × 1.0000001。
 */

export type GwrKernel = "gaussian" | "bisquare";

export interface GwrFit {
  readonly bandwidth: number;
  readonly kernel: GwrKernel;
  readonly adaptive: boolean;
  readonly betas: readonly (readonly number[])[];
  readonly standardErrors: readonly (readonly number[])[];
  readonly yhat: readonly number[];
  readonly residuals: readonly number[];
  readonly localR2: readonly number[];
  readonly hatDiagonal: readonly number[];
  readonly traceS: number;
  readonly rss: number;
  readonly tss: number;
  readonly r2: number;
  readonly sigma2: number;
  readonly aicc: number;
}

export interface OlsFit {
  readonly beta: readonly number[];
  readonly rss: number;
  readonly r2: number;
  readonly aicc: number;
}

interface LocalSolve {
  readonly beta: number[];
  readonly rInverse: number[][];
}

/** 解 min ||A·b − y||。A 是 m×p 行优先。返回 b 和 R⁻¹；秩不足时返回 null。 */
function solveQr(a: number[][], y: number[], p: number): LocalSolve | null {
  const m = a.length;
  if (m < p) return null;
  const r = a.map((row) => row.slice());
  const qty = y.slice();
  let scale = 0;
  for (const row of r) for (const value of row) scale = Math.max(scale, Math.abs(value));
  if (!(scale > 0)) return null;
  for (let k = 0; k < p; k += 1) {
    let norm = 0;
    for (let i = k; i < m; i += 1) norm += (r[i]?.[k] ?? 0) ** 2;
    norm = Math.sqrt(norm);
    if (norm <= 1e-12 * scale) return null;
    const pivot = r[k]?.[k] ?? 0;
    const alpha = pivot > 0 ? -norm : norm;
    const v: number[] = new Array<number>(m - k).fill(0);
    for (let i = k; i < m; i += 1) v[i - k] = r[i]?.[k] ?? 0;
    v[0] = (v[0] ?? 0) - alpha;
    let vNorm2 = 0;
    for (const value of v) vNorm2 += value * value;
    if (vNorm2 === 0) continue;
    for (let j = k; j < p; j += 1) {
      let dot = 0;
      for (let i = k; i < m; i += 1) dot += (v[i - k] ?? 0) * (r[i]?.[j] ?? 0);
      const factor = (2 * dot) / vNorm2;
      for (let i = k; i < m; i += 1) {
        const row = r[i];
        if (row) row[j] = (row[j] ?? 0) - factor * (v[i - k] ?? 0);
      }
    }
    let dot = 0;
    for (let i = k; i < m; i += 1) dot += (v[i - k] ?? 0) * (qty[i] ?? 0);
    const factor = (2 * dot) / vNorm2;
    for (let i = k; i < m; i += 1) qty[i] = (qty[i] ?? 0) - factor * (v[i - k] ?? 0);
  }
  const beta = new Array<number>(p).fill(0);
  for (let i = p - 1; i >= 0; i -= 1) {
    let sum = qty[i] ?? 0;
    for (let j = i + 1; j < p; j += 1) sum -= (r[i]?.[j] ?? 0) * (beta[j] ?? 0);
    beta[i] = sum / (r[i]?.[i] ?? 1);
  }
  const rInverse: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  for (let column = 0; column < p; column += 1) {
    for (let i = column; i >= 0; i -= 1) {
      let sum = i === column ? 1 : 0;
      for (let j = i + 1; j <= column; j += 1) sum -= (r[i]?.[j] ?? 0) * (rInverse[j]?.[column] ?? 0);
      const row = rInverse[i];
      if (row) row[column] = sum / (r[i]?.[i] ?? 1);
    }
  }
  return { beta, rInverse };
}

function aiccOf(n: number, rss: number, traceS: number): number {
  if (!(rss > 0) || n - traceS - 2 <= 0) return Number.POSITIVE_INFINITY;
  return n * Math.log((2 * Math.PI * rss) / n) + n + (2 * n * (traceS + 1)) / (n - traceS - 2);
}

function sumOfSquaresAroundMean(y: readonly number[]): number {
  const mean = y.reduce((total, value) => total + value, 0) / y.length;
  return y.reduce((total, value) => total + (value - mean) ** 2, 0);
}

export function olsFit(x: readonly (readonly number[])[], y: readonly number[]): OlsFit {
  const p = x[0]?.length ?? 0;
  const solved = solveQr(x.map((row) => row.slice()), y.slice(), p);
  if (!solved) throw new SpatialOpError("全局回归奇异。解释变量可能共线。");
  let rss = 0;
  for (let i = 0; i < y.length; i += 1) {
    const row = x[i] ?? [];
    let predicted = 0;
    for (let j = 0; j < p; j += 1) predicted += (row[j] ?? 0) * (solved.beta[j] ?? 0);
    rss += ((y[i] ?? 0) - predicted) ** 2;
  }
  return { beta: solved.beta, rss, r2: 1 - rss / sumOfSquaresAroundMean(y), aicc: aiccOf(y.length, rss, p) };
}

/** 每点的核带宽。固定带宽时每点相同。 */
function bandwidthsOf(distances: Float64Array, n: number, bandwidth: number, adaptive: boolean): Float64Array {
  const result = new Float64Array(n);
  if (!adaptive) {
    result.fill(bandwidth);
    return result;
  }
  const k = Math.round(bandwidth);
  const row = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) row[j] = distances[i * n + j] ?? 0;
    row.sort();
    result[i] = (row[Math.min(n, k) - 1] ?? 0) * 1.0000001;
  }
  return result;
}

function kernelWeight(kernel: GwrKernel, distance: number, bandwidth: number): number {
  if (kernel === "gaussian") return bandwidth > 0 ? Math.exp(-0.5 * (distance / bandwidth) ** 2) : distance === 0 ? 1 : 0;
  if (!(distance < bandwidth)) return 0;
  return (1 - (distance / bandwidth) ** 2) ** 2;
}

/** 给定带宽拟合。只算 AICc 时 full=false，跳过标准误和局部 R²。 */
function fitAt(
  x: readonly (readonly number[])[],
  y: readonly number[],
  distances: Float64Array,
  kernel: GwrKernel,
  adaptive: boolean,
  bandwidth: number,
  full: boolean,
): GwrFit | null {
  const n = y.length;
  const p = x[0]?.length ?? 0;
  const widths = bandwidthsOf(distances, n, bandwidth, adaptive);
  const betas: number[][] = [];
  const inverses: number[][][] = [];
  const weightsOf: Float64Array[] = [];
  const hat: number[] = [];
  const yhat: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const weights = new Float64Array(n);
    const rows: number[][] = [];
    const values: number[] = [];
    for (let j = 0; j < n; j += 1) {
      const weight = kernelWeight(kernel, distances[i * n + j] ?? 0, widths[i] ?? 0);
      weights[j] = weight;
      if (!(weight > 0)) continue;
      const root = Math.sqrt(weight);
      rows.push((x[j] ?? []).map((value) => value * root));
      values.push((y[j] ?? 0) * root);
    }
    const solved = solveQr(rows, values, p);
    if (!solved) return null;
    const own = x[i] ?? [];
    let predicted = 0;
    for (let j = 0; j < p; j += 1) predicted += (own[j] ?? 0) * (solved.beta[j] ?? 0);
    // S_ii = w_ii · x_iᵀ(XᵀWX)⁻¹x_i = ||R⁻ᵀx_i||²，w_ii = 1。
    let leverage = 0;
    for (let column = 0; column < p; column += 1) {
      let sum = 0;
      for (let row = 0; row <= column; row += 1) sum += (solved.rInverse[row]?.[column] ?? 0) * (own[row] ?? 0);
      leverage += sum * sum;
    }
    betas.push(solved.beta);
    inverses.push(solved.rInverse);
    weightsOf.push(weights);
    hat.push(leverage);
    yhat.push(predicted);
  }
  const residuals = y.map((value, index) => value - (yhat[index] ?? 0));
  const rss = residuals.reduce((total, value) => total + value * value, 0);
  const traceS = hat.reduce((total, value) => total + value, 0);
  const tss = sumOfSquaresAroundMean(y);
  const aicc = aiccOf(n, rss, traceS);
  const sigma2 = n - traceS > 0 ? rss / (n - traceS) : Number.NaN;
  const standardErrors: number[][] = [];
  const localR2: number[] = [];
  if (full) {
    for (let i = 0; i < n; i += 1) {
      const weights = weightsOf[i] ?? new Float64Array(n);
      const rInverse = inverses[i] ?? [];
      // (XᵀWX)⁻¹ = R⁻¹R⁻ᵀ；Var(β) = σ²·(XᵀWX)⁻¹ XᵀW²X (XᵀWX)⁻¹。
      const inverse: number[][] = Array.from({ length: p }, (_, a) => Array.from({ length: p }, (_unused, b) => {
        let sum = 0;
        for (let k = Math.max(a, b); k < p; k += 1) sum += (rInverse[a]?.[k] ?? 0) * (rInverse[b]?.[k] ?? 0);
        return sum;
      }));
      const middle: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
      let weightSum = 0;
      let weightedY = 0;
      for (let j = 0; j < n; j += 1) {
        const weight = weights[j] ?? 0;
        if (!(weight > 0)) continue;
        weightSum += weight;
        weightedY += weight * (y[j] ?? 0);
        const row = x[j] ?? [];
        for (let a = 0; a < p; a += 1) {
          const line = middle[a];
          if (!line) continue;
          for (let b = 0; b < p; b += 1) line[b] = (line[b] ?? 0) + weight * weight * (row[a] ?? 0) * (row[b] ?? 0);
        }
      }
      const errors: number[] = [];
      for (let a = 0; a < p; a += 1) {
        let variance = 0;
        for (let b = 0; b < p; b += 1) {
          for (let c = 0; c < p; c += 1) variance += (inverse[a]?.[b] ?? 0) * (middle[b]?.[c] ?? 0) * (inverse[c]?.[a] ?? 0);
        }
        errors.push(Math.sqrt(Math.max(0, sigma2 * variance)));
      }
      standardErrors.push(errors);
      const meanY = weightedY / weightSum;
      let totalW = 0;
      let residualW = 0;
      for (let j = 0; j < n; j += 1) {
        const weight = weights[j] ?? 0;
        if (!(weight > 0)) continue;
        totalW += weight * ((y[j] ?? 0) - meanY) ** 2;
        residualW += weight * (residuals[j] ?? 0) ** 2;
      }
      localR2.push(totalW > 0 ? (totalW - residualW) / totalW : Number.NaN);
    }
  }
  return {
    bandwidth: adaptive ? Math.round(bandwidth) : bandwidth,
    kernel,
    adaptive,
    betas,
    standardErrors,
    yhat,
    residuals,
    localR2,
    hatDiagonal: hat,
    traceS,
    rss,
    tss,
    r2: 1 - rss / tss,
    sigma2,
    aicc,
  };
}

export function gwrFit(
  x: readonly (readonly number[])[],
  y: readonly number[],
  distances: Float64Array,
  kernel: GwrKernel,
  adaptive: boolean,
  bandwidth: number,
): GwrFit {
  const fitted = fitAt(x, y, distances, kernel, adaptive, bandwidth, true);
  if (!fitted) throw new SpatialOpError("带宽太小，有点的局部回归奇异。请加大带宽。");
  return fitted;
}

export function gwrAicc(
  x: readonly (readonly number[])[],
  y: readonly number[],
  distances: Float64Array,
  kernel: GwrKernel,
  adaptive: boolean,
  bandwidth: number,
): number {
  return fitAt(x, y, distances, kernel, adaptive, bandwidth, false)?.aicc ?? Number.POSITIVE_INFINITY;
}

/**
 * 按 AICc 选带宽。自适应且 n ≤ 150 时逐个 k 穷举；其余先在对数格网上粗扫，再黄金分割细化，
 * 自适应时取整。bisquare 固定带宽的下界保证每点至少有 p+2 个邻居落在带宽内。
 */
export function selectBandwidth(
  x: readonly (readonly number[])[],
  y: readonly number[],
  distances: Float64Array,
  kernel: GwrKernel,
  adaptive: boolean,
): { readonly bandwidth: number; readonly aicc: number; readonly evaluations: number } {
  const n = y.length;
  const p = x[0]?.length ?? 0;
  const cache = new Map<number, number>();
  const score = (value: number): number => {
    const key = adaptive ? Math.round(value) : value;
    const known = cache.get(key);
    if (known !== undefined) return known;
    const result = gwrAicc(x, y, distances, kernel, adaptive, key);
    cache.set(key, result);
    return result;
  };
  let lower: number;
  let upper: number;
  if (adaptive) {
    lower = Math.min(n, p + 2);
    upper = n;
    if (n <= 150) {
      let best = { bandwidth: upper, aicc: Number.POSITIVE_INFINITY };
      for (let k = lower; k <= upper; k += 1) {
        const value = score(k);
        if (value < best.aicc) best = { bandwidth: k, aicc: value };
      }
      if (!Number.isFinite(best.aicc)) throw new SpatialOpError("没有可用的带宽。样本可能太少或共线。");
      return { ...best, evaluations: cache.size };
    }
  } else {
    let maximum = 0;
    let minimum = Number.POSITIVE_INFINITY;
    let neighborFloor = 0;
    const row = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        const value = distances[i * n + j] ?? 0;
        row[j] = value;
        maximum = Math.max(maximum, value);
        if (value > 0) minimum = Math.min(minimum, value);
      }
      row.sort();
      neighborFloor = Math.max(neighborFloor, row[Math.min(n - 1, p + 1)] ?? 0);
    }
    if (!(maximum > 0)) throw new SpatialOpError("要素位置全部重合，不能做地理加权回归。");
    // bisquare 在带宽外权重为 0，每点至少要有 p+2 个邻居；gaussian 权重处处为正，从最小点距的一半开始。
    lower = kernel === "bisquare" ? Math.max(neighborFloor, maximum * 1e-6) : minimum / 2;
    upper = maximum;
  }
  // 先在对数格网上粗扫 30 个点，再在最好的点两侧做黄金分割，避免多峰或下端 AICc 为无穷时走偏。
  const candidates: number[] = [];
  for (let index = 0; index < 30; index += 1) {
    const value = lower * (upper / lower) ** (index / 29);
    candidates.push(adaptive ? Math.round(value) : value);
  }
  let bestIndex = 0;
  candidates.forEach((value, index) => {
    if (score(value) < score(candidates[bestIndex] ?? value)) bestIndex = index;
  });
  const ratio = (Math.sqrt(5) - 1) / 2;
  let a = candidates[Math.max(0, bestIndex - 1)] ?? lower;
  let b = candidates[Math.min(candidates.length - 1, bestIndex + 1)] ?? upper;
  let c = b - ratio * (b - a);
  let d = a + ratio * (b - a);
  let fc = score(c);
  let fd = score(d);
  for (let iteration = 0; iteration < 200; iteration += 1) {
    if (adaptive ? Math.round(b) - Math.round(a) <= 1 : b - a <= 1e-6 * Math.max(1, Math.abs(b))) break;
    if (fc <= fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - ratio * (b - a);
      fc = score(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + ratio * (b - a);
      fd = score(d);
    }
  }
  let best = { bandwidth: upper, aicc: Number.POSITIVE_INFINITY };
  const finals = adaptive ? [Math.round(a), Math.round(b), Math.round(c), Math.round(d)] : [a, b, c, d];
  for (const candidate of finals) {
    const value = score(candidate);
    if (value < best.aicc) best = { bandwidth: candidate, aicc: value };
  }
  for (const [key, value] of cache) if (value < best.aicc) best = { bandwidth: key, aicc: value };
  if (!Number.isFinite(best.aicc)) throw new SpatialOpError("没有可用的带宽。样本可能太少或共线。");
  return { ...best, evaluations: cache.size };
}
