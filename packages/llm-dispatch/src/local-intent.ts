// SPDX-License-Identifier: Apache-2.0

import { looksLikeGeometryText } from "@igis/shared-types";
import type { KnownMockLayer } from "./gis-route.js";

/**
 * 本地意图只是加速器。本文件抽出意图、图层名和距离，不调用模型，不读几何。
 * 抽不全时由 dispatch-policy 把原文和这里的部分实体交给云端模型，不能在这里停住。
 * 句中没有距离就是缺槽。200 只表示用户写出了 200，不能用来填空槽。
 * 旧的空槽 200 来自早期测试句被直接写进解析器，不是距离规则。
 * 整句里还有对不上的词时，不在本地执行。
 *
 * 分离：两个图层名都在时，只做一次裁剪（第一个名字是被裁图层，第二个是裁剪图层）。
 */

export type InstructionIntent =
  | "analyze"
  | "buffer"
  | "intersect"
  | "clip"
  | "separate"
  | "buffer-intersect"
  | "buffer-clip"
  | "delete"
  | "hide"
  | "show"
  | "clear-all"
  | "drop-database";

export interface NormalizedInstruction {
  readonly intent: InstructionIntent;
  readonly layers: readonly string[];
  readonly distance: { readonly distance: number; readonly unit: "meters" } | null;
}

export interface PartialEntities {
  readonly intentFragments: readonly string[];
  readonly layerCandidates: readonly string[];
  readonly numbers: readonly number[];
}

export interface LocalIntentOptions {
  readonly lastCreatedLayerId?: string | null;
}

const PLACEHOLDER = /^(当前图层|另一图层|这个图层|该图层|其它图层|其他图层|这张图|这张地图)$/;

/** 虚词和操作词。不能从「首先」里拆出「首」来当图层名。 */
const FUNCTION_WORDS = new Set([
  "首", "先", "首先", "当前", "另一", "其他", "其它", "这个", "那个", "该",
  "再", "和", "与", "跟", "对", "把", "将", "给", "用", "到", "在", "做",
  "进行", "分析", "缓冲", "缓冲区", "相交", "求交", "交点", "交点分析", "裁剪", "裁切", "分离", "图层", "米",
  "现在", "请", "一下", "切一下", "后", "然后", "并", "的", "地", "得", "且",
  "千米", "公里", "删除", "删掉", "移除", "隐藏", "显示", "看看", "它", "结果",
  "刚才", "上一个", "清空", "数据库", "所有", "百", "千", "两百", "三百", "一千",
  "或者", "还是", "大约", "大概",
  "这张地图", "这张图", "写入知识库",
  "两", "个", "两个", "一下", "什么", "怎么", "如何", "可以", "帮我", "请问",
  "是否", "没有", "已经", "需要", "吗", "呢", "吧",
  "buffer", "buffers", "buffering", "intersect", "intersection", "clip", "clipping",
  "meters", "meter", "kilometers", "kilometer", "please",
]);

const MARKERS = [
  "刚才那个结果", "上一个结果", "这个结果", "删除数据库", "清空所有", "交点分析",
  "这张地图", "这张图", "当前图层", "另一图层", "这个图层", "该图层", "其它图层", "其他图层",
  "缓冲区", "裁切一下", "切一下", "首先", "然后", "现在", "删掉", "删除", "移除", "进行", "一下",
  "by", "the", "and", "then", "with", "from", "into", "for",
  "裁切", "裁剪", "求交", "相交", "分离", "缓冲", "隐藏", "显示", "看看", "分析",
  "图层", "千米", "公里", "当前", "另一", "其他", "其它", "这个", "那个", "先", "再",
  "和", "与", "跟", "对", "把", "将", "给", "用", "到", "在", "做", "请", "后", "并",
  "的", "米", "该", "首", "它",
  "两个", "一下", "什么", "怎么", "如何", "帮我", "请问", "是否", "没有", "已经",
  "buffering", "buffers", "buffer", "intersection", "intersect", "clipping", "clip",
  "kilometers", "kilometer", "meters", "meter", "please",
].sort((left, right) => right.length - left.length || left.localeCompare(right));

