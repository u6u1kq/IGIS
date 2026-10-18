// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { looksLikeGeometryText } from "@igis/shared-types";
import { loadSqliteVecWasm } from "@igis/rag-meta";

/**
 * 预制工具轨迹库。和 RAG 的 var/rag 分开，只给以后的微调做底座。
 * 这里不训练、不导出坐标。样本是进程内合成的，没有真实地理。
 */

export const FOUNDATION_SCHEMA_VERSION = 1;
export const FOUNDATION_DB_FILE = "tool-traces.sqlite";
export const FOUNDATION_MANIFEST_FILE = "manifest.json";
const LICENSE_TAG = "Apache-2.0";
const BLOCKED_MESSAGE = "记录里含有坐标、WKT、WKB 或 GeoJSON 几何，已拒绝写入。";

export class FoundationDbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FoundationDbError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface FoundationManifest {
  readonly count: number;
  readonly schemaVersion: number;
  readonly sha256: string;
  readonly createdAt: string;
}

export interface FoundationFunctionCall {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface FoundationSampleInput {
  readonly instruction: string;
  readonly functionCall: FoundationFunctionCall;
  readonly source?: "synthetic";
  readonly licenseTag?: string;
}

interface SqliteStatement {
  bind(index: number, value: unknown): SqliteStatement;
  stepReset(): SqliteStatement;
  finalize(): void;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  selectValue(sql: string): unknown;
  selectObjects(sql: string, bind?: unknown): readonly Record<string, unknown>[];
  close(): void;
  readonly pointer: number;
}

interface Sqlite3Api {
  oo1: { DB: new (filename?: string, mode?: string) => SqliteDatabase };
  capi: {
    sqlite3_js_db_export(db: SqliteDatabase): Uint8Array;
    sqlite3_deserialize(
      db: number,
      schema: string,
      pointer: number,
      size: number,
      allocSize: number,
      flags: number,
    ): number;
    SQLITE_DESERIALIZE_FREEONCLOSE?: number;
    SQLITE_DESERIALIZE_RESIZEABLE?: number;
  };
  wasm: { allocFromTypedArray(bytes: Uint8Array): number };
}

const WKT_ANYWHERE =
  /\b(POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION)(\s+[ZM]{1,2})?\s*\(/i;
const COORDINATE_PAIR = /-?\d{1,3}\.\d+\s*[, ]\s*-?\d{1,3}\.\d+/;
const WKB_HEX = /\b(?:00|01)(?:01000000|00000001|02000000|00000002|03000000|00000003)[0-9a-f]{8,}\b/i;
const FORBIDDEN_KEYS = new Set([
  "coordinates",
  "geometry",
  "geometries",
  "geom",
  "wkt",
  "wkb",
  "ewkb",
  "latitude",
  "longitude",
  "lat",
  "lon",
  "lng",
  "bbox",
  "extent",
]);

const SYNTHETIC_ROWS: readonly { readonly instruction: string; readonly call: FoundationFunctionCall }[] = [
  { instruction: "列出当前项目里的图层名称。", call: { name: "list-layers", args: {} } },
  { instruction: "读取图层道路的字段名和要素数量。", call: { name: "get-layer-metadata", args: { layerName: "道路" } } },
  {
    instruction: "对图层道路做 100 米缓冲，结果作为新图层。",
    call: { name: "map.buffer", args: { layerName: "道路", distance: 100, unit: "meters" } },
  },
  {
    instruction: "求图层地块与图层红线的相交，生成新图层。",
    call: { name: "map.intersect", args: { layerName: "地块", otherLayerName: "红线" } },
  },
  {
    instruction: "用图层范围裁剪图层道路。",
    call: { name: "map.clip", args: { layerName: "道路", clipLayerName: "范围" } },
  },
  {
    instruction: "在图层地块上按属性筛选名称等于甲的要素。",
    call: { name: "map.query", args: { layerName: "地块", queryKind: "attribute", attributeFilter: "名称=甲" } },
  },
  { instruction: "统计图层地块的要素数量。", call: { name: "map.stats", args: { layerName: "地块" } } },
  { instruction: "用 GDL 摘要描述图层道路，不要包含几何。", call: { name: "gdl.describe", args: { layerName: "道路" } } },
];

function databasePath(directory: string): string {
  return join(directory, FOUNDATION_DB_FILE);
}

function manifestPath(directory: string): string {
  return join(directory, FOUNDATION_MANIFEST_FILE);
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return 0;
}

function openEmpty(sqlite3: Sqlite3Api): SqliteDatabase {
  return new sqlite3.oo1.DB(":memory:", "c");
}

function plainBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.constructor === Uint8Array) return bytes;
  return new Uint8Array(bytes);
}

