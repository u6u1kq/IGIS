// SPDX-License-Identifier: Apache-2.0

/**
 * V0.93.1 模型：注记避让、网络 Gi*、地理加权回归（与 numpy 独立实现对照）、
 * OD 重力模型、k 匿名、差分隐私格网。空间工具都经适配器调用。
 * 运行：npx tsx --tsconfig tsconfig.json apps/cli/src/v093-model-check.ts
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { env as nodeEnv } from "node:process";
import { booleanPointInPolygon } from "@turf/turf";
import { AUDIT_REQUIRED_OPERATIONS, CAPABILITY_MANIFEST } from "@igis/ai-boundary";
import { managedPythonPath } from "@igis/external-gateway";
import { GIS_TOOL_REGISTRY, canonicalToolName } from "@igis/llm-dispatch";
import { createSpatialAwareAdapter } from "../../../packages/spatial-ops/src/adapter.js";
import { CAPABILITY_OPERATIONS } from "../../../packages/spatial-ops/src/execute-gis-operation.js";
import { gwrFit, olsFit, selectBandwidth } from "../../../packages/spatial-ops/src/gwr.js";
import { openSpatialStack } from "../../../packages/spatial-ops/src/service.js";
import type { MapCollection, MapFeature } from "../../../packages/spatial-ops/src/types.js";
import { balanceGravity, calibrateGravity, dpGridFeatures, giStar, laplaceNoise } from "../../../packages/spatial-ops/src/v093-models.js";

const REPO_ROOT = resolve("E:/ai工作区/Igis");
const NAMES = ["map.offsetLine", "map.costCorridor", "map.classify", "map.hotspot", "map.gwr", "map.odFlow", "map.kAnonymize", "map.dpGrid"] as const;
const OPERATIONS = ["offset-line", "cost-corridor", "classify", "hotspot", "gwr", "od-flow", "k-anonymity", "dp-grid"] as const;
const ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["offset_line", "map.offsetLine"], ["cost_corridor", "map.costCorridor"], ["classify_raster", "map.classify"],
  ["hotspot_gi", "map.hotspot"], ["gwr_regression", "map.gwr"], ["od_flow", "map.odFlow"],
  ["k_anonymize", "map.kAnonymize"], ["dp_grid_count", "map.dpGrid"],
];

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

function close(actual: number, expected: number, tolerance: number): boolean {
  return Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected));
}

/** 固定种子的线性同余发生器，用例可重复。 */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state + 0.5) / 4294967296;
  };
}

function point(x: number, y: number, properties: Record<string, string | number | boolean | null>): MapFeature {
  return { type: "Feature", properties, geometry: { type: "Point", coordinates: [x, y] } };
}

function line(coordinates: readonly (readonly [number, number])[]): MapFeature {
  return { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coordinates.map((pair) => [pair[0], pair[1]]) } };
}

function square(x: number, y: number, size: number, properties: Record<string, string | number | boolean | null>): MapFeature {
  return { type: "Feature", properties, geometry: { type: "Polygon", coordinates: [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]] } };
}

function collection(features: readonly MapFeature[]): MapCollection {
  return { type: "FeatureCollection", features: [...features] };
}

function run(command: string, args: readonly string[]): Promise<string> {
  return new Promise((done, reject) => {
    const child = spawn(command, [...args], { env: nodeEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => { stdout += typeof chunk === "string" ? chunk : String(chunk); });
    child.stderr.on("data", (chunk: Buffer | string) => { stderr += typeof chunk === "string" ? chunk : String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr.trim() || stdout.trim() || `退出码 ${String(code)}`));
      else done(stdout.trim());
    });
  });
}

