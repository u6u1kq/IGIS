// SPDX-License-Identifier: Apache-2.0

import { guidanceFollowup, guidanceText, guidanceTurnNote } from "@igis/ai-boundary";

/**
 * 系统提示从规范规则入口读取。
 * 引导句只写在智能体规则模块的规范引导（assist/guidance-rules.ts）。
 */
export const GIS_SYSTEM_PROMPT = guidanceText("zh-CN");
export const GIS_SYSTEM_PROMPT_EN = guidanceText("en");
export const FOLLOWUP_LAYER_REMINDER = guidanceFollowup("zh-CN");

const TOOL_DESCRIPTION_EN: Readonly<Record<string, string>> = {
  "list-layers": "List layer names in a GIS file.",
  "get-layer-metadata": "Read layer metadata: geometry type, feature count, and field names.",
  "get-sample-feature": "Read a sample of non-coordinate attributes.",
  "map.buffer": "Buffer a layer by a distance and create a new layer.",
  "map.intersect": "Intersect two layers and create a new layer.",
  "map.clip": "Clip the first layer with the second and create a new layer.",
  "map.query": "Query features by an attribute or a spatial relation. Returns a summary.",
  "map.stats": "Summarize feature count and a numeric field.",
  "map.list": "List layers currently on the map.",
  "map.load": "Load an existing local layer onto the map by id or name.",
  "map.vertices": "Turn each vertex of a line or polygon into a point.",
  "map.lineIntersect": "Create points where lines intersect.",
  "map.transform": "Translate, rotate, or scale a layer. kind is translate, rotate, or scale.",
  "map.nearestOnLine": "Drop each point onto the nearest place on a line or polygon boundary.",
  "map.grid": "Create a rectangular grid over a layer's extent.",
  "map.calculateField": "Write a new field using arithmetic, comparison, and if. No scripts or SQL.",
  "map.join": "Inner-join two layers on equal field values. Geometry comes from the first layer.",
  "map.rasterCast": "Convert a raster to int16, int32, or float32. The raster stays off the map.",
  "map.rasterNoData": "Set the NoData flag on a raster. Pixel values stay unchanged.",
  "map.rasterSmooth": "Smooth a raster with a 3 by 3 mean. NoData is ignored.",
  "map.interpolate": "Interpolate a numeric point field to a raster. algorithm is invdist, nearest, or linear. Returns RMSE and MAE when enough points remain for a hold-out.",
  "map.erase": "Erase the second polygon layer from the first and create a new layer.",
  "map.union": "Union two polygon layers into one geometry.",
  "map.spatialJoin": "Copy polygon fields onto points that fall inside. This is not a field-equality join.",
  "map.viewshed": "Viewshed from the first point of a point layer on an elevation raster. The raster stays off the map.",
  "map.rasterClip": "Clip a raster with a polygon layer. The raster stays off the map.",
  "map.polygonize": "Turn equal raster values into polygons and load them on the map.",
  "map.rasterize": "Burn polygons into a raster. The raster stays off the map.",
  "map.zonal": "Summarize raster values inside each polygon. No new layer.",
  "map.resample": "Resample a raster to a new cell size. The raster stays off the map.",
  "map.rasterIndex": "Compute ndvi, ndwi, or savi from two single-band rasters on the same grid. ndvi and savi take near infrared then red; ndwi takes green then near infrared. No custom formula.",
  "map.focal": "Focal mean. size is 3, 5, or 7.",
  "map.quadtree": "Build a quadtree from points. Cells carry a count and a depth.",
  "map.chart": "Equal-width histogram of one numeric field. Returns bin counts only.",
  "map.kernelDensity": "Gaussian kernel density on a grid. On EPSG:4326 layers distances are great-circle meters and _density is points per square kilometer; unknown CRS uses coordinate units.",
  "map.snapToNetwork": "Snap points onto the nearest line. Both layers must share a CRS.",
  "map.networkDistance": "Shortest distance along a line network from each origin to its nearest destination. Returns min, max, and mean; meters on EPSG:4326, coordinate units on an unknown CRS.",
  "map.serviceArea": "Line edges reachable from points within a distance along the network.",
  "map.aggregateGrid": "Count points in grid cells. Original points are not kept.",
  "map.offsetLine": "Parallel line by GEOS OffsetCurve, without self-intersection at sharp turns. Positive distance is the left side, negative the right. Geographic CRS is refused; reproject first.",
  "map.costCorridor": "Least-cost path and corridor on a cost raster from the first start point to the first end point. The path is loaded as a line layer.",
  "map.classify": "Supervised raster classification with training points. Picks minimum distance, maximum likelihood, or kNN by 5-fold cross-validation and reports a confusion matrix, overall accuracy, and kappa.",
  "map.hotspot": "Getis-Ord Gi* hotspots. With a line layer, neighbors are within a network distance; otherwise within a straight-line distance.",
  "map.gwr": "Geographically weighted regression. Writes local coefficients, standard errors, fitted values, residuals, and local R2. Picks the bandwidth by AICc when none is given.",
  "map.odFlow": "Origin-destination flows by a doubly constrained gravity model. Give beta, or a target mean trip distance to calibrate beta.",
  "map.kAnonymize": "Location k-anonymity by quadtree cloaking. Every output region holds at least k points; original points are not output.",
  "map.dpGrid": "Differentially private counts per grid cell with Laplace noise of scale 1/epsilon. True counts are not output.",
  "map.kriging": "Ordinary kriging of a numeric point field. Needs the local professional model weights: the variogram starts from their prior and is fitted to these points. Reports nugget, sill, range, and leave-one-out errors. Returns unavailable when the weights are not installed. Geographic CRS is refused.",
  "map.watershed": "Watershed delineation on a projected DEM: D8 flow, Priority-Flood depression filling, pour points snapped to the highest accumulation nearby. Stream threshold and snap distance come from the local professional model weights; returns unavailable without them. Basins are loaded as a polygon layer. Large DEMs are computed directly.",
  "map.profile": "Terrain profile along the first line of a line layer, sampled at the cell spacing with bilinear interpolation. Samples are loaded as points with distance and elevation fields. Geographic CRS is refused.",
  "map.cutFill": "Cut and fill between two elevation rasters on the same grid: second minus first, positive is fill. Reports fill, cut, net volume, and areas. Geographic CRS is refused.",
  "map.waterLevel": "Water level minus DEM elevation. Writes a depth raster; cells at or below the water surface are 0. No velocity and no time. Ask when the water level is missing. Geographic CRS is refused.",
  "map.layerStack": "Record bottom-to-top layer order and the vertical gap. The 3D page draws the stack from this record. At least two loaded layers. With fewer layers, record nothing and draw nothing.",
  "map.geologyInputs": "Check geological inputs: a point layer of contacts, a contact field, a numeric dip field, and a numeric azimuth field. Ask if any are missing. This does not build a geological body; map.geologyModel does.",
  "map.rainfallRunoff": "Rainfall runoff on a DEM with the ANUGA shallow-water engine. Each rain scenario (mm/h x hours, e.g. 30x2;60x1) runs separately; the first failure stops the rest. Per output time: max depth, area above the depth threshold, max speed, and a depth raster handle; plus a peak-speed raster. Ask for rain intensity, duration, and Manning's n when missing. Needs a projected metric DEM with no nodata cells. Rain and simulation are at most 24 hours. On a coarse grid the wet area follows the lower cells, so a round hollow can extend along the rows and columns.",
  "map.rainfallLandslide": "Rainfall-induced shallow landslides on a DEM with USGS TRIGRS (infinite slope with 1-D infiltration). Each rain scenario runs separately; the first failure stops the rest. Per output time: minimum factor of safety, area with factor of safety below 1, and a raster handle. Every soil parameter must come from the user; ask for any that are missing. No runoff routing. Needs a projected metric DEM with square cells. Rain is at most 720 hours.",
  "map.geologyModel": "Build a geological body with LoopStructural from the contacts and orientations recorded by map.geologyInputs. Reports bottom-to-top units and their volumes; the 3D page shows the body. Ask for the depth below the lowest contact when missing. No faults. A contact is the base of its unit. Without a DEM the model top is the highest contact, so the top unit has no thickness and its volume is 0; ask for a DEM to see that unit.",
  "map.exportMap": "Export the current map view as one image with a legend and a scale bar.",
  "map.style": "Set fill, outline, width, opacity, a classified color field, or a single label field.",
  "map.reproject": "Reproject a layer. targetCrs must be EPSG:code.",
  "map.area": "Sum polygon areas.",
  "map.length": "Sum line lengths.",
  "map.distance": "Summarize nearest distances between two layers.",
  "map.nearest": "Annotate nearest distance onto a new layer.",
  "map.voronoi": "Create Thiessen polygons from points.",
  "map.dissolve": "Dissolve a layer, optionally by a field.",
  "map.groupStats": "Summarize a numeric field by group, including the minimum.",
};

