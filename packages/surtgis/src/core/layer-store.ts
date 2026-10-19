// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { crsAgrees, crsLabelFor, identifyCrs, resolveStoredCrs } from "./crs-identity.js";
import type { CrsIdentity } from "./crs-identity.js";
import { SurtGisCoreError } from "./errors.js";
import type { CoreCollection, LayerStyle } from "./types.js";

/**
 * 统一图层库。顺序、显隐和样式都在这里，几何只在 geojson 文件和内存里。
 * 磁盘布局沿用 V0.5 的 var/map-layers：每层一个 .geojson 和一个 .meta.json，
 * 另加一份 layer-store.json 记顺序和样式。旧目录可以直接恢复。
 */
export const LAYER_STORE_STATE_FILE = "layer-store.json";
export const DEFAULT_CRS_LABEL = "未声明";

const PALETTE = ["#2f6f5e", "#3d6f9a", "#8a5a2a", "#6b4c7a", "#8d3b3b"] as const;
const COLOR = /^#[0-9a-fA-F]{6}$/;

export interface LayerMeta {
  readonly layerId: string;
  readonly layerName: string;
  readonly sourcePaths: readonly string[];
  readonly outputFilePath: string;
  readonly featureCount: number;
  readonly fieldNames: readonly string[];
  readonly geometryKind: string;
  readonly crsLabel: string;
  /** 图层库里的坐标系身份。crsLabel 只是它的兼容显示串。 */
  readonly crsIdentity: CrsIdentity;
  /** 载入时读到的 WKT 投影定义。空间运算变换用；没有就是 undefined。 */
  readonly crsWkt?: string;
  /** 图层几何内容的稳定哈希（64 位十六进制）。入库时算一次，缓存键复用。 */
  readonly geometryHash?: string;
}

interface StoredLayer extends LayerMeta {
  readonly collection: CoreCollection;
}

export interface LayerStyleInput {
  readonly fill?: unknown;
  readonly outline?: unknown;
  readonly width?: unknown;
  readonly opacity?: unknown;
  readonly visible?: unknown;
  readonly colorField?: unknown;
  readonly labelField?: unknown;
}

let sequence = 0;

function nextLayerId(): string {
  sequence += 1;
  return `lyr-${Date.now().toString(16)}-${sequence}`;
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function samePath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

export function fieldNamesOf(collection: CoreCollection): string[] {
  const names = new Set<string>();
  for (const feature of collection.features) {
    for (const key of Object.keys(feature.properties)) {
      if (key !== "_fid") names.add(key);
    }
  }
  return [...names];
}

export function geometryKindOf(collection: CoreCollection): string {
  const kinds = new Set<string>();
  for (const feature of collection.features) {
    const type = feature.geometry.type;
    if (type === "Point" || type === "MultiPoint") kinds.add("point");
    else if (type === "LineString" || type === "MultiLineString") kinds.add("line");
    else if (type === "Polygon" || type === "MultiPolygon") kinds.add("polygon");
    else kinds.add("other");
  }
  if (kinds.size === 0) return "empty";
  if (kinds.size === 1) return [...kinds][0] ?? "unknown";
  return "mixed";
}

export function defaultLayerStyle(index: number): LayerStyle {
  return {
    fill: PALETTE[index % PALETTE.length] ?? "#2f6f5e",
    outline: "#1c2430",
    width: 1.5,
    opacity: 0.55,
    visible: true,
    colorField: null,
    labelField: null,
  };
}

function clampNumber(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, value));
}

/** 合并样式补丁。非法值保持原样，不抛错。 */
export function mergeLayerStyle(current: LayerStyle, patch: LayerStyleInput): LayerStyle {
  const fill = typeof patch.fill === "string" && COLOR.test(patch.fill) ? patch.fill.toLowerCase() : current.fill;
  const outline = typeof patch.outline === "string" && COLOR.test(patch.outline) ? patch.outline.toLowerCase() : current.outline;
  const width = clampNumber(patch.width, 0.5, 12) ?? current.width;
  const opacity = clampNumber(patch.opacity, 0, 1) ?? current.opacity;
  const visible = typeof patch.visible === "boolean" ? patch.visible : current.visible;
  const colorField = fieldStyle(patch.colorField, current.colorField);
  const labelField = fieldStyle(patch.labelField, current.labelField);
  return { fill, outline, width, opacity, visible, colorField, labelField };
}

function fieldStyle(value: unknown, current: string | null): string | null {
  if (typeof value !== "string") return current;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!/^[A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff]{0,63}$/.test(trimmed)) return current;
  return trimmed;
}

function readStyle(value: unknown, fallback: LayerStyle): LayerStyle {
  return isRecord(value) ? mergeLayerStyle(fallback, value) : fallback;
}

