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
 * 识别先过模型。本地词表不再抢在模型前面决定这句话是什么。
 * 只有已经确认的执行计划在本地优先：删除确认、以及模型选定之后的工具，都由本机执行。
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
  readonly allowUserText?: boolean;
  readonly recentResults?: string;
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

/** 删掉「删除……」之后还剩要求，确认删除后要继续，不能停在删除。 */
function hasWorkAfterDelete(text: string): boolean {
  const rest = text
    .replace(/首先|先把|然后|接着|再|之后|一下|并且|并/g, " ")
    .replace(/(?:删除|删掉|移除)[^，。；,.]*/g, " ")
    .replace(/[，。；,.\s]/g, "");
  return rest !== "";
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
    ...(input.allowUserText === true ? { allowUserText: true } : {}),
    ...(typeof input.recentResults === "string" && input.recentResults.trim() !== "" ? { recentResults: input.recentResults } : {}),
    ...(input.selectedLayer ? { selectedLayer: { layerId: input.selectedLayer.layerId, layerName: input.selectedLayer.layerName, geometryKind: "polygon", featureCount: 0, fieldNames: [], crsLabel: "", visible: true, order: 0 } } : {}),
    ...(input.userMemory ? { userMemory: input.userMemory } : {}),
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    ...(input.locale === "en" ? { locale: "en" as const } : {}),
    ...(typeof input.priorInstruction === "string" && input.priorInstruction.trim() !== "" && (input.allowUserText === true || !looksLikeGeometryText(input.priorInstruction))
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
 * 识别先交给模型。只有用户确认过的执行计划在本地优先。
 */
export async function runLocalFirstTurn(input: LocalFirstInput): Promise<LocalFirstResult> {
  if (input.confirm === true && input.pending?.requiresConfirm) {
    const decision = resolveChatPlan(input);
    if (decision.kind === "execute") {
      const turn = await executePlannedCalls(decision.calls, input.adapter, input.tools, input.onProgress);
      const pending = turn.stopReason === "step-failed"
        ? continuablePlanAfterFailure(decision.sourcePlan, turn.traces)
        : null;
      const source = decision.sourcePlan.sourceText.trim();
      if (!pending && decision.sourcePlan.requiresConfirm === true && hasWorkAfterDelete(source)) {
        const removed = turn.traces
          .filter((trace) => trace.ok && trace.layerName)
          .map((trace) => trace.layerName)
          .join("、");
        const followed = await callConfiguredModel({
          ...input,
          text: source,
          priorInstruction: `已删除：${removed || "请求中的图层"}。不要再删除。继续这句话里删除之后的要求。`,
        }, {
          kind: "model",
          pending: null,
          originalText: source,
          partial: { intentFragments: [], layerCandidates: [], numbers: [] },
          pendingSummary: null,
          parseTrace: decision.parseTrace,
        });
        const reply = `${turn.finalText ?? "已删除。"}\n${followed.reply}`;
        return {
          ...followed,
          reply,
          turn: {
            ...followed.turn,
            calls: [...turn.calls, ...followed.turn.calls],
            traces: [...turn.traces, ...followed.turn.traces],
            finalText: reply,
          },
        };
      }
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
  }
  return callConfiguredModel(input, {
    kind: "model",
    pending: null,
    originalText: input.text,
    partial: { intentFragments: [], layerCandidates: [], numbers: [] },
    pendingSummary: null,
    parseTrace: "识别交给模型",
  });
}