interface Box { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
interface Placement extends Box { readonly id: string; readonly position: string }
interface LabelApi {
  placeLabels(items: readonly unknown[], options: unknown): { placed: Placement[]; dropped: string[] };
  polygonAnchor(rings: readonly (readonly (readonly [number, number])[])[]): { point: [number, number]; clearance: number } | null;
  lineAnchors(line: readonly (readonly [number, number])[]): { anchors: [number, number][]; length: number };
}

function loadLabelApi(): LabelApi {
  const source = readFileSync(resolve(REPO_ROOT, "apps/desktop/ui/label-placement.js"), { encoding: "utf8" });
  const scope: { IgisLabelPlacement?: LabelApi } = {};
  new Function("globalThis", source)(scope);
  check(scope.IgisLabelPlacement, "注记模块没有挂出 IgisLabelPlacement");
  return scope.IgisLabelPlacement;
}

function labelChecks(): void {
  const api = loadLabelApi();
  const width = 400;
  const height = 300;
  const random = seeded(7);
  const symbols: Array<{ x: number; y: number; r: number }> = [];
  const items = Array.from({ length: 60 }, (_, index) => {
    const x = 170 + random() * 60;
    const y = 120 + random() * 60;
    symbols.push({ x, y, r: 5 });
    return { id: `p${index}`, text: `点${index}`, width: 48, height: 14, kind: "point", anchors: [[x, y]], radius: 5, rank: 0 };
  });
  const { placed, dropped } = api.placeLabels(items, { width, height, padding: 2, symbols });
  check(placed.length + dropped.length === 60, "放置和丢弃之和应等于输入数");
  check(dropped.length > 0 && placed.length > 0, `拥挤时应部分放置部分丢弃，实际放 ${placed.length} 丢 ${dropped.length}`);
  for (let i = 0; i < placed.length; i += 1) {
    const a = placed[i];
    if (!a) continue;
    check(a.x >= 0 && a.y >= 0 && a.x + a.width <= width && a.y + a.height <= height, `${a.id} 超出视口`);
    for (let j = i + 1; j < placed.length; j += 1) {
      const b = placed[j];
      if (!b) continue;
      const apart = a.x + a.width + 2 <= b.x || b.x + b.width + 2 <= a.x || a.y + a.height + 2 <= b.y || b.y + b.height + 2 <= a.y;
      check(apart, `${a.id} 和 ${b.id} 重叠`);
    }
    for (const circle of symbols) {
      const nx = Math.max(a.x, Math.min(circle.x, a.x + a.width));
      const ny = Math.max(a.y, Math.min(circle.y, a.y + a.height));
      check(Math.hypot(circle.x - nx, circle.y - ny) >= circle.r + 2 - 1e-9, `${a.id} 压住了点符号`);
    }
  }

  const single = api.placeLabels([{ id: "a", text: "甲", width: 30, height: 14, kind: "point", anchors: [[200, 150]], radius: 5 }], { width, height });
  check(single.placed[0]?.position === "NE", `空旷处应放右上，实际 ${single.placed[0]?.position ?? "无"}`);
  const edge = api.placeLabels([{ id: "b", text: "乙", width: 30, height: 14, kind: "point", anchors: [[395, 150]], radius: 5 }], { width, height });
  check(edge.placed[0]?.position === "NW", `靠右边界应改放左上，实际 ${edge.placed[0]?.position ?? "无"}`);
  const ranked = api.placeLabels([
    { id: "low", text: "下层", width: 30, height: 14, kind: "point", anchors: [[200, 150]], radius: 5, rank: 1 },
    { id: "top", text: "上层", width: 30, height: 14, kind: "point", anchors: [[200, 150]], radius: 5, rank: 0 },
  ], { width, height });
  const top = ranked.placed.find((item) => item.id === "top");
  const low = ranked.placed.find((item) => item.id === "low");
  check(top?.position === "NE" && low?.position === "SE", `上层图层先占右上，实际 ${top?.position ?? "无"} / ${low?.position ?? "无"}`);

  const lShape: [number, number][] = [[0, 0], [100, 0], [100, 30], [30, 30], [30, 100], [0, 100], [0, 0]];
  const anchor = api.polygonAnchor([lShape]);
  check(anchor !== null, "L 形应有注记点");
  const [ax, ay] = anchor.point;
  const insideL = ax > 0 && ay > 0 && (ax < 30 || ay < 30);
  check(insideL, `L 形注记点应在面内，实际 ${ax},${ay}`);
  // L 形最大内切圆在拐角处，半径 30/(1+1/√2) ≈ 17.57。
  check(anchor.clearance > 16.5 && anchor.clearance <= 17.58, `L 形注记点离边界应约 17.57，实际 ${anchor.clearance}`);
  const holed = api.polygonAnchor([
    [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]],
    [[30, 30], [70, 30], [70, 70], [30, 70], [30, 30]],
  ]);
  check(holed !== null, "带洞的面应有注记点");
  const [hx, hy] = holed.point;
  check(!(hx > 30 && hx < 70 && hy > 30 && hy < 70), `注记点不能落在洞里，实际 ${hx},${hy}`);
  const along = api.lineAnchors([[0, 0], [40, 0], [100, 0]]);
  check(close(along.anchors[0]?.[0] ?? 0, 50, 1e-12) && close(along.anchors[1]?.[0] ?? 0, 100 / 3, 1e-12) && along.length === 100, "线注记点应在 1/2、1/3 处");
  console.log(`ok 注记避让（60 个拥挤点放 ${placed.length} 个，无重叠，不压点符号）`);
}

