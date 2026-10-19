// SPDX-License-Identifier: Apache-2.0

import type { ExternalLlmConfig, LlmProviderId, LlmToolRequest, ScalarArg, ScalarArgs, ToolName } from "@igis/shared-types";
import type { DispatchInput, LlmDispatch } from "./input.js";
import { LlmInvokeError } from "./errors.js";
import { projectForModel } from "@igis/ai-translation";
import { assertLlmPayload } from "./guard.js";
import { postLlmJson } from "./http.js";
import { followupReminder } from "./gis-prompt.js";
import { formatSelectedLayer } from "./layer-context.js";
import { getLlmProviderProfile, resolveChatCompletionsUrl } from "./providers.js";

const TOOL_FUNCTION_NAME = "submit_igis_tool_request";

export interface LlmHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export interface LlmHttpInit {
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal?: AbortSignal;
}

export interface LlmHttp {
  (url: string, init: LlmHttpInit): Promise<LlmHttpResponse>;
}

/** 调用参数。密钥可以临时传入，也可以只给环境变量名对应的值。不要把密钥写进配置文件。 */
export interface LlmCallerOptions {
  readonly providerId: LlmProviderId;
  readonly model: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly fetchImpl?: LlmHttp;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** 单次模型请求的等待上限，毫秒。默认 30000。到点即返回，不等待挂起的连接。 */
  readonly timeoutMs?: number;
}

export interface ResolvedLlmConnection {
  readonly providerId: LlmProviderId;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string | null;
  readonly llm: ExternalLlmConfig;
}

function nonEmpty(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readProcessEnv(): Record<string, string | undefined> | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env;
}

function readEnv(name: string, env: Readonly<Record<string, string | undefined>> | undefined): string | null {
  const source = env ?? readProcessEnv();
  return nonEmpty(source?.[name]);
}

/** 解析提供方、基址和密钥。公开的 llm 对象只保留环境变量名。 */
export function resolveLlmConnection(options: LlmCallerOptions): ResolvedLlmConnection {
  const profile = getLlmProviderProfile(options.providerId);
  const model = nonEmpty(options.model);
  if (!model) {
    throw new LlmInvokeError("missing-model", "缺少模型名。本程序不内置权重。");
  }
  const baseUrl = nonEmpty(options.baseUrl) ?? profile.defaultBaseUrl;
  if (!baseUrl) {
    throw new LlmInvokeError(
      "missing-base-url",
      `提供方 ${profile.id} 缺少 baseUrl。本地模型必须由调用方传入 baseUrl。`,
    );
  }
  const apiKey = nonEmpty(options.apiKey) ?? readEnv(profile.apiKeyEnvVar, options.env);
  if (profile.apiKeyRequired && !apiKey) {
    throw new LlmInvokeError("missing-api-key", `缺少环境变量 ${profile.apiKeyEnvVar}。`);
  }
  return {
    providerId: profile.id,
    model,
    baseUrl,
    apiKey,
    llm: {
      mode: "external-api",
      builtinModel: null,
      providerId: profile.id,
      baseUrl,
      model,
      apiKeyEnvVar: profile.apiKeyEnvVar,
    },
  };
}

