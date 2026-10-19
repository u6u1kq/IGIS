// SPDX-License-Identifier: Apache-2.0

/**
 * 智能体规则模块。
 * 外层不再叫沙箱，也不叫数据处理辅助。
 * 子类：规范引导写在 guidance-rules.ts，隔离规则写在 isolation-rules.ts。
 */
export const AGENT_RULES = {
  name: "智能体规则模块",
  guidance: "规范引导",
  isolation: "隔离规则",
} as const;

/** @deprecated 使用 AGENT_RULES。 */
export const ASSIST_FRAMEWORK = AGENT_RULES;

export { ISOLATION_RULES, concealUserApi, isolationRules, rejectStorageRead } from "./isolation-rules.js";
export type { IsolationRule } from "./isolation-rules.js";
export { guidanceFollowup, guidanceText, guidanceTurnNote } from "./guidance-rules.js";
export type { GuidanceLocale } from "./guidance-rules.js";
