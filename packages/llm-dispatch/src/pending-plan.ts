// SPDX-License-Identifier: Apache-2.0

import { AUTHORIZATION_FORBIDDEN_INTENT_FIELDS } from "@igis/ai-boundary";
import type { ScalarArg } from "@igis/shared-types";
import { toApiToolName } from "./aliases.js";
import { destructiveActionOf, destructiveConfirmMessage } from "./destructive.js";
import { looksLikeGisInstruction, looksLikeLayerNameSupplement } from "./gis-route.js";
import type { KnownMockLayer, PlannedGisCall } from "./gis-route.js";
import { normalizeToolArguments } from "./normalize-args.js";
import { GIS_TOOL_REGISTRY } from "./registry.js";
import type { GisToolDefinition } from "./registry.js";
import { completeToolLoop, toolTraceFromResult } from "./loop.js";
import type { ToolLoopResult, ToolTrace } from "./loop.js";
import type { ScheduledToolCall, ToolAdapterPort } from "./validate.js";
import { progressToolEvent } from "./chat-progress.js";
import type { ChatProgressHandler } from "./chat-progress.js";
import {
  collectPartialEntities,
  explicitLayerTokens,
  formatParseTrace,
  normalizeInstruction,
  parseSequenceClauses,
} from "./instruction-normalizer.js";
import type { NormalizedInstruction, PartialEntities } from "./instruction-normalizer.js";

export interface PendingPlanStep {
  readonly tool: string;
  readonly apiName: string;
  readonly args: Readonly<Record<string, string | number | boolean>>;
  readonly missing: readonly string[];
  readonly bindPrevTo?: string;
}

export interface PendingPlan {
  readonly conversationId: string;
  readonly sourceText: string;
  readonly steps: readonly PendingPlanStep[];
  /** 危险操作已问过确认，只有带 confirm 的下一次请求才能执行。 */
  readonly requiresConfirm?: boolean;
}

export type ChatPlanResolution =
  | { readonly kind: "execute"; readonly calls: readonly PlannedGisCall[]; readonly pending: null; readonly sourcePlan: PendingPlan; readonly parseTrace: string }
  | { readonly kind: "clarify"; readonly text: string; readonly pending: PendingPlan; readonly parseTrace: string }
  | { readonly kind: "confirm"; readonly text: string; readonly pending: PendingPlan; readonly parseTrace: string }
  | { readonly kind: "reply"; readonly text: string; readonly pending: null; readonly parseTrace: string }
  | {
    readonly kind: "model";
    readonly pending: null;
    readonly originalText: string;
    readonly partial: PartialEntities;
    readonly pendingSummary: string | null;
    readonly parseTrace: string;
  };

export interface ResolveChatPlanInput {
  readonly conversationId: string;
  readonly text: string;
  readonly pending: PendingPlan | null;
  readonly selectedLayer: { readonly layerId: string; readonly layerName: string } | null;
  readonly knownLayers?: readonly KnownMockLayer[];
  /** 本对话里最近一次工具创建的图层标识。供「它 / 刚才那个结果」绑定。 */
  readonly lastCreatedLayerId?: string | null;
  /** 用户在确认框里再次提交时为 true。否则危险操作只返回挑战，不执行。 */
  readonly confirm?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean";
}

function selectedName(selected: ResolveChatPlanInput["selectedLayer"]): string | undefined {
  if (!selected) return undefined;
  const name = selected.layerName.trim() !== "" ? selected.layerName.trim() : selected.layerId.trim();
  return name === "" ? undefined : name;
}

/**
 * 缓冲槽如果来自选中图层，保留 layerId。
 * 不把选中 id 收成显示名再去按名查找，避免同名时落到另一层或变成歧义。
 * 用户已经写出的图层名不在这里改写。相交、裁剪仍用 selectedName 的显示名。
 */
function bufferLayerArg(
  filled: string | undefined,
  pickedName: string | undefined,
  selected: ResolveChatPlanInput["selectedLayer"],
): string | undefined {
  if (!filled) return undefined;
  if (pickedName !== undefined && filled === pickedName) {
    const id = selected?.layerId.trim() ?? "";
    if (id !== "") return id;
  }
  return filled;
}

export function planIsComplete(plan: PendingPlan): boolean {
  return plan.steps.every((step) => step.missing.length === 0);
}

