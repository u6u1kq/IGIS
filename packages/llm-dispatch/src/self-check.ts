// SPDX-License-Identifier: Apache-2.0

import type { LlmProviderId } from "@igis/shared-types";
import { LlmInvokeError } from "./errors.js";
import type { LlmHttp } from "./invoke.js";
import { resolveLlmConnection } from "./invoke.js";
import { runLlmToolCallLoop } from "./loop.js";
import { GIS_SYSTEM_PROMPT, FOLLOWUP_LAYER_REMINDER } from "./gis-prompt.js";
import { planGisInstruction } from "./gis-route.js";
import { resolveChatPlan } from "./pending-plan.js";
import { LLM_PROVIDER_PROFILES, resolveChatCompletionsUrl } from "./providers.js";
import type { ScheduledToolCall } from "./validate.js";

const EXPECTED_ENV: Record<LlmProviderId, string> = {
  deepseek: "DEEPSEEK_API_KEY",
  qwen: "QWEN_API_KEY",
  grok: "GROK_API_KEY",
  local: "LOCAL_LLM_API_KEY",
};

/** 不访问网络。导入本包不会自动执行。 */
export function runLlmDispatchSelfCheck(): void {
  const deepseekUrl = resolveChatCompletionsUrl("https://api.deepseek.com/v1/");
  if (deepseekUrl !== "https://api.deepseek.com/v1/chat/completions") {
    throw new Error("chat/completions 地址拼接错误。");
  }
  const localUrl = resolveChatCompletionsUrl("http://127.0.0.1:11434/v1/chat/completions");
  if (localUrl !== "http://127.0.0.1:11434/v1/chat/completions") {
    throw new Error("已带路径的基址被重复拼接。");
  }
  for (const profile of LLM_PROVIDER_PROFILES) {
    if (profile.apiKeyEnvVar !== EXPECTED_ENV[profile.id]) {
      throw new Error(`环境变量名不一致: ${profile.id}`);
    }
  }
  let missingKey = false;
  try {
    resolveLlmConnection({ providerId: "deepseek", model: "demo", env: {} });
  } catch (error) {
    missingKey = error instanceof LlmInvokeError && error.code === "missing-api-key";
  }
  if (!missingKey) throw new Error("缺少密钥时仍被放行。");
  let missingBase = false;
  try {
    resolveLlmConnection({ providerId: "local", model: "demo", env: {} });
  } catch (error) {
    missingBase = error instanceof LlmInvokeError && error.code === "missing-base-url";
  }
  if (!missingBase) throw new Error("本地模型缺少 baseUrl 时仍被放行。");
  const local = resolveLlmConnection({
    providerId: "local",
    model: "demo",
    baseUrl: "http://127.0.0.1:11434/v1",
    env: {},
  });
  if (local.apiKey !== null || local.llm.builtinModel !== null) {
    throw new Error("本地模型连接解析错误。");
  }
  if (local.llm.apiKeyEnvVar !== "LOCAL_LLM_API_KEY") {
    throw new Error("本地模型环境变量名错误。");
  }
  const qwen = resolveLlmConnection({
    providerId: "qwen",
    model: "demo",
    apiKey: "present",
    env: {},
  });
  if (qwen.baseUrl !== "https://dashscope.aliyuncs.com/compatible-mode/v1") {
    throw new Error("千问占位基址错误。");
  }
  if (qwen.llm.apiKeyEnvVar !== "QWEN_API_KEY" || qwen.llm.providerId !== "qwen") {
    throw new Error("千问配置没有指向提供方。");
  }
  if (JSON.stringify(qwen.llm).includes("present")) {
    throw new Error("公开配置写入了密钥。");
  }
  if (!GIS_SYSTEM_PROMPT.includes("PendingPlan") || !GIS_SYSTEM_PROMPT.includes("selectedLayer")) {
    throw new Error("系统提示缺少 PendingPlan 或 selectedLayer 说明。");
  }
  if (FOLLOWUP_LAYER_REMINDER !== "上一轮只是背景。这一轮若只是在补上一轮缺少的图层名，再完成那个操作；若是新的要求，按新的要求做，不要沿用上一轮的失败说明。") {
    throw new Error("追问提醒原文不对。");
  }
  const knownAreas = [
    { layerId: "lyr-a", layerName: "area-a" },
    { layerId: "lyr-b", layerName: "area-b" },
    { layerId: "lyr-q", layerName: "area-a_空间查询" },
    { layerId: "lyr-c", layerName: "area-a_裁剪" },
  ];
  const follow = planGisInstruction("area-a和area-b", knownAreas, {
    priorInstruction: "对当前图层做 200 米缓冲，再和另一图层相交",
  });
  if (follow.map((step) => step.name).join("|") !== "map.buffer|map.intersect") {
    throw new Error(`追问规划错误：${follow.map((step) => step.name).join("|")}`);
  }
  if (follow[0]?.args.layerId !== "area-a" || follow[0]?.args.distance !== 200 || follow[1]?.args.otherLayerId !== "area-b" || follow[1]?.args.layerId !== "__prev__") {
    throw new Error("追问规划的图层或距离不对。");
  }
  const pendingFirst = resolveChatPlan({
    conversationId: "self-check",
    text: "对当前图层做 200 米缓冲，再和另一图层相交",
    pending: null,
    selectedLayer: null,
    knownLayers: knownAreas,
  });
  if (pendingFirst.kind !== "clarify" || pendingFirst.pending.steps[0]?.apiName !== "run_buffer") {
    throw new Error("PendingPlan 第一轮没有存下缓冲再相交。");
  }
  const pendingSecond = resolveChatPlan({
    conversationId: "self-check",
    text: "area-a和area-b",
    pending: pendingFirst.pending,
    selectedLayer: null,
    knownLayers: knownAreas,
  });
  if (pendingSecond.kind !== "execute" || pendingSecond.calls.map((call) => call.name).join("|") !== "map.buffer|map.intersect") {
    throw new Error("PendingPlan 第二轮没有按计划执行。");
  }
  const incomplete = planGisInstruction("对当前图层做 200 米缓冲，再和另一图层相交", knownAreas);
  if (incomplete.some((step) => step.name === "map.buffer" || step.name === "map.intersect")) {
    throw new Error("未补图层名时不应开始缓冲或相交。");
  }
  const intersectOnly = planGisInstruction("道路和用地相交", [
    { layerId: "r", layerName: "道路" },
    { layerId: "l", layerName: "用地" },
  ]);
  if (intersectOnly.map((step) => step.name).join("|") !== "map.intersect") {
    throw new Error("单独相交规划被改坏了。");
  }
  const current = planGisInstruction("对当前图层做 200 米缓冲", knownAreas, {
    selectedLayer: { layerId: "lyr-a", layerName: "area-a" },
  });
  if (current[0]?.name !== "map.buffer" || current[0]?.args.layerId !== "area-a" || current[0]?.args.distance !== 200) {
    throw new Error("当前图层没有绑定到选中层。");
  }
}

