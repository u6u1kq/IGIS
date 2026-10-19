// SPDX-License-Identifier: Apache-2.0

import type { ScalarArg } from "@igis/shared-types";
import { LlmInvokeError } from "./errors.js";
import { buildGisSystemPrompt } from "./gis-prompt.js";
import { concealUserApi, rejectStorageRead } from "@igis/ai-boundary";
import { BoundaryError, isModelVisibleTool } from "@igis/ai-translation";
import { postLlmJson } from "./http.js";
import type { DispatchInput } from "./input.js";
import type { LlmCallerOptions } from "./invoke.js";
import { resolveLlmConnection, visibleDispatchContext } from "./invoke.js";
import { canonicalToolName, toApiToolName } from "./aliases.js";
import { normalizeToolArguments } from "./normalize-args.js";
import { parseTextToolCalls } from "./parse-text-tools.js";
import { resolveChatCompletionsUrl } from "./providers.js";
import { GIS_TOOL_REGISTRY, toOpenAiTools } from "./registry.js";
import type { GisToolDefinition } from "./registry.js";
import type { ScheduledToolCall, ToolAdapterPort } from "./validate.js";
import { progressToolEvent, sanitizeProgressText } from "./chat-progress.js";
import type { ChatProgressHandler } from "./chat-progress.js";

export interface ToolLoopOptions extends LlmCallerOptions {
  readonly adapter: ToolAdapterPort;
  readonly maxRounds?: number;
  readonly tools?: readonly GisToolDefinition[];
  /** 用户记忆摘要。 */
  readonly userMemory?: string;
  /** 用户界面语言。英语时系统提示和工具说明用英语。 */
  readonly locale?: "zh-CN" | "en";
  /** 每完成一步就回调。不要在这里缓冲整轮。 */
  readonly onProgress?: ChatProgressHandler;
}

export type ToolLoopStopReason = "completed" | "step-failed" | "repeat-failure" | "max-rounds";

/** 单步结果。和整轮 turnStatus 分开，成功步不会因为后面的失败被改成失败。 */
export type StepStatus = "succeeded" | "failed" | "not-run";

/** 整轮结果。partial 表示已经有成功步，后面还有失败或未执行的步。 */
export type TurnStatus = "succeeded" | "partial" | "failed" | "max-rounds";

export interface ToolTrace {
  readonly tool: string;
  readonly args: Readonly<Record<string, ScalarArg>>;
  readonly ok: boolean;
  readonly stepStatus: StepStatus;
  readonly message: string;
  readonly layerId?: string;
  readonly layerName?: string;
  readonly code?: string;
  readonly action?: string;
  readonly durationMs?: number;
  readonly ragEntryId?: string;
  readonly auditRecordId?: string;
  /** remember 里 audit.append 失败时为 true。没有这个字段不表示审计已写出。 */
  readonly auditAppendFailed?: true;
  /** 缓冲、相交、裁剪、查询、统计的操作身份。不是 auditRecordId。 */
  readonly operationId?: string;
  readonly cached?: boolean;
}

export interface ToolLoopResult {
  readonly rounds: number;
  readonly calls: readonly ScheduledToolCall[];
  readonly traces: readonly ToolTrace[];
  readonly finalText: string | null;
  readonly stopReason: ToolLoopStopReason;
  readonly turnStatus: TurnStatus;
  /** 用户允许出站时，这一轮交给模型的工具结果。下一轮原样附上。密钥已去掉。 */
  readonly modelCarry?: string;
}

interface ParsedToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
}

function rewriteToolNames(message: unknown): unknown {
  if (message === null || typeof message !== "object") return message;
  const record = message as Record<string, unknown>;
  const toolCalls = record.tool_calls;
  if (!Array.isArray(toolCalls)) return message;
  return {
    ...record,
    tool_calls: toolCalls.map((call) => {
      if (call === null || typeof call !== "object") return call;
      const item = call as Record<string, unknown>;
      const fn = item.function;
      if (fn === null || typeof fn !== "object") return call;
      const fnRecord = fn as Record<string, unknown>;
      if (typeof fnRecord.name !== "string") return call;
      return { ...item, function: { ...fnRecord, name: toApiToolName(fnRecord.name) } };
    }),
  };
}

