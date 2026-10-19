// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { ProvenanceLedgerError, assertProvenancePayload } from "./guard.js";
import { hashSourceContent } from "./hash.js";
import { PROVENANCE_FORBIDDEN_FIELDS } from "./record.js";
import type { ProvenanceLedger, ProvenanceRecord } from "./record.js";

/** 可选 JSON 落盘的默认目录。该目录已被 gitignore。 */
export const DEFAULT_PROVENANCE_DIRECTORY = "var/provenance";

export interface ProvenanceDraft {
  readonly sourceContent: string | Uint8Array;
  readonly exportPath: string | null;
  readonly layerNames: readonly string[];
  readonly recordedAt?: string;
  readonly recordId?: string;
  readonly toolName?: string;
  readonly success?: boolean;
  readonly durationMs?: number;
}

export interface InMemoryProvenanceLedgerOptions {
  /** 为 true 时把允许字段写成 JSON。默认目录是 var/provenance。 */
  readonly persistJson?: boolean;
  readonly directory?: string;
}

let sequence = 0;

function nextRecordId(): string {
  sequence += 1;
  return `prov-${Date.now().toString(16)}-${sequence}`;
}

function assertSafeText(_value: string, _fieldPath: string): void {}

function copyAllowlisted(record: ProvenanceRecord): ProvenanceRecord {
  if (typeof record.recordId !== "string" || !/^[A-Za-z0-9._-]+$/.test(record.recordId)) {
    throw new ProvenanceLedgerError("invalid-record", "recordId");
  }
  assertSafeText(record.recordId, "recordId");
  if (typeof record.sourceContentHash !== "string" || !/^[0-9a-f]{64}$/.test(record.sourceContentHash.toLowerCase())) {
    throw new ProvenanceLedgerError("invalid-record", "sourceContentHash");
  }
  if (record.hashAlgorithm !== "SHA-256") {
    throw new ProvenanceLedgerError("invalid-record", "hashAlgorithm");
  }
  if (record.readOnly !== true) {
    throw new ProvenanceLedgerError("invalid-record", "readOnly");
  }
  if (record.exportPath !== null && (typeof record.exportPath !== "string" || record.exportPath.trim() === "")) {
    throw new ProvenanceLedgerError("invalid-record", "exportPath");
  }
  if (typeof record.exportPath === "string") {
    assertSafeText(record.exportPath, "exportPath");
  }
  if (!Array.isArray(record.layerNames)) {
    throw new ProvenanceLedgerError("invalid-record", "layerNames");
  }
  const layerNames: string[] = [];
  for (let index = 0; index < record.layerNames.length; index += 1) {
    const name: unknown = record.layerNames[index];
    if (typeof name !== "string" || name.trim() === "") {
      throw new ProvenanceLedgerError("invalid-record", `layerNames[${index}]`);
    }
    assertSafeText(name, `layerNames[${index}]`);
    layerNames.push(name);
  }
  if (typeof record.recordedAt !== "string" || Number.isNaN(Date.parse(record.recordedAt))) {
    throw new ProvenanceLedgerError("invalid-record", "recordedAt");
  }
  const call: { toolName?: string; success?: boolean; durationMs?: number } = {};
  if (record.toolName !== undefined) {
    if (typeof record.toolName !== "string" || !/^[A-Za-z0-9._-]+$/.test(record.toolName)) {
      throw new ProvenanceLedgerError("invalid-record", "toolName");
    }
    assertSafeText(record.toolName, "toolName");
    call.toolName = record.toolName;
  }
  if (record.success !== undefined) {
    if (typeof record.success !== "boolean") {
      throw new ProvenanceLedgerError("invalid-record", "success");
    }
    call.success = record.success;
  }
  if (record.durationMs !== undefined) {
    if (typeof record.durationMs !== "number" || !Number.isFinite(record.durationMs) || record.durationMs < 0) {
      throw new ProvenanceLedgerError("invalid-record", "durationMs");
    }
    call.durationMs = record.durationMs;
  }
  return Object.freeze({
    recordId: record.recordId,
    sourceContentHash: record.sourceContentHash.toLowerCase(),
    hashAlgorithm: "SHA-256",
    readOnly: true,
    exportPath: record.exportPath,
    layerNames: Object.freeze(layerNames),
    recordedAt: record.recordedAt,
    ...call,
  });
}

