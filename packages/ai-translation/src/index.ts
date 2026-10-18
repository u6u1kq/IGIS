// SPDX-License-Identifier: Apache-2.0

export { boundaryViolation, translateAiIntent } from "./ai-to-local.js";
export type { IntentCode, OperationIntent, SummaryIntent, TranslatedIntent } from "./ai-to-local.js";
export { projectForModel } from "./allowlist.js";
export { BoundaryError, isModelVisibleTool, rejectModelToolCall, releaseToModel } from "./gateway.js";
export {
  payloadHasCoordinateArrays,
  toLayerSummary,
  toOperationContext,
  translateLocalToAi,
} from "./local-to-ai.js";
export type { LayerSummary, OperationContext } from "./local-to-ai.js";