function parseArguments(raw: unknown): unknown {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new LlmInvokeError("invalid-tool-call", "工具参数不是合法 JSON。");
    }
  }
  if (raw !== null && typeof raw === "object") return raw;
  throw new LlmInvokeError("invalid-tool-call", "工具参数缺失。");
}

function readReasoning(messageRecord: Record<string, unknown>, choice: Record<string, unknown>): string {
  const bags = [messageRecord, choice];
  const keys = ["reasoning", "reasoning_content", "reasoningContent"] as const;
  for (const bag of bags) {
    for (const key of keys) {
      const value = bag[key];
      if (typeof value === "string") {
        const text = sanitizeProgressText(value);
        if (text !== "") return text;
      }
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        const content = (value as Record<string, unknown>).content;
        if (typeof content === "string") {
          const text = sanitizeProgressText(content);
          if (text !== "") return text;
        }
      }
    }
  }
  return "";
}

function readMessage(payload: unknown): {
  readonly calls: readonly ParsedToolCall[];
  readonly text: string | null;
  readonly assistant: unknown;
  readonly reasoning: string;
} {
  if (payload === null || typeof payload !== "object") {
    throw new LlmInvokeError("invalid-tool-call", "模型响应不是对象。");
  }
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new LlmInvokeError("invalid-tool-call", "模型响应缺少 choices。");
  }
  const choice: unknown = choices[0];
  if (choice === null || typeof choice !== "object") {
    throw new LlmInvokeError("invalid-tool-call", "模型响应的 choice 无效。");
  }
  const message = (choice as Record<string, unknown>).message;
  if (message === null || typeof message !== "object") {
    throw new LlmInvokeError("invalid-tool-call", "模型响应缺少 message。");
  }
  const messageRecord = message as Record<string, unknown>;
  const reasoning = readReasoning(messageRecord, choice as Record<string, unknown>);
  const text = typeof messageRecord.content === "string" ? messageRecord.content : null;
  const toolCalls = messageRecord.tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    const calls: ParsedToolCall[] = [];
    for (let index = 0; index < toolCalls.length; index += 1) {
      const call: unknown = toolCalls[index];
      if (call === null || typeof call !== "object") {
        throw new LlmInvokeError("invalid-tool-call", "工具调用无效。");
      }
      const record = call as Record<string, unknown>;
      const fn = record.function;
      const target = fn !== null && typeof fn === "object" ? (fn as Record<string, unknown>) : record;
      if (typeof target.name !== "string" || target.name.trim() === "") {
        throw new LlmInvokeError("invalid-tool-call", "工具名为空。");
      }
      const id = typeof record.id === "string" && record.id.trim() !== "" ? record.id : `call-${index}`;
      calls.push({ id, name: target.name, args: parseArguments(target.arguments) });
    }
    return { calls, text, assistant: rewriteToolNames(message), reasoning };
  }
  const fromText = text ? parseTextToolCalls(text) : [];
  if (fromText.length > 0) {
    const calls = fromText.map((item) => ({ id: item.id, name: item.name, args: item.args }));
    return {
      calls,
      text: null,
      assistant: {
        role: "assistant",
        content: null,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: toApiToolName(call.name), arguments: JSON.stringify(call.args ?? {}) },
        })),
      },
      reasoning,
    };
  }
  return { calls: [], text, assistant: message, reasoning };
}

function buildBody(
  model: string,
  messages: readonly unknown[],
  tools: readonly GisToolDefinition[],
  locale?: "zh-CN" | "en",
): string {
  return JSON.stringify(concealUserApi({
    model,
    messages,
    tools: toOpenAiTools(tools, locale),
    tool_choice: "auto",
  }));
}

function isArgsRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function blockedToolName(name: string): { readonly code: string; readonly message: string } | null {
  return rejectStorageRead(name);
}

function withoutModelConfirm(args: unknown): unknown {
  if (!isArgsRecord(args) || !Object.prototype.hasOwnProperty.call(args, "confirm")) return args;
  const next = { ...args };
  delete next.confirm;
  return next;
}