export function visibleDispatchContext(input: DispatchInput): unknown {
  const prior = typeof input.priorInstruction === "string" ? input.priorInstruction.trim() : "";
  const selectedLayer = formatSelectedLayer(input.mapLayers ?? [], input.selectedLayer?.layerId ?? input.selectedLayer?.layerName);
  const selectedFromInput = input.selectedLayer
    ? formatSelectedLayer([input.selectedLayer], input.selectedLayer.layerId)
    : null;
  const selected = selectedLayer ?? selectedFromInput;
  return {
    instruction: input.instruction,
    metadata: input.metadata.map((document) => ({
      layerName: document.layerName,
      fieldNames: [...document.fieldNames],
      crs: document.crs,
      featureCount: document.featureCount,
      style: document.style
        ? {
            mode: document.style.mode,
            field: document.style.field,
            ramp: document.style.ramp,
          }
        : null,
    })),
    kgHits: input.kgHits.map((hit) => ({
      operation: hit.operation,
      tool: hit.tool,
      issue: hit.issue,
      resolution: hit.resolution,
    })),
    mapLayers: input.mapLayers ?? [],
    selectedLayer: selected,
    ...(prior !== "" ? { priorInstruction: prior, reminder: followupReminder(input.locale) } : {}),
    ...(typeof input.originalText === "string" && input.originalText.trim() !== "" ? { originalText: input.originalText.trim() } : {}),
    ...(input.partialEntities ? { partialEntities: input.partialEntities } : {}),
    ...(typeof input.pendingSummary === "string" && input.pendingSummary.trim() !== "" ? { pendingSummary: input.pendingSummary.trim() } : {}),
    ...(typeof input.recentResults === "string" && input.recentResults.trim() !== "" ? { recentResults: input.recentResults.trim() } : {}),
    notes: input.locale === "en"
      ? (prior !== ""
        ? `The previous instruction is priorInstruction. ${followupReminder("en")} Current layers are mapLayers. Decide the user's goal, then which listed layer it uses, then whether a tool is needed. ${input.allowUserText === true ? "Coordinates and paths are already in this turn, including tool results. Use them next. Do not ask to fetch them again." : "Do not output coordinates."}`
        : `Current layers are mapLayers. Decide the user's goal, then which listed layer it uses, then whether a tool is needed. ${input.allowUserText === true ? "Coordinates and paths are already in this turn, including tool results. Use them next. Do not ask to fetch them again." : "Do not output coordinates."}`)
      : (prior !== ""
        ? `上一轮用户指令见 priorInstruction。${followupReminder("zh-CN")}当前地图图层见 mapLayers。先判断用户要的结果，再判断用到 mapLayers 里的哪一层，最后判断要不要调用工具。${input.allowUserText === true ? "坐标和路径已经在这一轮里，工具结果里的也在。下一步直接用，不要再要求读取。" : "不要输出坐标。"}`
        : `当前地图图层见 mapLayers。先判断用户要的结果，再判断用到 mapLayers 里的哪一层，最后判断要不要调用工具。${input.allowUserText === true ? "坐标和路径已经在这一轮里，工具结果里的也在。下一步直接用，不要再要求读取。" : "不要输出坐标。"}`),
  };
}

function buildBody(model: string, userContent: string): string {
  return JSON.stringify(projectForModel({
    model,
    messages: [
      {
        role: "system",
        content:
          "你是 Igis 的工具调度器。只能通过函数 submit_igis_tool_request 返回下一次工具调用。参数只有 tool、scalarArgs、memoryHandles。scalarArgs 的值只能是字符串、数字、布尔或 null。memoryHandles 的值只能是不透明句柄。不要输出几何文本、二进制几何或 GeoJSON 几何对象。tool 必须以 io.、vector. 或 raster. 开头。",
      },
      { role: "user", content: userContent },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: TOOL_FUNCTION_NAME,
          description: "提交下一次 Igis 工具调用。只含工具名、标量和不透明句柄。",
          parameters: {
            type: "object",
            additionalProperties: false,
            required: ["tool", "scalarArgs", "memoryHandles"],
            properties: {
              tool: { type: "string" },
              scalarArgs: { type: "object" },
              memoryHandles: { type: "object" },
            },
          },
        },
      },
    ],
    tool_choice: { type: "function", function: { name: TOOL_FUNCTION_NAME } },
  }));
}

