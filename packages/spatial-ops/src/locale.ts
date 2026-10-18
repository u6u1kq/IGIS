// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";

/** 这一次请求里用户看得到的语言。没设置时保持中文，已有检查不受影响。 */
export type UserLocale = "zh-CN" | "en";

const localeContext = new AsyncLocalStorage<UserLocale>();

export function currentUserLocale(): UserLocale {
  return localeContext.getStore() ?? "zh-CN";
}

export function runWithUserLocale<T>(locale: UserLocale, run: () => T): T {
  return localeContext.run(locale, run);
}

export function ui(zh: string, en: string): string {
  return currentUserLocale() === "en" ? en : zh;
}
