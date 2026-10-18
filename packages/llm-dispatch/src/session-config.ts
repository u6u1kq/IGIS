// SPDX-License-Identifier: Apache-2.0

import type { LlmProviderId } from "@igis/shared-types";
import { getLlmProviderProfile } from "./providers.js";

/**
 * 放在现有 HTTP 适配器前面的薄配置。
 * 有效配置 = 用户已确认的内存覆盖（若有），否则环境变量。
 * 未勾选「保存配置到后端」时，调用方不得写入 llm.local.json。
 * 进程重启后内存覆盖消失，这里会回到对应提供方的环境变量和预设地址。
 * 本文件不写日志，也不把密钥放进错误文本。
 * 千问和 Grok 的地址来自现有提供方表，不另建 HTTP 客户端。
 */
export const DEEPSEEK_PRESET_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_PRESET_MODEL = "deepseek-flash";
export const QWEN_PRESET_MODEL = "qwen3.8-max";
export const GROK_PRESET_MODEL = "grok-4.7";

export type ModelPresetId = "local-mock" | "deepseek" | "qwen" | "grok" | "custom";

export interface ModelPreset {
  readonly id: ModelPresetId;
  readonly label: string;
  readonly providerId: LlmProviderId;
  readonly model: string;
  readonly baseUrl: string;
}

/** 预设只提供名称和地址的默认值，调用方可以改。自定义一行不带厂商地址。 */
export function listModelPresets(): readonly ModelPreset[] {
  const deepseek = getLlmProviderProfile("deepseek");
  const qwen = getLlmProviderProfile("qwen");
  const grok = getLlmProviderProfile("grok");
  return [
    { id: "local-mock", label: "local-mock", providerId: "local", model: "local-mock", baseUrl: "" },
    {
      id: "deepseek",
      label: DEEPSEEK_PRESET_MODEL,
      providerId: "deepseek",
      model: DEEPSEEK_PRESET_MODEL,
      baseUrl: deepseek.defaultBaseUrl ?? DEEPSEEK_PRESET_BASE_URL,
    },
    {
      id: "qwen",
      label: QWEN_PRESET_MODEL,
      providerId: "qwen",
      model: QWEN_PRESET_MODEL,
      baseUrl: qwen.defaultBaseUrl ?? "",
    },
    {
      id: "grok",
      label: GROK_PRESET_MODEL,
      providerId: "grok",
      model: GROK_PRESET_MODEL,
      baseUrl: grok.defaultBaseUrl ?? "",
    },
    { id: "custom", label: "自定义", providerId: "local", model: "", baseUrl: "" },
  ];
}

export interface LlmMemoryOverride {
  readonly active: boolean;
  readonly providerId: LlmProviderId;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
}

export interface EffectiveLlmConfig {
  readonly providerId: LlmProviderId;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly localMock: boolean;
  readonly source: "memory" | "env";
}

function nonEmpty(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function envKeyFor(providerId: LlmProviderId, env: Readonly<Record<string, string | undefined>>): string {
  return nonEmpty(env[getLlmProviderProfile(providerId).apiKeyEnvVar]) ?? "";
}

function presetModel(providerId: LlmProviderId): string {
  const found = listModelPresets().find((item) => item.providerId === providerId && item.model !== "" && item.id !== "custom");
  return found?.model ?? DEEPSEEK_PRESET_MODEL;
}

/** 用户覆盖优先。只有模型名 local-mock 走本机模拟。密钥为空时才读该提供方的环境变量。 */
export function resolveEffectiveLlmConfig(options: {
  readonly override: LlmMemoryOverride;
  readonly env: Readonly<Record<string, string | undefined>>;
}): EffectiveLlmConfig {
  const localMock = options.override.active && options.override.model === "local-mock";
  if (localMock) {
    return {
      providerId: "local",
      model: "local-mock",
      baseUrl: "",
      apiKey: "",
      localMock: true,
      source: "memory",
    };
  }
  if (options.override.active) {
    const providerId = options.override.providerId;
    const profile = getLlmProviderProfile(providerId);
    return {
      providerId,
      model: nonEmpty(options.override.model) ?? presetModel(providerId),
      baseUrl: nonEmpty(options.override.baseUrl) ?? profile.defaultBaseUrl ?? "",
      apiKey: nonEmpty(options.override.apiKey) ?? envKeyFor(providerId, options.env),
      localMock: false,
      source: "memory",
    };
  }
  return {
    providerId: "deepseek",
    model: DEEPSEEK_PRESET_MODEL,
    baseUrl: DEEPSEEK_PRESET_BASE_URL,
    apiKey: nonEmpty(options.env.DEEPSEEK_API_KEY) ?? "",
    localMock: false,
    source: "env",
  };
}

/**
 * 单次任务（例如生成报告）的有效配置。
 * 任务表单里填的模型、地址和密钥优先；没填的项回落到同一提供方的全局配置，再回落到该提供方的环境变量。
 * 任务选 local-mock 时不使用任何地址和密钥。
 */
export function resolveTaskLlmConfig(options: {
  readonly task: {
    readonly localMock: boolean;
    readonly model?: string;
    readonly providerId?: LlmProviderId;
    readonly baseUrl: string;
    readonly apiKey: string;
  };
  readonly global: LlmMemoryOverride;
  readonly env: Readonly<Record<string, string | undefined>>;
}): EffectiveLlmConfig {
  if (options.task.localMock || options.task.model === "local-mock") {
    return { providerId: "local", model: "local-mock", baseUrl: "", apiKey: "", localMock: true, source: "memory" };
  }
  const globalRemote = options.global.active && options.global.model !== "local-mock";
  const fallback = resolveEffectiveLlmConfig({
    override: globalRemote ? options.global : { ...options.global, active: false },
    env: options.env,
  });
  const providerId = options.task.providerId ?? (fallback.localMock ? "deepseek" : fallback.providerId);
  const profile = getLlmProviderProfile(providerId);
  const sameProvider = !fallback.localMock && fallback.providerId === providerId;
  const taskModel = nonEmpty(options.task.model);
  const taskBase = nonEmpty(options.task.baseUrl);
  const taskKey = nonEmpty(options.task.apiKey);
  return {
    providerId,
    model: taskModel ?? (sameProvider ? fallback.model : presetModel(providerId)),
    baseUrl: taskBase ?? (sameProvider && fallback.baseUrl !== "" ? fallback.baseUrl : profile.defaultBaseUrl ?? ""),
    apiKey: taskKey ?? (sameProvider ? fallback.apiKey : envKeyFor(providerId, options.env)),
    localMock: false,
    source: taskBase || taskKey || taskModel ? "memory" : fallback.source,
  };
}

/** 只对较长密钥保留末尾四位。掩码若与原文相同，则退回全星号，避免把完整密钥退回浏览器。 */
export function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed === "") return "";
  if (trimmed.length < 16) return "********";
  const mask = `********${trimmed.slice(-4)}`;
  return mask === trimmed ? "********" : mask;
}

/** 从将要返回给浏览器的文字里去掉密钥和 Bearer 片段。 */
export function scrubSecrets(message: string, secrets: readonly (string | undefined)[]): string {
  let text = message.replace(/Bearer\s+\S+/gi, "Bearer ****");
  for (const secret of secrets) {
    if (typeof secret !== "string") continue;
    const trimmed = secret.trim();
    if (trimmed.length < 8) continue;
    text = text.split(trimmed).join("****");
  }
  return text;
}
