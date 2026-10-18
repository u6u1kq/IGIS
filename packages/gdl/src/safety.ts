// SPDX-License-Identifier: Apache-2.0

const WKT_LITERAL = /\b(POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION)[ \t]*(\(|EMPTY\b)/i;
const GEOM_KEYWORD = /(^|[\s"])GEOM([\s"]|$)/i;
const COORDINATE_PAIR = /[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?[ \t]+[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?[ \t]*[,)]/;
const PAREN_NUMBER = /\([ \t]*[-+]?\.?\d/;

/** 文本里是否有几何字面量或坐标对。用于摘要自检和模型提交的 GDL。 */
export function findGeometryLiteral(text: string): string | null {
  if (GEOM_KEYWORD.test(text)) return "出现了 GEOM 几何字面量";
  if (WKT_LITERAL.test(text)) return "出现了 POINT/LINESTRING/POLYGON 等几何字面量";
  if (PAREN_NUMBER.test(text)) return "括号里出现了坐标数字";
  if (COORDINATE_PAIR.test(text)) return "出现了像坐标对的数字";
  return null;
}

export class GdlSummaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GdlSummaryError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function assertGdlSummarySafe(text: string): void {
  const hit = findGeometryLiteral(text);
  if (hit) throw new GdlSummaryError(`GDL 摘要不安全：${hit}，已拒绝。`);
}
