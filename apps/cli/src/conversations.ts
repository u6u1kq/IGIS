// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parsePendingPlan } from "@igis/llm-dispatch";
import type { PendingPlan, StepStatus, TurnStatus } from "@igis/llm-dispatch";

export interface ChatTrace {
  readonly tool: string;
  readonly message: string;
  readonly ok: boolean;
  readonly layerId?: string;
  readonly layerName?: string;
  readonly code?: string;
  readonly action?: string;
  readonly durationMs?: number;
  /** 这次 GIS 操作的身份。旧消息没有这个字段，回退仍看 createdLayerIds。 */
  readonly operationId?: string;
  /** 这次工具结果里已写出的审计 id。没有这个字段不表示审计已成功。 */
  readonly auditRecordId?: string;
  /** 工具结果标明 audit.append 失败时为 true。 */
  readonly auditAppendFailed?: true;
  /** 这一步自己的结果。没有这个字段的旧消息仍只看 ok。 */
  readonly stepStatus?: StepStatus;
}

export interface ChatMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly at: string;
  readonly traces?: readonly ChatTrace[];
  readonly resultLayers?: readonly { readonly layerId: string; readonly layerName: string }[];
  readonly createdLayerIds?: readonly string[];
  readonly thought?: string;
  readonly thoughtKind?: "reasoning" | "status";
  readonly parseTrace?: string;
  readonly ragEntryIds?: readonly string[];
  readonly auditRecordIds?: readonly string[];
  /** 这一轮里各次 GIS 调用自己的 operationId。没有父操作。旧消息没有这个字段。 */
  readonly operationIds?: readonly string[];
  /** 整轮状态。和 traces 里每一步的 stepStatus 分开。 */
  readonly turnStatus?: TurnStatus;
}

export interface ConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly messageCount: number;
  readonly outboundMode?: "full" | "pronoun";
}

/** 一轮回退还没做完时留在对话文件里。重试只删这里剩下的 id。 */
export interface PendingTurnRollback {
  readonly createdLayerIds: readonly string[];
  readonly ragEntryIds: readonly string[];
  readonly auditRecordIds: readonly string[];
  readonly operationIds: readonly string[];
  /** `${index}:${role}:${at}`，提交时只去掉这些消息。 */
  readonly messageKeys: readonly string[];
}

export interface PreparedTurnRollback {
  readonly createdLayerIds: readonly string[];
  readonly ragEntryIds: readonly string[];
  readonly auditRecordIds: readonly string[];
  readonly operationIds: readonly string[];
  readonly resumed: boolean;
}

export interface ConversationCheckpoint {
  readonly id: string;
  readonly messageCount: number;
  readonly replayText: string;
  readonly createdAt: string;
  readonly pendingPlan?: PendingPlan | null;
  readonly lastCreatedLayerId?: string | null;
}

export interface ConversationRecord {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: readonly ChatMessage[];
  readonly pendingPlan?: PendingPlan | null;
  /** 本对话最近一次工具新建的图层标识。供「它」指代。 */
  readonly lastCreatedLayerId?: string | null;
  /** 已记下、尚未全部删除的这一轮。消息在提交前保持原样。 */
  readonly pendingRollback?: PendingTurnRollback;
  readonly workspaceLayerIds?: readonly string[];
  /** 这个对话是否把坐标和路径发给云端模型。pronoun 表示收成「这些点」「当前图层」后仍然发送。 */
  readonly outboundMode?: "full" | "pronoun";
  /** 上一轮原样发给模型的工具结果。只在 outboundMode 为 full 时继续附上。 */
  readonly toolCarry?: string;
  readonly workspaceFileNames?: readonly string[];
  readonly checkpoints?: readonly ConversationCheckpoint[];
}

export interface ConversationIndex {
  readonly activeId: string;
  readonly conversations: readonly ConversationSummary[];
}

const TITLE_LIMIT = 40;
const ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const MESSAGE_KEY_PATTERN = /^\d+:(user|assistant):.+$/;
const MAX_CHECKPOINTS = 32;

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => ID_PATTERN.test(id)))];
}

function turnMessageKey(index: number, message: ChatMessage): string {
  return `${index}:${message.role}:${message.at}`;
}