/**
 * 模型输出先过翻译边界，再交给登记表。登记表不是数据边界。
 * 读文件、外壳、GDAL、任意脚本、未登记工具和本机 HTTP 都不会进入 GIS 运行时。
 */
function reviewModelCall(
  name: string,
  args: unknown,
): { readonly ok: true; readonly name: string; readonly args: unknown } | { readonly ok: false; readonly code: string; readonly message: string } {
  const blocked = blockedToolName(name);
  if (blocked) return { ok: false, code: blocked.code, message: blocked.message };
  if (!isModelVisibleTool(name)) {
    return { ok: false, code: "storage-read-rejected", message: "不能跳过用户直接读取系统内的存储文件。" };
  }
  return { ok: true, name, args: withoutModelConfirm(args) };
}

const CLOUD_PROVENANCE = {
  source: "cloud-ai" as const,
  aiOrigin: true,
  translationUsed: true,
  requestSource: "cloud-ai" as const,
  dataBoundaryLevel: "L2" as const,
};

function asResultRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return { ...(value as Record<string, unknown>) };
  return { ok: false, code: "adapter-error", message: "适配器必须返回对象。" };
}

function errorPayload(code: string, message: string, extra: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { ok: false, code, message, ...extra };
}

/** 抛出的错误若自带审计字段，原样放进工具结果。不在这里生成 id。 */
function auditFieldsOf(error: unknown): Record<string, unknown> {
  if (typeof error !== "object" || error === null) return {};
  const record = error as { readonly auditRecordId?: unknown; readonly auditAppendFailed?: unknown };
  const fields: Record<string, unknown> = {};
  if (typeof record.auditRecordId === "string") fields.auditRecordId = record.auditRecordId;
  else if (record.auditAppendFailed === true) fields.auditAppendFailed = true;
  return fields;
}

/** 同一规范工具名加同一错误码即重复。图层、栅格名、输出名和参数别名不进入这个键。 */
function fingerprint(tool: string, code: string): string {
  const errorCode = code.trim() === "" ? "missing-code" : code.trim();
  return `${canonicalToolName(tool)}::${errorCode}`;
}

export function toolTraceFromResult(tool: string, args: Readonly<Record<string, ScalarArg>>, result: Readonly<Record<string, unknown>>): ToolTrace {
  const ok = result.ok !== false;
  const message = typeof result.message === "string" && result.message.trim() !== ""
    ? result.message
    : ok
      ? "已完成。"
      : "工具没有完成。";
  return {
    tool,
    args,
    ok,
    stepStatus: ok ? "succeeded" : "failed",
    message,
    ...(typeof result.layerId === "string" ? { layerId: result.layerId } : {}),
    ...(typeof result.layerName === "string" ? { layerName: result.layerName } : {}),
    ...(typeof result.code === "string" ? { code: result.code } : {}),
    ...(typeof result.action === "string" ? { action: result.action } : {}),
    ...(typeof result.durationMs === "number" ? { durationMs: result.durationMs } : {}),
    ...(typeof result.ragEntryId === "string" ? { ragEntryId: result.ragEntryId } : {}),
    ...(typeof result.auditRecordId === "string" ? { auditRecordId: result.auditRecordId } : {}),
    ...(result.auditAppendFailed === true ? { auditAppendFailed: true } : {}),
    ...(typeof result.operationId === "string" ? { operationId: result.operationId } : {}),
    ...(result.cached === true ? { cached: true } : {}),
  };
}

function turnStatusFor(stopReason: ToolLoopStopReason, traces: readonly ToolTrace[]): TurnStatus {
  if (stopReason === "max-rounds") return "max-rounds";
  const executed = traces.filter((item) => item.stepStatus !== "not-run");
  const anyOk = executed.some((item) => item.ok);
  const anyBad = executed.some((item) => !item.ok) || traces.some((item) => item.stepStatus === "not-run");
  if (anyOk && anyBad) return "partial";
  if (anyBad) return "failed";
  return "succeeded";
}

