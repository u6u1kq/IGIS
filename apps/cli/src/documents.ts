// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import type { SqliteVecRagStore } from "@igis/rag-meta";
import { looksLikeGeometryText } from "@igis/shared-types";

export type DocumentKind = "rag" | "gdl" | "export";

export interface DocumentItem {
  readonly kind: DocumentKind;
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly createdAt: string | null;
  readonly canDelete: boolean;
  readonly canDownload: boolean;
}

const VECTOR_FILE = /\.(shp|shx|dbf|gdb|gpkg|mif|mid|tab|kml|kmz|dxf)$/i;
const TEXT_FILE = /\.(txt|md|markdown|csv|json)$/i;

export class DocumentError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "DocumentError";
    this.status = status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function inside(root: string, candidate: string): boolean {
  const base = resolve(root).toLowerCase();
  const path = resolve(candidate).toLowerCase();
  return path === base || path.startsWith(`${base}\\`) || path.startsWith(`${base}/`);
}

function safeName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.includes("\0") || trimmed.includes("..") || /[\\/]/.test(trimmed)) {
    throw new DocumentError(400, "文件名无效。");
  }
  return trimmed;
}

async function listFiles(directory: string, extensions: readonly string[]): Promise<readonly { readonly name: string; readonly mtime: string | null }[]> {
  let names: string[] = [];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isEnoent(error)) return [];
    throw new DocumentError(500, "文档目录暂时读不出来。");
  }
  const allowed = new Set(extensions.map((item) => item.toLowerCase()));
  const items: { name: string; mtime: string | null }[] = [];
  for (const name of names) {
    const ext = extname(name).toLowerCase();
    if (!allowed.has(ext)) continue;
    if (VECTOR_FILE.test(name)) continue;
    try {
      const info = await stat(join(directory, name));
      if (!info.isFile()) continue;
      items.push({ name, mtime: null });
    } catch {
      continue;
    }
  }
  return items.sort((left, right) => left.name.localeCompare(right.name, "zh"));
}

export interface DocumentRoots {
  readonly gdl: string;
  readonly exports: string;
}

export async function listProjectDocuments(store: SqliteVecRagStore, roots: DocumentRoots): Promise<readonly DocumentItem[]> {
  const items: DocumentItem[] = [];
  try {
    const documents = await store.list();
    for (const doc of documents) {
      items.push({
        kind: "rag",
        id: doc.entryId,
        name: doc.title,
        title: doc.title,
        createdAt: doc.createdAt || null,
        canDelete: true,
        canDownload: false,
      });
    }
  } catch {
    throw new DocumentError(500, "知识库暂时读不出来，请稍后再试。");
  }
  for (const file of await listFiles(roots.gdl, [".gdl", ".txt"])) {
    items.push({
      kind: "gdl",
      id: file.name,
      name: file.name,
      title: file.name,
      createdAt: file.mtime,
      canDelete: true,
      canDownload: true,
    });
  }
  for (const file of await listFiles(roots.exports, [".geojson", ".json"])) {
    items.push({
      kind: "export",
      id: file.name,
      name: file.name,
      title: file.name,
      createdAt: file.mtime,
      canDelete: true,
      canDownload: true,
    });
  }
  return items;
}

export async function deleteProjectDocument(
  store: SqliteVecRagStore,
  roots: DocumentRoots,
  kind: DocumentKind,
  id: string,
): Promise<void> {
  if (kind === "rag") {
    const removed = await store.delete(id.trim());
    if (!removed) throw new DocumentError(404, "找不到这篇文档。");
    return;
  }
  const directory = kind === "gdl" ? roots.gdl : roots.exports;
  const name = safeName(id);
  const filePath = join(directory, name);
  if (!inside(directory, filePath)) throw new DocumentError(400, "文件路径无效。");
  try {
    await rm(filePath, { recursive: true, force: true });
  } catch {
    throw new DocumentError(500, "这个文件没有删除。");
  }
}

export async function readProjectDocument(
  roots: DocumentRoots,
  kind: DocumentKind,
  id: string,
): Promise<{ readonly fileName: string; readonly bytes: Uint8Array; readonly contentType: string }> {
  if (kind === "rag") throw new DocumentError(400, "知识库条目请用知识库面板查看，不能按文件下载。");
  const directory = kind === "gdl" ? roots.gdl : roots.exports;
  const name = safeName(id);
  const filePath = join(directory, name);
  if (!inside(directory, filePath)) throw new DocumentError(400, "文件路径无效。");
  try {
    const bytes = await readFile(filePath);
    const ext = extname(name).toLowerCase();
    const contentType = ext === ".geojson" || ext === ".json"
        ? "application/geo+json"
        : "text/plain; charset=utf-8";
    return { fileName: name, bytes, contentType };
  } catch (error) {
    if (isEnoent(error)) throw new DocumentError(404, "找不到这个文件。");
    throw new DocumentError(500, "文件读不出来。");
  }
}

export async function addTextDocumentToRag(
  store: SqliteVecRagStore,
  input: { readonly title: string; readonly text: string; readonly fileName?: string },
): Promise<{ readonly entryId: string; readonly chunkCount: number }> {
  const fileName = (input.fileName ?? "").trim();
  if (fileName !== "" && VECTOR_FILE.test(fileName)) {
    throw new DocumentError(400, "不能读取 shp、gdb、mif 等矢量文件。请使用纯文本或 Markdown。");
  }
  if (fileName !== "" && !TEXT_FILE.test(fileName) && fileName.includes(".")) {
    throw new DocumentError(400, "只能添加纯文本或 Markdown。");
  }
  if (input.text.includes("\u0000")) throw new DocumentError(400, "文件无法解析，请使用 UTF-8 文本。");
  if (looksLikeGeometryText(input.text)) throw new DocumentError(400, "正文含有几何坐标，已拒绝写入知识库。");
  const title = (input.title.trim() || basename(fileName).replace(/\.[^.]+$/, "") || "未命名文本").slice(0, 200);
  const added = await store.add({ title, body: input.text, kind: "text" });
  return { entryId: added.entryId, chunkCount: added.chunkCount };
}

export async function ensureDocumentDirs(roots: DocumentRoots): Promise<void> {
  await mkdir(roots.gdl, { recursive: true });
  await mkdir(roots.exports, { recursive: true });
}
