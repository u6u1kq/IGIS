// SPDX-License-Identifier: Apache-2.0

/**
 * V0.7 起地图图层目录就是 SurtGIS 内核的统一图层库。
 * 名字和方法（restore、list、get、collection、insert、rename、remove、exportTo）不变，
 * 另外多了顺序、显隐和样式。磁盘格式兼容 V0.5 的 var/map-layers。
 */
export { LayerStore as MapLayerCatalog, samePath } from "@igis/surtgis";
export type { LayerMeta } from "@igis/surtgis";
