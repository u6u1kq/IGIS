// SPDX-License-Identifier: Apache-2.0

/**
 * 一条对话的图层目录。名字和方法（restore、list、get、collection、insert、rename、remove、exportTo）不变，
 * 另外有顺序、显隐和样式。文件是每层一个 geojson、一个 meta，加一份 layer-store.json。
 */
export { LayerStore as MapLayerCatalog, samePath } from "@igis/surtgis";
export type { LayerMeta } from "@igis/surtgis";
