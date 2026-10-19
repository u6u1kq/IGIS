// SPDX-License-Identifier: Apache-2.0

/**
 * 一次缓冲「要做什么」，以及这次允许的副作用。
 * 四个纯函数把各入口已经取出、但还没解析成图层身份的值抄进原始输入和策略。
 * 那不是最终 OperationRequest。最终请求只接受已解析成功的图层身份。
 * 不解析文字，不换算单位，不查找图层，不执行缓冲，不执行策略。
 * Chat/MCP、地图 HTTP 与 GDL 在调用 SpatialService.buffer 之前用这些函数组装请求。
 */

import type { LayerResolutionIdentity, LayerResolutionResult } from "./layer-resolution.js";

/** 代码里实际接受的距离单位。与 normalizeUnit / GDL / 地图下拉相同，不另加单位。 */
export type BufferDistanceUnit = "meters" | "kilometers" | "miles" | "feet" | "degrees";

/**
 * 图层指针。只有标识或名字，没有几何。
 * 种类按入口怎么引用图层来分。这是原始输入，不是已经解析好的图层。
 */
export type LayerReference =
  | { readonly kind: "id"; readonly id: string }
  | { readonly kind: "name"; readonly name: string }
  | { readonly kind: "name-or-id"; readonly text: string };

/**
 * 一次缓冲「要做什么」。
 * sourceLayer 只接受解析成功后的图层身份，不接受原始引用，也不接受 NotFound / Ambiguous。
 * 不含执行结果、状态、时间、错误、回滚、几何、operationId，也不含副作用开关。
 * steps 仍是引擎常量，不在这里。
 * writeKnowledge 不在这里，它在 ExecutionPolicy。
 */
export interface BufferOperationRequest {
  readonly operation: "buffer";
  readonly sourceLayer: LayerResolutionIdentity;
  readonly distance: number;
  readonly unit: BufferDistanceUnit;
  readonly outputName?: string;
}

/**
 * 入口字符串还没解析成图层身份时的形状。
 * 这是 Raw Operation Input，不是 BufferOperationRequest。
 */
export interface RawBufferOperationInput {
  readonly operation: "buffer";
  readonly sourceLayer: LayerReference;
  readonly distance: number;
  readonly unit: BufferDistanceUnit;
  readonly outputName?: string;
}

/**
 * 这次运行附带的开关。运算不读取它。
 */
export interface ExecutionPolicy {
  readonly writeKnowledge?: boolean;
}

/**
 * 原始入口的两半。input 仍是图层引用。
 * 不是最终 OperationRequest，也不是执行结果。
 */
export interface RawBufferOperationMapping {
  readonly input: RawBufferOperationInput;
  readonly policy: ExecutionPolicy;
}

/**
 * 用已经得到的解析结果组装请求。
 * 成功才有 request。NotFound 与 Ambiguous 只有 code，没有 request。
 * 正常的找不到或不能唯一确定不抛异常。
 */
export type BufferOperationRequestBuild =
  | { readonly ok: true; readonly request: BufferOperationRequest }
  | { readonly ok: false; readonly code: "NotFound" | "Ambiguous" };

/** 聊天本地计划已经写进工具参数的值。距离和单位由调用方传入，本函数不默认 200。 */
export interface ChatLocalBufferParsed {
  /** args.layerId。可以是图层名，也可以是回指或选中图层得到的 id。此处不区分，也不解析。 */
  readonly layerRef: string;
  readonly distance: number;
  readonly unit: BufferDistanceUnit;
  /** 调用方已经决定的布尔值。映射进 ExecutionPolicy，不进请求。 */
  readonly writeKnowledge: boolean;
}

/** 工具参数整理之后的值。MCP map_buffer 与此相同。 */
export interface ToolBufferParsed {
  /** args.layerId。工具表写明可以是图层标识或图层名。此处不解析。 */
  readonly layerRef: string;
  readonly distance: number;
  readonly unit: BufferDistanceUnit;
  readonly outputName?: string;
  /** 只有参数里已经是布尔值才出现。映射进 ExecutionPolicy。 */
  readonly writeKnowledge?: boolean;
}

