// SPDX-License-Identifier: Apache-2.0

/**
 * 删除图层和清空图层共用的确认边界。
 * 聊天界面可以先问一句，但 Map、MCP 和直接工具调用也要经过这里。
 * 布尔参数是人机界面或本地运行时的确认，不是模型或 MCP 参数里的 confirm。
 * 调用方不得把模型载荷里的 confirm:true 传进来。
 */

export type DestructiveAction = "delete-layer" | "clear-layers" | "drop-database";

export function destructiveActionOf(tool: string): DestructiveAction | null {
  if (tool === "map.delete" || tool === "delete_layer") return "delete-layer";
  if (tool === "map.clearAll" || tool === "clear_all_layers") return "clear-layers";
  if (tool === "map.dropDatabase" || tool === "delete_database") return "drop-database";
  return null;
}

export function destructiveConfirmMessage(action: DestructiveAction, detail?: string): string {
  if (action === "drop-database") return "确认要删除数据库吗？确认后才会执行。";
  if (action === "clear-layers") return "确认要清空所有图层吗？确认后才会执行。";
  const names = (detail ?? "").trim();
  if (names !== "") return `确认要删除图层 ${names} 吗？确认后才会执行。`;
  return "确认要删除图层吗？确认后才会执行。";
}

export function gateDestructive(
  action: DestructiveAction,
  confirmed: boolean,
  detail?: string,
): { readonly ok: true } | { readonly ok: false; readonly code: "confirm-required"; readonly message: string } {
  if (confirmed === true) return { ok: true };
  return { ok: false, code: "confirm-required", message: destructiveConfirmMessage(action, detail) };
}
