// SPDX-License-Identifier: Apache-2.0

import { AUTHORIZATION_FORBIDDEN_INTENT_FIELDS, isFileKey, isGeometryKey, looksLikeFilePath } from "@igis/ai-boundary";
import { projectForModel } from "@igis/ai-translation";
import { looksLikeGeometryText } from "@igis/shared-types";
import type { ExternalBackendPort, ExternalBackendResult, ExternalCapabilityOutcome, ExternalCapabilityRequest } from "./port.js";

/**
 * 外部能力边界的强制点（四条硬约束）：
 *   1. 可选适配器：未配置后端 = 能力下线（返回 unavailable），核心不依赖本包；
 *   2. 单向依赖：本包可以依赖核心（投影/键规则），核心不 import 本包；
 *   3. 能力可下线：available=false 时任何 invoke 直接拒绝，不留半截状态；
 *   4. 上线开关：enabled=false 时后端即使配置了也不加载。
 * 请求侧：授权字段/路径键/几何键/路径值/几何值一律拒绝（模型永不进后端通道）。
 * 结果侧：facts 过白名单投影（bounds/transform/uri 等全部剥离），outputResources 只回本地。
 */

const FORBIDDEN_PARAMETER_KEYS = new Set<string>(AUTHORIZATION_FORBIDDEN_INTENT_FIELDS.map((key) => key.toLowerCase()));

export type ExternalRequestRejection = { readonly ok: false; readonly code: string; readonly message: string };

function rejectRequest(code: string, message: string): ExternalRequestRejection {
  return { ok: false, code, message };
}

/** 请求纪律：标量参数白名单化，路径/几何/授权一律拒绝。 */
export function validateExternalRequest(request: ExternalCapabilityRequest): true | ExternalRequestRejection {
  if (typeof request.capability !== "string" || request.capability.trim() === "") {
    return rejectRequest("external-request-invalid", "外部能力请求缺少能力名。");
  }
  for (const resource of request.inputResources) {
    if (typeof resource !== "string" || resource.trim() === "" || resource.length > 256) {
      return rejectRequest("external-request-invalid", "外部能力请求的资源标识不合法。");
    }
  }
  for (const [key, value] of Object.entries(request.parameters)) {
    const lower = key.toLowerCase();
    if (FORBIDDEN_PARAMETER_KEYS.has(lower)) {
      return rejectRequest("external-request-rejected", `外部能力参数不能携带授权字段（${key}）。`);
    }
    if (isFileKey(key) || isGeometryKey(key) || lower === "bbox" || lower === "bounds" || lower === "extent" || lower === "where" || lower === "sql") {
      return rejectRequest("external-request-rejected", `外部能力参数不能携带路径、几何或查询子句（${key}）。`);
    }
    if (typeof value === "string") {
      if (looksLikeFilePath(value)) {
        return rejectRequest("external-request-rejected", "外部能力参数不能携带文件路径。");
      }
      if (looksLikeGeometryText(value)) {
        return rejectRequest("external-request-rejected", "外部能力参数不能携带几何文本。");
      }
      if (/^-?\d+(?:\.\d+)?\s*[,，\s]\s*-?\d+(?:\.\d+)?$/.test(value.trim())) {
        return rejectRequest("external-request-rejected", "外部能力参数不能携带坐标对。");
      }
    }
  }
  return true;
}

/** 结果投影：facts 走白名单投影（bounds/transform/uri 等键直接消失），文本过清洗。 */
export function sanitizeExternalResult(result: ExternalBackendResult): ExternalCapabilityOutcome {
  const projectedMessage = typeof result.message === "string"
    ? (projectForModel({ message: result.message }) as { message?: unknown }).message
    : undefined;
  const message = typeof projectedMessage === "string" ? projectedMessage : "";
  const facts = result.facts === undefined
    ? undefined
    : (projectForModel(result.facts) as Record<string, unknown> | undefined);
  return {
    ok: result.ok === true,
    ...(facts !== undefined && Object.keys(facts).length > 0 ? { facts } : {}),
    ...(message !== "" ? { message } : {}),
    ...(result.outputResources !== undefined && result.outputResources.length > 0
      ? { localOutputResources: [...result.outputResources] }
      : {}),
  };
}

export interface ExternalGatewayOptions {
  /** 上线开关：false 时后端不加载，能力整体下线。 */
  readonly enabled: boolean;
  readonly backend?: ExternalBackendPort | undefined;
}

export class ExternalCapabilityBoundary {
  private enabled: boolean;
  private readonly backend: ExternalBackendPort | undefined;

  constructor(options: ExternalGatewayOptions) {
    this.enabled = options.enabled === true;
    this.backend = options.backend;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  get backendName(): string | null {
    return this.backend?.name ?? null;
  }

  async isAvailable(): Promise<boolean> {
    if (!this.enabled || !this.backend) return false;
    try {
      return await this.backend.isAvailable();
    } catch {
      return false;
    }
  }

  async status(): Promise<{ readonly enabled: boolean; readonly available: boolean; readonly backend: string | null; readonly message: string }> {
    if (!this.enabled || !this.backend) {
      return { enabled: false, available: false, backend: this.backend?.name ?? null, message: "外部能力已关闭。" };
    }
    try {
      const result = this.backend.checkAvailability
        ? await this.backend.checkAvailability()
        : { available: await this.backend.isAvailable(), message: "外部能力后端检查完成。" };
      return { enabled: true, available: result.available, backend: this.backend.name, message: result.message };
    } catch (error) {
      return { enabled: true, available: false, backend: this.backend.name, message: error instanceof Error ? error.message.slice(0, 300) : "外部能力自检失败。" };
    }
  }

  async invoke(request: ExternalCapabilityRequest): Promise<ExternalCapabilityOutcome> {
    const validation = validateExternalRequest(request);
    if (validation !== true) return validation;
    if (!this.enabled || !this.backend) {
      return { ok: false, code: "external-capability-unavailable", message: "外部能力后端未启用，该能力当前不可用。" };
    }
    const available = await this.isAvailable();
    if (!available) {
      return { ok: false, code: "external-capability-unavailable", message: "外部能力后端不可用，该能力当前不可用。" };
    }
    try {
      const raw = await this.backend.invoke(request);
      return sanitizeExternalResult(raw);
    } catch (error) {
      return {
        ok: false,
        code: "external-capability-failed",
        message: error instanceof Error ? error.message.slice(0, 500) : "外部能力执行失败。",
      };
    }
  }
}
