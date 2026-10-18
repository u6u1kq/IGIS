// SPDX-License-Identifier: Apache-2.0

/**
 * 只构造图层解析结果并检查形状。不查找图层，不读 var/，不执行 GIS。
 * 运行：npx tsx --tsconfig tsconfig.json apps/cli/src/layer-resolution-check.ts
 */

import type { LayerResolution, LayerResolutionResult } from "../../../packages/spatial-ops/src/layer-resolution.js";

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

function assertSuccess(label: string, value: LayerResolutionResult): void {
  if (!value.ok) throw new Error(`${label} 应为成功`);
  assertKeys(label, value, ["ok", "layerId", "layerName"]);
  if (value.layerId.trim() === "" || value.layerName.trim() === "") {
    throw new Error(`${label} 成功身份不能是空白`);
  }
  if ("code" in value || "candidates" in value || "geometry" in value || "features" in value) {
    throw new Error(`${label} 成功值带了解析以外的字段`);
  }
}

function assertNotFound(label: string, value: LayerResolutionResult): void {
  if (value.ok || value.code !== "NotFound") throw new Error(`${label} 应为 NotFound`);
  assertKeys(label, value, ["ok", "code"]);
}

function assertAmbiguous(label: string, value: LayerResolutionResult): void {
  if (value.ok || value.code !== "Ambiguous") throw new Error(`${label} 应为 Ambiguous`);
  assertKeys(label, value, ["ok", "code", "candidates"]);
  if (value.candidates.length < 2) throw new Error(`${label} 多名匹配至少两层`);
  for (const candidate of value.candidates) {
    assertKeys(`${label} 候选`, candidate, ["layerId", "layerName"]);
    if (candidate.layerId.trim() === "") throw new Error(`${label} 候选缺少 layerId`);
  }
}

const success: LayerResolutionResult = { ok: true, layerId: "lyr-1", layerName: "道路" };
const notFound: LayerResolutionResult = { ok: false, code: "NotFound" };
const ambiguous: LayerResolutionResult = {
  ok: false,
  code: "Ambiguous",
  candidates: [
    { layerId: "lyr-1", layerName: "道路" },
    { layerId: "lyr-2", layerName: "道路" },
  ],
};

assertSuccess("success", success);
assertNotFound("NotFound", notFound);
assertAmbiguous("Ambiguous", ambiguous);

const paired: LayerResolution = {
  reference: { kind: "name", name: "道路" },
  result: success,
};
assertKeys("LayerResolution", paired, ["reference", "result"]);
if (paired.result.ok !== true || paired.result.layerId !== "lyr-1") {
  throw new Error("LayerResolution 没有带上成功身份");
}

const idHit: LayerResolution = {
  reference: { kind: "id", id: "lyr-9" },
  result: { ok: true, layerId: "lyr-9", layerName: "选中图层" },
};
if (idHit.reference.kind !== "id" || !idHit.result.ok || idHit.result.layerId !== "lyr-9") {
  throw new Error("id 引用命中时，结果 layerId 应是该层标识");
}

console.log(JSON.stringify({ success, notFound, ambiguous }, null, 2));
console.log("layer-resolution-check: ok");
