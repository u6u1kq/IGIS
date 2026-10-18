// SPDX-License-Identifier: Apache-2.0

import type { ToolName } from "@igis/shared-types";
import { assertApiToolName, canonicalToolName, toApiToolName } from "./aliases.js";
import { englishParameterDescription, englishToolDescription } from "./gis-prompt.js";

export interface ToolParameterSpec {
  readonly name: string;
  readonly type: "string" | "number" | "boolean";
  readonly required: boolean;
  readonly description: string;
}

/** 调度层可见的工具。真正的 GIS 动作由注入的适配器执行。空间分析也登记在这里，参数里不放坐标。 */
export interface GisToolDefinition {
  readonly name: ToolName;
  readonly description: string;
  readonly parameters: readonly ToolParameterSpec[];
}

export const GIS_QUERY_TOOL_NAMES = ["list-layers", "get-layer-metadata", "get-sample-feature"] as const;

export const MAP_SPATIAL_TOOL_NAMES = [
  "map.buffer",
  "map.intersect",
  "map.clip",
  "map.query",
  "map.stats",
  "map.list",
  "map.load",
  "map.style",
  "map.setVisibility",
  "map.setOrder",
  "map.zoomToLayer",
  "map.exportGeoJson",
  "map.area",
  "map.length",
  "map.distance",
  "map.nearest",
  "map.convert",
  "map.dissolve",
  "map.merge",
  "map.simplify",
  "map.groupStats",
  "map.reclassify",
  "map.qualityCheck",
  "map.splitByGrid",
  "map.voronoi",
  "map.convexHull",
  "map.minBBox",
  "map.centroid",
  "map.bearing",
  "map.exportCoordinates",
  "map.makeValid",
  "map.reproject",
  "map.convertFormat",
  "map.rasterInfo",
  "map.demDerivative",
  "map.rasterCalc",
  "map.contour",
  "map.splitLine",
  "map.explode",
  "map.vertices",
  "map.lineIntersect",
  "map.transform",
  "map.nearestOnLine",
  "map.grid",
  "map.splitPolygon",
  "map.spatialAggregate",
  "map.distanceMatrix",
  "map.nearestExact",
  "map.calculateField",
  "map.join",
  "map.rasterCast",
  "map.rasterNoData",
  "map.rasterSmooth",
  "map.interpolate",
  "map.erase",
  "map.union",
  "map.spatialJoin",
  "map.viewshed",
  "map.rasterClip",
  "map.polygonize",
  "map.rasterize",
  "map.zonal",
  "map.resample",
  "map.rasterIndex",
  "map.focal",
  "map.quadtree",
  "map.chart",
  "map.kernelDensity",
  "map.snapToNetwork",
  "map.networkDistance",
  "map.serviceArea",
  "map.aggregateGrid",
  "map.exportMap",
  "map.offsetLine",
  "map.costCorridor",
  "map.classify",
  "map.hotspot",
  "map.gwr",
  "map.odFlow",
  "map.kAnonymize",
  "map.dpGrid",
  "map.kriging",
  "map.watershed",
  "map.profile",
  "map.cutFill",
  "map.waterLevel",
  "map.layerStack",
  "map.geologyInputs",
  "map.rainfallRunoff",
  "map.rainfallLandslide",
  "map.geologyModel",
] as const;

export const GDL_TOOL_NAMES = ["gdl.run", "gdl.describe"] as const;

