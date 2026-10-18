// SPDX-License-Identifier: Apache-2.0

import type { LlmProviderId } from "@igis/shared-types";
import { LlmInvokeError } from "./errors.js";

/**
 * 提供方占位。defaultBaseUrl 可被调用参数覆盖。
 * 类型检查和自检都不会访问这些地址。
 * 密钥只出现在环境变量名里：
 * DEEPSEEK_API_KEY、QWEN_API_KEY、GROK_API_KEY、LOCAL_LLM_API_KEY。
 * 本地模型可以不提供密钥。builtinBaseModel 保持为空，本程序不内置权重。
 */
export interface LlmProviderProfile {
  readonly id: LlmProviderId;
  readonly label: string;
  readonly defaultBaseUrl: string | null;
  readonly apiKeyEnvVar: string;
  readonly apiKeyRequired: boolean;
}

export const LLM_PROVIDER_PROFILES: readonly LlmProviderProfile[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com",
    apiKeyEnvVar: "DEEPSEEK_API_KEY",
    apiKeyRequired: true,
  },
  {
    id: "qwen",
    label: "千问",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnvVar: "QWEN_API_KEY",
    apiKeyRequired: true,
  },
  {
    id: "grok",
    label: "Grok",
    defaultBaseUrl: "https://api.x.ai/v1",
    apiKeyEnvVar: "GROK_API_KEY",
    apiKeyRequired: true,
  },
  {
    id: "local",
    label: "本地模型",
    defaultBaseUrl: null,
    apiKeyEnvVar: "LOCAL_LLM_API_KEY",
    apiKeyRequired: false,
  },
];

export function getLlmProviderProfile(id: LlmProviderId): LlmProviderProfile {
  const found = LLM_PROVIDER_PROFILES.find((item) => item.id === id);
  if (!found) {
    throw new LlmInvokeError("unknown-provider", `未知的模型提供方: ${id}`);
  }
  return found;
}

/** 拼出 OpenAI 兼容的 chat/completions 地址。已带该路径时不再重复追加。 */
export function resolveChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  return `${trimmed}/chat/completions`;
}
