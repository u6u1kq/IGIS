// SPDX-License-Identifier: Apache-2.0

/**
 * 回退单位仍是一轮聊天：最后一条助手消息，以及它前面的那条用户消息。
 * 新的 GIS 操作先按 operationId 收回缓存、知识和图层。
 * 只有 createdLayerIds、没有 operationId 的旧消息，仍按图层清单删除。
 * 失败审计和来源账本不删。先清理，再截短对话。
 */
import { ConversationStore } from "./conversations.js";

export type RollbackStepName = "layer" | "rag" | "audit" | "conversation";

export type RollbackStepState = "removed" | "already-absent" | "failed" | "kept";

export interface RollbackStep {
  readonly step: RollbackStepName;
  readonly id: string;
  readonly state: RollbackStepState;
  readonly message?: string;
}

export interface ChatTurnRollbackResult {
  readonly ok: boolean;
  readonly resumed: boolean;
  readonly message: string;
  readonly removedLayerIds: readonly string[];
  readonly removedRagIds: readonly string[];
  readonly removedAuditIds: readonly string[];
  readonly completed: readonly RollbackStep[];
  readonly unfinished: readonly RollbackStep[];
}

export interface OperationRollbackNotice {
  readonly ok: boolean;
  readonly status: "rolled_back" | "rollback_failed";
  readonly cleaned: readonly { readonly kind: string; readonly id: string; readonly state: string; readonly message?: string }[];
  readonly remaining: readonly { readonly kind: string; readonly id: string; readonly state: string; readonly message?: string }[];
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  return "删除失败";
}

function stepLabel(step: RollbackStep): string {
  if (step.step === "conversation") {
    return step.state === "removed" ? "对话中的这一轮" : "对话中的这一轮（仍保留）";
  }
  const kind = step.step === "layer" ? "图层" : step.step === "rag" ? "知识库" : "审计";
  if (step.state === "removed") return `${kind} ${step.id}`;
  if (step.state === "already-absent") return `${kind} ${step.id}（已经不在）`;
  return `${kind} ${step.id}（${step.message ?? "没有删除"}）`;
}

export function describeRollback(completed: readonly RollbackStep[], unfinished: readonly RollbackStep[]): string {
  const done = completed.map(stepLabel);
  const left = unfinished.map(stepLabel);
  if (left.length === 0) {
    return `已回退上一轮。已完成：${done.join("、") || "没有需要删除的图层、知识库或审计"}。`;
  }
  return `回退没有完成。已完成：${done.join("、") || "无"}。未完成：${left.join("、")}。`;
}

async function runOne(
  step: "layer" | "rag" | "audit",
  id: string,
  remove: (id: string) => Promise<boolean>,
): Promise<RollbackStep> {
  try {
    const removed = await remove(id);
    if (removed) return { step, id, state: "removed" };
    return { step, id, state: "already-absent" };
  } catch (error) {
    return { step, id, state: "failed", message: errorText(error) };
  }
}

/** 按图层、知识库、审计的原有顺序逐项删除。某一项抛错只记为未完成，不吞掉。 */
export async function rollbackTurnEffects(input: {
  readonly createdLayerIds: readonly string[];
  readonly ragEntryIds: readonly string[];
  readonly auditRecordIds: readonly string[];
  readonly removeLayer: (layerId: string) => Promise<boolean>;
  readonly deleteRag: (entryId: string) => Promise<boolean>;
  readonly deleteAudit: (recordId: string) => Promise<boolean>;
}): Promise<{
  readonly removedLayerIds: readonly string[];
  readonly removedRagIds: readonly string[];
  readonly removedAuditIds: readonly string[];
  readonly completed: readonly RollbackStep[];
  readonly unfinished: readonly RollbackStep[];
}> {
  const steps: RollbackStep[] = [];
  for (const layerId of [...new Set(input.createdLayerIds)]) {
    steps.push(await runOne("layer", layerId, input.removeLayer));
  }
  for (const entryId of [...new Set(input.ragEntryIds)]) {
    steps.push(await runOne("rag", entryId, input.deleteRag));
  }
  for (const recordId of [...new Set(input.auditRecordIds)]) {
    steps.push(await runOne("audit", recordId, input.deleteAudit));
  }
  const completed = steps.filter((step) => step.state === "removed" || step.state === "already-absent");
  const unfinished = steps.filter((step) => step.state === "failed");
  return {
    removedLayerIds: completed.filter((step) => step.step === "layer" && step.state === "removed").map((step) => step.id),
    removedRagIds: completed.filter((step) => step.step === "rag" && step.state === "removed").map((step) => step.id),
    removedAuditIds: completed.filter((step) => step.step === "audit" && step.state === "removed").map((step) => step.id),
    completed,
    unfinished,
  };
}

