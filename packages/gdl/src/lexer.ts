// SPDX-License-Identifier: Apache-2.0

/**
 * Igis GDL 词法。手写，不用解析器生成器。
 * 一行一条语句。记号：词、字符串、等号、左右括号、逗号。
 * 注释从记号开头的两个连字符 -- 起到行尾。
 */
export type GdlTokenKind = "word" | "string" | "eq" | "lparen" | "rparen" | "comma";

export interface GdlToken {
  readonly kind: GdlTokenKind;
  readonly text: string;
  readonly line: number;
  readonly column: number;
}

export interface GdlLine {
  readonly line: number;
  readonly tokens: readonly GdlToken[];
}

export interface GdlDiagnostic {
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

const PUNCT: Readonly<Record<string, GdlTokenKind>> = {
  "=": "eq",
  "(": "lparen",
  ")": "rparen",
  ",": "comma",
};

function isSpace(char: string): boolean {
  return char === " " || char === "\t" || char === "\r" || char === "\uFEFF" || char === "\u3000";
}

export function tokenizeLine(source: string, line: number, diagnostics: GdlDiagnostic[]): GdlToken[] {
  const tokens: GdlToken[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? "";
    if (isSpace(char)) {
      index += 1;
      continue;
    }
    if (char === "-" && source[index + 1] === "-") break;
    const punct = PUNCT[char];
    if (punct) {
      tokens.push({ kind: punct, text: char, line, column: index + 1 });
      index += 1;
      continue;
    }
    if (char === "\"") {
      const start = index;
      let value = "";
      index += 1;
      let closed = false;
      while (index < source.length) {
        const next = source[index] ?? "";
        if (next === "\\") {
          const escaped = source[index + 1];
          if (escaped === "\"" || escaped === "\\") {
            value += escaped;
            index += 2;
            continue;
          }
          if (escaped === "n") {
            value += "\n";
            index += 2;
            continue;
          }
          value += next;
          index += 1;
          continue;
        }
        if (next === "\"") {
          closed = true;
          index += 1;
          break;
        }
        value += next;
        index += 1;
      }
      if (!closed) {
        diagnostics.push({ line, column: start + 1, message: "字符串缺少右引号。" });
        return tokens;
      }
      tokens.push({ kind: "string", text: value, line, column: start + 1 });
      continue;
    }
    const start = index;
    while (index < source.length) {
      const next = source[index] ?? "";
      if (isSpace(next) || PUNCT[next] || next === "\"") break;
      index += 1;
    }
    tokens.push({ kind: "word", text: source.slice(start, index), line, column: start + 1 });
  }
  return tokens;
}

/** 按行切开。空行和纯注释行不返回。 */
export function tokenize(text: string, diagnostics: GdlDiagnostic[]): GdlLine[] {
  const lines: GdlLine[] = [];
  const raw = text.replace(/\r\n?/g, "\n").split("\n");
  for (let index = 0; index < raw.length; index += 1) {
    const tokens = tokenizeLine(raw[index] ?? "", index + 1, diagnostics);
    if (tokens.length > 0) lines.push({ line: index + 1, tokens });
  }
  return lines;
}
