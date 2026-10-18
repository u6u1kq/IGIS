// SPDX-License-Identifier: Apache-2.0

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ExternalBackendPort, ExternalBackendResult, ExternalCapabilityRequest } from "./port.js";

/**
 * MCP 协议后端适配器：本地 stdio 起 MCP server，本进程以 MCP 客户端调用其工具。
 * 模型永远不直连 MCP——请求与结果都必须先过 ExternalCapabilityBoundary。
 * 与 gdal-mcp 这类第三方 MCP server 对接时使用；live 通道的实测在接入时做。
 */
export interface McpBackendOptions {
  readonly name?: string;
  readonly command: string;
  readonly args?: readonly string[];
  /** 能力名到 MCP 工具名的映射；不传则同名。 */
  readonly mapToolName?: (capability: string) => string;
}

export function createMcpBackend(options: McpBackendOptions): ExternalBackendPort {
  let clientPromise: Promise<Client> | null = null;

  async function ensureClient(): Promise<Client> {
    if (!clientPromise) {
      clientPromise = (async () => {
        const client = new Client({ name: options.name ?? "igis-external-gateway", version: "0.1.0" });
        await client.connect(new StdioClientTransport({ command: options.command, args: [...(options.args ?? [])] }));
        return client;
      })();
    }
    return clientPromise;
  }

  return {
    name: options.name ?? "mcp",
    async isAvailable(): Promise<boolean> {
      try {
        await ensureClient();
        return true;
      } catch {
        return false;
      }
    },
    async invoke(request: ExternalCapabilityRequest): Promise<ExternalBackendResult> {
      const client = await ensureClient();
      const toolName = options.mapToolName ? options.mapToolName(request.capability) : request.capability;
      const response = await client.callTool({
        name: toolName,
        arguments: { inputResources: [...request.inputResources], ...request.parameters },
      });
      const content = (response as { content?: readonly { type?: string; text?: string }[] }).content ?? [];
      const firstText = content.find((item) => item.type === "text" && typeof item.text === "string")?.text ?? "";
      if (firstText.trim() === "") {
        return { ok: false };
      }
      try {
        return JSON.parse(firstText) as ExternalBackendResult;
      } catch {
        return { ok: false, facts: { note: "non-json" }, message: firstText.slice(0, 500) };
      }
    },
  };
}
