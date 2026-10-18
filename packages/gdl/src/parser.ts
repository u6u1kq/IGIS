// SPDX-License-Identifier: Apache-2.0

import type {
  GdlFeature,
  GdlField,
  GdlFieldType,
  GdlGeometryKind,
  GdlLayerStatement,
  GdlProgram,
  GdlScalar,
  GdlStatement,
  GdlStylePatch,
  GdlUnit,
} from "./ast.js";
import { parseGeometryLiteral } from "./geometry.js";
import { tokenize } from "./lexer.js";
import type { GdlDiagnostic, GdlLine, GdlToken } from "./lexer.js";

export const GDL_TEXT_LIMIT = 1024 * 1024;
const ERROR_CAP = 50;
const NAME_LIMIT = 80;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const UNIT_ALIASES: Readonly<Record<string, GdlUnit>> = {
  m: "meters",
  meter: "meters",
  meters: "meters",
  metre: "meters",
  metres: "meters",
  米: "meters",
  km: "kilometers",
  kilometer: "kilometers",
  kilometers: "kilometers",
  千米: "kilometers",
  公里: "kilometers",
  mi: "miles",
  mile: "miles",
  miles: "miles",
  英里: "miles",
  ft: "feet",
  foot: "feet",
  feet: "feet",
  英尺: "feet",
  deg: "degrees",
  degree: "degrees",
  degrees: "degrees",
  度: "degrees",
};

const GEOMETRY_KINDS: Readonly<Record<string, GdlGeometryKind>> = {
  POINT: "point",
  LINE: "line",
  POLYGON: "polygon",
  MIXED: "mixed",
};

const FIELD_TYPES: readonly GdlFieldType[] = ["TEXT", "INT", "REAL", "BOOL"];

export interface GdlParseResult {
  readonly ok: boolean;
  readonly program: GdlProgram;
  readonly errors: readonly GdlDiagnostic[];
}

export class GdlSyntaxError extends Error {
  readonly diagnostics: readonly GdlDiagnostic[];