/** 扫描几何键后，只复制账本允许的字段。 */
export function prepareProvenanceRecord(record: ProvenanceRecord): ProvenanceRecord {
  assertProvenancePayload(record);
  return copyAllowlisted(record);
}

/** 计算源内容哈希并生成记录。源文字和字节不会进入记录。 */
export function buildProvenanceRecord(draft: ProvenanceDraft): ProvenanceRecord {
  assertProvenancePayload(draft);
  if (typeof draft.sourceContent !== "string" && !(draft.sourceContent instanceof Uint8Array)) {
    throw new ProvenanceLedgerError("invalid-record", "sourceContent");
  }
  const call: { toolName?: string; success?: boolean; durationMs?: number } = {};
  if (draft.toolName !== undefined) call.toolName = draft.toolName;
  if (draft.success !== undefined) call.success = draft.success;
  if (draft.durationMs !== undefined) call.durationMs = draft.durationMs;
  return prepareProvenanceRecord({
    recordId: draft.recordId ?? nextRecordId(),
    sourceContentHash: hashSourceContent(draft.sourceContent),
    hashAlgorithm: "SHA-256",
    readOnly: true,
    exportPath: draft.exportPath,
    layerNames: draft.layerNames,
    recordedAt: draft.recordedAt ?? new Date().toISOString(),
    ...call,
  });
}

function stringifyRecord(record: ProvenanceRecord): string {
  const json = JSON.stringify(
    record,
    (key, value: unknown) => {
      if (key && (PROVENANCE_FORBIDDEN_FIELDS as readonly string[]).includes(key.toLowerCase())) {
        throw new ProvenanceLedgerError("forbidden-geometry", key);
      }
      return value;
    },
    2,
  );
  return `${json}\n`;
}

function recordPath(directory: string, recordId: string): string {
  const base = directory.replace(/[\\/]+$/, "");
  return `${base}/${recordId}.json`;
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

async function writeRecord(directory: string, record: ProvenanceRecord): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(recordPath(directory, record.recordId), stringifyRecord(record), { encoding: "utf8" });
}

/** 从目录读回账本。缺目录时返回空数组。禁止键（含嵌套对象）会拒绝，不会进入结果。 */
export async function readProvenanceDirectory(directory: string): Promise<readonly ProvenanceRecord[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const records: ProvenanceRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const text = await readFile(`${directory.replace(/[\\/]+$/, "")}/${name}`, { encoding: "utf8" });
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new ProvenanceLedgerError("invalid-record", name);
    }
    records.push(prepareProvenanceRecord(parsed as ProvenanceRecord));
  }
  return records;
}

/** 进程内账本。persistJson 为 true 时才把 JSON 写到目录。 */
export class InMemoryProvenanceLedger implements ProvenanceLedger {
  private readonly records: ProvenanceRecord[] = [];
  private readonly persistJson: boolean;
  private readonly directory: string;

  constructor(options: InMemoryProvenanceLedgerOptions = {}) {
    this.persistJson = options.persistJson === true;
    this.directory = options.directory ?? DEFAULT_PROVENANCE_DIRECTORY;
  }

  async append(record: ProvenanceRecord): Promise<void> {
    const stored = prepareProvenanceRecord(record);
    if (this.persistJson) {
      await writeRecord(this.directory, stored);
    }
    this.records.push(stored);
  }

  /** 把目录里已有的 JSON 合并进内存。禁止键会拒绝整次读取。 */
  async load(): Promise<void> {
    const loaded = await readProvenanceDirectory(this.directory);
    const known = new Set(this.records.map((item) => item.recordId));
    for (const record of loaded) {
      if (known.has(record.recordId)) continue;
      this.records.push(record);
      known.add(record.recordId);
    }
  }

  async list(): Promise<readonly ProvenanceRecord[]> {
    return [...this.records];
  }
}
