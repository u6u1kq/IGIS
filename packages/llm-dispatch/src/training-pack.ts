// SPDX-License-Identifier: Apache-2.0

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";

/**
 * 打包训练数据时，模型只能看到这份索引。
 * 索引没有坐标、范围、高程值和绝对路径。EPSG 只在文件自己写明时才出现。
 */

export interface TrainingIndexEntry {
  readonly kind: "points" | "lines" | "polygons" | "raster" | "table" | "vector" | "unknown";
  readonly name: string;
  readonly metric: boolean | null;
  readonly epsg: string | null;
  readonly featureCount: number | null;
  readonly numericFields: readonly string[];
  readonly outletContiguous: boolean | null;
}

const INDEX_EXTENSIONS = new Set([".shp", ".geojson", ".json", ".csv", ".tif", ".tiff"]);
const MAX_INDEX_FILES = 200;
const MAX_TEXT_BYTES = 20 * 1024 * 1024;

export function isTrainingPackRequest(text: string): boolean {
  return /打包训练数据|pack training data/i.test(text);
}

export function isTrainErrorReport(text: string): boolean {
  return /train\.py|normalized RMSE|basin IoU|stream F1|训练报错/i.test(text);
}

/** 去掉绝对路径。剩下的是程序自己的话和相对名称。 */
export function stripAbsolutePaths(text: string): string {
  return text
    .replace(/\\\\[^\s"'<>|]+/g, "[path]")
    .replace(/[A-Za-z]:[\\/][^\s"'<>|]+/g, "[path]")
    .replace(/(?:^|\s)\/(?:[\w.-]+\/){1,}[\w.-]+/g, " [path]");
}

export function trainingPackPaths(text: string): string[] {
  const found = text.match(/[A-Za-z]:[\\/][^\s"'<>|]+/g) ?? [];
  return [...new Set(found.map((item) => item.replace(/[\\/]+$/, "")))];
}

export function trainingPackModelText(input: {
  readonly text: string;
  readonly index: readonly TrainingIndexEntry[] | null;
  readonly locale?: "zh-CN" | "en";
}): string {
  const pack = isTrainingPackRequest(input.text);
  const error = isTrainErrorReport(input.text);
  if (!pack && !error) return input.text;
  const zh = input.locale !== "en";
  const parts: string[] = [];
  if (pack) {
    parts.push(zh
      ? "用户要打包训练数据。只根据本机索引整理 training.json，不要读取坐标。train.py 需要两组，而且两组都要有：kriging 每项是 points 和 field；watershed 每项是 dem、outlets、basins，有河道时键名是 streams。键必须写 field，不能写 valueField；必须写 streams，不能写 rivers。索引里的 epsg 只在文件自己写了的时候才有。没有就空着，不要编造 EPSG，也不要编造出水口编号。不要把 Igis 的汇水结果当成标注。不要运行 train.py。整理出来的权重是实验用的，不能说成可以放进公开安装包。索引对不上时，告诉用户还缺什么，不要补文件。"
      : "The user wants a training-data pack. Organize training.json only from the local index. Do not read coordinates. train.py needs both groups: each kriging item has points and field; each watershed item has dem, outlets, and basins, and streams when a line file is present. The keys must be field and streams, not valueField or rivers. epsg is present only when the file itself declares it. Leave it empty otherwise. Do not invent an EPSG code or outlet numbers. Do not use Igis watershed output as labels. Do not run train.py. The resulting weights are experimental and must not be described as releasable. If the index does not match, say what is missing. Do not invent files.");
  }
  if (error) {
    parts.push(zh
      ? "下面是训练程序的退出说明，本机已经去掉路径。只解释这些原话。不要编造 EPSG 或出水口编号，也不要建议把实验权重发布。"
      : "Below is the training program's own exit text, with paths already removed. Explain only that text. Do not invent an EPSG code or outlet numbers, and do not describe experimental weights as releasable.");
  }
  if (input.index) {
    parts.push(`${zh ? "本机索引（无坐标、无范围、无高程、无绝对路径）：" : "Local index (no coordinates, extents, elevations, or absolute paths):"}\n${JSON.stringify(input.index)}`);
  }
  parts.push(stripAbsolutePaths(input.text));
  return parts.join("\n\n");
}

function declaredCrs(text: string): { readonly epsg: string | null; readonly metric: boolean | null } {
  const match = /AUTHORITY\["EPSG","(\d+)"\]|EPSG(?::|::)(\d+)/i.exec(text);
  const code = match?.[1] ?? match?.[2] ?? "";
  const epsg = code === "" ? null : `EPSG:${code}`;
  const projected = /PROJCS\[/i.test(text);
  const geographic = /GEOGCS\[/i.test(text) && !projected;
  const metres = /UNIT\["(?:metre|meter)"/i.test(text);
  const degrees = /UNIT\["degree"/i.test(text);
  let metric: boolean | null = null;
  if (metres || code === "3857") metric = true;
  else if (geographic || degrees || code === "4326" || code === "4269") metric = false;
  return { epsg, metric };
}

function geometryKind(type: string): TrainingIndexEntry["kind"] | null {
  if (type === "Point" || type === "MultiPoint") return "points";
  if (type === "LineString" || type === "MultiLineString") return "lines";
  if (type === "Polygon" || type === "MultiPolygon") return "polygons";
  return null;
}

function outletContiguous(values: readonly unknown[]): boolean | null {
  if (values.length === 0) return null;
  const numbers: number[] = [];
  for (const value of values) {
    if (typeof value !== "number" || !Number.isInteger(value)) return null;
    numbers.push(value);
  }
  const unique = new Set(numbers);
  if (unique.size !== numbers.length) return false;
  for (let index = 1; index <= numbers.length; index += 1) {
    if (!unique.has(index)) return false;
  }
  return true;
}

function indexFeatureCollection(value: unknown, name: string, crsText: string): TrainingIndexEntry | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type !== "FeatureCollection" || !Array.isArray(record.features)) return null;
  const kinds = new Set<TrainingIndexEntry["kind"]>();
  const numeric = new Map<string, boolean>();
  const outlets: unknown[] = [];
  let outletSeen = 0;
  for (const feature of record.features) {
    if (feature === null || typeof feature !== "object" || Array.isArray(feature)) continue;
    const item = feature as Record<string, unknown>;
    const geometry = item.geometry;
    if (geometry !== null && typeof geometry === "object" && !Array.isArray(geometry)) {
      const kind = geometryKind(String((geometry as { type?: unknown }).type ?? ""));
      if (kind) kinds.add(kind);
    }
    const properties = item.properties;
    if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
      const props = properties as Record<string, unknown>;
      if ("outlet" in props) {
        outletSeen += 1;
        outlets.push(props.outlet);
      }
      for (const [key, property] of Object.entries(props)) {
        if (property === null || property === undefined || property === "") continue;
        const wasNumeric = numeric.get(key) !== false;
        numeric.set(key, wasNumeric && typeof property === "number" && Number.isFinite(property));
      }
    }
  }
  const crs = record.crs === undefined ? declaredCrs(crsText) : declaredCrs(`${crsText}\n${JSON.stringify(record.crs)}`);
  const featureCount = record.features.length;
  return {
    kind: kinds.size === 1 ? [...kinds][0]! : "unknown",
    name,
    metric: crs.metric,
    epsg: crs.epsg,
    featureCount,
    numericFields: [...numeric.entries()].filter((entry) => entry[1]).map((entry) => entry[0]).sort(),
    outletContiguous: outletSeen === 0 ? null : outletSeen === featureCount ? outletContiguous(outlets) : false,
  };
}

function indexCsv(text: string, name: string): TrainingIndexEntry {
  const lines = text.split(/\r?\n/u).filter((line) => line.trim() !== "");
  const headers = (lines[0] ?? "").split(",").map((item) => item.trim().replace(/^"|"$/g, "")).filter((item) => item !== "");
  const numeric = new Set(headers);
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    headers.forEach((header, index) => {
      const cell = (cells[index] ?? "").trim();
      if (cell === "") return;
      if (!Number.isFinite(Number(cell))) numeric.delete(header);
    });
  }
  return {
    kind: "table",
    name,
    metric: null,
    epsg: null,
    featureCount: Math.max(0, lines.length - 1),
    numericFields: [...numeric].sort(),
    outletContiguous: null,
  };
}

function latin1(bytes: Uint8Array, start: number, length: number): string {
  let text = "";
  for (let index = 0; index < length && start + index < bytes.length; index += 1) {
    text += String.fromCharCode(bytes[start + index] ?? 0);
  }
  return text.replace(/\0/g, "");
}

function readDbfFields(bytes: Uint8Array): { readonly numericFields: string[]; readonly outletContiguous: boolean | null; readonly featureCount: number } {
  if (bytes.length < 32) return { numericFields: [], outletContiguous: null, featureCount: 0 };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const featureCount = view.getUint32(4, true);
  const headerLength = view.getUint16(8, true);
  const recordLength = view.getUint16(10, true);
  const fields: { name: string; type: string; length: number; offset: number }[] = [];
  let cursor = 32;
  let valueOffset = 1;
  while (cursor + 32 <= headerLength && bytes[cursor] !== 0x0d) {
    const name = latin1(bytes, cursor, 11).trim();
    const type = String.fromCharCode(bytes[cursor + 11] ?? 0);
    const length = bytes[cursor + 16] ?? 0;
    if (name !== "") fields.push({ name, type, length, offset: valueOffset });
    valueOffset += length;
    cursor += 32;
  }
  const numericFields = fields.filter((field) => field.type === "N" || field.type === "F").map((field) => field.name).sort();
  const outlet = fields.find((field) => field.name.toLowerCase() === "outlet");
  if (!outlet || featureCount === 0 || headerLength + featureCount * recordLength > bytes.length) {
    return { numericFields, outletContiguous: null, featureCount };
  }
  const values: unknown[] = [];
  for (let index = 0; index < featureCount; index += 1) {
    const start = headerLength + index * recordLength + outlet.offset;
    const raw = latin1(bytes, start, outlet.length).trim();
    const value = Number(raw);
    values.push(Number.isInteger(value) ? value : raw);
  }
  return { numericFields, outletContiguous: outletContiguous(values), featureCount };
}

async function relativeName(root: string, path: string): Promise<string | null> {
  const from = relative(root, path);
  if (from.startsWith("..") || from.includes(`..${sep}`)) return null;
  const name = from.split(sep).join("/");
  return name === "" ? basename(path) : name;
}

async function sidecarText(path: string, extension: string): Promise<string> {
  const sidecar = path.slice(0, -extname(path).length) + extension;
  try {
    const info = await stat(sidecar);
    if (!info.isFile() || info.size > 1024 * 1024) return "";
    return await readFile(sidecar, { encoding: "utf8" });
  } catch {
    return "";
  }
}

/** 只索引目录里的矢量、表和栅格文件名。不读取坐标和高程。 */
export async function indexTrainingDirectory(directory: string): Promise<TrainingIndexEntry[]> {
  const root = resolve(directory);
  const info = await stat(root);
  if (!info.isDirectory()) throw new Error("训练数据索引需要一个目录。");
  const files: string[] = [];
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > 4 || files.length >= MAX_INDEX_FILES) return;
    const entries = await readdir(current);
    for (const name of entries) {
      if (files.length >= MAX_INDEX_FILES) return;
      if (name === "node_modules" || name === ".git" || name.startsWith(".")) continue;
      const path = join(current, name);
      const info = await stat(path);
      if (info.isDirectory()) await walk(path, depth + 1);
      else if (INDEX_EXTENSIONS.has(extname(name).toLowerCase())) files.push(path);
    }
  };
  await walk(root, 0);
  const indexed: TrainingIndexEntry[] = [];
  for (const path of files) {
    const name = await relativeName(root, path);
    if (!name) continue;
    const extension = extname(path).toLowerCase();
    const fileInfo = await stat(path);
    if (extension === ".tif" || extension === ".tiff") {
      const crs = declaredCrs(await sidecarText(path, ".prj"));
      indexed.push({ kind: "raster", name, metric: crs.metric, epsg: crs.epsg, featureCount: null, numericFields: [], outletContiguous: null });
      continue;
    }
    if (extension === ".shp") {
      const crs = declaredCrs(await sidecarText(path, ".prj"));
      let numericFields: string[] = [];
      let outlet: boolean | null = null;
      let featureCount: number | null = null;
      try {
        const dbfPath = path.slice(0, -4) + ".dbf";
        const dbfInfo = await stat(dbfPath);
        if (dbfInfo.isFile() && dbfInfo.size <= MAX_TEXT_BYTES) {
          const summary = readDbfFields(await readFile(dbfPath));
          numericFields = summary.numericFields;
          outlet = summary.outletContiguous;
          featureCount = summary.featureCount;
        }
      } catch {
        numericFields = [];
      }
      indexed.push({ kind: "vector", name, metric: crs.metric, epsg: crs.epsg, featureCount, numericFields, outletContiguous: outlet });
      continue;
    }
    if (fileInfo.size > MAX_TEXT_BYTES) {
      indexed.push({ kind: extension === ".csv" ? "table" : "unknown", name, metric: null, epsg: null, featureCount: null, numericFields: [], outletContiguous: null });
      continue;
    }
    const text = await readFile(path, { encoding: "utf8" });
    if (extension === ".csv") {
      indexed.push(indexCsv(text, name));
      continue;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      const entry = indexFeatureCollection(parsed, name, "");
      if (entry) indexed.push(entry);
    } catch {
      // 不是要素集合的 JSON 不进入索引，避免把别的配置内容送出去。
    }
  }
  return indexed;
}
