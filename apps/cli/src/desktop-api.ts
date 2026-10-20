// SPDX-License-Identifier: Apache-2.0

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { collectGisRagChunks } from "@igis/gis-tools";
import { GisIoReadError, GisIoRequestError } from "@igis/gis-io";
import {
  LlmInvokeError,
  createLocalChatMock,
  GIS_TOOL_REGISTRY,
  formatMapLayerContext,
  formatSelectedLayer,
  layersForConversationScope,
  runLocalFirstTurn,
  indexTrainingDirectory,
  isTrainErrorReport,
  isTrainingPackRequest,
  trainingPackModelText,
  trainingPackPaths,
  getLlmProviderProfile,
  DEEPSEEK_PRESET_BASE_URL,
  DEEPSEEK_PRESET_MODEL,
  listModelPresets,
  maskApiKey,
  resolveChatCompletionsUrl,
  resolveEffectiveLlmConfig,
  runAssistantTurn,
  scrubSecrets,
  toApiToolName,
  gateDestructive,
} from "@igis/llm-dispatch";
import type { ChatProgressEvent, ChatProgressHandler, GisToolDefinition, LlmMemoryOverride, ModelPresetId, ToolAdapterPort } from "@igis/llm-dispatch";
import { activateProModel, GEOLOGY_FILE, installProModel, listConversationRasterIds, listProModelSlots, ProModelError, rasterHandle, readOperationRecord, readSceneFile, recordNonSpatialOperation, rollbackOperation, runWithUserLocale, sceneForPage, SpatialOpError, spatialResultSink } from "@igis/spatial-ops";
import type { NonSpatialOperationKind, PublicMapLayer } from "@igis/spatial-ops";
import { isSensitiveFieldName, issueAndConsumeApproval } from "@igis/ai-boundary";
import type { ApprovalState } from "@igis/ai-boundary";
import { composeAdapters, connectExternalMcp } from "@igis/mcp-server";
import type { ExternalMcpSession } from "@igis/mcp-server";
import { handleV05Request, publicStoreLayer } from "./map-http.js";
import { handleGdlRequest } from "./gdl-http.js";
import { corsHeadersForAllowedPage, isAllowedOrigin, originFromHeader, requiresOriginGate } from "./origin-gate.js";
import type { LlmProviderId } from "@igis/shared-types";
import { buildSpatialAuditRecord } from "@igis/provenance";
import { RagStoreError } from "@igis/rag-meta";
import { ensureManagedGdalEnv, installEngines, readBootstrapError, savedPythonCommandForPanel, writeInterpreterSelection } from "@igis/external-gateway";
import { planarUnitToMeter } from "@igis/surtgis";
import { openGisWorkspace } from "./gis-runtime.js";
import { checkRuntimeEnvironment } from "./environment-check.js";
import type { EnvironmentReport } from "./environment-check.js";
import { dialogueBeforeCurrent } from "./conversation-dataset.js";
import { ConversationStore, assistantChatMessage, conversationDirectory, conversationWorkspaceDirectory, priorInstructionAfterClarification } from "./conversations.js";
import { rollbackChatTurn } from "./turn-rollback.js";
import type { ChatMessage, ChatTrace } from "./conversations.js";
import { MemoryRejectedError, UserMemoryStore, memoryDirectory } from "./user-memory.js";
import {
  DocumentError,
  addTextDocumentToRag,
  deleteProjectDocument,
  ensureDocumentDirs,
  listProjectDocuments,
  readProjectDocument,
} from "./documents.js";
import type { DocumentKind } from "./documents.js";

const DEFAULT_PORT = 39221;
const LEGACY_DEEPSEEK_CHOICE = "DeepSeek-V4.1-Flash";
const LOCAL_CHOICE = "local-mock";
const RAG_TEXT_LIMIT = 1024 * 1024;
const REQUEST_LIMIT = 2 * 1024 * 1024;
const GIS_UPLOAD_LIMIT = 1024 * 1024 * 1024;
const VECTOR_FILE = /\.(shp|shx|dbf|gdb|gpkg|mif|mid|tab|kml|kmz|dxf)$/i;

/** 非空间状态变更的留痕：桌面入口（local-user / desktop-ui）。 */
function auditDesktopChange(
  root: string,
  body: {
    readonly kind: NonSpatialOperationKind;
    readonly action: string;
    readonly inputResources?: readonly string[];
    readonly outputResources?: readonly string[];
    readonly ok: boolean;
    readonly message?: string;
    readonly approvalState?: ApprovalState;
  },
): Promise<string> {
  return recordNonSpatialOperation({
    ...body,
    entry: "map",
    source: "local-user",
    aiOrigin: false,
    translationUsed: false,
    requestSource: "desktop-ui",
    root,
  });
}

interface HostProcess {
  readonly argv: readonly string[];
  cwd(): string;
  env: Readonly<Record<string, string | undefined>>;
  exitCode?: number;
  stdout: { write(chunk: string): boolean };
  stderr: { write(chunk: string): boolean };
}

type ModelChoice = ModelPresetId;

interface DesktopSettings {
  readonly providerId: LlmProviderId;
  readonly model: string;
  readonly choice: ModelChoice;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly ragTopK: number;
  readonly ragEnabled: boolean;
  readonly externalCapabilitiesEnabled: boolean;
  /** 空字符串表示使用托管环境。非空是自定义解释器路径，不会改写那份 Python。 */
  readonly pythonCommand: string;
  readonly geometryReleaseDeclared: boolean;
  readonly unrestricted: boolean;
  readonly configured: boolean;
  readonly persist: boolean;
  readonly chatRatio: number;
  readonly fontSize: number;
  readonly mcpCommand: string;
  readonly mcpArgs: readonly string[];
  readonly locale: UiLocale;
  readonly developerMode: boolean;
}

type UiLocale = "zh-CN" | "en";

interface MiniResponse {
  readonly ok: boolean;
  readonly status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface MiniFetch {
  (url: string, init: {
    readonly method: "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly signal: AbortSignal;
  }): Promise<MiniResponse>;
}

class FriendlyHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "FriendlyHttpError";
    this.status = status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function ordinaryFeatures(collection: { readonly features?: readonly { readonly type?: unknown; readonly geometry?: unknown; readonly properties?: unknown }[] } | null, layerName: string, unrestricted = false): readonly unknown[] {
  if (!collection || (!unrestricted && /控制点|转换参数|军事禁区|重力点|大地控制/.test(layerName))) return [];
  const features = collection.features ?? [];
  const visible = unrestricted ? features : features.slice(0, 200);
  return visible.map((feature) => {
    const properties: Record<string, unknown> = {};
    if (feature.properties !== null && typeof feature.properties === "object" && !Array.isArray(feature.properties)) {
      for (const [key, item] of Object.entries(feature.properties)) {
        if (isSensitiveFieldName(key)) continue;
        if (typeof item === "string" || typeof item === "number" || typeof item === "boolean" || item === null) properties[key] = item;
      }
    }
    return {
      type: feature.type === "Feature" ? "Feature" : "Feature",
      ...(feature.geometry !== undefined ? { geometry: feature.geometry } : {}),
      properties,
    };
  });
}

function hostProcess(): HostProcess {
  const candidate = (globalThis as { process?: HostProcess }).process;
  if (!candidate) throw new Error("桌面接口需要 Node。");
  return candidate;
}

function isProviderId(value: unknown): value is LlmProviderId {
  return value === "deepseek" || value === "qwen" || value === "grok" || value === "local";
}

function presetById(id: ModelChoice) {
  return listModelPresets().find((item) => item.id === id);
}

function defaultSettings(): DesktopSettings {
  const preset = presetById("deepseek");
  return {
    providerId: "deepseek",
    model: preset?.model ?? DEEPSEEK_PRESET_MODEL,
    choice: "deepseek",
    baseUrl: preset?.baseUrl ?? DEEPSEEK_PRESET_BASE_URL,
    apiKey: "",
    ragTopK: 4,
    ragEnabled: false,
    externalCapabilitiesEnabled: true,
    pythonCommand: "",
    geometryReleaseDeclared: false,
    unrestricted: false,
    configured: false,
    persist: false,
    chatRatio: 52,
    fontSize: 14,
    mcpCommand: "",
    mcpArgs: [],
    locale: osLocale(),
    developerMode: false,
  };
}

function osLocale(): UiLocale {
  const raw = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase();
  return raw.startsWith("zh") ? "zh-CN" : "en";
}

function localeOf(value: unknown, fallback: UiLocale): UiLocale {
  if (value === "en" || value === "en-US") return "en";
  if (value === "zh-CN" || value === "zh" || value === "zh-Hans") return "zh-CN";
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, { encoding: "utf8" })) as unknown;
  } catch {
    return null;
  }
}

function integerInRange(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

function layoutRatio(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  if (rounded < 20 || rounded > 80) return fallback;
  return rounded;
}

function layoutFont(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  if (rounded < 12 || rounded > 20) return fallback;
  return rounded;
}

function parseMcpArgs(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item !== "")
      .slice(0, 20);
  }
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (trimmed === "") return [];
  return trimmed.split(/\s+/).filter((item) => item !== "").slice(0, 20);
}

function parseMcpCommand(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (trimmed.length > 300 || /[\r\n\u0000]/.test(trimmed)) return fallback;
  return trimmed;
}

function layoutOf(
  value: Record<string, unknown>,
  fallback: Pick<DesktopSettings, "chatRatio" | "fontSize" | "locale" | "developerMode">,
): Pick<DesktopSettings, "chatRatio" | "fontSize" | "locale" | "developerMode"> {
  return {
    chatRatio: layoutRatio(value.chatRatio, fallback.chatRatio),
    fontSize: layoutFont(value.fontSize, fallback.fontSize),
    locale: localeOf(value.locale, fallback.locale),
    developerMode: typeof value.developerMode === "boolean" ? value.developerMode : fallback.developerMode,
  };
}

function parsePythonCommand(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length > 300 || /[\r\n\u0000]/.test(trimmed)) return null;
  return trimmed;
}

function choiceFromSaved(choiceRaw: string, providerId: string, model: string): ModelChoice {
  if (model === LOCAL_CHOICE || choiceRaw === LOCAL_CHOICE || choiceRaw === "local-mock") return "local-mock";
  if (choiceRaw === "custom") return "custom";
  if (choiceRaw === "qwen") return "qwen";
  if (choiceRaw === "grok") return "grok";
  if (choiceRaw === "deepseek" || choiceRaw === LEGACY_DEEPSEEK_CHOICE) return "deepseek";
  if (providerId === "qwen") return "qwen";
  if (providerId === "grok") return "grok";
  if (providerId === "deepseek") return "deepseek";
  return "custom";
}