const ANAPHORA = /它|刚才那个结果|这个结果|上一个结果/;

const TOKEN_SPLIT = /[和与、,，。！？；;：:\s_]+/;

const CN_DIGIT: Readonly<Record<string, number>> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

const CN_UNIT: Readonly<Record<string, number>> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

function isSingleCjk(name: string): boolean {
  return /^[\u4e00-\u9fff]$/.test(name);
}

function isLoadedExact(name: string, known: readonly KnownMockLayer[]): boolean {
  return known.some((layer) => layer.layerName === name || layer.layerId === name);
}

/** 功能词不是图层名。单个汉字只有在已载入图层就叫这个字时才保留。 */
function allowedLayerLabel(label: string, known: readonly KnownMockLayer[]): boolean {
  if (FUNCTION_WORDS.has(label) || PLACEHOLDER.test(label)) {
    return isSingleCjk(label) && isLoadedExact(label, known);
  }
  if (isSingleCjk(label)) return isLoadedExact(label, known);
  if (parseCnInteger(label) !== null) return false;
  return true;
}

function loadedLabels(known: readonly KnownMockLayer[]): string[] {
  const labels: string[] = [];
  for (const layer of known) {
    const name = layer.layerName.trim();
    const id = layer.layerId.trim();
    if (name !== "") labels.push(name);
    if (id !== "" && id !== name) labels.push(id);
  }
  return [...new Set(labels)].sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function longestAt(text: string, cursor: number, labels: readonly string[]): string | null {
  for (const label of labels) {
    if (label !== "" && text.startsWith(label, cursor)) return label;
  }
  return null;
}

function maskSpans(text: string, spans: readonly (readonly [number, number])[]): string {
  if (spans.length === 0) return text;
  const chars = [...text];
  for (const [start, end] of spans) {
    for (let index = start; index < end && index < chars.length; index += 1) chars[index] = " ";
  }
  return chars.join("");
}

interface LayerScan {
  readonly layers: readonly string[];
  readonly outside: string;
}

/**
 * 已载入图层按从左到右的最长匹配切分，匹配后从结尾继续。
 * 话语标记（首先）整段跳过，不留下「首」。
 */
function scanLayers(text: string, known: readonly KnownMockLayer[]): LayerScan {
  const labels = loadedLabels(known).filter((label) => allowedLayerLabel(label, known));
  const found: { index: number; name: string }[] = [];
  const covered: Array<[number, number]> = [];
  const layerSpans: Array<[number, number]> = [];
  let cursor = 0;
  while (cursor < text.length) {
    const marker = longestAt(text, cursor, MARKERS);
    const layer = longestAt(text, cursor, labels);
    if (layer && (!marker || layer.length >= marker.length)) {
      found.push({ index: cursor, name: layer });
      layerSpans.push([cursor, cursor + layer.length]);
      covered.push([cursor, cursor + layer.length]);
      cursor += layer.length;
      continue;
    }
    if (marker) {
      covered.push([cursor, cursor + marker.length]);
      cursor += marker.length;
      continue;
    }
    cursor += 1;
  }
  const gaps: { index: number; text: string }[] = [];
  const ranges = [...covered].sort((left, right) => left[0] - right[0]);
  let from = 0;
  for (const [start, end] of ranges) {
    if (start > from) gaps.push({ index: from, text: text.slice(from, start) });
    from = Math.max(from, end);
  }
  if (from < text.length) gaps.push({ index: from, text: text.slice(from) });
  for (const gap of gaps) {
    let offset = 0;
    for (const part of gap.text.split(TOKEN_SPLIT)) {
      const name = part.trim();
      const at = name === "" ? -1 : gap.text.indexOf(name, offset);
      if (at >= 0) offset = at + name.length;
      if (!allowedLayerLabel(name, known) || name.length > 80) continue;
      if (rejectedLooseLayerName(name, text, known)) continue;
      if (/^\d+(?:\.\d+)?$/.test(name)) continue;
      if (/^(?:by|the|a|an|of|to|and|or|then|with|from|into|on|in|for|layer|layers|current|selected|this|that)$/i.test(name)) continue;
      if (parseCnInteger(name) !== null) continue;
      if (!/[A-Za-z0-9\u4e00-\u9fff]/.test(name)) continue;
      if (found.some((item) => item.name === name)) continue;
      found.push({ index: at < 0 ? text.length : gap.index + at, name });
    }
  }
  found.sort((left, right) => left.index - right.index || left.name.localeCompare(right.name));
  const unique: string[] = [];
  for (const item of found) {
    if (!unique.includes(item.name)) unique.push(item.name);
  }
  return { layers: unique, outside: maskSpans(text, layerSpans) };
}

/** 显式图层名。粘在一起的已载入图层名会按最长匹配切开。不含「当前图层」。首先/首不会变成图层。 */
export function explicitLayerTokens(text: string, known: readonly KnownMockLayer[] = []): string[] {
  return [...scanLayers(text, known).layers];
}

/** 整句或夹着虚词的碎片不是图层名。已经载入的图层名保持原样。 */
function rejectedLooseLayerName(name: string, fullText: string, known: readonly KnownMockLayer[]): boolean {
  if (isLoadedExact(name, known)) return false;
  if (name === fullText.trim()) return true;
  if (name.length > 32) return true;
  for (const word of FUNCTION_WORDS) {
    if (word.length >= 2 && name.includes(word)) return true;
  }
  return false;
}

/** 中文整数。两百=200，三百=300，一千=1000。认不出返回 null。 */
export function parseCnInteger(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "" || !/^[零〇一二两三四五六七八九十百千万]+$/.test(trimmed)) return null;
  let total = 0;
  let current = 0;
  let seen = false;
  for (const char of trimmed) {
    if (char in CN_DIGIT) {
      current = CN_DIGIT[char] ?? 0;
      seen = true;
      continue;
    }
    const unit = CN_UNIT[char];
    if (!unit) return null;
    if (current === 0) current = 1;
    total += current * unit;
    current = 0;
    seen = true;
  }
  if (!seen) return null;
  return total + current;
}

