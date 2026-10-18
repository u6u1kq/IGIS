// SPDX-License-Identifier: Apache-2.0

/** 调度输入里的知识图命中。当前聊天路径不查询知识图，字段保留给调用方。 */
export interface KgHit {
  readonly operation: string;
  readonly tool: string;
  readonly issue: string | null;
  readonly resolution: string | null;
}
