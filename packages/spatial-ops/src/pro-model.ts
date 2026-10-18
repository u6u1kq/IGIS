// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 本地专业模型权重。不是语言模型，只是训练程序在本地数据上拟合出来的少量参数。
 * 每一份放在 var/models/igis-pro/slots/，当前启用的一份同时写到 model.json。
 * 克里金和汇水只读 model.json。文件不入库；没有启用的文件时，这两项返回不可用。
 * 训练坐标不进这些文件，只有归一化后的参数和训练数据集个数。
 */

export const PRO_MODEL_FORMAT = "igis-pro-model";
export const PRO_MODEL_VERSION = 1;
export const PRO_MODEL_FILE = "model.json";
const PRO_MODEL_SLOTS = "slots";
const PRO_MODEL_ACTIVE = "active.json";

export type VariogramModel = "spherical" | "exponential" | "gaussian";

export interface ProKrigingWeights {
  /** 半变异函数族。 */
  readonly model: VariogramModel;
  /** 块金占基台的比例，0 到 0.95。 */
  readonly nuggetRatio: number;
  /** 变程占点范围对角线的比例。 */
  readonly rangeRatio: number;
  /** 先验强度。拟合目标里先验项的权重是 priorWeight ÷ 点数，点越多越听数据。 */
  readonly priorWeight: number;
  /** 局部克里金的邻点个数。 */
  readonly neighbors: number;
}

export interface ProWatershedWeights {
  /** 河道起始的汇水面积，平方米。 */
  readonly streamArea: number;
  /** 出水口捕捉半径，米。 */
  readonly snapDistance: number;
}

export interface ProModel {
  readonly format: typeof PRO_MODEL_FORMAT;
  readonly version: typeof PRO_MODEL_VERSION;
  readonly name: string;
  readonly kriging: ProKrigingWeights;
  readonly watershed: ProWatershedWeights;
  /** 训练用了几组数据。只是计数。 */
  readonly trainingSets: number;
}

export class ProModelError extends Error {}

export interface ProModelSlot {
  readonly id: string;
  readonly name: string;
}

export interface ProModelLibrary {
  /** 当前写在 model.json 里的那一份。没有启用的权重时是 null。 */
  readonly model: ProModel | null;
  readonly activeId: string;
  readonly slots: readonly ProModelSlot[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numberIn(value: unknown, label: string, low: number, high: number, openLow = false): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ProModelError(`权重 ${label} 不是有限数值。`);
  if (openLow ? value <= low : value < low) throw new ProModelError(`权重 ${label} 超出范围。`);
  if (value > high) throw new ProModelError(`权重 ${label} 超出范围。`);
  return value;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (extra.length > 0) throw new ProModelError(`${label}有不认识的字段 ${extra.slice(0, 5).join("、")}。`);
}

/** 校验权重文件内容。字段缺失、多余、类型不对或超出范围都拒绝，不做默认值补齐。 */
export function parseProModel(value: unknown): ProModel {
  if (!isRecord(value)) throw new ProModelError("权重文件不是 JSON 对象。");
  onlyKeys(value, ["format", "version", "name", "kriging", "watershed", "trainingSets"], "权重文件");
  if (value.format !== PRO_MODEL_FORMAT) throw new ProModelError("权重文件格式不对。");
  if (value.version !== PRO_MODEL_VERSION) throw new ProModelError("权重文件版本不支持。");
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (name === "" || name.length > 80 || !/^[\p{L}\p{N} ._-]+$/u.test(name)) throw new ProModelError("权重文件名称不合法。");
  const kriging = value.kriging;
  const watershed = value.watershed;
  if (!isRecord(kriging) || !isRecord(watershed)) throw new ProModelError("权重文件缺少 kriging 或 watershed。");
  onlyKeys(kriging, ["model", "nuggetRatio", "rangeRatio", "priorWeight", "neighbors"], "权重 kriging ");
  onlyKeys(watershed, ["streamArea", "snapDistance"], "权重 watershed ");
  const model = kriging.model;
  if (model !== "spherical" && model !== "exponential" && model !== "gaussian") throw new ProModelError("权重 kriging.model 只支持 spherical、exponential、gaussian。");
  const neighbors = numberIn(kriging.neighbors, "kriging.neighbors", 4, 64);
  if (!Number.isInteger(neighbors)) throw new ProModelError("权重 kriging.neighbors 必须是整数。");
  const trainingSets = numberIn(value.trainingSets, "trainingSets", 1, 1_000_000);
  if (!Number.isInteger(trainingSets)) throw new ProModelError("权重 trainingSets 必须是整数。");
  return {
    format: PRO_MODEL_FORMAT,
    version: PRO_MODEL_VERSION,
    name,
    kriging: {
      model,
      nuggetRatio: numberIn(kriging.nuggetRatio, "kriging.nuggetRatio", 0, 0.95),
      rangeRatio: numberIn(kriging.rangeRatio, "kriging.rangeRatio", 0.005, 3),
      priorWeight: numberIn(kriging.priorWeight, "kriging.priorWeight", 0, 10_000),
      neighbors,
    },
    watershed: {
      streamArea: numberIn(watershed.streamArea, "watershed.streamArea", 0, 1e12, true),
      snapDistance: numberIn(watershed.snapDistance, "watershed.snapDistance", 0, 100_000),
    },
    trainingSets,
  };
}

/** 读安装目录里的权重。没有目录或没有文件返回 null；文件存在但不合格时抛错。 */
export async function loadProModel(directory: string | undefined): Promise<ProModel | null> {
  if (!directory) return null;
  let text: string;
  try {
    text = await readFile(join(directory, PRO_MODEL_FILE), { encoding: "utf8" });
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ProModelError("权重文件不是合法 JSON。");
  }
  return parseProModel(parsed);
}

function slotId(name: string): string {
  return createHash("sha256").update(name).digest("hex").slice(0, 12);
}

function slotFile(directory: string, id: string): string {
  return join(directory, PRO_MODEL_SLOTS, `${id}.json`);
}

async function readJson(path: string): Promise<unknown> {
  const text = await readFile(path, { encoding: "utf8" });
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProModelError("权重文件不是合法 JSON。");
  }
}

