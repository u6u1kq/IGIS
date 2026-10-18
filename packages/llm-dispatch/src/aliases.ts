// SPDX-License-Identifier: Apache-2.0

/**
 * 工具名与参数名的别名。旧名字继续可用，调度时折成登记表里的正式名。
 * 这里不执行 GIS，也不读几何。
 */
/**
 * 发给模型的 function.name。只含字母、数字、下划线和连字符。
 * 内部登记名仍带点号，例如 map.buffer。
 */
export const API_TOOL_NAMES: Readonly<Record<string, string>> = {
  "list-layers": "list_layers",
  "get-layer-metadata": "get_layer_metadata",
  "get-sample-feature": "get_sample_feature",
  "io.read": "read_gis_file",
  "io.listLayers": "list_memory_layers",
  "map.buffer": "run_buffer",
  "map.intersect": "run_intersect",
  "map.clip": "run_clip",
  "map.query": "query_features",
  "map.stats": "summarize_layer",
  "map.list": "list_map_layers",
  "map.load": "load_map_layer",
  "map.style": "set_layer_style",
  "map.setVisibility": "set_layer_visibility",
  "map.setOrder": "set_layer_order",
  "map.zoomToLayer": "zoom_to_layer",
  "map.exportGeoJson": "export_geojson",
  "map.vertices": "vertices_to_points",
  "map.lineIntersect": "line_intersections",
  "map.transform": "transform_geometry",
  "map.nearestOnLine": "nearest_on_line",
  "map.grid": "square_grid",
  "map.calculateField": "calculate_field",
  "map.join": "attribute_join",
  "map.rasterCast": "raster_cast",
  "map.rasterNoData": "raster_nodata",
  "map.rasterSmooth": "raster_smooth",
  "map.interpolate": "interpolate_points",
  "map.erase": "erase_overlay",
  "map.union": "union_overlay",
  "map.spatialJoin": "spatial_join",
  "map.viewshed": "viewshed",
  "map.rasterClip": "clip_raster",
  "map.polygonize": "polygonize_raster",
  "map.rasterize": "rasterize_polygons",
  "map.zonal": "zonal_stats",
  "map.resample": "resample_raster",
  "map.rasterIndex": "raster_index",
  "map.focal": "focal_stats",
  "map.quadtree": "quadtree",
  "map.chart": "chart_bins",
  "map.kernelDensity": "kernel_density",
  "map.snapToNetwork": "snap_to_network",
  "map.networkDistance": "network_distance",
  "map.serviceArea": "service_area",
  "map.aggregateGrid": "aggregate_grid",
  "map.exportMap": "export_map",
  "map.offsetLine": "offset_line",
  "map.costCorridor": "cost_corridor",
  "map.classify": "classify_raster",
  "map.hotspot": "hotspot_gi",
  "map.gwr": "gwr_regression",
  "map.odFlow": "od_flow",
  "map.kAnonymize": "k_anonymize",
  "map.dpGrid": "dp_grid_count",
  "map.kriging": "kriging",
  "map.watershed": "watershed",
  "map.profile": "terrain_profile",
  "map.cutFill": "cut_fill",
  "map.waterLevel": "water_level",
  "map.layerStack": "layer_stack",
  "map.geologyInputs": "geology_inputs",
  "map.rainfallRunoff": "rainfall_runoff",
  "map.rainfallLandslide": "rainfall_landslide",
  "map.geologyModel": "geology_model",
  "gdl.run": "run_gdl",
  "gdl.describe": "describe_gdl",
  "map.delete": "delete_layer",
  "map.clearAll": "clear_all_layers",
  "map.dropDatabase": "delete_database",
};

const API_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** 把任意工具名收成接口接受的名称。未知名字去掉点号和其他非法字符。 */
export function toApiToolName(name: string): string {
  const trimmed = name.trim();
  const internal = TOOL_ALIASES[trimmed] ?? TOOL_ALIASES[trimmed.toLowerCase()] ?? trimmed;
  const mapped = API_TOOL_NAMES[internal] ?? API_TOOL_NAMES[trimmed];
  if (mapped) return mapped;
  const cleaned = trimmed.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned === "" ? "tool" : cleaned;
}

export function assertApiToolName(name: string): string {
  if (!API_NAME_PATTERN.test(name)) {
    throw new Error(`工具名不符合接口要求：${name}`);
  }
  return name;
}