async function gwrChecks(root: string): Promise<{ readonly x: number[][]; readonly y: number[]; readonly coords: [number, number][] }> {
  const random = seeded(20261017);
  const coords: [number, number][] = [];
  const x: number[][] = [];
  const y: number[] = [];
  for (let row = 0; row < 9; row += 1) {
    for (let column = 0; column < 9; column += 1) {
      const u = column * 10 + random() * 4;
      const v = row * 10 + random() * 4;
      const x1 = random() * 10;
      const x2 = random() * 5;
      const noise = (random() + random() + random() - 1.5) * 0.4;
      coords.push([u, v]);
      x.push([1, x1, x2]);
      y.push(1 + 0.05 * u + (0.5 + 0.04 * v) * x1 - 1.5 * x2 + noise);
    }
  }
  const n = y.length;
  const distances = new Float64Array(n * n);
  for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) {
    const a = coords[i];
    const b = coords[j];
    distances[i * n + j] = a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : 0;
  }
  const adaptive = gwrFit(x, y, distances, "bisquare", true, 25);
  const fixed = gwrFit(x, y, distances, "gaussian", false, 18);
  const selected = selectBandwidth(x, y, distances, "bisquare", true);
  const fixedSelected = selectBandwidth(x, y, distances, "gaussian", false);
  const ols = olsFit(x, y);
  const huge = gwrFit(x, y, distances, "gaussian", false, 1e9);
  check(huge.betas.every((beta) => beta.every((value, k) => close(value, ols.beta[k] ?? 0, 1e-6))), "带宽极大时 GWR 系数应等于全局 OLS");
  check(close(huge.traceS, 3, 1e-6) && close(huge.aicc, ols.aicc, 1e-6), `带宽极大时 tr(S)=p 且 AICc 等于 OLS，实际 ${huge.traceS} / ${huge.aicc} vs ${ols.aicc}`);
  check(selected.aicc < ols.aicc - 10, `系数随位置变化时 GWR 的 AICc 应明显低于 OLS，实际 ${selected.aicc} vs ${ols.aicc}`);

  const python = managedPythonPath(REPO_ROOT);
  check(python !== null, "托管 Python 不在，GWR 对照不能跑。");
  const dataPath = join(root, "gwr.json");
  await writeFile(dataPath, JSON.stringify({ coords, x, y }), { encoding: "utf8" });
  const script = String.raw`
import json, os, sys
os.environ["PATH"] = os.path.join(sys.prefix, "Library", "bin") + os.pathsep + os.environ.get("PATH", "")
import numpy as np
data = json.load(open(sys.argv[1], encoding="utf-8"))
X = np.array(data["x"], dtype=float); y = np.array(data["y"], dtype=float); C = np.array(data["coords"], dtype=float)
n, p = X.shape
D = np.sqrt(((C[:, None, :] - C[None, :, :]) ** 2).sum(axis=2))
def fit(kernel, adaptive, bw):
    B = np.zeros((n, p)); S = np.zeros(n); SE = np.zeros((n, p)); R2 = np.zeros(n); W = np.zeros((n, n))
    for i in range(n):
        d = D[i]
        h = np.sort(d)[int(bw) - 1] * 1.0000001 if adaptive else bw
        if kernel == "gaussian":
            w = np.exp(-0.5 * (d / h) ** 2)
        else:
            w = np.where(d < h, (1 - (d / h) ** 2) ** 2, 0.0)
        W[i] = w
        XtW = X.T * w
        inv = np.linalg.inv(XtW @ X)
        B[i] = inv @ XtW @ y
        S[i] = X[i] @ inv @ X[i] * w[i]
    yhat = (X * B).sum(axis=1); resid = y - yhat; rss = float(resid @ resid); tr = float(S.sum())
    aicc = n * np.log(2 * np.pi * rss / n) + n + 2 * n * (tr + 1) / (n - tr - 2) if n - tr - 2 > 0 else float("inf")
    sigma2 = rss / (n - tr)
    for i in range(n):
        w = W[i]; XtW = X.T * w; inv = np.linalg.inv(XtW @ X); Cm = inv @ XtW
        SE[i] = np.sqrt(np.diag(Cm @ Cm.T) * sigma2)
        ybar = (w * y).sum() / w.sum()
        tss = (w * (y - ybar) ** 2).sum(); rssw = (w * resid ** 2).sum()
        R2[i] = (tss - rssw) / tss
    return {"betas": B.tolist(), "hat": S.tolist(), "se": SE.tolist(), "r2": R2.tolist(), "aicc": float(aicc), "traceS": tr, "rss": rss}
out = {"adaptive": fit("bisquare", True, 25), "fixed": fit("gaussian", False, 18)}
scores = []
for k in range(p + 2, n + 1):
    try:
        scores.append((fit("bisquare", True, k)["aicc"], k))
    except np.linalg.LinAlgError:
        pass
best = min(scores)
out["bestK"] = best[1]; out["bestAicc"] = best[0]
grid = np.linspace(5, 150, 300)
out["fixedGridMin"] = min(fit("gaussian", False, float(b))["aicc"] for b in grid)
json.dump(out, open(sys.argv[2], "w", encoding="utf-8"))
`;
  const scriptPath = join(root, "gwr_reference.py");
  const outPath = join(root, "gwr_reference.json");
  await writeFile(scriptPath, script, { encoding: "utf8" });
  await run(python, [scriptPath, dataPath, outPath]);
  const reference = JSON.parse(await readFile(outPath, { encoding: "utf8" })) as Record<string, unknown>;
  type Ref = { betas: number[][]; hat: number[]; se: number[][]; r2: number[]; aicc: number; traceS: number; rss: number };
  const compare = (label: string, mine: typeof adaptive, theirs: Ref): void => {
    let worst = 0;
    mine.betas.forEach((row, i) => row.forEach((value, k) => { worst = Math.max(worst, Math.abs(value - (theirs.betas[i]?.[k] ?? Number.NaN))); }));
    mine.hatDiagonal.forEach((value, i) => { worst = Math.max(worst, Math.abs(value - (theirs.hat[i] ?? Number.NaN))); });
    mine.standardErrors.forEach((row, i) => row.forEach((value, k) => { worst = Math.max(worst, Math.abs(value - (theirs.se[i]?.[k] ?? Number.NaN))); }));
    mine.localR2.forEach((value, i) => { worst = Math.max(worst, Math.abs(value - (theirs.r2[i] ?? Number.NaN))); });
    check(worst < 1e-8, `${label} 的系数、杠杆、标准误或局部 R² 与 numpy 不一致，最大差 ${worst}`);
    check(close(mine.aicc, theirs.aicc, 1e-10) && close(mine.traceS, theirs.traceS, 1e-10) && close(mine.rss, theirs.rss, 1e-10), `${label} 的 AICc/tr(S)/RSS 与 numpy 不一致：${mine.aicc} vs ${theirs.aicc}`);
  };
  compare("自适应 bisquare k=25", adaptive, reference.adaptive as Ref);
  compare("固定 gaussian 18", fixed, reference.fixed as Ref);
  check(selected.bandwidth === reference.bestK && close(selected.aicc, Number(reference.bestAicc), 1e-10), `AICc 选出的 k 应为 ${String(reference.bestK)}，实际 ${selected.bandwidth}`);
  check(fixedSelected.aicc <= Number(reference.fixedGridMin) + 1e-6, `固定带宽选出的 AICc ${fixedSelected.aicc} 不应高于格网最小值 ${String(reference.fixedGridMin)}`);
  const fixedBisquare = selectBandwidth(x, y, distances, "bisquare", false);
  check(Number.isFinite(fixedBisquare.aicc) && fixedBisquare.aicc < ols.aicc, `固定 bisquare 也应选出有限且优于 OLS 的带宽，实际 ${fixedBisquare.aicc}`);

  // n > 150 时自适应带宽走粗扫加黄金分割，对照逐个 k 穷举。
  const big = seeded(31);
  const bigCoords: [number, number][] = [];
  const bigX: number[][] = [];
  const bigY: number[] = [];
  for (let index = 0; index < 196; index += 1) {
    const u = (index % 14) * 7 + big() * 3;
    const v = Math.floor(index / 14) * 7 + big() * 3;
    const x1 = big() * 10;
    bigCoords.push([u, v]);
    bigX.push([1, x1]);
    bigY.push(2 + Math.sin(u / 15) * 3 + (0.5 + 0.03 * v) * x1 + (big() - 0.5));
  }
  const m = bigY.length;
  const bigDistances = new Float64Array(m * m);
  for (let i = 0; i < m; i += 1) for (let j = 0; j < m; j += 1) {
    const a = bigCoords[i];
    const b = bigCoords[j];
    bigDistances[i * m + j] = a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : 0;
  }
  const bigSelected = selectBandwidth(bigX, bigY, bigDistances, "bisquare", true);
  let bigBest = Number.POSITIVE_INFINITY;
  for (let k = 4; k <= m; k += 1) bigBest = Math.min(bigBest, gwrFit(bigX, bigY, bigDistances, "bisquare", true, k).aicc);
  check(bigSelected.aicc <= bigBest + 1e-9, `n=196 自适应选带宽应达到穷举最小 AICc ${bigBest}，实际 ${bigSelected.aicc}（k=${bigSelected.bandwidth}，算了 ${bigSelected.evaluations} 次）`);
  console.log(`ok GWR 与 numpy 一致（k=${selected.bandwidth}，AICc ${selected.aicc.toFixed(4)}，OLS ${ols.aicc.toFixed(4)}）`);
  return { x, y, coords };
}

