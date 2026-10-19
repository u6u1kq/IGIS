// SPDX-License-Identifier: Apache-2.0

import type { Geometry } from "geojson";
import type { GdlFieldType, GdlScalar } from "./ast.js";
import { geometryToLiteral } from "./geometry.js";
import { assertGdlSummarySafe } from "./safety.js";

/** 写成 GDL 的图层来源。几何只在 features 里；摘要不读 features 的几何。 */
export interface GdlLayerSource {
  readonly name: string;
  readonly geometryKind: string;
  readonly crsLabel: string;
  readonly style: {
    readonly fill: string;
    readonly outline: string;
    readonly width: number;
    readonly opacity: number;
    readonly visible: boolean;
  } | null;
  readonly order: number | null;
  readonly features: readonly {
    readonly properties: Readonly<Record<string, GdlScalar>>;
    readonly geometry: Geometry;
  }[];
}

const BARE = /^[\p{L}\p{N}_][\p{L}\p{N}_.:\-]*$/u;
const RESERVED = new Set(["GEOM", "END", "AS", "WITH", "BY", "TRUE", "FALSE", "NULL"]);

export function quoteGdlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\r?\n/g, "\\n")}"`;
}

/** 简单名字直接写，含空格、标点或保留字时加引号。 */
export function formatGdlName(value: string): string {
  if (BARE.test(value) && !value.startsWith("--") && !RESERVED.has(value.toUpperCase())) return value;
  return quoteGdlString(value);
}

function formatScalar(value: GdlScalar): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  return quoteGdlString(value);
}

/** 按首次出现的顺序推断字段类型。混有数字和文字时记 TEXT。 */
export function inferGdlFieldTypes(features: GdlLayerSource["features"]): { readonly name: string; readonly type: GdlFieldType }[] {
  const order: string[] = [];
  const kinds = new Map<string, Set<string>>();
  for (const feature of features) {
    for (const [key, value] of Object.entries(feature.properties)) {
      if (key === "_fid") continue;
      if (!kinds.has(key)) {
        kinds.set(key, new Set());
        order.push(key);
      }
      if (value === null) continue;
      const set = kinds.get(key);
      if (!set) continue;
      if (typeof value === "number") set.add(Number.isInteger(value) ? "int" : "real");
      else set.add(typeof value);
    }
  }
  return order.map((name) => {
    const set = kinds.get(name) ?? new Set<string>();
    let type: GdlFieldType = "TEXT";
    if (set.size > 0 && [...set].every((item) => item === "int")) type = "INT";
    else if (set.size > 0 && [...set].every((item) => item === "int" || item === "real")) type = "REAL";
    else if (set.size === 1 && set.has("boolean")) type = "BOOL";
    return { name, type };
  });
}

function geometryKeyword(kind: string): string {
  if (kind === "point") return "POINT";
  if (kind === "line") return "LINE";
  if (kind === "polygon") return "POLYGON";
  return "MIXED";
}

function headerLines(source: GdlLayerSource, fields: readonly { name: string; type: GdlFieldType }[]): string[] {
  const lines = [
    `LAYER ${formatGdlName(source.name)}`,
    `  GEOMETRY ${geometryKeyword(source.geometryKind)}`,
    `  CRS ${formatGdlName(source.crsLabel)}`,
  ];
  for (const field of fields) lines.push(`  FIELD ${formatGdlName(field.name)} ${field.type}`);
  if (source.style) {
    lines.push(`  STYLE fill ${source.style.fill} outline ${source.style.outline} width ${source.style.width} opacity ${source.style.opacity} visible ${source.style.visible ? "true" : "false"}`);
  }
  if (source.order !== null) lines.push(`  STYLE order ${source.order}`);
  return lines;
}

function featureKey(name: string): string {
  return name.toUpperCase() === "GEOM" ? quoteGdlString(name) : formatGdlName(name);
}

/**
 * 图层写回 GDL 全文，包含几何字面量。只用于用户请求的导出文件或下载。
 * 几何集合在第一版里不支持，用注释记下序号后跳过。
 */
export function layerToGdl(source: GdlLayerSource): { readonly text: string; readonly omitted: number } {
  const fields = inferGdlFieldTypes(source.features);
  const lines = [
    "-- Igis GDL（地理描述语言）导出",
    ...headerLines(source, fields),
  ];
  let omitted = 0;
  source.features.forEach((feature, index) => {
    const literal = geometryToLiteral(feature.geometry);
    if (!literal) {
      omitted += 1;
      lines.push(`  -- 第 ${index + 1} 个要素是几何集合，GDL 第一版不支持，已省略。`);
      return;
    }
    const attributes = fields
      .filter((field) => Object.prototype.hasOwnProperty.call(feature.properties, field.name))
      .map((field) => `${featureKey(field.name)}=${formatScalar(feature.properties[field.name] ?? null)}`);
    lines.push(`  FEATURE ${attributes.length > 0 ? `${attributes.join(" ")} ` : ""}GEOM ${literal}`);
  });
  lines.push("END", "");
  return { text: lines.join("\n"), omitted };
}

/**
 * 图层的 GDL 摘要：图层名、几何类型、坐标系标签、字段名和类型、样式、要素数量。
 */
export function layerToGdlSummary(source: GdlLayerSource): string {
  const fields = inferGdlFieldTypes(source.features);
  const text = [
    "-- Igis GDL 摘要",
    ...headerLines(source, fields),
    `  FEATURES ${source.features.length}`,
    "END",
    "",
  ].join("\n");
  assertGdlSummarySafe(text);
  return text;
}
