// SPDX-License-Identifier: Apache-2.0

import type { OperationCrsFacts } from "./operation-attempt.js";

/** 空间分析的友好错误。调用方捕获后返回给页面，不能让进程退出。 */
export class SpatialOpError extends Error {
  /** 失败审计已经写入时的 recordId。没有写出时不设置，也不填占位 id。 */
  auditRecordId?: string;
  /** 失败时已经判定的坐标系事实。不含几何。 */
  crsFacts?: OperationCrsFacts;
  /** 坐标系拒绝用这个码。不是文件访问失败。 */
  code?: string;
  /**
   * remember 里 audit.append 抛错被捕获时为 true。
   * 没调用 remember，或只是组装记录失败，都不设置。不能把它读成审计已成功。
   */
  auditAppendFailed?: true;

  constructor(message: string) {
    super(message);
    this.name = "SpatialOpError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * 从 SpatialOpError 取出已有的审计字段。
 * 有 recordId 时只返回 id；append 失败时只返回 auditAppendFailed。没有尝试写审计时返回空对象。
 */
export function auditFailureFields(error: unknown): Readonly<Record<string, string | boolean>> {
  if (!(error instanceof SpatialOpError)) return {};
  if (typeof error.auditRecordId === "string") return { auditRecordId: error.auditRecordId };
  if (error.auditAppendFailed === true) return { auditAppendFailed: true };
  return {};
}
