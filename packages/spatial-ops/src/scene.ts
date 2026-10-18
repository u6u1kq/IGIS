// SPDX-License-Identifier: Apache-2.0

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 当前对话的三维页登记。保存图层标识、名称、层间间距、地层输入字段、情景时刻和栅格句柄。
 * 不保存坐标、几何或路径。地形只记对话里的裸文件名，给页面时换成情景编号。
 */

export const SCENE_FILE = "scene.json";
export const GEOLOGY_FILE = "scene-geology.json";

export interface SceneLayerRef {
  readonly layerId: string;
  readonly layerName: string;
}

export interface SceneStack {
  readonly order: readonly SceneLayerRef[];
  readonly gap: number;
}

export interface SceneGeology {
  readonly layerId: string;
  readonly layerName: string;
  readonly contactField: string;
  readonly dipField: string;
  readonly azimuthField: string;
}

export interface SceneSeriesStep {
  readonly hours: number;
  readonly handle: string;
}

export interface SceneSeries {
  readonly seriesId: string;
  readonly kind: "runoff" | "landslide";
  readonly label: string;
  /** 情景所用高程栅格在对话里的裸文件名。不给页面。 */
  readonly terrain: string;
  readonly steps: readonly SceneSeriesStep[];
  /** 径流情景的最大流速栅格句柄。 */
  readonly peak: string | null;
}

export interface SceneGeologyModel {
  readonly units: readonly string[];
  readonly volumes: readonly number[];
  /** 定范围和削顶用的高程栅格裸文件名。不给页面。 */
  readonly terrain: string | null;
}

export interface SceneFile {
  readonly stack: SceneStack | null;
  readonly geology: SceneGeology | null;
  readonly series: readonly SceneSeries[];
  readonly geologyModel: SceneGeologyModel | null;
}

export interface ScenePageSeries {
  readonly seriesId: string;
  readonly kind: "runoff" | "landslide";
  readonly label: string;
  readonly steps: readonly SceneSeriesStep[];
  readonly peak: string | null;
}

export interface ScenePage {
  readonly ok: true;
  readonly layers: readonly SceneLayerRef[];
  readonly rasters: readonly { readonly handle: string }[];
  readonly stack: SceneStack | null;
  readonly geology: SceneGeology | null;
  readonly series: readonly ScenePageSeries[];
  readonly geologyModel: { readonly units: readonly string[]; readonly volumes: readonly number[]; readonly clipped: boolean } | null;
  readonly note: string;
}

const BANNED = new Set([
  "coordinates",
  "coordinate",
  "geometry",
  "geometries",
  "geom",
  "wkt",
  "wkb",
  "path",
  "paths",
  "outputfilepath",
  "absolute",
  "relative",
]);

