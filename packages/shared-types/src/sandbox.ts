// SPDX-License-Identifier: Apache-2.0

import type { FunctionCall, FunctionResult } from "./pipeline.js";

/** V0.1 只固定契约，不提供沙箱运行时。 */
export interface SandboxPolicy {
  readonly geometryLeavesProcess: false;
  readonly serializeGeometryToDisk: false;
  readonly serializeGeometryToNetwork: false;
  readonly inputsAreMemoryRefs: true;
  readonly outputsAreMemoryRefs: true;
}

export interface AiSandbox {
  readonly policy: SandboxPolicy;
  invoke(call: FunctionCall): Promise<FunctionResult>;
}
