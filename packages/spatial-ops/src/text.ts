// SPDX-License-Identifier: Apache-2.0

import { omitCoordinateParameter } from "@igis/provenance";
import type { SpatialAuditParameters } from "@igis/provenance";
import { SpatialOpError } from "./errors.js";
import type { DistanceUnit, QueryKind, ScalarProps } from "./types.js";

const COORDINATE_FIELD = /^(x|y|z|lat|lon|lng|latitude|longitude|easting|northing|经度|纬度|坐标)$/i;

const UNITS: Readonly<Record<string, DistanceUnit>> = {
  meters: "meters",
  meter: "meters",
  m: "meters",
  米: "meters",
  kilometers: "kilometers",
  kilometer: "kilometers",
  km: "kilometers",
  千米: "kilometers",
  公里: "kilometers",
  miles: "miles",
  mile: "miles",
  英里: "miles",
  feet: "feet",
  foot: "feet",
  英尺: "feet",
  degrees: "degrees",
  degree: "degrees",
  度: "degrees",
};

export function normalizeUnit(value: string): DistanceUnit {
  const unit = UNITS[value.trim().toLowerCase()] ?? UNITS[value.trim()];
  if (!unit) throw new SpatialOpError("不认识这个距离单位。请用米、千米、英里、英尺或度。");
  return unit;
}

export function assertDistance(distance: number, unit: DistanceUnit): void {
  if (!Number.isFinite(distance) || distance <= 0) {
    throw new SpatialOpError("缓冲距离必须是大于 0 的数。");
  }
  const cap = unit === "degrees" ? 180 : unit === "kilometers" ? 20000 : 10_000_000;
  if (distance > cap) throw new SpatialOpError("缓冲距离太大，已拒绝。");
}

export function normalizeQueryKind(value: string): QueryKind {
  const text = value.trim().toLowerCase();
  if (text === "attribute" || value.trim() === "属性" || value.trim() === "属性筛选") return "attribute";
  if (text === "point-in-polygon" || value.trim() === "点在面内" || value.trim() === "点在面") return "point-in-polygon";
  if (text === "intersects" || value.trim() === "相交") return "intersects";
  throw new SpatialOpError("查询种类只能是属性筛选、点在面内或相交。");
}

export function isCoordinateField(name: string): boolean {
  return COORDINATE_FIELD.test(name.trim());
}

/** 图层名。 */
export function safeLayerName(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return "未命名图层";
  return trimmed.slice(0, 80);
}

export function safeModelName(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return "local-mock";
  return trimmed.slice(0, 120);
}

/** 属性筛选原文。 */
export function safeAttributeFilter(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") throw new SpatialOpError("属性筛选不能为空。");
  return trimmed;
}

export function auditParameters(input: {
  readonly distance?: number;
  readonly unit?: string;
  readonly attributeFilter?: string;
  readonly queryKind?: string;
  readonly target?: string;
  readonly tolerance?: number;
  readonly groupField?: string;
  readonly fieldName?: string;
  readonly mapping?: string;
  readonly columns?: number;
  readonly rows?: number;
  readonly limit?: number;
}): SpatialAuditParameters {
  const parameters: {
    distance?: number; unit?: string; attributeFilter?: string; queryKind?: string;
    target?: string; tolerance?: number; groupField?: string; fieldName?: string; mapping?: string; columns?: number; rows?: number; limit?: number;
  } = {};
  if (typeof input.distance === "number" && Number.isFinite(input.distance)) parameters.distance = input.distance;
  if (typeof input.tolerance === "number" && Number.isFinite(input.tolerance)) parameters.tolerance = input.tolerance;
  if (typeof input.columns === "number" && Number.isFinite(input.columns)) parameters.columns = input.columns;
  if (typeof input.rows === "number" && Number.isFinite(input.rows)) parameters.rows = input.rows;
  if (typeof input.limit === "number" && Number.isFinite(input.limit)) parameters.limit = input.limit;
  for (const key of ["unit", "attributeFilter", "queryKind", "target", "groupField", "fieldName", "mapping"] as const) {
    const kept = omitCoordinateParameter(input[key]);
    if (kept) parameters[key] = kept;
  }
  return parameters;
}