function gravityChecks(): void {
  const production = [100, 250, 50];
  const attraction = [120, 80, 200];
  const costs = Float64Array.from([1, 4, 9, 3, 2, 6, 8, 5, 1]);
  const total = 400;
  const free = balanceGravity(production, attraction, costs, "exp", 0);
  for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) {
    const expected = ((production[i] ?? 0) * (attraction[j] ?? 0)) / total;
    check(close(free.flows[i * 3 + j] ?? 0, expected, 1e-9), `β=0 时流量应为 P·A/T=${expected}`);
  }
  const deterred = balanceGravity(production, attraction, costs, "exp", 0.4);
  for (let i = 0; i < 3; i += 1) {
    const sum = [0, 1, 2].reduce((acc, j) => acc + (deterred.flows[i * 3 + j] ?? 0), 0);
    check(close(sum, production[i] ?? 0, 1e-9), `第 ${i + 1} 行流量合计应等于产生量`);
  }
  for (let j = 0; j < 3; j += 1) {
    const sum = [0, 1, 2].reduce((acc, i) => acc + (deterred.flows[i * 3 + j] ?? 0), 0);
    check(close(sum, attraction[j] ?? 0, 1e-9), `第 ${j + 1} 列流量合计应等于吸引量`);
  }
  check(deterred.meanCost < free.meanCost, "β>0 时平均费用应下降");
  const calibrated = calibrateGravity(production, attraction, costs, "exp", 3.5);
  check(close(calibrated.meanCost, 3.5, 1e-8) && calibrated.beta > 0, `标定后平均费用应为 3.5，实际 ${calibrated.meanCost}`);
  // 这组数据的最小费用运输解平均费用为 1270/400 = 3.175，目标 3 不可达。
  let unreachable = "";
  try {
    calibrateGravity(production, attraction, costs, "exp", 3);
  } catch (error) {
    unreachable = error instanceof Error ? error.message : String(error);
  }
  check(unreachable.includes("达不到"), `目标低于最小费用运输解时应报达不到，实际 ${unreachable}`);
  const steep = calibrateGravity(production, attraction, costs, "exp", 3.18);
  check(close(steep.meanCost, 3.18, 1e-6), `接近下限的目标 3.18 也应标定成功，实际 ${steep.meanCost}`);
  const zeroCost = Float64Array.from([0, 4, 9, 3, 2, 6, 8, 5, 1]);
  const power = balanceGravity(production, attraction, zeroCost, "power", 2);
  check(power.flows[0] === 0, "power 时零费用的对不分配流量");
  console.log("ok OD 双约束重力模型（行列合计、β=0 闭式解、标定）");
}