/** 地图 POST /api/spatial/run 已经取出的缓冲字段。 */
export interface MapHttpBufferParsed {
  /** 下拉框 option value，是图层 id 字符串。此处不把它当成已经解析的身份。 */
  readonly layerId: string;
  readonly distance: number;
  readonly unit: BufferDistanceUnit;
  /** 复选框已经变成的布尔值。映射进 ExecutionPolicy，不进请求。 */
  readonly writeKnowledge: boolean;
}

/** GDL 已经解析出的 BUFFER 语句字段。input 仍是图层名，不是宿主解析后的 id。 */
export interface GdlBufferParsed {
  readonly layerName: string;
  readonly distance: number;
  readonly unit: BufferDistanceUnit;
  readonly outputName: string;
}

function rawBufferMapping(
  sourceLayer: LayerReference,
  distance: number,
  unit: BufferDistanceUnit,
  outputName?: string,
  writeKnowledge?: boolean,
): RawBufferOperationMapping {
  const input: RawBufferOperationInput = {
    operation: "buffer",
    sourceLayer,
    distance,
    unit,
  };
  const policy: ExecutionPolicy = {};
  return {
    input: outputName !== undefined ? { ...input, outputName } : input,
    policy: writeKnowledge !== undefined ? { writeKnowledge } : policy,
  };
}

/** 聊天本地计划的原始输入。原样抄入距离和单位。不查找图层，也不把公里乘成米。 */
export function rawBufferInputFromChatLocal(input: ChatLocalBufferParsed): RawBufferOperationMapping {
  return rawBufferMapping(
    { kind: "name-or-id", text: input.layerRef },
    input.distance,
    input.unit,
    undefined,
    input.writeKnowledge,
  );
}

/**
 * 聊天模型工具参数，以及 MCP map_buffer 经同一套参数整理后的原始输入。
 * 300 与 kilometers 保持 300 kilometers，不乘 1000。不查找图层。
 */
export function rawBufferInputFromToolArgs(input: ToolBufferParsed): RawBufferOperationMapping {
  return rawBufferMapping(
    { kind: "name-or-id", text: input.layerRef },
    input.distance,
    input.unit,
    input.outputName,
    input.writeKnowledge,
  );
}

/** MCP 与工具参数是同一种原始输入，不是另一套解析，也不是最终请求。 */
export const rawBufferInputFromMcp = rawBufferInputFromToolArgs;

/** 地图按钮的原始输入。图层引用固定为 id 字符串。没有结果图层名。不查找图层。 */
export function rawBufferInputFromMapHttp(input: MapHttpBufferParsed): RawBufferOperationMapping {
  return rawBufferMapping(
    { kind: "id", id: input.layerId },
    input.distance,
    input.unit,
    undefined,
    input.writeKnowledge,
  );
}

/** GDL BUFFER 的原始输入。图层引用固定为语句里的图层名。语句没有 writeKnowledge，策略里也不写。不查找图层。 */
export function rawBufferInputFromGdl(input: GdlBufferParsed): RawBufferOperationMapping {
  return rawBufferMapping(
    { kind: "name", name: input.layerName },
    input.distance,
    input.unit,
    input.outputName,
  );
}

/**
 * 只有解析已经成功，或调用方已经拿着图层身份时，才做出 BufferOperationRequest。
 * NotFound 与 Ambiguous 不产生请求。
 * 不调用查找、LayerStore、SpatialService，不读 var/。
 */
export function bufferRequestFromResolution(
  resolved: LayerResolutionResult | LayerResolutionIdentity,
  distance: number,
  unit: BufferDistanceUnit,
  outputName?: string,
): BufferOperationRequestBuild {
  if ("ok" in resolved && !resolved.ok) {
    return { ok: false, code: resolved.code };
  }
  const sourceLayer: LayerResolutionIdentity = {
    layerId: resolved.layerId,
    layerName: resolved.layerName,
  };
  const request: BufferOperationRequest = {
    operation: "buffer",
    sourceLayer,
    distance,
    unit,
  };
  return {
    ok: true,
    request: outputName !== undefined ? { ...request, outputName } : request,
  };
}
