// SPDX-License-Identifier: Apache-2.0

import type { KgHit } from "@igis/shared-types";
import type { RagMetadataDocument } from "@igis/rag-meta";
import type { ExternalLlmConfig, LlmProviderId, LlmToolRequest } from "@igis/shared-types";
import type { MapLayerContext } from "./layer-context.js";

export interface DispatchInput {
  readonly instruction: string;
  readonly metadata: readonly RagMetadataDocument[];
  readonly kgHits: readonly KgHit[];
  /** 当前地图图层摘要。 */
  readonly mapLayers?: readonly MapLayerContext[];
  /** 当前对话已有的栅格：文件名和栅格编号。 */
  readonly rasterIds?: readonly { readonly fileName: string; readonly id: string }[];
  /** 上一轮助手在澄清时，对应的上一句用户指令。 */
  readonly priorInstruction?: string;
  /** 这条对话已经存下的来回记录。当前这句不在里面。 */
  readonly dialogue?: string;
  /** 界面当前选中的图层。未选中则为空。 */
  readonly selectedLayer?: MapLayerContext | null;
  /** 用户原句。本地解析失败时必须随请求交给模型。 */
  readonly originalText?: string;
  /** 本地解析抽出的意图片段、图层名候选和数字。 */
  readonly partialEntities?: {
    readonly intentFragments: readonly string[];
    readonly layerCandidates: readonly string[];
    readonly numbers: readonly number[];
  };
  /** 未完成的 PendingPlan 摘要。 */
  readonly pendingSummary?: string;
  /** 使用者已声明这是有权处理的普通工程数据。为真时几何和坐标可以进入模型。 */
  readonly releaseOrdinaryGeometry?: boolean;
  /** 完全不挡。题面、路径、坐标和几何不再被筛掉，模型也可以把它们写进工具参数。 */
  readonly unrestricted?: boolean;
  /** 用户在对话里选择原样发送。这句话和工具结果里的坐标、路径留下，密钥仍然去掉。 */
  readonly allowUserText?: boolean;
  /** 上一轮已经发给模型的工具结果。只在原样发送时附上。 */
  readonly recentResults?: string;
  /** 界面语言。不进入模型可见字段名，只决定提示用中文还是英语。 */
  readonly locale?: "zh-CN" | "en";
}

/**
 * 调度结果是工具请求。模型不直接生成几何。
 * providerId 选择 deepseek、qwen、grok 或 local。
 */
export interface LlmDispatch {
  readonly providerId: LlmProviderId;
  readonly llm: ExternalLlmConfig;
  plan(input: DispatchInput): Promise<LlmToolRequest>;
}
