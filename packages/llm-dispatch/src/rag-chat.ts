// SPDX-License-Identifier: Apache-2.0

import type { MapLayerContext } from "./layer-context.js";
import { runLlmToolCallLoop } from "./loop.js";
import type { ToolLoopOptions, ToolLoopResult } from "./loop.js";

export interface AssistantTurnOptions extends ToolLoopOptions {
  readonly question: string;
  readonly retrievedTexts?: readonly string[];
  readonly mapLayers?: readonly MapLayerContext[];
  /** 上一轮助手在澄清时对应的用户指令。不含坐标。 */
  readonly priorInstruction?: string;
  /** 界面当前选中的图层。不含坐标。 */
  readonly selectedLayer?: MapLayerContext | null;
  /** 触发这轮计划的用户原句。不含坐标。 */
  readonly originalText?: string;
  /** 本地没填满时抽出的部分实体。不含坐标和密钥。 */
  readonly partialEntities?: {
    readonly intentFragments: readonly string[];
    readonly layerCandidates: readonly string[];
    readonly numbers: readonly number[];
  };
  /** 未完成计划的文字摘要。不含坐标。 */
  readonly pendingSummary?: string;
  readonly releaseOrdinaryGeometry?: boolean;
  readonly unrestricted?: boolean;
}

/** 把用户问题交给工具循环。检索自由文本不拼进模型指令。 */
export function runAssistantTurn(options: AssistantTurnOptions): Promise<ToolLoopResult> {
  if ((options.retrievedTexts?.length ?? 0) > 0) {
    // 检索正文是自由文本，不进入模型载荷。本地检索结果仍由调用方保存。
  }
  return runLlmToolCallLoop(options, {
    instruction: options.question,
    metadata: [],
    kgHits: [],
    mapLayers: options.mapLayers ?? [],
    ...(typeof options.priorInstruction === "string" && options.priorInstruction.trim() !== ""
      ? { priorInstruction: options.priorInstruction.trim() }
      : {}),
    ...(options.locale === "en" ? { locale: "en" as const } : {}),
    ...(options.selectedLayer ? { selectedLayer: options.selectedLayer } : {}),
    ...(typeof options.originalText === "string" && options.originalText.trim() !== "" ? { originalText: options.originalText.trim() } : {}),
    ...(options.unrestricted === true || !options.partialEntities ? {} : { partialEntities: options.partialEntities }),
    ...(typeof options.pendingSummary === "string" && options.pendingSummary.trim() !== "" ? { pendingSummary: options.pendingSummary.trim() } : {}),
    ...(options.releaseOrdinaryGeometry === true ? { releaseOrdinaryGeometry: true } : {}),
    ...(options.unrestricted === true ? { unrestricted: true } : {}),
  });
}
