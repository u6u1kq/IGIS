// SPDX-License-Identifier: Apache-2.0

/**
 * Igis GDL（地理描述语言）第一版。
 * 名字与 Graphisoft ArchiCAD 的 Geometric Description Language 撞名，最终名称待定；语法和文档没有参考它。
 * 语法见 docs/gdl/grammar.md。
 */
export const GDL_VERSION = "igis-gdl-0.1" as const;

export type {
  GdlBufferStatement,
  GdlFeature,
  GdlField,
  GdlFieldType,
  GdlGeometryKind,
  GdlLayerStatement,
  GdlOverlayStatement,
  GdlProgram,
  GdlScalar,
  GdlStatement,
  GdlStyleStatement,
  GdlStylePatch,
  GdlUnit,
} from "./ast.js";
export type { GdlDiagnostic, GdlToken } from "./lexer.js";
export { tokenize } from "./lexer.js";
export { GDL_TEXT_LIMIT, GdlSyntaxError, normalizeGdlUnit, parseGdl, parseGdlOrThrow } from "./parser.js";
export type { GdlParseResult } from "./parser.js";
export { GDL_GEOMETRY_KEYWORDS, geometryToLiteral, parseGeometryLiteral } from "./geometry.js";
export { formatGdlName, inferGdlFieldTypes, layerToGdl, layerToGdlSummary, quoteGdlString } from "./serialize.js";
export type { GdlLayerSource } from "./serialize.js";
export { summarizeGdlProgram } from "./summary.js";
export { GdlSummaryError, assertGdlSummarySafe, findGeometryLiteral } from "./safety.js";
export { GdlGuardError, validateLlmGdl } from "./guard.js";
export { GdlRuntimeError, executeGdl } from "./execute.js";
export type { GdlExecution, GdlHost, GdlLayerRef, GdlStep } from "./execute.js";