/** 只接受带 persist:true 的文件。没有这个标记时，重启后走环境变量，不把旧文件当成默认密钥库。 */
function loadPersisted(value: unknown): DesktopSettings | null {
  if (!isRecord(value) || value.persist !== true) return null;
  const ragTopK = integerInRange(value.ragTopK, 1, 20) ?? 4;
  const ragEnabled = value.ragEnabled === true;
  const externalCapabilitiesEnabled = value.externalCapabilitiesEnabled !== false;
  const layout = layoutOf(value, defaultSettings());
  const modelRaw = typeof value.model === "string" ? value.model.trim() : "";
  const choiceRaw = typeof value.choice === "string" ? value.choice.trim() : "";
  const providerRaw = typeof value.providerId === "string" ? value.providerId : "";
  const choice = choiceFromSaved(choiceRaw, providerRaw, modelRaw);
  if (choice === "local-mock") {
    return {
      providerId: "local",
      model: LOCAL_CHOICE,
      choice,
      baseUrl: "",
      apiKey: "",
      ragTopK,
      ragEnabled,
      externalCapabilitiesEnabled,
      geometryReleaseDeclared: value.geometryReleaseDeclared === true,
      unrestricted: value.unrestricted === true,
      pythonCommand: "",
      configured: true,
      persist: true,
      ...layout,
      mcpCommand: parseMcpCommand(value.mcpCommand, ""),
      mcpArgs: parseMcpArgs(value.mcpArgs),
    };
  }
  const preset = presetById(choice);
  const providerId = choice === "custom" ? (isProviderId(providerRaw) ? providerRaw : "local") : (preset?.providerId ?? "deepseek");
  const model = modelRaw !== "" && modelRaw !== LEGACY_DEEPSEEK_CHOICE ? modelRaw : (preset?.model ?? "");
  if (model === "" || model.length > 120) return null;
  const apiKey = typeof value.apiKey === "string" ? value.apiKey.trim() : "";
  const rawBase = typeof value.baseUrl === "string" ? value.baseUrl.trim() : "";
  const fallbackBase = preset?.baseUrl || getLlmProviderProfile(providerId).defaultBaseUrl || "";
  const baseUrl = rawBase === "" ? fallbackBase : safeBaseUrl(rawBase, apiKey, fallbackBase);
  if (baseUrl === "") return null;
  return {
    providerId,
    model,
    choice,
    baseUrl,
    apiKey,
    ragTopK,
    ragEnabled,
    externalCapabilitiesEnabled,
    pythonCommand: "",
    geometryReleaseDeclared: value.geometryReleaseDeclared === true,
    unrestricted: value.unrestricted === true,
    configured: true,
    persist: true,
    ...layout,
    mcpCommand: parseMcpCommand(value.mcpCommand, ""),
    mcpArgs: parseMcpArgs(value.mcpArgs),
  };
}

function assertHttpUrl(value: string, apiKey: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new FriendlyHttpError(400, "接口地址无效。");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new FriendlyHttpError(400, "接口地址只接受 http 或 https。");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new FriendlyHttpError(400, "接口地址无效。");
  }
  if (value.length > 500) {
    throw new FriendlyHttpError(400, "接口地址无效。");
  }
  const secret = apiKey.trim();
  if (secret.length >= 8 && value.includes(secret)) {
    throw new FriendlyHttpError(400, "接口地址无效。");
  }
  return value;
}

function safeBaseUrl(value: string, apiKey: string, fallback: string): string {
  try {
    return assertHttpUrl(value, apiKey);
  } catch {
    return fallback;
  }
}

function cleanModelName(value: string, apiKey: string): string {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > 120 || /[\r\n\u0000]/.test(trimmed)) {
    throw new FriendlyHttpError(400, "请填写模型名。");
  }
  const secret = apiKey.trim();
  if (secret.length >= 8 && trimmed.includes(secret)) {
    throw new FriendlyHttpError(400, "模型名无效。");
  }
  return trimmed;
}

function incomingSelection(body: Record<string, unknown>, previous: DesktopSettings): {
  choice: ModelChoice;
  providerId: LlmProviderId;
  model: string;
} {
  const rawModel = typeof body.model === "string" ? body.model.trim() : "";
  const rawChoice = typeof body.choice === "string" ? body.choice.trim() : "";
  if (rawModel === LOCAL_CHOICE || rawChoice === LOCAL_CHOICE || rawChoice === "local-mock") {
    return { choice: "local-mock", providerId: "local", model: LOCAL_CHOICE };
  }
  let choice: ModelChoice = "custom";
  if (rawChoice === "deepseek" || rawChoice === LEGACY_DEEPSEEK_CHOICE || rawModel === LEGACY_DEEPSEEK_CHOICE) choice = "deepseek";
  else if (rawChoice === "qwen") choice = "qwen";
  else if (rawChoice === "grok") choice = "grok";
  else if (rawChoice === "custom") choice = "custom";
  const preset = presetById(choice);
  const providerId = choice === "custom"
    ? (isProviderId(body.providerId) ? body.providerId : "local")
    : (preset?.providerId ?? "deepseek");
  const modelSource = rawModel === "" || rawModel === LEGACY_DEEPSEEK_CHOICE || rawModel === preset?.label
    ? (preset?.model || previous.model)
    : rawModel;
  return { choice, providerId, model: modelSource };
}

function applyUserConfig(body: Record<string, unknown>, previous: DesktopSettings, persist: boolean): DesktopSettings {
  const layout = layoutOf(body, previous);
  const selected = incomingSelection(body, previous);
  if (selected.choice === "local-mock") {
    return {
      providerId: "local",
      model: LOCAL_CHOICE,
      choice: "local-mock",
      baseUrl: "",
      apiKey: "",
      ragTopK: previous.ragTopK,
      ragEnabled: previous.ragEnabled,
      externalCapabilitiesEnabled: typeof body.externalCapabilitiesEnabled === "boolean" ? body.externalCapabilitiesEnabled : previous.externalCapabilitiesEnabled,
      pythonCommand: previous.pythonCommand,
      geometryReleaseDeclared: typeof body.geometryReleaseDeclared === "boolean" ? body.geometryReleaseDeclared : previous.geometryReleaseDeclared,
      unrestricted: typeof body.unrestricted === "boolean" ? body.unrestricted : previous.unrestricted,
      configured: true,
      persist,
      ...layout,
      mcpCommand: parseMcpCommand(body.mcpCommand, previous.mcpCommand),
      mcpArgs: body.mcpCommand !== undefined || body.mcpArgs !== undefined || body.mcpArgsText !== undefined ? parseMcpArgs(body.mcpArgs ?? body.mcpArgsText) : [...previous.mcpArgs],
    };
  }
  const submittedKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const apiKey = submittedKey !== "" ? submittedKey : previous.apiKey;
  const model = cleanModelName(selected.model, apiKey);
  const preset = presetById(selected.choice);
  const submittedBase = typeof body.apiBase === "string" ? body.apiBase.trim() : "";
  const previousBase = previous.choice === "local-mock" ? "" : previous.baseUrl.trim();
  let baseCandidate = submittedBase;
  if (baseCandidate === "" && selected.choice !== "custom") baseCandidate = preset?.baseUrl || previousBase;
  if (baseCandidate === "" && selected.choice === "custom") baseCandidate = previousBase;
  if (baseCandidate === "") baseCandidate = getLlmProviderProfile(selected.providerId).defaultBaseUrl ?? "";
  if (baseCandidate === "") throw new FriendlyHttpError(400, "请填写 API Base URL。");
  const baseUrl = assertHttpUrl(baseCandidate, apiKey);
  return {
    providerId: selected.providerId,
    model,
    choice: selected.choice,
    baseUrl,
    apiKey,
    ragTopK: previous.ragTopK,
    ragEnabled: previous.ragEnabled,
    externalCapabilitiesEnabled: typeof body.externalCapabilitiesEnabled === "boolean" ? body.externalCapabilitiesEnabled : previous.externalCapabilitiesEnabled,
    pythonCommand: previous.pythonCommand,
    geometryReleaseDeclared: typeof body.geometryReleaseDeclared === "boolean" ? body.geometryReleaseDeclared : previous.geometryReleaseDeclared,
    unrestricted: typeof body.unrestricted === "boolean" ? body.unrestricted : previous.unrestricted,
    configured: true,
    persist,
    ...layout,
    mcpCommand: parseMcpCommand(body.mcpCommand, previous.mcpCommand),
    mcpArgs: body.mcpCommand !== undefined || body.mcpArgs !== undefined || body.mcpArgsText !== undefined
      ? parseMcpArgs(body.mcpArgs ?? body.mcpArgsText)
      : [...previous.mcpArgs],
  };
}

function utf8Size(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function ragInput(body: Record<string, unknown>): { title: string; text: string } {
  const fileName = typeof body.fileName === "string" ? body.fileName.trim() : "";
  if (fileName !== "" && VECTOR_FILE.test(fileName)) {
    throw new FriendlyHttpError(400, "不能读取 shp、gdb、mif 等矢量文件。请上传纯文本。");
  }
  if (typeof body.text !== "string" || body.text.includes("\u0000")) {
    throw new FriendlyHttpError(400, "文件无法解析，请使用 UTF-8 文本。");
  }
  if (utf8Size(body.text) > RAG_TEXT_LIMIT) {
    throw new FriendlyHttpError(413, "文件太大，请上传 1MB 以内的文本。");
  }
  const titleFromBody = typeof body.title === "string" ? body.title.trim() : "";
  const titleFromFile = fileName.replace(/\.[^.]+$/, "").trim();
  const title = (titleFromBody || titleFromFile || "未命名文本").slice(0, 200);
  if (title.trim() === "") {
    throw new FriendlyHttpError(400, "文件无法解析，请使用 UTF-8 文本。");
  }
  return { title, text: body.text };
}

async function readBody(request: IncomingMessage, limit: number = REQUEST_LIMIT): Promise<unknown> {
  const parts: string[] = [];
  let size = 0;
  // 流式解码：TCP 分块可能切开 UTF-8 多字节序列（中文），逐块独立解码会产生 U+FFFD。
  const decoder = new TextDecoder();
  for await (const chunk of request) {
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    size += utf8Size(text);
    if (size > limit) {
      throw new FriendlyHttpError(413, "请求太大。");
    }
    parts.push(text);
  }
  parts.push(decoder.decode());
  const text = parts.join("");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new FriendlyHttpError(400, "请求无法解析。");
  }
}

interface MultipartUploadBody {
  readonly fields: Map<string, string>;
  readonly files: Map<string, Buffer>;
}

async function readMultipartUpload(request: IncomingMessage): Promise<MultipartUploadBody> {
  const contentType = request.headers["content-type"] ?? "";
  const boundaryMatch = /\bboundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (boundaryMatch?.[1] ?? boundaryMatch?.[2] ?? "").trim();
  if (!contentType.toLowerCase().startsWith("multipart/form-data") || boundary === "" || boundary.length > 200) {
    throw new FriendlyHttpError(400, "上传请求格式无效，请重试选择文件。");
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > GIS_UPLOAD_LIMIT) {
      request.resume();
      throw new FriendlyHttpError(413, "单次上传不能超过 1 GB。请压缩数据或分批上传。");
    }
    chunks.push(bytes);
  }

  const body = Buffer.concat(chunks, size);
  const marker = Buffer.from(`--${boundary}`);
  const separator = Buffer.from("\r\n\r\n");
  const fields = new Map<string, string>();
  const files = new Map<string, Buffer>();
  let position = body.indexOf(marker);
  if (position !== 0) throw new FriendlyHttpError(400, "上传内容无法解析，请重新选择文件。");

  while (position >= 0) {
    position += marker.length;
    if (body.subarray(position, position + 2).toString("ascii") === "--") break;
    if (body.subarray(position, position + 2).toString("ascii") !== "\r\n") {
      throw new FriendlyHttpError(400, "上传内容格式无效。");
    }
    position += 2;
    const headerEnd = body.indexOf(separator, position);
    if (headerEnd < 0) throw new FriendlyHttpError(400, "上传内容格式无效。");
    const headers = body.subarray(position, headerEnd).toString("latin1");
    const disposition = /content-disposition:\s*form-data;([^\r\n]+)/i.exec(headers)?.[1] ?? "";
    const fieldName = /\bname="([^\"]+)"/i.exec(disposition)?.[1];
    if (!fieldName) throw new FriendlyHttpError(400, "上传字段缺少名称。");
    const contentStart = headerEnd + separator.length;
    const nextMarker = body.indexOf(marker, contentStart);
    if (nextMarker < 2) throw new FriendlyHttpError(400, "上传内容不完整。");
    const contentEnd = nextMarker - 2;
    const hasFileName = /\bfilename="[^\"]*"/i.test(disposition);
    if (hasFileName) {
      if (files.has(fieldName)) throw new FriendlyHttpError(400, "上传文件字段重复。");
      files.set(fieldName, body.subarray(contentStart, contentEnd));
    } else {
      if (fields.has(fieldName)) throw new FriendlyHttpError(400, "上传字段重复。");
      fields.set(fieldName, body.subarray(contentStart, contentEnd).toString("utf8"));
    }
    position = nextMarker;
  }
  return { fields, files };
}

