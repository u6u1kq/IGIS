// SPDX-License-Identifier: Apache-2.0

import type { ScalarArg, ToolName } from "@igis/shared-types";
import { FORBIDDEN_GEOMETRY_ARG_NAMES } from "@igis/shared-types";
import { PROVENANCE_FORBIDDEN_FIELDS } from "@igis/provenance";
import { LlmInvokeError } from "./errors.js";
import { findGisTool } from "./registry.js";
import type { GisToolDefinition } from "./registry.js";

const GEOMETRY_ARG_NAMES = new Set(
  [...FORBIDDEN_GEOMETRY_ARG_NAMES, ...PROVENANCE_FORBIDDEN_FIELDS].map((name) => name.toLowerCase()),
);

export interface ToolCallProvenance {
  readonly source: "local-user" | "local-parser" | "cloud-ai" | "mcp";
  readonly aiOrigin: boolean;
  readonly translationUsed: boolean;
  readonly requestSource?: "desktop-ui" | "cloud-ai" | "mcp" | "internal";
  readonly dataBoundaryLevel?: "L2";
}

export interface ScheduledToolCall {
  readonly tool: ToolName;
  readonly args: Readonly<Record<string, ScalarArg>>;
  /** 只有人机界面或本地运行时可以设置。模型参数和 MCP 参数不能设置。 */
  readonly userConfirmed?: boolean;
  readonly provenance?: ToolCallProvenance;
  /** 完全不挡时由调度层设置。模型参数不能自己打开这一项。 */
  readonly unrestricted?: boolean;
}

/** 适配器端口。调度层只调用它，不在这里做空间计算。返回值可以是嵌套 JSON，但不能带几何字段。 */
export interface ToolAdapterPort {
  execute(call: ScheduledToolCall): Promise<unknown>;
}

function matches(type: "string" | "number" | "boolean", value: unknown): value is ScalarArg {
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * 分发前检查参数。
 * 未知工具、几何参数名、多余参数和类型不对都会拒绝，并且不会调用适配器。
 */
export function validateToolArguments(
  toolName: string,
  rawArgs: unknown,
  registry: readonly GisToolDefinition[],
  options?: { readonly unrestricted?: boolean },
): ScheduledToolCall {
  const tool = findGisTool(toolName, registry);
  if (!tool) {
    throw new LlmInvokeError("unknown-tool", `未知工具: ${toolName}`);
  }
  if (rawArgs === null || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    throw new LlmInvokeError("invalid-tool-arguments", "工具参数必须是对象。");
  }
  const unrestricted = options?.unrestricted === true;
  const record = rawArgs as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!unrestricted && GEOMETRY_ARG_NAMES.has(key.toLowerCase())) {
      throw new LlmInvokeError("geometry-rejected", `工具参数含有几何字段: ${key}`);
    }
  }
  const args: Record<string, ScalarArg> = {};
  for (const parameter of tool.parameters) {
    if (!Object.prototype.hasOwnProperty.call(record, parameter.name)) {
      if (parameter.required) {
        throw new LlmInvokeError("invalid-tool-arguments", `缺少参数 ${parameter.name}。`);
      }
      continue;
    }
    const value = record[parameter.name];
    if (!matches(parameter.type, value)) {
      if (unrestricted && value !== null && typeof value === "object") {
        args[parameter.name] = JSON.stringify(value);
        continue;
      }
      throw new LlmInvokeError("invalid-tool-arguments", `参数 ${parameter.name} 类型不正确。`);
    }
    args[parameter.name] = value;
  }
  for (const key of Object.keys(record)) {
    if (tool.parameters.some((parameter) => parameter.name === key)) continue;
    if (unrestricted) {
      const value = record[key];
      if (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
        args[key] = value;
      } else if (value !== null && typeof value === "object") {
        args[key] = JSON.stringify(value);
      }
      continue;
    }
    throw new LlmInvokeError("invalid-tool-arguments", `未知参数: ${key}`);
  }
  return { tool: tool.name, args };
}