export function completeToolLoop(
  rounds: number,
  calls: readonly ScheduledToolCall[],
  traces: readonly ToolTrace[],
  finalText: string | null,
  stopReason: ToolLoopStopReason,
): ToolLoopResult {
  return { rounds, calls, traces, finalText, stopReason, turnStatus: turnStatusFor(stopReason, traces) };
}

function succeededLayerText(traces: readonly ToolTrace[]): string {
  const parts: string[] = [];
  for (const item of traces) {
    if (item.stepStatus !== "succeeded") continue;
    const tool = item.tool;
    if (typeof item.layerId === "string" && item.layerId !== "") {
      const name = typeof item.layerName === "string" && item.layerName !== "" ? `${item.layerName}（${item.layerId}）` : item.layerId;
      parts.push(`${tool} 生成图层 ${name}`);
      continue;
    }
    parts.push(tool);
  }
  return parts.join("、");
}

/** 已经有成功工具时不丢掉它们。还没有成功工具时仍抛出，让原有的轮数上限检查保持不变。 */
function maxRoundsResult(
  rounds: number,
  calls: readonly ScheduledToolCall[],
  traces: readonly ToolTrace[],
): ToolLoopResult | null {
  if (!traces.some((item) => item.stepStatus === "succeeded")) return null;
  const ran = succeededLayerText(traces);
  const finalText = ran === ""
    ? "模型仍在请求工具，已达到轮数上限。"
    : `模型仍在请求工具，已达到轮数上限。已完成：${ran}。`;
  return completeToolLoop(rounds, calls, traces, finalText, "max-rounds");
}

/** 只有这一句本身在要求投影或米制运算时，才自动追问 EPSG。检查错位、换了话题，不沿用上一轮。 */
function turnContinuesCrsOperation(text: string): boolean {
  return /重投影|坐标系|投影到|转换坐标|缓冲|裁剪|相交|\breproject\b|\bproject\b/i.test(text);
}

function epsgTargetFromText(text: string): string | null {
  const match = text.match(/EPSG\s*[:：]\s*(\d{3,6})/i);
  if (!match?.[1]) return null;
  return `EPSG:${match[1]}`;
}

async function recoverByReproject(
  options: ToolLoopOptions,
  scheduled: ScheduledToolCall | null,
  layerId: string,
  target: string,
): Promise<{ readonly trace: ToolTrace; readonly nextLayerId: string }> {
  const call: ScheduledToolCall = {
    tool: "map.reproject",
    args: { layerId, targetCrs: target, outputName: "reprojected" },
    provenance: scheduled?.provenance ?? CLOUD_PROVENANCE,
  };
  let raw: unknown;
  try {
    raw = await options.adapter.execute(call);
  } catch (error) {
    const message = error instanceof Error ? error.message : "重投影失败。";
    raw = { ok: false, code: "adapter-error", message };
  }
  const record = asResultRecord(raw);
  const trace = toolTraceFromResult("map.reproject", call.args, record);
  const nextLayerId = typeof record.layerId === "string" ? record.layerId : "";
  return { trace, nextLayerId };
}

async function retryOnLayer(options: ToolLoopOptions, scheduled: ScheduledToolCall | null, layerId: string): Promise<ToolTrace> {
  if (!scheduled) {
    return toolTraceFromResult("map.buffer", { layerId }, { ok: false, code: "adapter-error", message: "没有可以重试的运算。" });
  }
  const call: ScheduledToolCall = { ...scheduled, args: { ...scheduled.args, layerId } };
  let raw: unknown;
  try {
    raw = await options.adapter.execute(call);
  } catch (error) {
    const message = error instanceof Error ? error.message : "运算失败。";
    raw = { ok: false, code: "adapter-error", message };
  }
  return toolTraceFromResult(call.tool, call.args, asResultRecord(raw));
}

/**
 * 把工具定义发给模型，整理参数，交给注入的适配器，再把标量结果送回模型。
 * 参数错误和适配器失败会写成结构化结果让模型改；同一失败重复两次则停止。
 * 不做缓冲、相交或其他 GIS 运算。
 */
