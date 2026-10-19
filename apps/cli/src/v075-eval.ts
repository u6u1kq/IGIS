// SPDX-License-Identifier: Apache-2.0

import { readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  explicitLayerTokens,
  LOCAL_DISPATCH_POLICY,
  resolveChatPlan,
  runLocalFirstTurn,
  toApiToolName,
} from "@igis/llm-dispatch";
import type { LlmHttp, ScheduledToolCall } from "@igis/llm-dispatch";
import { openSqliteVecRagStore } from "@igis/rag-meta";
import { openSpatialStack, SpatialOpError } from "@igis/spatial-ops";
import type { MapCollection } from "@igis/spatial-ops";
import { ConversationStore } from "./conversations.js";
import { rollbackChatTurn } from "./turn-rollback.js";

interface HostProcess {
  cwd(): string;
  argv: string[];
  stdout: { write(chunk: string): boolean };
  stderr: { write(chunk: string): boolean };
  exitCode?: number;
}

const LONG_A = "area-a_area-b_相交_缓冲";
const LONG_B = "area-a_area-b_相交_缓冲_相交";
const DELETE_SENTENCE = "首先，删除 area-a_area-b_相交_缓冲area-a_area-b_相交_缓冲_相交";

const KNOWN = [
  { layerId: "lyr-a", layerName: "area-a" },
  { layerId: "lyr-b", layerName: "area-b" },
  { layerId: "lyr-c", layerName: "area-c" },
  { layerId: "lyr-shou", layerName: "首" },
  { layerId: "lyr-ix", layerName: "area-a_area-b_相交" },
  { layerId: "lyr-long-a", layerName: LONG_A },
  { layerId: "lyr-long-b", layerName: LONG_B },
  { layerId: "lyr-prev", layerName: "area-a_缓冲" },
];

function hostProcess(): HostProcess {
  const candidate = (globalThis as { process?: HostProcess }).process;
  if (!candidate) throw new Error("评测需要 Node。");
  return candidate;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function countOf(items: readonly unknown[]): number {
  return items.length;
}

function square(name: string, dx: number): MapCollection {
  const x0 = dx;
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { name },
      geometry: {
        type: "Polygon",
        coordinates: [[[x0, 0], [x0, 1], [x0 + 1, 1], [x0 + 1, 0], [x0, 0]]],
      },
    }],
  };
}

function modelReply(): LlmHttp {
  return async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [{ message: { role: "assistant", content: "已由模型处理。" } }],
    }),
  });
}

function countingFetch(bodies: string[]): LlmHttp {
  const inner = modelReply();
  return async (url, init) => {
    bodies.push(init.body);
    return inner(url, init);
  };
}

interface ModelUserPayload {
  instruction?: string;
  originalText?: string;
  partialEntities?: { intentFragments?: string[]; layerCandidates?: string[]; numbers?: number[] };
  selectedLayer?: { layerId?: string; layerName?: string } | null;
}

function userPayload(body: string): ModelUserPayload {
  const parsed = JSON.parse(body) as { messages?: { role?: string; content?: string }[] };
  const user = parsed.messages?.find((item) => item.role === "user");
  assert(typeof user?.content === "string", "模型请求应包含用户消息");
  return JSON.parse(user.content) as ModelUserPayload;
}

function baseTurn(fetchImpl: LlmHttp, adapterCalls: ScheduledToolCall[]) {
  return {
    conversationId: "conv-v075",
    pending: null,
    selectedLayer: null as { layerId: string; layerName: string } | null,
    knownLayers: KNOWN,
    adapter: {
      execute(call: ScheduledToolCall) {
        adapterCalls.push(call);
        return Promise.resolve({
          ok: true,
          message: "已完成",
          layerId: "lyr-out",
          layerName: "结果",
          durationMs: 12,
        });
      },
    },
    providerId: "local" as const,
    model: "local-test",
    baseUrl: "http://127.0.0.1:9/v1",
    env: {} as Readonly<Record<string, string | undefined>>,
    fetchImpl,
  };
}