function restore(sqlite3: Sqlite3Api, bytes: Uint8Array): SqliteDatabase {
  const db = openEmpty(sqlite3);
  const pointer = sqlite3.wasm.allocFromTypedArray(plainBytes(bytes));
  const freeOnClose = sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE ?? 1;
  const resizable = sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE ?? 2;
  sqlite3.capi.sqlite3_deserialize(db.pointer, "main", pointer, bytes.byteLength, bytes.byteLength, freeOnClose | resizable);
  return db;
}

async function readDatabase(sqlite3: Sqlite3Api, filePath: string): Promise<SqliteDatabase> {
  try {
    const bytes = await readFile(filePath);
    if (bytes.byteLength === 0) return openEmpty(sqlite3);
    return restore(sqlite3, bytes);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : "";
    if (code === "ENOENT") return openEmpty(sqlite3);
    throw error;
  }
}

function ensureSchema(db: SqliteDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS tool_trace_samples (
    id INTEGER PRIMARY KEY,
    instruction TEXT NOT NULL,
    function_call TEXT NOT NULL,
    source TEXT NOT NULL,
    license_tag TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function textHasBlockedGeography(value: string): boolean {
  if (looksLikeGeometryText(value)) return true;
  if (/"coordinates"\s*:/.test(value)) return true;
  if (WKT_ANYWHERE.test(value)) return true;
  if (COORDINATE_PAIR.test(value)) return true;
  if (/\b(WKB|EWKB)\b/i.test(value)) return true;
  const compact = value.replace(/\s+/g, "");
  return WKB_HEX.test(compact);
}

function walkBlocked(value: unknown, seen: WeakSet<object>): boolean {
  if (typeof value === "string") return textHasBlockedGeography(value);
  if (typeof value === "number") return false;
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => walkBlocked(item, seen));
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) return true;
    if (walkBlocked(item, seen)) return true;
  }
  return false;
}

