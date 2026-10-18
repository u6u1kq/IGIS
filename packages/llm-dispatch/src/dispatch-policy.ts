// SPDX-License-Identifier: Apache-2.0

import { looksLikeGeometryText } from "@igis/shared-types";
import type { MapLayerContext } from "./layer-context.js";
import { toApiToolName } from "./aliases.js";
import { destructiveActionOf, destructiveConfirmMessage } from "./destructive.js";
import type { LlmHttp } from "./invoke.js";
import { completeToolLoop } from "./loop.js";
import type { ToolLoopResult } from "./loop.js";
import { continuablePlanAfterFailure, dispatchJudgment, executePlannedCalls, resolveChatPlan } from "./pending-plan.js";
import type { ChatPlanResolution, PendingPlan, ResolveChatPlanInput } from "./pending-plan.js";
import { runAssistantTurn } from "./rag-chat.js";
import type { GisToolDefinition } from "./registry.js";
import type { ToolAdapterPort } from "./validate.js";
import type { ChatProgressHandler } from "./chat-progress.js";
import type { PartialEntities } from "./local-intent.js";

/**
 * LOCAL_DISPATCH_POLICY
 * 本地解析器只是加速器。只有本地解析完全匹配、并且每个必填槽都已填上时，才在本地执行，不调用模型，不消耗 token。
 * 其余情况必须把用户原文和已抽出的部分实体（意图片段、图层名候选、数字）交给已配置的云端模型。
 * 禁止在本地解析失败、意图含糊、或唯一一次 PendingPlan 追问没有补上槽位时，向用户返回错误、拒绝或停住不调用模型。
 * 云端模型是后备大脑。runLocalFirstTurn 的 switch 把 model 分支写成必经路径，不能在调用方再写一套提前返回。
 */
export const LOCAL_DISPATCH_POLICY = "local-accelerator-cloud-fallback" as const;

const DANGEROUS = new Set(["map.delete", "map.clearAll", "map.dropDatabase", "delete_layer", "clear_all_layers", "delete_database"]);

export interface LocalFirstInput extends ResolveChatPlanInput {
  readonly adapter: ToolAdapterPort;
  readonly fetchImpl?: LlmHttp;
  readonly providerId: "deepseek" | "qwen" | "grok" | "local";
  readonly model: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly tools?: readonly GisToolDefinition[];
  readonly mapLayers?: readonly MapLayerContext[];
  readonly releaseOrdinaryGeometry?: boolean;
  readonly unrestricted?: boolean;
  readonly retrievedTexts?: readonly string[];
  readonly userMemory?: string;
  readonly onProgress?: ChatProgressHandler;
  /** 上一轮澄清或失败追问对应的用户指令。不含几何。 */
  readonly priorInstruction?: string;
  readonly locale?: "zh-CN" | "en";
}

export interface LocalFirstResult {
  readonly policy: typeof LOCAL_DISPATCH_POLICY;
  readonly kind: ChatPlanResolution["kind"];
  readonly usedModel: boolean;
  readonly reply: string;
  readonly pending: PendingPlan | null;
  readonly parseTrace: string;
  readonly judgment: string;
  readonly confirmRequired: boolean;
  readonly turn: ToolLoopResult;
  readonly originalText: string;
  readonly partial: PartialEntities | null;
}

function emptyTurn(text: string): ToolLoopResult {
  return completeToolLoop(0, [], [], text, "completed");
}

function isDangerousTool(name: string): boolean {
  return DANGEROUS.has(name) || DANGEROUS.has(toApiToolName(name));
}

function confirmMessage(tool: string): string {
  return destructiveConfirmMessage(destructiveActionOf(tool) ?? "delete-layer");
}

function guardDangerous(adapter: ToolAdapterPort): ToolAdapterPort {
  return {
    async execute(call) {
      if (isDangerousTool(call.tool)) {
        return { ok: false, code: "confirm-required", message: confirmMessage(call.tool), action: "confirm" };
      }
      return adapter.execute(call);
    },
  };
}

function pendingFromDangerous(conversationId: string, sourceText: string, turn: ToolLoopResult): PendingPlan | null {
  const steps = turn.traces
    .filter((trace) => trace.code === "confirm-required")
    .map((trace) => {
      const args: Record<string, string | number | boolean> = {};
      for (const [key, value] of Object.entries(trace.args)) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") args[key] = value;
      }
      return { tool: trace.tool, apiName: toApiToolName(trace.tool), args, missing: [] as string[] };
    });
  if (steps.length === 0) return null;
  return { conversationId, sourceText, steps, requiresConfirm: true };
}

