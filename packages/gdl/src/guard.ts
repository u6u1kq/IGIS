// SPDX-License-Identifier: Apache-2.0

import type { GdlProgram } from "./ast.js";
import { parseGdl } from "./parser.js";
import type { GdlDiagnostic } from "./lexer.js";
import { findGeometryLiteral } from "./safety.js";

/** 合法的模型侧语句里数字后面总跟着单位、关键字或样式名，不会出现两个数字相连。 */
const BARE_NUMBER_PAIR = /(^|[\s,(])[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?[ \t]+[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?(?=$|[\s,)])/m;

/** 模型提交的 GDL 不合规时抛出。消息是中文，可以原样回给模型。 */
export class GdlGuardError extends Error {
  readonly diagnostics: readonly GdlDiagnostic[];

  constructor(message: string, diagnostics: readonly GdlDiagnostic[] = []) {
    super(message);
    this.name = "GdlGuardError";
    this.diagnostics = diagnostics;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * 校验模型通过 gdl.run 提交的 GDL。
 * 只允许引用已有图层的 STYLE、BUFFER、INTERSECT、CLIP、QUERY、STATS、MEASURE。
 * 不允许 LAYER 块、FEATURE、几何字面量，也不允许在几何位置出现坐标数字。模型不能生成几何。
 */
export function validateLlmGdl(text: string): GdlProgram {
  if (typeof text !== "string" || text.trim() === "") throw new GdlGuardError("GDL 文本为空。");
  if (text.length > 8000) throw new GdlGuardError("模型提交的 GDL 太长，最多 8000 个字符。");
  const literal = findGeometryLiteral(text) ?? (BARE_NUMBER_PAIR.test(text) ? "出现了连续的两个数字，像坐标" : null);
  if (literal) throw new GdlGuardError(`已拒绝：${literal}。模型只能引用图层名并写样式或缓冲、相交、裁剪语句，不能生成几何。`);
  const parsed = parseGdl(text);
  if (!parsed.ok) {
    const first = parsed.errors[0];
    throw new GdlGuardError(first ? `GDL 第 ${first.line} 行第 ${first.column} 列：${first.message}` : "GDL 语法错误。", parsed.errors);
  }
  for (const statement of parsed.program.statements) {
    if (statement.kind === "layer") {
      throw new GdlGuardError(`第 ${statement.line} 行：模型不能用 LAYER 新建图层或写要素，只能引用已有图层。`);
    }
  }
  return parsed.program;
}
