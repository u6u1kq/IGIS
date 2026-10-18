// SPDX-License-Identifier: Apache-2.0

import {
  isFileKey,
  isGeometryKey,
  looksLikeDatabaseDump,
  looksLikeFilePath,
  looksLikeGdalCommand,
  looksLikeShellCommand,
} from "@igis/ai-boundary";
import { looksLikeGeometryText } from "@igis/shared-types";

/**
 * 模型意图到本地操作请求。
 * 只接受操作名、图层标识、距离、单位和已有标量参数。
 * 文件系统、GDAL 和原始几何在这里拒绝，调用方不得再碰图层库。
 */

const OPERATIONS = new Set(["buffer", "intersect", "clip", "query", "stats"]);

const TOOL_OF: Readonly<Record<string, string>> = {
  buffer: "map.buffer",
  intersect: "map.intersect",
  clip: "map.clip",
  query: "map.query",
  stats: "map.stats",
};

const SCALAR_KEYS = new Set([
  "layerid",
  "otherlayerid",
  "distance",
  "unit",
  "outputname",
  "querykind",
  "attributefilter",
  "fieldname",
  "writeknowledge",
  "confirm",
  "visible",
  "place",
  "fill",
  "outline",
  "width",
  "opacity",
  "script",
  "layername",
]);

export type IntentCode = "filesystem-rejected" | "gdal-rejected" | "geometry-rejected" | "capability-rejected";

export interface OperationIntent {
  readonly kind: "operation";
  readonly tool: "map.buffer" | "map.intersect" | "map.clip" | "map.query" | "map.stats";
  readonly args: Readonly<Record<string, string | number | boolean>>;
}

export interface SummaryIntent {
  readonly kind: "summary";
}

