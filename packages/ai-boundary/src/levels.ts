// SPDX-License-Identifier: Apache-2.0

/**
 * 数据分级。
 * L0 只留在空间运行时：原始文件、坐标、WKT/WKB、栅格、GDAL 数据集句柄、文件系统路径。
 * L1 给操作框架用：图层标识、坐标系元数据、要素数量、几何类型。不能把原始几何送到云端。
 * L2 是唯一可以朝向模型的形状：图层名和标识、类型、数量、抽象关系、可用操作。
 */

export type DataLevel = "L0" | "L1" | "L2";

/** local-parser 是没有调用模型的聊天计划。chat 入口本身不等于 cloud-ai。 */
export type OperationSource = "local-user" | "local-parser" | "cloud-ai" | "mcp";

export type RequestSource = "desktop-ui" | "cloud-ai" | "mcp" | "internal";

export type DataBoundaryLevel = "L2";

export type ForbiddenClass = "raw_geometry" | "filesystem" | "shell" | "database_dump";

/** 操作框架内部可以使用的图层事实。没有坐标，也没有文件路径。 */
export interface OperationLayerFacts {
  readonly level: "L1";
  readonly layerId: string;
  readonly crs: string;
  readonly featureCount: number;
  readonly geometryType: string;
}

/** 可以交给模型的图层摘要。 */
export interface AiLayerView {
  readonly level: "L2";
  readonly layerId: string;
  readonly layerName: string;
  readonly geometryType: string;
  readonly featureCount: number;
  readonly relations: readonly string[];
  readonly availableOperations: readonly string[];
}

export const AI_SPATIAL_OPERATIONS = [
  "buffer",
  "intersect",
  "clip",
  "query",
  "stats",
  "area",
  "length",
  "distance",
  "nearest",
  "convert",
  "dissolve",
  "merge",
  "simplify",
  "group-stats",
  "reclassify",
  "quality-check",
  "split-grid",
  "voronoi",
  "convex-hull",
  "min-bbox",
  "centroid",
  "bearing",
  "make-valid",
  "reproject",
  "convert-format",
  "dem-derivative",
  "contour",
  "raster-calc",
  "raster-info",
  "split-line",
  "explode",
  "vertices",
  "line-intersect",
  "transform",
  "nearest-on-line",
  "grid",
  "split-polygon",
  "spatial-aggregate",
  "distance-matrix",
  "nearest-exact",
  "field-calc",
  "join",
  "raster-cast",
  "raster-nodata",
  "raster-smooth",
  "interpolate",
  "erase",
  "union",
  "spatial-join",
  "viewshed",
  "raster-clip",
  "polygonize",
  "rasterize",
  "zonal",
  "resample",
  "raster-index",
  "focal",
  "quadtree",
  "chart",
  "kernel-density",
  "network-snap",
  "network-distance",
  "service-area",
  "aggregate-grid",
  "offset-line",
  "cost-corridor",
  "classify",
  "hotspot",
  "gwr",
  "od-flow",
  "k-anonymity",
  "dp-grid",
  "kriging",
  "watershed",
  "profile",
  "cut-fill",
  "water-level",
  "layer-stack",
  "geology-inputs",
  "rainfall-runoff",
  "rainfall-landslide",
  "geology-model",
] as const;

export const L0_ONLY = "spatial-runtime" as const;

const GEOMETRY_KEYS = new Set([
  "coordinates",
  "coordinate",
  "geometry",
  "geometries",
  "geom",
  "wkt",
  "wkb",
  "geojson",
  "bbox",
  "extent",
  "envelope",
  "rings",
  "paths",
  "points",
  "lat",
  "lon",
  "latitude",
  "longitude",
]);

const FILE_KEYS = new Set([
  "path",
  "filepath",
  "absolutepath",
  "destinationpath",
  "outputfilepath",
  "sourcepath",
  "sourcepaths",
  "read",
  "file",
  "filename",
]);

export function isGeometryKey(key: string): boolean {
  return GEOMETRY_KEYS.has(key.toLowerCase());
}

/**
 * 敏感字段名黑名单（V0.89 字段分级的保守默认）。
 * 命中黑名单的字段名不得出现在模型可见面；字段名单其余部分可见，属性值仍只出聚合。
 * 通用词（name/名称/id）不进黑名单，避免误伤地名、图斑名等常规字段。
 */
const SENSITIVE_FIELD_PATTERNS: readonly RegExp[] = [
  /姓名|名字|身份证|证件号|身份号|学号|工号|手机号|手机|电话|联系方式|联系人|住址|地址|邮箱|邮件|工资|收入|年龄|出生|生日|密码|账号|帐号|银行卡|银行/,
  /idcard|id_card|identity|phone|mobile|telephone|email|address|birth|birthday|salary|income|password|passwd|username|realname|fullname|gender/i,
  /(?:^|[_-])(?:age|sex)(?:$|[_-])/i,
];

export function isSensitiveFieldName(name: string): boolean {
  return SENSITIVE_FIELD_PATTERNS.some((pattern) => pattern.test(name));
}

/** 字段名列表的投影：去掉敏感字段名，其余保留。 */
export function projectFieldNames(names: readonly string[]): readonly string[] {
  return names.filter((name) => typeof name === "string" && name.trim() !== "" && !isSensitiveFieldName(name));
}

export function isFileKey(key: string): boolean {
  return FILE_KEYS.has(key.toLowerCase());
}

function isCjk(char: string): boolean {
  return /[\u3400-\u9fff]/.test(char);
}

/** 盘符、UNC、`..` 以及路径段之间的斜杠算路径。汉字两侧的斜杠是列举，不是路径。 */
function hasPathSeparator(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== "/" && char !== "\\") continue;
    const before = index > 0 ? text[index - 1] ?? "" : "";
    const after = index + 1 < text.length ? text[index + 1] ?? "" : "";
    if (isCjk(before) && isCjk(after)) continue;
    return true;
  }
  return false;
}

export function looksLikeFilePath(value: string): boolean {
  const text = value.trim();
  if (text === "") return false;
  if (/^[A-Za-z]:/.test(text)) return true;
  if (text.startsWith("\\\\") || text.startsWith("//")) return true;
  if (text.includes("..")) return true;
  if (hasPathSeparator(text)) return true;
  return false;
}

export function looksLikeGdalCommand(value: string): boolean {
  return /^(gdal[a-z0-9_]*|ogr2ogr|ogrinfo)\b/i.test(value.trim());
}

export function looksLikeShellCommand(value: string): boolean {
  return /^(powershell|cmd(\.exe)?|bash|sh)\b/i.test(value.trim());
}

export function looksLikeDatabaseDump(value: string): boolean {
  return /^\s*(select\b|dump\b|pragma\b)/i.test(value.trim());
}
