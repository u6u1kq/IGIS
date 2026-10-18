// SPDX-License-Identifier: Apache-2.0

import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  executePlannedCalls,
  resolveChatPlan,
  toApiToolName,
  visibleDispatchContext,
} from "@igis/llm-dispatch";
import type { MapLayerContext, ScheduledToolCall } from "@igis/llm-dispatch";
import { ConversationStore } from "./conversations.js";

interface HostProcess {
  cwd(): string;
  stdout: { write(chunk: string): boolean };
  stderr: { write(chunk: string): boolean };
  exitCode?: number;
}

const KNOWN = [
  { layerId: "lyr-a", layerName: "area-a" },
  { layerId: "lyr-b", layerName: "area-b" },
  { layerId: "lyr-q", layerName: "area-a_空间查询" },
  { layerId: "lyr-c", layerName: "area-a_裁剪" },
];

const LAYERS: MapLayerContext[] = KNOWN.map((layer, order) => ({
  layerId: layer.layerId,
  layerName: layer.layerName,
  geometryKind: "polygon",
  featureCount: 1,
  fieldNames: ["名称"],
  crsLabel: "EPSG:4326",
  visible: true,
  order,
}));

function hostProcess(): HostProcess {
  const candidate = (globalThis as { process?: HostProcess }).process;
  if (!candidate) throw new Error("评测需要 Node。");
  return candidate;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function runPendingPlanEval(): Promise<void> {
  const proc = hostProcess();
  const directory = resolve(proc.cwd(), "var/tmp/pending-plan-eval");
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  try {
    const store = new ConversationStore(directory, join(directory, "legacy.json"));
    await store.load();
    const conversationId = store.active().id;
    const checkpoint = await store.createCheckpointFor(conversationId, "对当前图层做 200 米缓冲，再和另一图层相交");
    const turn1 = resolveChatPlan({
      conversationId,
      text: "对当前图层做 200 米缓冲，再和另一图层相交",
      pending: store.pendingPlan(),
      selectedLayer: null,
      knownLayers: KNOWN,
    });
    assert(turn1.kind === "clarify", `第一轮应为澄清，实际是 ${turn1.kind}`);
    assert(turn1.pending.steps.length === 2, "第一轮应有两步 PendingPlan");
    assert(turn1.pending.steps[0]?.apiName === "run_buffer", "第一步应为 run_buffer");
    assert(turn1.pending.steps[0]?.args.distance === 200, "缓冲距离应为 200");
    assert(turn1.pending.steps[0]?.args.unit === "meters", "缓冲单位应为 meters");
    assert(turn1.pending.steps[0]?.missing.join(",") === "layerId", "第一步应缺 layerId");
    assert(turn1.pending.steps[1]?.apiName === "run_intersect", "第二步应为 run_intersect");
    assert(turn1.pending.steps[1]?.missing.join(",") === "otherLayerId", "第二步应缺 otherLayerId");
    assert(turn1.pending.steps[1]?.bindPrevTo === "layerId", "相交的 layerId 应绑定上一步结果");
    await store.appendTo(conversationId, [
      { role: "user", text: "上一步请求", at: new Date().toISOString() },
      { role: "assistant", text: "上一步回复", at: new Date().toISOString() },
    ]);
    await store.setPendingPlan(turn1.pending);
    const planCheckpoint = await store.createCheckpointFor(conversationId, "area-a和area-b");

    const reloaded = new ConversationStore(directory, join(directory, "legacy.json"));
    await reloaded.load();
    const persisted = reloaded.pendingPlan();
    assert(persisted !== null, "PendingPlan 应写入对话记录");
    assert(persisted.sourceText === "对当前图层做 200 米缓冲，再和另一图层相交", "落盘应保留原指令");
    const savedCheckpoint = reloaded.checkpointsFor(conversationId)[0];
    assert(savedCheckpoint?.id === checkpoint.id, "检查点应在重启后保留");
    assert(savedCheckpoint.messageCount === 0, "检查点应记住原始轮次边界");
    assert(savedCheckpoint.replayText === "对当前图层做 200 米缓冲，再和另一图层相交", "检查点应保存可重跑的原指令");
    const savedPlanCheckpoint = reloaded.checkpointsFor(conversationId).find((item) => item.id === planCheckpoint.id);
    assert(savedPlanCheckpoint?.pendingPlan?.sourceText === turn1.pending.sourceText, "检查点应保存待澄清的多步计划");

    const turn2 = resolveChatPlan({
      conversationId,
      text: "area-a和area-b",
      pending: persisted,
      selectedLayer: null,
      knownLayers: KNOWN,
    });
    assert(turn2.kind === "execute", `第二轮应按计划执行，实际是 ${turn2.kind}`);
    assert(turn2.calls[0]?.name === "map.buffer", "第二轮第一步应为 map.buffer");
    assert(turn2.calls[0]?.args.layerId === "area-a", "缓冲对象应为 area-a");
    assert(turn2.calls[0]?.args.distance === 200, "缓冲距离应为 200");
    assert(turn2.calls[1]?.name === "map.intersect", "第二轮第二步应为 map.intersect");
    assert(turn2.calls[1]?.args.otherLayerId === "area-b", "相交对象应为 area-b");
    assert(turn2.calls[1]?.args.layerId === "__prev__", "相交输入应绑定缓冲结果");

    const executed: ScheduledToolCall[] = [];
    const result = await executePlannedCalls(turn2.calls, {
      execute(call) {
        executed.push(call);
        if (call.tool === "map.buffer") {
          return Promise.resolve({ ok: true, layerId: "lyr-buf", layerName: "area-a_缓冲", message: "已缓冲" });
        }
        return Promise.resolve({ ok: true, layerId: "lyr-ix", layerName: "area-a_缓冲_area-b_相交", message: "已相交" });
      },
    });
    assert(executed.length === 2, "应按序执行两个工具");
    assert(toApiToolName(executed[0]?.tool ?? "") === "run_buffer", "第一个工具应为 run_buffer");
    assert(executed[0]?.args.layerId === "area-a", "run_buffer 图层应为 area-a");
    assert(executed[0]?.args.distance === 200, "run_buffer 距离应为 200");
    assert(executed[0]?.args.unit === "meters", "run_buffer 单位应为 meters");
    assert(toApiToolName(executed[1]?.tool ?? "") === "run_intersect", "第二个工具应为 run_intersect");
    assert(executed[1]?.args.layerId === "area-a_缓冲", "run_intersect 应使用缓冲结果层");
    assert(executed[1]?.args.otherLayerId === "area-b", "run_intersect 另一层应为 area-b");
    const sequence = result.traces.filter((trace) => trace.ok).map((trace) => toApiToolName(trace.tool));
    assert(sequence.join("|") === "run_buffer|run_intersect", `工具序列不对：${sequence.join("|")}`);
    await reloaded.setPendingPlan(null);
    assert(reloaded.pendingPlan() === null, "执行后应清空 PendingPlan");
    await reloaded.restoreCheckpointState(conversationId, planCheckpoint.id);
    assert(reloaded.pendingPlan()?.sourceText === turn1.pending.sourceText, "回退检查点后应恢复原多步计划");
    await reloaded.setPendingPlan(null);

    const context = visibleDispatchContext({
      instruction: "对当前图层做 200 米缓冲",
      metadata: [],
      kgHits: [],
      mapLayers: LAYERS,
      selectedLayer: LAYERS[0] ?? null,
    }) as { selectedLayer?: { layerId?: string; layerName?: string } | null };
    assert(context.selectedLayer !== null && context.selectedLayer !== undefined, "上下文应有 selectedLayer");
    assert(context.selectedLayer.layerId === "lyr-a", "selectedLayer.layerId 应对上");
    assert(context.selectedLayer.layerName === "area-a", "selectedLayer.layerName 应对上");

    proc.stdout.write(`${JSON.stringify({ ok: true, tools: sequence, pendingStored: true, selectedLayer: context.selectedLayer }, null, 2)}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const argv1 = (globalThis as { process?: { argv?: string[] } }).process?.argv?.[1];
if (typeof argv1 === "string" && argv1.includes("pending-plan")) {
  void runPendingPlanEval().catch((error: unknown) => {
    const proc = hostProcess();
    proc.stderr.write(`${error instanceof Error ? error.message : "评测失败"}\n`);
    proc.exitCode = 1;
  });
}
