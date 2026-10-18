// SPDX-License-Identifier: Apache-2.0

/**
 * V0.93.3 语言识别隔离：含糊句交给模型，缺距离不填 200 米。
 * 运行：npx --yes tsx --tsconfig tsconfig.json apps/cli/src/v0933-check.ts
 */

import { dispatchJudgment, resolveChatPlan } from "@igis/llm-dispatch";

const known = [
  { layerId: "lyr-road", layerName: "道路" },
  { layerId: "lyr-a", layerName: "area-a" },
];

function check(condition: unknown, label: string): void {
  if (!condition) throw new Error(label);
}

const vague = resolveChatPlan({
  conversationId: "conv-v0933",
  text: "帮我卓一下数据处理和缓冲，在这张图里",
  pending: null,
  selectedLayer: { layerId: "lyr-road", layerName: "道路" },
  knownLayers: known,
});
check(vague.kind === "model", `含糊句应交给模型，实际 ${vague.kind}`);
check(dispatchJudgment("帮我卓一下数据处理和缓冲，在这张图里", vague.kind).includes("不在本地执行"), "判断应说明不在本地执行");
check(dispatchJudgment("帮我卓一下数据处理和缓冲，在这张图里", vague.kind).includes("这张图"), "判断应说明这张图");

const clean = resolveChatPlan({
  conversationId: "conv-v0933",
  text: "对道路做 200 米缓冲",
  pending: null,
  selectedLayer: null,
  knownLayers: known,
});
check(clean.kind === "execute" && clean.calls[0]?.args.distance === 200, "写明 200 米的缓冲仍在本地执行");

const picture = resolveChatPlan({
  conversationId: "conv-v0933",
  text: "对这张图做 200 米缓冲",
  pending: null,
  selectedLayer: { layerId: "lyr-road", layerName: "道路" },
  knownLayers: known,
});
check(picture.kind === "execute" && picture.calls[0]?.args.layerId === "lyr-road" && picture.calls[0]?.args.distance === 200, "干净的「这张图」用选中图层");

const missingDistance = resolveChatPlan({
  conversationId: "conv-v0933",
  text: "对道路做缓冲",
  pending: null,
  selectedLayer: null,
  knownLayers: known,
});
check(missingDistance.kind === "clarify", `没写距离应追问，实际 ${missingDistance.kind}`);
check(missingDistance.kind === "clarify" && missingDistance.pending?.steps[0]?.missing.includes("distance") === true, "缺的是距离");
check(missingDistance.kind !== "execute" || missingDistance.calls[0]?.args.distance !== 200, "不能填 200 米");

console.log("v0933-check passed");