function selectLastTurn(messages: readonly ChatMessage[]): { readonly start: number; readonly end: number } | null {
  let lastAssistant = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      lastAssistant = index;
      break;
    }
  }
  if (lastAssistant < 0) return null;
  let start = lastAssistant;
  if (lastAssistant > 0 && messages[lastAssistant - 1]?.role === "user") start = lastAssistant - 1;
  return { start, end: lastAssistant + 1 };
}

function layerIdsOfTurn(messages: readonly ChatMessage[]): string[] {
  return uniqueIds(messages.flatMap((item) => item.createdLayerIds ?? item.resultLayers?.map((layer) => layer.layerId) ?? []));
}

/**
 * 删除清单只收成功路径上的审计。
 * 轨迹标明失败的 id 即使已被放进 auditRecordIds，也不删除。
 * 对不上失败轨迹的 id 仍视为 039 之前收集的成功审计。
 */
function successAuditIdsForRollback(messages: readonly ChatMessage[]): string[] {
  const failureIds = new Set<string>();
  for (const message of messages) {
    for (const trace of message.traces ?? []) {
      if (typeof trace.auditRecordId !== "string" || trace.auditRecordId === "") continue;
      if (trace.ok === false || trace.auditAppendFailed === true) failureIds.add(trace.auditRecordId);
    }
  }
  return uniqueIds(messages.flatMap((item) => item.auditRecordIds ?? []).filter((id) => !failureIds.has(id)));
}

function operationIdsOfTurn(messages: readonly ChatMessage[]): string[] {
  const listed = messages.flatMap((item) => item.operationIds ?? []);
  const traced = messages.flatMap((item) => (item.traces ?? []).flatMap((trace) => (trace.operationId ? [trace.operationId] : [])));
  return uniqueIds([...listed, ...traced]);
}

function readIdList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !ID_PATTERN.test(item)) return null;
    ids.push(item);
  }
  return [...new Set(ids)];
}