/** 拒绝坐标、WKT、WKB 和 GeoJSON 几何。错误文字不回显原文。 */
export function assertFoundationSampleClean(instruction: string, functionCall: unknown): void {
  if (textHasBlockedGeography(instruction) || walkBlocked(functionCall, new WeakSet<object>())) {
    throw new FoundationDbError(BLOCKED_MESSAGE);
  }
  const encoded = JSON.stringify(functionCall);
  if (textHasBlockedGeography(encoded)) throw new FoundationDbError(BLOCKED_MESSAGE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeCall(value: FoundationFunctionCall): { name: string; args: Record<string, unknown> } {
  const name = value.name.trim();
  if (name === "" || name.length > 80 || textHasBlockedGeography(name)) {
    throw new FoundationDbError("工具名无效。");
  }
  if (!isRecord(value.args)) throw new FoundationDbError("工具参数必须是对象。");
  return { name, args: { ...value.args } };
}

async function writeManifest(directory: string, bytes: Uint8Array, count: number, createdAt: string): Promise<FoundationManifest> {
  const manifest: FoundationManifest = {
    count,
    schemaVersion: FOUNDATION_SCHEMA_VERSION,
    sha256: sha256(bytes),
    createdAt,
  };
  await writeFile(manifestPath(directory), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8" });
  return manifest;
}

async function readManifest(directory: string): Promise<FoundationManifest | null> {
  try {
    const parsed = JSON.parse(await readFile(manifestPath(directory), { encoding: "utf8" })) as unknown;
    if (!isRecord(parsed)) return null;
    if (parsed.schemaVersion !== FOUNDATION_SCHEMA_VERSION) return null;
    if (typeof parsed.count !== "number" || typeof parsed.sha256 !== "string" || typeof parsed.createdAt !== "string") return null;
    return {
      count: parsed.count,
      schemaVersion: FOUNDATION_SCHEMA_VERSION,
      sha256: parsed.sha256,
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}

function insertRow(db: SqliteDatabase, instruction: string, functionCall: string, licenseTag: string, createdAt: string): void {
  const statement = db.prepare(
    "INSERT INTO tool_trace_samples (instruction, function_call, source, license_tag, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  statement.bind(1, instruction).bind(2, functionCall).bind(3, "synthetic").bind(4, licenseTag).bind(5, createdAt).stepReset();
  statement.finalize();
}

let tail: Promise<void> = Promise.resolve();

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const run = tail.then(work, work);
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function ensureUnlocked(directory: string): Promise<FoundationManifest> {
  await mkdir(directory, { recursive: true });
  const existing = await readManifest(directory);
  if (existing) {
    try {
      const bytes = await readFile(databasePath(directory));
      if (bytes.byteLength > 0 && sha256(bytes) === existing.sha256) return existing;
    } catch {
      // 清单还在但文件丢了，下面重新生成。
    }
  }
  const sqlite3 = await loadSqliteVecWasm();
  const db = openEmpty(sqlite3);
  try {
    ensureSchema(db);
    const createdAt = new Date().toISOString();
    for (const row of SYNTHETIC_ROWS) {
      const call = normalizeCall(row.call);
      assertFoundationSampleClean(row.instruction, call);
      insertRow(db, row.instruction, JSON.stringify(call), LICENSE_TAG, createdAt);
    }
    const bytes = sqlite3.capi.sqlite3_js_db_export(db);
    await writeFile(databasePath(directory), bytes);
    return writeManifest(directory, bytes, SYNTHETIC_ROWS.length, createdAt);
  } finally {
    db.close();
  }
}

/** 第一次使用时在目录里生成合成样本。已有同版本清单则直接返回，不覆盖。 */
export function ensureFoundationDatabase(directory: string): Promise<FoundationManifest> {
  return enqueue(() => ensureUnlocked(directory));
}

/** 追加一条合成样本。含坐标或几何时拒绝，不写盘。 */
export async function insertFoundationSample(directory: string, input: FoundationSampleInput): Promise<FoundationManifest> {
  const instruction = input.instruction.trim();
  if (instruction === "" || instruction.length > 500) throw new FoundationDbError("指令文字无效。");
  if (input.source !== undefined && input.source !== "synthetic") throw new FoundationDbError("只接受合成来源。");
  const licenseTag = (input.licenseTag ?? LICENSE_TAG).trim();
  if (licenseTag === "" || licenseTag.length > 80 || textHasBlockedGeography(licenseTag)) {
    throw new FoundationDbError("许可证标记无效。");
  }
  const call = normalizeCall(input.functionCall);
  assertFoundationSampleClean(instruction, call);
  return enqueue(async () => {
    await ensureUnlocked(directory);
    const sqlite3 = await loadSqliteVecWasm();
    const db = await readDatabase(sqlite3, databasePath(directory));
    try {
      ensureSchema(db);
      const createdAt = new Date().toISOString();
      insertRow(db, instruction, JSON.stringify(call), licenseTag, createdAt);
      const bytes = sqlite3.capi.sqlite3_js_db_export(db);
      await writeFile(databasePath(directory), bytes);
      const count = asNumber(db.selectValue("SELECT count(*) FROM tool_trace_samples"));
      const previous = await readManifest(directory);
      return writeManifest(directory, bytes, count, previous?.createdAt ?? createdAt);
    } finally {
      db.close();
    }
  });
}

export async function readFoundationFile(directory: string): Promise<Uint8Array> {
  await ensureFoundationDatabase(directory);
  return readFile(databasePath(directory));
}

export function foundationDownloadName(): string {
  return "igis-foundation.sqlite";
}