export const TOOL_ALIASES: Readonly<Record<string, string>> = {
  list_layers: "list-layers",
  get_layer_metadata: "get-layer-metadata",
  get_sample_feature: "get-sample-feature",
  read_gis_file: "io.read",
  list_memory_layers: "io.listLayers",
  run_buffer: "map.buffer",
  run_intersect: "map.intersect",
  run_clip: "map.clip",
  query_features: "map.query",
  summarize_layer: "map.stats",
  list_map_layers: "map.list",
  load_map_layer: "map.load",
  set_layer_style: "map.style",
  set_layer_visibility: "map.setVisibility",
  set_layer_order: "map.setOrder",
  zoom_to_layer: "map.zoomToLayer",
  export_geojson: "map.exportGeoJson",
  vertices_to_points: "map.vertices",
  "map.vertices": "map.vertices",
  line_intersections: "map.lineIntersect",
  "map.lineIntersect": "map.lineIntersect",
  transform_geometry: "map.transform",
  "map.transform": "map.transform",
  nearest_on_line: "map.nearestOnLine",
  "map.nearestOnLine": "map.nearestOnLine",
  square_grid: "map.grid",
  "map.grid": "map.grid",
  calculate_field: "map.calculateField",
  "map.calculateField": "map.calculateField",
  attribute_join: "map.join",
  "map.join": "map.join",
  raster_cast: "map.rasterCast",
  "map.rasterCast": "map.rasterCast",
  raster_nodata: "map.rasterNoData",
  "map.rasterNoData": "map.rasterNoData",
  raster_smooth: "map.rasterSmooth",
  "map.rasterSmooth": "map.rasterSmooth",
  interpolate_points: "map.interpolate",
  "map.interpolate": "map.interpolate",
  erase_overlay: "map.erase",
  "map.erase": "map.erase",
  union_overlay: "map.union",
  "map.union": "map.union",
  spatial_join: "map.spatialJoin",
  "map.spatialJoin": "map.spatialJoin",
  viewshed: "map.viewshed",
  "map.viewshed": "map.viewshed",
  clip_raster: "map.rasterClip",
  "map.rasterClip": "map.rasterClip",
  polygonize_raster: "map.polygonize",
  "map.polygonize": "map.polygonize",
  rasterize_polygons: "map.rasterize",
  "map.rasterize": "map.rasterize",
  zonal_stats: "map.zonal",
  "map.zonal": "map.zonal",
  resample_raster: "map.resample",
  "map.resample": "map.resample",
  raster_index: "map.rasterIndex",
  "map.rasterIndex": "map.rasterIndex",
  focal_stats: "map.focal",
  "map.focal": "map.focal",
  quadtree: "map.quadtree",
  "map.quadtree": "map.quadtree",
  chart_bins: "map.chart",
  "map.chart": "map.chart",
  kernel_density: "map.kernelDensity",
  "map.kernelDensity": "map.kernelDensity",
  snap_to_network: "map.snapToNetwork",
  "map.snapToNetwork": "map.snapToNetwork",
  network_distance: "map.networkDistance",
  "map.networkDistance": "map.networkDistance",
  service_area: "map.serviceArea",
  "map.serviceArea": "map.serviceArea",
  aggregate_grid: "map.aggregateGrid",
  "map.aggregateGrid": "map.aggregateGrid",
  export_map: "map.exportMap",
  "map.exportMap": "map.exportMap",
  offset_line: "map.offsetLine",
  "map.offsetLine": "map.offsetLine",
  cost_corridor: "map.costCorridor",
  "map.costCorridor": "map.costCorridor",
  classify_raster: "map.classify",
  "map.classify": "map.classify",
  hotspot_gi: "map.hotspot",
  "map.hotspot": "map.hotspot",
  gwr_regression: "map.gwr",
  "map.gwr": "map.gwr",
  od_flow: "map.odFlow",
  "map.odFlow": "map.odFlow",
  k_anonymize: "map.kAnonymize",
  "map.kAnonymize": "map.kAnonymize",
  dp_grid_count: "map.dpGrid",
  "map.dpGrid": "map.dpGrid",
  kriging: "map.kriging",
  "map.kriging": "map.kriging",
  watershed: "map.watershed",
  "map.watershed": "map.watershed",
  terrain_profile: "map.profile",
  "map.profile": "map.profile",
  cut_fill: "map.cutFill",
  "map.cutFill": "map.cutFill",
  water_level: "map.waterLevel",
  "map.waterLevel": "map.waterLevel",
  layer_stack: "map.layerStack",
  "map.layerStack": "map.layerStack",
  geology_inputs: "map.geologyInputs",
  "map.geologyInputs": "map.geologyInputs",
  rainfall_runoff: "map.rainfallRunoff",
  "map.rainfallRunoff": "map.rainfallRunoff",
  rainfall_landslide: "map.rainfallLandslide",
  "map.rainfallLandslide": "map.rainfallLandslide",
  geology_model: "map.geologyModel",
  "map.geologyModel": "map.geologyModel",
  run_gdl: "gdl.run",
  describe_gdl: "gdl.describe",
  buffer: "map.buffer",
  "vector.buffer": "map.buffer",
  "map.buffer": "map.buffer",
  intersect: "map.intersect",
  "vector.intersect": "map.intersect",
  "map.intersect": "map.intersect",
  clip: "map.clip",
  "vector.clip": "map.clip",
  "map.clip": "map.clip",
  query: "map.query",
  "map.queryFeatures": "map.query",
  "map.query": "map.query",
  stats: "map.stats",
  "map.statistics": "map.stats",
  "map.stats": "map.stats",
  "listLayers": "list-layers",
  "map.listLayers": "map.list",
  "map.list_layers": "map.list",
  "getLayerMetadata": "get-layer-metadata",
  "getSampleFeature": "get-sample-feature",
  "map.setStyle": "map.style",
  "map.updateStyle": "map.style",
  "map.hide": "map.setVisibility",
  "map.show": "map.setVisibility",
  "map.zoom": "map.zoomToLayer",
  "map.fit": "map.zoomToLayer",
  "map.export": "map.exportGeoJson",
  "map.exportGeoJSON": "map.exportGeoJson",
  "map.loadFile": "map.load",
  "gdl.runScript": "gdl.run",
  "gdl.summary": "gdl.describe",
  delete_layer: "map.delete",
  clear_all_layers: "map.clearAll",
  delete_database: "map.dropDatabase",
  "map.delete": "map.delete",
  "map.clearAll": "map.clearAll",
  "map.dropDatabase": "map.dropDatabase",
};