function safeUploadSegments(value: unknown): string[] {
  if (typeof value !== "string" || value.trim() === "") throw new FriendlyHttpError(400, "上传文件名无效。");
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-z]:/i.test(normalized) || normalized.includes("\0")) {
    throw new FriendlyHttpError(400, "上传文件名不能包含本机路径。");
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.includes(":"))) {
    throw new FriendlyHttpError(400, "上传文件路径无效。");
  }
  return segments;
}

const GIS_UPLOAD_PRIMARY_EXTENSIONS = new Set([".shp", ".geojson", ".json", ".gpkg", ".kml", ".kmz", ".mif", ".tab", ".dxf", ".tif", ".tiff"]);
const RASTER_UPLOAD = /\.tiff?$/i;

interface UploadedDatasetInspection {
  readonly path: string;
  readonly kind: string;
  readonly missing: readonly string[];
  readonly warnings: readonly string[];
}

function inspectUploadedDatasets(paths: readonly string[]): UploadedDatasetInspection[] {
  const exactPaths = new Set(paths.map((path) => path.toLocaleLowerCase("en-US")));
  const sourcePaths = paths.filter((path) => GIS_UPLOAD_PRIMARY_EXTENSIONS.has(extname(path).toLowerCase()));
  return sourcePaths.map((path) => {
    const extension = extname(path).toLowerCase();
    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
    const stem = basename(path, extname(path));
    const requiredSidecars = extension === ".shp" ? [".shx", ".dbf"] : extension === ".mif" ? [".mid"] : [];
    const missing: string[] = [];
    const warnings: string[] = [];

    for (const sidecar of requiredSidecars) {
      const expectedPath = `${folder}${stem}${sidecar}`;
      if (!exactPaths.has(expectedPath.toLocaleLowerCase("en-US"))) missing.push(expectedPath);
    }

    if (extension === ".shp") {
      const projectionPath = `${folder}${stem}.prj`;
      if (!exactPaths.has(projectionPath.toLocaleLowerCase("en-US"))) {
        warnings.push(`缺少 ${basename(projectionPath)} 坐标系文件（.prj），已按未声明载入：空间分析不可用；属性查询、统计和显示可用。`);
      }
    }

    return { path, kind: extension.slice(1).toUpperCase(), missing, warnings };
  });
}

function formatIncompleteUpload(datasets: readonly UploadedDatasetInspection[], paths: readonly string[]): string {
  const filesByFolder = new Map<string, string[]>();
  for (const path of paths) {
    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
    filesByFolder.set(folder, [...(filesByFolder.get(folder) ?? []), path]);
  }
  const details = datasets.map((dataset) => {
    const folder = dataset.path.includes("/") ? dataset.path.slice(0, dataset.path.lastIndexOf("/") + 1) : "";
    const stem = basename(dataset.path, extname(dataset.path));
    const normalizedStem = stem.replace(/\s+\(\d+\)$/u, "").toLocaleLowerCase("en-US");
    const mismatched = (filesByFolder.get(folder) ?? []).filter((candidate) => {
      const candidateExtension = extname(candidate).toLowerCase();
      const candidateStem = basename(candidate, extname(candidate)).replace(/\s+\(\d+\)$/u, "").toLocaleLowerCase("en-US");
      return candidate !== dataset.path && candidateStem === normalizedStem && dataset.missing.some((expected) => extname(expected).toLowerCase() === candidateExtension);
    });
    const mismatchText = mismatched.length > 0 ? `；已上传 ${mismatched.map((item) => basename(item)).join("、")}，但文件名与主文件不一致` : "";
    const warningText = dataset.warnings.length > 0 ? `；${dataset.warnings.join(" ")}` : "";
    const statusText = dataset.missing.length === 0 ? "文件齐全" : `缺少 ${dataset.missing.map((item) => basename(item)).join("、")}`;
    return `${basename(dataset.path)}：${statusText}${mismatchText}${warningText}`;
  });
  return `上传文件检查未通过，请补齐或改正后重试：\n${details.join("\n")}`;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function startSse(response: ServerResponse): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
}

function requestHeader(request: IncomingMessage, name: string): unknown {
  const bag = request as IncomingMessage & { headers?: Record<string, unknown> };
  return bag.headers?.[name];
}

function discardRequestBody(request: IncomingMessage): void {
  const stream = request as IncomingMessage & { resume?: () => void };
  if (typeof stream.resume === "function") stream.resume();
}

function rejectDisallowedOrigin(request: IncomingMessage, response: ServerResponse): void {
  discardRequestBody(request);
  response.writeHead(403, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify({ ok: false, message: "这个来源不能调用本机接口。" }));
}