function isAnalyzePlan(plan: PendingPlan): boolean {
  return plan.steps.length > 0 && plan.steps.every((step) => step.tool === "gdl.describe" || step.tool === "map.stats");
}

export function clarifyPendingPlan(plan: PendingPlan): string {
  const slots = plan.steps.flatMap((step) => step.missing);
  const buffer = plan.steps.some((step) => step.tool === "map.buffer");
  const intersect = plan.steps.some((step) => step.tool === "map.intersect");
  const clip = plan.steps.some((step) => step.tool === "map.clip");
  const analyze = isAnalyzePlan(plan);
  const separate = clip && plan.sourceText.includes("分离");
  const remove = plan.steps.length > 0 && plan.steps.every((step) => step.tool === "map.delete");
  if (remove) return "请指定要删除的图层。";
  if (analyze) return "请指定要分析的图层。";
  if (separate && slots.length > 1) return "请指定要分离的两个图层，例如：area-a和area-b。";
  if (separate && slots.length === 1) return "请指定另一个要分离的图层。";
  if (buffer && intersect && slots.includes("layerId") && slots.includes("otherLayerId")) {
    return "请指定要缓冲的图层和要相交的图层，例如：area-a和area-b。";
  }
  if (buffer && intersect && slots.includes("otherLayerId")) return "请指定要相交的图层。";
  if (buffer && slots.includes("distance") && slots.includes("layerId")) return "请指定要缓冲的图层，并给出距离。不会填默认距离。";
  if (buffer && slots.includes("distance")) return "请给出缓冲距离。不会填默认距离。";
  if (buffer && slots.includes("layerId")) return "请指定要缓冲的图层。";
  if (clip && slots.length > 0) return "请指定裁剪用到的图层名。";
  if (intersect && slots.length > 0) return "请指定要相交的图层。";
  return "空间分析需要写明已经载入的图层名。";
}

function stepOf(
  tool: string,
  args: Record<string, string | number | boolean>,
  missing: readonly string[],
  bindPrevTo?: string,
): PendingPlanStep {
  return {
    tool,
    apiName: toApiToolName(tool),
    args,
    missing,
    ...(bindPrevTo ? { bindPrevTo } : {}),
  };
}

function mentionedCurrent(text: string): boolean {
  return /当前图层|这个图层|该图层|这张地图|这张图/.test(text);
}

/** 用户已经写出的图层名优先。选中图层只在没有显式名字时填「当前图层」，分析且没点名时也可以填。 */
function selectedFillName(
  text: string,
  normalized: NormalizedInstruction,
  selected: ResolveChatPlanInput["selectedLayer"],
): string | undefined {
  if (normalized.layers.length > 0) return undefined;
  if (normalized.intent !== "analyze" && !mentionedCurrent(text)) return undefined;
  return selectedName(selected);
}

const DANGEROUS_TOOLS = new Set(["map.delete", "map.clearAll", "map.dropDatabase"]);

function isDangerousPlan(plan: PendingPlan): boolean {
  return plan.steps.length > 0 && plan.steps.every((step) => DANGEROUS_TOOLS.has(step.tool));
}

function intentLabels(plan: PendingPlan): string[] {
  const labels: string[] = [];
  for (const step of plan.steps) {
    if (step.tool === "map.buffer") labels.push("buffer");
    else if (step.tool === "map.intersect") labels.push("intersect");
    else if (step.tool === "map.clip") labels.push("clip");
    else if (step.tool === "map.delete") labels.push("delete");
    else if (step.tool === "map.clearAll") labels.push("clear-all");
    else if (step.tool === "map.dropDatabase") labels.push("drop-database");
    else if (step.tool === "map.setVisibility") labels.push(step.args.visible === false ? "hide" : "show");
    else if (step.tool === "gdl.describe" || step.tool === "map.stats") {
      if (!labels.includes("analyze")) labels.push("analyze");
    }
  }
  return labels;
}

function missingSlots(plan: PendingPlan): string[] {
  return plan.steps.flatMap((step) => step.missing);
}

function confirmText(plan: PendingPlan): string {
  const action = destructiveActionOf(plan.steps[0]?.tool ?? "");
  if (plan.steps.every((step) => destructiveActionOf(step.tool) === "drop-database")) return destructiveConfirmMessage("drop-database");
  if (plan.steps.every((step) => destructiveActionOf(step.tool) === "clear-layers")) return destructiveConfirmMessage("clear-layers");
  const names = plan.steps.map((step) => (typeof step.args.layerId === "string" ? step.args.layerId : "")).filter((name) => name !== "");
  return destructiveConfirmMessage(action ?? "delete-layer", names.join("、"));
}