export async function runV075Eval(): Promise<void> {
  const proc = hostProcess();
  const root = resolve(proc.cwd(), "var/tmp/v075-eval");
  await rm(root, { recursive: true, force: true });
  const bufferBodies: string[] = [];
  const bufferCalls: ScheduledToolCall[] = [];
  const buffered = await runLocalFirstTurn({
    ...baseTurn(countingFetch(bufferBodies), bufferCalls),
    text: "对 area-a 做 200 米缓冲",
  });
  assert(buffered.policy === LOCAL_DISPATCH_POLICY, "应走对话调度策略");
  assert(buffered.usedModel === true && buffered.kind === "model", "识别先交给模型，不在本地抢先执行");
  assert(bufferCalls.length === 0, "模型还没选定工具时不在本地执行缓冲");
  assert(bufferBodies.length === 1, "识别应请求一次模型");

  const unknownBodies: string[] = [];
  const unknownCalls: ScheduledToolCall[] = [];
  const unknownText = "帮我写一首关于春天的诗";
  const unknown = await runLocalFirstTurn({
    ...baseTurn(countingFetch(unknownBodies), unknownCalls),
    text: unknownText,
    selectedLayer: { layerId: "lyr-a", layerName: "area-a" },
  });
  assert(unknown.usedModel === true, "认不出的句子必须调用模型");
  assert(unknown.kind === "model", `认不出的句子不能本地报错，实际 ${unknown.kind}`);
  assert(unknown.reply === "已由模型处理。", "模型回复应原样返回");
  assert(unknownBodies.length === 1, `认不出的句子应只请求一次模型，实际 ${unknownBodies.length}`);
  assert(unknownCalls.length === 0, "认不出的句子不应本地执行");
  const unknownUser = userPayload(unknownBodies[0] ?? "");
  assert(unknownUser.originalText === unknownText, "模型请求应带上用户原文");
  assert(unknownUser.partialEntities !== undefined, "模型请求应带上已抽出的部分实体");
  assert(Array.isArray(unknownUser.partialEntities?.intentFragments), "部分实体应含意图片段");
  assert(unknownUser.selectedLayer?.layerId === "lyr-a", "回退到模型时也应带上选中图层");
  assert(!unknownBodies[0]?.includes('"coordinates"'), "模型请求不能含坐标");
  assert(!unknownBodies[0]?.includes("Authorization"), "请求正文不能带密钥");

  const ambiguousBodies: string[] = [];
  const ambiguousCalls: ScheduledToolCall[] = [];
  const ambiguous = await runLocalFirstTurn({
    ...baseTurn(countingFetch(ambiguousBodies), ambiguousCalls),
    text: "把 area-a 缓冲或者求交",
  });
  assert(ambiguous.usedModel === true && ambiguous.kind === "model", "含糊意图必须调用模型");
  assert(ambiguousBodies.length === 1, "含糊意图应只请求一次模型");
  assert(ambiguousCalls.length === 0, "含糊意图不应本地执行");
  const ambiguousUser = userPayload(ambiguousBodies[0] ?? "");
  const fragments = ambiguousUser.partialEntities?.intentFragments ?? [];
  assert(ambiguousUser.originalText === "把 area-a 缓冲或者求交", "含糊句应把原文交给模型");

  const missingBodies: string[] = [];
  const missingCalls: ScheduledToolCall[] = [];
  const asked = await runLocalFirstTurn({
    ...baseTurn(countingFetch(missingBodies), missingCalls),
    text: "做 200 米缓冲",
  });
  assert(asked.kind === "model" && asked.usedModel === true, "缺槽的句子也先交给模型识别");
  assert(countOf(missingBodies) === 1 && countOf(missingCalls) === 0, "识别时调用模型，不在本地执行");
  const follow = await runLocalFirstTurn({
    ...baseTurn(countingFetch(missingBodies), missingCalls),
    text: "今天天气怎么样",
    pending: asked.pending,
  });
  assert(follow.usedModel === true && follow.kind === "model", "下一句也交给模型识别");
  assert(countOf(missingBodies) === 2, "两句各请求一次模型");
  assert(countOf(missingCalls) === 0, "识别阶段不能执行");
  const followUser = userPayload(missingBodies[1] ?? "");
  assert(followUser.originalText === "今天天气怎么样", "模型应看到这一轮的原句");

  const partialBodies: string[] = [];
  const partialCalls: ScheduledToolCall[] = [];
  const twoStep = resolveChatPlan({
    conversationId: "conv-v075",
    text: "对当前图层做 200 米缓冲，再和另一图层相交",
    pending: null,
    selectedLayer: null,
    knownLayers: KNOWN,
  });
  assert(twoStep.kind === "clarify", "两步都缺图层时应追问，而不是只做一步");
  const half = await runLocalFirstTurn({
    ...baseTurn(countingFetch(partialBodies), partialCalls),
    text: "area-a",
    pending: twoStep.kind === "clarify" ? twoStep.pending : null,
  });
  assert(half.usedModel === true, "只补上一个槽不能执行缩水计划，应调用模型");
  assert(partialCalls.length === 0, "只补一个图层名时不能先做缓冲");

  const clip = resolveChatPlan({
    conversationId: "conv-v075",
    text: "把 area-a 裁切一下 area-b",
    pending: null,
    selectedLayer: { layerId: "lyr-c", layerName: "area-c" },
    knownLayers: KNOWN,
  });
  assert(clip.kind === "execute" && clip.calls[0]?.name === "map.clip", "裁切应映射为 clip");
  assert(clip.calls[0]?.args.layerId === "area-a" && clip.calls[0]?.args.otherLayerId === "area-b", "显式图层名应覆盖选中图层");
  assert(toApiToolName(clip.calls[0]?.name ?? "") === "run_clip", "裁切对外名应为 run_clip");

  const cut = resolveChatPlan({
    conversationId: "conv-v075",
    text: "用 area-b 裁剪 area-a",
    pending: null,
    selectedLayer: null,
    knownLayers: KNOWN,
  });
  assert(cut.kind === "execute" && cut.calls[0]?.name === "map.clip", "裁剪应映射为 clip");

  const cross = resolveChatPlan({
    conversationId: "conv-v075",
    text: "对 area-a 和 area-b 求交",
    pending: null,
    selectedLayer: { layerId: "lyr-c", layerName: "area-c" },
    knownLayers: KNOWN,
  });
  assert(cross.kind === "execute" && cross.calls[0]?.name === "map.intersect", "求交应映射为 intersect");
  assert(cross.calls[0]?.args.layerId === "area-a" && cross.calls[0]?.args.otherLayerId === "area-b", "求交应使用写出的两个图层");
  assert(toApiToolName("map.intersect") === "run_intersect", "内部 map.intersect 对外是 run_intersect");

  const point = resolveChatPlan({
    conversationId: "conv-v075",
    text: "对 area-a 和 area-b 做交点分析",
    pending: null,
    selectedLayer: null,
    knownLayers: KNOWN,
  });
  assert(point.kind === "execute" && point.calls[0]?.name === "map.intersect", "交点分析应映射为 intersect");

  const twoHundred = resolveChatPlan({
    conversationId: "conv-v075",
    text: "把 area-a 缓冲两百",
    pending: null,
    selectedLayer: { layerId: "lyr-b", layerName: "area-b" },
    knownLayers: KNOWN,
  });
  assert(twoHundred.kind === "execute", "两百米缓冲应能本地执行");
  if (twoHundred.kind === "execute") {
    assert(twoHundred.calls[0]?.args.layerId === "area-a", "显式 area-a 不能被选中的 area-b 覆盖");
    assert(twoHundred.calls[0]?.args.distance === 200 && twoHundred.calls[0]?.args.unit === "meters", "两百应是 200 米");
  }

  const bare = resolveChatPlan({
    conversationId: "conv-v075",
    text: "把 area-a 缓冲 200",
    pending: null,
    selectedLayer: null,
    knownLayers: KNOWN,
  });
  assert(bare.kind === "execute" && bare.calls[0]?.args.distance === 200 && bare.calls[0]?.args.unit === "meters", "裸数字 200 默认米");

  const anaphora = resolveChatPlan({
    conversationId: "conv-v075",
    text: "对刚才那个结果缓冲 200 米",
    pending: null,
    selectedLayer: { layerId: "lyr-a", layerName: "area-a" },
    knownLayers: KNOWN,
    lastCreatedLayerId: "lyr-prev",
  });
  assert(anaphora.kind === "execute" && anaphora.calls[0]?.name === "map.buffer", "刚才那个结果应能缓冲");
  assert(anaphora.kind === "execute" && anaphora.calls[0]?.args.layerId === "lyr-prev", "指代应绑定最近创建的图层");

  const itBuffer = resolveChatPlan({
    conversationId: "conv-v075",
    text: "把它缓冲两百米",
    pending: null,
    selectedLayer: { layerId: "lyr-a", layerName: "area-a" },
    knownLayers: KNOWN,
    lastCreatedLayerId: "lyr-prev",
  });
  assert(itBuffer.kind === "execute" && itBuffer.calls[0]?.args.layerId === "lyr-prev", "它应绑定最近创建的图层，而不是选中图层");

  const hidden = resolveChatPlan({
    conversationId: "conv-v075",
    text: "隐藏 area-a",
    pending: null,
    selectedLayer: null,
    knownLayers: KNOWN,
  });
  assert(hidden.kind === "execute" && hidden.calls[0]?.name === "map.setVisibility" && hidden.calls[0]?.args.visible === false, "隐藏应本地执行");

  const shown = resolveChatPlan({
    conversationId: "conv-v075",
    text: "显示 area-b",
    pending: null,
    selectedLayer: null,
    knownLayers: KNOWN,
  });
  assert(shown.kind === "execute" && shown.calls[0]?.args.visible === true, "显示应本地执行");

  const names = explicitLayerTokens(DELETE_SENTENCE, KNOWN);
  assert(names.join("|") === `${LONG_A}|${LONG_B}`, `粘连图层应按最长匹配切开，实际 ${names.join("|")}`);
  assert(!names.includes("首") && !names.includes("首先"), "首先和首不是图层");

  const deleteBodies: string[] = [];
  const deleteCalls: ScheduledToolCall[] = [];
  const challenged = await runLocalFirstTurn({
    ...baseTurn(countingFetch(deleteBodies), deleteCalls),
    text: DELETE_SENTENCE,
    knownLayers: KNOWN,
  });
  assert(challenged.kind === "model" && challenged.usedModel === true, "删除句子也先交给模型识别");
  assert(countOf(deleteCalls) === 0, "确认前不能执行");
  const deletePlan = resolveChatPlan({
    conversationId: "conv-v075",
    text: DELETE_SENTENCE,
    pending: null,
    selectedLayer: null,
    knownLayers: KNOWN,
  });
  assert(deletePlan.kind === "confirm", "解析器仍能把明确删除收成待确认计划");
  const confirmed = await runLocalFirstTurn({
    ...baseTurn(() => { throw new Error("已确认的删除不应再识别"); }, deleteCalls),
    text: DELETE_SENTENCE,
    pending: deletePlan.kind === "confirm" ? deletePlan.pending : null,
    confirm: true,
    knownLayers: KNOWN,
  });
  assert(confirmed.kind === "execute", "确认后才执行删除");
  assert(countOf(deleteCalls) === 2, `确认后应删除两个图层，实际 ${deleteCalls.length}`);
  assert(deleteCalls.every((call) => call.tool === "map.delete"), "确认后只能删除，不能缓冲");
  assert(deleteCalls[0]?.args.layerId === LONG_A && deleteCalls[1]?.args.layerId === LONG_B, "应删除两个粘连结果图层");
  assert(toApiToolName(deleteCalls[0]?.tool ?? "") === "delete_layer", "删除对外名应为 delete_layer");

  const convDir = join(root, "conversations");
  const store = new ConversationStore(convDir, join(convDir, "legacy.json"));
  await store.load();
  const drafted = resolveChatPlan({
    conversationId: store.active().id,
    text: "对当前图层做 200 米缓冲，再和另一图层相交",
    pending: null,
    selectedLayer: null,
    knownLayers: KNOWN,
  });
  assert(drafted.kind === "clarify", "缓冲再相交缺图层时应追问");
  if (drafted.kind !== "clarify") throw new Error("计划应处于追问");
  await store.setPendingPlan(drafted.pending);
  const reloaded = new ConversationStore(convDir, join(convDir, "legacy.json"));
  await reloaded.load();
  const persisted = reloaded.pendingPlan();
  assert(persisted !== null, "PendingPlan 应写入 var/conversations，重启后还能读到");
  const filled = resolveChatPlan({
    conversationId: store.active().id,
    text: "area-a和area-b",
    pending: persisted,
    selectedLayer: { layerId: "lyr-c", layerName: "area-c" },
    knownLayers: KNOWN,
  });
  assert(filled.kind === "execute", "补上两个图层后应执行原计划");
  assert(filled.kind === "execute" && filled.calls[0]?.name === "map.buffer" && filled.calls[0]?.args.layerId === "area-a", "先缓冲 area-a");
  assert(filled.kind === "execute" && filled.calls[0]?.args.distance === 200, "缓冲距离保持 200 米");
  assert(filled.kind === "execute" && filled.calls[1]?.name === "map.intersect" && filled.calls[1]?.args.otherLayerId === "area-b", "再与 area-b 相交");
  assert(filled.kind === "execute" && filled.calls[1]?.args.layerId === "__prev__", "相交应接上一步输出");
  assert(filled.kind === "execute" && filled.calls[0]?.args.layerId === "area-a", "补上的名字应覆盖选中图层");

  const pipeline = resolveChatPlan({
    conversationId: "conv-v075",
    text: "先对 area-a 缓冲两百米，再和 area-b 求交，然后用 area-c 裁切",
    pending: null,
    selectedLayer: null,
    knownLayers: KNOWN,
  });
  assert(pipeline.kind === "execute" && pipeline.calls.length === 3, "先再然后应拆成三步");
  assert(pipeline.kind === "execute" && pipeline.calls[0]?.name === "map.buffer" && pipeline.calls[0]?.args.layerId === "area-a", "第一步缓冲 area-a");
  assert(pipeline.kind === "execute" && pipeline.calls[1]?.name === "map.intersect" && pipeline.calls[1]?.args.layerId === "__prev__", "第二步接上一步");
  assert(pipeline.kind === "execute" && pipeline.calls[2]?.name === "map.clip" && pipeline.calls[2]?.args.layerId === "__prev__", "第三步继续接上一步");
  assert(pipeline.kind === "execute" && pipeline.calls[2]?.args.otherLayerId === "area-c", "裁切图层应为 area-c");

  const stackDir = join(root, "stack");
  const rag = await openSqliteVecRagStore(join(stackDir, "rag"));
  const stack = await openSpatialStack({
    layerDirectory: join(stackDir, "layers"),
    auditDirectory: join(stackDir, "audit"),
    cacheDirectory: join(stackDir, "cache"),
    modelName: () => "local-test",
  });
  const source = await stack.catalog.insert({
    layerName: "area-a",
    sourcePaths: ["memory"],
    collection: square("area-a", 0),
    crsLabel: "EPSG:4326",
  });
  const other = await stack.catalog.insert({
    layerName: "area-b",
    sourcePaths: ["memory"],
    collection: square("area-b", 0.5),
    crsLabel: "EPSG:4326",
  });
  const keep = await stack.catalog.insert({
    layerName: "keep-me",
    sourcePaths: ["memory"],
    collection: square("keep", 10),
    crsLabel: "EPSG:4326",
  });
  const first = await stack.service.buffer(source.layerId, 200, "meters", true);
  assert(typeof first.durationMs === "number" && first.durationMs >= 0, "缓冲应记录 durationMs");
  assert(first.cached !== true, "第一次缓冲不应命中缓存");
  assert(typeof first.ragEntryId === "string" && first.ragEntryId !== "", "本地空间运算应写入一条知识库摘要");
  assert(typeof first.auditRecordId === "string" && first.auditRecordId !== "", "本地空间运算应写入审计");
  const listed = await rag.list();
  const entry = listed.find((item) => item.entryId === first.ragEntryId);
  assert(entry !== undefined, "应能读到 sqlite-vec 摘要");
  const stored = listed.find((item) => item.entryId === first.ragEntryId);
  assert(stored !== undefined && stored.layerNames.includes("area-a"), "摘要应包含图层名");
  const second = await stack.service.buffer(source.layerId, 200, "meters", false);
  assert(second.cached === true, "相同运算、图层、参数和几何哈希应命中缓存");
  assert(second.layer?.layerId === first.layer?.layerId, "缓存应返回同一结果图层");
  const bufferedLayers = stack.catalog.list().filter((layer) => layer.layerName.includes("缓冲"));
  assert(bufferedLayers.length === 1, "缓存命中不应再生成一层");
  const cacheFiles = await readdir(join(stackDir, "cache"));
  assert(cacheFiles.some((name) => name.endsWith(".json")), "缓存应落在 var/cache");
  for (const name of cacheFiles) {
    const text = await readFile(join(stackDir, "cache", name), { encoding: "utf8" });
    assert(!text.includes("coordinates"), "缓存文件不能写坐标");
  }
  const crossed = await stack.service.intersect(source.layerId, other.layerId, true);
  const crossEntry = (await rag.list()).find((item) => item.entryId === crossed.ragEntryId);
  assert(crossEntry !== undefined, "相交也应写一条摘要");
  assert(crossEntry.layerNames.includes("area-a") && crossEntry.layerNames.includes("area-b"), "相交摘要应包含两个图层名");
  assert(crossEntry.title.includes("run_intersect"), "摘要里的运算名用 run_intersect");

  const bad = await stack.catalog.insert({
    layerName: "bad-geom",
    sourcePaths: ["memory"],
    collection: {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: { name: "bad" },
        geometry: { type: "GeometryCollection", geometries: [] },
      }],
    } as MapCollection,
    crsLabel: "EPSG:4326",
  });
  let stopped = false;
  try {
    await stack.service.buffer(bad.layerId, 200, "meters", false);
  } catch (error) {
    stopped = error instanceof SpatialOpError && error.message.includes("调用前停止");
  }
  assert(stopped, "几何类型不合格时必须在调用 Turf 之前停止");

  const chatDir = join(root, "rollback-chat");
  const chats = new ConversationStore(chatDir, join(chatDir, "legacy.json"));
  await chats.load();
  await chats.append([
    { role: "user", text: "对 area-a 做 200 米缓冲", at: new Date().toISOString() },
    {
      role: "assistant",
      text: "已缓冲。",
      at: new Date().toISOString(),
      createdLayerIds: first.layer ? [first.layer.layerId] : [],
      ragEntryIds: first.ragEntryId ? [first.ragEntryId] : [],
      auditRecordIds: first.auditRecordId ? [first.auditRecordId] : [],
    },
  ]);
  const effects = await rollbackChatTurn({
    conversations: chats,
    removeLayer: (layerId) => stack.catalog.remove(layerId),
    deleteRag: (entryId) => rag.delete(entryId),
    deleteAudit: (recordId) => stack.audit.remove(recordId),
  });
  assert(effects.removedLayerIds.includes(first.layer?.layerId ?? ""), "回退应删除本轮新建图层");
  assert(stack.catalog.get(first.layer?.layerId ?? "") === null, "结果图层应已不在");
  assert(stack.catalog.get(keep.layerId) !== null, "回退不能删除本轮之外的图层");
  assert(effects.removedRagIds.includes(first.ragEntryId ?? ""), "回退应删除本轮知识库行");
  assert((await rag.list()).every((item) => item.entryId !== first.ragEntryId), "知识库里不应再有这一行");
  assert(effects.removedAuditIds.includes(first.auditRecordId ?? ""), "回退应删除本轮空间审计");
  assert((await stack.audit.list()).every((item) => item.recordId !== first.auditRecordId), "审计里不应再有这一条");
  assert((await stack.audit.list()).some((item) => item.recordId === crossed.auditRecordId), "别的轮次的审计应保留");

  const html = await readFile(resolve(proc.cwd(), "apps/desktop/ui/index.html"), { encoding: "utf8" });
  const appJs = await readFile(resolve(proc.cwd(), "apps/desktop/ui/app.js"), { encoding: "utf8" });
  assert(html.includes('id="settings-developer"'), "齿轮里应有开发者模式");
  assert(!html.includes('id="settings-developer" type="checkbox" checked'), "开发者模式默认关闭");
  assert(appJs.includes("developerMode: false"), "界面默认不打开开发者模式");
  assert(appJs.includes("parseTrace"), "开发者模式显示解析轨迹");
  assert(appJs.includes("durationMs"), "界面显示本地运算耗时");
  assert(appJs.includes("selectedLayer"), "对话请求发送选中图层");
  assert(appJs.includes("confirm: true"), "确认后才带 confirm 再次提交");

  proc.stdout.write(`${JSON.stringify({ ok: true, policy: LOCAL_DISPATCH_POLICY })}\n`);
  await rm(root, { recursive: true, force: true });
}

const argv1 = hostProcess().argv[1] ?? "";
if (argv1.includes("v075")) {
  void runV075Eval().catch((error: unknown) => {
    const proc = hostProcess();
    proc.stderr.write(`${error instanceof Error ? error.message : "评测失败"}\n`);
    proc.exitCode = 1;
  });
}