export async function runLlmToolCallLoop(options: ToolLoopOptions, input: DispatchInput): Promise<ToolLoopResult> {
  const resolved = resolveLlmConnection(options);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxRounds = options.maxRounds ?? 8;
  if (!Number.isInteger(maxRounds) || maxRounds < 1) {
    throw new LlmInvokeError("max-rounds", "maxRounds 必须是正整数。");
  }
  const tools = (options.tools ?? GIS_TOOL_REGISTRY).filter((tool) => isModelVisibleTool(tool.name));
  const visible = concealUserApi(visibleDispatchContext(input));
  const systemContent = buildGisSystemPrompt(options.userMemory, options.locale);
  const messages: unknown[] = [
    { role: "system", content: systemContent },
    { role: "user", content: JSON.stringify(visible) },
  ];
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (resolved.apiKey) headers.Authorization = `Bearer ${resolved.apiKey}`;
  const executed: ScheduledToolCall[] = [];
  const traces: ToolTrace[] = [];
  const failures = new Map<string, number>();
  const succeeded = new Set<string>();
  let confirmText = "";
  let crsRecovered = false;
  const carryParts: string[] = [];
  const finish = (result: ToolLoopResult): ToolLoopResult => {
    const text = carryParts.join("\n").slice(0, 12_000);
    return text === "" ? result : { ...result, modelCarry: text };
  };
  for (let round = 1; round <= maxRounds; round += 1) {
    const payload = await postLlmJson(
      options.fetchImpl,
      resolveChatCompletionsUrl(resolved.baseUrl),
      headers,
      buildBody(resolved.model, messages, tools, options.locale),
      timeoutMs,
    );
    const parsed = readMessage(payload);
    if (parsed.reasoning !== "") {
      options.onProgress?.({ type: "thought", kind: "reasoning", text: parsed.reasoning });
    }
    if (parsed.calls.length === 0) {
      return finish(completeToolLoop(round, executed, traces, parsed.text, "completed"));
    }
    if (parsed.reasoning === "") {
      options.onProgress?.({ type: "thought", kind: "status", code: "running_tools" });
    }
    if (round === maxRounds) {
      const kept = maxRoundsResult(round, executed, traces);
      if (kept) return finish(kept);
      throw new LlmInvokeError("max-rounds", "模型仍在请求工具，已达到轮数上限。");
    }
    messages.push(parsed.assistant);
    for (let index = 0; index < parsed.calls.length; index += 1) {
      const parsedCall = parsed.calls[index];
      if (!parsedCall) {
        throw new LlmInvokeError("invalid-tool-call", "工具调用数量不一致。");
      }
      let scheduled: ScheduledToolCall | null = null;
      let localResult: Record<string, unknown>;
      try {
        const review = reviewModelCall(parsedCall.name, parsedCall.args);
        if (!review.ok) {
          localResult = { ok: false, code: review.code, message: review.message };
        } else {
          const normalized = normalizeToolArguments(review.name, review.args, tools);
          const cleanedArgs = { ...normalized.args };
          delete cleanedArgs.confirm;
          scheduled = { tool: normalized.tool, args: cleanedArgs, provenance: CLOUD_PROVENANCE };
          const signature = `${scheduled.tool}::${JSON.stringify(scheduled.args)}`;
          if (succeeded.has(signature)) {
            messages.push({
              role: "tool",
              tool_call_id: parsedCall.id,
              content: JSON.stringify({
                ok: true,
                code: "already-done",
                message: "相同参数的这一步已经完成。不要再调用它。按用户这一句决定另一个工具，或直接回答。",
              }),
            });
            continue;
          }
          let rawResult: unknown;
          try {
            rawResult = await options.adapter.execute(scheduled);
          } catch (error) {
            if (error instanceof BoundaryError || (error instanceof LlmInvokeError && error.code === "geometry-rejected")) {
              throw new LlmInvokeError("geometry-rejected", "模型载荷越过了数据边界。");
            }
            if (error instanceof LlmInvokeError && (error.code === "timeout" || error.code === "network-error" || error.code === "http-error" || error.code === "missing-api-key")) {
              throw error;
            }
            const message = error instanceof Error ? error.message : "适配器执行失败。";
            rawResult = errorPayload("adapter-error", message, auditFieldsOf(error));
          }
          localResult = asResultRecord(rawResult);
          executed.push(scheduled);
        }
      } catch (error) {
        if (error instanceof LlmInvokeError && error.code === "geometry-rejected") throw error;
        if (error instanceof LlmInvokeError && (error.code === "timeout" || error.code === "network-error" || error.code === "http-error" || error.code === "missing-api-key" || error.code === "max-rounds")) {
          throw error;
        }
        const code = error instanceof LlmInvokeError ? error.code : "invalid-tool-arguments";
        const message = error instanceof Error ? error.message : "工具参数无效。";
        localResult = errorPayload(code, message);
      }
      const args = scheduled?.args ?? {};
      const toolName = scheduled?.tool ?? parsedCall.name;
      const trace = toolTraceFromResult(toolName, args, localResult);
      traces.push(trace);
      options.onProgress?.(progressToolEvent(trace));
      if (trace.ok) succeeded.add(`${toolName}::${JSON.stringify(args)}`);
      let modelResult: unknown = concealUserApi(localResult);
      const modelRecord = modelResult !== null && typeof modelResult === "object" && !Array.isArray(modelResult)
        ? modelResult
        : { ok: false, code: "adapter-error", message: "结果不能交给模型。" };
      const toolContent = JSON.stringify(modelRecord);
      if (carryParts.join("").length < 12_000) carryParts.push(toolContent.slice(0, 4_000));
      messages.push({
        role: "tool",
        tool_call_id: parsedCall.id,
        content: toolContent,
      });
      if (trace.code === "crs-refused" && !crsRecovered && turnContinuesCrsOperation(input.instruction)) {
        const target = epsgTargetFromText(input.instruction);
        const sourceLayer = typeof scheduled?.args.layerId === "string" ? scheduled.args.layerId : "";
        if (sourceLayer === "") {
          return finish(completeToolLoop(
            round,
            executed,
            traces,
            `${trace.message} 这次要改的不是图层。重投影只接受图层，已停止。`,
            "step-failed",
          ));
        }
        if (target === null) {
          return finish(completeToolLoop(
            round,
            executed,
            traces,
            `${trace.message} 请给出目标 EPSG 代码。给出之后才会对新图层继续这次运算。`,
            "completed",
          ));
        }
        crsRecovered = true;
        const repro = await recoverByReproject(options, scheduled, sourceLayer, target);
        traces.push(repro.trace);
        options.onProgress?.(progressToolEvent(repro.trace));
        if (!repro.trace.ok || repro.nextLayerId === "") {
          return finish(completeToolLoop(round, executed, traces, `${repro.trace.message} 重投影没有通过，已停止。`, "step-failed"));
        }
        const retried = await retryOnLayer(options, scheduled, repro.nextLayerId);
        traces.push(retried);
        options.onProgress?.(progressToolEvent(retried));
        const spoken = retried.ok
          ? `已按 ${target} 重投影后再运算。${retried.message}`
          : `${retried.message} 重投影后的运算没有通过，已停止，不再重投影。`;
        return finish(completeToolLoop(round, executed, traces, spoken, retried.ok ? "completed" : "step-failed"));
      }
      if (trace.code === "confirm-required") {
        confirmText = trace.message;
        continue;
      }
      if (confirmText !== "") continue;
      if (trace.ok) continue;
      const key = fingerprint(toolName, trace.code ?? "");
      const count = (failures.get(key) ?? 0) + 1;
      failures.set(key, count);
      if (count >= 2) {
        return finish(completeToolLoop(
          round,
          executed,
          traces,
          `同一工具、同一错误已出现两次，已停止。参数没有改。${trace.message}`,
          "repeat-failure",
        ));
      }
    }
    if (confirmText !== "") {
      return finish(completeToolLoop(round, executed, traces, confirmText, "completed"));
    }
  }
  const kept = maxRoundsResult(maxRounds, executed, traces);
  if (kept) return finish(kept);
  throw new LlmInvokeError("max-rounds", "模型仍在请求工具，已达到轮数上限。");
}
