// SPDX-License-Identifier: Apache-2.0

import type { Geometry, Position } from "geojson";
import type { GdlDiagnostic, GdlToken } from "./lexer.js";

/**
 * GDL 的几何字面量：WKT 的一个子集，只写在 FEATURE ... GEOM 之后，必须在同一行写完。
 * POINT (x y)
 * LINESTRING (x y, x y, ...)
 * POLYGON ((x y, ...), (x y, ...))
 * MULTIPOINT (x y, ...) 或 MULTIPOINT ((x y), ...)
 * MULTILINESTRING ((x y, ...), ...)
 * MULTIPOLYGON (((x y, ...)), ...)
 * 任何类型后面写 EMPTY 表示空几何。
 */
export const GDL_GEOMETRY_KEYWORDS = ["POINT", "LINESTRING", "POLYGON", "MULTIPOINT", "MULTILINESTRING", "MULTIPOLYGON"] as const;

type GeometryKeyword = (typeof GDL_GEOMETRY_KEYWORDS)[number];

const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

class GeometryCursor {
  index: number;

  constructor(private readonly tokens: readonly GdlToken[], start: number, private readonly lineEndColumn: number) {
    this.index = start;
  }

  peek(): GdlToken | undefined {
    return this.tokens[this.index];
  }

  column(): number {
    return this.peek()?.column ?? this.lineEndColumn;
  }

  take(): GdlToken | undefined {
    const token = this.tokens[this.index];
    this.index += 1;
    return token;
  }

  done(): boolean {
    return this.index >= this.tokens.length;
  }
}

class GeometryFailure extends Error {
  constructor(readonly column: number, message: string) {
    super(message);
  }
}

function expect(cursor: GeometryCursor, kind: GdlToken["kind"], label: string): GdlToken {
  const token = cursor.peek();
  if (!token || token.kind !== kind) {
    throw new GeometryFailure(cursor.column(), token ? `这里应为${label}，实际是“${token.text}”。` : `几何字面量没写完，缺少${label}。`);
  }
  cursor.take();
  return token;
}

function readPosition(cursor: GeometryCursor): Position {
  const values: number[] = [];
  while (values.length < 4) {
    const token = cursor.peek();
    if (!token || token.kind !== "word" || !NUMBER.test(token.text)) break;
    cursor.take();
    const value = Number(token.text);
    if (!Number.isFinite(value)) throw new GeometryFailure(token.column, "坐标不是有限数字。");
    values.push(value);
  }
  if (values.length < 2) {
    const token = cursor.peek();
    throw new GeometryFailure(cursor.column(), token ? `坐标至少要两个数字，这里遇到“${token.text}”。` : "坐标至少要两个数字。");
  }
  if (values.length > 3) throw new GeometryFailure(cursor.column(), "一个坐标最多三个数字。");
  return values;
}

function readList<T>(cursor: GeometryCursor, item: () => T): T[] {
  expect(cursor, "lparen", "左括号 (");
  const items: T[] = [item()];
  while (cursor.peek()?.kind === "comma") {
    cursor.take();
    items.push(item());
  }
  expect(cursor, "rparen", "右括号 )");
  return items;
}

function readPositions(cursor: GeometryCursor): Position[] {
  return readList(cursor, () => readPosition(cursor));
}

function readMultiPoint(cursor: GeometryCursor): Position[] {
  expect(cursor, "lparen", "左括号 (");
  const items: Position[] = [];
  const one = (): void => {
    if (cursor.peek()?.kind === "lparen") {
      cursor.take();
      items.push(readPosition(cursor));
      expect(cursor, "rparen", "右括号 )");
    } else {
      items.push(readPosition(cursor));
    }
  };
  one();
  while (cursor.peek()?.kind === "comma") {
    cursor.take();
    one();
  }
  expect(cursor, "rparen", "右括号 )");
  return items;
}

function emptyGeometry(keyword: GeometryKeyword): Geometry {
  const type = keyword === "POINT"
    ? "Point"
    : keyword === "LINESTRING"
      ? "LineString"
      : keyword === "POLYGON"
        ? "Polygon"
        : keyword === "MULTIPOINT"
          ? "MultiPoint"
          : keyword === "MULTILINESTRING"
            ? "MultiLineString"
            : "MultiPolygon";
  return { type, coordinates: [] } as unknown as Geometry;
}

