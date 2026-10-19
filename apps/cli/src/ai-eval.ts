// SPDX-License-Identifier: Apache-2.0

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  DEEPSEEK_PRESET_MODEL,
  GIS_TOOL_REGISTRY,
  GROK_PRESET_MODEL,
  QWEN_PRESET_MODEL,
  assertLlmPayload,
  createLegacyLocalChatMock,
  createLocalChatMock,
  executePlannedCalls,
  resolveChatPlan,
  runAssistantTurn,
  runLlmDispatchSelfCheck,
  runLlmToolLoopSelfCheck,
  scrubSecrets,
} from "@igis/llm-dispatch";
import type { LlmHttp, MapLayerContext } from "@igis/llm-dispatch";
import { createGdlAwareAdapter } from "./gdl-http.js";
import type { GdlDeps } from "./gdl-http.js";
import { createSpatialAwareAdapter, openSpatialStack } from "@igis/spatial-ops";
import type { MapCollection, SpatialStack } from "@igis/spatial-ops";

interface HostProcess {
  cwd(): string;
  env: Readonly<Record<string, string | undefined>>;
  stdout: { write(chunk: string): boolean };
  stderr: { write(chunk: string): boolean };
  exitCode?: number;
}

interface EvalCase {
  readonly id: string;
  readonly instruction: string;
  readonly setup: "pair" | "ambiguous" | "empty" | "areas";
  readonly expectedTools: readonly string[];
  readonly expectAmbiguous?: boolean;
  readonly expectClarify?: boolean;
  readonly priorInstruction?: string;
}

const CASES: readonly EvalCase[] = [
  { id: "buffer-200m", instruction: "对道路做 200 米缓冲", setup: "pair", expectedTools: ["map.buffer"] },
  { id: "buffer-then-intersect", instruction: "对道路做 200 米缓冲，再与用地相交", setup: "pair", expectedTools: ["map.buffer", "map.intersect"] },
  { id: "clip", instruction: "用用地裁剪道路", setup: "pair", expectedTools: ["map.clip"] },
  { id: "stats", instruction: "统计道路要素数量", setup: "pair", expectedTools: ["map.stats"] },
  { id: "attr-query", instruction: "查询道路属性 名称=路", setup: "pair", expectedTools: ["map.query"] },
  { id: "intersect-query", instruction: "查询道路和用地相交", setup: "pair", expectedTools: ["map.query"] },
  { id: "style-fill", instruction: "把道路填充色改成红色", setup: "pair", expectedTools: ["map.style"] },
  { id: "hide", instruction: "隐藏用地", setup: "pair", expectedTools: ["map.setVisibility"] },
  { id: "show", instruction: "显示道路", setup: "pair", expectedTools: ["map.setVisibility"] },
  { id: "order-top", instruction: "把道路放到最上层", setup: "pair", expectedTools: ["map.setOrder"] },
  { id: "zoom", instruction: "缩放到道路", setup: "pair", expectedTools: ["map.zoomToLayer"] },
  { id: "export", instruction: "把道路导出为 GeoJSON", setup: "pair", expectedTools: ["map.exportGeoJson"] },
  { id: "quoted", instruction: "对「道路」做 100 米缓冲", setup: "pair", expectedTools: ["map.buffer"] },
  { id: "km", instruction: "对水域做 2 公里缓冲", setup: "pair", expectedTools: ["map.buffer"] },
  { id: "named-output", instruction: "给道路做 50 米缓冲区，结果叫道路缓冲", setup: "pair", expectedTools: ["map.buffer"] },
  { id: "clip-after-buffer", instruction: "对道路做 80 米缓冲后再用用地裁剪", setup: "pair", expectedTools: ["map.buffer", "map.clip"] },
  { id: "intersect-only", instruction: "道路和用地相交", setup: "pair", expectedTools: ["map.intersect"] },
  { id: "stats-field", instruction: "对道路统计字段 长度", setup: "pair", expectedTools: ["map.stats"] },
  { id: "opacity", instruction: "把用地透明度设为 0.3", setup: "pair", expectedTools: ["map.style"] },
  { id: "width", instruction: "把道路轮廓宽度改成 3", setup: "pair", expectedTools: ["map.style"] },
  { id: "list", instruction: "列出当前图层", setup: "pair", expectedTools: ["map.list"] },
  { id: "hide-zoom", instruction: "隐藏道路并缩放到用地", setup: "pair", expectedTools: ["map.setVisibility", "map.zoomToLayer"] },
  { id: "gdl-buffer", instruction: "请用 GDL：\nBUFFER 道路 100 m AS 道路缓冲", setup: "pair", expectedTools: ["gdl.run"] },
  { id: "gdl-describe", instruction: "用 GDL 描述图层道路", setup: "pair", expectedTools: ["gdl.describe"] },
  { id: "write-rag", instruction: "对道路做 200 米缓冲并写入知识库", setup: "pair", expectedTools: ["map.buffer"] },
  { id: "feet", instruction: "对道路做 30 英尺缓冲", setup: "pair", expectedTools: ["map.buffer"] },
  { id: "id-style", instruction: "对图层 道路 改填充色 #112233", setup: "pair", expectedTools: ["map.style"] },
  { id: "ambiguous", instruction: "对道路做 200 米缓冲", setup: "ambiguous", expectedTools: ["map.buffer"], expectAmbiguous: true },
  { id: "missing-layer", instruction: "对铁路做 200 米缓冲", setup: "pair", expectedTools: ["map.buffer"], expectAmbiguous: true },
  { id: "clarify", instruction: "做个 200 米缓冲", setup: "pair", expectedTools: [], expectClarify: true },
  { id: "empty-map", instruction: "对道路做 200 米缓冲", setup: "empty", expectedTools: ["map.buffer"], expectAmbiguous: true },
  { id: "export-land", instruction: "导出用地为 GeoJSON", setup: "pair", expectedTools: ["map.exportGeoJson"] },
  {
    id: "followup-area-a-area-b",
    instruction: "area-a和area-b",
    priorInstruction: "对当前图层做 200 米缓冲，再和另一图层相交",
    setup: "areas",
    expectedTools: ["map.buffer", "map.intersect"],
  },
];