function withConfirmedDestructive(plan: PendingPlan): PendingPlan {
  return {
    ...plan,
    steps: plan.steps.map((step) => (
      destructiveActionOf(step.tool) ? { ...step, args: { ...step.args, confirm: true } } : step
    )),
  };
}

function modelResolution(
  text: string,
  known: readonly KnownMockLayer[],
  pending: PendingPlan | null,
  parseTrace: string,
): ChatPlanResolution {
  const partial = pending
    ? {
      intentFragments: intentLabels(pending),
      layerCandidates: filledLayerSlots(pending),
      numbers: pending.steps.flatMap((step) => (typeof step.args.distance === "number" ? [step.args.distance] : [])),
    }
    : collectPartialEntities(text, known);
  const summary = pending
    ? pending.steps.map((step) => `${step.apiName}(${step.missing.length > 0 ? `缺 ${step.missing.join(",")}` : "已填"})`).join(" → ")
    : null;
  return {
    kind: "model",
    pending: null,
    originalText: pending?.sourceText && pending.sourceText.trim() !== "" ? pending.sourceText : text,
    partial,
    pendingSummary: summary,
    parseTrace,
  };
}

function finishComplete(plan: PendingPlan, confirm: boolean): ChatPlanResolution {
  const labels = intentLabels(plan);
  if (isDangerousPlan(plan) && confirm !== true) {
    const gated: PendingPlan = { ...plan, requiresConfirm: true };
    return { kind: "confirm", text: confirmText(gated), pending: gated, parseTrace: formatParseTrace(labels, [], "confirm") };
  }
  const ready = confirm === true ? withConfirmedDestructive(plan) : plan;
  return { kind: "execute", calls: plannedCallsFrom(ready), pending: null, sourcePlan: ready, parseTrace: formatParseTrace(labels, [], "run") };
}

const LAYER_SLOTS = ["layerId", "otherLayerId", "layerName"] as const;

/** 缺图层或缺参数，而不是坐标系不支持。这种失败可以留着原计划等下一句补槽。 */
export function isMissingSlotFailure(trace: { readonly ok: boolean; readonly code?: string; readonly message: string }): boolean {
  if (trace.ok) return false;
  const message = trace.message;
  if (/坐标系|EPSG|towgs84|投影|局部平面|\bCRS\b/i.test(message)) return false;
  const code = trace.code ?? "";
  if (code === "unknown-layer" || code === "ambiguous-layer" || code === "NotFound" || code === "Ambiguous") return true;
  return /找不到|没有填写|不能唯一确定|有歧义|请先把图层载入|图层名必须是字符串|需要指定|不能为空|缺少距离|距离必须|没有距离/.test(message);
}

/**
 * 本地执行因缺图层或缺参数失败时，把失败步的图层槽重新标成缺失。
 * 计划里只有标量参数和原句，不放几何。
 */
export function continuablePlanAfterFailure(
  plan: PendingPlan,
  traces: readonly { readonly ok: boolean; readonly code?: string; readonly message: string }[],
): PendingPlan | null {
  let reopened = false;
  const steps = plan.steps.map((step, index) => {
    const trace = traces[index];
    if (!trace || !isMissingSlotFailure(trace)) return step;
    const args: Record<string, string | number | boolean> = { ...step.args };
    const missing = [...step.missing];
    let changed = false;
    for (const key of LAYER_SLOTS) {
      if (!Object.prototype.hasOwnProperty.call(args, key)) continue;
      delete args[key];
      if (!missing.includes(key)) missing.push(key);
      changed = true;
    }
    if (/距离|单位|distance|unit/i.test(trace.message)) {
      if (Object.prototype.hasOwnProperty.call(args, "distance")) {
        delete args.distance;
        changed = true;
      }
      if (Object.prototype.hasOwnProperty.call(args, "unit")) delete args.unit;
      if (!missing.includes("distance")) missing.push("distance");
    }
    if (!changed && !missing.includes("layerId")) {
      missing.push("layerId");
      changed = true;
    }
    if (!changed) return step;
    reopened = true;
    return { ...step, args, missing };
  });
  if (!reopened) return null;
  return {
    conversationId: plan.conversationId,
    sourceText: plan.sourceText,
    steps,
    ...(plan.requiresConfirm === true ? { requiresConfirm: true } : {}),
  };
}