const PARAM_DESCRIPTION_EN: Readonly<Record<string, string>> = {
  layerId: "Layer id or layer name",
  otherLayerId: "The other layer id or layer name",
  filePath: "Path of a GIS file or directory",
  distance: "Distance. On geographic layers this is meters",
  unit: "meters, kilometers, miles, feet, or degrees",
  outputName: "Optional name for the result layer",
  fieldName: "Field name",
  otherFieldName: "Field name on the second layer",
  expression: "Arithmetic, comparison, or if(condition, yes, no)",
  rasterName: "Raster file name in this conversation, such as dem.tif",
  otherRasterName: "Second raster file name",
  outputType: "int16, int32, or float32",
  noData: "NoData number",
  algorithm: "invdist, nearest, or linear",
  targetCrs: "Target CRS as EPSG:code",
  kind: "translate, rotate, or scale",
  queryKind: "attribute, within, or intersects",
  attributeFilter: "Attribute filter text",
  cellSize: "Cell size, greater than 0",
  op: "add, subtract, multiply, divide, min, or max",
  derivative: "slope, aspect, or hillshade",
  interval: "Contour interval, greater than 0",
  observerHeight: "Observer height above the surface, zero or greater",
  index: "ndvi, ndwi, or savi",
  size: "Neighborhood size: 3, 5, or 7",
  bandwidth: "Bandwidth, greater than 0. Meters on EPSG:4326, otherwise coordinate units; neighbor count for adaptive GWR",
  lineLayerId: "Line layer used as the road network",
  join: "Corner style: round, mitre, or bevel",
  method: "auto, mindist, maxlike, knn1, knn3, knn5, or knn7",
  testFraction: "Share of samples held out for testing, default 0.3",
  predictors: "Predictor fields, comma separated, 1 to 5",
  kernel: "bisquare or gaussian",
  adaptive: "true for a neighbor-count bandwidth, false for a distance bandwidth",
  deterrence: "exp or power",
  beta: "Distance decay parameter, zero or greater",
  targetMean: "Target mean trip distance used to calibrate beta",
  k: "Integer k, at least 2",
  epsilon: "Privacy budget epsilon, greater than 0",
  colorField: "Field used for classified colors. Empty clears it",
  labelField: "Field used as a label. Empty clears it",
};

export function englishToolDescription(name: string, fallback: string): string {
  return TOOL_DESCRIPTION_EN[name] ?? fallback;
}

export function englishParameterDescription(name: string, fallback: string): string {
  return PARAM_DESCRIPTION_EN[name] ?? fallback;
}

function preferenceForPrompt(summary: string | undefined): string {
  if (typeof summary !== "string") return "";
  return summary.trim().slice(0, 1600);
}

/** 系统提示附上已保存的偏好。偏好不是这一轮的任务。 */
export function buildGisSystemPrompt(memorySummary?: string, locale?: "zh-CN" | "en"): string {
  const base = guidanceText(locale);
  const preference = preferenceForPrompt(memorySummary);
  if (preference === "") return base;
  const label = locale === "en"
    ? "Saved preferences, not this turn's task:"
    : "用户保存的偏好，不是这一轮的任务：";
  return `${base}\n${label}\n${preference}`;
}

export function followupReminder(locale?: "zh-CN" | "en"): string {
  return guidanceFollowup(locale);
}

export { guidanceTurnNote };