const LINE: MapCollection = {
  type: "FeatureCollection",
  features: [{ type: "Feature", properties: { 名称: "路", 长度: 120 }, geometry: { type: "LineString", coordinates: [[116.3, 39.9], [116.31, 39.91]] } }],
};

const POLY: MapCollection = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    properties: { 名称: "地" },
    geometry: { type: "Polygon", coordinates: [[[116.29, 39.89], [116.33, 39.89], [116.33, 39.93], [116.29, 39.93], [116.29, 39.89]]] },
  }],
};

function hostProcess(): HostProcess {
  const candidate = (globalThis as { process?: HostProcess }).process;
  if (!candidate) throw new Error("评测需要 Node。");
  return candidate;
}

function layerContext(stack: SpatialStack): MapLayerContext[] {
  return stack.catalog.list().map((layer, index) => {
    const style = stack.catalog.style(layer.layerId);
    return {
      layerId: layer.layerId,
      layerName: layer.layerName,
      geometryKind: layer.geometryKind,
      featureCount: layer.featureCount,
      fieldNames: [...layer.fieldNames],
      crsLabel: layer.crsLabel,
      visible: style?.visible !== false,
      order: index,
      ...(style ? { fill: style.fill, outline: style.outline } : {}),
    };
  });
}

async function seed(stack: SpatialStack, setup: EvalCase["setup"]): Promise<void> {
  for (const layer of [...stack.catalog.list()]) {
    await stack.catalog.remove(layer.layerId);
  }
  if (setup === "empty") return;
  if (setup === "areas") {
    await stack.catalog.insert({ layerName: "area-a", sourcePaths: ["eval://area-a"], collection: POLY, crsLabel: "EPSG:4326" });
    await stack.catalog.insert({ layerName: "area-b", sourcePaths: ["eval://area-b"], collection: POLY, crsLabel: "EPSG:4326" });
    await stack.catalog.insert({ layerName: "area-a_空间查询", sourcePaths: ["eval://area-a-query"], collection: POLY, crsLabel: "EPSG:4326" });
    await stack.catalog.insert({ layerName: "area-a_裁剪", sourcePaths: ["eval://area-a-clip"], collection: POLY, crsLabel: "EPSG:4326" });
    return;
  }
  if (setup === "ambiguous") {
    await stack.catalog.insert({ layerName: "道路西段", sourcePaths: ["eval://west"], collection: LINE, crsLabel: "EPSG:4326" });
    await stack.catalog.insert({ layerName: "道路东段", sourcePaths: ["eval://east"], collection: LINE, crsLabel: "EPSG:4326" });
    return;
  }
  await stack.catalog.insert({ layerName: "道路", sourcePaths: ["eval://road"], collection: LINE, crsLabel: "EPSG:4326" });
  await stack.catalog.insert({ layerName: "用地", sourcePaths: ["eval://land"], collection: POLY, crsLabel: "EPSG:4326" });
  await stack.catalog.insert({ layerName: "水域", sourcePaths: ["eval://water"], collection: POLY, crsLabel: "EPSG:4326" });
}

