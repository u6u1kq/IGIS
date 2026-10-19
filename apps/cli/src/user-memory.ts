// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface MemoryItem {
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
}

const MAX_ITEMS = 20;
const MAX_TEXT = 240;
const MAX_SUMMARY = 1600;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function looksLikeSecret(text: string): boolean {
  if (/sk-[A-Za-z0-9_-]{10,}/.test(text)) return true;
  if (/Bearer\s+\S+/i.test(text)) return true;
  if (/(api[_-]?key|secret|token)\s*[:=]/i.test(text)) return true;
  if (/DEEPSEEK_API_KEY|QWEN_API_KEY|GROK_API_KEY|LOCAL_LLM_API_KEY/.test(text)) return true;
  return false;
}

function looksLikeCoordinates(_text: string): boolean {
  return false;
}

export class MemoryRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryRejectedError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function readItem(value: unknown): MemoryItem | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.text !== "string") return null;
  if (!/^mem-[A-Za-z0-9._-]+$/.test(value.id)) return null;
  const text = value.text.trim();
  if (text === "" || looksLikeCoordinates(text) || looksLikeSecret(text)) return null;
  return {
    id: value.id,
    text: text.slice(0, MAX_TEXT),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
  };
}

/** 用户记忆。JSON 存在 var/memory。 */
export class UserMemoryStore {
  private readonly filePath: string;
  private items: MemoryItem[] = [];

  constructor(directory: string) {
    this.filePath = join(directory, "user-memory.json");
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, { encoding: "utf8" })) as unknown;
      const list = isRecord(parsed) && Array.isArray(parsed.items) ? parsed.items : Array.isArray(parsed) ? parsed : [];
      this.items = list.map(readItem).filter((item): item is MemoryItem => item !== null).slice(0, MAX_ITEMS);
    } catch {
      this.items = [];
    }
  }

  list(): readonly MemoryItem[] {
    return [...this.items];
  }

  summary(): string {
    if (this.items.length === 0) return "";
    const lines = this.items.map((item, index) => `${index + 1}. ${item.text}`);
    let text = lines.join("\n");
    if (text.length > MAX_SUMMARY) text = `${text.slice(0, MAX_SUMMARY)}…`;
    return text;
  }

  async add(text: string): Promise<MemoryItem> {
    const trimmed = text.replace(/\u0000/g, "").trim();
    if (trimmed === "") throw new MemoryRejectedError("请填写要记住的内容。");
    if (looksLikeCoordinates(trimmed)) throw new MemoryRejectedError("记忆不能包含坐标或几何。");
    if (looksLikeSecret(trimmed)) throw new MemoryRejectedError("记忆不能包含密钥。");
    if (trimmed.length > MAX_TEXT) throw new MemoryRejectedError(`记忆请控制在 ${MAX_TEXT} 字以内。`);
    if (this.items.length >= MAX_ITEMS) throw new MemoryRejectedError(`最多保存 ${MAX_ITEMS} 条记忆。`);
    const item: MemoryItem = {
      id: `mem-${Date.now().toString(16)}-${this.items.length + 1}`,
      text: trimmed,
      createdAt: new Date().toISOString(),
    };
    this.items = [...this.items, item];
    await this.persist();
    return item;
  }

  async remove(id: string): Promise<boolean> {
    const next = this.items.filter((item) => item.id !== id);
    if (next.length === this.items.length) return false;
    this.items = next;
    await this.persist();
    return true;
  }

  private async persist(): Promise<void> {
    await mkdir(resolve(this.filePath, ".."), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify({ items: this.items }, null, 2)}\n`, { encoding: "utf8" });
  }
}

export function memoryDirectory(root: string): string {
  return resolve(root, "var/memory");
}

export { looksLikeCoordinates, looksLikeSecret };
