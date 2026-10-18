// SPDX-License-Identifier: Apache-2.0

import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { hashSourceContent } from "@igis/provenance";

function filesystemCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function assertInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * 收集目录内的普通文件。符号链接若指向目录外，则跳过，避免把无关字节算进来源。
 * 返回的是相对路径，分隔符统一为 /。
 */
async function listFiles(root: string): Promise<readonly string[]> {
  const realRoot = await realpath(root);
  let entries: string[];
  try {
    entries = await readdir(root, { recursive: true });
  } catch (error) {
    if (filesystemCode(error) === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const hostPath = resolve(root, entry);
    let info;
    try {
      info = await stat(hostPath);
    } catch (error) {
      if (filesystemCode(error) === "ENOENT") continue;
      throw error;
    }
    if (!info.isFile()) continue;
    let realFile: string;
    try {
      realFile = await realpath(hostPath);
    } catch (error) {
      if (filesystemCode(error) === "ENOENT") continue;
      throw error;
    }
    if (!assertInside(realRoot, realFile) && realFile !== realRoot) continue;
    files.push(entry.replaceAll("\\", "/"));
  }
  files.sort();
  return files;
}

/**
 * 准备账本要哈希的源内容。
 * 文件使用字节。目录使用「相对路径 + 各文件 SHA-256」的清单，清单里没有几何文本。
 * 路径不存在或无法读取时，退回路径字符串本身。账本只保存最终摘要，不保存这段明文。
 */
export async function readSourceDigestMaterial(absolutePath: string): Promise<string | Uint8Array> {
  try {
    const info = await stat(absolutePath);
    if (info.isDirectory()) {
      const names = await listFiles(absolutePath);
      const lines: string[] = [];
      for (const name of names) {
        const bytes = await readFile(join(absolutePath, name));
        lines.push(`${name}\0${hashSourceContent(bytes)}`);
      }
      return lines.join("\n");
    }
    if (info.isFile()) return await readFile(absolutePath);
  } catch (error) {
    if (filesystemCode(error) !== null) return absolutePath;
    throw error;
  }
  return absolutePath;
}
