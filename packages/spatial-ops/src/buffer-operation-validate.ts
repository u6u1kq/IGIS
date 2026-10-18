// SPDX-License-Identifier: Apache-2.0

/**
 * 缓冲请求的结构验证。只看请求对象本身，不解析图层，不执行缓冲，不检查策略。
 * sourceLayer 必须是已解析身份（layerId 与 layerName）。原始图层引用、NotFound、Ambiguous 都不是请求。
 * 本函数不查找图层。writeKnowledge 在 ExecutionPolicy 上，本函数不检查它。
 * 非法输入返回 ValidationResult，不抛异常。
 * 现有执行路径有独立距离上限，本验证层本任务不承担该业务规则。
 * Chat/MCP、地图 HTTP 与 GDL 在调用 SpatialService.buffer 之前调用本函数。本函数不查找图层。
 */

import type { BufferDistanceUnit } from "./buffer-operation.js";

/** 与 BufferDistanceUnit 相同的五个字面量。不接受别名，也不换算。 */
const BUFFER_DISTANCE_UNITS: readonly BufferDistanceUnit[] = [
  "meters",
  "kilometers",
  "miles",
  "feet",
  "degrees",
];

export interface ValidationError {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

/** 合法为 { ok: true }。不合法为 { ok: false, errors }，不是异常。 */
export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnit(value: unknown): value is BufferDistanceUnit {
  return typeof value === "string" && (BUFFER_DISTANCE_UNITS as readonly string[]).includes(value);
}

function error(field: string, code: string, message: string): ValidationError {
  return { field, code, message };
}

function sourceLayerErrors(value: unknown): ValidationError[] {
  if (!isRecord(value)) {
    return [error("sourceLayer", "sourceLayer.required", "必须提供已解析的图层身份。")];
  }
  if (value.ok === false || value.code === "NotFound" || value.code === "Ambiguous" || "candidates" in value) {
    return [error("sourceLayer", "sourceLayer.unresolved", "找不到或不能唯一确定的图层不能进入操作请求。")];
  }
  if (value.kind === "id" || value.kind === "name" || value.kind === "name-or-id") {
    return [error("sourceLayer", "sourceLayer.unresolved", "图层引用还不是已解析身份。操作请求只接受 layerId 与 layerName。")];
  }
  const layerId = value.layerId;
  const layerName = value.layerName;
  if (typeof layerId !== "string" || layerId.trim() === "" || typeof layerName !== "string" || layerName.trim() === "") {
    return [error("sourceLayer", "sourceLayer.empty", "图层身份的 layerId 和 layerName 去掉空白后不能为空。")];
  }
  return [];
}

function distanceErrors(value: unknown): ValidationError[] {
  if (typeof value !== "number") {
    return [error("distance", "distance.type", "距离必须是大于 0 的有限数字。")];
  }
  if (!Number.isFinite(value)) {
    return [error("distance", "distance.not_finite", "距离必须是大于 0 的有限数字。")];
  }
  if (value <= 0) {
    return [error("distance", "distance.not_positive", "距离必须是大于 0 的有限数字。")];
  }
  return [];
}

function outputNameErrors(request: Record<string, unknown>): ValidationError[] {
  if (!Object.hasOwn(request, "outputName") || request.outputName === undefined) return [];
  if (typeof request.outputName !== "string") {
    return [error("outputName", "outputName.type", "输出名必须是字符串。")];
  }
  if (request.outputName === "") {
    return [error("outputName", "outputName.empty", "输出名如果写了，就不能是空字符串。要省略就不要带这个字段。")];
  }
  return [];
}

/**
 * 检查一份值是否是结构上基本合法的缓冲请求。
 * 不查图层是否存在，不查坐标系、地面距离、Turf 或几何。
 * 原始图层引用、NotFound 和 Ambiguous 不是合法请求。带齐 layerId 与 layerName 时仍不访问图层库。
 * 不加距离上限。不检查 ExecutionPolicy，也不检查 writeKnowledge。
 * 同一输入得到同一输出。
 */
export function validateBufferOperation(request: unknown): ValidationResult {
  if (!isRecord(request)) {
    return {
      ok: false,
      errors: [error("request", "request.type", "缓冲请求必须是对象。")],
    };
  }
  const errors: ValidationError[] = [];
  if (request.operation !== "buffer") {
    errors.push(error("operation", "operation.invalid", "操作必须是 buffer。"));
  }
  errors.push(...sourceLayerErrors(request.sourceLayer));
  errors.push(...distanceErrors(request.distance));
  if (!isUnit(request.unit)) {
    errors.push(error("unit", "unit.invalid", "单位必须是 meters、kilometers、miles、feet、degrees 之一。"));
  }
  errors.push(...outputNameErrors(request));
  if (errors.length === 0) return { ok: true };
  return { ok: false, errors };
}