function readPendingRollback(value: unknown): PendingTurnRollback | null {
  if (!isRecord(value)) return null;
  const createdLayerIds = readIdList(value.createdLayerIds);
  const ragEntryIds = readIdList(value.ragEntryIds);
  const auditRecordIds = readIdList(value.auditRecordIds);
  const operationIds = value.operationIds === undefined ? [] : readIdList(value.operationIds);
  if (!createdLayerIds || !ragEntryIds || !auditRecordIds || !operationIds) return null;
  if (!Array.isArray(value.messageKeys) || value.messageKeys.length === 0) return null;
  const messageKeys: string[] = [];
  for (const key of value.messageKeys) {
    if (typeof key !== "string" || !MESSAGE_KEY_PATTERN.test(key)) return null;
    messageKeys.push(key);
  }
  return { createdLayerIds, ragEntryIds, auditRecordIds, operationIds, messageKeys };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeText(value: string): string {
  return value.replace(/\u0000/g, "").trim();
}

function nextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(16)}-${Math.floor(Math.random() * 1000)}`;
}

function summaryOf(record: ConversationRecord): ConversationSummary {
  return {
    id: record.id,
    title: record.title,
    updatedAt: record.updatedAt,
    messageCount: record.messages.length,
    ...(record.outboundMode ? { outboundMode: record.outboundMode } : {}),
  };
}

function readTrace(value: unknown): ChatTrace | null {
  if (!isRecord(value) || typeof value.tool !== "string" || typeof value.message !== "string") return null;
  const trace: ChatTrace = {
    tool: safeText(value.tool).slice(0, 80),
    message: safeText(value.message).slice(0, 500),
    ok: value.ok !== false,
  };
  const extra: {
    layerId?: string;
    layerName?: string;
    code?: string;
    action?: string;
    operationId?: string;
    auditRecordId?: string;
    auditAppendFailed?: true;
    stepStatus?: StepStatus;
  } = {};
  if (typeof value.layerId === "string" && /^[A-Za-z0-9._-]+$/.test(value.layerId)) extra.layerId = value.layerId;
  if (typeof value.layerName === "string") extra.layerName = safeText(value.layerName).slice(0, 80);
  if (typeof value.code === "string") extra.code = safeText(value.code).slice(0, 80);
  if (typeof value.action === "string") extra.action = safeText(value.action).slice(0, 80);
  if (typeof value.operationId === "string" && /^op-[a-z0-9]+-[a-z0-9]+$/.test(value.operationId)) extra.operationId = value.operationId;
  if (typeof value.auditRecordId === "string" && /^[A-Za-z0-9._-]+$/.test(value.auditRecordId)) extra.auditRecordId = value.auditRecordId;
  if (value.auditAppendFailed === true) extra.auditAppendFailed = true;
  if (value.stepStatus === "succeeded" || value.stepStatus === "failed" || value.stepStatus === "not-run") extra.stepStatus = value.stepStatus;
  if (typeof value.durationMs === "number" && Number.isFinite(value.durationMs) && value.durationMs >= 0) {
    return { ...trace, ...extra, durationMs: Math.round(value.durationMs) };
  }
  return { ...trace, ...extra };
}

function readMessage(value: unknown): ChatMessage | null {
  if (!isRecord(value) || (value.role !== "user" && value.role !== "assistant") || typeof value.text !== "string") return null;
  const traces = Array.isArray(value.traces) ? value.traces.map(readTrace).filter((item): item is ChatTrace => item !== null) : [];
  const resultLayers = Array.isArray(value.resultLayers)
    ? value.resultLayers.flatMap((item) => {
        if (!isRecord(item) || typeof item.layerId !== "string" || typeof item.layerName !== "string") return [];
        if (!/^[A-Za-z0-9._-]+$/.test(item.layerId)) return [];
        return [{ layerId: item.layerId, layerName: safeText(item.layerName).slice(0, 80) }];
      })
    : [];
  const createdLayerIds = Array.isArray(value.createdLayerIds)
    ? value.createdLayerIds.filter((item): item is string => typeof item === "string" && /^[A-Za-z0-9._-]+$/.test(item))
    : resultLayers.map((item) => item.layerId);
  const message: ChatMessage = {
    role: value.role,
    text: safeText(value.text).slice(0, 20_000),
    at: typeof value.at === "string" && !Number.isNaN(Date.parse(value.at)) ? value.at : new Date().toISOString(),
  };
  const thought = typeof value.thought === "string" ? safeText(value.thought).slice(0, 4000) : "";
  const thoughtKind = value.thoughtKind === "reasoning" || value.thoughtKind === "status" ? value.thoughtKind : undefined;
  const parseTrace = typeof value.parseTrace === "string" ? safeText(value.parseTrace).slice(0, 500) : "";
  const ragEntryIds = Array.isArray(value.ragEntryIds)
    ? value.ragEntryIds.filter((item): item is string => typeof item === "string" && /^[A-Za-z0-9._-]+$/.test(item))
    : [];
  const auditRecordIds = Array.isArray(value.auditRecordIds)
    ? value.auditRecordIds.filter((item): item is string => typeof item === "string" && /^[A-Za-z0-9._-]+$/.test(item))
    : [];
  const operationIds = Array.isArray(value.operationIds)
    ? value.operationIds.filter((item): item is string => typeof item === "string" && /^op-[a-z0-9]+-[a-z0-9]+$/.test(item))
    : [];
  const turnStatus = value.turnStatus === "succeeded" || value.turnStatus === "partial" || value.turnStatus === "failed" || value.turnStatus === "max-rounds"
    ? value.turnStatus
    : undefined;
  return {
    ...message,
    ...(traces.length > 0 ? { traces } : {}),
    ...(resultLayers.length > 0 ? { resultLayers } : {}),
    ...(createdLayerIds.length > 0 ? { createdLayerIds } : {}),
    ...(thought !== "" ? { thought } : {}),
    ...(thoughtKind ? { thoughtKind } : {}),
    ...(parseTrace !== "" ? { parseTrace } : {}),
    ...(ragEntryIds.length > 0 ? { ragEntryIds } : {}),
    ...(auditRecordIds.length > 0 ? { auditRecordIds } : {}),
    ...(operationIds.length > 0 ? { operationIds } : {}),
    ...(turnStatus ? { turnStatus } : {}),
  };
}

export function assistantChatMessage(input: {
  readonly text: string;
  readonly at: string;
  readonly traces?: readonly ChatTrace[];
  readonly resultLayers?: readonly { readonly layerId: string; readonly layerName: string }[];
  readonly createdLayerIds?: readonly string[];
  readonly thought?: string;
  readonly thoughtKind?: "reasoning" | "status";
  readonly parseTrace?: string;
  readonly ragEntryIds?: readonly string[];
  readonly auditRecordIds?: readonly string[];
  readonly operationIds?: readonly string[];
  readonly turnStatus?: TurnStatus;
}): ChatMessage {
  return {
    role: "assistant",
    text: input.text,
    at: input.at,
    ...(input.traces && input.traces.length > 0 ? { traces: input.traces } : {}),
    ...(input.resultLayers && input.resultLayers.length > 0 ? { resultLayers: input.resultLayers } : {}),
    ...(input.createdLayerIds && input.createdLayerIds.length > 0 ? { createdLayerIds: input.createdLayerIds } : {}),
    ...(input.thought && input.thought !== "" ? { thought: input.thought } : {}),
    ...(input.thoughtKind ? { thoughtKind: input.thoughtKind } : {}),
    ...(input.parseTrace && input.parseTrace !== "" ? { parseTrace: input.parseTrace } : {}),
    ...(input.ragEntryIds && input.ragEntryIds.length > 0 ? { ragEntryIds: input.ragEntryIds } : {}),
    ...(input.auditRecordIds && input.auditRecordIds.length > 0 ? { auditRecordIds: input.auditRecordIds } : {}),
    ...(input.operationIds && input.operationIds.length > 0 ? { operationIds: input.operationIds } : {}),
    ...(input.turnStatus ? { turnStatus: input.turnStatus } : {}),
  };
}

function titleFromMessages(messages: readonly ChatMessage[], fallback: string): string {
  const first = messages.find((item) => item.role === "user" && item.text.trim() !== "");
  if (!first) return fallback;
  const text = first.text.replace(/\s+/g, " ").trim();
  return text.length <= TITLE_LIMIT ? text : `${text.slice(0, TITLE_LIMIT)}…`;
}

function emptyRecord(title: string): ConversationRecord {
  const now = new Date().toISOString();
  return { id: nextId("conv"), title, createdAt: now, updatedAt: now, messages: [] };
}

/** 对话列表。只存文字和工具轨迹摘要，不存几何。目录在 var/conversations。 */
export class ConversationStore {
  private readonly directory: string;
  private readonly legacyMessagesPath: string;
  private activeId = "";
  private readonly records = new Map<string, ConversationRecord>();

  constructor(directory: string, legacyMessagesPath: string) {
    this.directory = directory;
    this.legacyMessagesPath = legacyMessagesPath;
  }

  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    let names: string[] = [];
    try {
      names = await readdir(this.directory);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!name.endsWith(".json") || name === "index.json") continue;
      try {
        const parsed = JSON.parse(await readFile(join(this.directory, name), { encoding: "utf8" })) as unknown;
        const record = this.readRecord(parsed);
        if (record) this.records.set(record.id, record);
      } catch {
        // 坏文件跳过。
      }
    }
    const index = await this.readIndexFile();
    if (this.records.size === 0) {
      const migrated = await this.migrateLegacy();
      const created = migrated ?? emptyRecord("新对话");
      this.records.set(created.id, created);
      this.activeId = created.id;
      await this.persist(created);
      await this.writeIndex();
      return;
    }
    this.activeId = index && this.records.has(index) ? index : [...this.records.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.id ?? "";
    if (this.activeId === "") {
      const created = emptyRecord("新对话");
      this.records.set(created.id, created);
      this.activeId = created.id;
      await this.persist(created);
    }
    await this.writeIndex();
  }

  list(): ConversationIndex {
    const conversations = [...this.records.values()]
      .map(summaryOf)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return { activeId: this.activeId, conversations };
  }

  active(): ConversationRecord {
    const current = this.records.get(this.activeId);
    if (current) return current;
    throw new Error("没有活动对话。");
  }

  messages(): readonly ChatMessage[] {
    return this.active().messages;
  }

  pendingPlan(): PendingPlan | null {
    return this.active().pendingPlan ?? null;
  }

  lastCreatedLayerId(): string | null {
    return this.active().lastCreatedLayerId ?? null;
  }

  record(id: string): ConversationRecord | null {
    return this.records.get(id) ?? null;
  }

  async createCheckpointFor(id: string, replayText: string): Promise<ConversationCheckpoint> {
    const current = this.records.get(id);
    if (!current) throw new Error("找不到这个对话。");
    const checkpoint: ConversationCheckpoint = {
      id: nextId("checkpoint"),
      messageCount: current.messages.length,
      replayText: safeText(replayText).slice(0, 20_000),
      createdAt: new Date().toISOString(),
      pendingPlan: current.pendingPlan ?? null,
      lastCreatedLayerId: current.lastCreatedLayerId ?? null,
    };
    const checkpoints = [...(current.checkpoints ?? []), checkpoint].slice(-MAX_CHECKPOINTS);
    const next = { ...current, checkpoints, updatedAt: checkpoint.createdAt };
    this.records.set(id, next);
    await this.persist(next);
    await this.writeIndex();
    return checkpoint;
  }

  checkpointsFor(id: string): readonly ConversationCheckpoint[] {
    return this.records.get(id)?.checkpoints ?? [];
  }

  async restoreCheckpointState(id: string, checkpointId: string): Promise<void> {
    const current = this.records.get(id);
    const checkpoint = current?.checkpoints?.find((item) => item.id === checkpointId);
    if (!current || !checkpoint) throw new Error("找不到这个检查点。");
    const next: ConversationRecord = {
      ...current,
      pendingPlan: checkpoint.pendingPlan ?? null,
      lastCreatedLayerId: checkpoint.lastCreatedLayerId ?? null,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(id, next);
    await this.persist(next);
    await this.writeIndex();
  }

  async setPendingPlan(plan: PendingPlan | null): Promise<ConversationRecord> {
    return this.setPendingPlanFor(this.active().id, plan);
  }

  async setPendingPlanFor(id: string, plan: PendingPlan | null): Promise<ConversationRecord> {
    const current = this.records.get(id);
    if (!current) throw new Error("找不到这个对话。");
    const next: ConversationRecord = {
      ...current,
      pendingPlan: plan,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(current.id, next);
    await this.persist(next);
    await this.writeIndex();
    return next;
  }

  async setOutboundModeFor(id: string, mode: "full" | "pronoun"): Promise<void> {
    const current = this.records.get(id);
    if (!current || current.outboundMode === mode) return;
    const next: ConversationRecord = { ...current, outboundMode: mode, updatedAt: new Date().toISOString() };
    this.records.set(current.id, next);
    await this.persist(next);
    await this.writeIndex();
  }

  async setToolCarryFor(id: string, toolCarry: string): Promise<void> {
    const current = this.records.get(id);
    if (!current) return;
    const next: ConversationRecord = { ...current, toolCarry: toolCarry.slice(0, 12_000), updatedAt: new Date().toISOString() };
    this.records.set(current.id, next);
    await this.persist(next);
  }

  async create(title?: string): Promise<ConversationRecord> {
    const record = emptyRecord(title && title.trim() !== "" ? safeText(title).slice(0, TITLE_LIMIT) : "新对话");
    this.records.set(record.id, record);
    this.activeId = record.id;
    await this.persist(record);
    await this.writeIndex();
    return record;
  }

  async switchTo(id: string): Promise<ConversationRecord> {
    const record = this.records.get(id);
    if (!record) throw new Error("找不到这个对话。");
    this.activeId = id;
    await this.writeIndex();
    return record;
  }

  async rename(id: string, title: string): Promise<ConversationRecord> {
    const record = this.records.get(id);
    if (!record) throw new Error("找不到这个对话。");
    const nextTitle = safeText(title).slice(0, TITLE_LIMIT);
    if (nextTitle === "") throw new Error("请填写对话名称。");
    const next = { ...record, title: nextTitle, updatedAt: new Date().toISOString() };
    this.records.set(id, next);
    await this.persist(next);
    await this.writeIndex();
    return next;
  }

  async remove(id: string): Promise<ConversationIndex> {
    if (!this.records.has(id)) throw new Error("找不到这个对话。");
    this.records.delete(id);
    await rm(join(this.directory, `${id}.json`), { recursive: true, force: true });
    if (this.records.size === 0) {
      const created = emptyRecord("新对话");
      this.records.set(created.id, created);
      this.activeId = created.id;
      await this.persist(created);
    } else if (this.activeId === id) {
      const next = [...this.records.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      this.activeId = next?.id ?? "";
    }
    await this.writeIndex();
    return this.list();
  }

  async forgetWorkspaceLayer(layerId: string): Promise<void> {
    let changed = false;
    for (const current of this.records.values()) {
      if (!current.workspaceLayerIds?.includes(layerId)) continue;
      const workspaceLayerIds = current.workspaceLayerIds.filter((id) => id !== layerId);
      this.records.set(current.id, { ...current, workspaceLayerIds, updatedAt: new Date().toISOString() });
      await this.persist(this.records.get(current.id) as ConversationRecord);
      changed = true;
    }
    if (changed) await this.writeIndex();
  }

  async registerWorkspaceLayers(id: string, layerIds: readonly string[]): Promise<void> {
    const current = this.records.get(id);
    if (!current) throw new Error("找不到这个对话。");
    const workspaceLayerIds = uniqueIds([...(current.workspaceLayerIds ?? []), ...layerIds]);
    const next = { ...current, workspaceLayerIds, updatedAt: new Date().toISOString() };
    this.records.set(id, next);
    await this.persist(next);
    await this.writeIndex();
  }

  async registerWorkspaceFiles(id: string, fileNames: readonly string[]): Promise<void> {
    const current = this.records.get(id);
    if (!current) throw new Error("找不到这个对话。");
    const workspaceFileNames = [...new Set([...(current.workspaceFileNames ?? []), ...fileNames])].slice(0, 512);
    const next = { ...current, workspaceFileNames, updatedAt: new Date().toISOString() };
    this.records.set(id, next);
    await this.persist(next);
    await this.writeIndex();
  }

  async append(messages: readonly ChatMessage[]): Promise<ConversationRecord> {
    return this.appendTo(this.active().id, messages);
  }

  async appendTo(id: string, messages: readonly ChatMessage[]): Promise<ConversationRecord> {
    const current = this.records.get(id);
    if (!current) throw new Error("找不到这个对话。");
    const now = new Date().toISOString();
    const nextMessages = [...current.messages, ...messages];
    const title = current.messages.length === 0 ? titleFromMessages(nextMessages, current.title) : current.title;
    const created = nextMessages.flatMap((item) => item.createdLayerIds ?? []);
    const lastCreated = created.length > 0 ? created[created.length - 1] : current.lastCreatedLayerId;
    const next: ConversationRecord = {
      ...current,
      title,
      updatedAt: now,
      messages: nextMessages,
      ...(typeof lastCreated === "string" && lastCreated !== "" ? { lastCreatedLayerId: lastCreated } : {}),
    };
    this.records.set(current.id, next);
    await this.persist(next);
    await this.writeIndex();
    return next;
  }

  /**
   * 记下这一轮要删的图层、知识库行和成功审计，先写入对话文件，不截短消息。
   * 已有未完成记录时只返回剩余 id，不改选更早的一轮。
   */
  async prepareTurnRollback(): Promise<PreparedTurnRollback> {
    const current = this.active();
    const pending = current.pendingRollback;
    if (pending) {
      return {
      createdLayerIds: pending.createdLayerIds,
      ragEntryIds: pending.ragEntryIds,
      auditRecordIds: pending.auditRecordIds,
      operationIds: pending.operationIds,
      resumed: true,
      };
    }
    const selected = selectLastTurn(current.messages);
    if (!selected) throw new Error("没有可以回退的助手回复。");
    const removed = current.messages.slice(selected.start, selected.end);
    const plan: PendingTurnRollback = {
      createdLayerIds: layerIdsOfTurn(removed),
      ragEntryIds: uniqueIds(removed.flatMap((item) => item.ragEntryIds ?? [])),
      auditRecordIds: successAuditIdsForRollback(removed),
      operationIds: operationIdsOfTurn(removed),
      messageKeys: current.messages.map((message, index) => turnMessageKey(index, message)).slice(selected.start, selected.end),
    };
    const next: ConversationRecord = {
      ...current,
      pendingRollback: plan,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(current.id, next);
    await this.persist(next);
    await this.writeIndex();
    return {
      createdLayerIds: plan.createdLayerIds,
      ragEntryIds: plan.ragEntryIds,
      auditRecordIds: plan.auditRecordIds,
      operationIds: plan.operationIds,
      resumed: false,
    };
  }

  /** 部分删除失败后，把还没删掉的 id 写回同一条回退记录。消息仍保留。 */
  async retainTurnRollback(remaining: {
    readonly createdLayerIds: readonly string[];
    readonly ragEntryIds: readonly string[];
    readonly auditRecordIds: readonly string[];
    readonly operationIds?: readonly string[];
  }): Promise<void> {
    const current = this.active();
    const pending = current.pendingRollback;
    if (!pending) throw new Error("没有进行中的回退。");
    const next: ConversationRecord = {
      ...current,
      pendingRollback: {
        createdLayerIds: uniqueIds(remaining.createdLayerIds),
        ragEntryIds: uniqueIds(remaining.ragEntryIds),
        auditRecordIds: uniqueIds(remaining.auditRecordIds),
        operationIds: uniqueIds(remaining.operationIds ?? pending.operationIds),
        messageKeys: pending.messageKeys,
      },
      updatedAt: new Date().toISOString(),
    };
    this.records.set(current.id, next);
    await this.persist(next);
    await this.writeIndex();
  }

  /** 副作用都已处理完，才去掉计划里的那一轮消息。 */
  async commitTurnRollback(): Promise<void> {
    const current = this.active();
    const pending = current.pendingRollback;
    if (!pending) throw new Error("没有进行中的回退。");
    const keys = new Set(pending.messageKeys);
    const found = new Set<string>();
    current.messages.forEach((message, index) => {
      const key = turnMessageKey(index, message);
      if (keys.has(key)) found.add(key);
    });
    if (found.size !== keys.size) throw new Error("回退记录对不上这一轮对话，没有改对话。");
    const kept = current.messages.filter((message, index) => !keys.has(turnMessageKey(index, message)));
    const keptCreatedLayerIds = kept.flatMap((message) => message.createdLayerIds ?? message.resultLayers?.map((layer) => layer.layerId) ?? []);
    const { pendingRollback: pendingRollbackToClear, ...rollbackBase } = current;
    void pendingRollbackToClear;
    const next: ConversationRecord = {
      ...rollbackBase,
      updatedAt: new Date().toISOString(),
      messages: kept,
      pendingPlan: null,
      lastCreatedLayerId: keptCreatedLayerIds[keptCreatedLayerIds.length - 1] ?? null,
      checkpoints: (current.checkpoints ?? []).filter((checkpoint) => checkpoint.messageCount <= kept.length),
    };
    this.records.set(current.id, next);
    await this.persist(next);
    await this.writeIndex();
  }

  private readRecord(value: unknown): ConversationRecord | null {
    if (!isRecord(value) || typeof value.id !== "string" || !/^conv-[A-Za-z0-9._-]+$/.test(value.id)) return null;
    const messages = Array.isArray(value.messages) ? value.messages.map(readMessage).filter((item): item is ChatMessage => item !== null) : [];
    const createdAt = typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString();
    const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : createdAt;
    const title = typeof value.title === "string" && value.title.trim() !== "" ? safeText(value.title).slice(0, TITLE_LIMIT) : titleFromMessages(messages, "新对话");
    const pendingPlan = parsePendingPlan(value.pendingPlan);
    const lastCreatedLayerId = typeof value.lastCreatedLayerId === "string" && /^[A-Za-z0-9._-]+$/.test(value.lastCreatedLayerId)
      ? value.lastCreatedLayerId
      : null;
    const pendingRollback = readPendingRollback(value.pendingRollback);
    const checkpoints = Array.isArray(value.checkpoints)
      ? value.checkpoints.flatMap((item) => {
          if (!isRecord(item) || typeof item.id !== "string" || !/^checkpoint-[A-Za-z0-9._-]+$/.test(item.id)) return [];
          if (!Number.isInteger(item.messageCount) || (item.messageCount as number) < 0 || (item.messageCount as number) > messages.length) return [];
          if (typeof item.replayText !== "string" || typeof item.createdAt !== "string") return [];
          const pendingPlan = parsePendingPlan(item.pendingPlan);
          const lastCreatedLayerId = typeof item.lastCreatedLayerId === "string" && ID_PATTERN.test(item.lastCreatedLayerId)
            ? item.lastCreatedLayerId
            : null;
          return [{
            id: item.id,
            messageCount: item.messageCount as number,
            replayText: safeText(item.replayText).slice(0, 20_000),
            createdAt: item.createdAt,
            pendingPlan,
            lastCreatedLayerId,
          }];
        }).slice(-MAX_CHECKPOINTS)
      : [];
    return {
      id: value.id,
      title,
      createdAt,
      updatedAt,
      messages,
      ...(pendingPlan ? { pendingPlan } : {}),
      ...(lastCreatedLayerId ? { lastCreatedLayerId } : {}),
      ...(pendingRollback ? { pendingRollback } : {}),
      ...(value.outboundMode === "full" || value.outboundMode === "pronoun" ? { outboundMode: value.outboundMode } : {}),
      ...(typeof value.toolCarry === "string" && value.toolCarry !== "" ? { toolCarry: value.toolCarry.slice(0, 12_000) } : {}),
      ...(Array.isArray(value.workspaceLayerIds) ? { workspaceLayerIds: uniqueIds(value.workspaceLayerIds.filter((item): item is string => typeof item === "string")) } : {}),
      ...(Array.isArray(value.workspaceFileNames) ? { workspaceFileNames: value.workspaceFileNames.filter((item): item is string => typeof item === "string").map((item) => item.slice(0, 512)).slice(0, 512) } : {}),
      ...(checkpoints.length > 0 ? { checkpoints } : {}),
    };
  }

  private async persist(record: ConversationRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const payload = {
      id: record.id,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      messages: record.messages,
      pendingPlan: record.pendingPlan ?? null,
      lastCreatedLayerId: record.lastCreatedLayerId ?? null,
      pendingRollback: record.pendingRollback ?? null,
      workspaceLayerIds: record.workspaceLayerIds ?? [],
      ...(record.outboundMode ? { outboundMode: record.outboundMode } : {}),
      ...(record.toolCarry ? { toolCarry: record.toolCarry } : {}),
      workspaceFileNames: record.workspaceFileNames ?? [],
      checkpoints: record.checkpoints ?? [],
    };
    await writeFile(join(this.directory, `${record.id}.json`), `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8" });
  }

  private async writeIndex(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const payload = { activeId: this.activeId, conversations: this.list().conversations };
    await writeFile(join(this.directory, "index.json"), `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8" });
  }

  private async readIndexFile(): Promise<string | null> {
    try {
      const parsed = JSON.parse(await readFile(join(this.directory, "index.json"), { encoding: "utf8" })) as unknown;
      if (isRecord(parsed) && typeof parsed.activeId === "string") return parsed.activeId;
    } catch {
      return null;
    }
    return null;
  }

  private async migrateLegacy(): Promise<ConversationRecord | null> {
    try {
      const parsed = JSON.parse(await readFile(this.legacyMessagesPath, { encoding: "utf8" })) as unknown;
      if (!Array.isArray(parsed) || parsed.length === 0) return null;
      const messages = parsed.map(readMessage).filter((item): item is ChatMessage => item !== null);
      if (messages.length === 0) return null;
      const now = new Date().toISOString();
      return {
        id: nextId("conv"),
        title: titleFromMessages(messages, "导入的对话"),
        createdAt: messages[0]?.at ?? now,
        updatedAt: messages[messages.length - 1]?.at ?? now,
        messages,
      };
    } catch {
      return null;
    }
  }
}

export function conversationDirectory(root: string): string {
  return resolve(root, "var/conversations");
}

export function conversationWorkspaceDirectory(root: string, conversationId: string): string {
  if (!/^conv-[A-Za-z0-9._-]+$/.test(conversationId)) throw new Error("对话编号无效。");
  return resolve(root, "var/conversation-workspaces", conversationId);
}

const READ_ONLY_TOOLS = new Set([
  "map.list",
  "list_map_layers",
  "list-layers",
  "list_layers",
  "get-layer-metadata",
  "get_layer_metadata",
  "get-sample-feature",
  "get_sample_feature",
  "gdl.describe",
  "describe_gdl",
]);

/** 上一轮助手只在澄清（提问或只列出图层），没有做出空间结果。 */
export function isClarificationAssistant(message: ChatMessage): boolean {
  if (message.role !== "assistant") return false;
  if ((message.resultLayers ?? []).length > 0) return false;
  if ((message.createdLayerIds ?? []).length > 0) return false;
  const traces = message.traces ?? [];
  return !traces.some((trace) => trace.ok && !READ_ONLY_TOOLS.has(trace.tool));
}

/** 若上一轮助手在澄清，返回那一轮对应的用户指令。 */
export function priorInstructionAfterClarification(messages: readonly ChatMessage[]): string | undefined {
  if (messages.length < 2) return undefined;
  const last = messages[messages.length - 1];
  const prev = messages[messages.length - 2];
  if (!last || !prev || last.role !== "assistant" || prev.role !== "user") return undefined;
  if (!isClarificationAssistant(last)) return undefined;
  const text = prev.text.trim();
  return text === "" ? undefined : text;
}
