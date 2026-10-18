// SPDX-License-Identifier: Apache-2.0

export type { DispatchInput, LlmDispatch } from "./input.js";

export type { LlmCallerOptions, LlmHttp, LlmHttpInit, LlmHttpResponse, ResolvedLlmConnection } from "./invoke.js";
export { createExternalLlmDispatch, invokeLlmForToolRequest, resolveLlmConnection } from "./invoke.js";
export { LlmInvokeError } from "./errors.js";
export type { LlmInvokeErrorCode } from "./errors.js";
export { LLM_PROVIDER_PROFILES, getLlmProviderProfile, resolveChatCompletionsUrl } from "./providers.js";
export type { LlmProviderProfile } from "./providers.js";
export { assertLlmPayload } from "./guard.js";
export { payloadHasCoordinateArrays, translateLocalToAi as translateForModel } from "@igis/ai-translation";
export { destructiveActionOf, destructiveConfirmMessage, gateDestructive } from "./destructive.js";
export type { DestructiveAction } from "./destructive.js";
export {
  GDL_TOOL_NAMES,
  GIS_QUERY_TOOL_NAMES,
  GIS_TOOL_REGISTRY,
  MAP_SPATIAL_TOOL_NAMES,
  findGisTool,
  gdlTools,
  gisQueryTools,
  mapSpatialTools,
  toOpenAiTools,
} from "./registry.js";
export { requestLlmText } from "./text.js";
export type { LlmTextRequest } from "./text.js";
export type { GisToolDefinition, ToolParameterSpec } from "./registry.js";
export { validateToolArguments } from "./validate.js";
export type { ScheduledToolCall, ToolAdapterPort, ToolCallProvenance } from "./validate.js";
export { runLlmToolCallLoop } from "./loop.js";
export type { ToolLoopOptions, ToolLoopResult, ToolTrace, ToolLoopStopReason, StepStatus, TurnStatus } from "./loop.js";
export { CHAT_STREAM_FIXTURE, progressToolEvent, sanitizeProgressText, visibleStreamEventTypes } from "./chat-progress.js";
export type { ChatProgressEvent, ChatProgressHandler, ThoughtStatusCode } from "./chat-progress.js";
export { runLlmDispatchSelfCheck, runLlmToolLoopSelfCheck } from "./self-check.js";
export { createLegacyLocalChatMock, createLocalChatMock, createScriptedGisMock } from "./local-mock.js";
export { runAssistantTurn } from "./rag-chat.js";
export type { AssistantTurnOptions } from "./rag-chat.js";
export { GIS_SYSTEM_PROMPT, FOLLOWUP_LAYER_REMINDER, buildGisSystemPrompt } from "./gis-prompt.js";
export { formatMapLayerContext, formatSelectedLayer, layersForConversationScope } from "./layer-context.js";
export type { MapLayerContext } from "./layer-context.js";
export { canonicalToolName, toApiToolName } from "./aliases.js";
export { normalizeToolArguments } from "./normalize-args.js";
export { parseTextToolCalls } from "./parse-text-tools.js";
export { planGisInstruction, looksLikeLayerNameSupplement } from "./gis-route.js";
export { explicitLayerTokens, normalizeInstruction } from "./instruction-normalizer.js";
export {
  collectPartialEntities,
  formatParseTrace,
  isAmbiguousIntent,
  parseDistanceMeters,
} from "./local-intent.js";
export type { PartialEntities } from "./local-intent.js";
export { LOCAL_DISPATCH_POLICY, runLocalFirstTurn } from "./dispatch-policy.js";
export type { LocalFirstInput, LocalFirstResult } from "./dispatch-policy.js";
export type { InstructionIntent, NormalizedInstruction } from "./instruction-normalizer.js";
export type { PlanGisOptions, PlannedGisCall, KnownMockLayer } from "./gis-route.js";
export {
  clarifyPendingPlan,
  draftPendingPlan,
  continuablePlanAfterFailure,
  executePlannedCalls,
  fillPendingPlan,
  isMissingSlotFailure,
  parsePendingPlan,
  planIsComplete,
  plannedCallsFrom,
  resolveChatPlan,
  dispatchJudgment,
} from "./pending-plan.js";
export type { ChatPlanResolution, PendingPlan, PendingPlanStep, ResolveChatPlanInput } from "./pending-plan.js";
export { visibleDispatchContext } from "./invoke.js";
export {
  DEEPSEEK_PRESET_BASE_URL,
  DEEPSEEK_PRESET_MODEL,
  GROK_PRESET_MODEL,
  QWEN_PRESET_MODEL,
  listModelPresets,
  maskApiKey,
  resolveEffectiveLlmConfig,
  resolveTaskLlmConfig,
  scrubSecrets,
} from "./session-config.js";
export type { EffectiveLlmConfig, LlmMemoryOverride, ModelPreset, ModelPresetId } from "./session-config.js";
