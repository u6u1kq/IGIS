// SPDX-License-Identifier: Apache-2.0

import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LlmInvokeError } from "./errors.js";
import type { LlmHttp } from "./invoke.js";

const AUDIT_DIR = "var/llm-requests";
const AUDIT_KEEP = 200;
const AUDIT_BODY_CAP = 262144;
/** 出站审计整体磁盘占用上限。超出从最旧开始淘汰，避免无限膨胀。 */
const AUDIT_TOTAL_CAP = 50 * 1024 * 1024;

/**
 * 出站审计：把发给模型的消息体落盘到 var/llm-requests，供事后核查模型看到了什么。
 * 不记录鉴权头；目标地址去掉查询串，避免把密钥写进日志。失败不阻塞模型调用。
 */
async function auditOutbound(url: string, body: string): Promise<void> {
  try {
    const target = (url.split("?")[0] ?? url).slice(0, 512);
    const record = {
      at: new Date().toISOString(),
      target,
      bodyLength: body.length,
      body: body.length > AUDIT_BODY_CAP ? `${body.slice(0, AUDIT_BODY_CAP)}…（截断）` : body,
    };
    await mkdir(AUDIT_DIR, { recursive: true });
    const name = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.json`;
    await writeFile(join(AUDIT_DIR, name), JSON.stringify(record, null, 2), { encoding: "utf8" });
    const files = await readdir(AUDIT_DIR);
    if (files.length > AUDIT_KEEP) {
      const doomed = files.sort().slice(0, files.length - AUDIT_KEEP);
      for (const item of doomed) await rm(join(AUDIT_DIR, item), { recursive: true, force: true });
    }
    await evictAuditOverBudget();
  } catch {
    // 审计失败不影响模型调用。
  }
}

/** 总大小上限：目录整体超过 50MB 时按文件名（时间序）从最旧开始淘汰。 */
async function evictAuditOverBudget(): Promise<void> {
  const names = (await readdir(AUDIT_DIR)).sort();
  const sized: { readonly name: string; readonly size: number }[] = [];
  let total = 0;
  for (const name of names) {
    const info = await stat(join(AUDIT_DIR, name));
    sized.push({ name, size: info.size });
    total += info.size;
  }
  for (const item of sized) {
    if (total <= AUDIT_TOTAL_CAP) break;
    await rm(join(AUDIT_DIR, item.name), { recursive: true, force: true });
    total -= item.size;
  }
}

function resolveHttp(injected: LlmHttp | undefined): LlmHttp {
  if (injected) return injected;
  const runtimeFetch = (globalThis as { fetch?: unknown }).fetch;
  if (typeof runtimeFetch !== "function") {
    throw new LlmInvokeError("missing-fetch", "当前运行时没有 fetch。请注入 fetchImpl。");
  }
  return runtimeFetch as LlmHttp;
}

/**
 * 发起一次 chat/completions。
 * 用 Promise.race 限制等待时间，到点就返回，不跟着挂起的连接一直等。
 */
export async function postLlmJson(
  fetchImpl: LlmHttp | undefined,
  url: string,
  headers: Readonly<Record<string, string>>,
  body: string,
  timeoutMs: number,
): Promise<unknown> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new LlmInvokeError("timeout", "timeoutMs 必须是正数。");
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  void auditOutbound(url, body);
  const fetchPromise = (async () => {
    const response = await resolveHttp(fetchImpl)(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    const text = await response.text();
    return { response, text };
  })().then(
    (value) => ({ kind: "ok" as const, value }),
    (error: unknown) => ({ kind: "err" as const, error }),
  );
  const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: "timeout" });
    }, timeoutMs);
  });
  const outcome = await Promise.race([fetchPromise, timeoutPromise]);
  if (timer !== undefined) clearTimeout(timer);
  if (outcome.kind === "timeout") {
    throw new LlmInvokeError("timeout", `模型请求超过 ${timeoutMs} 毫秒，已停止等待。`);
  }
  if (outcome.kind === "err") {
    if (outcome.error instanceof LlmInvokeError) throw outcome.error;
    const message = outcome.error instanceof Error ? outcome.error.message : "网络错误";
    throw new LlmInvokeError("network-error", message);
  }
  if (!outcome.value.response.ok) {
    throw new LlmInvokeError(
      "http-error",
      `模型接口返回 HTTP ${outcome.value.response.status}: ${outcome.value.text.slice(0, 500)}`,
    );
  }
  try {
    return JSON.parse(outcome.value.text) as unknown;
  } catch {
    throw new LlmInvokeError("invalid-tool-call", "模型响应不是 JSON。");
  }
}
