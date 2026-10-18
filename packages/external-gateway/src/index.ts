// SPDX-License-Identifier: Apache-2.0

export { ExternalCapabilityBoundary, sanitizeExternalResult, validateExternalRequest } from "./boundary.js";
export type { ExternalGatewayOptions, ExternalRequestRejection } from "./boundary.js";
export { createProcessBackend } from "./process-adapter.js";
export type { ProcessBackendOptions } from "./process-adapter.js";
export {
  ensureManagedGdalEnv,
  managedPythonPath,
  readBootstrapError,
  readGdalPythonLock,
  readInterpreterSelection,
  resolvePythonCommand,
  savedPythonCommandForPanel,
  writeInterpreterSelection,
} from "./gdal-env.js";
export type { GdalPythonLock, InterpreterSelection } from "./gdal-env.js";
export { enginesDirectory, enginesPythonPath, installEngines, readEnginesLock, trigrsSourceOrder } from "./engines-env.js";
export type { EnginesLock } from "./engines-env.js";
export { createMcpBackend } from "./mcp-adapter.js";
export type { McpBackendOptions } from "./mcp-adapter.js";
export type { ExternalBackendPort, ExternalBackendResult, ExternalCapabilityOutcome, ExternalCapabilityRequest } from "./port.js";