const HANDLE = /^ras-[0-9a-f]{10}$/;
const BARE_RASTER = /^[^\\/:*?"<>|]{1,128}\.tiff?$/i;

export function emptyScene(): SceneFile {
  return { stack: null, geology: null, series: [], geologyModel: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function banned(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => banned(item));
  if (!isRecord(value)) return false;
  for (const [key, item] of Object.entries(value)) {
    if (BANNED.has(key.toLowerCase()) || banned(item)) return true;
  }
  return false;
}

function text(value: unknown, limit = 80): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > limit ? "" : trimmed;
}

function layerRef(value: unknown): SceneLayerRef | null {
  if (!isRecord(value)) return null;
  const layerId = text(value.layerId);
  const layerName = text(value.layerName);
  if (layerId === "" || layerName === "") return null;
  return { layerId, layerName };
}

function parseStack(value: unknown): SceneStack | null {
  if (!isRecord(value) || !Array.isArray(value.order)) return null;
  const order: SceneLayerRef[] = [];
  for (const item of value.order) {
    const layer = layerRef(item);
    if (!layer) return null;
    order.push(layer);
  }
  const gap = value.gap;
  if (order.length < 2 || typeof gap !== "number" || !Number.isFinite(gap) || gap < 0) return null;
  return { order, gap };
}

function parseGeology(value: unknown): SceneGeology | null {
  if (!isRecord(value)) return null;
  const layerId = text(value.layerId);
  const layerName = text(value.layerName);
  const contactField = text(value.contactField);
  const dipField = text(value.dipField);
  const azimuthField = text(value.azimuthField);
  if ([layerId, layerName, contactField, dipField, azimuthField].some((item) => item === "")) return null;
  return { layerId, layerName, contactField, dipField, azimuthField };
}

function parseSeries(value: unknown): SceneSeries | null {
  if (!isRecord(value) || !Array.isArray(value.steps)) return null;
  const seriesId = text(value.seriesId);
  const label = text(value.label, 120);
  const terrain = text(value.terrain, 128);
  const kind = value.kind === "runoff" || value.kind === "landslide" ? value.kind : null;
  if (seriesId === "" || label === "" || kind === null || !BARE_RASTER.test(terrain)) return null;
  const steps: SceneSeriesStep[] = [];
  for (const item of value.steps) {
    if (!isRecord(item) || typeof item.hours !== "number" || !Number.isFinite(item.hours) || typeof item.handle !== "string" || !HANDLE.test(item.handle)) return null;
    steps.push({ hours: item.hours, handle: item.handle });
  }
  if (steps.length === 0) return null;
  const peak = typeof value.peak === "string" && HANDLE.test(value.peak) ? value.peak : null;
  return { seriesId, kind, label, terrain, steps, peak };
}

function parseGeologyModel(value: unknown): SceneGeologyModel | null {
  if (!isRecord(value) || !Array.isArray(value.units) || !Array.isArray(value.volumes)) return null;
  const units = value.units.map((item) => text(item));
  const volumes = value.volumes.filter((item): item is number => typeof item === "number" && Number.isFinite(item) && item >= 0);
  if (units.length < 2 || units.some((item) => item === "") || volumes.length !== units.length) return null;
  const terrain = typeof value.terrain === "string" && BARE_RASTER.test(value.terrain) ? value.terrain : null;
  return { units, volumes, terrain };
}

export function parseScene(value: unknown): SceneFile {
  if (!isRecord(value) || banned(value)) return emptyScene();
  const series = Array.isArray(value.series)
    ? value.series.map(parseSeries).filter((item): item is SceneSeries => item !== null)
    : [];
  return {
    stack: parseStack(value.stack),
    geology: parseGeology(value.geology),
    series,
    geologyModel: parseGeologyModel(value.geologyModel),
  };
}

export async function readSceneFile(workspace: string): Promise<SceneFile> {
  try {
    const content = await readFile(join(workspace, SCENE_FILE), { encoding: "utf8" });
    return parseScene(JSON.parse(content) as unknown);
  } catch {
    return emptyScene();
  }
}

export async function writeSceneFile(workspace: string, scene: SceneFile): Promise<void> {
  const clean = parseScene(scene);
  if (banned(clean)) throw new Error("三维页登记不能包含坐标或路径。");
  await writeFile(join(workspace, SCENE_FILE), `${JSON.stringify(clean, null, 2)}\n`, { encoding: "utf8" });
}

/** 三维页只接收图层标识、情景编号、时刻和栅格句柄。地形文件名留在服务端。 */
export function sceneForPage(input: {
  readonly layers: readonly SceneLayerRef[];
  readonly handles: readonly string[];
  readonly collided: boolean;
  readonly scene: SceneFile;
}): ScenePage {
  const scene = parseScene(input.scene);
  const note = input.collided ? "有栅格句柄对应多个文件，这些句柄没有列出。" : "";
  return {
    ok: true,
    layers: input.layers.map((layer) => ({ layerId: layer.layerId, layerName: layer.layerName })),
    rasters: input.handles.map((handle) => ({ handle })),
    stack: scene.stack,
    geology: scene.geology,
    series: scene.series.map((item) => ({ seriesId: item.seriesId, kind: item.kind, label: item.label, steps: item.steps, peak: item.peak })),
    geologyModel: scene.geologyModel
      ? { units: scene.geologyModel.units, volumes: scene.geologyModel.volumes, clipped: scene.geologyModel.terrain !== null }
      : null,
    note,
  };
}