/**
 * 从 start 开始读一个几何字面量，必须读到行尾。
 * 出错时写入 diagnostics 并返回 null。
 */
export function parseGeometryLiteral(tokens: readonly GdlToken[], start: number, line: number, lineEndColumn: number, diagnostics: GdlDiagnostic[]): Geometry | null {
  const cursor = new GeometryCursor(tokens, start, lineEndColumn);
  try {
    const head = cursor.take();
    if (!head || head.kind !== "word") throw new GeometryFailure(lineEndColumn, "GEOM 后面缺少几何类型，例如 POINT、LINESTRING、POLYGON。");
    const keyword = head.text.toUpperCase() as GeometryKeyword;
    if (!(GDL_GEOMETRY_KEYWORDS as readonly string[]).includes(keyword)) {
      throw new GeometryFailure(head.column, `不认识的几何类型“${head.text}”。可用：${GDL_GEOMETRY_KEYWORDS.join("、")}。`);
    }
    let geometry: Geometry;
    if (cursor.peek()?.kind === "word" && cursor.peek()?.text.toUpperCase() === "EMPTY") {
      cursor.take();
      geometry = emptyGeometry(keyword);
    } else if (keyword === "POINT") {
      expect(cursor, "lparen", "左括号 (");
      const position = readPosition(cursor);
      expect(cursor, "rparen", "右括号 )");
      geometry = { type: "Point", coordinates: position };
    } else if (keyword === "LINESTRING") {
      geometry = { type: "LineString", coordinates: readPositions(cursor) };
    } else if (keyword === "MULTIPOINT") {
      geometry = { type: "MultiPoint", coordinates: readMultiPoint(cursor) };
    } else if (keyword === "POLYGON") {
      geometry = { type: "Polygon", coordinates: readList(cursor, () => readPositions(cursor)) };
    } else if (keyword === "MULTILINESTRING") {
      geometry = { type: "MultiLineString", coordinates: readList(cursor, () => readPositions(cursor)) };
    } else {
      geometry = { type: "MultiPolygon", coordinates: readList(cursor, () => readList(cursor, () => readPositions(cursor))) };
    }
    if (!cursor.done()) {
      const extra = cursor.peek();
      throw new GeometryFailure(extra?.column ?? lineEndColumn, `几何字面量后面多了“${extra?.text ?? ""}”。`);
    }
    return geometry;
  } catch (error) {
    if (error instanceof GeometryFailure) {
      diagnostics.push({ line, column: error.column, message: error.message });
      return null;
    }
    diagnostics.push({ line, column: lineEndColumn, message: "几何字面量无法解析。" });
    return null;
  }
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(Number(value.toFixed(8)));
}

function formatPosition(position: Position): string {
  return position.slice(0, 3).map((value) => formatNumber(value)).join(" ");
}

function formatPositions(positions: readonly Position[]): string {
  return `(${positions.map(formatPosition).join(", ")})`;
}

/** 把 GeoJSON 几何写成 GDL 字面量。几何集合不支持，返回 null。 */
export function geometryToLiteral(geometry: Geometry): string | null {
  switch (geometry.type) {
    case "Point":
      return geometry.coordinates.length === 0 ? "POINT EMPTY" : `POINT (${formatPosition(geometry.coordinates)})`;
    case "LineString":
      return geometry.coordinates.length === 0 ? "LINESTRING EMPTY" : `LINESTRING ${formatPositions(geometry.coordinates)}`;
    case "MultiPoint":
      return geometry.coordinates.length === 0 ? "MULTIPOINT EMPTY" : `MULTIPOINT ${formatPositions(geometry.coordinates)}`;
    case "Polygon":
      return geometry.coordinates.length === 0 ? "POLYGON EMPTY" : `POLYGON (${geometry.coordinates.map(formatPositions).join(", ")})`;
    case "MultiLineString":
      return geometry.coordinates.length === 0 ? "MULTILINESTRING EMPTY" : `MULTILINESTRING (${geometry.coordinates.map(formatPositions).join(", ")})`;
    case "MultiPolygon":
      return geometry.coordinates.length === 0
        ? "MULTIPOLYGON EMPTY"
        : `MULTIPOLYGON (${geometry.coordinates.map((polygon) => `(${polygon.map(formatPositions).join(", ")})`).join(", ")})`;
    default:
      return null;
  }
}