export type TranslatedIntent =
  | { readonly ok: true; readonly intent: OperationIntent | SummaryIntent }
  | { readonly ok: false; readonly code: IntentCode; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPosition(value: readonly unknown[]): boolean {
  return value.length >= 2 && value.length <= 4 && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function isCoordinateNest(value: readonly unknown[]): boolean {
  if (isPosition(value)) return true;
  return value.length > 0 && value.every((item) => Array.isArray(item)) && value.some((item) => isCoordinateNest(item as unknown[]));
}

export function boundaryViolation(value: unknown): IntentCode | null {
  return walk(value, true);
}

function walk(value: unknown, top: boolean): IntentCode | null {
  if (typeof value === "string") {
    if (looksLikeGeometryText(value) || /\b(?:MULTI)?(?:POINT|LINESTRING|POLYGON|GEOMETRYCOLLECTION)(?:\s+[ZM]{1,2})?\s*\(/i.test(value)) return "geometry-rejected";
    if (looksLikeGdalPayload(value)) return "gdal-rejected";
    if (looksLikeShellPayload(value) || looksLikeJsPayload(value) || looksLikeLocalHttp(value)) return "capability-rejected";
    if (looksLikeDatabaseDump(value)) return "capability-rejected";
    if (looksLikeFilePath(value)) return "filesystem-rejected";
    return null;
  }
  if (Array.isArray(value)) {
    if (isCoordinateNest(value)) return "geometry-rejected";
    for (const item of value) {
      const hit = walk(item, false);
      if (hit) return hit;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const [key, item] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (!top && (lower === "operation" || lower === "tool" || lower === "args")) {
      const nested = walk(item, false);
      if (nested) return nested;
      continue;
    }
    if (lower === "operation" || lower === "tool" || lower === "args" || lower === "level") {
      const nested = walk(item, lower === "args");
      if (nested) return nested;
      continue;
    }
    if (isGeometryKey(key)) return "geometry-rejected";
    if (isFileKey(key)) return "filesystem-rejected";
    if (lower === "gdal" || lower === "ogr" || lower === "dataset") return "gdal-rejected";
    if (lower === "shell" || lower === "cmd" || lower === "command" || lower === "exec") return "capability-rejected";
    if (lower === "dump" || lower === "sql" || lower === "database") return "capability-rejected";
    const nested = walk(item, false);
    if (nested) return nested;
  }
  return null;
}

function looksLikeJsPayload(value: string): boolean {
  return /\b(?:eval|Function)\s*\(|\bnew\s+Function\b|\bjavascript\s*:/i.test(value);
}

function looksLikeLocalHttp(value: string): boolean {
  return /(?:https?|file):\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])|file:\/\//i.test(value);
}

function looksLikeGdalPayload(value: string): boolean {
  return looksLikeGdalCommand(value) || /\b(?:ogr2ogr|ogrinfo|gdal_translate|gdalwarp|gdalinfo|gdalbuildvrt)\b/i.test(value);
}

function looksLikeShellPayload(value: string): boolean {
  return looksLikeShellCommand(value) || /(?:^|[;&|`\n])\s*(?:powershell|cmd(?:\.exe)?|bash)\b/i.test(value);
}

function messageOf(code: IntentCode): string {
  if (code === "filesystem-rejected") return "模型不能读取或打开本地 GIS 文件。";
  if (code === "gdal-rejected") return "模型不能直接调用 GDAL。";
  if (code === "geometry-rejected") return "模型不能提交原始几何。";
  return "模型不能使用文件系统、外壳或数据库转储。";
}

function reject(code: IntentCode): TranslatedIntent {
  return { ok: false, code, message: messageOf(code) };
}

function scalarArgs(source: Record<string, unknown>): Readonly<Record<string, string | number | boolean>> | IntentCode {
  const args: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(source)) {
    const lower = key.toLowerCase();
    if (lower === "operation" || lower === "tool" || lower === "args" || lower === "level") continue;
    if (!SCALAR_KEYS.has(lower)) {
      if (isGeometryKey(key) || isFileKey(key)) return isFileKey(key) ? "filesystem-rejected" : "geometry-rejected";
      return "capability-rejected";
    }
    if (typeof item === "string") {
      const violation = boundaryViolation(item);
      if (violation) return violation;
      args[key] = item;
      continue;
    }
    if (typeof item === "number" && Number.isFinite(item)) {
      args[key] = item;
      continue;
    }
    if (typeof item === "boolean") {
      args[key] = item;
      continue;
    }
    if (item !== undefined && item !== null) return "capability-rejected";
  }
  return args;
}

function operationName(value: Record<string, unknown>): string {
  const operation = typeof value.operation === "string" ? value.operation.trim().toLowerCase() : "";
  if (operation !== "") return operation;
  const tool = typeof value.tool === "string" ? value.tool.trim().toLowerCase() : "";
  if (tool === "map.buffer" || tool === "run_buffer") return "buffer";
  if (tool === "map.intersect" || tool === "run_intersect") return "intersect";
  if (tool === "map.clip" || tool === "run_clip") return "clip";
  if (tool === "map.query" || tool === "query_features") return "query";
  if (tool === "map.stats" || tool === "summarize_layer") return "stats";
  if (tool === "map.list" || tool === "list_map_layers") return "summary";
  return operation;
}

/** 把模型意图收成操作请求或拒绝。这个函数不读取图层库。 */
export function translateAiIntent(value: unknown): TranslatedIntent {
  const violation = boundaryViolation(value);
  if (violation) return reject(violation);
  if (!isRecord(value)) return reject("capability-rejected");
  const name = operationName(value);
  if (name === "summary" || name === "list") return { ok: true, intent: { kind: "summary" } };
  if (looksLikeGdalCommand(name) || name.includes("gdal") || name.includes("ogr")) return reject("gdal-rejected");
  if (/^(readfile|read_file|readgis|io\.read|read_gis_file|map\.load|load_map_layer|fs\.read)$/.test(name)) return reject("filesystem-rejected");
  if (looksLikeShellPayload(name) || looksLikeJsPayload(name) || looksLikeLocalHttp(name)) return reject("capability-rejected");
  if (!OPERATIONS.has(name)) return reject("capability-rejected");
  const source = isRecord(value.args) ? { ...value, ...value.args } : value;
  const args = scalarArgs(source);
  if (typeof args === "string") return reject(args);
  const tool = TOOL_OF[name];
  if (tool !== "map.buffer" && tool !== "map.intersect" && tool !== "map.clip" && tool !== "map.query" && tool !== "map.stats") {
    return reject("capability-rejected");
  }
  return { ok: true, intent: { kind: "operation", tool, args } };
}
