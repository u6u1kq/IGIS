// SPDX-License-Identifier: Apache-2.0

import { LlmInvokeError } from "./errors.js";
import { assertLlmPayload } from "./guard.js";
import { postLlmJson } from "./http.js";
import type { LlmCallerOptions } from "./invoke.js";
import { resolveLlmConnection } from "./invoke.js";
import { resolveChatCompletionsUrl } from "./providers.js";

export interface LlmTextRequest {
  readonly system: string;
  /** 发给模型的材料。发请求前按来源账本的禁用字段和几何文本检查一遍。 */
  readonly material: unknown;
  readonly instruction: string;
  readonly maxTokens?: number;
}

function readContent(payload: unknown): string {
  if (payload === null || typeof payload !== "object") throw new LlmInvokeError("invalid-tool-call", "模型响应不是对象。");
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) throw new LlmInvokeError("invalid-tool-call", "模型响应缺少 choices。");
  const first: unknown = choices[0];
  const message = first !== null && typeof first === "object" ? (first as Record<string, unknown>).message : null;
  const content = message !== null && typeof message === "object" ? (message as Record<string, unknown>).content : null;
  if (typeof content !== "string" || content.trim() === "") throw new LlmInvokeError("empty-reply", "模型没有返回文字。");
  return content;
}

/**
 * 一次不带工具的 chat/completions，用于报告文字。
 * 走现有的 resolveLlmConnection 和 postLlmJson，不另建 HTTP 客户端。
 * 材料里若有几何字段或 WKT / GeoJSON 文本，不发请求，直接拒绝。
 */
export async function requestLlmText(options: LlmCallerOptions, request: LlmTextRequest): Promise<string> {
  const resolved = resolveLlmConnection(options);
  assertLlmPayload(request.material);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (resolved.apiKey) headers.Authorization = `Bearer ${resolved.apiKey}`;
  const body = JSON.stringify({
    model: resolved.model,
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: `${request.instruction}\n\n材料（JSON，不含几何坐标）：\n${JSON.stringify(request.material)}` },
    ],
    temperature: 0.2,
    max_tokens: request.maxTokens ?? 1200,
  });
  const payload = await postLlmJson(options.fetchImpl, resolveChatCompletionsUrl(resolved.baseUrl), headers, body, options.timeoutMs ?? 60_000);
  return readContent(payload);
}
