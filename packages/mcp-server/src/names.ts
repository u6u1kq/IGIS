// SPDX-License-Identifier: Apache-2.0

import { GIS_TOOL_REGISTRY } from "@igis/llm-dispatch";
import type { GisToolDefinition } from "@igis/llm-dispatch";
import { isModelVisibleTool } from "@igis/ai-translation";

/** MCP 工具名只允许字母、数字、下划线和连字符。图层工具里的点改成下划线。 */
export function toMcpToolName(toolName: string): string {
  return toolName.replace(/\./g, "_");
}

export function mcpToolCatalog(registry: readonly GisToolDefinition[] = GIS_TOOL_REGISTRY): readonly {
  readonly mcpName: string;
  readonly tool: GisToolDefinition;
}[] {
  const used = new Set<string>();
  return registry.map((tool) => {
    let mcpName = toMcpToolName(tool.name);
    if (used.has(mcpName)) mcpName = `${mcpName}_tool`;
    used.add(mcpName);
    return { mcpName, tool };
  });
}

export function findMcpTool(
  mcpName: string,
  registry: readonly GisToolDefinition[] = GIS_TOOL_REGISTRY,
): GisToolDefinition | undefined {
  const catalog = mcpToolCatalog(registry);
  const hit = catalog.find((item) => item.mcpName === mcpName);
  return hit?.tool;
}

export function jsonSchemaOf(tool: GisToolDefinition): Readonly<Record<string, unknown>> {
  const properties: Record<string, { readonly type: string; readonly description: string }> = {};
  const required: string[] = [];
  for (const parameter of tool.parameters) {
    properties[parameter.name] = { type: parameter.type, description: parameter.description };
    if (parameter.required) required.push(parameter.name);
  }
  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

export function listMcpTools(registry: readonly GisToolDefinition[] = GIS_TOOL_REGISTRY): readonly {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}[] {
  return mcpToolCatalog(registry)
    .filter((item) => isModelVisibleTool(item.tool.name))
    .map((item) => ({
    name: item.mcpName,
    description: item.tool.description,
    inputSchema: jsonSchemaOf(item.tool),
  }));
}