async function writeActive(directory: string, id: string, model: ProModel): Promise<void> {
  const body = `${JSON.stringify(model, null, 2)}\n`;
  await mkdir(join(directory, PRO_MODEL_SLOTS), { recursive: true });
  await writeFile(slotFile(directory, id), body, { encoding: "utf8" });
  await writeFile(join(directory, PRO_MODEL_ACTIVE), `${JSON.stringify({ id })}\n`, { encoding: "utf8" });
  await writeFile(join(directory, PRO_MODEL_FILE), body, { encoding: "utf8" });
}

/** 校验后写入权重库，并启用这一份。同名权重会替换库里的那一份，其他份保留。不合格的内容不会落盘。 */
export async function installProModel(directory: string, value: unknown): Promise<ProModel> {
  const model = parseProModel(value);
  await mkdir(directory, { recursive: true });
  await writeActive(directory, slotId(model.name), model);
  return model;
}

/** 库里的权重。旧的单文件安装会在第一次列出时收进库里。 */
export async function listProModelSlots(directory: string): Promise<ProModelLibrary> {
  let names: string[] = [];
  try {
    names = await readdir(join(directory, PRO_MODEL_SLOTS));
  } catch {
    names = [];
  }
  if (names.length === 0) {
    const legacy = await loadProModel(directory);
    if (legacy) await writeActive(directory, slotId(legacy.name), legacy);
  }
  const slots: ProModelSlot[] = [];
  let slotNames: string[] = [];
  try {
    slotNames = await readdir(join(directory, PRO_MODEL_SLOTS));
  } catch {
    slotNames = [];
  }
  for (const name of slotNames) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (!/^[a-f0-9]{12}$/.test(id)) continue;
    try {
      const model = parseProModel(await readJson(slotFile(directory, id)));
      slots.push({ id, name: model.name });
    } catch (error) {
      if (!(error instanceof ProModelError)) throw error;
    }
  }
  slots.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  let activeId = "";
  try {
    const marker = await readJson(join(directory, PRO_MODEL_ACTIVE));
    if (isRecord(marker) && typeof marker.id === "string" && slots.some((slot) => slot.id === marker.id)) activeId = marker.id;
  } catch {
    activeId = "";
  }
  const model = await loadProModel(directory);
  if (activeId === "" && model) {
    const match = slots.find((slot) => slot.name === model.name);
    if (match) activeId = match.id;
  }
  return { model, activeId, slots };
}

/** 把库里的一份写成当前的 model.json。克里金和汇水随后读这一份。 */
export async function activateProModel(directory: string, id: string): Promise<ProModel> {
  if (!/^[a-f0-9]{12}$/.test(id)) throw new ProModelError("没有这份权重。");
  let model: ProModel;
  try {
    model = parseProModel(await readJson(slotFile(directory, id)));
  } catch (error) {
    if (error instanceof ProModelError) throw new ProModelError("没有这份权重。");
    throw error;
  }
  await writeActive(directory, id, model);
  return model;
}