function scoreCase(item: EvalCase, tools: readonly string[], codes: readonly string[]): number {
  if (item.expectClarify) return tools.length === 0 ? 1 : 0;
  if (item.expectAmbiguous) return codes.includes("ambiguous-layer") || codes.includes("unknown-layer") ? 1 : 0;
  if (item.expectedTools.length === 0) return tools.length === 0 ? 1 : 0;
  if (tools.join("|") === item.expectedTools.join("|")) return 1;
  if (item.expectedTools.every((name) => tools.includes(name))) return 0.5;
  if (tools[0] === item.expectedTools[0]) return 0.5;
  return 0;
}

function leak(text: string): boolean {
  return /116\.3|"coordinates"|POINT\(|POLYGON \(/.test(text);
}

async function runSuite(
  label: string,
  stack: SpatialStack,
  fetchImpl: LlmHttp,
  gdlDirectory: string,
): Promise<{ readonly label: string; readonly score: number; readonly total: number; readonly rows: readonly Record<string, unknown>[] }> {
  const gdlDeps: GdlDeps = {
    spatial: stack,
    gdlDirectory,
  };
  const adapter = createGdlAwareAdapter(
    createSpatialAwareAdapter({
      execute() {
        return Promise.resolve({ ok: false, message: "评测未执行文件查询工具。" });
      },
    }, stack.service),
    gdlDeps,
  );
  const rows: Record<string, unknown>[] = [];
  let score = 0;
  for (const item of CASES) {
    await seed(stack, item.setup);
    let mapLayers = layerContext(stack);
    const bodies: string[] = [];
    const fetchGate: LlmHttp = (url, init) => {
      bodies.push(init.body);
      if (leak(init.body)) throw new Error("发给模型的请求含有坐标。");
      return fetchImpl(url, init);
    };
    const runTurn = (question: string, priorInstruction?: string) => {
      const payload: Record<string, unknown> = { instruction: question, mapLayers };
      if (priorInstruction) payload.priorInstruction = priorInstruction;
      assertLlmPayload(payload);
      return runAssistantTurn({
        providerId: "local",
        model: "local-mock",
        baseUrl: "http://127.0.0.1:9/v1",
        env: {},
        timeoutMs: 20_000,
        maxRounds: 8,
        fetchImpl: fetchGate,
        adapter,
        tools: GIS_TOOL_REGISTRY,
        question,
        mapLayers,
        ...(priorInstruction ? { priorInstruction } : {}),
      });
    };
    let result;
    let planned: readonly string[] | undefined;
    if (item.priorInstruction) {
      const known = mapLayers.map((layer) => ({ layerId: layer.layerId, layerName: layer.layerName }));
      const first = resolveChatPlan({
        conversationId: "eval-followup",
        text: item.priorInstruction,
        pending: null,
        selectedLayer: null,
        knownLayers: known,
      });
      if (first.kind !== "clarify") throw new Error(`${item.id} 第一轮应写入 PendingPlan 并澄清。`);
      const second = resolveChatPlan({
        conversationId: "eval-followup",
        text: item.instruction,
        pending: first.pending,
        selectedLayer: null,
        knownLayers: known,
      });
      if (second.kind !== "execute") throw new Error(`${item.id} 第二轮应按 PendingPlan 执行。`);
      planned = second.calls.map((call) => call.name);
      result = await executePlannedCalls(second.calls, adapter);
    } else {
      result = await runTurn(item.instruction);
    }
    const tools = result.traces.filter((trace) => trace.ok).map((trace) => trace.tool);
    const codes = result.traces.map((trace) => trace.code ?? "");
    const gained = scoreCase(item, tools, codes);
    score += gained;
    rows.push({
      id: item.id,
      score: gained,
      tools,
      codes: codes.filter((code) => code !== ""),
      stopReason: result.stopReason,
      leaked: bodies.some((body) => leak(body)),
      ...(planned ? { planned } : {}),
      ...(item.priorInstruction ? { priorInstruction: item.priorInstruction, followup: item.instruction } : {}),
    });
  }
  return { label, score, total: CASES.length, rows };
}

function envHasKey(env: Readonly<Record<string, string | undefined>>): { readonly providerId: "deepseek" | "qwen" | "grok" | "local"; readonly apiKey: string } | null {
  if (env.DEEPSEEK_API_KEY && env.DEEPSEEK_API_KEY.trim() !== "") return { providerId: "deepseek", apiKey: env.DEEPSEEK_API_KEY.trim() };
  if (env.QWEN_API_KEY && env.QWEN_API_KEY.trim() !== "") return { providerId: "qwen", apiKey: env.QWEN_API_KEY.trim() };
  if (env.GROK_API_KEY && env.GROK_API_KEY.trim() !== "") return { providerId: "grok", apiKey: env.GROK_API_KEY.trim() };
  if (env.LOCAL_LLM_API_KEY && env.LOCAL_LLM_API_KEY.trim() !== "") return { providerId: "local", apiKey: env.LOCAL_LLM_API_KEY.trim() };
  return null;
}

export async function runAiEval(): Promise<void> {
  const proc = hostProcess();
  runLlmDispatchSelfCheck();
  await runLlmToolLoopSelfCheck();
  const directory = resolve(proc.cwd(), "var/tmp/ai-eval-layers");
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const stack = await openSpatialStack({
    layerDirectory: directory,
    auditDirectory: join(directory, "audit"),
    modelName: () => "local-mock",
  });
  try {
    const after = await runSuite("after", stack, createLocalChatMock(), join(directory, "gdl"));
    const before = await runSuite("before", stack, createLegacyLocalChatMock(), join(directory, "gdl"));
    const key = envHasKey(proc.env);
    let real: Record<string, unknown> = { ran: false, reason: "环境变量里没有可用的模型密钥。" };
    if (key) {
      await seed(stack, "pair");
      try {
        const turn = await runAssistantTurn({
          providerId: key.providerId,
          model: key.providerId === "deepseek" ? DEEPSEEK_PRESET_MODEL : key.providerId === "qwen" ? QWEN_PRESET_MODEL : key.providerId === "grok" ? GROK_PRESET_MODEL : "local-model",
          apiKey: key.apiKey,
          env: proc.env,
          timeoutMs: 30_000,
          maxRounds: 6,
          adapter: createSpatialAwareAdapter({
            execute() {
              return Promise.resolve({ ok: false, message: "评测未执行文件查询工具。" });
            },
          }, stack.service),
          tools: GIS_TOOL_REGISTRY,
          question: "对道路做 200 米缓冲，再与用地相交",
          mapLayers: layerContext(stack),
        });
        real = {
          ran: true,
          hasApiKey: true,
          providerId: key.providerId,
          tools: turn.traces.map((trace) => trace.tool),
          ok: turn.traces.some((trace) => trace.tool === "map.buffer" && trace.ok),
          stopReason: turn.stopReason,
        };
      } catch (error) {
        real = {
          ran: true,
          hasApiKey: true,
          providerId: key.providerId,
          ok: false,
          message: scrubSecrets(error instanceof Error ? error.message : "真实模型调用失败。", [key.apiKey]),
        };
      }
    }
    const followup = after.rows.find((row) => row.id === "followup-area-a-area-b");
    if (!followup || followup.score !== 1 || String(followup.tools) !== String(["map.buffer", "map.intersect"])) {
      throw new Error(`追问评测未走出缓冲再相交：${JSON.stringify(followup)}`);
    }
    const summary = {
      ok: true,
      caseCount: CASES.length,
      before: { score: before.score, total: before.total, percent: Number((before.score / before.total).toFixed(3)) },
      after: { score: after.score, total: after.total, percent: Number((after.score / after.total).toFixed(3)) },
      realModel: real,
      afterRows: after.rows,
      beforeRows: before.rows,
    };
    const outDir = resolve(proc.cwd(), "var/tmp");
    await mkdir(outDir, { recursive: true });
    const out = resolve(outDir, "ai-eval-v072.json");
    await writeFile(out, `${JSON.stringify(summary, null, 2)}\n`, { encoding: "utf8" });
    proc.stdout.write(`${JSON.stringify({ ok: true, before: summary.before, after: summary.after, followup: { tools: followup.tools, planned: followup.planned, score: followup.score }, realModel: { ran: Boolean(real.ran), hasApiKey: real.hasApiKey === true, ok: real.ok === true }, out }, null, 2)}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const argv1 = (globalThis as { process?: { argv?: string[] } }).process?.argv?.[1];
if (typeof argv1 === "string" && argv1.includes("ai-eval")) {
  void runAiEval().catch((error: unknown) => {
    const proc = hostProcess();
    proc.stderr.write(`${error instanceof Error ? error.message : "评测失败"}\n`);
    proc.exitCode = 1;
  });
}