function oneStep(part: NormalizedInstruction, index: number, text: string, selected: ResolveChatPlanInput["selectedLayer"]): PendingPlanStep | null {
  const picked = index === 0 ? selectedFillName(text, part, selected) : undefined;
  const first = part.layers[0] ?? picked;
  const second = part.layers[1];
  const knowledge = (args: Record<string, string | number | boolean>) => args;
  if (part.intent === "buffer") {
    const args: Record<string, string | number | boolean> = knowledge({});
    const missing: string[] = [];
    if (part.distance) {
      args.distance = part.distance.distance;
      args.unit = part.distance.unit;
    } else missing.push("distance");
    if (index > 0) return stepOf("map.buffer", args, missing, "layerId");
    const bufferLayer = bufferLayerArg(first, picked, selected);
    if (bufferLayer) args.layerId = bufferLayer;
    else missing.push("layerId");
    return stepOf("map.buffer", args, missing);
  }
  if (part.intent === "intersect" || part.intent === "clip" || part.intent === "separate") {
    const tool = part.intent === "intersect" ? "map.intersect" : "map.clip";
    const args: Record<string, string | number | boolean> = knowledge({});
    const missing: string[] = [];
    if (index > 0) {
      if (first) args.otherLayerId = first;
      else if (second) args.otherLayerId = second;
      else missing.push("otherLayerId");
      return stepOf(tool, args, missing, "layerId");
    }
    if (first) args.layerId = first;
    else missing.push("layerId");
    if (second) args.otherLayerId = second;
    else missing.push("otherLayerId");
    return stepOf(tool, args, missing);
  }
  if (part.intent === "analyze") {
    return stepOf("map.stats", first ? { layerId: first } : {}, first ? [] : ["layerId"]);
  }
  if (part.intent === "hide" || part.intent === "show") {
    const visible = part.intent === "show";
    return stepOf("map.setVisibility", first ? { layerId: first, visible } : { visible }, first ? [] : ["layerId"]);
  }
  if (part.intent === "delete") {
    return stepOf("map.delete", first ? { layerId: first } : {}, first ? [] : ["layerId"]);
  }
  return null;
}

function sequencePlan(
  conversationId: string,
  text: string,
  known: readonly KnownMockLayer[],
  selected: ResolveChatPlanInput["selectedLayer"],
  lastCreatedLayerId: string | null,
): PendingPlan | null {
  const clauses = parseSequenceClauses(text);
  if (!clauses) return null;
  const steps: PendingPlanStep[] = [];
  for (let index = 0; index < clauses.length; index += 1) {
    const clause = clauses[index] ?? "";
    const part = normalizeInstruction(clause, known, { lastCreatedLayerId: index === 0 ? lastCreatedLayerId : null });
    if (!part || part.intent === "buffer-intersect" || part.intent === "buffer-clip" || part.intent === "clear-all" || part.intent === "drop-database") {
      return null;
    }
    const step = oneStep(part, index, index === 0 ? text : clause, selected);
    if (!step) return null;
    steps.push(step);
  }
  if (steps.length < 2) return null;
  return { conversationId, sourceText: text, steps };
}