export function numericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * 属性比较只认一种类型规则，= 与 != 互为否定，不能同时为真。
 * 属性值本身是有限数字时才是数字；字符串保持字符串，不把 "10.0" 收成 10。
 * 筛选文字只有在属性已是数字、且文字能无损还原成同一写法时才当作数字（"10" 可以，"10.0" 不行）。
 * 缺失、null、空字符串是同一种空值。空值等于空值；空值不等于非空。
 * 类型不同时 = 为 false，!= 为 true。
 * > >= < <= 只在两边都是数字时比较，否则为 false。
 * ~ 仍是子串包含，按文字形式查找，不参与数字换算。
 */
type Compared =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "empty" };

function propertyCompared(value: unknown): Compared {
  if (value === null || value === undefined) return { kind: "empty" };
  if (typeof value === "number") return Number.isFinite(value) ? { kind: "number", value } : { kind: "empty" };
  if (typeof value === "boolean") return { kind: "boolean", value };
  if (typeof value === "string") {
    const text = value.trim();
    return text === "" ? { kind: "empty" } : { kind: "string", value: text };
  }
  return { kind: "empty" };
}

/** 不能把 "10.0"、"01" 收成另一个数字。只有 String(数值) 与原文一致才算数字。 */
function canonicalNumberLiteral(text: string): number | null {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || String(value) !== text) return null;
  return value;
}

function filterCompared(raw: string, left: Compared): Compared {
  const text = raw.trim();
  if (text === "") return { kind: "empty" };
  if (left.kind === "number") {
    const value = canonicalNumberLiteral(text);
    if (value !== null) return { kind: "number", value };
  }
  return { kind: "string", value: text };
}

function valuesEqual(left: Compared, right: Compared): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "empty") return true;
  if (left.kind === "number" && right.kind === "number") return left.value === right.value;
  if (left.kind === "string" && right.kind === "string") return left.value === right.value;
  if (left.kind === "boolean" && right.kind === "boolean") return left.value === right.value;
  return false;
}

function textOf(value: Compared): string {
  if (value.kind === "string") return value.value;
  if (value.kind === "number") return String(value.value);
  if (value.kind === "boolean") return value.value ? "true" : "false";
  return "";
}

export function matchAttribute(properties: ScalarProps, filter: string): boolean {
  const matched = /^([\p{L}\p{N}_]+)\s*(>=|<=|!=|=|>|<|~)\s*(.*)$/u.exec(filter.trim());
  const field = matched?.[1];
  const op = matched?.[2];
  const raw = matched?.[3] ?? "";
  if (!field || !op) throw new SpatialOpError("属性筛选格式应为 字段=值、字段>数字 或 字段~文字。");
  const left = propertyCompared(properties[field]);
  if (op === "~") return textOf(left).includes(raw.trim());
  const right = filterCompared(raw, left);
  if (op === "=") return valuesEqual(left, right);
  if (op === "!=") return !valuesEqual(left, right);
  if (left.kind !== "number" || right.kind !== "number") return false;
  if (op === ">") return left.value > right.value;
  if (op === ">=") return left.value >= right.value;
  if (op === "<") return left.value < right.value;
  return left.value <= right.value;
}

function visibleOperation(operationType: string): string {
  if (operationType === "buffer") return "run_buffer";
  if (operationType === "intersect") return "run_intersect";
  if (operationType === "clip") return "run_clip";
  if (operationType === "spatial-query") return "query_features";
  if (operationType === "stats") return "summarize_layer";
  return operationType;
}

/** 一条 sqlite-vec 摘要：运算、图层名、字段名。 */
export function ragSummary(
  layerName: string,
  operationType: string,
  featureCount: number,
  fieldNames: readonly string[],
  layerNames: readonly string[] = [],
): { readonly title: string; readonly body: string; readonly layerNames: readonly string[] } | null {
  const names = [...new Set((layerNames.length > 0 ? layerNames : [layerName]).map((name) => name.trim()).filter((name) => name !== ""))];
  const shown = names.length > 0 ? names : ["图层"];
  const op = visibleOperation(operationType);
  const fields = fieldNames.filter((name) => name !== "_fid").join("、");
  const body = [`图层 ${shown.join("、")}`, `操作 ${op}`, `要素数量 ${featureCount}`, `字段 ${fields || "无"}`].join("\n");
  return { title: `${shown.join("、")} ${op} 摘要`, body, layerNames: shown };
}
