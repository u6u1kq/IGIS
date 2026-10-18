// SPDX-License-Identifier: Apache-2.0

import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  CHAT_STREAM_FIXTURE,
  createLocalChatMock,
  executePlannedCalls,
  resolveChatPlan,
  runAssistantTurn,
  toApiToolName,
  visibleStreamEventTypes,
} from "@igis/llm-dispatch";
import type { ChatProgressEvent, MapLayerContext, ScheduledToolCall } from "@igis/llm-dispatch";
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

const SELECTED_OTHER = { layerId: "lyr-x", layerName: "selected-layer" };

function hostProcess(): HostProcess {
  const candidate = (globalThis as { process?: HostProcess }).process;
  if (!candidate) throw new Error("评测需要 Node。");
  return candidate;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function evalDeleteOnlyConversation(): Promise<void> {
  const proc = hostProcess();
  const directory = resolve(proc.cwd(), "var/tmp/chat-ux-delete");
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  try {
    const store = new ConversationStore(directory, join(directory, "legacy.json"));
    await store.load();
    assert(store.list().conversations.length === 1, "初始应只有一个对话");
    const onlyId = store.active().id;
    await store.append([{ role: "user", text: "你好", at: new Date().toISOString() }]);
    assert(store.messages().length === 1, "删除前应有一条消息");
    const listed = await store.remove(onlyId);
    assert(listed.conversations.length === 1, "删掉唯一对话后仍应留下一个对话");
    const fresh = listed.conversations[0];
    assert(fresh !== undefined, "应有新的空对话");
    assert(fresh.id !== onlyId, "新对话应使用新的编号");
    assert(fresh.messageCount === 0, "新对话不应带着旧消息");
    assert(store.messages().length === 0, "活动对话应是空的");
    assert(store.active().id === fresh.id, "活动对话应切到新的空对话");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function evalDialogues(): Promise<{ analyze: string; separate: string; follow: string }> {
  const analyze = resolveChatPlan({
    conversationId: "ux",
    text: "现在先分析图层",
    pending: null,
    selectedLayer: { layerId: "lyr-a", layerName: "area-a" },
    knownLayers: KNOWN,
  });
  assert(analyze.kind === "execute", `分析应直接执行，实际是 ${analyze.kind}`);
  assert(analyze.calls.length === 2, "分析只应有描述和统计两步");
  assert(toApiToolName(analyze.calls[0]?.name ?? "") === "describe_gdl", "第一步应是 describe_gdl");
  assert(analyze.calls[0]?.args.layerName === "area-a", "描述应使用选中图层");
  assert(toApiToolName(analyze.calls[1]?.name ?? "") === "summarize_layer", "第二步应是 summarize_layer");
  assert(analyze.calls[1]?.args.layerId === "area-a", "统计应使用同一个图层");
  const analyzeRan: string[] = [];
  const analyzeResult = await executePlannedCalls(analyze.calls, {
    execute(call) {
      analyzeRan.push(toApiToolName(call.tool));
      if (call.tool === "gdl.describe") return Promise.resolve({ ok: true, message: "面图层，1 个要素。" });
      return Promise.resolve({ ok: true, message: "1 个要素。" });
    },
  });
  assert(analyzeRan.join("|") === "describe_gdl|summarize_layer", `分析工具序列不对：${analyzeRan.join("|")}`);
  const analyzeText = analyzeResult.finalText ?? "";
  assert(!/还可以|请选择|缓冲、相交/.test(analyzeText), "分析结束后不应再给菜单");
  assert(analyzeText.includes("面图层"), "分析答复应包含简短描述");

  const ask = resolveChatPlan({
    conversationId: "ux",
    text: "现在先分析图层",
    pending: null,
    selectedLayer: null,
    knownLayers: KNOWN,
  });
  assert(ask.kind === "clarify", "没有图层名也没有选中图层时只应追问一次");
  if (ask.kind !== "clarify") throw new Error("没有图层名也没有选中图层时只应追问一次");
  assert(ask.text === "请指定要分析的图层。", `追问不对：${ask.text}`);
  assert(!ask.text.includes("缓冲") && !ask.text.includes("相交"), "分析追问不应展开成菜单");
  const filled = resolveChatPlan({
    conversationId: "ux",
    text: "area-a",
    pending: ask.pending,
    selectedLayer: { layerId: "lyr-b", layerName: "area-b" },
    knownLayers: KNOWN,
  });
  assert(filled.kind === "execute", "补上图层名后应执行分析，而不是再问一遍");
  assert(filled.calls[0]?.args.layerName === "area-a", "补上的名字不应被选中图层覆盖");
  assert(filled.calls[1]?.args.layerId === "area-a", "统计也应使用补上的名字");

  const separate = resolveChatPlan({
    conversationId: "ux",
    text: "area-a_area-b分离",
    pending: null,
    selectedLayer: SELECTED_OTHER,
    knownLayers: KNOWN,
  });
  assert(separate.kind === "execute", `分离应直接执行，实际是 ${separate.kind}`);
  assert(separate.calls.length === 1, "分离只执行一次");
  assert(toApiToolName(separate.calls[0]?.name ?? "") === "run_clip", "分离采用一次 run_clip");
  assert(separate.calls[0]?.args.layerId === "area-a", "被裁图层应为 area-a，而不是选中图层");
  assert(separate.calls[0]?.args.otherLayerId === "area-b", "裁剪图层应为 area-b");

  const namedBuffer = resolveChatPlan({
    conversationId: "ux",
    text: "对 area-a 做 200 米缓冲",
    pending: null,
    selectedLayer: { layerId: "lyr-b", layerName: "area-b" },
    knownLayers: KNOWN,
  });
  assert(namedBuffer.kind === "execute", "写明图层名的缓冲应直接执行");
  assert(namedBuffer.calls[0]?.args.layerId === "area-a", "显式图层名应压过选中图层");

  const first = resolveChatPlan({
    conversationId: "ux",
    text: "对当前图层做 200 米缓冲，再和另一图层相交",
    pending: null,
    selectedLayer: SELECTED_OTHER,
    knownLayers: KNOWN,
  });
  assert(first.kind === "clarify", "另一图层仍缺时应只追问");
  assert(first.pending.steps[0]?.args.layerId === "lyr-x", "当前图层在没有点名时用选中图层的标识");
  const second = resolveChatPlan({
    conversationId: "ux",
    text: "area-a和area-b",
    pending: first.pending,
    selectedLayer: SELECTED_OTHER,
    knownLayers: KNOWN,
  });
  assert(second.kind === "execute", `补名后应执行，实际是 ${second.kind}`);
  assert(toApiToolName(second.calls[0]?.name ?? "") === "run_buffer", "第一步应是 run_buffer");
  assert(second.calls[0]?.args.layerId === "area-a", "缓冲对象应为用户写下的 area-a");
  assert(second.calls[0]?.args.distance === 200, "缓冲距离应为 200");
  assert(second.calls[0]?.args.unit === "meters", "缓冲单位应为 meters");
  assert(toApiToolName(second.calls[1]?.name ?? "") === "run_intersect", "第二步应是 run_intersect");
  assert(second.calls[1]?.args.otherLayerId === "area-b", "相交对象应为 area-b");
  assert(second.calls[1]?.args.layerId === "__prev__", "相交输入应绑定缓冲结果");
  const executed: ScheduledToolCall[] = [];
  await executePlannedCalls(second.calls, {
    execute(call) {
      executed.push(call);
      if (call.tool === "map.buffer") return Promise.resolve({ ok: true, layerId: "lyr-buf", layerName: "area-a_缓冲", message: "已缓冲" });
      return Promise.resolve({ ok: true, layerId: "lyr-ix", layerName: "area-a_缓冲_相交", message: "已相交" });
    },
  });
  assert(executed.length === 2, "缓冲再相交只跑两步");
  assert(toApiToolName(executed[0]?.tool ?? "") === "run_buffer", "执行的第一步应是 run_buffer");
  assert(executed[0]?.args.layerId === "area-a", "执行时缓冲图层仍是 area-a");
  assert(executed[1]?.args.layerId === "area-a_缓冲", "相交应使用缓冲结果");
  assert(executed[1]?.args.otherLayerId === "area-b", "相交另一层应是 area-b");
  assert(!executed.some((call) => Object.values(call.args).includes("selected-layer")), "选中图层不得覆盖用户写下的名字");

  let duplicateRuns = 0;
  await executePlannedCalls(
    [
      { name: "map.stats", args: { layerId: "area-a" } },
      { name: "map.stats", args: { layerId: "area-a" } },
    ],
    {
      execute() {
        duplicateRuns += 1;
        return Promise.resolve({ ok: true, message: "1 个要素。" });
      },
    },
  );
  assert(duplicateRuns === 1, "同一工具和参数在一轮里只能跑一次");

  return {
    analyze: analyzeRan.join("|"),
    separate: separate.calls.map((call) => toApiToolName(call.name)).join("|"),
    follow: executed.map((call) => toApiToolName(call.tool)).join("|"),
  };
}

async function evalStream(): Promise<readonly string[]> {
  const events: ChatProgressEvent[] = [];
  const turn = await runAssistantTurn({
    providerId: "local",
    model: "local-mock",
    baseUrl: "http://127.0.0.1:9/v1",
    env: {},
    timeoutMs: 5000,
    fetchImpl: createLocalChatMock(),
    question: "对 area-a 做 200 米缓冲",
    mapLayers: LAYERS,
    onProgress(event) {
      events.push(event);
    },
    adapter: {
      execute() {
        return Promise.resolve({ ok: true, message: "已缓冲", layerId: "lyr-buf", layerName: "area-a_缓冲" });
      },
    },
  });
  events.push({ type: "final", text: turn.finalText ?? "" });
  const types = visibleStreamEventTypes(events);
  assert(types[0] === "thought", `流的第一项应是思考，实际是 ${types.join(",")}`);
  const toolAt = types.indexOf("tool");
  const finalAt = types.lastIndexOf("final");
  assert(toolAt > 0, "工具步应出现在思考之后");
  assert(finalAt > toolAt, "最终文字应出现在工具步之后");
  const tool = events.find((event) => event.type === "tool");
  assert(tool !== undefined && tool.type === "tool" && tool.tool === "run_buffer", "工具步应使用 run_buffer");
  assert(!events.some((event) => event.type === "tool" && event.tool.includes(".")), "工具步不应使用带点的内部名");
  const packed = JSON.stringify(events);
  assert(!packed.includes("sk-") && !/Bearer\s+\S+/.test(packed), "流里不应出现密钥");
  assert(!/\d+\.\d+\s*,\s*\d+\.\d+/.test(packed), "流里不应出现坐标");
  assert(visibleStreamEventTypes(CHAT_STREAM_FIXTURE).join(",") === "thought,tool,final", "固定样例顺序应为思考、工具、正文");
  return types;
}

export async function runChatUxEval(): Promise<void> {
  const proc = hostProcess();
  await evalDeleteOnlyConversation();
  const dialogues = await evalDialogues();
  const stream = await evalStream();
  proc.stdout.write(`${JSON.stringify({ ok: true, version: "0.74", deleteOnly: "one-empty", ...dialogues, stream }, null, 2)}\n`);
}

const argv1 = (globalThis as { process?: { argv?: string[] } }).process?.argv?.[1];
if (typeof argv1 === "string" && argv1.includes("chat-ux-eval")) {
  void runChatUxEval().catch((error: unknown) => {
    const proc = hostProcess();
    proc.stderr.write(`${error instanceof Error ? error.message : "评测失败"}\n`);
    proc.exitCode = 1;
  });
}
