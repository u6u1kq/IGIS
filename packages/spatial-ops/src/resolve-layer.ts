// SPDX-License-Identifier: Apache-2.0

import type { LayerMeta } from "./catalog.js";

export interface LayerCandidate {
  readonly layerId: string;
  readonly layerName: string;
  readonly geometryKind: string;
  readonly featureCount: number;
}

export type LayerResolveHit =
  | { readonly status: "ok"; readonly layerId: string; readonly layerName: string }
  | { readonly status: "missing"; readonly query: string; readonly candidates: readonly LayerCandidate[] }
  | { readonly status: "ambiguous"; readonly query: string; readonly candidates: readonly LayerCandidate[] }
  | { readonly status: "empty"; readonly query: string };

export interface LayerCatalogView {
  list(): readonly LayerMeta[];
}

function candidateOf(layer: LayerMeta): LayerCandidate {
  return {
    layerId: layer.layerId,
    layerName: layer.layerName,
    geometryKind: layer.geometryKind,
    featureCount: layer.featureCount,
  };
}

function unique(layers: readonly LayerMeta[]): LayerMeta[] {
  const seen = new Set<string>();
  const result: LayerMeta[] = [];
  for (const layer of layers) {
    if (seen.has(layer.layerId)) continue;
    seen.add(layer.layerId);
    result.push(layer);
  }
  return result;
}

function payload(status: "missing" | "ambiguous", query: string, layers: readonly LayerMeta[]): LayerResolveHit {
  return { status, query, candidates: unique(layers).slice(0, 12).map(candidateOf) };
}

/**
 * 按图层标识或名称解析。精确匹配优先；多个同名或都像这个名字时返回候选，不自行挑选。
 */
export function resolveLayerRef(catalog: LayerCatalogView, query: string): LayerResolveHit {
  const text = query.trim();
  if (text === "") return { status: "empty", query: text };
  const layers = catalog.list();
  const byId = layers.find((layer) => layer.layerId === text);
  if (byId) return { status: "ok", layerId: byId.layerId, layerName: byId.layerName };
  const exact = layers.filter((layer) => layer.layerName === text);
  if (exact.length === 1 && exact[0]) return { status: "ok", layerId: exact[0].layerId, layerName: exact[0].layerName };
  if (exact.length > 1) return payload("ambiguous", text, exact);
  const folded = text.toLowerCase();
  const ignoreCase = layers.filter((layer) => layer.layerName.toLowerCase() === folded);
  if (ignoreCase.length === 1 && ignoreCase[0]) {
    return { status: "ok", layerId: ignoreCase[0].layerId, layerName: ignoreCase[0].layerName };
  }
  if (ignoreCase.length > 1) return payload("ambiguous", text, ignoreCase);
  if (text.length < 2) return payload("missing", text, layers);
  // 只做"图层名包含查询串"的单向模糊：反向包含（查询串包含图层名）会让"湖泊_缓冲"静默命中"湖泊"。
  const contains = layers.filter((layer) => layer.layerName.includes(text));
  if (contains.length === 1 && contains[0]) return { status: "ok", layerId: contains[0].layerId, layerName: contains[0].layerName };
  if (contains.length > 1) return payload("ambiguous", text, contains);
  return payload("missing", text, layers);
}

export function layerResolveMessage(hit: LayerResolveHit): string {
  if (hit.status === "ok") return `已匹配图层 ${hit.layerName}。`;
  if (hit.status === "empty") return "没有填写图层名或图层标识。";
  const listed = hit.candidates.map((item) => `${item.layerName}（${item.layerId}，${item.geometryKind}，${item.featureCount} 个要素）`).join("、");
  if (hit.status === "ambiguous") {
    return listed === ""
      ? `图层「${hit.query}」有多个候选，请改用完整名称或图层标识。`
      : `图层「${hit.query}」有多个候选：${listed}。请改用完整名称或图层标识。`;
  }
  return listed === ""
    ? `找不到图层「${hit.query}」。请先把图层载入地图。`
    : `找不到图层「${hit.query}」。当前图层：${listed}。`;
}

export function layerResolvePayload(hit: Exclude<LayerResolveHit, { status: "ok" }>): Record<string, unknown> {
  return {
    ok: false,
    code: hit.status === "ambiguous" ? "ambiguous-layer" : "unknown-layer",
    message: layerResolveMessage(hit),
    query: hit.status === "empty" ? "" : hit.query,
    candidates: hit.status === "empty" ? [] : hit.candidates,
  };
}
