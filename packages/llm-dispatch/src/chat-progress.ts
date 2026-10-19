// SPDX-License-Identifier: Apache-2.0

import { toApiToolName } from "./aliases.js";

interface ProgressTrace {
  readonly tool: string;
  readonly ok: boolean;
  readonly message: string;
  readonly layerName?: string;
  readonly durationMs?: number;
}

export type ThoughtStatusCode = "understanding" | "running_tools";

export type ChatProgressEvent =
  | { readonly type: "thought"; readonly kind: "reasoning"; readonly text: string }
  | { readonly type: "thought"; readonly kind: "status"; readonly code: ThoughtStatusCode }
  | { readonly type: "tool"; readonly tool: string; readonly ok: boolean; readonly message: string; readonly layerName?: string; readonly durationMs?: number }
  | { readonly type: "final"; readonly text: string };

export type ChatProgressHandler = (event: ChatProgressEvent) => void;

/** 去掉空值。 */
export function sanitizeProgressText(text: string): string {
  const trimmed = text.replace(/\u0000/g, "").trim();
  if (trimmed === "") return "";
  return trimmed.slice(0, 4000);
}

export function progressToolEvent(trace: ProgressTrace): ChatProgressEvent {
  const message = sanitizeProgressText(trace.message) || (trace.ok ? "已完成。" : "工具没有完成。");
  const layerName = typeof trace.layerName === "string" ? sanitizeProgressText(trace.layerName) : "";
  const durationMs = typeof trace.durationMs === "number" && Number.isFinite(trace.durationMs) && trace.durationMs >= 0
    ? Math.round(trace.durationMs)
    : undefined;
  return {
    type: "tool",
    tool: toApiToolName(trace.tool),
    ok: trace.ok,
    message,
    ...(layerName !== "" ? { layerName } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

/** 评测用的可见事件顺序：思考状态 → 工具步 → 最终文字。 */
export const CHAT_STREAM_FIXTURE: readonly ChatProgressEvent[] = [
  { type: "thought", kind: "status", code: "understanding" },
  { type: "tool", tool: "run_buffer", ok: true, message: "已缓冲", layerName: "area-a_缓冲" },
  { type: "final", text: "已按计划完成 run_buffer、run_intersect。" },
];

export function visibleStreamEventTypes(events: readonly ChatProgressEvent[]): readonly string[] {
  return events.map((event) => event.type);
}