function isScalarArg(value: unknown): value is ScalarArg {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function asToolName(tool: string): ToolName {
  if (!/^(io|vector|raster)\..+/.test(tool)) {
    throw new LlmInvokeError("invalid-tool-call", "tool 必须以 io.、vector. 或 raster. 开头。");
  }
  return tool as ToolName;
}

function toToolRequest(raw: unknown): LlmToolRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LlmInvokeError("invalid-tool-call", "工具参数必须是对象。");
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "tool" && key !== "scalarArgs" && key !== "memoryHandles") {
      throw new LlmInvokeError("invalid-tool-call", `工具参数含有不允许的字段: ${key}`);
    }
  }
  if (typeof record.tool !== "string") {
    throw new LlmInvokeError("invalid-tool-call", "tool 必须是字符串。");
  }
  if (record.scalarArgs === null || typeof record.scalarArgs !== "object" || Array.isArray(record.scalarArgs)) {
    throw new LlmInvokeError("invalid-tool-call", "scalarArgs 必须是对象。");
  }
  if (record.memoryHandles === null || typeof record.memoryHandles !== "object" || Array.isArray(record.memoryHandles)) {
    throw new LlmInvokeError("invalid-tool-call", "memoryHandles 必须是对象。");
  }
  const scalarRecord = record.scalarArgs as Record<string, unknown>;
  const scalars: Record<string, ScalarArg> = {};
  for (const key of Object.keys(scalarRecord)) {
    const value = scalarRecord[key];
    if (!isScalarArg(value)) {
      throw new LlmInvokeError("invalid-tool-call", "scalarArgs 只接受标量。");
    }
    scalars[key] = value;
  }
  const handleRecord = record.memoryHandles as Record<string, unknown>;
  const handles: Record<string, string> = {};
  for (const key of Object.keys(handleRecord)) {
    const value = handleRecord[key];
    if (typeof value !== "string" || value.trim() === "") {
      throw new LlmInvokeError("invalid-tool-call", "memoryHandles 的值必须是非空字符串。");
    }
    handles[key] = value;
  }
  return {
    tool: asToolName(record.tool),
    scalarArgs: scalars as ScalarArgs,
    memoryHandles: handles as LlmToolRequest["memoryHandles"],
  };
}

function readFunctionArguments(call: unknown): unknown | undefined {
  if (call === null || typeof call !== "object") return undefined;
  const record = call as Record<string, unknown>;
  const nested = record.function;
  const target = nested !== null && typeof nested === "object" ? (nested as Record<string, unknown>) : record;
  if (target.name !== TOOL_FUNCTION_NAME) return undefined;
  const raw = target.arguments;
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

function readToolArguments(payload: unknown): unknown {
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
  const toolCalls = messageRecord.tool_calls;
  if (Array.isArray(toolCalls)) {
    for (const call of toolCalls) {
      const args = readFunctionArguments(call);
      if (args !== undefined) return args;
    }
  }
  if (messageRecord.function_call !== undefined && messageRecord.function_call !== null) {
    const args = readFunctionArguments(messageRecord.function_call);
    if (args !== undefined) return args;
  }
  throw new LlmInvokeError("invalid-tool-call", "模型没有返回工具调用。");
}

async function executeToolRequest(
  resolved: ResolvedLlmConnection,
  fetchImpl: LlmHttp | undefined,
  input: DispatchInput,
  timeoutMs: number,
): Promise<LlmToolRequest> {
  const visible = projectForModel(visibleDispatchContext(input));
  assertLlmPayload(visible);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (resolved.apiKey) {
    headers.Authorization = `Bearer ${resolved.apiKey}`;
  }
  const parsed = await postLlmJson(
    fetchImpl,
    resolveChatCompletionsUrl(resolved.baseUrl),
    headers,
    buildBody(resolved.model, JSON.stringify(visible)),
    timeoutMs,
  );
  const rawArgs = readToolArguments(parsed);
  assertLlmPayload(rawArgs);
  return toToolRequest(rawArgs);
}

/** 按提供方发起一次 OpenAI 兼容的工具调用。几何载荷在发请求前被拒绝。 */
export function invokeLlmForToolRequest(options: LlmCallerOptions, input: DispatchInput): Promise<LlmToolRequest> {
  const resolved = resolveLlmConnection(options);
  return executeToolRequest(resolved, options.fetchImpl, input, options.timeoutMs ?? 30_000);
}

/**
 * 构造一个 LlmDispatch。
 * 密钥留在闭包里，不放进返回对象，也不写进 llm 配置。
 */
export function createExternalLlmDispatch(options: LlmCallerOptions): LlmDispatch {
  const resolved = resolveLlmConnection(options);
  const fetchImpl = options.fetchImpl;
  const timeoutMs = options.timeoutMs ?? 30_000;
  return {
    providerId: resolved.providerId,
    llm: resolved.llm,
    plan(input: DispatchInput): Promise<LlmToolRequest> {
      return executeToolRequest(resolved, fetchImpl, input, timeoutMs);
    },
  };
}
