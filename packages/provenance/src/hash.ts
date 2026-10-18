// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

/** 用 Node 内置 crypto 计算 SHA-256。明文留在调用方，账本只保存十六进制摘要。 */
export function hashSourceContent(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