/**
 * 先把计划写入对话文件，再删副作用。全部完成后才截短这一轮。
 * 有未完成项时，对话和回退记录都留下剩余 id，重试仍只处理这一轮。
 */
export async function rollbackChatTurn(input: {
  readonly conversations: ConversationStore;
  readonly removeLayer: (layerId: string) => Promise<boolean>;
  readonly deleteRag: (entryId: string) => Promise<boolean>;
  readonly deleteAudit: (recordId: string) => Promise<boolean>;
  /** 有 operationId 时先按记录收回。旧消息不传也行。 */
  readonly rollbackOperation?: (operationId: string) => Promise<OperationRollbackNotice>;
}): Promise<ChatTurnRollbackResult> {
  const prepared = await input.conversations.prepareTurnRollback();
  const handledLayers = new Set<string>();
  const handledRag = new Set<string>();
  const handledAudits = new Set<string>();
  const operationFailures: RollbackStep[] = [];
  const failedOperationIds: string[] = [];
  if (input.rollbackOperation) {
    for (const operationId of prepared.operationIds) {
      try {
        const result = await input.rollbackOperation(operationId);
        for (const item of [...result.cleaned, ...result.remaining]) {
          if (item.kind === "layer") handledLayers.add(item.id);
          if (item.kind === "knowledge") handledRag.add(item.id);
          if (item.kind === "audit" && item.state !== "kept") handledAudits.add(item.id);
        }
        if (!result.ok) {
          failedOperationIds.push(operationId);
          const failedItems = result.remaining.filter((item) => item.state === "failed");
          if (failedItems.length === 0) {
            operationFailures.push({ step: "layer", id: operationId, state: "failed", message: "操作回退没有完成。" });
          }
          for (const item of failedItems) {
            const step = item.kind === "knowledge" ? "rag" : item.kind === "audit" ? "audit" : "layer";
            operationFailures.push({ step, id: item.id, state: "failed", message: item.message ?? "没有删除" });
          }
        }
      } catch (error) {
        // 记录缺失这类永久性失败不写回待回退清单：重试必然再次失败，会让该轮对话永远删不掉。
        const permanent = error instanceof Error && error.message.includes("找不到这次操作");
        if (!permanent) failedOperationIds.push(operationId);
        operationFailures.push({ step: "layer", id: operationId, state: "failed", message: errorText(error) });
      }
    }
  }
  const effects = await rollbackTurnEffects({
    createdLayerIds: prepared.createdLayerIds.filter((id) => !handledLayers.has(id)),
    ragEntryIds: prepared.ragEntryIds.filter((id) => !handledRag.has(id)),
    auditRecordIds: prepared.auditRecordIds.filter((id) => !handledAudits.has(id)),
    removeLayer: input.removeLayer,
    deleteRag: input.deleteRag,
    deleteAudit: input.deleteAudit,
  });
  const removed = {
    removedLayerIds: effects.removedLayerIds,
    removedRagIds: effects.removedRagIds,
    removedAuditIds: effects.removedAuditIds,
  };
  const unfinished = [...operationFailures, ...effects.unfinished];
  const completed = effects.completed;
  if (unfinished.length === 0) {
    await input.conversations.commitTurnRollback();
    const done: RollbackStep[] = [...completed, { step: "conversation", id: "turn", state: "removed" }];
    return {
      ok: true,
      resumed: prepared.resumed,
      message: describeRollback(done, []),
      ...removed,
      completed: done,
      unfinished: [],
    };
  }
  await input.conversations.retainTurnRollback({
    createdLayerIds: unfinished.filter((step) => step.step === "layer").map((step) => step.id),
    ragEntryIds: unfinished.filter((step) => step.step === "rag").map((step) => step.id),
    auditRecordIds: unfinished.filter((step) => step.step === "audit").map((step) => step.id),
    operationIds: failedOperationIds,
  });
  const kept: RollbackStep[] = [
    ...unfinished,
    { step: "conversation", id: "turn", state: "kept", message: "这一轮对话还在，未完成的删除仍记在回退记录里。" },
  ];
  return {
    ok: false,
    resumed: prepared.resumed,
    message: describeRollback(completed, kept),
    ...removed,
    completed,
    unfinished: kept,
  };
}
