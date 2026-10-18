// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 本地专业模型权重。不是语言模型，只是训练程序在本地数据上拟合出来的少量参数。
 * 文件放在 var/models/igis-pro/model.json，不入库；没有这个文件时，依赖它的工具返回不可用。
 * 训练坐标不进这个文件，只有归一化后的参数和训练数据集个数。
 */

export const PRO_MODEL_FORMAT = "igis-pro-model";
export const PRO_MODEL_VERSION = 1;
export const PRO_MODEL_FILE = "model.json";

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

/** 校验后写入安装目录。不合格的内容不会落盘。 */
export async function installProModel(directory: string, value: unknown): Promise<ProModel> {
  const model = parseProModel(value);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, PRO_MODEL_FILE), `${JSON.stringify(model, null, 2)}\n`, { encoding: "utf8" });
  return model;
}