const LOOP_INPUT = { instruction: "打开数据", metadata: [], kgHits: [] };

function toolResponse(name: string, args: unknown): { ok: true; status: 200; text: () => Promise<string> } {
  return {
    ok: true,
    status: 200,
    text: () =>
      Promise.resolve(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  { id: "call-1", type: "function", function: { name, arguments: JSON.stringify(args) } },
                ],
              },
            },
          ],
        }),
      ),
  };
}

/** 同一规范工具名和同一错误码，第二次就停。不同工具不共用计数。不访问真实模型接口。 */
export async function runRepeatFailureSelfCheck(): Promise<void> {
  let aliasRound = 0;
  const aliased = await runLlmToolCallLoop(
    {
      providerId: "deepseek",
      model: "demo",
      apiKey: "present",
      env: {},
      timeoutMs: 1000,
      fetchImpl: () => {
        aliasRound += 1;
        if (aliasRound === 1) return Promise.resolve(toolResponse("run_buffer", { layer: "rivers", distance: 10, unit: "meters", outputName: "out-a" }));
        return Promise.resolve(toolResponse("map.buffer", { layerId: "roads", distance: 80, unit: "meters", outputName: "out-b" }));
      },
      adapter: {
        execute() {
          return Promise.resolve({ ok: false, code: "layer-missing", message: "没有这个图层" });
        },
      },
    },
    LOOP_INPUT,
  );
  if (aliased.stopReason !== "repeat-failure" || aliased.traces.length !== 2) {
    throw new Error("同一工具、同一错误码、不同图层名没有在第二次停止。");
  }
  let mixedRound = 0;
  const mixed = await runLlmToolCallLoop(
    {
      providerId: "deepseek",
      model: "demo",
      apiKey: "present",
      env: {},
      timeoutMs: 1000,
      fetchImpl: () => {
        mixedRound += 1;
        if (mixedRound === 1) return Promise.resolve(toolResponse("map.buffer", { layerId: "rivers", distance: 10, unit: "meters" }));
        if (mixedRound === 2) return Promise.resolve(toolResponse("map.intersect", { layerId: "roads", otherLayerId: "lakes" }));
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ choices: [{ message: { content: "完成" } }] })),
        });
      },
      adapter: {
        execute() {
          return Promise.resolve({ ok: false, code: "layer-missing", message: "没有这个图层" });
        },
      },
    },
    LOOP_INPUT,
  );
  if (mixed.stopReason === "repeat-failure" || mixed.finalText !== "完成") {
    throw new Error("不同工具的相同错误码不应互相停止。");
  }
}