function buildNormalizedPlan(
  conversationId: string,
  text: string,
  normalized: NormalizedInstruction,
  selected: ResolveChatPlanInput["selectedLayer"],
  known: readonly KnownMockLayer[],
  lastCreatedLayerId: string | null,
): PendingPlan | null {
  const sequenced = sequencePlan(conversationId, text, known, selected, lastCreatedLayerId);
  if (sequenced) return sequenced;
  const explicit = normalized.layers;
  const picked = selectedFillName(text, normalized, selected);
  const first = explicit[0] ?? picked;
  const second = explicit[1];
  const optionalKnowledge = (args: Record<string, string | number | boolean>) => args;
  const knowledge = (args: Record<string, string | number | boolean>) => args;
  const steps: PendingPlanStep[] = [];
  if (normalized.intent === "clear-all") {
    return { conversationId, sourceText: text, steps: [stepOf("map.clearAll", {}, [])] };
  }
  if (normalized.intent === "drop-database") {
    return { conversationId, sourceText: text, steps: [stepOf("map.dropDatabase", {}, [])] };
  }
  if (normalized.intent === "hide" || normalized.intent === "show") {
    const visible = normalized.intent === "show";
    return {
      conversationId,
      sourceText: text,
      steps: [stepOf("map.setVisibility", first ? { layerId: first, visible } : { visible }, first ? [] : ["layerId"])],
    };
  }
  if (normalized.intent === "delete") {
    const names = explicit.length > 0 ? explicit : picked ? [picked] : [];
    if (names.length === 0) steps.push(stepOf("map.delete", {}, ["layerId"]));
    else for (const name of names) steps.push(stepOf("map.delete", { layerId: name }, []));
    return { conversationId, sourceText: text, steps };
  }
  if (normalized.intent === "analyze") {
    steps.push(stepOf("gdl.describe", first ? { layerName: first } : {}, first ? [] : ["layerName"]));
    steps.push(stepOf("map.stats", first ? optionalKnowledge({ layerId: first }) : {}, first ? [] : ["layerId"]));
    return { conversationId, sourceText: text, steps };
  }
  if (normalized.intent === "separate") {
    const args: Record<string, string | number | boolean> = {};
    const missing: string[] = [];
    if (first) args.layerId = first;
    else missing.push("layerId");
    if (second) args.otherLayerId = second;
    else missing.push("otherLayerId");
    steps.push(stepOf("map.clip", knowledge(args), missing));
    return { conversationId, sourceText: text, steps };
  }
  const dist = normalized.distance;
  const wantsBuffer = normalized.intent === "buffer" || normalized.intent === "buffer-intersect" || normalized.intent === "buffer-clip";
  const wantsClip = normalized.intent === "clip" || normalized.intent === "buffer-clip";
  const wantsIntersect = normalized.intent === "intersect" || normalized.intent === "buffer-intersect";
  if (wantsBuffer) {
    const args: Record<string, string | number | boolean> = knowledge({});
    const missing: string[] = [];
    if (dist) {
      args.distance = dist.distance;
      args.unit = dist.unit;
    } else missing.push("distance");
    const bufferLayer = bufferLayerArg(first, picked, selected);
    if (bufferLayer) args.layerId = bufferLayer;
    else missing.push("layerId");
    steps.push(stepOf("map.buffer", args, missing));
  }
  if (wantsClip) {
    const args: Record<string, string | number | boolean> = knowledge({});
    const missing: string[] = [];
    if (wantsBuffer) {
      if (second) args.otherLayerId = second;
      else missing.push("otherLayerId");
      steps.push(stepOf("map.clip", args, missing, "layerId"));
    } else {
      const usedAsMask = /用/.test(text);
      const target = usedAsMask ? second : first;
      const mask = usedAsMask ? first : second;
      if (target) args.layerId = target;
      else missing.push("layerId");
      if (mask) args.otherLayerId = mask;
      else missing.push("otherLayerId");
      steps.push(stepOf("map.clip", args, missing));
    }
  } else if (wantsIntersect) {
    const args: Record<string, string | number | boolean> = knowledge({});
    const missing: string[] = [];
    if (wantsBuffer) {
      if (second) args.otherLayerId = second;
      else missing.push("otherLayerId");
      steps.push(stepOf("map.intersect", args, missing, "layerId"));
    } else {
      if (first) args.layerId = first;
      else missing.push("layerId");
      if (second) args.otherLayerId = second;
      else missing.push("otherLayerId");
      steps.push(stepOf("map.intersect", args, missing));
    }
  }
  if (steps.length === 0) return null;
  return { conversationId, sourceText: text, steps };
}

export function draftPendingPlan(
  conversationId: string,
  text: string,
  selected: ResolveChatPlanInput["selectedLayer"],
  known: readonly KnownMockLayer[] = [],
  lastCreatedLayerId: string | null = null,
): PendingPlan | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const normalized = normalizeInstruction(trimmed, known, { lastCreatedLayerId });
  if (!normalized) return null;
  return buildNormalizedPlan(conversationId, trimmed, normalized, selected, known, lastCreatedLayerId);
}