const LAYER_ID_KEYS = ["layerId", "layer", "layer_id", "layerName", "layer_name", "name", "inputLayer"] as const;
const OTHER_LAYER_KEYS = ["otherLayerId", "other", "other_layer", "otherLayer", "clipLayer", "overlay", "mask"] as const;

/** 各正式参数名可接受的别名。出现多个时保留正式名，否则把别名抄过去。 */
export const ARG_ALIASES: Readonly<Record<string, readonly string[]>> = {
  layerId: LAYER_ID_KEYS,
  otherLayerId: OTHER_LAYER_KEYS,
  filePath: ["filePath", "file_path", "path", "file"],
  absolutePath: ["absolutePath", "absolute_path", "filePath", "path", "file"],
  destinationPath: ["destinationPath", "destination", "outputPath", "output", "saveAs"],
  distance: ["distance", "dist", "radius"],
  unit: ["unit", "units"],
  outputName: ["outputName", "output", "as", "resultName", "result_name"],
  queryKind: ["queryKind", "query_kind", "kind"],
  attributeFilter: ["attributeFilter", "filter", "where"],
  fieldName: ["fieldName", "field", "field_name"],
  writeKnowledge: ["writeKnowledge", "write_knowledge"],
  visible: ["visible", "show"],
  fill: ["fill", "fillColor", "color"],
  outline: ["outline", "outlineColor", "stroke"],
  width: ["width", "lineWidth"],
  opacity: ["opacity", "alpha"],
  place: ["place", "position"],
  script: ["script", "gdl", "text"],
  handle: ["handle"],
  layerName: ["layerName", "layer_name", "name", "layer"],
  targetCrs: ["targetCrs", "target_crs", "crs", "toCrs"],
  format: ["format", "targetFormat", "target_format"],
  derivative: ["derivative", "demDerivative", "dem_derivative"],
  interval: ["interval", "contourInterval", "contour_interval"],
  op: ["op", "operator"],
  rasterName: ["rasterName", "raster_name", "raster", "fileName", "file_name"],
  otherRasterName: ["otherRasterName", "other_raster_name", "otherRaster", "secondRaster"],
  columns: ["columns", "cols"],
  rows: ["rows"],
  groupField: ["groupField", "group_field", "groupBy", "group_by"],
  mapping: ["mapping", "reclassMap", "reclass"],
  tolerance: ["tolerance", "tol", "simplifyTolerance"],
  target: ["target", "convertTo", "convert_to"],
  limit: ["limit", "maxPairs", "max_pairs", "cap"],
};

export function canonicalToolName(name: string): string {
  const trimmed = name.trim();
  const hit = TOOL_ALIASES[trimmed] ?? TOOL_ALIASES[trimmed.toLowerCase()];
  if (hit) return hit;
  // 通用回转：接口名（map_voronoi）折回内部名（map.voronoi），保留大小写。
  // 手工别名表覆盖不到的新工具也能走通回程，不再依赖逐个登记。
  const prefixed = /^(map|gdl|io)_/.exec(trimmed);
  if (prefixed) return `${prefixed[1]}.${trimmed.slice(prefixed[0].length)}`;
  return trimmed;
}

export function isKnownArgAlias(key: string): boolean {
  const lower = key.toLowerCase();
  for (const aliases of Object.values(ARG_ALIASES)) {
    if (aliases.some((item) => item.toLowerCase() === lower || item === key)) return true;
  }
  return false;
}

export function pickAliasedValue(record: Readonly<Record<string, unknown>>, names: readonly string[]): unknown {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(record, name) && record[name] !== undefined) return record[name];
  }
  const lower = Object.fromEntries(Object.keys(record).map((key) => [key.toLowerCase(), record[key]]));
  for (const name of names) {
    const hit = lower[name.toLowerCase()];
    if (hit !== undefined) return hit;
  }
  return undefined;
}
