// SPDX-License-Identifier: Apache-2.0

import { concealUserApi, rejectStorageRead } from "@igis/ai-boundary";
import { LlmInvokeError } from "@igis/llm-dispatch";
import type { GisToolDefinition, ScheduledToolCall, ToolAdapterPort } from "@igis/llm-dispatch";
import { isModelVisibleTool } from "@igis/ai-translation";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface ExternalMcpConfig {
  readonly command: string;
  readonly args: readonly string[];
}

export interface ExternalMcpSession {
  readonly tools: readonly GisToolDefinition[];
  readonly adapter: ToolAdapterPort;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function schemaParameters(schema: unknown): GisToolDefinition["parameters"] {
  if (!isRecord(schema) || !isRecord(schema.properties)) return [];
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [],
  );
  const parameters: { name: string; type: "string" | "number" | "boolean"; required: boolean; description: string }[] = [];
  for (const [name, spec] of Object.entries(schema.properties)) {
    if (!isRecord(spec)) continue;
    const rawType = spec.type;
    const type = rawType === "number" || rawType === "integer" ? "number" : rawType === "boolean" ? "boolean" : "string";
    const description = typeof spec.description === "string" ? spec.description : name;
    parameters.push({ name, type, required: required.has(name), description });
  }
  return parameters;
}

function mcpToolName(name: string): string {
  const compact = name.trim().replace(/[^A-Za-z0-9_-]/g, "_");
  return compact === "" ? "mcp_tool" : compact.slice(0, 64);
}

function extractText(payload: { readonly content?: unknown }): string {
  const content = payload.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(payload);
  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    if (typeof item.text === "string") parts.push(item.text);
  }
  return parts.join("\n") || JSON.stringify(payload);
}

/**
 * 可选的外部 MCP 客户端。命令和参数来自齿轮配置。
 * FUTURE CAPABILITY SANDBOX: NOT IMPLEMENTED。
 * 外部进程的进程、文件系统和网络不受本程序控制。隔离规则不写在这里。
 * 失败时返回 null，对话仍只用内置 GIS 工具。不要在日志里打印命令行。
 * 测试和实现修复不得启动这里的外部命令。
 */
export async function connectExternalMcp(config: ExternalMcpConfig): Promise<ExternalMcpSession | null> {
  const command = config.command.trim();
  if (command === "") return null;
  const transport = new StdioClientTransport({ command, args: [...config.args] });
  const client = new Client({ name: "igis-desktop", version: "0.73.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const tools: GisToolDefinition[] = [];
    const seen = new Set<string>();
    const originalNames = new Map<string, string>();
    for (const item of listed.tools) {
      if (!isModelVisibleTool(item.name)) continue;
      const localName = `map.ext_${mcpToolName(item.name)}`;
      if (seen.has(localName)) continue;
      seen.add(localName);
      originalNames.set(localName, item.name);
      tools.push({
        name: localName as GisToolDefinition["name"],
        description: (item.description ?? item.name).slice(0, 400),
        parameters: schemaParameters(item.inputSchema),
      });
    }
    const adapter: ToolAdapterPort = {
      async execute(call: ScheduledToolCall) {
        const rejected = rejectStorageRead(call.tool);
        if (rejected) return rejected;
        const remoteName = originalNames.get(call.tool) ?? call.tool;
        const result: unknown = await client.callTool({ name: remoteName, arguments: { ...call.args } });
        const payload = result as { readonly content?: unknown; readonly isError?: boolean };
        const text = extractText(payload);
        let parsed: unknown = { ok: payload.isError !== true, message: text.slice(0, 4000) };
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          parsed = { ok: payload.isError !== true, message: text.slice(0, 4000) };
        }
        return concealUserApi(parsed);
      },
    };
    return {
      tools,
      adapter,
      async close() {
        try {
          await client.close();
        } catch {
          // 关闭失败不影响对话。
        }
      },
    };
  } catch {
    try {
      await client.close();
    } catch {
      // 忽略。
    }
    return null;
  }
}

export function composeAdapters(inner: ToolAdapterPort, extra: ToolAdapterPort, extraNames: ReadonlySet<string>): ToolAdapterPort {
  return {
    execute(call) {
      if (extraNames.has(call.tool)) return extra.execute(call);
      return inner.execute(call);
    },
  };
}