export function fillPendingPlan(plan: PendingPlan, names: readonly string[]): PendingPlan {
  const remaining = names.filter((name) => name.trim() !== "");
  const steps = plan.steps.map((step) => {
    const args: Record<string, string | number | boolean> = { ...step.args };
    const missing: string[] = [];
    for (const slot of step.missing) {
      const next = remaining.shift();
      if (next) args[slot] = next;
      else missing.push(slot);
    }
    return { ...step, args, missing };
  });
  return { ...plan, steps };
}

export function plannedCallsFrom(plan: PendingPlan): readonly PlannedGisCall[] {
  return plan.steps.map((step) => {
    const args: Record<string, string | number | boolean> = { ...step.args };
    if (step.bindPrevTo && (args[step.bindPrevTo] === undefined || args[step.bindPrevTo] === "")) {
      args[step.bindPrevTo] = "__prev__";
    }
    return { name: step.tool, args };
  });
}

interface OperandSlot {
  readonly index: number;
  readonly key: "layerId" | "otherLayerId" | "layerName";
}

function operandSlots(plan: PendingPlan): OperandSlot[] {
  if (isAnalyzePlan(plan)) return [{ index: 0, key: "layerName" }];
  const slots: OperandSlot[] = [];
  plan.steps.forEach((step, index) => {
    const bindsLayer = step.bindPrevTo === "layerId";
    if (!bindsLayer && (Object.prototype.hasOwnProperty.call(step.args, "layerId") || step.missing.includes("layerId"))) {
      slots.push({ index, key: "layerId" });
    }
    if (Object.prototype.hasOwnProperty.call(step.args, "otherLayerId") || step.missing.includes("otherLayerId")) {
      slots.push({ index, key: "otherLayerId" });
    }
    if (step.tool === "gdl.describe" && (Object.prototype.hasOwnProperty.call(step.args, "layerName") || step.missing.includes("layerName"))) {
      slots.push({ index, key: "layerName" });
    }
  });
  return slots;
}

const LAYER_SLOT_KEYS = ["layerId", "otherLayerId", "layerName"] as const;

function filledLayerSlots(plan: PendingPlan): string[] {
  const names: string[] = [];
  for (const step of plan.steps) {
    for (const key of LAYER_SLOT_KEYS) {
      const value = step.args[key];
      if (typeof value === "string" && value.trim() !== "" && value !== "__prev__") names.push(value);
    }
  }
  return names;
}

function isKnownLayer(
  name: string,
  known: readonly KnownMockLayer[],
  selected: ResolveChatPlanInput["selectedLayer"],
): boolean {
  if (selected && (name === selected.layerId || name === selected.layerName)) return true;
  return known.some((layer) => layer.layerId === name || layer.layerName === name);
}

/** 补上来的名字按槽位绑定。名字够槽位时覆盖先前用选中图层填上的值。 */
function assignOperandNames(plan: PendingPlan, names: readonly string[]): PendingPlan {
  if (isAnalyzePlan(plan)) {
    const name = names[0];
    if (!name) return plan;
    return {
      ...plan,
      steps: plan.steps.map((step) => (
        step.tool === "gdl.describe"
          ? { ...step, args: { ...step.args, layerName: name }, missing: [] }
          : { ...step, args: { ...step.args, layerId: name }, missing: [] }
      )),
    };
  }
  const slots = operandSlots(plan);
  const steps = plan.steps.map((step) => ({ ...step, args: { ...step.args }, missing: [...step.missing] }));
  slots.forEach((slot, slotIndex) => {
    const name = names[slotIndex];
    const step = steps[slot.index];
    if (!name || !step) return;
    const args = { ...step.args, [slot.key]: name };
    const missing = step.missing.filter((item) => item !== slot.key);
    steps[slot.index] = { ...step, args, missing };
  });
  return { ...plan, steps };
}

/**
 * 本地解析是加速器。槽位齐了才执行；危险操作先确认。
 * 解析失败、意图含糊、或上一次追问没有补上槽位时，返回 kind:"model"。
 * 调用方必须把这种情况交给云端模型，不能当成错误停住。见 LOCAL_DISPATCH_POLICY。
 */
/** 给用户看的判断。不引用原句里的坐标。 */
export function dispatchJudgment(text: string, kind: ChatPlanResolution["kind"]): string {
  const parts: string[] = [];
  if (/这张图|这张地图/.test(text)) parts.push("「这张图」指当前选中的图层。");
  if (kind === "model") parts.push("这句话不在本地执行，原文交给模型。没有写出的距离不会填成 200 米。");
  else if (kind === "execute") parts.push("参数已经齐，在本地执行。");
  else if (kind === "clarify") parts.push("还缺参数，先问一句，不执行。");
  else if (kind === "confirm") parts.push("这一步需要确认后才会执行。");
  else parts.push("按这句话直接回复。");
  return parts.join("");
}

