// SPDX-License-Identifier: Apache-2.0

/** 与 vec0 表的 float[64] 一致。换维度就要重建库。 */
export const VECTOR_DIMENSION = 64;

function hashText(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** 本地字符三元组哈希。不下载模型，也不调用云端嵌入接口。 */
export function embedText(text: string): Float32Array {
  const vector = new Float32Array(VECTOR_DIMENSION);
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return vector;
  const grams: string[] = [];
  if (normalized.length < 3) grams.push(normalized);
  else {
    for (let index = 0; index <= normalized.length - 3; index += 1) {
      grams.push(normalized.slice(index, index + 3));
    }
  }
  for (const gram of grams) {
    const primary = hashText(gram) % VECTOR_DIMENSION;
    const secondary = hashText(`${gram}#`) % VECTOR_DIMENSION;
    const sign = hashText(`${gram}!`) % 2 === 0 ? 1 : -1;
    const left = vector[primary] ?? 0;
    const right = vector[secondary] ?? 0;
    vector[primary] = left + sign;
    vector[secondary] = right + 1;
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  if (norm === 0) return vector;
  const scale = 1 / Math.sqrt(norm);
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index] ?? 0;
    vector[index] = value * scale;
  }
  return vector;
}

export function chunkPlainText(text: string, size = 480): readonly string[] {
  const trimmed = text.replace(/\r\n/g, "\n").trim();
  if (trimmed === "") return [];
  const paragraphs = trimmed.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";
  const push = (value: string): void => {
    const piece = value.trim();
    if (piece !== "") chunks.push(piece);
  };
  for (const paragraph of paragraphs) {
    if (paragraph.length > size) {
      push(current);
      current = "";
      for (let index = 0; index < paragraph.length; index += size) {
        push(paragraph.slice(index, index + size));
      }
      continue;
    }
    const next = current === "" ? paragraph : `${current}\n\n${paragraph}`;
    if (next.length > size) {
      push(current);
      current = paragraph;
    } else {
      current = next;
    }
  }
  push(current);
  return chunks;
}
