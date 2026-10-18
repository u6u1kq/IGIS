// SPDX-License-Identifier: Apache-2.0

export type {
  AiLayerView,
  DataBoundaryLevel,
  DataLevel,
  ForbiddenClass,
  OperationLayerFacts,
  OperationSource,
  RequestSource,
} from "./levels.js";
export {
  AI_SPATIAL_OPERATIONS,
  L0_ONLY,
  isFileKey,
  isGeometryKey,
  isSensitiveFieldName,
  looksLikeDatabaseDump,
  looksLikeFilePath,
  looksLikeGdalCommand,
  looksLikeShellCommand,
  projectFieldNames,
} from "./levels.js";
export type { ModelManifest } from "./manifest.js";
export { loadModelManifest, parseModelManifest } from "./manifest.js";
export { AI_SANDBOX_ALLOW, AI_SANDBOX_DENY } from "./sandbox.js";
export type { SandboxDeny } from "./sandbox.js";
/** AI GIS Worker Contract 锚点（V0.85）：能力/可见面/授权/留痕四契约的单一事实源。 */
export type { ApprovalIssuer, ApprovalState, ApprovalToken, CapabilityEntry, DangerLevel } from "./capability-manifest.js";
export {
  AUDIT_REQUIRED_FIELDS,
  AUDIT_REQUIRED_OPERATIONS,
  AUTHORIZATION_FORBIDDEN_INTENT_FIELDS,
  AUTHORIZATION_REQUIRED_OPERATIONS,
  CAPABILITY_MANIFEST,
  VISIBILITY_FORBIDDEN_KEYS,
  VISIBILITY_NUMBERS_ALLOWED,
  consumeApprovalToken,
  issueApprovalToken,
  issueAndConsumeApproval,
} from "./capability-manifest.js";
