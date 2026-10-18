// SPDX-License-Identifier: Apache-2.0

/**
 * 出厂默认：本地结构化过滤优先。
 * localMethod 仍保留本地嵌入这一名称，V0.2 不实现嵌入，也不引入嵌入库。
 * 云端嵌入必须由用户显式打开。出厂 cloudEnabled 为 false。
 */
export interface RetrievalConfig {
  readonly provider: "local" | "cloud";
  readonly cloudEnabled: boolean;
  readonly localMethod: "structured-filter+local-embedding";
  readonly cloudEndpoint: string | null;
  readonly cloudApiKeyEnvVar: string | null;
}

export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  provider: "local",
  cloudEnabled: false,
  localMethod: "structured-filter+local-embedding",
  cloudEndpoint: null,
  cloudApiKeyEnvVar: null,
};

/** 调用方可选的模型提供方。本地模型由用户提供 baseUrl。 */
export type LlmProviderId = "deepseek" | "qwen" | "grok" | "local";

/**
 * 不内置基座模型。密钥只通过环境变量名引用，配置里不写密钥值。
 * 环境变量名：DEEPSEEK_API_KEY、QWEN_API_KEY、GROK_API_KEY、LOCAL_LLM_API_KEY。
 */
export interface ExternalLlmConfig {
  readonly mode: "external-api";
  readonly builtinModel: null;
  readonly providerId: LlmProviderId | null;
  readonly baseUrl: string | null;
  readonly model: string | null;
  readonly apiKeyEnvVar: string | null;
}

export const EMPTY_LLM_CONFIG: ExternalLlmConfig = {
  mode: "external-api",
  builtinModel: null,
  providerId: null,
  baseUrl: null,
  model: null,
  apiKeyEnvVar: null,
};
