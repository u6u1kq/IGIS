// SPDX-License-Identifier: Apache-2.0

import { loadModelManifest } from "@igis/ai-boundary";
import type { ModelManifest } from "@igis/ai-boundary";
import { boundaryViolation } from "./ai-to-local.js";

/**
 * 出站网关。模型可见工具在这里过滤。
 * 工具结果原样返回。
 */

export class BoundaryError extends Error {
  readonly code = "boundary-rejected" as const;

  constructor(message: string) {
    super(message);
    this.name = "BoundaryError";
  }
}

const BLOCKED_TOOLS = new Set([
  "list-layers",
  "list_layers",
  "get-layer-metadata",
  "get_layer_metadata",
  "get-sample-feature",
  "get_sample_feature",
  "io.read",
  "io_read",
  "read_gis_file",
  "io.listlayers",
  "io_listlayers",
  "list_memory_layers",
  "map.load",
  "map_load",
  "load_map_layer",
  "map.exportgeojson",
  "map_exportgeojson",
  "export_geojson",
  "map.exportcoordinates",
  "map_exportcoordinates",
]);

export function isModelVisibleTool(name: string): boolean {
  const key = name.trim().toLowerCase();
  if (key === "") return false;
  if (BLOCKED_TOOLS.has(key)) return false;
  if (/gdal|ogr2ogr|ogrinfo|filesystem|shell|powershell|javascript/.test(key)) return false;
  if (/readfile|read_file|readgis|fs\.read/.test(key)) return false;
  if (/127\.0\.0\.1|localhost|file:\/\//.test(key)) return false;
  if (/\b(?:eval|function)\b/.test(key)) return false;
  return true;
}

export function rejectModelToolCall(tool: string, args: unknown): { readonly ok: false; readonly code: string; readonly message: string } | null {
  if (!isModelVisibleTool(tool)) {
    return { ok: false, code: "capability-rejected", message: "模型不能直接读取文件、几何或调用 GDAL。" };
  }
  const violation = boundaryViolation(args);
  if (!violation) return null;
  if (violation === "filesystem-rejected") return { ok: false, code: violation, message: "模型不能读取或打开本地 GIS 文件。" };
  if (violation === "gdal-rejected") return { ok: false, code: violation, message: "模型不能直接调用 GDAL。" };
  if (violation === "geometry-rejected") return { ok: false, code: violation, message: "模型不能提交原始几何。" };
  return { ok: false, code: violation, message: "模型不能使用文件系统、外壳或数据库转储。" };
}

/** 结果原样交给模型。 */
export function releaseToModel(value: unknown, _manifest: ModelManifest = loadModelManifest()): unknown {
  return value;
}
