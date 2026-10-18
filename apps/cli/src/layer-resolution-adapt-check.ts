// SPDX-License-Identifier: Apache-2.0

/**
 * 只把构造好的查找结果交给 adaptLayerLookup。
 * 不调用 resolveLayerRef、findByName、LayerStore。不读 var/。不执行 GIS。
 * 运行：npx tsx --tsconfig tsconfig.json apps/cli/src/layer-resolution-adapt-check.ts
 */

import { unknownCrs } from "@igis/surtgis";
import type { LayerMeta } from "../../../packages/spatial-ops/src/catalog.js";
import { adaptLayerLookup } from "../../../packages/spatial-ops/src/layer-resolution.js";
import type { LayerResolutionResult } from "../../../packages/spatial-ops/src/layer-resolution.js";
import type { LayerResolveHit } from "../../../packages/spatial-ops/src/resolve-layer.js";

function keysOf(value: object): string[] {
  return Object.keys(value).sort();
}

function assertKeys(label: string, value: object, expected: readonly string[]): void {
  const actual = keysOf(value);
  const wanted = [...expected].sort();
  if (actual.join(",") !== wanted.join(",")) {
    throw new Error(`${label} 字段不符\n实际: ${actual.join(",")}\n期望: ${wanted.join(",")}`);
  }
}

function assertStable(label: string, run: () => LayerResolutionResult): LayerResolutionResult {
  const first = run();
  const second = run();
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error(`${label} 相同输入两次结果不同\n${JSON.stringify(first)}\n${JSON.stringify(second)}`);
  }
  return first;
}

function assertResolved(label: string, value: LayerResolutionResult, layerId: string, layerName: string): void {
  if (!value.ok) throw new Error(`${label} 应为 Resolved`);
  assertKeys(label, value, ["ok", "layerId", "layerName"]);
  if (value.layerId !== layerId || value.layerName !== layerName) {
    throw new Error(`${label} 身份不符 ${JSON.stringify(value)}`);
  }
  if (
    "code" in value ||
    "candidates" in value ||
    "geometry" in value ||
    "geometryKind" in value ||
    "featureCount" in value ||
    "query" in value ||
    "status" in value
  ) {
    throw new Error(`${label} 成功值带了图层身份以外的字段`);
  }
}

const oneLayer: Exclude<LayerResolveHit, { readonly status: "empty" }> = {
  status: "ok",
  layerId: "lyr-1",
  layerName: "道路",
};
const resolved = assertStable("一条命中", () => adaptLayerLookup(oneLayer));
assertResolved("一条命中", resolved, "lyr-1", "道路");

const none: Exclude<LayerResolveHit, { readonly status: "empty" }> = {
  status: "missing",
  query: "没有这层",
  candidates: [{ layerId: "lyr-9", layerName: "其他", geometryKind: "Point", featureCount: 2 }],
};
const notFound = assertStable("明确未命中", () => adaptLayerLookup(none));
if (notFound.ok || notFound.code !== "NotFound") throw new Error(`明确未命中应为 NotFound ${JSON.stringify(notFound)}`);
assertKeys("明确未命中", notFound, ["ok", "code"]);

const legacyNull = assertStable("遗留查找 null", () => adaptLayerLookup(null));
if (legacyNull.ok || legacyNull.code !== "NotFound") {
  throw new Error(`findByName / get 的 null 应为 NotFound ${JSON.stringify(legacyNull)}`);
}

const multiple: Exclude<LayerResolveHit, { readonly status: "empty" }> = {
  status: "ambiguous",
  query: "道路",
  candidates: [
    { layerId: "lyr-1", layerName: "道路", geometryKind: "LineString", featureCount: 4 },
    { layerId: "lyr-2", layerName: "道路", geometryKind: "Polygon", featureCount: 1 },
  ],
};
const ambiguous = assertStable("多名候选", () => adaptLayerLookup(multiple));
if (ambiguous.ok || ambiguous.code !== "Ambiguous") throw new Error(`多名候选应为 Ambiguous ${JSON.stringify(ambiguous)}`);
assertKeys("多名候选", ambiguous, ["ok", "code", "candidates"]);
if (ambiguous.candidates.length !== 2) throw new Error("多名候选应保留两条");
const firstCandidate = ambiguous.candidates[0];
const secondCandidate = ambiguous.candidates[1];
if (!firstCandidate || !secondCandidate) throw new Error("多名候选缺少条目");
assertKeys("候选 1", firstCandidate, ["layerId", "layerName"]);
assertKeys("候选 2", secondCandidate, ["layerId", "layerName"]);
if (firstCandidate.layerId !== "lyr-1" || secondCandidate.layerId !== "lyr-2") {
  throw new Error("多名候选顺序或标识被改写");
}
if ("geometryKind" in firstCandidate || "featureCount" in firstCandidate || "geometry" in firstCandidate) {
  throw new Error("候选不应留下几何种类或要素数");
}

// LEGACY CURRENT BEHAVIOR：这条 LayerMeta 可能是 findByName 在同名多层里取走的最上一层。
// AMBIGUITY INFORMATION LOST IN LEGACY LOOKUP。一条结果里没有其余候选，不能反推 Ambiguous。
const legacySingle: LayerMeta = {
  layerId: "lyr-top",
  layerName: "道路",
  sourcePaths: [],
  outputFilePath: "unused.geojson",
  featureCount: 9,
  fieldNames: ["name"],
  geometryKind: "Polygon",
  crsLabel: "未声明",
  crsIdentity: unknownCrs(),
};
const legacyResolved = assertStable("遗留单条", () => adaptLayerLookup(legacySingle));
if (!legacyResolved.ok) {
  throw new Error("不能从一条结果推断是否还有被丢掉的候选；单条遗留命中必须是 Resolved，不能编造 Ambiguous");
}
assertResolved(
  "遗留单条",
  legacyResolved,
  "lyr-top",
  "道路",
);

console.log(
  JSON.stringify(
    {
      resolved,
      notFound,
      legacyNull,
      ambiguous,
      legacyResolved,
    },
    null,
    2,
  ),
);
console.log("layer-resolution-adapt-check: ok");
