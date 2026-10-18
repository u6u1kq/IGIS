// SPDX-License-Identifier: Apache-2.0

export { executeMcpTool } from "./execute.js";
export type { McpRuntimeAuthority, McpToolCallResult } from "./execute.js";
export {
  findMcpTool,
  jsonSchemaOf,
  listMcpTools,
  mcpToolCatalog,
  toMcpToolName,
} from "./names.js";
export {
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  printMcpHelp,
  runMcpOnce,
  runMcpStdioServer,
} from "./stdio.js";
export type { McpStdioOptions } from "./stdio.js";
export { composeAdapters, connectExternalMcp } from "./external.js";
export type { ExternalMcpConfig, ExternalMcpSession } from "./external.js";