export function resolveChatPlan(input: ResolveChatPlanInput): ChatPlanResolution {
  const text = input.text.trim();
  const known = input.knownLayers ?? [];
  const lastCreatedLayerId = input.lastCreatedLayerId ?? null;
  if (input.confirm === true && input.pending?.requiresConfirm && planIsComplete(input.pending)) {
    return finishComplete(input.pending, true);
  }
  if (input.pending && !planIsComplete(input.pending)) {
    const names = explicitLayerTokens(text, known);
    const slots = operandSlots(input.pending).length;
    const filled = names.length > 0 && names.length >= slots && slots > 0
      ? assignOperandNames(input.pending, names)
      : names.length > 0
        ? fillPendingPlan(input.pending, names)
        : input.pending;
    const filledNow = missingSlots(filled).length < missingSlots(input.pending).length || planIsComplete(filled);
    if (!filledNow || !planIsComplete(filled)) {
      return modelResolution(
        text,
        known,
        input.pending,
        formatParseTrace(intentLabels(input.pending), missingSlots(input.pending), "model"),
      );
    }
    const bad = filledLayerSlots(filled).filter((name) => !isKnownLayer(name, known, input.selectedLayer));
    if (bad.length > 0) {
      return modelResolution(text, known, input.pending, formatParseTrace(intentLabels(input.pending), missingSlots(input.pending), "model"));
    }
    // 确认只对已要求确认的完整计划生效（见上方 confirm 分支）。补齐槽位这条路径不接受 confirm 授权。
    return finishComplete(filled, false);
  }
  const drafted = draftPendingPlan(input.conversationId, text, input.selectedLayer, known, lastCreatedLayerId);
  if (drafted) {
    const bad = filledLayerSlots(drafted).filter((name) => !isKnownLayer(name, known, input.selectedLayer));
    if (bad.length > 0) {
      return modelResolution(text, known, null, formatParseTrace(intentLabels(drafted), missingSlots(drafted), "model"));
    }
    // 新起草的计划不接受 confirm 授权：破坏性计划必须先问一次用户确认。
    if (planIsComplete(drafted)) return finishComplete(drafted, false);
    const labels = intentLabels(drafted);
    return {
      kind: "clarify",
      text: clarifyPendingPlan(drafted),
      pending: drafted,
      parseTrace: formatParseTrace(labels, missingSlots(drafted), "wait"),
    };
  }
  return modelResolution(text, known, null, formatParseTrace(collectPartialEntities(text, known).intentFragments, [], "model"));
}

function resultLayerName(result: Readonly<Record<string, unknown>>): string {
  if (typeof result.layerName === "string" && result.layerName.trim() !== "") return result.layerName;
  if (typeof result.layerId === "string" && result.layerId.trim() !== "") return result.layerId;
  return "";
}

function completedLayerText(traces: readonly ToolTrace[]): string {
  const parts: string[] = [];
  for (const item of traces) {
    if (item.stepStatus !== "succeeded") continue;
    if (typeof item.layerId !== "string" || item.layerId === "") continue;
    const name = typeof item.layerName === "string" && item.layerName !== "" ? item.layerName : item.layerId;
    parts.push(`${name}（${item.layerId}）`);
  }
  return parts.length > 0 ? `已完成的图层：${parts.join("、")}。` : "";
}

function notRunTrace(tool: string, args: Readonly<Record<string, ScalarArg>>): ToolTrace {
  return {
    tool,
    args,
    ok: false,
    stepStatus: "not-run",
    message: "这一步没有执行。",
  };
}