async function callConfiguredModel(input: LocalFirstInput, decision: Extract<ChatPlanResolution, { kind: "model" | "reply" }>): Promise<LocalFirstResult> {
  const originalText = decision.kind === "model" ? decision.originalText : input.text;
  const partial = decision.kind === "model" ? decision.partial : null;
  const pendingSummary = decision.kind === "model" ? decision.pendingSummary : null;
  const parseTrace = decision.parseTrace;
  const turn = await runAssistantTurn({
    providerId: input.providerId,
    model: input.model,
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(input.apiKey ? { apiKey: input.apiKey } : {}),
    ...(input.env ? { env: input.env } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    timeoutMs: 30_000,
    maxRounds: 8,
    adapter: guardDangerous(input.adapter),
    ...(input.tools ? { tools: input.tools } : {}),
    question: input.text,
    ...(input.retrievedTexts ? { retrievedTexts: input.retrievedTexts } : {}),
    ...(input.mapLayers ? { mapLayers: input.mapLayers } : {}),
    ...(input.releaseOrdinaryGeometry === true ? { releaseOrdinaryGeometry: true } : {}),
    ...(input.unrestricted === true ? { unrestricted: true } : {}),
    ...(input.selectedLayer ? { selectedLayer: { layerId: input.selectedLayer.layerId, layerName: input.selectedLayer.layerName, geometryKind: "polygon", featureCount: 0, fieldNames: [], crsLabel: "", visible: true, order: 0 } } : {}),
    ...(input.userMemory ? { userMemory: input.userMemory } : {}),
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    ...(input.locale === "en" ? { locale: "en" as const } : {}),
    ...(typeof input.priorInstruction === "string" && input.priorInstruction.trim() !== "" && !looksLikeGeometryText(input.priorInstruction)
      ? { priorInstruction: input.priorInstruction.trim() }
      : {}),
    originalText,
    ...(partial ? { partialEntities: partial } : {}),
    ...(pendingSummary ? { pendingSummary } : {}),
  });
  const dangerous = turn.traces.some((trace) => trace.code === "confirm-required");
  const pending = dangerous ? pendingFromDangerous(input.conversationId, input.text, turn) : null;
  const reply = turn.finalText ?? "模型没有返回文字。";
  return {
    policy: LOCAL_DISPATCH_POLICY,
    kind: dangerous ? "confirm" : "model",
    usedModel: true,
    reply: dangerous ? (turn.traces.find((trace) => trace.code === "confirm-required")?.message ?? reply) : reply,
    pending,
    parseTrace,
    judgment: dispatchJudgment(input.text, decision.kind),
    confirmRequired: dangerous,
    turn,
    originalText,
    partial,
  };
}

/**
 * 对话调度的唯一入口。
 * 顺序：已确认的危险计划 → 未完成的 PendingPlan（补上就执行原计划，补不上就交模型）→
 * 本地完整匹配则执行 → 危险操作先确认 → 意图明确但缺槽则只问一句 → 其余一律调用模型。
 */
export async function runLocalFirstTurn(input: LocalFirstInput): Promise<LocalFirstResult> {
  const decision = resolveChatPlan(input);
  switch (decision.kind) {
    case "execute": {
      const turn = await executePlannedCalls(decision.calls, input.adapter, input.tools, input.onProgress);
      const pending = turn.stopReason === "step-failed"
        ? continuablePlanAfterFailure(decision.sourcePlan, turn.traces)
        : null;
      return {
        policy: LOCAL_DISPATCH_POLICY,
        kind: "execute",
        usedModel: false,
        reply: turn.finalText ?? "已在本地完成。",
        pending,
        parseTrace: decision.parseTrace,
        judgment: dispatchJudgment(input.text, decision.kind),
        confirmRequired: false,
        turn,
        originalText: input.text,
        partial: null,
      };
    }
    case "clarify":
      return {
        policy: LOCAL_DISPATCH_POLICY,
        kind: "clarify",
        usedModel: false,
        reply: decision.text,
        pending: decision.pending,
        parseTrace: decision.parseTrace,
        judgment: dispatchJudgment(input.text, decision.kind),
        confirmRequired: false,
        turn: emptyTurn(decision.text),
        originalText: input.text,
        partial: null,
      };
    case "confirm":
      return {
        policy: LOCAL_DISPATCH_POLICY,
        kind: "confirm",
        usedModel: false,
        reply: decision.text,
        pending: decision.pending,
        parseTrace: decision.parseTrace,
        judgment: dispatchJudgment(input.text, decision.kind),
        confirmRequired: true,
        turn: emptyTurn(decision.text),
        originalText: input.text,
        partial: null,
      };
    case "reply":
    case "model":
      // 本地解析失败、含糊、或追问没有补上槽位：必须调用已配置的模型。禁止在此返回错误。
      return callConfiguredModel(input, decision);
    default: {
      const leftover: never = decision;
      return callConfiguredModel(input, leftover);
    }
  }
}