/** 落盘读回的 WKT 投影定义。形状不对就当没有，不用它做变换。 */
function readableWkt(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length < 16 || trimmed.length > 8192) return undefined;
  if (!/^(PROJCS|GEOGCS)\[/i.test(trimmed)) return undefined;
  return trimmed;
}

/** 落盘读回的几何哈希。形状不对就当没有，运算时现算。 */
function readableGeometryHash(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}

export class LayerStore {
  private readonly layers = new Map<string, StoredLayer>();
  private readonly styles = new Map<string, LayerStyle>();
  private orderIds: string[] = [];
  private stateWrite: Promise<void> = Promise.resolve();
  private created = 0;
  private afterRemove: ((layerId: string) => Promise<void>) | null = null;
  private afterRename: ((layerId: string, layerName: string) => Promise<void>) | null = null;

  constructor(private readonly directory: string) {}

  async restore(): Promise<void> {
    let names: string[] = [];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (isEnoent(error)) return;
      throw error;
    }
    const restored: string[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith(".meta.json")) continue;
      try {
        const metaText = await readFile(join(this.directory, name), { encoding: "utf8" });
        const meta = JSON.parse(metaText) as unknown;
        if (!isRecord(meta) || typeof meta.layerId !== "string" || typeof meta.outputFilePath !== "string") continue;
        const raw = await readFile(meta.outputFilePath, { encoding: "utf8" });
        const parsed = JSON.parse(raw) as unknown;
        if (!isRecord(parsed) || parsed.type !== "FeatureCollection" || !Array.isArray(parsed.features)) continue;
        const collection = parsed as unknown as CoreCollection;
        const layerName = typeof meta.layerName === "string" ? meta.layerName : meta.layerId;
        const sourcePaths = Array.isArray(meta.sourcePaths) ? meta.sourcePaths.filter((item): item is string => typeof item === "string") : [];
        const crsWkt = readableWkt(meta.crsWkt);
        const crsIdentity = resolveStoredCrs(meta.crsLabel, meta.crsIdentity, crsWkt);
        const geometryHash = readableGeometryHash(meta.geometryHash);
        const stored: StoredLayer = {
          layerId: meta.layerId,
          layerName,
          sourcePaths,
          outputFilePath: meta.outputFilePath,
          featureCount: collection.features.length,
          fieldNames: fieldNamesOf(collection),
          geometryKind: geometryKindOf(collection),
          crsIdentity,
          crsLabel: crsLabelFor(crsIdentity),
          ...(crsWkt !== undefined ? { crsWkt } : {}),
          ...(geometryHash !== undefined ? { geometryHash } : {}),
          collection,
        };
        this.layers.set(stored.layerId, stored);
        restored.push(stored.layerId);
      } catch {
        // 单个历史图层损坏时跳过。
      }
    }
    this.created = restored.length;
    let state: unknown = null;
    try {
      state = JSON.parse(await readFile(join(this.directory, LAYER_STORE_STATE_FILE), { encoding: "utf8" })) as unknown;
    } catch {
      state = null;
    }
    const savedOrder = isRecord(state) && Array.isArray(state.order)
      ? state.order.filter((id): id is string => typeof id === "string" && this.layers.has(id))
      : [];
    const savedStyles = isRecord(state) && isRecord(state.styles) ? state.styles : {};
    const unseen = restored.filter((id) => !savedOrder.includes(id)).reverse();
    this.orderIds = [...new Set([...savedOrder, ...unseen])];
    restored.forEach((id, index) => {
      this.styles.set(id, readStyle(savedStyles[id], defaultLayerStyle(index)));
    });
  }

  private snapshot(layer: StoredLayer): LayerMeta {
    return {
      layerId: layer.layerId,
      layerName: layer.layerName,
      sourcePaths: layer.sourcePaths,
      outputFilePath: layer.outputFilePath,
      featureCount: layer.featureCount,
      fieldNames: layer.fieldNames,
      geometryKind: layer.geometryKind,
      crsLabel: layer.crsLabel,
      crsIdentity: layer.crsIdentity,
      ...(layer.crsWkt !== undefined ? { crsWkt: layer.crsWkt } : {}),
      ...(layer.geometryHash !== undefined ? { geometryHash: layer.geometryHash } : {}),
    };
  }

  /** 按叠放顺序返回，第一个在最上面。 */
  list(): readonly LayerMeta[] {
    return this.orderIds
      .map((id) => this.layers.get(id))
      .filter((layer): layer is StoredLayer => layer !== undefined)
      .map((layer) => this.snapshot(layer));
  }

  get(layerId: string): LayerMeta | null {
    const layer = this.layers.get(layerId);
    return layer ? this.snapshot(layer) : null;
  }

  /** 同名图层取叠放最靠上的那个。 */
  findByName(layerName: string): LayerMeta | null {
    for (const id of this.orderIds) {
      const layer = this.layers.get(id);
      if (layer && layer.layerName === layerName) return this.snapshot(layer);
    }
    return null;
  }

  collection(layerId: string): CoreCollection | null {
    return this.layers.get(layerId)?.collection ?? null;
  }

  order(): readonly string[] {
    return [...this.orderIds];
  }

  style(layerId: string): LayerStyle | null {
    return this.styles.get(layerId) ?? null;
  }

  async insert(input: {
    readonly layerName: string;
    readonly sourcePaths: readonly string[];
    readonly collection: CoreCollection;
    readonly crsLabel?: string;
    readonly crsIdentity?: CrsIdentity;
    readonly crsWkt?: string;
    readonly geometryHash?: string;
    readonly style?: LayerStyleInput;
  }): Promise<LayerMeta> {
    const layerId = nextLayerId();
    const outputFilePath = join(this.directory, `${layerId}.geojson`);
    const fromLabel = identifyCrs(input.crsLabel);
    const identity = input.crsIdentity ?? fromLabel;
    const labelAgrees = !input.crsIdentity || crsAgrees(input.crsIdentity, fromLabel) || input.crsLabel === crsLabelFor(input.crsIdentity);
    if (input.crsIdentity && input.crsLabel !== undefined && !labelAgrees && fromLabel.kind !== "unknown") {
      throw new SurtGisCoreError("调用方给出的坐标系和要写入的坐标系不一致，已拒绝，没有改写。");
    }
    const crsWkt = readableWkt(input.crsWkt);
    const geometryHash = readableGeometryHash(input.geometryHash);
    const stored: StoredLayer = {
      layerId,
      layerName: input.layerName,
      sourcePaths: [...input.sourcePaths],
      outputFilePath,
      featureCount: input.collection.features.length,
      fieldNames: fieldNamesOf(input.collection),
      geometryKind: geometryKindOf(input.collection),
      crsIdentity: identity,
      crsLabel: crsLabelFor(identity),
      ...(crsWkt !== undefined ? { crsWkt } : {}),
      ...(geometryHash !== undefined ? { geometryHash } : {}),
      collection: input.collection,
    };
    await mkdir(this.directory, { recursive: true });
    await writeFile(outputFilePath, JSON.stringify(input.collection), { encoding: "utf8" });
    await this.writeMeta(stored);
    this.layers.set(layerId, stored);
    const base = defaultLayerStyle(this.created);
    this.created += 1;
    this.styles.set(layerId, input.style ? mergeLayerStyle(base, input.style) : base);
    this.orderIds = [layerId, ...this.orderIds.filter((id) => id !== layerId)];
    await this.writeState();
    return this.snapshot(stored);
  }

  /** 删除和重命名时通知缓存。钩子抛错会原样抛出，不当成删除或改名已经完成。 */
  bindLifecycle(hooks: {
    readonly afterRemove?: (layerId: string) => Promise<void>;
    readonly afterRename?: (layerId: string, layerName: string) => Promise<void>;
  }): void {
    this.afterRemove = hooks.afterRemove ?? null;
    this.afterRename = hooks.afterRename ?? null;
  }

  /** 重投影的目标是标准 EPSG 时，把这个声明写进图层。读回的文件经常不带代码。 */
  async assignKnownEpsg(layerId: string, epsg: number): Promise<LayerMeta | null> {
    const current = this.layers.get(layerId);
    if (!current || !Number.isInteger(epsg) || epsg <= 0) return null;
    const crsIdentity: CrsIdentity = { kind: "known", canonical: `EPSG:${epsg}`, epsg };
    const next: StoredLayer = { ...current, crsIdentity, crsLabel: crsLabelFor(crsIdentity) };
    this.layers.set(layerId, next);
    await this.writeMeta(next);
    return this.snapshot(next);
  }

  async rename(layerId: string, layerName: string): Promise<LayerMeta> {
    const current = this.layers.get(layerId);
    if (!current) throw new SurtGisCoreError("找不到这个图层。");
    const next: StoredLayer = { ...current, layerName };
    this.layers.set(layerId, next);
    await this.writeMeta(next);
    if (this.afterRename) await this.afterRename(layerId, layerName);
    return this.snapshot(next);
  }

  async updateStyle(layerId: string, patch: LayerStyleInput): Promise<LayerStyle> {
    const current = this.styles.get(layerId);
    if (!current || !this.layers.has(layerId)) throw new SurtGisCoreError("找不到这个图层。");
    const next = mergeLayerStyle(current, patch);
    this.styles.set(layerId, next);
    await this.writeState();
    return next;
  }

  /** 新顺序里没提到的图层保持原来的相对位置，排在后面。 */
  async setOrder(layerIds: readonly string[]): Promise<readonly string[]> {
    const wanted = layerIds.filter((id, index) => this.layers.has(id) && layerIds.indexOf(id) === index);
    const rest = this.orderIds.filter((id) => !wanted.includes(id));
    this.orderIds = [...wanted, ...rest];
    await this.writeState();
    return this.order();
  }

  /** 只移除此图层在地图目录里的生成文件，不删除源数据，也不调用 GDAL。 */
  async remove(layerId: string): Promise<boolean> {
    const current = this.layers.get(layerId);
    if (!current) return false;
    const metaPath = join(this.directory, `${layerId}.meta.json`);
    const generated = [current.outputFilePath, metaPath];
    if (current.sourcePaths.some((path) => generated.some((item) => samePath(item, path)))) {
      throw new SurtGisCoreError("不会删除源数据文件。");
    }
    if (this.afterRemove) await this.afterRemove(layerId);
    await this.clearStaleSourcePaths(current);
    await this.discardGenerated(current.outputFilePath);
    await this.discardGenerated(metaPath);
    this.layers.delete(layerId);
    this.styles.delete(layerId);
    this.orderIds = this.orderIds.filter((id) => id !== layerId);
    await this.writeState();
    return true;
  }

  /** 派生图层保留几何，只去掉已删除图层的生成路径，避免它继续被当成活的来源。 */
  private async clearStaleSourcePaths(removed: StoredLayer): Promise<void> {
    const stale = removed.outputFilePath;
    for (const layer of [...this.layers.values()]) {
      if (layer.layerId === removed.layerId) continue;
      if (!layer.sourcePaths.some((path) => samePath(path, stale))) continue;
      const next: StoredLayer = {
        ...layer,
        sourcePaths: layer.sourcePaths.filter((path) => !samePath(path, stale)),
      };
      this.layers.set(layer.layerId, next);
      await this.writeMeta(next);
    }
  }

  async exportTo(layerId: string, destinationPath: string): Promise<string> {
    const layer = this.layers.get(layerId);
    if (!layer) throw new SurtGisCoreError("找不到要导出的图层。");
    const destination = resolve(destinationPath);
    if (destination.trim() === "") throw new SurtGisCoreError("请填写导出路径。");
    const blocked = [layer.outputFilePath, ...layer.sourcePaths];
    if (blocked.some((path) => samePath(path, destination))) {
      throw new SurtGisCoreError("导出路径必须和源文件不同，不能覆盖源数据。");
    }
    await mkdir(dirname(destination), { recursive: true });
    try {
      await stat(destination);
      throw new SurtGisCoreError("目标文件已存在，请换一个新路径。");
    } catch (error) {
      if (error instanceof SurtGisCoreError) throw error;
      if (!isEnoent(error)) throw new SurtGisCoreError("导出没有完成，请换一个可写的新路径。");
    }
    // 导出的 GeoJSON 带上 crs 成员，重新导入时身份不丢。只有标准 EPSG 标签才写。
    const exported = /^EPSG:\d+$/.test(layer.crsLabel)
      ? { ...layer.collection, crs: { type: "name", properties: { name: layer.crsLabel } } }
      : layer.collection;
    await writeFile(destination, JSON.stringify(exported), { encoding: "utf8" });
    return destination;
  }

  private async discardGenerated(filePath: string): Promise<void> {
    try {
      await rm(filePath, { recursive: true, force: true });
    } catch {
      throw new SurtGisCoreError("这个图层没有从地图目录里删除干净，请再试一次。");
    }
  }

  private async writeMeta(layer: StoredLayer): Promise<void> {
    const meta = {
      layerId: layer.layerId,
      layerName: layer.layerName,
      sourcePaths: layer.sourcePaths,
      outputFilePath: layer.outputFilePath,
      featureCount: layer.featureCount,
      fieldNames: layer.fieldNames,
      geometryKind: layer.geometryKind,
      crsLabel: layer.crsLabel,
      crsIdentity: layer.crsIdentity,
      ...(layer.crsWkt !== undefined ? { crsWkt: layer.crsWkt } : {}),
      ...(layer.geometryHash !== undefined ? { geometryHash: layer.geometryHash } : {}),
    };
    await mkdir(this.directory, { recursive: true });
    await writeFile(join(this.directory, `${layer.layerId}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`, { encoding: "utf8" });
  }

  /** 顺序和样式串行落盘，避免并发写坏文件。 */
  private writeState(): Promise<void> {
    const payload = {
      schemaVersion: 1,
      order: [...this.orderIds],
      styles: Object.fromEntries([...this.styles.entries()]),
    };
    const text = `${JSON.stringify(payload, null, 2)}\n`;
    const run = async (): Promise<void> => {
      await mkdir(this.directory, { recursive: true });
      await writeFile(join(this.directory, LAYER_STORE_STATE_FILE), text, { encoding: "utf8" });
    };
    this.stateWrite = this.stateWrite.then(run, run);
    return this.stateWrite;
  }
}