export async function executePlannedCalls(
  calls: readonly PlannedGisCall[],
  adapter: ToolAdapterPort,
  tools: readonly GisToolDefinition[] = GIS_TOOL_REGISTRY,
  onProgress?: ChatProgressHandler,
): Promise<ToolLoopResult> {
  const executed: ScheduledToolCall[] = [];
  const traces: ToolTrace[] = [];
  let previous = "";
  const seen = new Set<string>();
  if (calls.length > 0) {
    onProgress?.({ type: "thought", kind: "status", code: "running_tools" });
  }
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index];
    if (!call) continue;
    const raw: Record<string, string | number | boolean> = { ...call.args };
    for (const key of Object.keys(raw)) {
      if (raw[key] === "__prev__") raw[key] = previous;
    }
    const confirmedByRuntime = raw.confirm === true;
    delete raw.confirm;
    const scheduled = normalizeToolArguments(call.name, raw, tools);
    const signature = `${scheduled.tool}::${JSON.stringify(scheduled.args)}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    const authorized: ScheduledToolCall = {
      tool: scheduled.tool,
      args: scheduled.args,
      provenance: {
        source: "local-parser",
        aiOrigin: false,
        translationUsed: false,
        requestSource: "internal",
      },
      ...(confirmedByRuntime ? { userConfirmed: true as const } : {}),
    };
    const rawResult = await adapter.execute(authorized);
    const result = isRecord(rawResult) ? rawResult : { ok: false, message: "适配器必须返回对象。" };
    executed.push(scheduled);
    const trace = toolTraceFromResult(scheduled.tool, scheduled.args, result);
    traces.push(trace);
    onProgress?.(progressToolEvent(trace));
    if (trace.ok) {
      const next = resultLayerName(result);
      if (next !== "") previous = next;
      continue;
    }
    for (let rest = index + 1; rest < calls.length; rest += 1) {
      const later = calls[rest];
      if (!later) continue;
      const laterArgs: Record<string, ScalarArg> = { ...later.args };
      for (const key of Object.keys(laterArgs)) {
        if (laterArgs[key] === "__prev__") laterArgs[key] = previous;
      }
      traces.push(notRunTrace(later.name, laterArgs));
    }
    return completeToolLoop(1, executed, traces, `${completedLayerText(traces)}${trace.message}`, "step-failed");
  }
  const ran = traces.filter((item) => item.stepStatus === "succeeded");
  const apis = ran.map((item) => toApiToolName(item.tool)).join("、");
  const layers = ran.filter((item) => item.layerName).map((item) => item.layerName as string);
  const analyzeOnly = ran.length > 0 && ran.every((item) => item.tool === "gdl.describe" || item.tool === "map.stats");
  const finalText = analyzeOnly
    ? ran.map((item) => item.message).join(" ")
    : layers.length > 0
      ? `已按计划完成 ${apis}，结果图层：${layers.join("、")}。`
      : `已按计划完成 ${apis}。`;
  return completeToolLoop(1, executed, traces, finalText, "completed");
}

export function parsePendingPlan(value: unknown): PendingPlan | null {
  if (!isRecord(value) || typeof value.conversationId !== "string" || typeof value.sourceText !== "string") return null;
  if (!Array.isArray(value.steps)) return null;
  const steps: PendingPlanStep[] = [];
  for (const item of value.steps) {
    if (!isRecord(item) || typeof item.tool !== "string" || typeof item.apiName !== "string") return null;
    if (!isRecord(item.args)) return null;
    const args: Record<string, string | number | boolean> = {};
    for (const [key, raw] of Object.entries(item.args)) {
      if (!isScalar(raw)) return null;
      // 授权契约：AI 意图/计划里不得携带授权字段——对话文件也不能自带授权。
      if (AUTHORIZATION_FORBIDDEN_INTENT_FIELDS.includes(key)) continue;
      args[key] = raw;
    }
    const missing = Array.isArray(item.missing)
      ? item.missing.filter((slot): slot is string => typeof slot === "string")
      : [];
    const bindPrevTo = typeof item.bindPrevTo === "string" ? item.bindPrevTo : undefined;
    steps.push({
      tool: item.tool.slice(0, 80),
      apiName: item.apiName.slice(0, 80),
      args,
      missing,
      ...(bindPrevTo ? { bindPrevTo: bindPrevTo.slice(0, 40) } : {}),
    });
  }
  return {
    conversationId: value.conversationId.slice(0, 80),
    sourceText: value.sourceText.slice(0, 2000),
    steps,
    ...(value.requiresConfirm === true ? { requiresConfirm: true } : {}),
  };
}

export function shouldUsePendingPlan(text: string, pending: PendingPlan | null): boolean {
  return pending !== null && looksLikeLayerNameSupplement(text);
}

export function isPendingGisInstruction(text: string): boolean {
  return looksLikeGisInstruction(text);
}
