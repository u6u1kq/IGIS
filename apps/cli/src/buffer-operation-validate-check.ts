// SPDX-License-Identifier: Apache-2.0

/**
 * 只调用缓冲请求的结构验证。不执行缓冲，不写 var/。
 * 运行：npx tsx --tsconfig tsconfig.json apps/cli/src/buffer-operation-validate-check.ts
 */

import { validateBufferOperation } from "../../../packages/spatial-ops/src/buffer-operation-validate.js";
import type { ValidationResult } from "../../../packages/spatial-ops/src/buffer-operation-validate.js";

const valid = {
  operation: "buffer",
  sourceLayer: { layerId: "lyr-a", layerName: "道路" },
  distance: 300,
  unit: "meters",
};

function sameResult(left: ValidationResult, right: ValidationResult): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function check(
  label: string,
  input: unknown,
  expectOk: boolean,
  field?: string,
): { readonly label: string; readonly result: ValidationResult } {
  const first = validateBufferOperation(input);
  const second = validateBufferOperation(input);
  if (!sameResult(first, second)) {
    throw new Error(`${label}\n两次结果不同\n${JSON.stringify(first)}\n${JSON.stringify(second)}`);
  }
  if (first.ok !== expectOk) {
    throw new Error(`${label}\n实际: ${JSON.stringify(first)}\n期望 ok: ${String(expectOk)}`);
  }
  if (first.ok && "errors" in first) {
    throw new Error(`${label} 通过时不应带 errors`);
  }
  if (!first.ok && field !== undefined && !first.errors.some((item) => item.field === field)) {
    throw new Error(`${label} 缺少字段 ${field}\n${JSON.stringify(first)}`);
  }
  return { label, result: first };
}

const cases = [
  check("1 buffer layer a 300 meters", valid, true),
  check("2 distance 0", { ...valid, distance: 0 }, false, "distance"),
  check("3 distance -1", { ...valid, distance: -1 }, false, "distance"),
  check("4 NaN", { ...valid, distance: Number.NaN }, false, "distance"),
  check("5 Infinity", { ...valid, distance: Number.POSITIVE_INFINITY }, false, "distance"),
  check("6 unit meter", { ...valid, unit: "meter" }, false, "unit"),
  check("7 empty sourceLayer", { ...valid, sourceLayer: { layerId: "", layerName: "道路" } }, false, "sourceLayer"),
  check("7b blank sourceLayer", { ...valid, sourceLayer: { layerId: "lyr-a", layerName: "   " } }, false, "sourceLayer"),
  check(
    "8 raw reference is not a request",
    { ...valid, sourceLayer: { kind: "name-or-id", text: "没有这个图层" } },
    false,
    "sourceLayer",
  ),
  check("8b NotFound is not a request", { ...valid, sourceLayer: { ok: false, code: "NotFound" } }, false, "sourceLayer"),
  check(
    "8c Ambiguous is not a request",
    {
      ...valid,
      sourceLayer: {
        ok: false,
        code: "Ambiguous",
        candidates: [{ layerId: "lyr-a", layerName: "道路" }],
      },
    },
    false,
    "sourceLayer",
  ),
  check("outputName omitted", valid, true),
  check("outputName present", { ...valid, outputName: "道路缓冲" }, true),
  check("outputName empty", { ...valid, outputName: "" }, false, "outputName"),
  check("outputName not string", { ...valid, outputName: 1 }, false, "outputName"),
];

const hugeDistance = check("distance above engine cap still ok", { ...valid, distance: 100_000_001 }, true);
const aliasRejected = cases[5];
if (aliasRejected?.result.ok !== false) {
  throw new Error("unit alias 应失败");
}

console.log(JSON.stringify({ cases, hugeDistance }, null, 2));
console.log("buffer-operation-validate-check: ok");
