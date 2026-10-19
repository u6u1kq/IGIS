// SPDX-License-Identifier: Apache-2.0

import { env as nodeEnv } from "node:process";
import { resolve } from "node:path";
import { ensureManagedGdalEnv } from "@igis/external-gateway";
import { printMcpHelp, runMcpOnce, runMcpStdioServer } from "@igis/mcp-server";
import { ConversationStore, conversationDirectory, conversationWorkspaceDirectory } from "./conversations.js";
import { openGisWorkspace } from "./gis-runtime.js";

interface HostProcess {
  readonly argv: readonly string[];
  cwd(): string;
  stdin: { [Symbol.asyncIterator](): AsyncIterator<Uint8Array | string> };
  stdout: { write(chunk: string): boolean };
  stderr: { write(chunk: string): boolean };
}

function hostProcess(): HostProcess {
  const candidate = (globalThis as { process?: HostProcess }).process;
  if (!candidate) throw new Error("MCP 服务器需要 Node。");
  return candidate;
}

async function readStdin(proc: HostProcess): Promise<string> {
  const parts: string[] = [];
  for await (const chunk of proc.stdin) {
    parts.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
  }
  return parts.join("");
}

async function main(): Promise<void> {
  const proc = hostProcess();
  const args = proc.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printMcpHelp((line) => {
      proc.stdout.write(`${line}\n`);
    });
    return;
  }
  if (args.includes("--list-tools")) {
    const { listMcpTools } = await import("@igis/mcp-server");
    proc.stdout.write(`${JSON.stringify({ ok: true, tools: listMcpTools() }, null, 2)}\n`);
    return;
  }
  if (args.includes("--once")) {
    await runMcpOnce(() => readStdin(proc), (chunk) => {
      proc.stdout.write(chunk);
    });
    return;
  }
  const root = proc.cwd();
  void ensureManagedGdalEnv(root);
  let workspace: Awaited<ReturnType<typeof openGisWorkspace>> | null = null;
  let conversations: ConversationStore | null = null;
  await runMcpStdioServer({
    adapter: async () => {
      if (!workspace) {
        workspace = await openGisWorkspace(root, { modelName: () => "mcp", entry: "mcp", env: nodeEnv });
        workspace.spatial.catalog.detach();
        conversations = new ConversationStore(conversationDirectory(root), resolve(root, "var/desktop/messages.json"));
        await conversations.load();
      }
      const opened = workspace;
      const store = conversations;
      if (!opened || !store) throw new Error("MCP 工作区没有打开。");
      const active = store.active();
      return {
        execute: (call) => opened.spatial.service.inConversation(
          conversationWorkspaceDirectory(root, active.id),
          () => opened.adapter.execute(call),
        ),
      };
    },
  });
}

const entry = hostProcess().argv[1] ?? "";
if (entry.includes("mcp-server")) {
  void main().catch((error) => {
    const proc = hostProcess();
    const message = error instanceof Error ? error.message : "MCP 服务器没有启动。";
    proc.stderr.write(`${message.replace(/sk-[A-Za-z0-9_-]+/g, "****")}\n`);
  });
}
