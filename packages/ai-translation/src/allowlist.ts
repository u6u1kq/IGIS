// SPDX-License-Identifier: Apache-2.0

import { isFileKey, isGeometryKey, looksLikeFilePath, isSensitiveFieldName, projectFieldNames } from "@igis/ai-boundary";
import { looksLikeGeometryText } from "@igis/shared-types";

/**
 * 交给模型的唯一投影。默认拒绝。
 * 只保留当前工具协议已经在用的操作名、图层标识、数量、类型、距离、单位、
 * 已有标量参数、非几何的计划状态和安全校验消息。
 * 坐标系只放行 crsLabel 标签字符串。坐标、WKT、范围、路径、检索自由文本和记忆自由文本不在这份名单里。
 * 字段分级（V0.89 起）：字段名单可见（敏感字段名黑名单过滤），属性值只出聚合。
 * 不另做一套执行器，也不把运行时对象原样 JSON.stringify 给模型。
 */

const ALLOWED = new Set([
  "model",
  "messages",
  "tools",
  "tool_choice",
  "role",
  "content",
  "name",
  "tool_calls",
  "tool_call_id",
  "function",
  "arguments",
  "type",
  "description",
  "parameters",
  "properties",
  "required",
  "additionalproperties",
  "items",
  "enum",
  "id",
  "instruction",
  "originaltext",
  "priorinstruction",
  "dialogue",
  "recentresults",
  "pendingsummary",
  "notes",
  "reminder",
  "partialentities",
  "intentfragments",
  "layercandidates",
  "numbers",
  "selectedlayer",
  "maplayers",
  "metadata",
  "style",
  "mode",
  "ramp",
  "operation",
  "operationtype",
  "tool",
  "level",
  "layerid",
  "layername",
  "otherlayerid",
  "otherlayername",
  "outputname",
  "sourcelayerid",
  "sourcelayername",
  "geometrytype",
  "geometrykind",
  "featurecount",
  "distance",
  "unit",
  "querykind",
  "attributefilter",
  "fieldname",
  "writeknowledge",
  "visible",
  "place",
  "fill",
  "outline",
  "width",
  "opacity",
  "order",
  "status",
  "operationid",
  "message",
  "code",
  "ok",
  "action",
  "availableoperations",
  "relations",
  "layers",
  "candidates",
  "query",
  "durationms",
  "cached",
  "minimum",
  "maximum",
  "mean",
  "sum",
  "rmse",
  "mae",
  "heldout",
  "accuracy",
  "kappa",
  "classifier",
  "cvaccuracy",
  "pathcost",
  "tolerance",
  "aicc",
  "bandwidth",
  "r2",
  "beta",
  "epsilon",
  "iterations",
  "msdr",
  "variogram",
  "range",
  "sill",
  "nugget",
  "streamarea",
  "snapdistance",
  "length",
  "ascent",
  "descent",
  "cut",
  "net",
  "script",
  "confirm",
  "scalarargs",
  "memoryhandles",
  "fieldnames",
  "crslabel",
  "crskind",
  "linearunit",
  "features",
  "geometry",
  "coordinates",
  "type",
  "properties",
]);

const LOCAL_DATA_MESSAGE = "本地数据暂时无法访问。";

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

function payloadHasLeak(value: unknown, ordinaryGeometry = false): boolean {
  if (typeof value === "string") return textHasLeak(value);
  if (Array.isArray(value)) {
    if (!ordinaryGeometry && isCoordinateNest(value)) return true;
    return value.some((item) => payloadHasLeak(item, ordinaryGeometry));
  }
  if (!isRecord(value)) return false;
  for (const [key, item] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (isFileKey(key) || lower === "bbox" || lower === "extent" || lower === "crs") return true;
    if (!ordinaryGeometry && isGeometryKey(key)) return true;
    if (payloadHasLeak(item, ordinaryGeometry)) return true;
  }
  return false;
}

