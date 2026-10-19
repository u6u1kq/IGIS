// SPDX-License-Identifier: Apache-2.0

import { GIS_TOOL_REGISTRY } from "@igis/llm-dispatch";
import type { GisToolDefinition, ToolAdapterPort } from "@igis/llm-dispatch";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { executeMcpTool } from "./execute.js";
import { listMcpTools } from "./names.js";

export const MCP_SERVER_NAME = "igis";
export const MCP_SERVER_VERSION = "0.73.0";

export interface McpStdioOptions {
  readonly adapter: () => Promise<ToolAdapterPort>;
  readonly tools?: readonly GisToolDefinition[];
}

function toolArguments(params: Readonly<Record<string, unknown>> | undefined): unknown {
  if (!params) return {};
  const args = params.arguments;
  return args === undefined ? {} : args;
}

function toolNameOf(params: Readonly<Record<string, unknown>> | undefined): string {
  if (!params || typeof params.name !== "string") return "";
  return params.name.trim();
}

/** 用官方 MCP TypeScript SDK 在 stdio 上暴露现有 GIS 工具。 */
export async function runMcpStdioServer(options: McpStdioOptions): Promise<void> {
  const tools = options.tools ?? GIS_TOOL_REGISTRY;
  const server = new Server(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: listMcpTools(tools),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = toolNameOf(request.params);
    const adapter = await options.adapter();
    const result = await executeMcpTool(adapter, name, toolArguments(request.params), tools);
    return {
      content: [{ type: "text", text: result.text }],
      isError: !result.ok,
    };
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export function printMcpHelp(write: (line: string) => void): void {
  write("Igis MCP 服务器");
  write("在 stdio 上暴露空间操作和图层摘要（缓冲、相交、裁剪、查询、统计、样式、显隐、顺序、缩放、GDL）。");
  write("网页应用不依赖本进程，也不依赖 Cursor。");
  write("");
  write("用法：");
  write("  npx --yes tsx --tsconfig tsconfig.json apps/cli/src/mcp-server.ts");
  write("  npx --yes tsx --tsconfig tsconfig.json apps/cli/src/mcp-server.ts --help");
  write("  npx --yes tsx --tsconfig tsconfig.json apps/cli/src/mcp-server.ts --list-tools");
  write("  npx --yes tsx --tsconfig tsconfig.json apps/cli/src/mcp-server.ts --once");
  write("");
  write("工具：");
  for (const tool of listMcpTools()) {
    write(`  ${tool.name}`);
  }
}

/**
 * 一次性 JSON-RPC：从标准输入读 initialize / tools/list（换行或 Content-Length），
 * 写出响应后退出。不打开 GIS 运行时。
 */
export async function runMcpOnce(
  readStdin: () => Promise<string>,
  write: (chunk: string) => void,
): Promise<void> {
  const raw = await readStdin();
  const messages = parseRpcMessages(raw);
  for (const message of messages) {
    const reply = handleOnce(message);
    if (reply) write(encodeContentLength(reply));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseRpcMessages(raw: string): Record<string, unknown>[] {
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  const framed = parseContentLength(raw);
  if (framed.length > 0) return framed;
  const items: Record<string, unknown>[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (text === "") continue;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (isRecord(parsed)) items.push(parsed);
    } catch {
      // 跳过无法解析的行。
    }
  }
  if (items.length > 0) return items;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? [parsed] : [];
  } catch {
    return [];
  }
}

function parseContentLength(raw: string): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  let rest = raw;
  while (rest.length > 0) {
    const match = /^Content-Length:\s*(\d+)\r?\n\r?\n/i.exec(rest);
    if (!match?.[1]) break;
    const size = Number(match[1]);
    const start = match[0].length;
    const json = rest.slice(start, start + size);
    rest = rest.slice(start + size);
    try {
      const parsed = JSON.parse(json) as unknown;
      if (isRecord(parsed)) items.push(parsed);
    } catch {
      break;
    }
  }
  return items;
}

function encodeContentLength(value: unknown): string {
  const json = `${JSON.stringify(value)}\n`;
  const bytes = new TextEncoder().encode(json).length;
  return `Content-Length: ${bytes}\r\n\r\n${json}`;
}

function handleOnce(message: Record<string, unknown>): Record<string, unknown> | null {
  const id = message.id;
  const method = typeof message.method === "string" ? message.method : "";
  if (method === "notifications/initialized" || method.startsWith("notifications/")) return null;
  if (id === undefined) return null;
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      },
    };
  }
  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: listMcpTools() } };
  }
  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: "一次性模式只处理 initialize 和 tools/list。" },
  };
}
