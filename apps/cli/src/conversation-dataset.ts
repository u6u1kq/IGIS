// SPDX-License-Identifier: Apache-2.0

import type { ChatMessage } from "./conversations.js";

/** 这条对话已经存下的来回记录。当前这句不重复放进去。 */
export function dialogueBeforeCurrent(messages: readonly ChatMessage[], current: string): string {
  const list = [...messages];
  const last = list[list.length - 1];
  if (last?.role === "user" && last.text.trim() === current.trim()) list.pop();
  const lines: string[] = [];
  for (const message of list.slice(-40)) {
    const text = message.text.replace(/\s+/g, " ").trim();
    if (text === "") continue;
    const who = message.role === "user" ? "用户" : "助手";
    lines.push(`${who}：${text.slice(0, 1000)}`);
  }
  const joined = lines.join("\n");
  return joined.length > 16_000 ? joined.slice(-16_000) : joined;
}
