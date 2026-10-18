// SPDX-License-Identifier: Apache-2.0

import { ARG_ALIASES, canonicalToolName, isKnownArgAlias, pickAliasedValue } from "./aliases.js";
import { LlmInvokeError } from "./errors.js";
import { findGisTool } from "./registry.js";
import type { GisToolDefinition } from "./registry.js";
import { validateToolArguments } from "./validate.js";
import type { ScheduledToolCall } from "./validate.js";

const DISTANCE_WITH_UNIT = /^(-?\d+(?:\.\d+)?)\s*(米|千米|公里|英里|英尺|度|m|km|meters?|kilometers?|miles?|feet|foot|degrees?)?$/i;

const UNIT_TEXT: Readonly<Record<string, string>> = {
  米: "meters",
  m: "meters",
  meter: "meters",
  meters: "meters",
  千米: "kilometers",
  公里: "kilometers",
  km: "kilometers",
  kilometer: "kilometers",
  kilometers: "kilometers",
  英里: "miles",
  mile: "miles",
  miles: "miles",
  英尺: "feet",
  foot: "feet",
  feet: "feet",
  度: "degrees",
  degree: "degrees",
  degrees: "degrees",
};

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LlmInvokeError("invalid-tool-arguments", "工具参数必须是对象。");
  }
  return { ...(value as Record<string, unknown>) };
}

function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return undefined;
  const text = value.trim().toLowerCase();
  if (text === "true" || text === "1" || text === "yes" || text === "是" || text === "显示") return true;
  if (text === "false" || text === "0" || text === "no" || text === "否" || text === "隐藏") return false;
  return undefined;
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeUnitText(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const key = value.trim();
  return UNIT_TEXT[key] ?? UNIT_TEXT[key.toLowerCase()] ?? value;
}

function splitDistance(value: unknown): { readonly distance?: number; readonly unit?: string } {
  if (typeof value === "number" && Number.isFinite(value)) return { distance: value };
  if (typeof value !== "string") return {};
  const matched = DISTANCE_WITH_UNIT.exec(value.trim());
  if (!matched?.[1]) return {};
  const distance = Number(matched[1]);
  const unitRaw = matched[2];
  const unit = unitRaw ? String(normalizeUnitText(unitRaw)) : undefined;
  return unit ? { distance, unit } : { distance };
}

/**
 * 把模型给的参数整理成登记表要求的形状：别名、数字字符串、中文单位。
 * 几何字段仍由 validateToolArguments 拒绝。
 */
export function normalizeToolArguments(
  toolName: string,
  rawArgs: unknown,
  registry: readonly GisToolDefinition[],
  options?: { readonly unrestricted?: boolean },
): ScheduledToolCall {
  const canonical = canonicalToolName(toolName);
  const tool = findGisTool(canonical, registry) ?? findGisTool(toolName, registry);
  if (!tool) {
    throw new LlmInvokeError("unknown-tool", `未知工具: ${toolName}`);
  }
  const record = asRecord(rawArgs);
  const mapped: Record<string, unknown> = {};
  for (const parameter of tool.parameters) {
    const aliases = ARG_ALIASES[parameter.name] ?? [parameter.name];
    const value = pickAliasedValue(record, aliases);
    if (value === undefined) continue;
    if (parameter.type === "number") {
      if (parameter.name === "distance") {
        const split = splitDistance(value);
        if (split.distance !== undefined) mapped.distance = split.distance;
        if (split.unit !== undefined && pickAliasedValue(record, ARG_ALIASES.unit ?? ["unit"]) === undefined) {
          mapped.unit = split.unit;
        }
        continue;
      }
      const number = coerceNumber(value);
      if (number === undefined) mapped[parameter.name] = value;
      else mapped[parameter.name] = number;
      continue;
    }
    if (parameter.type === "boolean") {
      const flag = coerceBoolean(value);
      mapped[parameter.name] = flag === undefined ? value : flag;
      continue;
    }
    mapped[parameter.name] = parameter.name === "unit" ? normalizeUnitText(value) : value;
  }
  if (mapped.distance === undefined) {
    const split = splitDistance(pickAliasedValue(record, ARG_ALIASES.distance ?? ["distance"]));
    if (split.distance !== undefined) mapped.distance = split.distance;
    if (split.unit !== undefined && mapped.unit === undefined) mapped.unit = split.unit;
  }
  for (const key of Object.keys(record)) {
    if (tool.parameters.some((parameter) => parameter.name === key)) continue;
    if (isKnownArgAlias(key)) continue;
    mapped[key] = record[key];
  }
  return validateToolArguments(tool.name, mapped, registry, options);
}