export const GIS_TOOL_REGISTRY: readonly GisToolDefinition[] = [
  {
    name: "list-layers",
    description: "列出 GIS 文件中的全部图层名。只返回名称，不返回坐标或几何。",
    parameters: [{ name: "filePath", type: "string", required: true, description: "GIS 文件或目录的路径" }],
  },
  {
    name: "get-layer-metadata",
    description: "读取一个图层的字段、空间参考、要素数量和几何类型。不返回坐标数组、范围或几何正文。",
    parameters: [
      { name: "filePath", type: "string", required: true, description: "GIS 文件或目录的路径" },
      { name: "layerName", type: "string", required: true, description: "图层名" },
    ],
  },
  {
    name: "get-sample-feature",
    description: "最多返回 15 条样例要素的属性、标识和几何类型。不扫描全量数据，不返回坐标。",
    parameters: [
      { name: "filePath", type: "string", required: true, description: "GIS 文件或目录的路径" },
      { name: "layerName", type: "string", required: true, description: "图层名" },
    ],
  },
  {
    name: "io.read",
    description: "调度只读打开源数据。本层只传递路径和图层名，不读取几何。",
    parameters: [
      { name: "absolutePath", type: "string", required: true, description: "源文件或源目录的绝对路径" },
      { name: "layerName", type: "string", required: false, description: "要打开的图层名，可以省略" },
    ],
  },
  {
    name: "io.listLayers",
    description: "调度适配器返回已打开数据的图层名。本层不计算几何。",
    parameters: [{ name: "handle", type: "string", required: true, description: "不透明内存句柄" }],
  },
  {
    name: "map.buffer",
    description: "对已载入地图的图层做缓冲，生成新的面图层。参数是图层标识、距离和单位，不要传坐标。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "输入图层标识或图层名" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
      { name: "distance", type: "number", required: true, description: "缓冲距离，必须大于 0" },
      { name: "unit", type: "string", required: true, description: "单位：meters、kilometers、miles、feet 或 degrees，也可用米、千米" },
      { name: "writeKnowledge", type: "boolean", required: false, description: "为 true 时把图层名、操作、要素数量和字段名写入本地知识库" },
    ],
  },
  {
    name: "map.intersect",
    description: "求两个已载入图层的相交结果。只传图层标识，不要传坐标或 GeoJSON。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "第一个图层标识或图层名" },
      { name: "otherLayerId", type: "string", required: true, description: "第二个图层标识或图层名" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
      { name: "writeKnowledge", type: "boolean", required: false, description: "为 true 时写入知识库摘要" },
    ],
  },
  {
    name: "map.clip",
    description: "用裁剪图层切开目标图层。layerId 是目标，otherLayerId 是裁剪面。不要传坐标。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "被裁剪的目标图层标识或图层名" },
      { name: "otherLayerId", type: "string", required: true, description: "裁剪图层标识或图层名" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
      { name: "writeKnowledge", type: "boolean", required: false, description: "为 true 时写入知识库摘要" },
    ],
  },
  {
    name: "map.query",
    description: "空间查询。queryKind 取 attribute、point-in-polygon 或 intersects。属性筛选只写字段和值，不要写坐标。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "被查询的图层标识或图层名" },
      { name: "queryKind", type: "string", required: true, description: "attribute、point-in-polygon 或 intersects" },
      { name: "attributeFilter", type: "string", required: false, description: "属性筛选，例如 NAME=甲 或 POP>10" },
      { name: "otherLayerId", type: "string", required: false, description: "点在面内或相交时的对照图层名或标识" },
      { name: "writeKnowledge", type: "boolean", required: false, description: "为 true 时写入知识库摘要" },
    ],
  },
  {
    name: "map.stats",
    description: "统计要素数量，以及某个数值字段的最小、最大和平均。坐标字段只返回要素数量。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "图层标识或图层名" },
      { name: "fieldName", type: "string", required: false, description: "数值字段名，可省略" },
      { name: "writeKnowledge", type: "boolean", required: false, description: "为 true 时写入知识库摘要" },
    ],
  },
  {
    name: "map.list",
    description: "列出当前已载入地图的图层：标识、名称、几何类型、要素数量、字段名、显隐和顺序。不返回坐标。",
    parameters: [],
  },
  {
    name: "map.load",
    description: "把磁盘上的矢量文件载入地图图层库。只传路径和可选图层名，不要传几何。",
    parameters: [
      { name: "absolutePath", type: "string", required: true, description: "源文件绝对路径" },
      { name: "layerName", type: "string", required: false, description: "载入后的图层名，可省略" },
      { name: "writeKnowledge", type: "boolean", required: false, description: "为 true 时写入知识库摘要" },
    ],
  },
  {
    name: "map.style",
    description: "修改已载入图层的填充色、轮廓色、宽度、透明度，或按字段分类设色、用一个字段做注记。颜色用 #RRGGBB。分类设色和注记只使用字段名，不做注记避让。不要传坐标。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "图层标识或图层名" },
      { name: "fill", type: "string", required: false, description: "填充色，例如 #c45c26" },
      { name: "outline", type: "string", required: false, description: "轮廓色" },
      { name: "width", type: "number", required: false, description: "轮廓宽度，0.5 到 12" },
      { name: "opacity", type: "number", required: false, description: "透明度，0 到 1" },
      { name: "colorField", type: "string", required: false, description: "按这个字段的取值分类设色。空字符串表示取消" },
      { name: "labelField", type: "string", required: false, description: "用这个字段的文字做注记。空字符串表示取消" },
    ],
  },
  {
    name: "map.setVisibility",
    description: "显示或隐藏已载入图层。visible 为 false 时隐藏。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "图层标识或图层名" },
      { name: "visible", type: "boolean", required: true, description: "true 显示，false 隐藏" },
    ],
  },
  {
    name: "map.setOrder",
    description: "调整图层叠放。place 取 top、bottom、up 或 down。top 表示画在最上面。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "图层标识或图层名" },
      { name: "place", type: "string", required: true, description: "top、bottom、up 或 down" },
    ],
  },
  {
    name: "map.zoomToLayer",
    description: "请求地图缩放到指定图层。工具结果不含坐标，缩放由客户端用本地几何完成。",
    parameters: [{ name: "layerId", type: "string", required: true, description: "图层标识或图层名" }],
  },
  {
    name: "map.exportGeoJson",
    description: "把已载入图层导出为新的 GeoJSON 文件，不能覆盖源文件。可省略路径，系统会写到 var/exports。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "图层标识或图层名" },
      { name: "destinationPath", type: "string", required: false, description: "新文件的绝对路径，必须是尚未存在的文件" },
    ],
  },
  {
    name: "gdl.run",
    description:
      "执行 Igis GDL（地理描述语言）语句，按图层名引用已载入的图层。只允许 STYLE、BUFFER、INTERSECT、CLIP 四种语句，例如 BUFFER 道路 100 m AS 道路_缓冲。不能写 LAYER、FEATURE、几何字面量或坐标，模型不能生成几何。",
    parameters: [
      { name: "script", type: "string", required: true, description: "GDL 语句，一行一条，只引用图层名" },
      { name: "writeKnowledge", type: "boolean", required: false, description: "为 true 时把这段 GDL 的摘要写入本地知识库" },
    ],
  },
  {
    name: "gdl.describe",
    description: "返回一个已载入图层的 GDL 摘要：图层名、几何类型、坐标系标签、字段名和类型、样式、要素数量。不含几何和坐标。",
    parameters: [{ name: "layerName", type: "string", required: true, description: "图层名" }],
  },
  {
    name: "map.delete",
    description: "删除一个已载入的结果图层。不会删除源文件。必须先经过用户确认。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "要删除的图层标识或图层名" },
    ],
  },
  {
    name: "map.clearAll",
    description: "清空地图上的全部图层。不删除源文件。必须先经过用户确认。",
    parameters: [],
  },
  {
    name: "map.dropDatabase",
    description: "清空本地知识库数据库。不删除源 GIS 文件。必须先经过用户确认。",
    parameters: [],
  },
  {
    name: "map.area",
    description: "统计面图层的面积（平方米，球面精确）：合计、最小、最大、平均。只出数字摘要，不返回几何。",
    parameters: [{ name: "layerId", type: "string", required: true, description: "图层标识或图层名" }],
  },
  {
    name: "map.length",
    description: "统计线要素长度（米）；面要素按周长单独统计。只出数字摘要，不返回几何。",
    parameters: [{ name: "layerId", type: "string", required: true, description: "图层标识或图层名" }],
  },
  {
    name: "map.distance",
    description: "统计两个图层之间的最近距离：最小、最大、平均。已声明坐标系时单位是米。两个图层都未声明坐标系时按坐标原值计算，单位是坐标单位，不是米。线/面按要素代表点计算。只出数字摘要。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "第一个图层标识或图层名" },
      { name: "otherLayerId", type: "string", required: true, description: "第二个图层标识或图层名" },
    ],
  },
  {
    name: "map.nearest",
    description: "给第一个图层的每个要素标注到第二个图层的最近距离，生成带 _dist 字段的新图层。已声明坐标系时 _dist 是米。两个图层都未声明坐标系时 _dist 是坐标单位，不是米。线/面按要素代表点计算。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "第一个图层标识或图层名" },
      { name: "otherLayerId", type: "string", required: true, description: "第二个图层标识或图层名" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.convert",
    description: "几何转换：target 是 polygon 表示线转面（自动闭合），line 表示面转线。生成新图层。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "图层标识或图层名" },
      { name: "target", type: "string", required: true, description: "目标几何：polygon 或 line" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.dissolve",
    description: "面融合：把面要素融合成一个面；给出 groupField 时按该字段分组，各组融为一个面。生成新图层。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "图层标识或图层名" },
      { name: "groupField", type: "string", required: false, description: "分组字段名，可省略" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.merge",
    description: "合并两个同类型图层为一个新图层。几何类型不同的图层不能合并。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "第一个图层标识或图层名" },
      { name: "otherLayerId", type: "string", required: true, description: "第二个图层标识或图层名" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.simplify",
    description: "几何简化：按容差（米）减少顶点数量，生成新图层。点要素原样保留。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "图层标识或图层名" },
      { name: "tolerance", type: "number", required: true, description: "简化容差，米，必须大于 0" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.groupStats",
    description: "分组统计：按 groupField 分组，统计 fieldName 数值字段的个数、合计、平均。只出数字摘要，不生成图层。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "图层标识或图层名" },
      { name: "groupField", type: "string", required: true, description: "分组字段名" },
      { name: "fieldName", type: "string", required: true, description: "要统计的数值字段名" },
    ],
  },
  {
    name: "map.reclassify",
    description: "字段重分类：按映射表替换字段值，生成新图层。mapping 形如「1=耕地;2=林地」。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "图层标识或图层名" },
      { name: "fieldName", type: "string", required: true, description: "要重分类的字段名" },
      { name: "mapping", type: "string", required: true, description: "映射表：源=目标，用分号分隔" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.qualityCheck",
    description: "数据质量检查：各字段的空值、空串、去重计数、数值值域，以及无效几何数量。只出数字和文字摘要。",
    parameters: [{ name: "layerId", type: "string", required: true, description: "图层标识或图层名" }],
  },
  {
    name: "map.splitByGrid",
    description: "格网分幅：把图层范围按列×行切幅并逐幅裁剪，生成带 _sheet 字段（行-列，1 起）的新图层。列数行数各 1 到 6。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "图层标识或图层名" },
      { name: "columns", type: "number", required: true, description: "列数，1 到 6" },
      { name: "rows", type: "number", required: true, description: "行数，1 到 6" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.voronoi",
    description: "Voronoi 剖分：对点图层生成泰森多边形面图层（每点一格）。需要至少 2 个点要素。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "点图层标识或图层名" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.convexHull",
    description: "凸包：生成覆盖图层全部要素的最小凸面图层。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "图层标识或图层名" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.minBBox",
    description: "最小外接矩形：逐要素生成面积最小的外接矩形面图层（坐标平面近似）。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "图层标识或图层名" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.centroid",
    description: "质心：逐要素生成质心点图层，保留原属性。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "图层标识或图层名" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.bearing",
    description: "方位角标注：给第一个图层每个要素标注到第二个图层最近要素代表点的方位角，生成带 _bearing 字段（度，正北 0）的新图层。按要素代表点计算。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "第一个图层标识或图层名" },
      { name: "otherLayerId", type: "string", required: true, description: "第二个图层标识或图层名" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.exportCoordinates",
    description: "坐标值报表：把图层坐标导出为本地 CSV 文件（不覆盖源文件）。坐标只写本地文件，对话里只返回行数。",
    parameters: [{ name: "layerId", type: "string", required: true, description: "图层标识或图层名" }],
  },
  {
    name: "map.makeValid",
    description: "几何修复：用本地 GDAL 后端修复无效几何（自相交等），生成新图层。后端未启用时该能力不可用。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "图层标识或图层名" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.reproject",
    description: "重投影：用本地 GDAL 后端把图层转换到目标坐标系，生成新图层。后端未启用时该能力不可用。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "图层标识或图层名" },
      { name: "targetCrs", type: "string", required: true, description: "目标坐标系，如 EPSG:3857" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.convertFormat",
    description: "格式转换：用本地 GDAL 后端把图层转换为目标格式（gpkg/geojson/kml/gml/shp），生成新文件并载入。后端未启用时该能力不可用。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "图层标识或图层名" },
      { name: "format", type: "string", required: true, description: "目标格式：gpkg、geojson、kml、gml 或 shp" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.rasterInfo",
    description: "栅格信息：读取当前对话里一个栅格的元数据与统计（宽高、波段、最小/最大/平均值）。栅格按文件名引用，例如 dem.tif，不要传路径。",
    parameters: [{ name: "rasterName", type: "string", required: true, description: "当前对话里的栅格文件名，如 dem.tif" }],
  },
  {
    name: "map.demDerivative",
    description: "DEM 衍生：对当前对话里的高程栅格生成坡度、坡向或晕渲。产物是本地栅格文件，不上图。栅格按文件名引用，例如 dem.tif，不要传路径。后端未启用时该能力不可用。",
    parameters: [
      { name: "rasterName", type: "string", required: true, description: "当前对话里的栅格文件名，如 dem.tif" },
      { name: "derivative", type: "string", required: true, description: "slope、aspect 或 hillshade" },
    ],
  },
  {
    name: "map.rasterCalc",
    description: "栅格代数：两个同尺寸栅格的有限运算（add、subtract、multiply、divide、min、max），不接受表达式。产物是本地栅格文件。",
    parameters: [
      { name: "rasterName", type: "string", required: true, description: "当前对话里的第一个栅格文件名，如 dem.tif" },
      { name: "otherRasterName", type: "string", required: true, description: "当前对话里的第二个栅格文件名，如 other.tif" },
      { name: "op", type: "string", required: true, description: "add、subtract、multiply、divide、min 或 max" },
    ],
  },
  {
    name: "map.contour",
    description: "等高线：对当前对话里的高程栅格按等高距生成等高线矢量图层（可上图）。栅格按文件名引用，例如 dem.tif，不要传路径。等高距必须大于 0。",
    parameters: [
      { name: "rasterName", type: "string", required: true, description: "当前对话里的栅格文件名，如 dem.tif" },
      { name: "interval", type: "number", required: true, description: "等高距（高程单位），必须大于 0" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.splitLine",
    description: "点分割线：用点图层把线图层切成多段，生成新线图层。点不在线上时按最近位置切。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "线图层标识或图层名" },
      { name: "otherLayerId", type: "string", required: true, description: "分割点图层标识或图层名" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.explode",
    description: "多部件拆分：把 Multi 几何拆成单部件图层（每部件一个要素），单部件原样保留。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "图层标识或图层名" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.vertices",
    description: "折点转点：把面或线的每个节点变成一个点，生成新点图层，属性从原要素复制。环上重复的闭合点会各成一点。不度量距离。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "面或线图层标识或图层名" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.lineIntersect",
    description: "线交点：求两个线图层的交点，生成点图层。省略第二个图层时求这一层自己的交点。面会先用边界。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "线或面图层标识或图层名" },
      { name: "otherLayerId", type: "string", required: false, description: "另一条线或面，可省略" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.transform",
    description: "几何变换：kind 为 translate、rotate 或 scale。平移在经纬度上按米，在未声明坐标系上按坐标单位。旋转角度是度。缩放倍数必须大于 0。在原坐标上生成新图层。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "图层标识或图层名" },
      { name: "kind", type: "string", required: true, description: "translate、rotate 或 scale" },
      { name: "distance", type: "number", required: false, description: "平移距离。经纬度时是米，未声明坐标系时是坐标单位" },
      { name: "bearing", type: "number", required: false, description: "平移方向，度，正北为 0，顺时针。省略为 0" },
      { name: "angle", type: "number", required: false, description: "旋转角度，度" },
      { name: "factor", type: "number", required: false, description: "缩放倍数，必须大于 0" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.nearestOnLine",
    description: "垂足：把点图层的每个点落到线或面边界上的最近点，生成点图层，_dist 为距离。经纬度时 _dist 是米。两个图层都未声明坐标系时 _dist 是坐标单位，不是米。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "点图层标识或图层名" },
      { name: "otherLayerId", type: "string", required: true, description: "线或面图层标识或图层名" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.grid",
    description: "矩形格网：按图层范围和边长生成矩形格网。经纬度或已声明米制平面时边长是米。未声明坐标系时边长是坐标单位，不是米。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "用来取范围的图层标识或图层名" },
      { name: "cellSize", type: "number", required: true, description: "格子边长，必须大于 0" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.splitPolygon",
    description: "线分割面：用线图层把面图层切成多块，生成新面图层。线不穿过面时该面跳过。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "面图层标识或图层名" },
      { name: "otherLayerId", type: "string", required: true, description: "分割线图层标识或图层名" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.spatialAggregate",
    description: "空间聚合：统计点图层落入面图层各面的数量（_count），可选数值字段求和（_sum）和均值（_mean），生成新面图层并给摘要。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "面图层标识或图层名" },
      { name: "otherLayerId", type: "string", required: true, description: "点图层标识或图层名" },
      { name: "fieldName", type: "string", required: false, description: "点图层上要求和/均值的数值字段名，可省略" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.distanceMatrix",
    description: "距离矩阵：统计两个图层逐对最近距离的最小、最大、平均。已声明坐标系时单位是米。两个图层都未声明坐标系时单位是坐标单位，不是米。规模超过上限（默认 10000 对）会拒绝。只出数字摘要。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "第一个图层标识或图层名" },
      { name: "otherLayerId", type: "string", required: true, description: "第二个图层标识或图层名" },
      { name: "limit", type: "number", required: false, description: "矩阵对数上限，默认 10000" },
    ],
  },
  {
    name: "map.nearestExact",
    description: "精确最近距离标注：给第一个图层每个要素按全部顶点采样标注到第二个图层的最近距离，生成带 _dist 字段的新图层。已声明坐标系时 _dist 是米。两个图层都未声明坐标系时 _dist 是坐标单位，不是米。比代表点近似更准。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "第一个图层标识或图层名" },
      { name: "otherLayerId", type: "string", required: true, description: "第二个图层标识或图层名" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.calculateField",
    description: "字段计算：用已有字段和常数写一个新字段。只支持加减乘除、比较和 if(条件, 是, 否)。文字用双引号。不执行脚本或 SQL。坐标字段不能当新字段名。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "图层标识或图层名" },
      { name: "expression", type: "string", required: true, description: "计算式，例如 if(value > 10, value * 2, 0)" },
      { name: "fieldName", type: "string", required: true, description: "新字段名" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.join",
    description: "属性连接：按两个字段的值做内连接，只保留对上的记录。几何来自第一个图层。一对多会保留多条。同名字段保留第一个图层的值。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "保留几何的图层标识或图层名" },
      { name: "otherLayerId", type: "string", required: true, description: "提供属性的图层标识或图层名" },
      { name: "fieldName", type: "string", required: true, description: "第一个图层上的连接字段" },
      { name: "otherFieldName", type: "string", required: true, description: "第二个图层上的连接字段" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.rasterCast",
    description: "栅格类型转换：把当前对话里的栅格转成 int16、int32 或 float32。转成整数时按四舍五入。产物是本地栅格，不上图。",
    parameters: [
      { name: "rasterName", type: "string", required: true, description: "当前对话里的栅格文件名，如 dem.tif" },
      { name: "outputType", type: "string", required: true, description: "int16、int32 或 float32" },
    ],
  },
  {
    name: "map.rasterNoData",
    description: "设置栅格第一波段的 NoData 标记。不改像元值。产物是本地栅格，不上图。",
    parameters: [
      { name: "rasterName", type: "string", required: true, description: "当前对话里的栅格文件名，如 dem.tif" },
      { name: "noData", type: "number", required: true, description: "NoData 数值" },
    ],
  },
  {
    name: "map.rasterSmooth",
    description: "邻域平滑：对当前对话里的栅格做 3×3 均值。NoData 不参与平均。产物是本地栅格，不上图。",
    parameters: [
      { name: "rasterName", type: "string", required: true, description: "当前对话里的栅格文件名，如 dem.tif" },
    ],
  },
  {
    name: "map.interpolate",
    description: "点插值：把点图层的一个数值字段插成栅格。algorithm 只能是 invdist、nearest 或 linear。点数够时留出一部分点，返回均方根误差和平均绝对误差。不做克里金。产物是本地栅格，不上图。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "点图层标识或图层名" },
      { name: "fieldName", type: "string", required: true, description: "要插值的数值字段" },
      { name: "algorithm", type: "string", required: true, description: "invdist、nearest 或 linear" },
    ],
  },
  {
    name: "map.erase",
    description: "擦除：从第一个面图层去掉与第二个面重叠的部分，生成新图层。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "被擦除的面图层" },
      { name: "otherLayerId", type: "string", required: true, description: "用来擦除的面图层" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.union",
    description: "联合：把两个面图层合成一个面，重叠部分合并。这不是把两个图层简单接在一起。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "第一个面图层" },
      { name: "otherLayerId", type: "string", required: true, description: "第二个面图层" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.spatialJoin",
    description: "按位置连接：点落在哪个面里，就把面的字段抄到点上。这不是按字段相等连接。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "点图层" },
      { name: "otherLayerId", type: "string", required: true, description: "面图层" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.viewshed",
    description: "可视域：用高程栅格和点图层的第一个点计算可见范围。观察点高度单位与栅格高程一致。产物是本地栅格，不上图。",
    parameters: [
      { name: "rasterName", type: "string", required: true, description: "高程栅格文件名" },
      { name: "layerId", type: "string", required: true, description: "观察点所在的点图层" },
      { name: "observerHeight", type: "number", required: true, description: "观察点高出地面的高度，大于或等于 0" },
    ],
  },
  {
    name: "map.rasterClip",
    description: "按面裁剪栅格。产物是本地栅格，不上图。",
    parameters: [
      { name: "rasterName", type: "string", required: true, description: "栅格文件名" },
      { name: "layerId", type: "string", required: true, description: "裁剪面图层" },
    ],
  },
  {
    name: "map.polygonize",
    description: "栅格转面：把相同像元值连成面，并载入地图。",
    parameters: [
      { name: "rasterName", type: "string", required: true, description: "栅格文件名" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.rasterize",
    description: "面转栅格：按格网边长把面烧成栅格。产物是本地栅格，不上图。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "面图层" },
      { name: "cellSize", type: "number", required: true, description: "格网边长，大于 0，单位与坐标一致" },
    ],
  },
  {
    name: "map.zonal",
    description: "按面统计栅格：对每个面给出其中像元的最小、最大和平均。不生成新图层。",
    parameters: [
      { name: "rasterName", type: "string", required: true, description: "栅格文件名" },
      { name: "layerId", type: "string", required: true, description: "面图层" },
    ],
  },
  {
    name: "map.resample",
    description: "重采样栅格到新的格网边长。产物是本地栅格，不上图。",
    parameters: [
      { name: "rasterName", type: "string", required: true, description: "栅格文件名" },
      { name: "cellSize", type: "number", required: true, description: "格网边长，大于 0" },
    ],
  },
  {
    name: "map.rasterIndex",
    description: "用两个同网格的单波段栅格计算 ndvi、ndwi 或 savi。ndvi 和 savi：第一个是近红外，第二个是红波段。ndwi：第一个是绿波段，第二个是近红外。不接受自定义公式。产物是本地栅格，不上图。",
    parameters: [
      { name: "rasterName", type: "string", required: true, description: "第一个波段的栅格文件名（ndvi/savi 为近红外，ndwi 为绿波段）" },
      { name: "otherRasterName", type: "string", required: true, description: "第二个波段的栅格文件名（ndvi/savi 为红波段，ndwi 为近红外）" },
      { name: "index", type: "string", required: true, description: "ndvi、ndwi 或 savi" },
    ],
  },
  {
    name: "map.focal",
    description: "邻域均值。size 只能是 3、5 或 7。产物是本地栅格，不上图。",
    parameters: [
      { name: "rasterName", type: "string", required: true, description: "栅格文件名" },
      { name: "size", type: "number", required: true, description: "邻域边长：3、5 或 7" },
    ],
  },
  {
    name: "map.quadtree",
    description: "用点图层建立四叉树，结果是带点数和深度的方格。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "点图层" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.chart",
    description: "按一个数值字段做等宽直方图，只返回各区间的个数，不生成图层。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "图层" },
      { name: "fieldName", type: "string", required: true, description: "数值字段" },
    ],
  },
  {
    name: "map.kernelDensity",
    description: "高斯核密度：对点做格网密度估计。EPSG:4326 图层按球面距离，带宽和边长用米，_density 是每平方公里的点数；未知坐标系按坐标单位。不做克里金。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "点图层" },
      { name: "bandwidth", type: "number", required: true, description: "带宽，大于 0。EPSG:4326 和已知米制平面为米，否则为坐标单位" },
      { name: "cellSize", type: "number", required: true, description: "格网边长，大于 0，单位同带宽" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.snapToNetwork",
    description: "把点落到最近的线上。两个图层坐标系必须相同。EPSG:4326 时 _snap 为米，未知坐标系时单位与坐标一致。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "点图层" },
      { name: "otherLayerId", type: "string", required: true, description: "线图层" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.networkDistance",
    description: "沿路网计算每个起点到最近终点的最短距离，只返回最小、最大和平均。EPSG:4326 为米，未知坐标系为坐标单位。不含转向限制。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "起点图层" },
      { name: "otherLayerId", type: "string", required: true, description: "终点图层" },
      { name: "lineLayerId", type: "string", required: true, description: "路网线图层" },
    ],
  },
  {
    name: "map.serviceArea",
    description: "服务范围：从点出发，沿路网走出给定距离内的路段。EPSG:4326 为米，未知坐标系为坐标单位。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "起点图层" },
      { name: "lineLayerId", type: "string", required: true, description: "路网线图层" },
      { name: "distance", type: "number", required: true, description: "沿路距离，大于 0" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.aggregateGrid",
    description: "把点按格网计数。结果只保留每格的个数，不保留原点。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "点图层" },
      { name: "cellSize", type: "number", required: true, description: "格网边长，大于 0" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.offsetLine",
    description: "平行线：用 GEOS 的 OffsetCurve 在本机生成，尖角和折线不会自交。正距离在线的左侧，负距离在右侧。已知 EPSG 投影和米制平面按米；EPSG:4326 等地理坐标会被拒绝，先用 map.reproject 投影。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "线图层" },
      { name: "distance", type: "number", required: true, description: "偏移距离，非零。正数在左侧，负数在右侧" },
      { name: "join", type: "string", required: false, description: "拐角：round（默认）、mitre 或 bevel" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.costCorridor",
    description: "最小费用走廊：在费用栅格上从起点到终点做 8 邻域累计费用。最小费用路径作为线图层载入地图，走廊栅格是本地产物。NoData 和不大于 0 的像元不可通行。",
    parameters: [
      { name: "rasterName", type: "string", required: true, description: "费用栅格文件名" },
      { name: "layerId", type: "string", required: true, description: "起点图层，取第一个点" },
      { name: "otherLayerId", type: "string", required: true, description: "终点图层，取第一个点" },
      { name: "tolerance", type: "number", required: false, description: "走廊宽容度 0 到 1，默认 0.05：累计费用不超过最小值 ×(1+tolerance) 的像元进走廊" },
      { name: "outputName", type: "string", required: false, description: "路径图层名，可省略" },
    ],
  },
  {
    name: "map.classify",
    description: "监督分类：用同网格的栅格波段和带类别字段的训练点。分层留出检验样本，在训练样本上用 5 折交叉验证从最小距离、最大似然、kNN 中选方法，报告混淆矩阵、总体精度和 Kappa。产物是类别编码栅格，不上图。",
    parameters: [
      { name: "rasterName", type: "string", required: true, description: "栅格文件名，多个用逗号分隔，必须同一网格" },
      { name: "layerId", type: "string", required: true, description: "训练点图层" },
      { name: "fieldName", type: "string", required: true, description: "类别字段" },
      { name: "method", type: "string", required: false, description: "auto（默认，交叉验证选）、mindist、maxlike、knn1、knn3、knn5、knn7" },
      { name: "testFraction", type: "number", required: false, description: "检验样本比例，默认 0.3" },
    ],
  },
  {
    name: "map.hotspot",
    description: "Getis-Ord Gi* 热点分析。给了路网线图层时按沿路距离定邻居（网络热点），否则按直线距离。输出 _gi_z、_gi_p 和 _gi_bin（±1/±2/±3 对应 90%/95%/99%）。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "要素图层" },
      { name: "fieldName", type: "string", required: true, description: "数值字段" },
      { name: "distance", type: "number", required: true, description: "邻域距离，大于 0。EPSG:4326 为米，未知坐标系为坐标单位" },
      { name: "lineLayerId", type: "string", required: false, description: "路网线图层。给了就按路网距离" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.gwr",
    description: "地理加权回归。每个要素输出局部系数 _b0、_b_字段、标准误、拟合值、残差和局部 R²，摘要给出 AICc、R²、带宽和全局 OLS 对比。不给带宽时按 AICc 选。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "要素图层，面按质心" },
      { name: "fieldName", type: "string", required: true, description: "因变量字段" },
      { name: "predictors", type: "string", required: true, description: "自变量字段，逗号分隔，1 到 5 个" },
      { name: "kernel", type: "string", required: false, description: "bisquare（默认）或 gaussian" },
      { name: "adaptive", type: "boolean", required: false, description: "true（默认）时带宽是邻居个数，false 时是距离" },
      { name: "bandwidth", type: "number", required: false, description: "带宽，可省略" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.odFlow",
    description: "OD 流量估计：双约束重力模型，按产生量和吸引量分配流量，Furness 平衡。β 直接给，或给目标平均出行距离来标定 β。输出起终点连线，_flow 是流量。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "起点图层，面按质心" },
      { name: "otherLayerId", type: "string", required: true, description: "终点图层" },
      { name: "fieldName", type: "string", required: true, description: "起点的产生量字段" },
      { name: "otherFieldName", type: "string", required: true, description: "终点的吸引量字段" },
      { name: "lineLayerId", type: "string", required: false, description: "路网线图层。给了就按路网距离" },
      { name: "deterrence", type: "string", required: false, description: "距离衰减：exp（默认）或 power" },
      { name: "beta", type: "number", required: false, description: "衰减参数 β，不小于 0" },
      { name: "targetMean", type: "number", required: false, description: "目标平均出行距离，用来标定 β。和 beta 只给一个" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.kAnonymize",
    description: "位置 k 匿名：四叉树隐匿，每个输出区域至少含 k 个点。结果只有区域面和计数，不输出原始点。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "点图层" },
      { name: "k", type: "number", required: true, description: "不小于 2 的整数" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.dpGrid",
    description: "差分隐私计数：每个统计格的点数加拉普拉斯噪声（尺度 1/ε），取整并截到不小于 0。真实计数不输出。前提是每人一个点、格互不重叠。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "点图层" },
      { name: "otherLayerId", type: "string", required: true, description: "统计格面图层，例如 map.grid 的结果" },
      { name: "epsilon", type: "number", required: true, description: "隐私预算 ε，大于 0" },
      { name: "outputName", type: "string", required: false, description: "结果图层名，可省略" },
    ],
  },
  {
    name: "map.kriging",
    description: "普通克里金插值。需要本地专业模型权重：半变异函数从权重里的先验出发，用这次的点拟合。结果报告块金、基台、变程和留一交叉验证误差。克里金值和方差两个栅格是本地产物，不上图。没有安装权重时返回不可用。地理坐标会被拒绝，先投影。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "点图层，至少 10 个不同位置" },
      { name: "fieldName", type: "string", required: true, description: "数值字段" },
      { name: "cellSize", type: "number", required: false, description: "格网边长，可省略；省略时长边 200 格" },
    ],
  },
  {
    name: "map.watershed",
    description: "汇水分析：D8 流向，Priority-Flood 填洼，出水口捕捉到附近汇流最大的像元。河道阈值面积和捕捉半径来自本地专业模型权重，没有安装权重时返回不可用。流域面载入地图，汇流累积量和河道栅格是本地产物。DEM 必须带投影坐标系。",
    parameters: [
      { name: "rasterName", type: "string", required: true, description: "DEM 文件名" },
      { name: "layerId", type: "string", required: true, description: "出水口点图层，最多 50 个点" },
      { name: "outputName", type: "string", required: false, description: "流域图层名，可省略" },
    ],
  },
  {
    name: "map.profile",
    description: "地形剖面：沿线图层的第一条线按像元间距采样 DEM，双线性插值。采样点载入地图，字段 distance 和 elevation；摘要给线长、最低、最高、累计爬升和下降。地理坐标会被拒绝。",
    parameters: [
      { name: "rasterName", type: "string", required: true, description: "DEM 文件名" },
      { name: "layerId", type: "string", required: true, description: "线图层" },
      { name: "outputName", type: "string", required: false, description: "采样点图层名，可省略" },
    ],
  },
  {
    name: "map.cutFill",
    description: "填挖方：第二个高程栅格减第一个，正为填、负为挖，报告填方、挖方、净方量和面积。两个栅格必须同一网格。差值栅格是本地产物。地理坐标会被拒绝。",
    parameters: [
      { name: "rasterName", type: "string", required: true, description: "现状高程栅格文件名" },
      { name: "otherRasterName", type: "string", required: true, description: "设计高程栅格文件名" },
    ],
  },
  {
    name: "map.waterLevel",
    description: "水面抬高：水面高程减去 DEM 地面高程，得到水深栅格。水深小于或等于 0 的地方记为 0。没有流速，也没有时间。水位没写就不要调用，先问用户。地理坐标会被拒绝。",
    parameters: [
      { name: "rasterName", type: "string", required: true, description: "地面高程栅格文件名或 ras- 句柄" },
      { name: "waterLevel", type: "number", required: true, description: "水面高程，与栅格高程同一单位。不要省略，也不要自行填数" },
    ],
  },
  {
    name: "map.layerStack",
    description: "爆炸图登记从下到上的图层顺序和层间竖向间距，三维页按登记画分层。至少两个已载入图层。少于两层时不登记，也不出图。",
    parameters: [
      { name: "layerIds", type: "string", required: true, description: "从下到上的图层名或标识，用逗号分开，至少两个" },
      { name: "gap", type: "number", required: true, description: "层间竖向间距。投影为米时单位是米。不要省略" },
    ],
  },
  {
    name: "map.geologyInputs",
    description: "地层体只核对输入：界面点图层、界面字段、倾角字段和倾向字段。缺任何一项就向用户问，不要编造。这一步不生成地层体，生成用 map.geologyModel。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "界面点图层名或标识" },
      { name: "fieldName", type: "string", required: true, description: "界面或地层名称字段" },
      { name: "groupField", type: "string", required: true, description: "倾角字段，必须是数值" },
      { name: "target", type: "string", required: true, description: "倾向字段，必须是数值方位角" },
    ],
  },
  {
    name: "map.rainfallRunoff",
    description: "降雨径流：用 ANUGA 浅水方程在 DEM 上算降雨后的地表水流。每个降雨情景单独跑，逐时刻给最大水深、超过水深下限的面积、最大流速和水深栅格句柄，另给最大流速栅格。某个情景失败就停。雨强、历时、曼宁糙率没写就先问用户，不要自行填数。需要以米为单位的投影坐标、完整无空值的 DEM。降雨和模拟时长不超过 24 小时。格子较粗时积水跟着较低的格子，圆形洼地会沿行列伸展。",
    parameters: [
      { name: "rasterName", type: "string", required: true, description: "地面高程栅格文件名或 ras- 句柄" },
      { name: "scenarios", type: "string", required: true, description: "降雨情景：雨强毫米每小时x历时小时，多个用分号隔开，例如 30x2;60x1。最多六个" },
      { name: "manning", type: "number", required: true, description: "地表曼宁糙率。不要省略，也不要自行填数" },
      { name: "simulationHours", type: "number", required: false, description: "每个情景的模拟总时长（小时），不短于降雨历时。不写就等于降雨历时" },
      { name: "steps", type: "number", required: false, description: "输出时刻数，1 到 24。不写按 4" },
      { name: "depthThreshold", type: "number", required: false, description: "统计面积用的水深下限（米）。不写按 0.01" },
      { name: "boundary", type: "string", required: false, description: "open 四周自由出流，closed 四周封闭。不写按 open" },
    ],
  },
  {
    name: "map.rainfallLandslide",
    description: "降雨滑坡：用 TRIGRS（无限边坡加一维入渗）在 DEM 上算降雨过程中的安全系数。每个降雨情景单独跑，逐时刻给最小安全系数、安全系数小于 1 的面积和安全系数栅格句柄。某个情景失败就停。土体参数全部要用户给，缺一项就先问，不要自行填数。不做径流汇流。需要以米为单位的投影坐标和正方形像元。降雨时长不超过 720 小时。",
    parameters: [
      { name: "rasterName", type: "string", required: true, description: "地面高程栅格文件名或 ras- 句柄" },
      { name: "scenarios", type: "string", required: true, description: "降雨情景：雨强毫米每小时x历时小时，多个用分号隔开，例如 20x6;50x2。最多六个" },
      { name: "cohesion", type: "number", required: true, description: "土体有效黏聚力（千帕）" },
      { name: "frictionAngle", type: "number", required: true, description: "有效内摩擦角（度）" },
      { name: "unitWeight", type: "number", required: true, description: "土体重度（千牛每立方米）" },
      { name: "diffusivity", type: "number", required: true, description: "饱和水力扩散系数（平方米每秒）" },
      { name: "ksat", type: "number", required: true, description: "饱和渗透系数（米每秒）" },
      { name: "soilDepth", type: "number", required: true, description: "土层厚度，即潜在滑面深度（米）" },
      { name: "waterTableDepth", type: "number", required: true, description: "初始地下水位埋深（米），不大于土层厚度" },
      { name: "backgroundRate", type: "number", required: false, description: "初始稳定入渗率（毫米每小时）。不写按 0" },
      { name: "steps", type: "number", required: false, description: "输出时刻数，1 到 24。不写按 4" },
    ],
  },
  {
    name: "map.geologyModel",
    description: "地层体：用 LoopStructural 按 map.geologyInputs 登记的界面点和产状做隐式建模，给出从下到上的地层顺序和各层体积，三维页可以看。没有登记就先调用 map.geologyInputs。向下延伸的深度没写就先问用户。不建断层。界面点按所标地层的底面处理。没给高程栅格时，模型顶面就是最高的界面点，最上面那一层没有厚度，体积是 0；要看到这一层，向用户要高程栅格。",
    parameters: [
      { name: "layerId", type: "string", required: true, description: "已登记的界面点图层名或标识" },
      { name: "depth", type: "number", required: true, description: "模型从最低界面点向下延伸的深度（米）。不要省略，也不要自行填数" },
      { name: "rasterName", type: "string", required: false, description: "地面高程栅格文件名或 ras- 句柄。给了就用它定界面点高程、范围，并削掉地面以上部分；点没有高程时必须给" },
    ],
  },
  {
    name: "map.exportMap",
    description: "把当前地图视图导出成一张带图例和比例尺的图片。由桌面窗口完成，不上传几何。",
    parameters: [],
  },
];

export function gisQueryTools(registry: readonly GisToolDefinition[] = GIS_TOOL_REGISTRY): readonly GisToolDefinition[] {
  return registry.filter((tool) => (GIS_QUERY_TOOL_NAMES as readonly string[]).includes(tool.name));
}

export function mapSpatialTools(registry: readonly GisToolDefinition[] = GIS_TOOL_REGISTRY): readonly GisToolDefinition[] {
  return registry.filter((tool) => (MAP_SPATIAL_TOOL_NAMES as readonly string[]).includes(tool.name));
}

export function gdlTools(registry: readonly GisToolDefinition[] = GIS_TOOL_REGISTRY): readonly GisToolDefinition[] {
  return registry.filter((tool) => (GDL_TOOL_NAMES as readonly string[]).includes(tool.name));
}

export function findGisTool(name: string, registry: readonly GisToolDefinition[] = GIS_TOOL_REGISTRY): GisToolDefinition | undefined {
  const canonical = canonicalToolName(name);
  return registry.find((tool) => tool.name === canonical)
    ?? registry.find((tool) => tool.name === name)
    ?? registry.find((tool) => tool.name.toLowerCase() === canonical.toLowerCase());
}

/** 转成 OpenAI 兼容的 tools 数组。 */
export function toOpenAiTools(registry: readonly GisToolDefinition[], locale?: "zh-CN" | "en"): readonly unknown[] {
  const english = locale === "en";
  return registry.map((tool) => {
    const properties: Record<string, { readonly type: string; readonly description: string }> = {};
    const required: string[] = [];
    for (const parameter of tool.parameters) {
      properties[parameter.name] = {
        type: parameter.type,
        description: english ? englishParameterDescription(parameter.name, parameter.description) : parameter.description,
      };
      if (parameter.required) required.push(parameter.name);
    }
    return {
      type: "function",
      function: {
        name: assertApiToolName(toApiToolName(tool.name)),
        description: english ? englishToolDescription(tool.name, tool.description) : tool.description,
        parameters: {
          type: "object",
          additionalProperties: false,
          required,
          properties,
        },
      },
    };
  });
}
