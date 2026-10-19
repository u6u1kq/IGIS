// SPDX-License-Identifier: Apache-2.0

import { concealUserApi, rejectStorageRead } from "@igis/ai-boundary";
import { GIS_TOOL_REGISTRY, normalizeToolArguments } from "@igis/llm-dispatch";
import type { GisToolDefinition, ScheduledToolCall, ToolAdapterPort } from "@igis/llm-dispatch";
import { isModelVisibleTool } from "@igis/ai-translation";
import { findMcpTool } from "./names.js";

export interface McpToolCallResult {
  readonly ok: boolean;
  readonly text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface McpRuntimeAuthority {
  /** 桌面或测试运行时的用户确认。工具参数里的 confirm 不能代替它。 */
  readonly userConfirmed?: boolean;
}

/**
 * 模型侧 MCP 只走现有操作接口。
 * 打开文件、读取几何和导出原始图层的工具在这里停住，不会进入图层库。
 * 返回给模型的结果再过一次翻译。
 * 参数里的 confirm:true 不能删除图层、清空图层或删除知识。
 */
export async function executeMcpTool(
  adapter: ToolAdapterPort,
  mcpName: string,
  rawArgs: unknown,
  registry: readonly GisToolDefinition[] = GIS_TOOL_REGISTRY,
  authority?: McpRuntimeAuthority,
): Promise<McpToolCallResult> {
  const tool = findMcpTool(mcpName, registry);
  if (!tool) {
    return { ok: false, text: JSON.stringify({ ok: false, code: "unknown-tool", message: "未知工具。" }) };
  }
  if (!isModelVisibleTool(tool.name) || !isModelVisibleTool(mcpName)) {
    return { ok: false, text: JSON.stringify({ ok: false, code: "capability-rejected", message: "这个工具不能对模型或外部 MCP 开放。" }) };
  }
  const rejected = rejectStorageRead(tool.name) ?? rejectStorageRead(mcpName);
  if (rejected) return { ok: false, text: JSON.stringify(rejected) };
  try {
    const scheduled = normalizeToolArguments(tool.name, rawArgs ?? {}, registry);
    const call: ScheduledToolCall = {
      tool: scheduled.tool,
      args: scheduled.args,
      provenance: {
        source: "mcp",
        aiOrigin: true,
        translationUsed: true,
        requestSource: "mcp",
        dataBoundaryLevel: "L2",
      },
      ...(authority?.userConfirmed === true ? { userConfirmed: true as const } : {}),
    };
    const result = concealUserApi(await adapter.execute(call));
    const payload = isRecord(result) ? result : { ok: true, result };
    return { ok: payload.ok !== false, text: JSON.stringify(payload) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "工具没有完成。";
    if (/密钥|api[_-]?key|bearer|sk-/i.test(message)) {
      return { ok: false, text: JSON.stringify({ ok: false, code: "tool-error", message: "工具没有完成。" }) };
    }
    return { ok: false, text: JSON.stringify({ ok: false, code: "tool-error", message }) };
  }
}
