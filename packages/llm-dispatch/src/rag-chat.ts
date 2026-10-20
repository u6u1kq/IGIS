// SPDX-License-Identifier: Apache-2.0

import type { MapLayerContext } from "./layer-context.js";
import { runLlmToolCallLoop } from "./loop.js";
import type { ToolLoopOptions, ToolLoopResult } from "./loop.js";

export interface AssistantTurnOptions extends ToolLoopOptions {
  readonly question: string;
  readonly retrievedTexts?: readonly string[];
  readonly mapLayers?: readonly MapLayerContext[];
  /** 当前对话已有的栅格：文件名和栅格编号。 */
  readonly rasterIds?: readonly { readonly fileName: string; readonly id: string }[];
  /** 上一轮助手在澄清时对应的用户指令。 */
  readonly priorInstruction?: string;
  /** 界面当前选中的图层。 */
  readonly selectedLayer?: MapLayerContext | null;
  /** 触发这轮计划的用户原句。 */
  readonly originalText?: string;
  /** 本地没填满时抽出的部分实体。 */
  readonly partialEntities?: {
    readonly intentFragments: readonly string[];
    readonly layerCandidates: readonly string[];
    readonly numbers: readonly number[];
  };
  /** 未完成计划的文字摘要。 */
  readonly pendingSummary?: string;
  readonly releaseOrdinaryGeometry?: boolean;
  readonly unrestricted?: boolean;
  readonly allowUserText?: boolean;
  readonly recentResults?: string;
  readonly dialogue?: string;
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
    ...(options.rasterIds && options.rasterIds.length > 0 ? { rasterIds: options.rasterIds } : {}),
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
    ...(options.allowUserText === true ? { allowUserText: true } : {}),
    ...(typeof options.recentResults === "string" && options.recentResults.trim() !== "" ? { recentResults: options.recentResults } : {}),
    ...(typeof options.dialogue === "string" && options.dialogue.trim() !== "" ? { dialogue: options.dialogue } : {}),
  });
}
