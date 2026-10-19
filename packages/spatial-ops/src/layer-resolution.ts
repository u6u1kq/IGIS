// SPDX-License-Identifier: Apache-2.0

/**
 * LayerReference 将来解析一步的结果形状，以及把已经得到的查找结果映射成该形状的纯函数。
 * 映射不验证请求，不查权限，不执行 GIS，不创建、删除或更新图层，不写 RAG 或审计。
 * 本文件没有查找函数。不调用 LayerStore，不读对话的图层目录。
 * 运行时不要导入本文件。
 */

import type { LayerReference } from "./buffer-operation.js";
import type { LayerMeta } from "./catalog.js";
import type { LayerResolveHit } from "./resolve-layer.js";

/**
 * 解析阶段的草案形状：已经写好的指针，加上这一步将来交出的结果。
 * 不是 ResolutionService，也不是查找函数。
 */
export interface LayerResolution {
  readonly reference: LayerReference;
  readonly result: LayerResolutionResult;
}

/**
 * 成功时能点名的那一层。
 * 现有命中（resolveLayerRef 的 ok、GDL 宿主的 resolveLayer、LayerStore.get / findByName）
 * 都同时带有图层标识和显示名。匹配是靠 id、精确名、忽略大小写还是包含，成功值里不记录。
 */
export interface LayerResolutionIdentity {
  readonly layerId: string;
  readonly layerName: string;
}

/**
 * 将来解析 LayerReference 的返回值。对不上一层，或不能收成唯一一层时，用这个值表示，不抛异常。
 * 没有几何、坐标、GeoJSON、Feature。没有 planned / running / completed / failed / rollback。
 *
 * - 成功：收成唯一身份。layerId 是图层库里的标识，不是用户写下的名字。
 * - NotFound：引用格式已经合格，图层库里没有对应的层。
 * - Ambiguous：一名对应多层，不能收成唯一 layerId。
 *   只有查找结果里明确带了多名候选时才映射成 Ambiguous。
 *   LayerStore.findByName 不会返回多名，它取叠放最靠上的一层。那一条命中映射为成功，不编造 Ambiguous。
 *
 * 不包含 EmptyReference。空白引用由 Validation 的 sourceLayer.empty 拒绝，这里不重复。
 * 不包含 InvalidReferenceKind。非法 kind 由 Validation 的 sourceLayer.kind 拒绝，这里不重复。
 */
export type LayerResolutionResult =
  | { readonly ok: true; readonly layerId: string; readonly layerName: string }
  | { readonly ok: false; readonly code: "NotFound" }
  | {
      readonly ok: false;
      readonly code: "Ambiguous";
      readonly candidates: readonly LayerResolutionIdentity[];
    };

/**
 * 把已经发生的查找结果收成 LayerResolutionResult。相同输入得到相同输出。
 * 不查找，不读图层库，不挑「最上面一层」。
 *
 * resolveLayerRef 的返回值是 LayerResolveHit。这里用这个类型，不另造 LookupResult。
 * `status: "empty"` 不在参数里：空白引用属于 Validation，结果类型没有 Empty 码，不把它写成 NotFound。
 *
 * findByName / get 的返回值是 LayerMeta | null，也是已有查找结果：
 * - null → NotFound
 * - 一条 LayerMeta → 成功，只留 layerId 和 layerName
 *   这条里没有其余同名层。AMBIGUITY INFORMATION LOST IN LEGACY LOOKUP。
 *   不能从一条结果反推被丢掉的候选，所以不得编造 Ambiguous。
 */
export function adaptLayerLookup(
  hit: Exclude<LayerResolveHit, { readonly status: "empty" }>,
): LayerResolutionResult;
export function adaptLayerLookup(hit: LayerMeta | null): LayerResolutionResult;
export function adaptLayerLookup(
  hit: Exclude<LayerResolveHit, { readonly status: "empty" }> | LayerMeta | null,
): LayerResolutionResult {
  if (hit === null) return { ok: false, code: "NotFound" };
  if (!("status" in hit)) {
    return { ok: true, layerId: hit.layerId, layerName: hit.layerName };
  }
  switch (hit.status) {
    case "ok":
      return { ok: true, layerId: hit.layerId, layerName: hit.layerName };
    case "missing":
      return { ok: false, code: "NotFound" };
    case "ambiguous":
      return {
        ok: false,
        code: "Ambiguous",
        candidates: hit.candidates.map((item) => ({
          layerId: item.layerId,
          layerName: item.layerName,
        })),
      };
    default: {
      const unexpected: never = hit;
      throw new Error(
        `adaptLayerLookup 不接收 status ${String((unexpected as { readonly status?: unknown }).status)}`,
      );
    }
  }
}

export type { LayerReference };
