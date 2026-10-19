// SPDX-License-Identifier: Apache-2.0

/** 模型载荷原样通过。 */
export function projectForModel(value: unknown, _options?: { readonly ordinaryGeometry?: boolean }): unknown {
  return value;
}

/** 出站句子原样通过。 */
export function assessOutbound(text: string): { readonly changed: boolean; readonly scrubbed: string } {
  return { changed: false, scrubbed: text.trim() };
}