/** 用注入的 fetch 走完工具循环。不访问真实模型接口。 */
export async function runLlmToolLoopSelfCheck(): Promise<void> {
  const bodies: string[] = [];
  const adapterCalls: ScheduledToolCall[] = [];
  let round = 0;
  const fetchImpl: LlmHttp = (url, init) => {
    if (!url.endsWith("/chat/completions")) throw new Error("地址不正确。");
    bodies.push(init.body);
    if (init.body.includes("present")) throw new Error("请求体写入了密钥。");
    round += 1;
    if (round === 1) return Promise.resolve(toolResponse("map.buffer", { layerId: "roads", distance: 10, unit: "meters" }));
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ choices: [{ message: { content: "完成" } }] })),
    });
  };
  const result = await runLlmToolCallLoop(
    {
      providerId: "deepseek",
      model: "demo",
      apiKey: "present",
      env: {},
      timeoutMs: 1000,
      fetchImpl,
      adapter: {
        execute(call) {
          adapterCalls.push(call);
          return Promise.resolve({ status: "ok", layerName: "sample" });
        },
      },
    },
    LOOP_INPUT,
  );
  if (result.finalText !== "完成" || result.rounds !== 2 || adapterCalls.length !== 1) {
    throw new Error("工具循环没有把结果送回模型。");
  }
  const firstCall = adapterCalls[0];
  if (firstCall?.tool !== "map.buffer" || firstCall.args.layerId !== "roads" || firstCall.args.distance !== 10) {
    throw new Error("适配器收到的参数不正确。");
  }
  const secondBody = bodies[1];
  if (secondBody === undefined || !secondBody.includes("sample") || !bodies[0]?.includes("run_buffer")) {
    throw new Error("工具定义或工具结果没有发给模型。");
  }
  if (!bodies[0]?.includes("GIS 助手") || !bodies[0]?.includes("mapLayers") || !bodies[0]?.includes("selectedLayer")) {
    throw new Error("系统提示或图层上下文没有发给模型。");
  }
  const fedBack: Array<{ readonly label: string; readonly name: string; readonly args: unknown; readonly code: string }> = [
    { label: "未知工具", name: "map.teleport", args: { layerId: "roads" }, code: "unknown-tool" },
    { label: "参数类型", name: "map.buffer", args: { layerId: "roads", distance: { nested: true }, unit: "meters" }, code: "invalid-tool-arguments" },
    { label: "几何参数", name: "map.buffer", args: { layerId: "roads", distance: 10, unit: "meters", wkt: "POINT(0 0)" }, code: "geometry-rejected" },
  ];
  for (const item of fedBack) {
    let adapterHit = false;
    let roundCount = 0;
    const outcome = await runLlmToolCallLoop(
      {
        providerId: "local",
        model: "demo",
        baseUrl: "http://127.0.0.1:9/v1",
        env: {},
        timeoutMs: 1000,
        fetchImpl: () => {
          roundCount += 1;
          if (roundCount === 1) return Promise.resolve(toolResponse(item.name, item.args));
          return Promise.resolve({
            ok: true,
            status: 200,
            text: () => Promise.resolve(JSON.stringify({ choices: [{ message: { content: "完成" } }] })),
          });
        },
        adapter: {
          execute() {
            adapterHit = true;
            throw new Error(`${item.label} 仍被分发。`);
          },
        },
      },
      LOOP_INPUT,
    );
    if (adapterHit || outcome.traces[0]?.ok !== false || outcome.traces[0]?.code !== item.code || outcome.finalText !== "完成") {
      throw new Error(`${item.label} 没有作为结构化错误送回模型。`);
    }
  }
  const rejected: Array<{ readonly label: string; readonly run: () => Promise<void>; readonly code: string }> = [
    {
      label: "网络",
      code: "network-error",
      run: () =>
        runLlmToolCallLoop(
          {
            providerId: "deepseek",
            model: "demo",
            apiKey: "present",
            env: {},
            timeoutMs: 1000,
            fetchImpl: () => Promise.reject(new Error("ECONNRESET")),
            adapter: {
              execute() {
                throw new Error("网络失败仍分发了工具。");
              },
            },
          },
          LOOP_INPUT,
        ).then(() => undefined),
    },
  ];
  for (const item of rejected) {
    let matched = false;
    try {
      await item.run();
    } catch (error) {
      matched = error instanceof LlmInvokeError && error.code === item.code;
    }
    if (!matched) throw new Error(`${item.label} 没有按预期拒绝。`);
  }
  const started = Date.now();
  let timedOut = false;
  try {
    await runLlmToolCallLoop(
      {
        providerId: "deepseek",
        model: "demo",
        apiKey: "present",
        env: {},
        timeoutMs: 40,
        fetchImpl: () => new Promise<never>(() => undefined),
        adapter: {
          execute() {
            throw new Error("超时后仍分发了工具。");
          },
        },
      },
      LOOP_INPUT,
    );
  } catch (error) {
    timedOut = error instanceof LlmInvokeError && error.code === "timeout";
  }
  if (!timedOut || Date.now() - started > 1000) throw new Error("超时没有在限定时间内返回。");
  let capped = false;
  try {
    await runLlmToolCallLoop(
      {
        providerId: "deepseek",
        model: "demo",
        apiKey: "present",
        env: {},
        timeoutMs: 1000,
        maxRounds: 1,
        fetchImpl: () => Promise.resolve(toolResponse("io.read", { absolutePath: "E:/demo.tif" })),
        adapter: {
          execute() {
            throw new Error("达到轮数上限后仍分发了工具。");
          },
        },
      },
      LOOP_INPUT,
    );
  } catch (error) {
    capped = error instanceof LlmInvokeError && error.code === "max-rounds";
  }
  if (!capped) throw new Error("轮数上限没有生效。");
  let textRound = 0;
  const textResult = await runLlmToolCallLoop(
    {
      providerId: "deepseek",
      model: "demo",
      apiKey: "present",
      env: {},
      timeoutMs: 1000,
      fetchImpl: () => {
        textRound += 1;
        if (textRound === 1) {
          return Promise.resolve({
            ok: true,
            status: 200,
            text: () =>
              Promise.resolve(
                JSON.stringify({
                  choices: [{ message: { content: "```json\n{\"name\":\"map.buffer\",\"arguments\":{\"layerId\":\"roads\",\"distance\":10,\"unit\":\"meters\"}}\n```" } }],
                }),
              ),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ choices: [{ message: { content: "完成" } }] })),
        });
      },
      adapter: {
        execute(call) {
          if (call.tool !== "map.buffer" || call.args.layerId !== "roads" || call.args.distance !== 10) {
            throw new Error("正文里的工具调用没有被解析。");
          }
          return Promise.resolve({ status: "ok", layerName: "from-text" });
        },
      },
    },
    LOOP_INPUT,
  );
  if (textResult.finalText !== "完成" || textResult.calls.length !== 1) {
    throw new Error("提供方把工具写在正文时没有进入循环。");
  }
  let failRound = 0;
  const repeated = await runLlmToolCallLoop(
    {
      providerId: "deepseek",
      model: "demo",
      apiKey: "present",
      env: {},
      timeoutMs: 1000,
      fetchImpl: () => {
        failRound += 1;
        return Promise.resolve(toolResponse("io.read", { absolutePath: "E:/demo.tif" }));
      },
      adapter: {
        execute() {
          return Promise.resolve({ ok: false, code: "adapter-error", message: "重复失败" });
        },
      },
    },
    LOOP_INPUT,
  );
  if (repeated.stopReason !== "repeat-failure" || repeated.traces.length < 2) {
    throw new Error("相同失败没有停止重试。");
  }
  await runRepeatFailureSelfCheck();
}

const selfCheckEntry = (globalThis as { process?: { argv?: readonly string[] } }).process?.argv?.[1] ?? "";
if (selfCheckEntry.split("\\").join("/").endsWith("packages/llm-dispatch/src/self-check.ts")) {
  void runLlmToolLoopSelfCheck().then(() => {
    console.log("llm loop self-check passed");
  }).catch((error: unknown) => {
    console.log(error instanceof Error ? error.message : "self-check failed");
    const proc = (globalThis as { process?: { exitCode?: number } }).process;
    if (proc) proc.exitCode = 1;
  });
}
