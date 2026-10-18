// SPDX-License-Identifier: Apache-2.0

/**
 * 本机合成样本库。设置里可以准备和下载 var/foundation。
 * 样本不能含坐标。这里不训练，也不导出训练集。
 */

export {
  FOUNDATION_DB_FILE,
  FOUNDATION_MANIFEST_FILE,
  FOUNDATION_SCHEMA_VERSION,
  FoundationDbError,
  assertFoundationSampleClean,
  ensureFoundationDatabase,
  foundationDownloadName,
  insertFoundationSample,
  readFoundationFile,
} from "./foundation-db.js";
export type { FoundationFunctionCall, FoundationManifest, FoundationSampleInput } from "./foundation-db.js";
