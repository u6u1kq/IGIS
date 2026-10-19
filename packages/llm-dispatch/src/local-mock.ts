// SPDX-License-Identifier: Apache-2.0

import type { LlmHttp, LlmHttpResponse } from "./invoke.js";
import { looksLikeGisInstruction, looksLikeLayerNameSupplement, planGisInstruction } from "./gis-route.js";
import type { KnownMockLayer } from "./gis-route.js";

function response(body: unknown): LlmHttpResponse {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

function toolCall(name: string, args: Readonly<Record<string, string | number | boolean>>): LlmHttpResponse {
  return response({
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id: `call-${name}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
  });
}

function textReply(content: string): LlmHttpResponse {
  return response({ choices: [{ message: { content } }] });
}

function userText(body: string): string {
  try {
    const parsed = JSON.parse(body) as { messages?: readonly { role?: string; content?: unknown }[] };
    const messages = parsed.messages ?? [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role === "user" && typeof message.content === "string") return message.content;
    }
  } catch {
    return body;
  }
  return "";
}

function toolCount(body: string): number {
  try {
    const parsed = JSON.parse(body) as { messages?: readonly { role?: string }[] };
    return (parsed.messages ?? []).filter((message) => message.role === "tool").length;
  } catch {
    return 0;
  }
}

function readPath(text: string, fallback: string): string {
  const marked = /文件路径[:：]\s*(\S+)/.exec(text);
  if (marked?.[1]) return marked[1];
  const windows = /[A-Za-z]:\\[^\s"']+/.exec(text);
  if (windows?.[0]) return windows[0];
  return fallback;
}

function readLayer(text: string, fallback: string): string {
  const marked = /图层[:：]\s*(\S+)/.exec(text);
  if (marked?.[1]) return marked[1];
  return fallback;
}

function layerFromToolResults(body: string, fallback: string): string {
  if (fallback.trim() !== "") return fallback;
  try {
    const parsed = JSON.parse(body) as { messages?: readonly { role?: string; content?: unknown }[] };
    for (const message of parsed.messages ?? []) {
      if (message.role !== "tool" || typeof message.content !== "string") continue;
      const payload = JSON.parse(message.content) as { layerNames?: unknown };
      const names = payload.layerNames;
      if (Array.isArray(names) && typeof names[0] === "string" && names[0].trim() !== "") return names[0];
    }
  } catch {
    return fallback;
  }
  return fallback;
}

/** 本地模拟模型。按固定顺序调用三个 GIS 工具，然后结束。 */
export function createScriptedGisMock(filePath: string, layerName: string): LlmHttp {
  return (_url, init) => {
    const text = userText(init.body);
    const path = readPath(text, filePath);
    const layer = layerFromToolResults(init.body, readLayer(text, layerName));
    const done = toolCount(init.body);
    if (done === 0) return Promise.resolve(toolCall("list-layers", { filePath: path }));
    if (done === 1) return Promise.resolve(toolCall("get-layer-metadata", { filePath: path, layerName: layer }));
    if (done === 2) return Promise.resolve(toolCall("get-sample-feature", { filePath: path, layerName: layer }));
    return Promise.resolve(textReply(`已完成图层查询。文件已交给只读工具，结果里没有坐标。图层：${layer}`));
  };
}

function knownLayersFromUser(text: string): KnownMockLayer[] {
  try {
    const parsed = JSON.parse(text) as { mapLayers?: unknown };
    if (!Array.isArray(parsed.mapLayers)) return [];
    return parsed.mapLayers.flatMap((item) => {
      if (item === null || typeof item !== "object") return [];
      const record = item as { layerId?: unknown; layerName?: unknown };
      if (typeof record.layerId !== "string" || typeof record.layerName !== "string") return [];
      return [{ layerId: record.layerId, layerName: record.layerName }];
    });
  } catch {
    return [];
  }
}

function previousResultLayer(body: string): string {
  try {
    const parsed = JSON.parse(body) as { messages?: readonly { role?: string; content?: unknown }[] };
    const messages = [...(parsed.messages ?? [])].reverse();
    for (const message of messages) {
      if (message.role !== "tool" || typeof message.content !== "string") continue;
      const payload = JSON.parse(message.content) as { layerName?: unknown; layerId?: unknown; layerNames?: unknown; ok?: unknown };
      if (payload.ok === false) continue;
      if (typeof payload.layerName === "string" && payload.layerName.trim() !== "") return payload.layerName;
      if (typeof payload.layerId === "string" && payload.layerId.trim() !== "") return payload.layerId;
      if (typeof payload.layerNames === "string" && payload.layerNames.trim() !== "") {
        const first = payload.layerNames.split("、")[0];
        if (first && first.trim() !== "") return first.trim();
      }
    }
  } catch {
    return "";
  }
  return "";
}

function fillPrev(args: Readonly<Record<string, string | number | boolean>>, previous: string): Record<string, string | number | boolean> {
  const next: Record<string, string | number | boolean> = { ...args };
  for (const key of Object.keys(next)) {
    if (next[key] === "__prev__") next[key] = previous;
  }
  return next;
}

function pickTool(text: string, path: string): { readonly name: string; readonly args: Readonly<Record<string, string>> } | null {
  if (path.trim() === "") return null;
  const layer = readLayer(text, "");
  if (/样例|样本|sample/i.test(text) && layer !== "") {
    return { name: "get-sample-feature", args: { filePath: path, layerName: layer } };
  }
  if (/元数据|字段|空间参考|metadata/i.test(text) && layer !== "") {
    return { name: "get-layer-metadata", args: { filePath: path, layerName: layer } };
  }
  if (/图层|list-layers|有哪些层/.test(text) || path !== "") {
    return { name: "list-layers", args: { filePath: path } };
  }
  return null;
}

function spatialTool(text: string): { readonly name: string; readonly args: Readonly<Record<string, string | number | boolean>> } | null {
  const layers = [...text.matchAll(/图层\s*([A-Za-z0-9_-]+)/g)]
    .map((match) => match[1])
    .filter((item): item is string => typeof item === "string" && item.trim() !== "");
  const first = layers[0];
  const second = layers[1];
  const withFlag = (args: Record<string, string | number | boolean>) => args;
  if (/缓冲/.test(text) && first) {
    const distance = /(\d+(?:\.\d+)?)\s*(米|千米|公里|英里|英尺|度)/.exec(text);
    const amount = distance?.[1];
    const unitText = distance?.[2];
    if (!amount || !unitText) return null;
    const unit = unitText === "千米" || unitText === "公里"
      ? "kilometers"
      : unitText === "英里"
        ? "miles"
        : unitText === "英尺"
          ? "feet"
          : unitText === "度"
            ? "degrees"
            : "meters";
    return { name: "map.buffer", args: withFlag({ layerId: first, distance: Number(amount), unit }) };
  }
  if (/裁剪/.test(text) && first && second) return { name: "map.clip", args: withFlag({ layerId: first, otherLayerId: second }) };
  if (/查询/.test(text) && /相交/.test(text) && first && second) {
    return { name: "map.query", args: withFlag({ layerId: first, otherLayerId: second, queryKind: "intersects" }) };
  }
  if (/点在面/.test(text) && first && second) {
    return { name: "map.query", args: withFlag({ layerId: first, otherLayerId: second, queryKind: "point-in-polygon" }) };
  }
  if (/相交/.test(text) && first && second) return { name: "map.intersect", args: withFlag({ layerId: first, otherLayerId: second }) };
  if (/统计/.test(text) && first) {
    const field = /字段\s*([A-Za-z0-9_\u4e00-\u9fff]+)/.exec(text);
    const args: Record<string, string | number | boolean> = { layerId: first };
    if (field?.[1]) args.fieldName = field[1];
    return { name: "map.stats", args: withFlag(args) };
  }
  if (/属性/.test(text) && first) {
    const filter = /属性\s*(\S+)/.exec(text);
    if (!filter?.[1]) return null;
    return { name: "map.query", args: withFlag({ layerId: first, queryKind: "attribute", attributeFilter: filter[1] }) };
  }
  return null;
}

function toolResultNote(body: string): string {
  try {
    const parsed = JSON.parse(body) as { messages?: readonly { role?: string; content?: unknown }[] };
    const messages = parsed.messages ?? [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== "tool" || typeof message.content !== "string") continue;
      const payload = JSON.parse(message.content) as { message?: unknown };
      if (typeof payload.message === "string" && payload.message.trim() !== "" && !payload.message.includes("coordinates")) {
        return payload.message;
      }
    }
  } catch {
    return "";
  }
  return "";
}

function instructionOf(text: string): string {
  try {
    const parsed = JSON.parse(text) as { instruction?: unknown };
    return typeof parsed.instruction === "string" ? parsed.instruction : text;
  } catch {
    return text;
  }
}

function priorInstructionOf(text: string): string {
  try {
    const parsed = JSON.parse(text) as { priorInstruction?: unknown };
    return typeof parsed.priorInstruction === "string" ? parsed.priorInstruction.trim() : "";
  } catch {
    return "";
  }
}

function selectedLayerFromUser(text: string): KnownMockLayer | undefined {
  try {
    const parsed = JSON.parse(text) as { selectedLayer?: unknown };
    const selected = parsed.selectedLayer;
    if (selected === null || typeof selected !== "object") return undefined;
    const record = selected as { layerId?: unknown; layerName?: unknown };
    if (typeof record.layerId !== "string" || typeof record.layerName !== "string") return undefined;
    if (record.layerId.trim() === "" && record.layerName.trim() === "") return undefined;
    return { layerId: record.layerId, layerName: record.layerName };
  } catch {
    return undefined;
  }
}

/** 问题里写了 GDL 时，挑出 STYLE/BUFFER/INTERSECT/CLIP 语句交给 gdl.run，或按图层名调 gdl.describe。 */
function gdlTool(text: string): { readonly name: string; readonly args: Readonly<Record<string, string | boolean>> } | null {
  const instruction = instructionOf(text);
  if (!/gdl/i.test(instruction)) return null;
  const statements = instruction
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(STYLE|BUFFER|INTERSECT|CLIP)\s/i.test(line));
  if (statements.length > 0) {
    const args: Record<string, string | boolean> = { script: statements.join("\n") };
    return { name: "gdl.run", args };
  }
  const layer = /图层\s*[「“"]?([^\s」”"，。]+)/.exec(instruction);
  if (layer?.[1] && /描述|摘要|describe/i.test(instruction)) return { name: "gdl.describe", args: { layerName: layer[1] } };
  return null;
}

/** 对话用的本地模拟。能读中文图层名，并按指令顺序走多步工具。 */
export function createLocalChatMock(): LlmHttp {
  return (_url, init) => {
    const text = userText(init.body);
    const instruction = instructionOf(text);
    const priorInstruction = priorInstructionOf(text);
    const selectedLayer = selectedLayerFromUser(text);
    const done = toolCount(init.body);
    const known = knownLayersFromUser(text);
    if (done === 0) {
      const gdl = gdlTool(text);
      if (gdl) return Promise.resolve(toolCall(gdl.name, gdl.args));
    }
    const plan = planGisInstruction(instruction, known, {
      ...(priorInstruction !== "" ? { priorInstruction } : {}),
      ...(selectedLayer ? { selectedLayer } : {}),
    });
    if (plan.length > 0) {
      const step = plan[done];
      if (step) {
        const previous = previousResultLayer(init.body);
        const args = fillPrev(step.args, previous);
        if (Object.values(args).some((value) => value === "__prev__" || value === "")) {
          return Promise.resolve(textReply("上一步没有生成可用的结果图层，无法继续。"));
        }
        return Promise.resolve(toolCall(step.name, args));
      }
      const toolNote = toolResultNote(init.body);
      if (toolNote) return Promise.resolve(textReply(toolNote));
      const names = plan.map((item) => item.name).join("、");
      return Promise.resolve(textReply(`已按指令完成工具调用：${names}。`));
    }
    if (done === 0 && (looksLikeGisInstruction(instruction) || looksLikeGisInstruction(priorInstruction) || (priorInstruction !== "" && looksLikeLayerNameSupplement(instruction)))) {
      return Promise.resolve(textReply("空间分析需要写明已经载入的图层名。例如：对道路做 200 米缓冲，再与用地相交。"));
    }
    if (done === 0) {
      const path = readPath(text, "");
      const tool = /[A-Za-z]:\\/.test(text) || /文件路径[:：]/.test(text) ? pickTool(text, path) : null;
      if (tool) return Promise.resolve(toolCall(tool.name, tool.args));
    }
    const toolNote = done > 0 ? toolResultNote(init.body) : "";
    if (toolNote) return Promise.resolve(textReply(toolNote));
    const retrieved = /以下是本地检索到的资料[\s\S]*/.exec(text);
    const excerpt = retrieved?.[0]?.replace(/\s+/g, " ").slice(0, 180) ?? "";
    const answer = excerpt.length > 0 ? `根据本地检索：${excerpt}` : "本地模型没有检索到资料，也没有需要调用的 GIS 工具。";
    return Promise.resolve(textReply(answer));
  };
}

/** 的对话模拟，只认「图层 lyr-abc」这种写法，并且一步之后就结束。供评测对照。 */
export function createLegacyLocalChatMock(): LlmHttp {
  return (_url, init) => {
    const text = userText(init.body);
    const done = toolCount(init.body);
    if (done === 0) {
      const gdl = gdlTool(text);
      if (gdl) return Promise.resolve(toolCall(gdl.name, gdl.args));
      if (/缓冲|相交|裁剪|点在面|统计/.test(text) || (/查询/.test(text) && /属性|相交|图层/.test(text))) {
        const spatial = spatialTool(text);
        if (spatial) return Promise.resolve(toolCall(spatial.name, spatial.args));
        return Promise.resolve(textReply("空间分析需要写明图层标识。例如：对图层 lyr-abc 缓冲 100 米。"));
      }
      const path = readPath(text, "");
      const tool = /[A-Za-z]:\\/.test(text) || /文件路径[:：]/.test(text) ? pickTool(text, path) : null;
      if (tool) return Promise.resolve(toolCall(tool.name, tool.args));
    }
    const toolNote = done > 0 ? toolResultNote(init.body) : "";
    if (toolNote) return Promise.resolve(textReply(toolNote));
    const retrieved = /以下是本地检索到的资料[\s\S]*/.exec(text);
    const excerpt = retrieved?.[0]?.replace(/\s+/g, " ").slice(0, 180) ?? "";
    const answer = excerpt.length > 0 ? `根据本地检索：${excerpt}` : "本地模型没有检索到资料，也没有需要调用的 GIS 工具。";
    return Promise.resolve(textReply(answer));
  };
}

