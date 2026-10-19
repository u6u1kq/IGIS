// SPDX-License-Identifier: Apache-2.0

/** 样本库已从产品移除。这些符号只为旧的类型引用留着，调用会失败。 */

export const FOUNDATION_DB_FILE = "foundation.sqlite";
export const FOUNDATION_MANIFEST_FILE = "foundation.json";
export const FOUNDATION_SCHEMA_VERSION = 0;

export class FoundationDbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FoundationDbError";
  }
}

export interface FoundationFunctionCall {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface FoundationManifest {
  readonly version: number;
  readonly count: number;
  readonly sha256: string;
  readonly createdAt: string;
}

export interface FoundationSampleInput {
  readonly instruction: string;
  readonly functionCall: FoundationFunctionCall;
  readonly source?: "synthetic";
  readonly licenseTag?: string;
}

export function assertFoundationSampleClean(_instruction?: string, _functionCall?: unknown): void {}

export function ensureFoundationDatabase(_directory?: string): Promise<FoundationManifest> {
  return Promise.reject(new FoundationDbError("样本库已删除。"));
}

export function insertFoundationSample(_directory?: string, _input?: FoundationSampleInput): Promise<FoundationManifest> {
  return Promise.reject(new FoundationDbError("样本库已删除。"));
}

export function readFoundationFile(_directory?: string): Promise<Uint8Array> {
  return Promise.reject(new FoundationDbError("样本库已删除。"));
}

export function foundationDownloadName(): string {
  return "igis-foundation.sqlite";
}