function writeSse(response: ServerResponse, event: unknown): void {
  const sink = response as ServerResponse & { write(chunk: string): boolean };
  sink.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** 气泡上的「我：」只用于显示。存进对话时去掉这一层前缀。 */
function stripDisplayedRolePrefix(text: string): string {
  return text.replace(/^(?:我|Me)[：:]\s*/i, "");
}

/** 进行中的状态不是历史思考。结束后只保留模型推理正文。 */
function persistedThought(
  thought: string,
  thoughtKind: "reasoning" | "status" | undefined,
): { readonly thought?: string; readonly thoughtKind?: "reasoning" } {
  if (thoughtKind !== "reasoning") return {};
  const text = thought.trim();
  if (text === "" || text === "running_tools" || text === "understanding" || text === "starting") return {};
  return { thought: text, thoughtKind: "reasoning" };
}

function publicProgressEvent(event: ChatProgressEvent, secrets: readonly string[]): Record<string, unknown> {
  if (event.type === "thought") {
    if (event.kind === "reasoning") {
      const text = scrubSecrets(event.text, secrets);
      return { type: "thought", kind: "reasoning", text };
    }
    return { type: "thought", kind: "status", code: event.code };
  }
  if (event.type === "tool") {
    return {
      type: "tool",
      tool: event.tool,
      ok: event.ok,
      message: scrubSecrets(event.message, secrets),
      ...(event.layerName ? { layerName: event.layerName } : {}),
      ...(typeof event.durationMs === "number" ? { durationMs: event.durationMs } : {}),
    };
  }
  const text = scrubSecrets(event.text, secrets);
  return { type: "final", text };
}

function contentType(fileName: string): string {
  if (fileName.endsWith(".css")) return "text/css; charset=utf-8";
  if (fileName.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "text/html; charset=utf-8";
}

/**
 * Chat 按 operationId 读回操作记录，再把这个 id 放到助手轨迹上。
 * 读不到文件时仍保留工具结果里的 operationId。
 */
async function operationIdForChat(root: string, trace: { readonly tool: string; readonly operationId?: string }): Promise<string | undefined> {
  const tools = new Set(["map.buffer", "map.intersect", "map.clip", "map.query", "map.stats"]);
  if (!tools.has(trace.tool) || typeof trace.operationId !== "string" || trace.operationId === "") return undefined;
  const loaded = await readOperationRecord(trace.operationId, root);
  if (loaded && loaded.operationId === trace.operationId) return loaded.operationId;
  return trace.operationId;
}

function runtimeFetch(): MiniFetch {
  const candidate = (globalThis as { fetch?: MiniFetch }).fetch;
  if (typeof candidate !== "function") {
    throw new FriendlyHttpError(500, "当前运行时不能测试外部连接。");
  }
  return candidate;
}

async function main(): Promise<void> {
  const proc = hostProcess();
  const portFlag = proc.argv.indexOf("--port");
  const portToken = portFlag >= 0 ? proc.argv[portFlag + 1] : undefined;
  const port = portToken !== undefined && /^[0-9]+$/.test(portToken) ? Number(portToken) : DEFAULT_PORT;
  const root = proc.cwd();
  const settingsPath = resolve(root, "config/llm.local.json");
  const messagePath = resolve(root, "var/desktop/messages.json");
  const uiDir = resolve(root, "apps/desktop/ui");
  let settings = loadPersisted(await readJson(settingsPath)) ?? defaultSettings();
  settings = { ...settings, pythonCommand: savedPythonCommandForPanel(root) };
  void ensureManagedGdalEnv(root);
  const workspace = await openGisWorkspace(root, {
    modelName: () => settings.model,
    externalEnabled: settings.externalCapabilitiesEnabled,
    env: proc.env,
  });
  const { adapter, spatial, store, gdlDeps, ledger, external, engines } = workspace;
  const exportDirectory = resolve(root, "var/exports");
  const documentRoots = { gdl: gdlDeps.gdlDirectory, exports: exportDirectory };
  await ensureDocumentDirs(documentRoots);
  const conversations = new ConversationStore(conversationDirectory(root), messagePath);
  await conversations.load();
  spatial.catalog.detach();

  async function withConversation<T>(conversationId: string, run: () => Promise<T>): Promise<T> {
    if (!conversations.record(conversationId)) throw new FriendlyHttpError(400, settings.locale === "en" ? "This chat is no longer available. Switch chats and try again." : "当前对话已失效，请切换对话后重试。");
    return spatial.service.inConversation(conversationWorkspaceDirectory(root, conversationId), run);
  }
  const userMemory = new UserMemoryStore(memoryDirectory(root));
  await userMemory.load();
  let extraMcp: ExternalMcpSession | null = null;
  let extraMcpKey = "";

  function memoryOverride(): LlmMemoryOverride {
    return {
      active: settings.configured,
      providerId: settings.providerId,
      model: settings.model,
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
    };
  }

  function secretValues(extra: readonly string[] = []): string[] {
    const values: string[] = [];
    if (settings.apiKey.trim() !== "") values.push(settings.apiKey.trim());
    for (const name of ["DEEPSEEK_API_KEY", "QWEN_API_KEY", "GROK_API_KEY", "LOCAL_LLM_API_KEY"]) {
      const value = proc.env[name];
      if (typeof value === "string" && value.trim() !== "") values.push(value.trim());
    }
    for (const value of extra) {
      if (value.trim() !== "") values.push(value.trim());
    }
    return values;
  }

  function publicLlmConfig(): Readonly<Record<string, unknown>> {
    const effective = resolveEffectiveLlmConfig({ override: memoryOverride(), env: proc.env });
    const memoryKey = settings.apiKey.trim();
    const keySource = effective.localMock ? "none" : memoryKey !== "" ? "memory" : effective.apiKey !== "" ? "env" : "none";
    const choice = settings.configured ? settings.choice : "deepseek";
    const preset = presetById(choice);
    return {
      ok: true,
      model: effective.model,
      choice,
      label: preset?.label ?? effective.model,
      providerId: effective.providerId,
      modelId: effective.model,
      apiBase: effective.localMock ? "" : effective.baseUrl,
      apiKeyMask: keySource === "memory" ? maskApiKey(memoryKey) : "",
      hasApiKey: keySource !== "none",
      keySource,
      persist: settings.persist,
      source: effective.source,
      presets: listModelPresets(),
      ragTopK: settings.ragTopK,
      ragEnabled: settings.ragEnabled,
      chatRatio: settings.chatRatio,
      fontSize: settings.fontSize,
      mcpCommand: settings.mcpCommand,
      mcpArgs: [...settings.mcpArgs],
      mcpArgsText: settings.mcpArgs.join(" "),
      locale: settings.locale,
      developerMode: settings.developerMode,
      externalCapabilitiesEnabled: settings.externalCapabilitiesEnabled,
      pythonCommand: settings.pythonCommand,
      geometryReleaseDeclared: settings.geometryReleaseDeclared,
      unrestricted: settings.unrestricted,
    };
  }

  function publicSettings(): Readonly<Record<string, unknown>> {
    const view = publicLlmConfig();
    return {
      providerId: view.providerId,
      model: view.modelId,
      baseUrl: view.apiBase,
      hasApiKey: view.hasApiKey,
      ragTopK: view.ragTopK,
      ragEnabled: view.ragEnabled,
    };
  }

  async function writePersistedSettings(): Promise<void> {
    if (!settings.persist) return;
    await mkdir(resolve(root, "config"), { recursive: true });
    const payload = {
      persist: true,
      providerId: settings.providerId,
      model: settings.model,
      choice: settings.choice,
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      ragTopK: settings.ragTopK,
      ragEnabled: settings.ragEnabled,
      chatRatio: settings.chatRatio,
      fontSize: settings.fontSize,
      mcpCommand: settings.mcpCommand,
      mcpArgs: [...settings.mcpArgs],
      locale: settings.locale,
      developerMode: settings.developerMode,
      externalCapabilitiesEnabled: settings.externalCapabilitiesEnabled,
      geometryReleaseDeclared: settings.geometryReleaseDeclared,
      unrestricted: settings.unrestricted,
    };
    await writeFile(settingsPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8" });
  }

  async function removePersistedSettings(): Promise<void> {
    try {
      await rm(settingsPath, { recursive: true, force: true });
    } catch {
      throw new FriendlyHttpError(500, "没有完成配置保存。");
    }
  }

  async function extraMcpSession(): Promise<ExternalMcpSession | null> {
    const command = settings.mcpCommand.trim();
    const key = `${command}\n${settings.mcpArgs.join("\n")}`;
    if (command === "") {
      if (extraMcp) {
        await extraMcp.close();
        extraMcp = null;
      }
      extraMcpKey = "";
      return null;
    }
    if (key === extraMcpKey) return extraMcp;
    if (extraMcp) {
      await extraMcp.close();
      extraMcp = null;
    }
    extraMcpKey = key;
    extraMcp = await connectExternalMcp({ command, args: settings.mcpArgs });
    return extraMcp;
  }

  function documentKindOf(value: unknown): DocumentKind | null {
    return value === "rag" || value === "gdl" || value === "export" ? value : null;
  }

  async function testConnection(body: Record<string, unknown>): Promise<{ ok: boolean; message: string; httpStatus?: number }> {
    const rawChoice = typeof body.choice === "string" ? body.choice.trim() : "";
    const rawModel = typeof body.model === "string" ? body.model.trim() : "";
    if (rawModel === LOCAL_CHOICE || rawChoice === "local-mock" || rawChoice === LOCAL_CHOICE) {
      return { ok: true, message: "本地模拟可用，没有访问外部网络。" };
    }
    const providerId = isProviderId(body.providerId)
      ? body.providerId
      : (settings.model === LOCAL_CHOICE ? "deepseek" : settings.providerId);
    const profile = getLlmProviderProfile(providerId);
    const submittedKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    const envName = profile.apiKeyEnvVar;
    const envKey = typeof proc.env[envName] === "string" ? proc.env[envName].trim() : "";
    const apiKey = submittedKey !== "" ? submittedKey : (settings.apiKey.trim() !== "" ? settings.apiKey.trim() : envKey);
    if (apiKey === "" && profile.apiKeyRequired) {
      return { ok: false, message: `还没有 API 密钥。请填写密钥，或在服务进程中设置 ${envName}。` };
    }
    const submittedBase = typeof body.apiBase === "string" ? body.apiBase.trim() : "";
    const rememberedBase = settings.model === LOCAL_CHOICE ? "" : settings.baseUrl.trim();
    const preset = listModelPresets().find((item) => item.id === rawChoice);
    const fallbackBase = rememberedBase || preset?.baseUrl || profile.defaultBaseUrl || "";
    let endpoint = "";
    let modelName = rawModel;
    if (modelName === "" || modelName === LEGACY_DEEPSEEK_CHOICE || modelName === preset?.label) {
      modelName = preset?.model || settings.model;
    }
    if (modelName === "" || modelName === LOCAL_CHOICE) {
      return { ok: false, message: "请填写模型名。" };
    }
    try {
      const baseUrl = assertHttpUrl(submittedBase !== "" ? submittedBase : fallbackBase, apiKey);
      endpoint = resolveChatCompletionsUrl(baseUrl);
    } catch {
      return { ok: false, message: "接口地址无效。" };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey !== "") headers.Authorization = `Bearer ${apiKey}`;
    try {
      const response = await runtimeFetch()(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: modelName,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        }),
        signal: controller.signal,
      });
      try {
        await response.arrayBuffer();
      } catch {
        // 丢弃接口正文，避免把返回内容写进错误信息。
      }
      if (!response.ok) {
        return { ok: false, httpStatus: response.status, message: `HTTP ${response.status}` };
      }
      return { ok: true, message: "连接成功。" };
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      if (aborted) return { ok: false, message: "连接超时，请检查接口地址或网络。" };
      return { ok: false, message: scrubSecrets("连接失败，请检查接口地址或网络。", secretValues(submittedKey === "" ? [] : [submittedKey])) };
    } finally {
      clearTimeout(timer);
    }
  }

  const environmentReport: EnvironmentReport = await checkRuntimeEnvironment(root, proc.env);
  if (proc.env.IGIS_REQUIRE_LOCAL_RUNTIME === "1" && !environmentReport.requiredOk) {
    const missing = environmentReport.items.filter((item) => item.required && !item.ok).map((item) => item.message).join("；");
    proc.stderr.write(`${missing}\n`);
    proc.exitCode = 1;
    return;
  }

  const server = createServer((request, response) => {
    void runWithUserLocale(settings.locale, async () => {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
      let streamOpen = false;
      let chatOriginId = "";
      let chatUserStored = false;
      const origin = originFromHeader(requestHeader(request, "origin"));
      const method = request.method ?? "GET";
      if (!isAllowedOrigin(origin, port) && (method === "OPTIONS" || requiresOriginGate(method, url.pathname))) {
        rejectDisallowedOrigin(request, response);
        return;
      }
      if (method === "OPTIONS") {
        response.writeHead(204, {
          "Cache-Control": "no-store",
          "Content-Length": "0",
          ...corsHeadersForAllowedPage(origin, port),
        });
        response.end();
        return;
      }
      try {
        if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/connect.html" || url.pathname === "/app.js" || url.pathname === "/app.css" || url.pathname === "/i18n.js" || url.pathname === "/label-placement.js" || url.pathname === "/scene3d.js")) {
          const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
          const filePath = resolve(uiDir, name);
          const [bytes, stats] = await Promise.all([readFile(filePath), stat(filePath)]);
          // UI 文件随版本变化：ETag 协商缓存，未变时回 304，不重复传输。
          const etag = `W/"${stats.size.toString(16)}-${stats.mtimeMs.toString(16)}"`;
          if (requestHeader(request, "if-none-match") === etag) {
            response.writeHead(304, { ETag: etag, "Cache-Control": "no-cache" });
            response.end();
            return;
          }
          response.writeHead(200, { "Content-Type": contentType(name), "Cache-Control": "no-cache", ETag: etag });
          response.end(bytes);
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/health") {
          sendJson(response, 200, { ok: true, port });
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/environment") {
          sendJson(response, 200, environmentReport);
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/llm/config") {
          sendJson(response, 200, publicLlmConfig());
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/llm/config") {
          const body = await readBody(request);
          if (!isRecord(body)) {
            sendJson(response, 400, { ok: false, message: "请求正文必须是对象。" });
            return;
          }
          const persist = body.persist === true;
          settings = applyUserConfig(body, settings, persist);
          if (typeof body.pythonCommand === "string") {
            const pythonCommand = parsePythonCommand(body.pythonCommand);
            if (pythonCommand === null) {
              sendJson(response, 400, { ok: false, message: "Python 解释器路径无效。" });
              return;
            }
            settings = { ...settings, pythonCommand };
            await writeInterpreterSelection(root, pythonCommand);
          }
          external.setEnabled(settings.externalCapabilitiesEnabled);
          engines.setEnabled(settings.externalCapabilitiesEnabled);
          if (persist) await writePersistedSettings();
          else await removePersistedSettings();
          sendJson(response, 200, publicLlmConfig());
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/llm/test") {
          const body = await readBody(request);
          if (!isRecord(body)) {
            sendJson(response, 400, { ok: false, message: "请求正文必须是对象。" });
            return;
          }
          const result = await testConnection(body);
          sendJson(response, 200, result);
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/settings") {
          sendJson(response, 200, publicSettings());
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/external/status") {
          const status = await external.status();
          const bootstrapError = status.available ? "" : await readBootstrapError(root);
          const message = bootstrapError !== "" && !status.message.includes(bootstrapError.slice(0, 80))
            ? `${status.message} ${bootstrapError}`.slice(0, 500)
            : status.message;
          sendJson(response, 200, { ...status, message });
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/pro-model") {
          try {
            const library = await listProModelSlots(resolve(root, "var/models/igis-pro"));
            sendJson(response, 200, {
              ok: true,
              installed: library.model !== null,
              name: library.model?.name ?? "",
              activeId: library.activeId,
              slots: library.slots,
            });
          } catch (error) {
            const message = error instanceof ProModelError ? error.message : "权重文件无法读取。";
            sendJson(response, 200, { ok: true, installed: false, name: "", activeId: "", slots: [], message });
          }
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/pro-model") {
          const body = await readBody(request);
          const directory = resolve(root, "var/models/igis-pro");
          try {
            const model = isRecord(body) && body.action === "activate" && typeof body.id === "string"
              ? await activateProModel(directory, body.id)
              : await installProModel(directory, body);
            const library = await listProModelSlots(directory);
            sendJson(response, 200, {
              ok: true,
              installed: true,
              name: model.name,
              activeId: library.activeId,
              slots: library.slots,
            });
          } catch (error) {
            const message = error instanceof ProModelError ? error.message : "权重没有安装。";
            sendJson(response, 400, { ok: false, message });
          }
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/scene") {
          const conversationId = url.searchParams.get("conversationId") ?? "";
          const record = conversations.record(conversationId);
          if (!record) throw new FriendlyHttpError(404, "找不到这个对话。");
          const workspace = conversationWorkspaceDirectory(root, conversationId);
          const scene = await readSceneFile(workspace);
          const ids = Array.isArray(record.workspaceLayerIds) ? record.workspaceLayerIds : [];
          const layers = await withConversation(conversationId, async () => ids.filter((id): id is string => typeof id === "string").map((id) => {
            const meta = spatial.catalog.get(id);
            return { layerId: id, layerName: meta?.layerName ?? id };
          }));
          let rasterNames: string[] = [];
          try {
            rasterNames = await readdir(join(workspace, "rasters"));
          } catch {
            rasterNames = [];
          }
          const grouped = new Map<string, number>();
          for (const name of rasterNames) {
            if (!/\.tiff?$/i.test(name)) continue;
            const handle = rasterHandle(name);
            grouped.set(handle, (grouped.get(handle) ?? 0) + 1);
          }
          const handles: string[] = [];
          let collided = false;
          for (const [handle, count] of grouped) {
            if (count === 1) handles.push(handle);
            else collided = true;
          }
          sendJson(response, 200, sceneForPage({ layers, handles, collided, scene }));
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/scene/terrain") {
          const conversationId = url.searchParams.get("conversationId") ?? "";
          if (!conversations.record(conversationId)) throw new FriendlyHttpError(404, "找不到这个对话。");
          const handle = (url.searchParams.get("handle") ?? "").trim().toLowerCase();
          const series = (url.searchParams.get("series") ?? "").trim();
          if (handle !== "" && !/^ras-[0-9a-f]{10}$/.test(handle)) throw new FriendlyHttpError(400, "栅格句柄不合法。");
          if (handle === "" && !/^[a-z]+(-\d+)?$/.test(series)) throw new FriendlyHttpError(400, "需要栅格句柄或情景编号。");
          const workspaceDir = conversationWorkspaceDirectory(root, conversationId);
          try {
            const grid = await spatial.service.usingConversationWorkspace(workspaceDir, async () => {
              const name = handle !== "" ? handle : await spatial.service.seriesTerrain(series);
              if (!name) throw new FriendlyHttpError(404, "这个情景没有登记地形。");
              return spatial.service.terrainGrid(name, 160);
            });
            sendJson(response, 200, { ok: true, ...grid });
          } catch (error) {
            if (error instanceof FriendlyHttpError) throw error;
            sendJson(response, 400, { ok: false, message: error instanceof Error ? error.message.slice(0, 300) : "三维地形读取失败。" });
          }
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/scene/geology") {
          const conversationId = url.searchParams.get("conversationId") ?? "";
          if (!conversations.record(conversationId)) throw new FriendlyHttpError(404, "找不到这个对话。");
          try {
            const text = await readFile(join(conversationWorkspaceDirectory(root, conversationId), GEOLOGY_FILE), { encoding: "utf8" });
            sendJson(response, 200, { ok: true, ...(JSON.parse(text) as Record<string, unknown>) });
          } catch {
            sendJson(response, 404, { ok: false, message: "这个对话还没有地层体。" });
          }
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/engines") {
          sendJson(response, 200, await engines.status());
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/engines/install") {
          const installed = await installEngines(root);
          const status = await engines.status();
          sendJson(response, installed.ok ? 200 : 500, { ...status, ok: installed.ok, message: installed.ok ? `${installed.message}${status.message}` : installed.message });
          return;
        }
        if (request.method === "PUT" && url.pathname === "/api/settings") {
          const body = await readBody(request);
          if (!isRecord(body)) {
            sendJson(response, 400, { ok: false, message: "请求正文必须是对象。" });
            return;
          }
          const ragTopK = integerInRange(body.ragTopK, 1, 20) ?? settings.ragTopK;
          const ragEnabled = typeof body.ragEnabled === "boolean" ? body.ragEnabled : settings.ragEnabled;
          settings = { ...settings, ragTopK, ragEnabled };
          if (settings.persist) await writePersistedSettings();
          sendJson(response, 200, publicSettings());
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/messages") {
          sendJson(response, 200, { messages: conversations.messages(), conversationId: conversations.active().id });
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/conversations") {
          sendJson(response, 200, { ok: true, ...conversations.list() });
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/conversations/checkpoints") {
          const conversationId = url.searchParams.get("conversationId") ?? conversations.active().id;
          if (!conversations.record(conversationId)) throw new FriendlyHttpError(404, "找不到这个对话。");
          sendJson(response, 200, { ok: true, checkpoints: conversations.checkpointsFor(conversationId) });
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/workspace/layers") {
          const conversationId = url.searchParams.get("conversationId") ?? "";
          const record = conversations.record(conversationId);
          if (!record) throw new FriendlyHttpError(404, "找不到这个对话。");
          sendJson(response, 200, { ok: true, layerIds: record.workspaceLayerIds ?? [] });
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/workspace/files") {
          const conversationId = url.searchParams.get("conversationId") ?? "";
          const record = conversations.record(conversationId);
          if (!record) throw new FriendlyHttpError(404, "找不到这个对话。");
          sendJson(response, 200, { ok: true, files: record.workspaceFileNames ?? [] });
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/conversations") {
          const body = await readBody(request);
          const title = isRecord(body) && typeof body.title === "string" ? body.title : undefined;
          const created = await conversations.create(title);
          sendJson(response, 200, { ok: true, conversation: created, ...conversations.list(), messages: created.messages });
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/conversations/switch") {
          const body = await readBody(request);
          if (!isRecord(body) || typeof body.id !== "string") {
            sendJson(response, 400, { ok: false, message: "需要对话编号。" });
            return;
          }
          const current = await conversations.switchTo(body.id.trim());
          sendJson(response, 200, { ok: true, conversation: current, ...conversations.list(), messages: current.messages });
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/conversations/rename") {
          const body = await readBody(request);
          if (!isRecord(body) || typeof body.id !== "string" || typeof body.title !== "string") {
            sendJson(response, 400, { ok: false, message: "需要对话编号和新名称。" });
            return;
          }
          const renamed = await conversations.rename(body.id.trim(), body.title);
          sendJson(response, 200, { ok: true, conversation: renamed, ...conversations.list() });
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/conversations/delete") {
          const body = await readBody(request);
          if (!isRecord(body) || typeof body.id !== "string") {
            sendJson(response, 400, { ok: false, message: "需要对话编号。" });
            return;
          }
          const conversationId = body.id.trim();
          const record = conversations.record(conversationId);
          if (!record) throw new FriendlyHttpError(404, "找不到这个对话。");
          const workspace = conversationWorkspaceDirectory(root, conversationId);
          spatial.service.releaseConversation(workspace);
          await rm(workspace, { recursive: true, force: true });
          const listed = await conversations.remove(conversationId);
          sendJson(response, 200, { ok: true, ...listed, messages: conversations.messages() });
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/conversations/rollback") {
          const activeConversationId = conversations.active().id;
          const result = await withConversation(activeConversationId, async () => {
          const layerNames = new Map(spatial.catalog.list().map((layer) => [layer.layerId, layer.layerName] as const));
          const rolled = await rollbackChatTurn({
            conversations,
            removeLayer: async (layerId) => spatial.catalog.remove(layerId),
            deleteRag: async (entryId) => store.delete(entryId),
            deleteAudit: async (recordId) => spatial.audit.remove(recordId),
            rollbackOperation: (operationId) => rollbackOperation(operationId, {
              root,
              removeLayer: async (layerId) => spatial.catalog.remove(layerId),
              deleteKnowledge: async (entryId) => store.delete(entryId),
              dropCacheKey: (key, resultLayerIds) => spatial.service.dropOwnedCacheKey(key, resultLayerIds),
              deleteSuccessAudit: async (recordId) => spatial.audit.remove(recordId),
            }),
          });
          const removedLayers = rolled.removedLayerIds.map((layerId) => ({
            layerId,
            layerName: layerNames.get(layerId) ?? layerId,
          }));
          if (rolled.ok) {
            try {
              await spatial.audit.append(buildSpatialAuditRecord({
                operationType: "rollback",
                inputLayerNames: removedLayers.map((layer) => layer.layerName),
                parameters: {},
                outputFilePath: null,
                modelName: settings.model.trim() === "" ? "local-mock" : settings.model,
                layerId: removedLayers[0]?.layerId ?? null,
                success: true,
                note: `回退上一轮助手回复，删除本轮生成图层 ${removedLayers.length} 个。`,
              }));
            } catch {
              // 审计失败不影响回退。
            }
          }
          sendJson(response, 200, {
            ok: rolled.ok,
            message: rolled.message,
            messages: conversations.messages(),
            removedLayerIds: removedLayers.map((layer) => layer.layerId),
            removedLayerNames: removedLayers.map((layer) => layer.layerName),
            completed: rolled.completed,
            unfinished: rolled.unfinished,
          });
          });
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/conversations/rollback-checkpoint") {
          const body = await readBody(request);
          if (!isRecord(body) || typeof body.checkpointId !== "string") {
            throw new FriendlyHttpError(400, "需要检查点编号。");
          }
          const record = conversations.active();
          if (record.pendingRollback) throw new FriendlyHttpError(409, "上一轮回退尚未完成，请先完成或重试回退。");
          const checkpoint = conversations.checkpointsFor(record.id).find((item) => item.id === body.checkpointId);
          if (!checkpoint) throw new FriendlyHttpError(404, "找不到这个检查点。");
          if (checkpoint.messageCount > record.messages.length) throw new FriendlyHttpError(409, "检查点与当前对话历史不匹配。");
          if (checkpoint.messageCount > 0 && record.messages[checkpoint.messageCount - 1]?.role !== "assistant") {
            throw new FriendlyHttpError(409, "检查点没有落在完整轮次边界，无法安全回退。");
          }
          const removedLayerIds: string[] = [];
          const rolledBack = await withConversation(record.id, async () => {
          while (conversations.messages().length > checkpoint.messageCount) {
            const result = await rollbackChatTurn({
              conversations,
              removeLayer: async (layerId) => spatial.catalog.remove(layerId),
              deleteRag: async (entryId) => store.delete(entryId),
              deleteAudit: async (recordId) => spatial.audit.remove(recordId),
              rollbackOperation: (operationId) => rollbackOperation(operationId, {
                root,
                removeLayer: async (layerId) => spatial.catalog.remove(layerId),
                deleteKnowledge: async (entryId) => store.delete(entryId),
                dropCacheKey: (key, resultLayerIds) => spatial.service.dropOwnedCacheKey(key, resultLayerIds),
                deleteSuccessAudit: async (recordId) => spatial.audit.remove(recordId),
              }),
            });
            removedLayerIds.push(...result.removedLayerIds);
            if (!result.ok) {
              sendJson(response, 200, { ok: false, message: result.message, messages: conversations.messages(), removedLayerIds });
              return false;
            }
          }
          if (conversations.messages().length !== checkpoint.messageCount) {
            throw new FriendlyHttpError(409, "检查点没有落在完整轮次边界，已停止回退。");
          }
          await conversations.restoreCheckpointState(record.id, checkpoint.id);
          const layerNames = new Map(spatial.catalog.list().map((layer) => [layer.layerId, layer.layerName] as const));
          sendJson(response, 200, {
            ok: true,
            message: "已回退到检查点。原指令已放回输入框，请确认后重新运行。",
            messages: conversations.messages(),
            replayText: checkpoint.replayText,
            removedLayerIds,
            removedLayerNames: removedLayerIds.map((layerId) => layerNames.get(layerId) ?? layerId),
          });
          return true;
          });
          if (rolledBack === false) return;
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/memory") {
          sendJson(response, 200, { ok: true, items: userMemory.list() });
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/memory/add") {
          const body = await readBody(request);
          if (!isRecord(body) || typeof body.text !== "string") {
            sendJson(response, 400, { ok: false, message: "请填写要记住的内容。" });
            return;
          }
          try {
            const item = await userMemory.add(body.text);
            sendJson(response, 200, { ok: true, item, items: userMemory.list() });
          } catch (error) {
            if (error instanceof MemoryRejectedError) {
              sendJson(response, 400, { ok: false, message: error.message });
              return;
            }
            throw error;
          }
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/memory/delete") {
          const body = await readBody(request);
          if (!isRecord(body) || typeof body.id !== "string") {
            sendJson(response, 400, { ok: false, message: "需要记忆编号。" });
            return;
          }
          const removed = await userMemory.remove(body.id.trim());
          if (!removed) {
            sendJson(response, 404, { ok: false, message: "找不到这条记忆。" });
            return;
          }
          sendJson(response, 200, { ok: true, items: userMemory.list() });
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/documents") {
          try {
            const documents = await listProjectDocuments(store, documentRoots);
            sendJson(response, 200, { ok: true, documents });
          } catch (error) {
            if (error instanceof DocumentError) {
              sendJson(response, error.status, { ok: false, message: error.message });
              return;
            }
            sendJson(response, 500, { ok: false, message: "文档列表暂时读不出来。" });
          }
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/documents/delete") {
          const body = await readBody(request);
          const kind = isRecord(body) ? documentKindOf(body.kind) : null;
          const id = isRecord(body) && typeof body.id === "string" ? body.id.trim() : "";
          if (!kind || id === "") {
            sendJson(response, 400, { ok: false, message: "需要文档种类和编号。" });
            return;
          }
          try {
            await deleteProjectDocument(store, documentRoots, kind, id);
            const operationId = await auditDesktopChange(root, {
              kind: "delete",
              action: "document-delete",
              inputResources: [id],
              ok: true,
            });
            sendJson(response, 200, { ok: true, documents: await listProjectDocuments(store, documentRoots), operationId });
          } catch (error) {
            const message = error instanceof DocumentError
              ? error.message
              : error instanceof RagStoreError ? error.message : "这个文件没有删除。";
            await auditDesktopChange(root, {
              kind: "delete",
              action: "document-delete",
              inputResources: [id],
              ok: false,
              message,
            }).catch(() => undefined);
            if (error instanceof DocumentError) {
              sendJson(response, error.status, { ok: false, message: error.message });
              return;
            }
            sendJson(response, 400, { ok: false, message });
          }
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/documents/add") {
          const body = await readBody(request);
          if (!isRecord(body)) {
            sendJson(response, 400, { ok: false, message: "请求正文必须是对象。" });
            return;
          }
          try {
            const input = ragInput(body);
            const added = await addTextDocumentToRag(store, { title: input.title, text: input.text, fileName: typeof body.fileName === "string" ? body.fileName : "" });
            sendJson(response, 200, { ok: true, ...added, documents: await listProjectDocuments(store, documentRoots) });
          } catch (error) {
            if (error instanceof DocumentError) {
              sendJson(response, error.status, { ok: false, message: error.message });
              return;
            }
            if (error instanceof FriendlyHttpError) throw error;
            const message = error instanceof RagStoreError
              ? error.message
              : "文件无法解析，请使用 UTF-8 文本。";
            sendJson(response, 400, { ok: false, message });
          }
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/documents/file") {
          const kind = documentKindOf(url.searchParams.get("kind"));
          const id = url.searchParams.get("id") ?? "";
          if (!kind || id.trim() === "") {
            sendJson(response, 400, { ok: false, message: "需要文档种类和编号。" });
            return;
          }
          try {
            const file = await readProjectDocument(documentRoots, kind, id);
            response.writeHead(200, {
              "Content-Type": file.contentType,
              "Content-Disposition": `attachment; filename="${file.fileName}"`,
              "Cache-Control": "no-store",
            });
            response.end(file.bytes);
          } catch (error) {
            if (error instanceof DocumentError) {
              sendJson(response, error.status, { ok: false, message: error.message });
              return;
            }
            sendJson(response, 500, { ok: false, message: "文件读不出来。" });
          }
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/rag/documents") {
          try {
            const documents = await store.list();
            sendJson(response, 200, { ok: true, documents });
          } catch {
            sendJson(response, 500, { ok: false, message: "知识库暂时读不出来，请稍后再试。" });
          }
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/rag/add") {
          const body = await readBody(request);
          if (!isRecord(body)) {
            sendJson(response, 400, { ok: false, message: "请求正文必须是对象。" });
            return;
          }
          try {
            const input = ragInput(body);
            const added = await store.add({ title: input.title, body: input.text, kind: "text" });
            sendJson(response, 200, { ok: true, entryId: added.entryId, chunkCount: added.chunkCount });
          } catch (error) {
            if (error instanceof FriendlyHttpError) throw error;
            const message = error instanceof RagStoreError
              ? error.message
              : "文件无法解析，请使用 UTF-8 文本。";
            sendJson(response, 400, { ok: false, message });
          }
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/rag/delete") {
          const body = await readBody(request);
          if (!isRecord(body) || typeof body.entryId !== "string" || body.entryId.trim() === "") {
            sendJson(response, 400, { ok: false, message: "需要文档编号。" });
            return;
          }
          try {
            const entryId = body.entryId.trim();
            const removed = await store.delete(entryId);
            const operationId = await auditDesktopChange(root, {
              kind: "delete",
              action: "knowledge-delete",
              inputResources: [entryId],
              ok: removed,
              ...(removed ? {} : { message: "找不到这篇文档。" }),
            });
            if (!removed) {
              sendJson(response, 404, { ok: false, message: "找不到这篇文档。", operationId });
              return;
            }
            sendJson(response, 200, { ok: true, entryId, removed: true, operationId });
          } catch (error) {
            const message = error instanceof RagStoreError ? error.message : "这篇文档没有删除。";
            await auditDesktopChange(root, {
              kind: "delete",
              action: "knowledge-delete",
              inputResources: [body.entryId.trim()],
              ok: false,
              message,
            }).catch(() => undefined);
            sendJson(response, 400, { ok: false, message });
          }
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/rag/clear") {
          let approval: ApprovalState | undefined;
          try {
            const body = await readBody(request);
            // 这个 confirm 来自桌面界面里用户点过确认，不是模型或 MCP 参数。
            const confirmed = isRecord(body) && body.confirm === true;
            const gate = gateDestructive("drop-database", confirmed);
            if (!gate.ok) {
              sendJson(response, 409, { ok: false, code: gate.code, message: gate.message });
              return;
            }
            // 授权契约：用户确认产生一次性 ApprovalToken 并立即消费。
            approval = issueAndConsumeApproval("drop-database:all", "local-ui");
            await store.clear();
            const operationId = await auditDesktopChange(root, {
              kind: "delete",
              action: "drop-database",
              approvalState: approval,
              ok: true,
            });
            sendJson(response, 200, { ok: true, cleared: true, operationId });
          } catch {
            await auditDesktopChange(root, {
              kind: "delete",
              action: "drop-database",
              ok: false,
              message: "知识库没有清空，请稍后再试。",
              ...(approval ? { approvalState: approval } : {}),
            }).catch(() => undefined);
            sendJson(response, 500, { ok: false, message: "知识库没有清空，请稍后再试。" });
          }
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/import") {
          const body = await readBody(request);
          if (!isRecord(body) || typeof body.absolutePath !== "string" || body.absolutePath.trim() === "") {
            sendJson(response, 400, { ok: false, message: settings.locale === "en" ? "A GIS file path is required." : "需要 GIS 文件路径。" });
            return;
          }
          try {
            const chunks = await collectGisRagChunks(body.absolutePath, ledger);
            const indexed: string[] = [];
            const importAuditId = await auditDesktopChange(root, {
              kind: "import",
              action: "import-file",
              inputResources: [body.absolutePath],
              outputResources: indexed,
              ok: true,
            });
            sendJson(response, 200, {
              ok: true,
              indexed: false,
              entryIds: indexed,
              chunks: chunks.map((chunk) => ({ title: chunk.title, layerNames: chunk.layerNames })),
              operationId: importAuditId,
            });
          } catch (error) {
            await auditDesktopChange(root, {
              kind: "import",
              action: "import-file",
              inputResources: [body.absolutePath],
              ok: false,
              message: error instanceof Error ? error.message : (settings.locale === "en" ? "Import did not finish." : "导入没有完成。"),
            }).catch(() => undefined);
            throw error;
          }
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/import/upload") {
          let uploadDirectory = "";
          let preserveUpload = false;
          try {
            const { fields, files } = await readMultipartUpload(request);
            let manifest: unknown;
            try {
              manifest = JSON.parse(fields.get("metadata") ?? "");
            } catch {
              throw new FriendlyHttpError(400, settings.locale === "en" ? "The upload description is invalid. Choose the files again." : "上传信息无效，请重新选择文件。");
            }
            if (!isRecord(manifest) || !Array.isArray(manifest.files)) {
              throw new FriendlyHttpError(400, settings.locale === "en" ? "The upload description is incomplete." : "上传信息不完整。");
            }
            const conversationId = typeof manifest.conversationId === "string" ? manifest.conversationId : "";
            if (!conversations.record(conversationId)) throw new FriendlyHttpError(400, settings.locale === "en" ? "This chat is no longer available. Switch chats and try again." : "当前对话已失效，请切换对话后重试。");
            if (manifest.files.length === 0 || manifest.files.length > 256 || files.size !== manifest.files.length) {
              throw new FriendlyHttpError(400, settings.locale === "en" ? "Choose 1 to 256 data files, then upload." : "请选择 1 到 256 个数据文件后再上传。");
            }

            uploadDirectory = resolve(conversationWorkspaceDirectory(root, conversationId), "imports", randomUUID());
            await mkdir(uploadDirectory, { recursive: true });
            const savedPaths = new Set<string>();
            const savedPathKeys = new Set<string>();
            const savedFields = new Set<string>();
            let totalBytes = 0;
            for (const item of manifest.files) {
              if (!isRecord(item) || typeof item.field !== "string") throw new FriendlyHttpError(400, "上传文件清单无效。");
              if (savedFields.has(item.field)) throw new FriendlyHttpError(400, "上传文件清单中有重复项目。");
              const bytes = files.get(item.field);
              if (!bytes) throw new FriendlyHttpError(400, "上传内容缺少文件，请重试。");
              totalBytes += bytes.byteLength;
              if (totalBytes > GIS_UPLOAD_LIMIT) throw new FriendlyHttpError(413, "单次上传不能超过 1 GB。");
              const segments = safeUploadSegments(item.relativePath);
              const relativePath = segments.join("/");
              const relativePathKey = relativePath.toLocaleLowerCase("en-US");
              if (savedPathKeys.has(relativePathKey)) throw new FriendlyHttpError(400, "上传文件中有重名，请检查所选文件。");
              const targetPath = resolve(uploadDirectory, ...segments);
              const uploadRoot = `${resolve(uploadDirectory)}${sep}`;
              if (!targetPath.toLowerCase().startsWith(uploadRoot.toLowerCase())) throw new FriendlyHttpError(400, "上传文件路径无效。");
              await mkdir(dirname(targetPath), { recursive: true });
              await writeFile(targetPath, bytes, { flag: "wx" });
              savedPaths.add(relativePath);
              savedPathKeys.add(relativePathKey);
              savedFields.add(item.field);
            }

            const datasets = inspectUploadedDatasets([...savedPaths]);
            const rasterPaths = [...savedPaths].filter((path) => RASTER_UPLOAD.test(path));
            if (datasets.length === 0) {
              const sidecars = [...savedPaths].filter((path) => [".shx", ".dbf", ".prj", ".cpg", ".sbn", ".sbx"].includes(extname(path).toLowerCase()));
              if (sidecars.length > 0) {
                throw new FriendlyHttpError(400, `收到的都是配套文件，没有找到图层主文件 .shp：\n${sidecars.map((path) => basename(path)).join("、")}`);
              }
              throw new FriendlyHttpError(400, "没有识别到 GIS 图层主文件。请选择 .shp、.geojson、.gpkg、.tif 等数据文件，并可同时选择配套文件。");
            }
            const ready = datasets.filter((dataset) => dataset.missing.length === 0);
            if (ready.length === 0) throw new FriendlyHttpError(400, formatIncompleteUpload(datasets, [...savedPaths]));

            const chunksByDataset: { readonly dataset: UploadedDatasetInspection; readonly chunks: Awaited<ReturnType<typeof collectGisRagChunks>> }[] = [];
            for (const dataset of ready) {
              if (RASTER_UPLOAD.test(dataset.path)) continue;
              const datasetPath = resolve(uploadDirectory, ...safeUploadSegments(dataset.path));
              chunksByDataset.push({ dataset, chunks: await collectGisRagChunks(datasetPath, ledger) });
            }
            const chunks = chunksByDataset.flatMap((item) => item.chunks);
            const indexed: string[] = [];
            const layers: ReturnType<typeof publicStoreLayer>[] = [];
            let mergeNote = "";
            preserveUpload = true;
            if (manifest.loadMap === true || rasterPaths.length > 0) {
              const published: ReturnType<typeof publicStoreLayer>[] = [];
              await withConversation(conversationId, async () => {
              for (const dataset of ready) {
                if (manifest.loadMap !== true && !RASTER_UPLOAD.test(dataset.path)) continue;
                const datasetPath = resolve(uploadDirectory, ...safeUploadSegments(dataset.path));
                const loaded = await spatial.service.usingRequestSource("desktop-ui", () => spatial.service.loadFile(datasetPath, null, false));
                published.push(...loaded.map((layer) => publicStoreLayer(spatial, layer)));
              }
              const polygons = published.filter((layer) => layer.geometryKind === "polygon");
              const others = published.filter((layer) => layer.geometryKind !== "polygon");
              if (polygons.length >= 2) {
                const created: string[] = [];
                let latest = "";
                try {
                  let current = polygons[0];
                  if (!current) throw new SpatialOpError(settings.locale === "en" ? "The polygon layers did not merge." : "这些面图层没有合成。");
                  for (let index = 1; index < polygons.length; index += 1) {
                    const other = polygons[index];
                    if (!other) continue;
                    const merged = await spatial.service.merge(current.layerId, other.layerId, false, index === polygons.length - 1 ? "导入面" : null);
                    if (current.layerId !== polygons[0]?.layerId) created.push(current.layerId);
                    if (!merged.layer) throw new SpatialOpError(settings.locale === "en" ? "The polygon layers did not merge." : "这些面图层没有合成。");
                    current = publicStoreLayer(spatial, merged.layer);
                    latest = current.layerId;
                  }
                  for (const layer of polygons) await spatial.catalog.remove(layer.layerId);
                  for (const id of created) {
                    if (id !== current.layerId) await spatial.catalog.remove(id);
                  }
                  layers.push(current, ...others);
                  mergeNote = settings.locale === "en"
                    ? `Merged ${polygons.length} polygon layers into one layer. The CRS was not guessed.`
                    : `已把 ${polygons.length} 个面图层合成一个图层。没有猜测坐标系。`;
                } catch (error) {
                  for (const id of created) await spatial.catalog.remove(id).catch(() => undefined);
                  if (latest !== "" && !polygons.some((layer) => layer.layerId === latest)) await spatial.catalog.remove(latest).catch(() => undefined);
                  layers.push(...published);
                  const reason = error instanceof Error ? error.message : (settings.locale === "en" ? "The polygon layers stayed separate." : "这些面图层仍分开载入。");
                  mergeNote = settings.locale === "en"
                    ? `These polygon layers were not merged: ${reason} The CRS was left unchanged.`
                    : `这些面没有合成一个图层：${reason} 没有改坐标系。`;
                }
              } else {
                layers.push(...published);
              }
              });
            }
            if (layers.length > 0) await conversations.registerWorkspaceLayers(conversationId, layers.map((layer) => layer.layerId));
            await conversations.registerWorkspaceFiles(conversationId, [...savedPaths]);
            const uploadAuditId = await auditDesktopChange(root, {
              kind: "import",
              action: "import-upload",
              inputResources: [...savedPaths],
              outputResources: [...layers.map((layer) => layer.layerId), ...indexed],
              ok: true,
            });
            sendJson(response, 200, {
              ok: true,
              uploaded: true,
              fileCount: savedPaths.size,
              datasets: datasets.map((dataset) => ({
                name: dataset.path,
                kind: dataset.kind,
                status: dataset.missing.length === 0 ? "ready" : "missing",
                missing: dataset.missing.map((item) => basename(item)),
                warnings: dataset.warnings,
              })),
              ...(mergeNote !== "" ? { mergeNote } : {}),
              indexed: false,
              entryIds: indexed,
              chunks: chunks.map((chunk) => ({ title: chunk.title, layerNames: chunk.layerNames })),
              layers,
              operationId: uploadAuditId,
            });
          } catch (error) {
            if (uploadDirectory !== "" && !preserveUpload) await rm(uploadDirectory, { recursive: true, force: true }).catch(() => undefined);
            await auditDesktopChange(root, {
              kind: "import",
              action: "import-upload",
              ok: false,
              message: error instanceof Error ? error.message : "上传没有完成。",
            }).catch(() => undefined);
            throw error;
          }
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/chat") {
          const body = await readBody(request);
          if (!isRecord(body) || typeof body.text !== "string" || body.text.trim() === "") {
            sendJson(response, 400, { ok: false, message: "需要问题文本。" });
            return;
          }
          const questionText = stripDisplayedRolePrefix(body.text.trim());
          if (questionText === "") {
            sendJson(response, 400, { ok: false, message: "需要问题文本。" });
            return;
          }
          const requestedId = typeof body.conversationId === "string" ? body.conversationId.trim() : "";
          const originConversation = (requestedId !== "" ? conversations.record(requestedId) : null) ?? conversations.record(conversations.active().id);
          if (!originConversation) {
            sendJson(response, 400, { ok: false, message: "找不到这个对话。" });
            return;
          }
          chatOriginId = originConversation.id;
          const requestedOutbound = body.outbound === "full" || body.allowOutbound === true
            ? "full"
            : body.outbound === "pronoun"
              ? "pronoun"
              : null;
          if (requestedOutbound) await conversations.setOutboundModeFor(chatOriginId, requestedOutbound);
          const outboundMode = requestedOutbound ?? originConversation.outboundMode ?? null;
          const dialogue = dialogueBeforeCurrent(originConversation.messages, questionText);
          const priorRaw = priorInstructionAfterClarification(originConversation.messages);
          const retrieved: { title: string; text: string }[] = [];
          const effective = resolveEffectiveLlmConfig({ override: memoryOverride(), env: proc.env });
          const forceMock = body.model === LOCAL_CHOICE || body.choice === "local-mock";
          const localMock = forceMock || effective.localMock;
          const allowUserText = localMock || outboundMode === "full";
          const priorInstruction = priorRaw || undefined;
          const produced: PublicMapLayer[] = [];
          // 界面会带上这张对话地图的图层。没带时用对话自己登记的图层，不把整个旧图层库接上来。
          const scopeLayerIds = Array.isArray(body.scopeLayerIds)
            ? body.scopeLayerIds.filter((id): id is string => typeof id === "string")
            : [...(originConversation.workspaceLayerIds ?? [])];
          const selectedFromBody = isRecord(body.selectedLayer) ? body.selectedLayer : null;
          const selectedLayerId = typeof selectedFromBody?.layerId === "string"
            ? selectedFromBody.layerId.trim()
            : typeof body.selectedLayerId === "string"
              ? body.selectedLayerId.trim()
              : "";
          const extra = await extraMcpSession();
          const tools: readonly GisToolDefinition[] = extra ? [...GIS_TOOL_REGISTRY, ...extra.tools] : GIS_TOOL_REGISTRY;
          const extraNames = new Set((extra?.tools ?? []).map((tool) => tool.name));
          const chatAdapter: ToolAdapterPort = extra ? composeAdapters(adapter, extra.adapter, extraNames) : adapter;
          const headerBag = request as IncomingMessage & { headers?: { accept?: string | readonly string[] } };
          const acceptRaw = headerBag.headers?.accept;
          const accept = Array.isArray(acceptRaw) ? acceptRaw.join(",") : acceptRaw ?? "";
          const wantsStream = body.stream === true || accept.includes("text/event-stream");
          let thought = "";
          let thoughtKind: "reasoning" | "status" | undefined;
          const emit = (event: ChatProgressEvent): void => {
            if (event.type === "thought") {
              if (event.kind === "reasoning" && event.text.trim() !== "") {
                thought = event.text;
                thoughtKind = "reasoning";
              } else if (event.kind === "status" && thoughtKind !== "reasoning") {
                thought = event.code;
                thoughtKind = "status";
              }
            }
            if (streamOpen) writeSse(response, publicProgressEvent(event, secretValues()));
          };
          if (wantsStream) {
            startSse(response);
            streamOpen = true;
          }
          emit({ type: "thought", kind: "status", code: "understanding" });
          let modelText = questionText;
          if (isTrainingPackRequest(questionText) || isTrainErrorReport(questionText)) {
            let trainingIndex: Awaited<ReturnType<typeof indexTrainingDirectory>> | null = null;
            if (isTrainingPackRequest(questionText)) {
              for (const candidate of trainingPackPaths(questionText)) {
                try {
                  const info = await stat(candidate);
                  if (!info.isDirectory()) continue;
                  trainingIndex = await indexTrainingDirectory(candidate);
                  break;
                } catch {
                  trainingIndex = null;
                }
              }
            }
            modelText = trainingPackModelText({ text: questionText, index: trainingIndex, locale: settings.locale });
          }
          const sentAt = new Date().toISOString();
          const confirming = body.confirm === true && originConversation.pendingPlan?.requiresConfirm === true;
          if (!confirming) {
            await conversations.createCheckpointFor(chatOriginId, questionText);
            await conversations.appendTo(chatOriginId, [{ role: "user", text: questionText, at: sentAt }]);
            chatUserStored = true;
          }
          // 只走 runLocalFirstTurn。本地解析失败必须调用模型，禁止在这里直接回错误。
          const outcome = await withConversation(chatOriginId, async () => {
            const visibleCatalog = layersForConversationScope(spatial.catalog.list(), scopeLayerIds);
            const mapLayers = formatMapLayerContext(
              visibleCatalog.map((layer, index) => {
                const style = spatial.catalog.style(layer.layerId);
                const factor = planarUnitToMeter(layer.crsWkt ?? "");
                return {
                  layerId: layer.layerId,
                  layerName: layer.layerName,
                  geometryKind: layer.geometryKind,
                  featureCount: layer.featureCount,
                  fieldNames: [...layer.fieldNames],
                  crsLabel: layer.crsLabel,
                  crsKind: layer.crsIdentity.kind,
                  ...(factor !== null ? { linearUnit: factor === 1 ? "米" : String(factor) } : {}),
                  visible: style?.visible !== false,
                  order: index,
                  ...(style ? { fill: style.fill, outline: style.outline } : {}),
                  ...(settings.unrestricted || settings.geometryReleaseDeclared ? { features: ordinaryFeatures(spatial.catalog.collection(layer.layerId), layer.layerName, settings.unrestricted) } : {}),
                };
              }),
            );
            const rasterIds = await listConversationRasterIds(join(conversationWorkspaceDirectory(root, chatOriginId), "rasters"));
            const selectedLayer = formatSelectedLayer(mapLayers, selectedLayerId);
            const selectedRef = selectedLayer ? { layerId: selectedLayer.layerId, layerName: selectedLayer.layerName } : null;
            return spatial.service.usingConversationLayers(scopeLayerIds, () => spatialResultSink.run(produced, () => runLocalFirstTurn({
            conversationId: chatOriginId,
            text: modelText,
            pending: originConversation.pendingPlan ?? null,
            selectedLayer: selectedRef,
            knownLayers: mapLayers,
            lastCreatedLayerId: originConversation.lastCreatedLayerId ?? null,
            // 确认门：body.confirm 只有在待执行计划确实要求确认时才算数。别处传来的 confirm 不能授权。
            confirm: confirming,
            adapter: chatAdapter,
            tools,
            onProgress: emit,
            providerId: localMock ? "local" : effective.providerId,
            model: localMock ? LOCAL_CHOICE : effective.model,
            ...(localMock ? { baseUrl: "http://127.0.0.1:9/v1", fetchImpl: createLocalChatMock() } : { baseUrl: effective.baseUrl }),
            ...(!localMock && effective.apiKey !== "" ? { apiKey: effective.apiKey } : {}),
            env: proc.env,
            mapLayers,
            ...(rasterIds.length > 0 ? { rasterIds } : {}),
            releaseOrdinaryGeometry: settings.unrestricted || settings.geometryReleaseDeclared,
            unrestricted: settings.unrestricted,
            ...(allowUserText ? { allowUserText: true } : {}),
            ...(allowUserText && typeof originConversation.toolCarry === "string" && originConversation.toolCarry !== ""
              ? { recentResults: originConversation.toolCarry }
              : {}),
            retrievedTexts: retrieved.map((hit) => `${hit.title}\n${hit.text}`),
            userMemory: userMemory.summary(),
            locale: settings.locale,
            ...(dialogue !== "" ? { dialogue } : {}),
            ...(priorInstruction ? { priorInstruction } : {}),
          })));
          });
          await conversations.setPendingPlanFor(chatOriginId, outcome.pending);
          const turn = outcome.turn;
          if (allowUserText && typeof turn.modelCarry === "string" && turn.modelCarry !== "") {
            await conversations.setToolCarryFor(chatOriginId, turn.modelCarry);
          }
          const traces: ChatTrace[] = [];
          for (const trace of turn.traces) {
            const operationId = await operationIdForChat(root, trace);
            traces.push({
              tool: toApiToolName(trace.tool),
              message: trace.message,
              ok: trace.ok,
              ...(trace.layerId ? { layerId: trace.layerId } : {}),
              ...(trace.layerName ? { layerName: trace.layerName } : {}),
              ...(trace.code ? { code: trace.code } : {}),
              ...(trace.action ? { action: trace.action } : {}),
              ...(typeof trace.durationMs === "number" ? { durationMs: trace.durationMs } : {}),
              ...(operationId ? { operationId } : {}),
              ...(typeof trace.auditRecordId === "string" ? { auditRecordId: trace.auditRecordId } : {}),
              ...(trace.auditAppendFailed === true ? { auditAppendFailed: true } : {}),
              stepStatus: trace.stepStatus,
            });
          }
          const resultLayers = produced.map((layer) => ({ layerId: layer.layerId, layerName: layer.layerName }));
          const createdLayerIds = resultLayers.map((layer) => layer.layerId);
          if (createdLayerIds.length > 0) await conversations.registerWorkspaceLayers(chatOriginId, createdLayerIds);
          const ragEntryIds = [...new Set(turn.traces.flatMap((trace) => (trace.ragEntryId ? [trace.ragEntryId] : [])))];
          const auditRecordIds = [...new Set(turn.traces.flatMap((trace) => (
            trace.ok === true && trace.auditAppendFailed !== true && typeof trace.auditRecordId === "string" && trace.auditRecordId !== ""
              ? [trace.auditRecordId]
              : []
          )))];
          const operationIds = traces.flatMap((trace) => (trace.operationId ? [trace.operationId] : []));
          const reply = scrubSecrets(outcome.reply || turn.finalText || "模型没有返回文字。", secretValues());
          const judgment = outcome.judgment.trim();
          const combined = thoughtKind === "reasoning" && thought.trim() !== "" && thought !== judgment
            ? `${judgment}\n${thought}`
            : judgment;
          if (combined !== "") {
            thought = combined;
            thoughtKind = "reasoning";
            emit({ type: "thought", kind: "reasoning", text: combined });
          }
          emit({ type: "final", text: reply });
          const keptThought = persistedThought(thought, thoughtKind);
          const assistantMessage: ChatMessage = assistantChatMessage({
            text: reply,
            at: new Date().toISOString(),
            traces,
            resultLayers,
            createdLayerIds,
            ...keptThought,
            ...(outcome.parseTrace !== "" ? { parseTrace: outcome.parseTrace } : {}),
            ragEntryIds,
            auditRecordIds,
            operationIds,
            turnStatus: turn.turnStatus,
          });
          await conversations.appendTo(chatOriginId, [assistantMessage]);
          chatUserStored = false;
          const stored = conversations.record(chatOriginId);
          const payload = {
            ok: true,
            reply,
            conversationId: chatOriginId,
            ...(outboundMode ? { outboundMode } : {}),
            messages: stored?.messages ?? [],
            confirmRequired: outcome.confirmRequired,
            usedModel: outcome.usedModel,
            parseTrace: outcome.parseTrace,
            calls: turn.traces.map((trace, index) => {
              const operationId = traces[index]?.operationId;
              return {
                tool: toApiToolName(trace.tool),
                args: trace.args,
                ok: trace.ok,
                message: trace.message,
                layerId: trace.layerId,
                layerName: trace.layerName,
                code: trace.code,
                action: trace.action,
                ...(operationId ? { operationId } : {}),
                ...(typeof trace.auditRecordId === "string" ? { auditRecordId: trace.auditRecordId } : {}),
                ...(trace.auditAppendFailed === true ? { auditAppendFailed: true } : {}),
                stepStatus: trace.stepStatus,
              };
            }),
            traces,
            retrieved: retrieved.map((hit) => ({ entryId: hit.entryId, title: hit.title, score: hit.score })),
            layers: produced.map((layer) => publicStoreLayer(spatial, layer)),
            resultLayers,
            createdLayerIds,
            zoomLayerIds: turn.traces.filter((trace) => trace.action === "zoom-to-layer" && trace.layerId).map((trace) => trace.layerId as string),
            exportMap: turn.traces.some((trace) => trace.action === "export-map"),
            stopReason: turn.stopReason,
            turnStatus: turn.turnStatus,
          };
          if (streamOpen) {
            writeSse(response, { type: "done", ...payload });
            response.end();
          } else {
            sendJson(response, 200, payload);
          }
          return;
        }
        if (await handleV05Request({
          spatial,
          vendorRoot: resolve(root, "node_modules/maplibre-gl/dist"),
          operationsRoot: root,
          hasConversation: (conversationId) => conversations.record(conversationId) !== null,
          registerWorkspaceLayers: async (conversationId, layerIds) => {
            if (!conversations.record(conversationId)) throw new FriendlyHttpError(400, settings.locale === "en" ? "This chat is no longer available. Switch chats and try again." : "当前对话已失效，请切换对话后重试。");
            await conversations.registerWorkspaceLayers(conversationId, layerIds);
          },
          forgetWorkspaceLayer: (layerId) => conversations.forgetWorkspaceLayer(layerId),
          inConversation: (conversationId, run) => withConversation(conversationId, run),
        }, request, response, url)) {
          return;
        }
        if (await handleGdlRequest({
          ...gdlDeps,
          registerWorkspaceLayers: async (conversationId, layerIds) => {
            if (!conversations.record(conversationId)) return;
            await conversations.registerWorkspaceLayers(conversationId, layerIds);
          },
          inConversation: (conversationId, run) => withConversation(conversationId, run),
        }, request, response, url)) {
          return;
        }
        sendJson(response, 404, { ok: false, message: settings.locale === "en" ? "There is no such interface." : "没有这个接口。" });
      } catch (error) {
        if (chatUserStored && chatOriginId !== "") {
          const raw = error instanceof Error ? error.message : "这一轮没有完成。";
          const failureText = scrubSecrets(raw, secretValues()).trim() || "这一轮没有完成。";
          try {
            await conversations.appendTo(chatOriginId, [assistantChatMessage({
              text: failureText,
              at: new Date().toISOString(),
              turnStatus: "failed",
            })]);
            const stored = conversations.record(chatOriginId);
            const payload = {
              ok: true,
              reply: failureText,
              conversationId: chatOriginId,
              messages: stored?.messages ?? [],
              confirmRequired: false,
              usedModel: false,
              parseTrace: "",
              calls: [],
              traces: [],
              retrieved: [],
              layers: [],
              resultLayers: [],
              createdLayerIds: [],
              zoomLayerIds: [],
              exportMap: false,
              stopReason: "step-failed",
              turnStatus: "failed",
            };
            if (streamOpen) {
              writeSse(response, { type: "done", ...payload });
              response.end();
            } else {
              sendJson(response, 200, payload);
            }
            return;
          } catch {
            // 错误回复写不进去时，仍把失败告诉当前这条连接。
          }
        }
        if (streamOpen) {
          const raw = error instanceof Error ? error.message : (settings.locale === "en" ? "The request failed" : "请求失败");
          writeSse(response, { type: "error", message: scrubSecrets(raw, secretValues()) });
          response.end();
          return;
        }
        if (error instanceof FriendlyHttpError) {
          sendJson(response, error.status, { ok: false, message: scrubSecrets(error.message, secretValues()) });
          return;
        }
        if (error instanceof MemoryRejectedError || error instanceof DocumentError) {
          sendJson(response, error instanceof DocumentError ? error.status : 400, { ok: false, message: error.message });
          return;
        }
        const code = error instanceof GisIoReadError
          ? error.code
          : error instanceof LlmInvokeError
            ? error.code
            : error instanceof GisIoRequestError
              ? "bad-request"
              : "failed";
        const raw = error instanceof Error ? error.message : (settings.locale === "en" ? "The request failed" : "请求失败");
        sendJson(response, 500, { ok: false, message: scrubSecrets(raw, secretValues()), code });
      }
    });
  });

  server.listen(port, "127.0.0.1", () => {
    proc.stdout.write(`Igis：http://127.0.0.1:${port}\n`);
  });
}

const entry = hostProcess().argv[1] ?? "";
if (entry.includes("desktop-api")) {
  void main();
}