  constructor(diagnostics: readonly GdlDiagnostic[]) {
    const first = diagnostics[0];
    super(first ? `GDL 第 ${first.line} 行第 ${first.column} 列：${first.message}` : "GDL 语法错误。");
    this.name = "GdlSyntaxError";
    this.diagnostics = diagnostics;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface AttributeMark {
  readonly key: string;
  readonly value: GdlScalar;
  readonly line: number;
  readonly column: number;
}

interface OpenLayer {
  readonly line: number;
  readonly column: number;
  readonly name: string;
  geometry: GdlGeometryKind | null;
  crs: string | null;
  readonly fields: GdlField[];
  readonly style: GdlStylePatch;
  readonly features: GdlFeature[];
  readonly marks: AttributeMark[][];
  featureCountHint: number | null;
}

function upper(token: GdlToken | undefined): string {
  return token && token.kind === "word" ? token.text.toUpperCase() : "";
}

function lineEnd(line: GdlLine): number {
  const last = line.tokens[line.tokens.length - 1];
  return last ? last.column + Math.max(1, last.text.length) : 1;
}

export function normalizeGdlUnit(text: string): GdlUnit | null {
  return UNIT_ALIASES[text.trim().toLowerCase()] ?? UNIT_ALIASES[text.trim()] ?? null;
}

function normalizeColor(text: string): string | null {
  if (!COLOR.test(text)) return null;
  if (text.length === 4) {
    const [, r = "0", g = "0", b = "0"] = text;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return text.toLowerCase();
}

class Parser {
  readonly errors: GdlDiagnostic[] = [];
  readonly statements: GdlStatement[] = [];
  private open: OpenLayer | null = null;
  private readonly layerNames = new Map<string, number>();

  error(line: number, column: number, message: string): void {
    if (this.errors.length < ERROR_CAP) this.errors.push({ line, column, message });
  }

  name(line: GdlLine, index: number, label: string): string | null {
    const token = line.tokens[index];
    if (!token || (token.kind !== "word" && token.kind !== "string")) {
      this.error(line.line, token?.column ?? lineEnd(line), `缺少${label}。`);
      return null;
    }
    const value = token.text.trim();
    if (value === "") {
      this.error(line.line, token.column, `${label}不能为空。`);
      return null;
    }
    if (value.length > NAME_LIMIT) {
      this.error(line.line, token.column, `${label}太长，最多 ${NAME_LIMIT} 个字符。`);
      return null;
    }
    return value;
  }

  noExtra(line: GdlLine, from: number): void {
    const extra = line.tokens[from];
    if (extra) this.error(line.line, extra.column, `这一行多了“${extra.text}”。`);
  }

  number(line: GdlLine, index: number, label: string): number | null {
    const token = line.tokens[index];
    if (!token || token.kind !== "word" || !NUMBER.test(token.text)) {
      this.error(line.line, token?.column ?? lineEnd(line), `${label}应为数字。`);
      return null;
    }
    return Number(token.text);
  }

  /** STYLE 的属性对：fill #rrggbb、outline #rrggbb、width 数字、opacity 0-1、visible true/false、order 正整数。 */
  stylePairs(line: GdlLine, start: number): GdlStylePatch | null {
    const patch: GdlStylePatch = {};
    let index = start;
    if (!line.tokens[index]) {
      this.error(line.line, lineEnd(line), "STYLE 后面缺少样式属性，例如 fill #2f6f5e。");
      return null;
    }
    let ok = true;
    while (index < line.tokens.length) {
      const keyToken = line.tokens[index];
      const valueToken = line.tokens[index + 1];
      const key = keyToken?.kind === "word" ? keyToken.text.toLowerCase() : "";
      if (!keyToken) break;
      if (!valueToken) {
        this.error(line.line, lineEnd(line), `样式属性 ${keyToken.text} 缺少取值。`);
        return null;
      }
      const raw = valueToken.text;
      if (key === "fill" || key === "outline") {
        const color = normalizeColor(raw);
        if (!color) {
          this.error(line.line, valueToken.column, `${key} 应为 #rrggbb 颜色。`);
          ok = false;
        } else if (key === "fill") patch.fill = color;
        else patch.outline = color;
      } else if (key === "width") {
        const value = NUMBER.test(raw) ? Number(raw) : NaN;
        if (!(value >= 0.5 && value <= 12)) {
          this.error(line.line, valueToken.column, "width 应在 0.5 到 12 之间。");
          ok = false;
        } else patch.width = value;
      } else if (key === "opacity") {
        const value = NUMBER.test(raw) ? Number(raw) : NaN;
        if (!(value >= 0 && value <= 1)) {
          this.error(line.line, valueToken.column, "opacity 应在 0 到 1 之间。");
          ok = false;
        } else patch.opacity = value;
      } else if (key === "visible") {
        const value = raw.toLowerCase();
        if (value !== "true" && value !== "false") {
          this.error(line.line, valueToken.column, "visible 只能是 true 或 false。");
          ok = false;
        } else patch.visible = value === "true";
      } else if (key === "order") {
        const value = NUMBER.test(raw) ? Number(raw) : NaN;
        if (!Number.isInteger(value) || value < 1 || value > 10000) {
          this.error(line.line, valueToken.column, "order 应为正整数，1 表示最上层。");
          ok = false;
        } else patch.order = value;
      } else {
        this.error(line.line, keyToken.column, `不认识的样式属性“${keyToken.text}”。可用：fill、outline、width、opacity、visible、order。`);
        ok = false;
      }
      index += 2;
    }
    return ok ? patch : null;
  }

  scalar(token: GdlToken | undefined, line: GdlLine): { ok: boolean; value: GdlScalar } {
    if (!token) {
      this.error(line.line, lineEnd(line), "属性缺少取值。");
      return { ok: false, value: null };
    }
    if (token.kind === "string") return { ok: true, value: token.text };
    if (token.kind === "word") {
      const lower = token.text.toLowerCase();
      if (lower === "true") return { ok: true, value: true };
      if (lower === "false") return { ok: true, value: false };
      if (lower === "null") return { ok: true, value: null };
      if (NUMBER.test(token.text)) return { ok: true, value: Number(token.text) };
    }
    this.error(line.line, token.column, `属性值“${token.text}”无效。文字请加双引号，数字直接写。`);
    return { ok: false, value: null };
  }

  feature(line: GdlLine, layer: OpenLayer): void {
    const attributes: Record<string, GdlScalar> = {};
    const marks: AttributeMark[] = [];
    let index = 1;
    let geomAt = -1;
    while (index < line.tokens.length) {
      const token = line.tokens[index];
      if (!token) break;
      if (upper(token) === "GEOM") {
        geomAt = index;
        break;
      }
      if (token.kind !== "word" && token.kind !== "string") {
        this.error(line.line, token.column, `这里应为属性名，实际是“${token.text}”。`);
        return;
      }
      const eq = line.tokens[index + 1];
      if (!eq || eq.kind !== "eq") {
        this.error(line.line, eq?.column ?? lineEnd(line), `属性 ${token.text} 后面缺少等号 =。`);
        return;
      }
      const value = this.scalar(line.tokens[index + 2], line);
      if (!value.ok) return;
      if (token.text === "_fid") {
        index += 3;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(attributes, token.text)) {
        this.error(line.line, token.column, `属性 ${token.text} 重复。`);
        return;
      }
      attributes[token.text] = value.value;
      marks.push({ key: token.text, value: value.value, line: line.line, column: token.column });
      index += 3;
    }
    if (geomAt < 0) {
      this.error(line.line, lineEnd(line), "FEATURE 缺少 GEOM 和几何字面量，例如 GEOM POINT (116.39 39.91)。");
      return;
    }
    const geometry = parseGeometryLiteral(line.tokens, geomAt + 1, line.line, lineEnd(line), this.errors);
    if (!geometry) return;
    layer.features.push({ line: line.line, attributes, geometry });
    layer.marks.push(marks);
  }

  layerLine(line: GdlLine, layer: OpenLayer): void {
    const head = line.tokens[0];
    const keyword = upper(head);
    if (keyword === "GEOMETRY") {
      const token = line.tokens[1];
      const kind = GEOMETRY_KINDS[upper(token)];
      if (!kind) {
        this.error(line.line, token?.column ?? lineEnd(line), "GEOMETRY 只能是 POINT、LINE、POLYGON 或 MIXED。");
        return;
      }
      if (layer.geometry !== null) this.error(line.line, head?.column ?? 1, "GEOMETRY 重复。");
      layer.geometry = kind;
      this.noExtra(line, 2);
      return;
    }
    if (keyword === "CRS") {
      const label = this.name(line, 1, "坐标系标签");
      if (label === null) return;
      layer.crs = label.slice(0, 60);
      this.noExtra(line, 2);
      return;
    }
    if (keyword === "FIELD") {
      const fieldName = this.name(line, 1, "字段名");
      const typeToken = line.tokens[2];
      const type = upper(typeToken) as GdlFieldType;
      if (fieldName === null) return;
      if (!FIELD_TYPES.includes(type)) {
        this.error(line.line, typeToken?.column ?? lineEnd(line), "字段类型只能是 TEXT、INT、REAL 或 BOOL。");
        return;
      }
      if (fieldName === "_fid") {
        this.error(line.line, line.tokens[1]?.column ?? 1, "_fid 是保留字段。");
        return;
      }
      if (layer.fields.some((field) => field.name === fieldName)) {
        this.error(line.line, line.tokens[1]?.column ?? 1, `字段 ${fieldName} 重复声明。`);
        return;
      }
      layer.fields.push({ name: fieldName, type, line: line.line });
      this.noExtra(line, 3);
      return;
    }
    if (keyword === "STYLE") {
      const patch = this.stylePairs(line, 1);
      if (patch) Object.assign(layer.style, patch);
      return;
    }
    if (keyword === "FEATURE") {
      this.feature(line, layer);
      return;
    }
    if (keyword === "FEATURES") {
      const count = this.number(line, 1, "要素数量");
      if (count !== null) layer.featureCountHint = Math.max(0, Math.floor(count));
      this.noExtra(line, 2);
      return;
    }
    if (keyword === "LAYER" || keyword === "BUFFER" || keyword === "INTERSECT" || keyword === "CLIP" || keyword === "QUERY" || keyword === "STATS" || keyword === "MEASURE") {
      this.error(line.line, head?.column ?? 1, `图层 ${layer.name} 的 LAYER 块还没有 END，不能写 ${keyword}。`);
      return;
    }
    this.error(line.line, head?.column ?? 1, `图层块里不认识“${head?.text ?? ""}”。可用：GEOMETRY、CRS、FIELD、STYLE、FEATURE、END。`);
  }

  checkFields(layer: OpenLayer): void {
    if (layer.fields.length === 0) return;
    const declared = new Map(layer.fields.map((field) => [field.name, field.type]));
    for (const marks of layer.marks) {
      for (const mark of marks) {
        const type = declared.get(mark.key);
        if (!type) {
          this.error(mark.line, mark.column, `属性 ${mark.key} 没有用 FIELD 声明。`);
          continue;
        }
        if (mark.value === null) continue;
        const ok = type === "TEXT"
          ? typeof mark.value === "string"
          : type === "BOOL"
            ? typeof mark.value === "boolean"
            : type === "INT"
              ? typeof mark.value === "number" && Number.isInteger(mark.value)
              : typeof mark.value === "number";
        if (!ok) this.error(mark.line, mark.column, `属性 ${mark.key} 的值和字段类型 ${type} 不符。`);
      }
    }
  }

  close(layer: OpenLayer): void {
    this.checkFields(layer);
    const statement: GdlLayerStatement = {
      kind: "layer",
      line: layer.line,
      name: layer.name,
      geometry: layer.geometry,
      crs: layer.crs,
      fields: layer.fields,
      style: layer.style,
      features: layer.features,
      featureCountHint: layer.featureCountHint,
    };
    this.statements.push(statement);
  }

  defineName(name: string, line: number, column: number): void {
    const previous = this.layerNames.get(name);
    if (previous !== undefined) {
      this.error(line, column, `图层名 ${name} 已在第 ${previous} 行定义过。`);
      return;
    }
    this.layerNames.set(name, line);
  }

  topLine(line: GdlLine): void {
    const head = line.tokens[0];
    const keyword = upper(head);
    const column = head?.column ?? 1;
    if (keyword === "LAYER") {
      const name = this.name(line, 1, "图层名");
      if (name === null) return;
      this.noExtra(line, 2);
      this.defineName(name, line.line, line.tokens[1]?.column ?? column);
      this.open = { line: line.line, column, name, geometry: null, crs: null, fields: [], style: {}, features: [], marks: [], featureCountHint: null };
      return;
    }
    if (keyword === "END") {
      this.error(line.line, column, "这里没有打开的 LAYER 块，END 多余。");
      return;
    }
    if (keyword === "STYLE") {
      const layer = this.name(line, 1, "要改样式的图层名");
      if (layer === null) return;
      const patch = this.stylePairs(line, 2);
      if (patch) this.statements.push({ kind: "style", line: line.line, layer, style: patch });
      return;
    }
    if (keyword === "BUFFER") {
      const input = this.name(line, 1, "输入图层名");
      if (input === null) return;
      let index = 2;
      let distance: number | null = null;
      let unitText = "";
      const glued = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))([^\d.].*)$/.exec(line.tokens[2]?.text ?? "");
      if (line.tokens[2]?.kind === "word" && glued?.[1] && glued[2]) {
        distance = Number(glued[1]);
        unitText = glued[2];
        index = 3;
      } else {
        distance = this.number(line, 2, "缓冲距离");
        if (distance === null) return;
        unitText = line.tokens[3]?.kind === "word" ? line.tokens[3].text : "";
        index = 4;
      }
      const unitColumn = line.tokens[index - 1]?.column ?? lineEnd(line);
      const unit = normalizeGdlUnit(unitText);
      if (!unit) {
        this.error(line.line, unitColumn, "缓冲单位只能是 m、km、mi、ft 或 deg。");
        return;
      }
      if (!(distance > 0)) {
        this.error(line.line, line.tokens[2]?.column ?? column, "缓冲距离必须大于 0。");
        return;
      }
      if (upper(line.tokens[index]) !== "AS") {
        this.error(line.line, line.tokens[index]?.column ?? lineEnd(line), "BUFFER 需要 AS 结果图层名，例如 BUFFER 道路 100 m AS 道路_缓冲。");
        return;
      }
      const output = this.name(line, index + 1, "结果图层名");
      if (output === null) return;
      this.noExtra(line, index + 2);
      this.defineName(output, line.line, line.tokens[index + 1]?.column ?? column);
      this.statements.push({ kind: "buffer", line: line.line, input, distance, unit, unitText, output });
      return;
    }
    if (keyword === "INTERSECT" || keyword === "CLIP") {
      const joiner = keyword === "INTERSECT" ? "WITH" : "BY";
      const example = keyword === "INTERSECT" ? "INTERSECT 甲 WITH 乙 AS 甲乙相交" : "CLIP 道路 BY 边界 AS 道路_裁剪";
      const input = this.name(line, 1, "输入图层名");
      if (input === null) return;
      if (upper(line.tokens[2]) !== joiner) {
        this.error(line.line, line.tokens[2]?.column ?? lineEnd(line), `${keyword} 的写法是：${example}。`);
        return;
      }
      const other = this.name(line, 3, keyword === "INTERSECT" ? "第二个图层名" : "裁剪图层名");
      if (other === null) return;
      if (upper(line.tokens[4]) !== "AS") {
        this.error(line.line, line.tokens[4]?.column ?? lineEnd(line), `${keyword} 需要 AS 结果图层名。写法：${example}。`);
        return;
      }
      const output = this.name(line, 5, "结果图层名");
      if (output === null) return;
      this.noExtra(line, 6);
      this.defineName(output, line.line, line.tokens[5]?.column ?? column);
      this.statements.push({ kind: keyword === "INTERSECT" ? "intersect" : "clip", line: line.line, input, other, output });
      return;
    }
    if (keyword === "QUERY") {
      const input = this.name(line, 1, "输入图层名");
      if (input === null) return;
      if (upper(line.tokens[2]) !== "WITH") {
        this.error(line.line, line.tokens[2]?.column ?? lineEnd(line), "QUERY 的写法是：QUERY 道路 WITH \"类型 = 高速\" AS 道路_筛选。");
        return;
      }
      const filterToken = line.tokens[3];
      if (!filterToken) {
        this.error(line.line, lineEnd(line), "QUERY 需要筛选文字，例如 QUERY 道路 WITH \"类型 = 高速\" AS 道路_筛选。");
        return;
      }
      const filter = filterToken.kind === "string" ? filterToken.text : line.tokens.slice(3).map((token) => token.text).join(" ");
      let after = filterToken.kind === "string" ? 4 : line.tokens.length;
      if (filterToken.kind !== "string") {
        const asIndex = line.tokens.findIndex((token) => upper(token) === "AS");
        if (asIndex > 3) {
          after = asIndex;
        } else {
          this.error(line.line, lineEnd(line), "QUERY 需要 AS 结果图层名。写法：QUERY 道路 WITH \"类型 = 高速\" AS 道路_筛选。");
          return;
        }
      }
      if (upper(line.tokens[after]) !== "AS") {
        this.error(line.line, line.tokens[after]?.column ?? lineEnd(line), "QUERY 需要 AS 结果图层名。写法：QUERY 道路 WITH \"类型 = 高速\" AS 道路_筛选。");
        return;
      }
      const output = this.name(line, after + 1, "结果图层名");
      if (output === null) return;
      if (filter.trim() === "") {
        this.error(line.line, line.tokens[3]?.column ?? lineEnd(line), "QUERY 的筛选文字不能为空。");
        return;
      }
      this.noExtra(line, after + 2);
      this.defineName(output, line.line, line.tokens[after + 1]?.column ?? column);
      this.statements.push({ kind: "query", line: line.line, input, filter: filter.trim(), output });
      return;
    }
    if (keyword === "STATS") {
      const input = this.name(line, 1, "输入图层名");
      if (input === null) return;
      if (upper(line.tokens[2]) === "ON") {
        const field = this.name(line, 3, "字段名");
        if (field === null) return;
        this.noExtra(line, 4);
        this.statements.push({ kind: "stats", line: line.line, input, field });
        return;
      }
      this.noExtra(line, 2);
      this.statements.push({ kind: "stats", line: line.line, input, field: null });
      return;
    }
    if (keyword === "MEASURE") {
      const what = upper(line.tokens[1]);
      if (what === "AREA" || what === "LENGTH") {
        const input = this.name(line, 2, "输入图层名");
        if (input === null) return;
        this.noExtra(line, 3);
        this.statements.push({ kind: "measure", line: line.line, measure: what === "AREA" ? "area" : "length", input, other: null });
        return;
      }
      if (what === "DISTANCE") {
        const input = this.name(line, 2, "第一个图层名");
        if (input === null) return;
        if (upper(line.tokens[3]) !== "TO") {
          this.error(line.line, line.tokens[3]?.column ?? lineEnd(line), "MEASURE DISTANCE 的写法是：MEASURE DISTANCE 甲 TO 乙。");
          return;
        }
        const other = this.name(line, 4, "第二个图层名");
        if (other === null) return;
        this.noExtra(line, 5);
        this.statements.push({ kind: "measure", line: line.line, measure: "distance", input, other });
        return;
      }
      this.error(line.line, line.tokens[1]?.column ?? lineEnd(line), "MEASURE 的写法是：MEASURE AREA 图层、MEASURE LENGTH 图层 或 MEASURE DISTANCE 甲 TO 乙。");
      return;
    }
    if (keyword === "GEOMETRY" || keyword === "CRS" || keyword === "FIELD" || keyword === "FEATURE" || keyword === "FEATURES") {
      this.error(line.line, column, `${keyword} 只能写在 LAYER 和 END 之间。`);
      return;
    }
    this.error(line.line, column, `不认识的语句“${head?.text ?? ""}”。可用：LAYER、STYLE、BUFFER、INTERSECT、CLIP、QUERY、STATS、MEASURE。`);
  }

  run(lines: readonly GdlLine[]): void {
    for (const line of lines) {
      if (this.open) {
        if (upper(line.tokens[0]) === "END") {
          this.noExtra(line, 1);
          this.close(this.open);
          this.open = null;
          continue;
        }
        this.layerLine(line, this.open);
        continue;
      }
      this.topLine(line);
    }
    if (this.open) {
      this.error(this.open.line, this.open.column, `图层 ${this.open.name} 的 LAYER 块缺少 END。`);
      this.close(this.open);
      this.open = null;
    }
  }
}

/** 解析 GDL 文本。收集全部错误（最多 50 条），每条带行号和列号。 */
export function parseGdl(text: string): GdlParseResult {
  if (typeof text !== "string") {
    return { ok: false, program: { statements: [] }, errors: [{ line: 1, column: 1, message: "GDL 文本必须是字符串。" }] };
  }
  if (new TextEncoder().encode(text).byteLength > GDL_TEXT_LIMIT) {
    return { ok: false, program: { statements: [] }, errors: [{ line: 1, column: 1, message: "GDL 文本超过 1MB。" }] };
  }
  const lexErrors: GdlDiagnostic[] = [];
  const lines = tokenize(text, lexErrors);
  const parser = new Parser();
  for (const item of lexErrors) parser.error(item.line, item.column, item.message);
  parser.run(lines);
  const errors = [...parser.errors].sort((left, right) => left.line - right.line || left.column - right.column);
  if (errors.length === 0 && parser.statements.length === 0) {
    return { ok: false, program: { statements: [] }, errors: [{ line: 1, column: 1, message: "GDL 文本里没有语句。" }] };
  }
  return { ok: errors.length === 0, program: { statements: parser.statements }, errors };
}

/** 解析失败就抛出 GdlSyntaxError。 */
export function parseGdlOrThrow(text: string): GdlProgram {
  const result = parseGdl(text);
  if (!result.ok) throw new GdlSyntaxError(result.errors);
  return result.program;
}