/** 「两个」「两边」里的两是量词，不是米。两百、两米仍然是距离。 */
function isMeasureWordLiang(text: string, token: string, index: number): boolean {
  if (token !== "两" && token !== "二") return false;
  const next = text[index + token.length] ?? "";
  return /[个层条只张次边种份块名点样]/.test(next);
}

/**
 * 距离一律折成米。200米、200、两百 → 200；三百 → 300；一千 → 1000；1.5公里 → 1500。
 * 没有单位时默认米。量词「两」不算米。
 */
export function parseDistanceMeters(text: string): { readonly distance: number; readonly unit: "meters" } | null {
  const kilo = /(\d+(?:\.\d+)?)\s*(千米|公里|km|kilometers?)/i.exec(text);
  if (kilo?.[1]) {
    const value = Number(kilo[1]) * 1000;
    if (Number.isFinite(value) && value > 0) return { distance: value, unit: "meters" };
  }
  const meters = /(\d+(?:\.\d+)?)\s*(米|m|meters?)/i.exec(text);
  if (meters?.[1] && !/(千米|公里)/.test(meters[0] ?? "")) {
    const value = Number(meters[1]);
    if (Number.isFinite(value) && value > 0) return { distance: value, unit: "meters" };
  }
  const cnKilo = /([零〇一二两三四五六七八九十百千万]+)\s*(千米|公里)/.exec(text);
  if (cnKilo?.[1]) {
    const base = parseCnInteger(cnKilo[1]);
    if (base !== null && base > 0) return { distance: base * 1000, unit: "meters" };
  }
  const cnMeters = /([零〇一二两三四五六七八九十百千万]+)\s*米/.exec(text);
  if (cnMeters?.[1]) {
    const base = parseCnInteger(cnMeters[1]);
    if (base !== null && base > 0) return { distance: base, unit: "meters" };
  }
  const cnBare = /[零〇一二两三四五六七八九十百千万]{1,8}/g;
  for (const match of text.matchAll(cnBare)) {
    const token = match[0];
    if (!token || isMeasureWordLiang(text, token, match.index ?? 0)) continue;
    const base = parseCnInteger(token);
    if (base !== null && base > 0) return { distance: base, unit: "meters" };
  }
  const bare = /(?:^|[^\d.])(\d+(?:\.\d+)?)(?!\s*(?:千米|公里|km|米|m))/i.exec(text);
  if (bare?.[1] && !/(千米|公里|km|米)/i.test(text)) {
    const value = Number(bare[1]);
    if (Number.isFinite(value) && value > 0) return { distance: value, unit: "meters" };
  }
  return null;
}

