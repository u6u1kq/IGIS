// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashSourceContent } from "@igis/provenance";
import type { MapCollection } from "./types.js";

/**
 * 本地空间结果缓存。键只包含会改变结果的输入，不写入整层对象，也不写坐标。
 * 运算、输入图层 id、每个输入图层的规范坐标系、距离、单位、输出名、
 * 查询种类、属性筛选（有则写入）和几何内容哈希。参数名按字母序固定，便于对照。
 */
export function geometryContentHash(collection: MapCollection): string {
  const canonical = JSON.stringify(collection.features.map((feature) => feature.geometry ?? null));
  return hashSourceContent(canonical);
}

export function spatialCacheKey(
  operation: string,
  layerIds: readonly string[],
  params: Readonly<Record<string, string | number | boolean>>,
  geometryHash: string,
  crsLabels: readonly string[] = [],
): string {
  const normalized: Record<string, string | number | boolean> = {};
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") normalized[key] = value;
  }
  const inputs = layerIds.map((layerId, index) => ({
    layerId,
    crsLabel: crsLabels[index] ?? "",
  }));
  return hashSourceContent(JSON.stringify({
    operation,
    inputs,
    params: normalized,
    geometryHash,
  }));
}

export interface CachedLayerRef {
  readonly layerId: string;
  readonly layerName: string;
  /** 参与这次运算的输入图层。删除其中任一层时用来作废这条缓存。 */
  readonly inputLayerIds?: readonly string[];
}

const CACHE_FILE = /^[a-f0-9]{64}\.json$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

interface CacheFileRecord {
  readonly key: string;
  readonly layerId: string;
  readonly layerName: string;
  readonly inputLayerIds: readonly string[];
}

export class SpatialResultCache {
  constructor(private readonly directory: string) {}

  async get(key: string): Promise<CachedLayerRef | null> {
    if (!/^[a-f0-9]{64}$/.test(key)) return null;
    try {
      const parsed = JSON.parse(await readFile(join(this.directory, `${key}.json`), { encoding: "utf8" })) as unknown;
      if (!isRecord(parsed)) return null;
      if (typeof parsed.layerId !== "string" || typeof parsed.layerName !== "string") return null;
      if (/"coordinates"\s*:/.test(parsed.layerName) || /"coordinates"\s*:/.test(parsed.layerId)) return null;
      return { layerId: parsed.layerId, layerName: parsed.layerName };
    } catch {
      return null;
    }
  }

  async put(key: string, value: CachedLayerRef): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(key)) return;
    await mkdir(this.directory, { recursive: true });
    const payload = {
      key,
      layerId: value.layerId,
      layerName: value.layerName,
      inputLayerIds: [...(value.inputLayerIds ?? [])],
    };
    await writeFile(join(this.directory, `${key}.json`), `${JSON.stringify(payload)}\n`, { encoding: "utf8" });
  }

  /**
   * 只查看这个缓存目录。结果图层 id 命中，或键里的输入图层 id 命中，就删掉那一条。
   * 目录不存在当作没有缓存。读失败或删除失败会抛出，调用方不能把它当成删除成功。
   */
  async invalidateLayer(layerId: string): Promise<void> {
    const names = await this.cacheFileNames();
    for (const name of names) {
      const record = await this.readRecord(name);
      const hit = record.layerId === layerId || record.inputLayerIds.includes(layerId);
      if (!hit) continue;
      await rm(join(this.directory, name), { recursive: true, force: true });
    }
  }

  /**
   * 这个键如果指向即将删除的结果图层，就删掉文件。
   * 指向别的图层时保留，避免清掉仍有图层依赖的共享缓存。
   * 文件不存在返回 missing。读失败会抛出。
   */
  async dropIfPointsAt(key: string, resultLayerIds: readonly string[]): Promise<"removed" | "kept" | "missing"> {
    if (!/^[a-f0-9]{64}$/.test(key)) return "missing";
    let record: CacheFileRecord;
    try {
      record = await this.readRecord(`${key}.json`);
    } catch (error) {
      if (isEnoent(error)) return "missing";
      throw error;
    }
    if (!resultLayerIds.includes(record.layerId)) return "kept";
    await rm(join(this.directory, `${key}.json`), { recursive: true, force: true });
    return "removed";
  }

  /** 只改指向该结果图层的缓存文件里的 layerName，不重算几何，也不改键。 */
  async renameStoredLayer(layerId: string, layerName: string): Promise<void> {
    const names = await this.cacheFileNames();
    for (const name of names) {
      const record = await this.readRecord(name);
      if (record.layerId !== layerId || record.layerName === layerName) continue;
      const payload = {
        key: record.key,
        layerId: record.layerId,
        layerName,
        inputLayerIds: [...record.inputLayerIds],
      };
      await writeFile(join(this.directory, name), `${JSON.stringify(payload)}\n`, { encoding: "utf8" });
    }
  }

  private async cacheFileNames(): Promise<string[]> {
    try {
      const names = await readdir(this.directory);
      return names.filter((name) => CACHE_FILE.test(name));
    } catch (error) {
      if (isEnoent(error)) return [];
      throw error;
    }
  }

  private async readRecord(name: string): Promise<CacheFileRecord> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(this.directory, name), { encoding: "utf8" })) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`缓存记录无法读取：${name}`);
      throw error;
    }
    if (!isRecord(parsed) || typeof parsed.layerId !== "string" || typeof parsed.layerName !== "string") {
      throw new Error(`缓存记录无法读取：${name}`);
    }
    const inputLayerIds = Array.isArray(parsed.inputLayerIds)
      ? parsed.inputLayerIds.filter((item): item is string => typeof item === "string")
      : [];
    const key = typeof parsed.key === "string" ? parsed.key : name.slice(0, -".json".length);
    return { key, layerId: parsed.layerId, layerName: parsed.layerName, inputLayerIds };
  }
}

/** 相同的键只计算一次，第二次返回已缓存的图层引用。 */
export async function takeCachedOrCompute<T extends CachedLayerRef>(
  cache: SpatialResultCache,
  key: string,
  compute: () => Promise<T>,
): Promise<{ readonly value: T; readonly cached: boolean }> {
  const hit = await cache.get(key);
  if (hit) return { value: hit as T, cached: true };
  const value = await compute();
  await cache.put(key, {
    layerId: value.layerId,
    layerName: value.layerName,
    ...(value.inputLayerIds ? { inputLayerIds: value.inputLayerIds } : {}),
  });
  return { value, cached: false };
}