function privacyChecks(): void {
  check(close(giStar([1, 2, 3, 4], [[0, 1]])[0]?.z ?? 0, -1.5491933384829668, 1e-12), "Gi* 手算值应为 -1.549193");
  const random = seeded(99);
  let sum = 0;
  let absolute = 0;
  let square2 = 0;
  const count = 400000;
  for (let i = 0; i < count; i += 1) {
    const value = laplaceNoise(2);
    sum += value;
    absolute += Math.abs(value);
    square2 += value * value;
  }
  check(Math.abs(sum / count) < 0.02, `拉普拉斯噪声均值应约为 0，实际 ${sum / count}`);
  check(close(absolute / count, 2, 0.01), `拉普拉斯噪声平均绝对值应约为尺度 2，实际 ${absolute / count}`);
  check(close(square2 / count, 8, 0.03), `拉普拉斯噪声方差应约为 2b²=8，实际 ${square2 / count}`);
  const points = collection(Array.from({ length: 30 }, (_, index) => point(random() * 20, random() * 10, {})));
  const cells = collection([square(0, 0, 10, { id: "西" }), square(10, 0, 10, { id: "东" })]);
  const exact = dpGridFeatures(points, cells, 1, () => 0.5).collection;
  const truth = [0, 0];
  for (const feature of points.features) {
    const pair = feature.geometry?.type === "Point" ? feature.geometry.coordinates : [0, 0];
    const side = (pair[0] ?? 0) >= 10 ? 1 : 0;
    truth[side] = (truth[side] ?? 0) + 1;
  }
  check(exact.features[0]?.properties._count_dp === truth[0] && exact.features[1]?.properties._count_dp === truth[1], "噪声为 0 时计数应等于真实点数");
  check(exact.features.every((feature) => !("_count" in feature.properties)), "差分隐私结果不能带真实计数");
  console.log("ok Gi* 手算值、拉普拉斯噪声分布、差分隐私计数");
}

