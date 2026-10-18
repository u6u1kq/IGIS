// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { looksLikeGeometryText } from "@igis/shared-types";
import type { ProvenanceLedger } from "@igis/provenance";
import { buildProvenanceRecord, hashSourceContent } from "@igis/provenance";
import { VECTOR_DIMENSION, chunkPlainText, embedText } from "./embed.js";

export const RAG_DIRECTORY = "var/rag";
const DATABASE_FILE = "kb.sqlite";

interface SqliteStatement {
  bind(index: number, value: unknown): SqliteStatement;
  stepReset(): SqliteStatement;
  finalize(): void;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  selectValue(sql: string, bind?: unknown): unknown;
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

interface WasmModule {
  default(options?: { wasmBinary?: Uint8Array; print?: () => void; printErr?: () => void }): Promise<Sqlite3Api>;
}

let wasmModule: Promise<Sqlite3Api> | null = null;

/**
 * 第一次使用知识库时加载 sqlite-vec 的 WASM。
 * sqlite-vec 被静态编进 sqlite-wasm-vec 的 sqlite3.wasm，官方 WASM 不能再动态 load_extension。
 * 这里读入该 wasm，初始化后立刻查询 vec_version()，确认 vec0 可用。
 */
export function loadSqliteVecWasm(): Promise<Sqlite3Api> {
  if (!wasmModule) {
    wasmModule = (async () => {
      const nodeRequire = createRequire(import.meta.url);
      const packageDir = dirname(nodeRequire.resolve("sqlite-wasm-vec/package.json"));
      const glue = join(packageDir, "sqlite-wasm/jswasm/sqlite3.mjs");
      const wasmPath = join(packageDir, "sqlite-wasm/jswasm/sqlite3.wasm");
      const wasmBinary = await readFile(wasmPath);
      const imported = (await import(pathToFileURL(glue).href)) as WasmModule;
      const sqlite3 = await imported.default({
        wasmBinary,
        print() {
          return undefined;
        },
        printErr() {
          return undefined;
        },
      });
      const probe = new sqlite3.oo1.DB(":memory:", "c");
      try {
        const version = probe.selectValue("select vec_version()");
        if (typeof version !== "string" || version.trim() === "") {
          throw new Error("sqlite-vec WASM 已加载，但 vec_version() 没有返回版本。");
        }
      } finally {
        probe.close();
      }
      return sqlite3;
    })();
  }
  return wasmModule;
}

export interface RagAddInput {
  readonly title: string;
  readonly body: string;
  readonly layerNames?: readonly string[];
  readonly kind?: "text" | "gis";
}

export interface RagAdded {
  readonly entryId: string;
  readonly chunkCount: number;
}

export interface RagHitResult {
  readonly entryId: string;
  readonly title: string;
  readonly text: string;
  readonly score: number;
  readonly layerNames: readonly string[];
}

/** 知识库列表。只有标题和条目信息，没有正文，也不带几何坐标。 */
export interface RagDocumentSummary {
  readonly entryId: string;
  readonly title: string;
  readonly kind: string;
  readonly layerNames: readonly string[];
  readonly createdAt: string;
  readonly chunkCount: number;
}

export class RagStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RagStoreError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

let entrySequence = 0;

function nextEntryId(): string {
  entrySequence += 1;
  return `rag-${Date.now().toString(16)}-${entrySequence}`;
}

function assertStorableText(value: string, label: string): void {
  if (looksLikeGeometryText(value)) {
    throw new RagStoreError(`${label}含有几何文本，已拒绝写入。`);
  }
}

function databasePath(directory: string): string {
  return join(directory, DATABASE_FILE);
}

function ensureSchema(db: SqliteDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS rag_entries (
    rowid INTEGER PRIMARY KEY,
    entry_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    layer_names TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS rag_vectors USING vec0(embedding float[${VECTOR_DIMENSION}])`);
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

async function persist(sqlite3: Sqlite3Api, db: SqliteDatabase, directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const bytes = sqlite3.capi.sqlite3_js_db_export(db);
  await writeFile(databasePath(directory), bytes);
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return 0;
}

export class SqliteVecRagStore {
  private readonly directory: string;
  private readonly ledger: ProvenanceLedger | null;
  private tail: Promise<void> = Promise.resolve();

  constructor(directory: string, ledger: ProvenanceLedger | null = null) {
    this.directory = directory;
    this.ledger = ledger;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async audit(
    toolName: string,
    source: string,
    layerNames: readonly string[],
    success: boolean,
    started: number,
  ): Promise<void> {
    if (!this.ledger) return;
    await this.ledger.append(
      buildProvenanceRecord({
        sourceContent: source,
        exportPath: null,
        layerNames,
        toolName,
        success,
        durationMs: Date.now() - started,
      }),
    );
  }

  /** 打开或创建库，加载 wasm，并确保条目表和 vec0 向量表存在。 */
  async init(): Promise<string> {
    return this.enqueue(async () => {
      const sqlite3 = await loadSqliteVecWasm();
      const db = await readDatabase(sqlite3, databasePath(this.directory));
      try {
        const version = asText(db.selectValue("select vec_version()"));
        ensureSchema(db);
        await persist(sqlite3, db, this.directory);
        return version;
      } finally {
        db.close();
      }
    });
  }

  async add(input: RagAddInput): Promise<RagAdded> {
    const started = Date.now();
    const title = input.title.trim();
    const body = input.body;
    const layerNames = input.layerNames ?? [];
    try {
      if (title === "") throw new RagStoreError("标题不能为空。");
      assertStorableText(title, "标题");
      assertStorableText(body, "正文");
      for (const name of layerNames) assertStorableText(name, "图层名");
      const chunks = chunkPlainText(body);
      if (chunks.length === 0) throw new RagStoreError("没有可写入的文本。");
      const entryId = nextEntryId();
      const added = await this.enqueue(async () => {
        const sqlite3 = await loadSqliteVecWasm();
        const db = await readDatabase(sqlite3, databasePath(this.directory));
        try {
          ensureSchema(db);
          const insertEntry = db.prepare(
            "INSERT INTO rag_entries(entry_id, chunk_index, kind, title, body, layer_names, source_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          );
          const insertVector = db.prepare("INSERT INTO rag_vectors(rowid, embedding) VALUES (?, ?)");
          const createdAt = new Date().toISOString();
          const kind = input.kind ?? "text";
          const namesJson = JSON.stringify(layerNames);
          for (let index = 0; index < chunks.length; index += 1) {
            const chunk = chunks[index] ?? "";
            const sourceHash = hashSourceContent(chunk);
            insertEntry
              .bind(1, entryId)
              .bind(2, index)
              .bind(3, kind)
              .bind(4, title)
              .bind(5, chunk)
              .bind(6, namesJson)
              .bind(7, sourceHash)
              .bind(8, createdAt)
              .stepReset();
            const rowid = asNumber(db.selectValue("select last_insert_rowid()"));
            const embedding = embedText(chunk);
            insertVector.bind(1, rowid).bind(2, embedding.buffer).stepReset();
          }
          insertEntry.finalize();
          insertVector.finalize();
          await persist(sqlite3, db, this.directory);
          return { entryId, chunkCount: chunks.length };
        } finally {
          db.close();
        }
      });
      await this.audit("rag.add", body, layerNames, true, started);
      return added;
    } catch (error) {
      await this.audit("rag.add", title || "rag-add", layerNames, false, started);
      throw error;
    }
  }

  async list(): Promise<readonly RagDocumentSummary[]> {
    return this.enqueue(async () => {
      const sqlite3 = await loadSqliteVecWasm();
      const db = await readDatabase(sqlite3, databasePath(this.directory));
      try {
        ensureSchema(db);
        const rows = db.selectObjects("SELECT entry_id, title, kind, layer_names, created_at FROM rag_entries");
        const grouped = new Map<string, RagDocumentSummary>();
        for (const row of rows) {
          const entryId = asText(row.entry_id);
          if (entryId === "") continue;
          const existing = grouped.get(entryId);
          if (existing) {
            grouped.set(entryId, { ...existing, chunkCount: existing.chunkCount + 1 });
            continue;
          }
          let names: string[] = [];
          try {
            const parsed = JSON.parse(asText(row.layer_names)) as unknown;
            if (Array.isArray(parsed)) names = parsed.filter((item): item is string => typeof item === "string");
          } catch {
            names = [];
          }
          grouped.set(entryId, {
            entryId,
            title: asText(row.title),
            kind: asText(row.kind),
            layerNames: names,
            createdAt: asText(row.created_at),
            chunkCount: 1,
          });
        }
        return [...grouped.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      } finally {
        db.close();
      }
    });
  }

  async delete(entryId: string): Promise<boolean> {
    const started = Date.now();
    try {
      if (!/^[A-Za-z0-9._-]+$/.test(entryId)) throw new RagStoreError("条目编号无效。");
      const removed = await this.enqueue(async () => {
        const sqlite3 = await loadSqliteVecWasm();
        const db = await readDatabase(sqlite3, databasePath(this.directory));
        try {
          ensureSchema(db);
          const rows = db.selectObjects("SELECT rowid AS rowid FROM rag_entries WHERE entry_id = ?", [entryId]);
          if (rows.length === 0) return false;
          for (const row of rows) {
            db.exec(`DELETE FROM rag_vectors WHERE rowid = ${asNumber(row.rowid)}`);
          }
          db.exec(`DELETE FROM rag_entries WHERE entry_id = '${entryId.replaceAll("'", "")}'`);
          await persist(sqlite3, db, this.directory);
          return true;
        } finally {
          db.close();
        }
      });
      await this.audit("rag.delete", entryId, [], removed, started);
      return removed;
    } catch (error) {
      await this.audit("rag.delete", entryId, [], false, started);
      throw error;
    }
  }

  async clear(): Promise<void> {
    const started = Date.now();
    try {
      await this.enqueue(async () => {
        const sqlite3 = await loadSqliteVecWasm();
        const db = await readDatabase(sqlite3, databasePath(this.directory));
        try {
          ensureSchema(db);
          db.exec("DELETE FROM rag_vectors");
          db.exec("DELETE FROM rag_entries");
          await persist(sqlite3, db, this.directory);
        } finally {
          db.close();
        }
      });
      await this.audit("rag.clear", "rag-clear", [], true, started);
    } catch (error) {
      await this.audit("rag.clear", "rag-clear", [], false, started);
      throw error;
    }
  }

  async search(query: string, topK: number): Promise<readonly RagHitResult[]> {
    const started = Date.now();
    const limit = normalizeTopK(topK);
    try {
      assertStorableText(query, "查询");
      const hits = await this.enqueue(async () => {
        const sqlite3 = await loadSqliteVecWasm();
        const db = await readDatabase(sqlite3, databasePath(this.directory));
        try {
          ensureSchema(db);
          const total = asNumber(db.selectValue("select count(*) from rag_entries"));
          if (total === 0) return [];
          const k = Math.min(limit, total);
          const embedding = embedText(query);
          const rows = db.selectObjects(
            `SELECT e.entry_id AS entry_id, e.title AS title, e.body AS body, e.layer_names AS layer_names, v.distance AS distance
             FROM rag_vectors AS v
             JOIN rag_entries AS e ON e.rowid = v.rowid
             WHERE v.embedding MATCH ?
               AND k = ?
             ORDER BY v.distance`,
            [embedding.buffer, k],
          );
          return rows.map((row) => {
            let names: string[] = [];
            try {
              const parsed = JSON.parse(asText(row.layer_names)) as unknown;
              if (Array.isArray(parsed)) names = parsed.filter((item): item is string => typeof item === "string");
            } catch {
              names = [];
            }
            const distance = asNumber(row.distance);
            return {
              entryId: asText(row.entry_id),
              title: asText(row.title),
              text: asText(row.body),
              score: 1 / (1 + distance),
              layerNames: names,
            };
          });
        } finally {
          db.close();
        }
      });
      const layerNames = [...new Set(hits.flatMap((hit) => hit.layerNames))];
      await this.audit("rag.search", query, layerNames, true, started);
      return hits;
    } catch (error) {
      await this.audit("rag.search", "rag-search", [], false, started);
      throw error;
    }
  }
}

export function normalizeTopK(topK: number): number {
  if (!Number.isInteger(topK) || topK < 1 || topK > 20) {
    throw new RagStoreError("topK 必须是 1 到 20 的整数。");
  }
  return topK;
}

export async function openSqliteVecRagStore(directory: string, ledger: ProvenanceLedger | null = null): Promise<SqliteVecRagStore> {
  const store = new SqliteVecRagStore(directory, ledger);
  await store.init();
  return store;
}