/** 两个以上运算被「或者 / 还是」连起来，本地不能猜。 */
export function isAmbiguousIntent(text: string): boolean {
  if (!/或者|还是|或是|\bor\b/i.test(text)) return false;
  const hits = intentFragmentsOf(text);
  const ops = hits.filter((item) => item !== "analyze");
  return ops.length >= 2;
}

export function intentFragmentsOf(text: string): string[] {
  const fragments: string[] = [];
  if (/删除数据库/.test(text)) fragments.push("drop-database");
  if (/清空所有/.test(text)) fragments.push("clear-all");
  if (/缓冲|\b(?:buffer|buffers|buffering)\b/i.test(text)) fragments.push("buffer");
  if (/相交|求交|交点分析|交点|\b(?:intersect|intersection)\b/i.test(text)) fragments.push("intersect");
  if (/裁剪|裁切|切一下|\b(?:clip|clipping)\b/i.test(text)) fragments.push("clip");
  if (/分离/.test(text)) fragments.push("separate");
  if (/删除|删掉|移除/.test(text) && !/删除数据库/.test(text)) fragments.push("delete");
  if (/隐藏/.test(text)) fragments.push("hide");
  if (/显示/.test(text)) fragments.push("show");
  if (/分析|看看/.test(text)) fragments.push("analyze");
  return fragments;
}

export function collectPartialEntities(text: string, known: readonly KnownMockLayer[] = []): PartialEntities {
  const distance = parseDistanceMeters(text);
  return {
    intentFragments: intentFragmentsOf(text),
    layerCandidates: explicitLayerTokens(text, known),
    numbers: distance ? [distance.distance] : [],
  };
}

/** 先…再…然后… 拆成子句。没有「然后/接着」时返回 null，以免拆开原来的缓冲再相交。 */
export function parseSequenceClauses(text: string): readonly string[] | null {
  if (!/然后|接着|\bthen\b/i.test(text) || isAmbiguousIntent(text)) return null;
  const parts = text
    .split(/然后|接着|\bthen\b/i)
    .flatMap((part) => part.split(/再/))
    .map((part) => part.replace(/^先(做)?/, "").replace(/^[，,\s]+|[，,\s]+$/g, "").trim())
    .filter((part) => part !== "");
  if (parts.length < 2) return null;
  return parts;
}

function applyAnaphora(layers: readonly string[], text: string, lastCreatedLayerId: string | null | undefined): string[] {
  const id = typeof lastCreatedLayerId === "string" ? lastCreatedLayerId.trim() : "";
  if (id === "" || !ANAPHORA.test(text)) return [...layers];
  return [id, ...layers.filter((name) => name !== id)];
}

