// SPDX-License-Identifier: Apache-2.0

/** 发给模型的图层摘要。坐标系种类和长度单位是事实。几何只在使用者声明出站之后附上。 */
export interface MapLayerContext {
  readonly layerId: string;
  readonly layerName: string;
  readonly geometryKind: string;
  readonly featureCount: number;
  readonly fieldNames: readonly string[];
  readonly crsLabel: string;
  readonly crsKind?: string;
  readonly linearUnit?: string;
  readonly visible: boolean;
  readonly order: number;
  readonly fill?: string;
  readonly outline?: string;
  readonly features?: readonly unknown[];
}

/**
 * 只保留当前对话地图范围里的图层。
 * 范围为空时返回空列表，不把图层库全集交给模型。
 */
export function layersForConversationScope<T extends { readonly layerId: string }>(
  layers: readonly T[],
  scopeLayerIds: readonly string[],
): T[] {
  const allowed = new Set(scopeLayerIds.filter((id) => id.trim() !== ""));
  return layers.filter((layer) => allowed.has(layer.layerId));
}

export function formatMapLayerContext(layers: readonly MapLayerContext[]): readonly MapLayerContext[] {
  return layers.map((layer, index) => ({
    layerId: layer.layerId,
    layerName: layer.layerName,
    geometryKind: layer.geometryKind,
    featureCount: layer.featureCount,
    fieldNames: [...layer.fieldNames],
    crsLabel: layer.crsLabel,
    ...(typeof layer.crsKind === "string" && layer.crsKind !== "" ? { crsKind: layer.crsKind } : {}),
    ...(typeof layer.linearUnit === "string" && layer.linearUnit !== "" ? { linearUnit: layer.linearUnit } : {}),
    visible: layer.visible,
    order: Number.isFinite(layer.order) ? layer.order : index,
    ...(typeof layer.fill === "string" ? { fill: layer.fill } : {}),
    ...(typeof layer.outline === "string" ? { outline: layer.outline } : {}),
    ...(Array.isArray(layer.features) ? { features: layer.features } : {}),
  }));
}

/** 从无坐标图层摘要里挑出当前选中层。对不上则视为未选中。 */
export function formatSelectedLayer(
  layers: readonly MapLayerContext[],
  selectedLayerId?: string | null,
): MapLayerContext | null {
  const id = typeof selectedLayerId === "string" ? selectedLayerId.trim() : "";
  if (id === "") return null;
  const formatted = formatMapLayerContext(layers);
  return formatted.find((layer) => layer.layerId === id || layer.layerName === id) ?? null;
}
