// SPDX-License-Identifier: Apache-2.0

/** 口语归一化只有一份实现，在 local-intent.ts。这里只转出旧的导入路径。 */
export {
  collectPartialEntities,
  explicitLayerTokens,
  formatParseTrace,
  intentFragmentsOf,
  isAmbiguousIntent,
  normalizeInstruction,
  parseCnInteger,
  parseDistanceMeters,
  parseSequenceClauses,
} from "./local-intent.js";
export type { InstructionIntent, LocalIntentOptions, NormalizedInstruction, PartialEntities } from "./local-intent.js";
