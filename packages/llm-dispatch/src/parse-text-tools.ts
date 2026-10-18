// SPDX-License-Identifier: Apache-2.0

import { looksLikeGeometryText } from "@igis/shared-types";

export interface TextToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readCall(value: unknown, index: number): TextToolCall | null {
  const record = asObject(value);
  if (!record) return null;
  const nested = asObject(record.function);
  const target = nested ?? record;
  const name = typeof target.name === "string"
    ? target.name
    : typeof record.tool === "string"
      ? record.tool
      : typeof record.tool_name === "string"
        ? record.tool_name
        : "";
  if (name.trim() === "") return null;
  let args: unknown = target.arguments ?? target.args ?? record.arguments ?? record.parameters ?? record.scalarArgs;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args) as unknown;
    } catch {
      return null;
    }
  }
  if (args === undefined) {
    const copy = { ...record };
    delete copy.name;
    delete copy.tool;
    delete copy.tool_name;
    delete copy.id;
    delete copy.type;
    delete copy.function;
    args = copy;
  }
  if (typeof args === "string" && looksLikeGeometryText(args)) return null;
  return {
    id: typeof record.id === "string" && record.id.trim() !== "" ? record.id : `text-call-${index}`,
    name: name.trim(),
    args: args ?? {},
  };
}

function parseJsonBlob(text: string, index: number): TextToolCall[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map((item, offset) => readCall(item, index + offset)).filter((item): item is TextToolCall => item !== null);
    }
    const record = asObject(parsed);
    if (!record) return [];
    if (Array.isArray(record.tool_calls)) {
      return record.tool_calls.map((item, offset) => readCall(item, index + offset)).filter((item): item is TextToolCall => item !== null);
    }
    const single = readCall(parsed, index);
    return single ? [single] : [];
  } catch {
    return [];
  }
}

/**
 * 部分提供方把函数调用写在正文里而不是 tool_calls。
 * 只接受名字加标量参数的 JSON，几何文本直接丢掉。
 */
export function parseTextToolCalls(text: string): readonly TextToolCall[] {
  const trimmed = text.trim();
  if (trimmed === "" || looksLikeGeometryText(trimmed)) return [];
  const calls: TextToolCall[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenced.exec(trimmed)) !== null) {
    const blob = match[1]?.trim() ?? "";
    if (blob !== "") calls.push(...parseJsonBlob(blob, calls.length));
  }
  if (calls.length === 0 && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
    calls.push(...parseJsonBlob(trimmed, 0));
  }
  if (calls.length === 0) {
    const tagged = /<tool_call>\s*([\s\S]*?)<\/tool_call>/i.exec(trimmed);
    if (tagged?.[1]) calls.push(...parseJsonBlob(tagged[1].trim(), 0));
  }
  if (calls.length === 0) {
    const invoke = /(?:调用工具|tool(?:\s*call)?)\s*[：:]\s*([A-Za-z0-9_.-]+)\s*(\{[\s\S]*\})/i.exec(trimmed);
    if (invoke?.[1] && invoke[2]) {
      try {
        const args = JSON.parse(invoke[2]) as unknown;
        calls.push({ id: "text-call-0", name: invoke[1], args });
      } catch {
        // 正文不是合法 JSON 时不当成工具调用。
      }
    }
  }
  return calls.slice(0, 8);
}