/** 能认出意图就返回结构；认不出或含糊返回 null，交给云端模型。 */
export function normalizeInstruction(
  text: string,
  known: readonly KnownMockLayer[] = [],
  options: LocalIntentOptions = {},
): NormalizedInstruction | null {
  const trimmed = text.trim();
  if (trimmed === "" || looksLikeGeometryText(trimmed) || isAmbiguousIntent(trimmed)) return null;
  const scanned = scanLayers(trimmed, known);
  const outside = scanned.outside;
  const wantsDrop = /删除数据库/.test(outside);
  const wantsClear = /清空所有/.test(outside);
  const wantsDelete = /删除|删掉|移除/.test(outside);
  const wantsSeparate = /分离/.test(outside);
  const wantsAnalyze = /分析|看看/.test(outside);
  const wantsBuffer = /缓冲|\b(?:buffer|buffers|buffering)\b/i.test(outside);
  const wantsIntersect = /相交|求交|交点分析|交点|\b(?:intersect|intersection)\b/i.test(outside) && !/查询|\bquery\b/i.test(outside);
  const wantsClip = /裁剪|裁切|切一下|\b(?:clip|clipping)\b/i.test(outside);
  const wantsHide = /隐藏/.test(outside);
  const wantsShow = /显示/.test(outside) && !/显示或隐藏/.test(outside);
  let intent: InstructionIntent | null = null;
  if (wantsDrop) intent = "drop-database";
  else if (wantsClear) intent = "clear-all";
  else if (wantsDelete) intent = "delete";
  else if (wantsHide && !wantsShow) intent = "hide";
  else if (wantsShow && !wantsHide) intent = "show";
  else if (wantsSeparate) intent = "separate";
  else if (wantsAnalyze && !wantsBuffer && !wantsIntersect && !wantsClip && !wantsDelete) intent = "analyze";
  else if (wantsBuffer && wantsIntersect) intent = "buffer-intersect";
  else if (wantsBuffer && wantsClip) intent = "buffer-clip";
  else if (wantsBuffer) intent = "buffer";
  else if (wantsIntersect) intent = "intersect";
  else if (wantsClip) intent = "clip";
  if (!intent) return null;
  if (hasUnexplainedResidue(trimmed, known)) return null;
  const layers = applyAnaphora(scanned.layers, trimmed, options.lastCreatedLayerId);
  const parsedDistance = parseDistanceMeters(trimmed);
  const distance = intent === "delete" || intent === "clear-all" || intent === "drop-database" || intent === "hide" || intent === "show" || intent === "analyze"
    ? null
    : parsedDistance;
  return { intent, layers, distance };
}

/** 去掉工具词、已载入图层名、距离和虚词之后还剩字，这句话就不在本地执行。 */
function hasUnexplainedResidue(text: string, known: readonly KnownMockLayer[]): boolean {
  let rest = text;
  const names = known.map((layer) => layer.layerName).filter((name) => name !== "").sort((left, right) => right.length - left.length);
  for (const name of names) rest = rest.split(name).join(" ");
  for (const id of known.map((layer) => layer.layerId)) {
    if (id !== "") rest = rest.split(id).join(" ");
  }
  for (const marker of MARKERS) rest = rest.split(marker).join(" ");
  rest = rest.replace(/\d+(?:\.\d+)?/g, " ");
  rest = rest.replace(/[零〇一二两三四五六七八九十百千万]+/g, " ");
  rest = rest.replace(/[^\p{L}\p{N}]+/gu, "");
  return rest !== "";
}

const SLOT_LABEL: Readonly<Record<string, string>> = {
  layerId: "layer1",
  otherLayerId: "layer2",
  layerName: "layer1",
  distance: "distance",
};

/** 开发者模式下给用户看的中文解析轨迹。不含坐标。 */
export function formatParseTrace(intents: readonly string[], missing: readonly string[], phase: "wait" | "run" | "confirm" | "model"): string {
  const intentText = intents.length > 0 ? intents.join(" + ") : "未识别";
  const miss = missing.length > 0 ? missing.map((slot) => SLOT_LABEL[slot] ?? slot).join(", ") : "无";
  if (phase === "wait") return `提取到意图: ${intentText}；缺失参数: ${miss}；等待用户补充`;
  if (phase === "confirm") return `提取到意图: ${intentText}；需要确认后才会执行`;
  if (phase === "run") return `提取到意图: ${intentText}；参数已齐，本地执行`;
  return `提取到意图: ${intentText}；缺失参数: ${miss}；转交模型`;
}
