// SPDX-License-Identifier: Apache-2.0

export type LlmInvokeErrorCode =
  | "unknown-provider"
  | "missing-api-key"
  | "missing-base-url"
  | "missing-model"
  | "missing-fetch"
  | "geometry-rejected"
  | "http-error"
  | "invalid-tool-call"
  | "unknown-tool"
  | "invalid-tool-arguments"
  | "network-error"
  | "timeout"
  | "adapter-error"
  | "max-rounds"
  | "empty-reply";

/** 调用失败。消息里只写原因，不写密钥。 */
export class LlmInvokeError extends Error {
  readonly code: LlmInvokeErrorCode;
  constructor(code: LlmInvokeErrorCode, message: string) {
    super(message);
    this.name = "LlmInvokeError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