async function main(): Promise<void> {
  for (const name of NAMES) {
    check(GIS_TOOL_REGISTRY.some((tool) => tool.name === name), `${name} 不在注册表`);
    check(CAPABILITY_MANIFEST.some((entry) => entry.tool === name), `${name} 不在能力清单`);
  }
  for (const operation of OPERATIONS) {
    check(CAPABILITY_OPERATIONS.includes(operation), `${operation} 不在执行清单`);
    check(AUDIT_REQUIRED_OPERATIONS.includes(operation), `${operation} 不在留痕清单`);
  }
  for (const [alias, name] of ALIASES) check(canonicalToolName(alias) === name, `${alias} 应折回 ${name}`);
  console.log("ok 登记和别名");

  labelChecks();
  gravityChecks();
  privacyChecks();

  const root = await mkdtemp(join(tmpdir(), "igis-v093m-"));
  check(!resolve(root).toLowerCase().startsWith(REPO_ROOT.toLowerCase()), "用例目录不能落在仓库里");
  try {
    const gwrData = await gwrChecks(root);
    const stack = await openSpatialStack({
      layerDirectory: join(root, "layers"),
      auditDirectory: join(root, "audit"),
      cacheDirectory: join(root, "cache"),
      modelName: () => "v093m",
    });
    const adapter = createSpatialAwareAdapter({ execute: async () => ({ ok: true }) }, stack.service, { entry: "chat", operationsRoot: root });
    const call = async (tool: string, args: Record<string, string | number | boolean>): Promise<Record<string, unknown>> => {
      const result = await adapter.execute({ tool: tool as never, args }) as Record<string, unknown>;
      return result;
    };
    const create = async (name: string, features: readonly MapFeature[], kind: "point" | "line" | "polygon"): Promise<string> => {
      const made = await stack.service.createLayer({ layerName: name, collection: collection(features), crsLabel: "Unknown", expectedKind: kind, sourceLabel: "v093m", writeKnowledge: false });
      return made.layer.layerId;
    };
    const rows = (layerId: unknown): MapFeature[] => stack.catalog.collection(String(layerId ?? ""))?.features ?? [];

    // 网络 Gi*：U 形路，左右两臂直线相距 10，沿路相距 210。
    const road = await create("U路", [line([[0, 0], [0, 100], [10, 100], [10, 0]])], "line");
    const values = [10, 12, 11, 1, 2, 1, 5];
    const spots = await create("热点", [
      point(0, 0, { v: 10 }), point(0, 10, { v: 12 }), point(0, 20, { v: 11 }),
      point(10, 0, { v: 1 }), point(10, 10, { v: 2 }), point(10, 20, { v: 1 }),
      point(5, 100, { v: 5 }),
    ], "point");
    const network = await call("map.hotspot", { layerId: spots, fieldName: "v", distance: 15, lineLayerId: road, outputName: "网络热点" });
    check(network.ok === true, `网络热点应成功：${String(network.message ?? network.error ?? "")}`);
    const networkNeighbors = [[0, 1], [0, 1, 2], [1, 2], [3, 4], [3, 4, 5], [4, 5], [6]];
    const networkZ = giStar(values, networkNeighbors);
    const networkRows = rows(network.layerId);
    networkRows.forEach((feature, index) => {
      const expected = networkZ[index]?.z ?? null;
      const actual = feature.properties._gi_z;
      check(typeof actual === "number" && expected !== null && close(actual, expected, 1e-12), `网络 Gi* 第 ${index + 1} 点 z 应为 ${String(expected)}，实际 ${String(actual)}`);
      check(feature.properties._gi_n === networkNeighbors[index]?.length, `网络 Gi* 第 ${index + 1} 点邻居数不对`);
    });
    const straight = await call("map.hotspot", { layerId: spots, fieldName: "v", distance: 15, outputName: "直线热点" });
    const straightRows = rows(straight.layerId);
    check(straightRows[0]?.properties._gi_n === 4, `直线距离 15 内 (0,0) 有 4 个邻居（含自身和对岸两点），实际 ${String(straightRows[0]?.properties._gi_n)}`);
    check(networkRows[0]?.properties._gi_n === 2, "沿路距离 15 内 (0,0) 只有 2 个邻居");
    console.log("ok 网络 Gi* 与直线 Gi* 的邻居不同，z 与手工邻接一致");

    // GWR 经适配器：结果写到要素上，按 AICc 选带宽。
    const gwrLayer = await create("回归", gwrData.coords.map((pair, index) => point(pair[0], pair[1], {
      price: gwrData.y[index] ?? 0,
      floor: gwrData.x[index]?.[1] ?? 0,
      age: gwrData.x[index]?.[2] ?? 0,
    })), "point");
    const gwr = await call("map.gwr", { layerId: gwrLayer, fieldName: "price", predictors: "floor,age", kernel: "bisquare", adaptive: true, outputName: "回归结果" });
    check(gwr.ok === true, `GWR 应成功：${String(gwr.message ?? gwr.error ?? "")}`);
    const gwrRows = rows(gwr.layerId);
    const slopes = gwrRows.map((feature) => Number(feature.properties._b_floor));
    check(gwrRows.length === 81 && slopes.every(Number.isFinite), "GWR 结果应给每点写 _b_floor");
    const southMean = slopes.slice(0, 18).reduce((a, b) => a + b, 0) / 18;
    const northMean = slopes.slice(-18).reduce((a, b) => a + b, 0) / 18;
    check(northMean - southMean > 1.5, `floor 系数应南小北大（真值 0.5→3.7），实际 ${southMean} → ${northMean}`);
    check(String(gwr.message ?? "").includes("AICc"), "GWR 摘要应带 AICc");

    // OD：直线与路网两种费用。
    const origins = await create("起区", [point(0, 0, { pop: 100 }), point(0, 50, { pop: 300 })], "point");
    const destinations = await create("终区", [point(10, 0, { jobs: 50 }), point(10, 50, { jobs: 150 })], "point");
    const od = await call("map.odFlow", { layerId: origins, otherLayerId: destinations, fieldName: "pop", otherFieldName: "jobs", deterrence: "exp", targetMean: 20, outputName: "OD" });
    check(od.ok === true, `OD 应成功：${String(od.message ?? od.error ?? "")}`);
    const odRows = rows(od.layerId);
    const flowTotal = odRows.reduce((acc, feature) => acc + Number(feature.properties._flow ?? 0), 0);
    check(close(flowTotal, 400, 1e-9), `OD 总流量应等于产生量 400，实际 ${flowTotal}`);
    const meanCost = odRows.reduce((acc, feature) => acc + Number(feature.properties._flow ?? 0) * Number(feature.properties._cost ?? 0), 0) / flowTotal;
    check(close(meanCost, 20, 1e-6), `标定后平均费用应为 20，实际 ${meanCost}`);
    const grid = await create("OD路", [line([[0, 0], [10, 0]]), line([[0, 50], [10, 50]]), line([[0, 0], [0, 50]])], "line");
    const odNetwork = await call("map.odFlow", { layerId: origins, otherLayerId: destinations, fieldName: "pop", otherFieldName: "jobs", lineLayerId: grid, deterrence: "exp", beta: 0.05, outputName: "OD路网" });
    const crossing = rows(odNetwork.layerId).find((feature) => feature.properties._from === 1 && feature.properties._to === 2);
    check(crossing && close(Number(crossing.properties._cost), 60, 1e-9), `路网费用：(0,0) 到 (10,50) 沿路 60，实际 ${String(crossing?.properties._cost)}`);

    // k 匿名：每个区域至少 k 个点，区域互不重叠且覆盖全部点。
    const crowd = seeded(5);
    const crowdPoints = Array.from({ length: 500 }, (_, index) => {
      const cluster = index % 3;
      const cx = cluster === 0 ? 10 : cluster === 1 ? 70 : 40;
      const cy = cluster === 2 ? 80 : 20;
      return point(cx + (crowd() - 0.5) * (cluster === 2 ? 40 : 8), cy + (crowd() - 0.5) * (cluster === 2 ? 30 : 8), { name: `人${index}` });
    });
    const crowdLayer = await create("人群", crowdPoints, "point");
    for (const k of [5, 25]) {
      const anonymous = await call("map.kAnonymize", { layerId: crowdLayer, k, outputName: `匿名${k}` });
      check(anonymous.ok === true, `k=${k} 匿名应成功：${String(anonymous.message ?? anonymous.error ?? "")}`);
      const regions = rows(anonymous.layerId);
      const counts = regions.map((feature) => Number(feature.properties._count));
      check(counts.every((value) => value >= k), `k=${k} 时每个区域至少 ${k} 个点，最少 ${Math.min(...counts)}`);
      check(counts.reduce((a, b) => a + b, 0) === 500, "区域点数之和应为 500");
      check(regions.every((feature) => !("name" in feature.properties)), "匿名结果不能带原始属性");
      const recount = regions.map((region) => crowdPoints.filter((item) => booleanPointInPolygon(item.geometry as never, region.geometry as never)).length);
      check(recount.every((value, index) => value === counts[index]), `k=${k} 区域的 _count 应等于落在区域里的点数`);
    }
    console.log("ok GWR 经适配器、OD 直线与路网费用、k 匿名");

    // 差分隐私：重复同样的请求得到同一份噪声；ε ≤ 0 被拒绝。
    const cellLayer = await create("统计格", [square(0, 0, 50, { id: "a" }), square(50, 0, 50, { id: "b" }), square(0, 50, 50, { id: "c" }), square(50, 50, 50, { id: "d" })], "polygon");
    const dp = await call("map.dpGrid", { layerId: crowdLayer, otherLayerId: cellLayer, epsilon: 0.5, outputName: "隐私计数" });
    check(dp.ok === true, `差分隐私计数应成功：${String(dp.message ?? dp.error ?? "")}`);
    const first = rows(dp.layerId).map((feature) => feature.properties._count_dp);
    const again = await call("map.dpGrid", { layerId: crowdLayer, otherLayerId: cellLayer, epsilon: 0.5, outputName: "隐私计数" });
    const second = rows(again.layerId).map((feature) => feature.properties._count_dp);
    check(JSON.stringify(first) === JSON.stringify(second), "同样的请求应返回同一份噪声，不能靠重复查询求平均");
    const rejected = await call("map.dpGrid", { layerId: crowdLayer, otherLayerId: cellLayer, epsilon: 0, outputName: "零" });
    check(rejected.ok !== true, "ε=0 应被拒绝");
    console.log("ok 差分隐私格网经适配器");
    console.log("v093-model-check passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

let failed: unknown = null;
try {
  await main();
} catch (error) {
  failed = error;
}
if (failed) {
  console.error(failed instanceof Error ? failed.message : failed);
  throw failed;
}