function textHasLeak(value: string): boolean {
  if (looksLikeGeometryText(value) || looksLikeFilePath(value)) return true;
  if (/\b(?:MULTI)?(?:POINT|LINESTRING|POLYGON|GEOMETRYCOLLECTION)(?:\s+[ZM]{1,2})?\s*\(/i.test(value)) return true;
  if (/"coordinates"\s*:/.test(value) || /"bbox"\s*:/.test(value) || /"wkt"\s*:/.test(value) || /"wkb"\s*:/.test(value)) return true;
  if (/(?:^|[\s"'=])[A-Za-z]:\\/.test(value) || /\/Users\//.test(value) || /\\\\[A-Za-z0-9_.$ -]/.test(value)) return true;
  if (/\.(?:shp|shx|dbf|geojson|gdb|gpkg|tif|tiff|kml|gml|fgb)\b/i.test(value)) return true;
  if (/\b(?:00|01)[0-9A-Fa-f]{20,}\b/.test(value)) return true;
  if (/https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0)|file:\/\//i.test(value)) return true;
  return false;
}

function isLocalDataFailure(code: string, message: string): boolean {
  if (code === "ENOENT") return true;
  if (/ENOENT/i.test(message)) return true;
  if (looksLikeFilePath(message)) return true;
  if (/[A-Za-z]:\\/.test(message) || /\/Users\//.test(message)) return true;
  return false;
}

function rewriteLocalData(value: Record<string, unknown>): Record<string, unknown> {
  const message = typeof value.message === "string" ? value.message : "";
  const code = typeof value.code === "string" ? value.code : "";
  if (!isLocalDataFailure(code, message)) return value;
  const referred = referText(message);
  const onlyPointer = referred === "" || referred === "当前图层" || referred === "这些点";
  if (code === "ENOENT" || /ENOENT/i.test(message) || onlyPointer) {
    return { ...value, ok: false, code: "LOCAL_DATA_ACCESS_ERROR", message: LOCAL_DATA_MESSAGE };
  }
  return { ...value, message: referred };
}

function balancedObject(text: string, start: number): { readonly end: number } | null {
  if (text[start] !== "{" && text[start] !== "[") return null;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (char === "\\") {
        escape = true;
        continue;
      }
      if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return { end: index + 1 };
    }
  }
  return null;
}

function stripEmbeddedLeaks(text: string): string {
  let result = "";
  let index = 0;
  while (index < text.length) {
    const objectAt = text.indexOf("{", index);
    const arrayAt = text.indexOf("[", index);
    let start = -1;
    if (objectAt >= 0 && (arrayAt < 0 || objectAt < arrayAt)) start = objectAt;
    else if (arrayAt >= 0) start = arrayAt;
    if (start < 0) {
      result += text.slice(index);
      break;
    }
    result += text.slice(index, start);
    const span = balancedObject(text, start);
    if (!span) {
      result += text[start];
      index = start + 1;
      continue;
    }
    const slice = text.slice(start, span.end);
    let leaked = textHasLeak(slice);
    if (!leaked) {
      try {
        leaked = payloadHasLeak(JSON.parse(slice) as unknown);
      } catch {
        leaked = false;
      }
    }
    result += leaked ? "这些点" : slice;
    index = span.end;
  }
  return result;
}

function stripWkt(text: string): string {
  const pattern = /\b(?:MULTI)?(?:POINT|LINESTRING|POLYGON|GEOMETRYCOLLECTION)(?:\s+[ZM]{1,2})?\s*\(/gi;
  let result = "";
  let index = 0;
  while (index < text.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(text);
    if (!match || match.index < index) {
      result += text.slice(index);
      break;
    }
    result += text.slice(index, match.index);
    result += "这些点";
    const paren = match.index + match[0].length - 1;
    let depth = 0;
    let end = paren;
    for (let cursor = paren; cursor < text.length; cursor += 1) {
      const char = text[cursor];
      if (char === "(") depth += 1;
      else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          end = cursor;
          break;
        }
      }
    }
    index = end + 1;
  }
  return result;
}

/** 坐标和路径换成称呼，句子其余部分留着。数字本身不出现。 */
function referText(text: string): string {
  return stripWkt(stripEmbeddedLeaks(text))
    .replace(/(?:经度|纬度|longitude|latitude)\s*[:：=]?\s*-?\d+(?:\.\d+)?(?:\s*[°度])?/gi, "这些点")
    .replace(/(?<![\d.])-?\d{1,3}\.\d+\s*[,，]\s*-?\d{1,3}\.\d+(?![\d.])/g, "这些点")
    .replace(/(?<![\d.])-?\d{1,3}\.\d+\s*°/g, "这些点")
    .replace(/\[\s*-?\d+(?:\.\d+)?(?:\s*,\s*-?\d+(?:\.\d+)?){1,3}\s*\]/g, "这些点")
    .replace(/[A-Za-z]:\\[^\s"'`,}\]]+/g, "当前图层")
    .replace(/[A-Za-z]:\/[^\s"'`,}\]]+/g, "当前图层")
    .replace(/\\\\[^\s"'`,}\]]+/g, "当前图层")
    .replace(/(?:\/Users\/|\/home\/|file:\/\/)[^\s"'`,}\]]+/g, "当前图层")
    .replace(/\b[\w.-]+\.(?:shp|shx|dbf|geojson|gdb|gpkg|tif|tiff|kml|gml|fgb)\b/gi, "当前图层")
    .replace(/\b(?:00|01)[0-9A-Fa-f]{20,}\b/g, "这些点")
    .replace(/https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0)(?::\d+)?[^\s"'`]*/gi, "当前图层")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * 斜杠、反斜杠和连续句点会让整句被当成路径。
 * 先把看起来像路径的片段换成称呼，再去掉剩下的分隔符，句子留着。
 */
function salvageSentence(text: string): string {
  return text
    .replace(/\b[\w.-]*(?:[\\/][\w.-]*)+/g, "当前图层")
    .replace(/\.{2,}/g, " ")
    .replace(/[\\/]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** 称呼替换之后如果还像路径，再抢救一次句子。仍然含坐标或路径才丢掉。 */
function projectProse(value: string): string | undefined {
  const scrubbed = referText(value);
  if (scrubbed !== "" && !textHasLeak(scrubbed)) return scrubbed;
  const saved = referText(salvageSentence(scrubbed));
  if (saved === "" || textHasLeak(saved)) return undefined;
  return saved;
}

function projectString(value: string, ordinaryGeometry = false): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length <= 200_000) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed !== null && typeof parsed === "object") {
        const projected = projectForModel(parsed, { ordinaryGeometry });
        if (projected === undefined) return undefined;
        const text = JSON.stringify(projected);
        if (!textHasLeak(text)) return text;
        return projectProse(text);
      }
    } catch {
      // 混在句子里的几何片段下面按文本换成称呼。
    }
  }
  return projectProse(value);
}

function projectValue(value: unknown, parentKey: string, ordinaryGeometry = false): unknown {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return projectString(value, ordinaryGeometry);
  if (Array.isArray(value)) {
    // numbers 只放行扁平数字列表（统计摘要里的数量、距离）。嵌套数组是坐标结构，递归也不放行。
    if (parentKey === "numbers") {
      return value.every((item) => typeof item === "number" && Number.isFinite(item)) ? [...value] : undefined;
    }
    if (!ordinaryGeometry && (isCoordinateNest(value) || isPosition(value))) return undefined;
    const items: unknown[] = [];
    for (const item of value) {
      const projected = projectValue(item, parentKey, ordinaryGeometry);
      if (projected !== undefined) items.push(projected);
    }
    return items;
  }
  if (isRecord(value)) return projectObject(rewriteLocalData(value), ordinaryGeometry);
  return undefined;
}

function projectObject(value: Record<string, unknown>, ordinaryGeometry = false): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (!ALLOWED.has(lower)) continue;
    // 字段分级（V0.89）：字段名单可见但过敏感黑名单；单个字段名命中黑名单时不放行。
    if (lower === "fieldnames") {
      if (Array.isArray(item)) {
        const kept = projectFieldNames(item.filter((entry): entry is string => typeof entry === "string"));
        if (kept.length > 0) out[key] = [...kept];
      }
      continue;
    }
    if (lower === "fieldname" && typeof item === "string" && isSensitiveFieldName(item)) continue;
    const projected = projectValue(item, lower, ordinaryGeometry);
    if (projected !== undefined) out[key] = projected;
  }
  return out;
}

/** 模型可见载荷。默认丢掉几何。ordinaryGeometry 为真时保留普通坐标，路径和范围仍然丢掉。 */
export function projectForModel(value: unknown, options?: { readonly ordinaryGeometry?: boolean }): unknown {
  return projectValue(value, "", options?.ordinaryGeometry === true);
}

/**
 * 出站判断和实际替换用同一套规则。
 * changed 为真时，发给模型的句子会变成 scrubbed。
 */
export function assessOutbound(text: string): { readonly changed: boolean; readonly scrubbed: string } {
  const trimmed = text.trim();
  const scrubbed = referText(trimmed);
  return { changed: scrubbed !== trimmed, scrubbed };
}
