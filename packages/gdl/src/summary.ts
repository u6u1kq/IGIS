// SPDX-License-Identifier: Apache-2.0

import type { GdlProgram, GdlStylePatch } from "./ast.js";
import { assertGdlSummarySafe } from "./safety.js";
import { formatGdlName } from "./serialize.js";

const GEOMETRY_WORD: Readonly<Record<string, string>> = {
  point: "POINT",
  line: "LINE",
  polygon: "POLYGON",
  mixed: "MIXED",
};

function styleText(style: Readonly<GdlStylePatch>): string {
  const parts: string[] = [];
  if (style.fill !== undefined) parts.push(`fill ${style.fill}`);
  if (style.outline !== undefined) parts.push(`outline ${style.outline}`);
  if (style.width !== undefined) parts.push(`width ${style.width}`);
  if (style.opacity !== undefined) parts.push(`opacity ${style.opacity}`);
  if (style.visible !== undefined) parts.push(`visible ${style.visible ? "true" : "false"}`);
  if (style.order !== undefined) parts.push(`order ${style.order}`);
  return parts.join(" ");
}

/**
 * 解析结果的摘要。FEATURE 行换成 FEATURES 数量，属性值和几何字面量全部去掉。
 * 结果再过一遍 assertGdlSummarySafe。
 */
export function summarizeGdlProgram(program: GdlProgram): string {
  const lines = ["-- Igis GDL 摘要"];
  for (const statement of program.statements) {
    if (statement.kind === "layer") {
      lines.push(`LAYER ${formatGdlName(statement.name)}`);
      if (statement.geometry) lines.push(`  GEOMETRY ${GEOMETRY_WORD[statement.geometry] ?? "MIXED"}`);
      if (statement.crs) lines.push(`  CRS ${formatGdlName(statement.crs)}`);
      for (const field of statement.fields) lines.push(`  FIELD ${formatGdlName(field.name)} ${field.type}`);
      const style = styleText(statement.style);
      if (style) lines.push(`  STYLE ${style}`);
      lines.push(`  FEATURES ${statement.features.length > 0 ? statement.features.length : (statement.featureCountHint ?? 0)}`);
      lines.push("END");
    } else if (statement.kind === "style") {
      lines.push(`STYLE ${formatGdlName(statement.layer)} ${styleText(statement.style)}`);
    } else if (statement.kind === "buffer") {
      lines.push(`BUFFER ${formatGdlName(statement.input)} ${statement.distance} ${statement.unitText} AS ${formatGdlName(statement.output)}`);
    } else if (statement.kind === "intersect") {
      lines.push(`INTERSECT ${formatGdlName(statement.input)} WITH ${formatGdlName(statement.other)} AS ${formatGdlName(statement.output)}`);
    } else if (statement.kind === "query") {
      lines.push(`QUERY ${formatGdlName(statement.input)} WITH "${statement.filter.replace(/"/g, "'")}" AS ${formatGdlName(statement.output)}`);
    } else if (statement.kind === "stats") {
      lines.push(statement.field === null ? `STATS ${formatGdlName(statement.input)}` : `STATS ${formatGdlName(statement.input)} ON ${formatGdlName(statement.field)}`);
    } else if (statement.kind === "measure") {
      if (statement.measure === "distance") lines.push(`MEASURE DISTANCE ${formatGdlName(statement.input)} TO ${formatGdlName(statement.other ?? "")}`);
      else lines.push(`MEASURE ${statement.measure === "area" ? "AREA" : "LENGTH"} ${formatGdlName(statement.input)}`);
    } else {
      lines.push(`CLIP ${formatGdlName(statement.input)} BY ${formatGdlName(statement.other)} AS ${formatGdlName(statement.output)}`);
    }
  }
  lines.push("");
  const text = lines.join("\n");
  assertGdlSummarySafe(text);
  return text;
}
