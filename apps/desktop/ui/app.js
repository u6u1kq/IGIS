const filePath = document.querySelector("#file-path");
const indexRag = document.querySelector("#index-rag");
const importOut = document.querySelector("#import-out");
const gisFiles = document.querySelector("#gis-files");
const gisFileSummary = document.querySelector("#gis-file-summary");
const gisFilesClear = document.querySelector("#gis-files-clear");
const gisUploadPicker = document.querySelector("#gis-upload-picker");
const ragToggle = document.querySelector("#rag-toggle");
const messages = document.querySelector("#messages");
const question = document.querySelector("#question");
const toolbarNote = document.querySelector("#toolbar-note");
const importDialog = document.querySelector("#import-dialog");
const modelButton = document.querySelector("#open-model");
const modelDialog = document.querySelector("#model-dialog");
const modelName = document.querySelector("#model-name");
const modelBase = document.querySelector("#model-base-url");
const modelKey = document.querySelector("#model-api-key");
const modelTestNote = document.querySelector("#model-test-note");
const modelHint = document.querySelector("#model-hint");
const persistConfig = document.querySelector("#persist-config");
const ragDialog = document.querySelector("#rag-dialog");
const ragNote = document.querySelector("#rag-note");
const ragList = document.querySelector("#rag-list");
const presetButtons = [...document.querySelectorAll("[data-model-choice]")];

/** 预设只提供名称和地址，确认后才提交。取消不保留对话框里没提交的修改。 */
const LOCAL_CHOICE = "local-mock";
const RAG_FILE_LIMIT = 1024 * 1024;
const VECTOR_FILE = /\.(shp|shx|dbf|gdb|gpkg|mif|mid|tab|kml|kmz|dxf)$/i;

const TOOL_LABELS = {
  "map.list": "列出图层",
  list_map_layers: "列出图层",
  "map.buffer": "缓冲",
  run_buffer: "缓冲",
  "map.intersect": "相交",
  run_intersect: "相交",
  "map.clip": "裁剪",
  run_clip: "裁剪",
  "map.query": "查询",
  query_features: "查询",
  "map.stats": "统计",
  summarize_layer: "统计",
  "map.style": "样式",
  set_layer_style: "样式",
  "map.setVisibility": "显隐",
  set_layer_visibility: "显隐",
  "map.setOrder": "顺序",
  set_layer_order: "顺序",
  "map.zoomToLayer": "缩放",
  zoom_to_layer: "缩放",
  "map.exportGeoJson": "导出",
  export_geojson: "导出",
  "map.load": "载入图层",
  load_map_layer: "载入图层",
  "gdl.run": "运行GDL",
  run_gdl: "运行GDL",
  "gdl.describe": "描述GDL",
  describe_gdl: "描述GDL",
  "list-layers": "列出文件图层",
  list_layers: "列出文件图层",
  "get-layer-metadata": "图层元数据",
  get_layer_metadata: "图层元数据",
  "get-sample-feature": "样例要素",
  get_sample_feature: "样例要素",
  "io.read": "读取文件",
  read_gis_file: "读取文件",
};

const WIRE_NAMES = {
  "map.buffer": "run_buffer",
  "map.intersect": "run_intersect",
  "map.clip": "run_clip",
  "map.query": "query_features",
  "map.stats": "summarize_layer",
  "map.list": "list_map_layers",
  "map.load": "load_map_layer",
  "map.style": "set_layer_style",
  "map.setVisibility": "set_layer_visibility",
  "map.setOrder": "set_layer_order",
  "map.zoomToLayer": "zoom_to_layer",
  "map.exportGeoJson": "export_geojson",
  "gdl.run": "run_gdl",
  "gdl.describe": "describe_gdl",
  "map.delete": "delete_layer",
  "map.clearAll": "clear_all_layers",
  "map.dropDatabase": "delete_database",
  "list-layers": "list_layers",
  "get-layer-metadata": "get_layer_metadata",
  "get-sample-feature": "get_sample_feature",
  "io.read": "read_gis_file",
};

function displayToolName(name) {
  return wireToolName(name);
}

function wireToolName(name) {
  if (typeof name !== "string" || name === "") return "";
  if (WIRE_NAMES[name]) return WIRE_NAMES[name];
  if (!name.includes(".")) return name;
  return name.replace(/\./g, "_");
}

let ragTopK = 4;
let chosen = {
  choice: "deepseek",
  providerId: "deepseek",
  model: "deepseek-flash",
  baseUrl: "https://api.deepseek.com",
};
let dialogChoice = "deepseek";
let settingsChoice = "deepseek";
let lastConfig = { persist: false, hasApiKey: false, keySource: "none" };
function browserLocale() {
  return (navigator.language || "").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}
const layout = { chatRatio: 52, fontSize: 14, locale: browserLocale(), developerMode: false };
let layoutSnapshot = null;
let settingsSaved = false;
let lastMessages = [];
let sending = false;

const THEME_KEY = "igis-ui-theme";

const MAP_EMPTY_LIGHT = "#ebe2d4";
const MAP_EMPTY_DARK = "#2f2922";

function mapEmptyColor(theme) {
  return theme === "dark" ? MAP_EMPTY_DARK : MAP_EMPTY_LIGHT;
}

function syncMapEmptyBackground(theme) {
  const color = mapEmptyColor(theme === "dark" ? "dark" : "light");
  // Use ref — theme init runs before `let map` is initialized (TDZ).
  const m = globalThis.__igisMapRef;
  if (!m || typeof m.getLayer !== "function" || !m.getLayer("background")) return;
  try {
    m.setPaintProperty("background", "background-color", color);
  } catch {
    /* map style not ready */
  }
}


function readStoredTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function syncThemeButtons(theme) {
  document.querySelectorAll("[data-theme-choice]").forEach((btn) => {
    const on = btn.dataset.themeChoice === theme;
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.classList.toggle("is-active", on);
  });
}

function applyTheme(theme, { persist = true } = {}) {
  const next = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  document.documentElement.classList.toggle("theme-dark", next === "dark");
  document.documentElement.classList.toggle("theme-light", next === "light");
  syncThemeButtons(next);
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* ignore quota */
    }
  }
  // Ambient stars only live under .chat — never on map. Restart/pause with theme.
  if (typeof window.__igisAmbient?.setEnabled === "function") {
    window.__igisAmbient.setEnabled(next === "dark");
  }
  syncMapEmptyBackground(next);
}

function initThemeToggle() {
  applyTheme(readStoredTheme(), { persist: false });
  document.querySelectorAll("[data-theme-choice]").forEach((btn) => {
    btn.addEventListener("click", () => applyTheme(btn.dataset.themeChoice));
  });
}

/** Night-sky starfield: ONLY inside .chat / #ambient-stars. Map must stay plain. */
function initAmbientSky() {
  const canvas = document.querySelector("#ambient-stars");
  const sky = document.querySelector(".ambient-sky");
  if (!canvas || !sky) {
    window.__igisAmbient = { setEnabled() {} };
    return;
  }
  const ctx = canvas.getContext("2d");
  let stars = [];
  let raf = 0;
  let enabled = false;
  let last = 0;

  function resize() {
    const host = sky.parentElement || sky;
    const rect = host.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.max(18, Math.min(48, Math.floor((w * h) / 18000)));
    stars = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: 0.4 + Math.random() * 1.1,
      phase: Math.random() * Math.PI * 2,
      speed: 0.00035 + Math.random() * 0.00055,
      base: 0.15 + Math.random() * 0.35,
    }));
  }

  function frame(ts) {
    if (!enabled) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    for (const s of stars) {
      const twinkle = s.base + 0.35 * (0.5 + 0.5 * Math.sin(ts * s.speed + s.phase));
      ctx.beginPath();
      ctx.fillStyle = `rgba(255, 236, 210, ${twinkle.toFixed(3)})`;
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    raf = requestAnimationFrame(frame);
  }

  function setEnabled(on) {
    enabled = Boolean(on);
    sky.classList.toggle("is-active", enabled);
    cancelAnimationFrame(raf);
    if (enabled) {
      resize();
      raf = requestAnimationFrame(frame);
    } else if (ctx) {
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    }
  }

  window.__igisAmbient = { setEnabled };
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => {
    if (enabled) resize();
  }) : null;
  if (ro) ro.observe(sky.parentElement || sky);
  window.addEventListener("resize", () => { if (enabled) resize(); });
  setEnabled(document.documentElement.dataset.theme === "dark");
}

initAmbientSky();
initThemeToggle();


function t(key) {
  const packs = window.IGIS_I18N || {};
  const pack = packs[layout.locale] || packs["zh-CN"] || {};
  return Object.prototype.hasOwnProperty.call(pack, key) ? pack[key] : key;
}

function applyChrome() {
  document.documentElement.lang = layout.locale === "en" ? "en" : "zh-CN";
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-label]").forEach((el) => {
    const text = t(el.dataset.i18nLabel);
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== "") {
        const pad = /^\s/.test(node.textContent) ? " " : "";
        node.textContent = `${pad}${text}`;
        return;
      }
    }
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
    el.setAttribute("aria-label", t(el.dataset.i18nAria));
  });
  const localeSelect = document.querySelector("#settings-locale");
  if (localeSelect) localeSelect.value = layout.locale === "en" ? "en" : "zh-CN";
  syncThemeButtons(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  const toggle = document.querySelector("#toggle-map");
  const mapPanelEl = document.querySelector("#map-panel");
  if (toggle && mapPanelEl) toggle.textContent = mapPanelEl.classList.contains("collapsed") ? t("nav.showMap") : t("nav.toggleMap");
  const boxButton = document.querySelector("#box-select");
  if (boxButton && typeof boxMode === "boolean") boxButton.textContent = boxMode ? t("map.boxStop") : t("map.box");
  syncLayoutControls();
  if (typeof updateGisFileSummary === "function") updateGisFileSummary();
  if (typeof refreshScene === "function") refreshScene().catch(() => undefined);
}

async function api(path, options) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = { ok: false, message: `服务返回了无法解析的内容（HTTP ${response.status}）。` };
  }
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.message || "请求失败");
    error.payload = payload;
    error.status = response.status;
    throw error;
  }
  return payload;
}

/** 统一错误弹窗。文字都来自服务端已去掉密钥的消息；几何问题只列序号和原因，不列坐标。 */
const errorDialog = document.querySelector("#error-dialog");
const ERROR_DETAIL_LIMIT = 20;

function errorDetails(payload) {
  const lines = [];
  if (payload && Array.isArray(payload.errors)) {
    for (const item of payload.errors) {
      if (item && typeof item.message === "string") {
        lines.push(typeof item.line === "number" ? `第 ${item.line} 行第 ${item.column ?? 1} 列：${item.message}` : item.message);
      }
    }
  }
  if (payload && Array.isArray(payload.geometryIssues)) {
    for (const issue of payload.geometryIssues) {
      if (issue && typeof issue.message === "string") lines.push(issue.message);
    }
  }
  return lines;
}

function showError(title, error) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "操作没有完成。";
  const payload = error && typeof error === "object" ? error.payload : null;
  showErrorDialog(title, message, errorDetails(payload));
}

function showErrorDialog(title, message, details) {
  document.querySelector("#error-title").textContent = title;
  document.querySelector("#error-message").textContent = message;
  const list = document.querySelector("#error-details");
  list.textContent = "";
  for (const line of details.slice(0, ERROR_DETAIL_LIMIT)) {
    const item = document.createElement("li");
    item.textContent = line;
    list.append(item);
  }
  if (details.length > ERROR_DETAIL_LIMIT) {
    const more = document.createElement("li");
    more.textContent = `还有 ${details.length - ERROR_DETAIL_LIMIT} 条没有列出。`;
    list.append(more);
  }
  list.hidden = details.length === 0;
  if (errorDialog.open) errorDialog.close();
  errorDialog.showModal();
}

function showGeometryIssues(issues, intro) {
  if (!Array.isArray(issues) || issues.length === 0) return;
  showErrorDialog("几何校验", intro || `有 ${issues.length} 个要素的几何有问题。空几何和无效几何已跳过，其余已载入。`, errorDetails({ geometryIssues: issues }));
}

document.querySelector("#close-error").addEventListener("click", () => errorDialog.close());

function connectionStatusText(httpStatus) {
  if (httpStatus === 400) return "请求格式被拒绝。请检查 API Base URL 和模型名。";
  if (httpStatus === 401) return "API-Key无效，请核对密钥";
  if (httpStatus === 402) return "账号余额不足，需要充值";
  if (httpStatus === 429) return "请求频率超限，请稍后重试";
  if (typeof httpStatus === "number") return String(httpStatus);
  return "";
}

async function runConnectionTest(note, fields) {
  note.textContent = "正在测试连接…";
  try {
    const response = await fetch("/api/llm/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: fields.model,
        apiBase: fields.apiBase,
        apiKey: fields.apiKey,
      }),
    });
    const payload = await response.json();
    if (payload && payload.ok === true) {
      note.textContent = typeof payload.message === "string" && payload.message !== "" ? payload.message : "连接成功。";
      return;
    }
    const mapped = connectionStatusText(payload && payload.httpStatus);
    if (mapped !== "") {
      note.textContent = mapped;
      return;
    }
    note.textContent = payload && typeof payload.message === "string" && payload.message !== "" ? payload.message : "连接失败。";
  } catch (error) {
    note.textContent = error instanceof Error ? error.message : "连接失败。";
  }
}

function syncLayoutControls() {
  const ratio = document.querySelector("#layout-ratio");
  const font = document.querySelector("#layout-font");
  if (ratio) ratio.value = String(layout.chatRatio);
  if (font) font.value = String(layout.fontSize);
  const developer = document.querySelector("#settings-developer");
  if (developer) developer.checked = layout.developerMode === true;
  const ratioNote = document.querySelector("#layout-ratio-note");
  const fontNote = document.querySelector("#layout-font-note");
  if (ratioNote) ratioNote.textContent = t("layout.ratio").replace("{chat}", String(layout.chatRatio)).replace("{map}", String(100 - layout.chatRatio));
  if (fontNote) fontNote.textContent = t("layout.font").replace("{size}", String(layout.fontSize));
}

function applyLayout() {
  document.documentElement.style.setProperty("--chat-flex", String(layout.chatRatio));
  document.documentElement.style.setProperty("--map-flex", String(100 - layout.chatRatio));
  document.documentElement.style.setProperty("--ui-font-size", `${layout.fontSize}px`);
  syncLayoutControls();
  if (typeof map !== "undefined" && map) requestAnimationFrame(() => map.resize());
}

let selectedTurnIndex = -1;
let conversationState = { activeId: "", conversations: [] };

function thoughtBody(item) {
  if (!item) return "";
  if (item.thought === "running_tools") return "";
  if (item.thoughtKind === "status" || item.thought === "understanding") {
    return t("thought.understanding");
  }
  return typeof item.thought === "string" ? item.thought : "";
}

function appendThought(block, item) {
  const text = thoughtBody(item);
  if (text === "") return;
  const details = document.createElement("details");
  details.className = "chat-thought";
  const summary = document.createElement("summary");
  summary.textContent = t("thought.title");
  const body = document.createElement("p");
  body.textContent = text;
  details.append(summary, body);
  block.append(details);
}

function timingLabel(step) {
  return step && typeof step.durationMs === "number" && Number.isFinite(step.durationMs) ? ` ${Math.round(step.durationMs)}ms` : "";
}

function appendParseTrace(block, item) {
  if (!layout.developerMode || !item || typeof item.parseTrace !== "string" || item.parseTrace.trim() === "") return;
  const line = document.createElement("p");
  line.className = "chat-parse";
  line.textContent = item.parseTrace;
  block.append(line);
}

function appendToolSteps(block, traces) {
  if (!Array.isArray(traces) || traces.length === 0) return;
  const list = document.createElement("ul");
  list.className = "chat-tools";
  for (const step of traces) {
    const row = document.createElement("li");
    const status = step.ok === false ? t("tool.fail") : t("tool.ok");
    const layer = step.layerName ? ` → ${step.layerName}` : "";
    row.textContent = `${status} ${wireToolName(step.tool)}${layer}${timingLabel(step)}${step.message ? `：${step.message}` : ""}`;
    list.append(row);
  }
  block.append(list);
}

/** 滚动跟随：贴在底部时跟随模型输出；上翻阅读时不打扰，只给"回到最新"按钮。 */
let chatFollowing = true;
const CHAT_FOLLOW_GAP = 48;
const chatJumpBottom = document.querySelector("#chat-jump-bottom");

function chatAtBottom() {
  return messages.scrollHeight - messages.scrollTop - messages.clientHeight <= CHAT_FOLLOW_GAP;
}

function syncChatFollowUi() {
  if (chatJumpBottom) chatJumpBottom.hidden = chatFollowing;
}

function stickChatToBottom() {
  if (chatFollowing) messages.scrollTop = messages.scrollHeight;
}

messages.addEventListener("scroll", () => {
  chatFollowing = chatAtBottom();
  syncChatFollowUi();
});

if (chatJumpBottom) {
  chatJumpBottom.addEventListener("click", () => {
    chatFollowing = true;
    messages.scrollTop = messages.scrollHeight;
    syncChatFollowUi();
  });
}

/** 对话中显示的助手名：当前使用的模型名，读不到时退回"模型"。 */
function modelLabel() {
  const name = typeof chosen.model === "string" ? chosen.model.trim() : "";
  return name === "" ? t("role.model") : name;
}

function renderMessages(list) {
  const keepScrollTop = messages.scrollTop;
  messages.textContent = "";
  const items = Array.isArray(list) ? list : [];
  lastMessages = items;
  if (items.length === 0) selectedTurnIndex = -1;
  else if (selectedTurnIndex < 0 || selectedTurnIndex >= items.length) selectedTurnIndex = items.length - 1;
  if (items.length === 0) {
    const welcome = document.createElement("article");
    // Framed empty-state card; entrance only on first empty paint, not every chat switch.
    const enter = !window.__igisWelcomePainted;
    window.__igisWelcomePainted = true;
    welcome.className = enter
      ? "chat-turn chat-assistant chat-welcome chat-welcome-enter"
      : "chat-turn chat-assistant chat-welcome";
    const card = document.createElement("div");
    card.className = "chat-welcome-card";
    const paragraph = document.createElement("p");
    paragraph.className = "chat-answer";
    paragraph.textContent = t("chat.welcome");
    card.append(paragraph);
    welcome.append(card);
    messages.append(welcome);
  }
  items.forEach((item, index) => {
    const block = document.createElement("article");
    block.className = item.role === "user" ? "chat-turn chat-user" : "chat-turn chat-assistant";
    block.dataset.turnIndex = String(index);
    if (index === selectedTurnIndex) block.classList.add("selected");
    if (item.role === "assistant") appendThought(block, item);
    if (item.role === "assistant") appendParseTrace(block, item);
    if (item.role === "assistant") appendToolSteps(block, item.traces);
    const paragraph = document.createElement("p");
    paragraph.className = item.role === "assistant" ? "chat-answer" : "";
    paragraph.dataset.turnText = item.text;
    paragraph.textContent = `${item.role === "user" ? t("role.user") : modelLabel()}：${item.text}`;
    block.append(paragraph);
    if (item.role === "assistant" && Array.isArray(item.resultLayers) && item.resultLayers.length > 0) {
      const result = document.createElement("p");
      result.className = "chat-result-layer";
      result.textContent = `${t("tool.layers")}：${item.resultLayers.map((layer) => layer.layerName).join("、")}`;
      block.append(result);
    }
    block.addEventListener("click", () => {
      selectedTurnIndex = index;
      highlightSelectedTurn();
    });
    messages.append(block);
  });
  // 翻阅不打扰：贴底才跟到最新，否则保持原阅读位置（重绘前的高度差只影响底部新增内容）。
  if (chatFollowing) messages.scrollTop = messages.scrollHeight;
  else messages.scrollTop = keepScrollTop;
  syncChatFollowUi();
}

function appendUserBubble(text) {
  const block = document.createElement("article");
  block.className = "chat-turn chat-user";
  const paragraph = document.createElement("p");
  paragraph.dataset.turnText = text;
  paragraph.textContent = `${t("role.user")}：${text}`;
  block.append(paragraph);
  messages.append(block);
  // 用户发出任务后恢复跟随，对话栏跟着模型思考走。
  chatFollowing = true;
  messages.scrollTop = messages.scrollHeight;
  syncChatFollowUi();
  return block;
}

function ensureLiveAssistant() {
  let block = document.querySelector("#live-assistant");
  if (block) return block;
  block = document.createElement("article");
  block.id = "live-assistant";
  block.className = "chat-turn chat-assistant";
  messages.append(block);
  stickChatToBottom();
  return block;
}

function statusLabel(code) {
  if (code === "starting") return t("thought.starting");
  return code === "running_tools" ? t("thought.running") : t("thought.understanding");
}

function applyStreamEvent(event) {
  const block = ensureLiveAssistant();
  if (event.type === "thought") {
    let details = block.querySelector(".chat-thought");
    if (!details) {
      details = document.createElement("details");
      details.className = "chat-thought";
      const summary = document.createElement("summary");
      summary.textContent = t("thought.title");
      const body = document.createElement("p");
      details.append(summary, body);
      block.prepend(details);
    }
    const body = details.querySelector("p");
    if (body) body.textContent = event.kind === "reasoning" ? event.text : statusLabel(event.code);
  } else if (event.type === "tool") {
    let list = block.querySelector(".chat-tools");
    if (!list) {
      list = document.createElement("ul");
      list.className = "chat-tools";
      const answer = block.querySelector(".chat-answer");
      if (answer) block.insertBefore(list, answer);
      else block.append(list);
    }
    const row = document.createElement("li");
    const layer = event.layerName ? ` → ${event.layerName}` : "";
    row.textContent = `${event.ok === false ? t("tool.fail") : t("tool.ok")} ${wireToolName(event.tool)}${layer}${timingLabel(event)}${event.message ? `：${event.message}` : ""}`;
    list.append(row);
  } else if (event.type === "final") {
    let answer = block.querySelector(".chat-answer");
    if (!answer) {
      answer = document.createElement("p");
      answer.className = "chat-answer";
      block.append(answer);
    }
    answer.dataset.turnText = event.text;
    answer.textContent = `${modelLabel()}：${event.text}`;
  }
  stickChatToBottom();
}

async function readSse(response, onEvent) {
  const reader = response.body ? response.body.getReader() : null;
  if (!reader) throw new Error(t("chat.sendFailed"));
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.split("\n").find((item) => item.startsWith("data: "));
      if (!line) continue;
      onEvent(JSON.parse(line.slice(6)));
    }
  }
}

function highlightSelectedTurn() {
  const turns = [...messages.querySelectorAll(".chat-turn")];
  turns.forEach((block, index) => {
    block.classList.toggle("selected", index === selectedTurnIndex);
  });
  const selected = messages.querySelector(".chat-turn.selected");
  if (selected) selected.scrollIntoView({ block: "nearest" });
}

function selectedTurnText() {
  const turns = [...messages.querySelectorAll(".chat-turn")];
  const block = turns[selectedTurnIndex];
  if (!block) return "";
  const paragraph = block.querySelector(".chat-answer") || block.querySelector(":scope > p");
  if (!paragraph) return "";
  if (typeof paragraph.dataset.turnText === "string") return paragraph.dataset.turnText;
  return paragraph.textContent.replace(/^(我|模型|Me|Model)：/, "").trim();
}

function moveTurn(delta) {
  const turns = messages.querySelectorAll(".chat-turn");
  if (turns.length === 0) return;
  if (selectedTurnIndex < 0) selectedTurnIndex = turns.length - 1;
  selectedTurnIndex = Math.max(0, Math.min(turns.length - 1, selectedTurnIndex + delta));
  highlightSelectedTurn();
}

function markPreset() {
  for (const button of presetButtons) {
    const selected = button.dataset.modelChoice === dialogChoice;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", selected ? "true" : "false");
  }
}

function modelHintText() {
  if (chosen.model === LOCAL_CHOICE) return "local-mock 使用本机模拟，忽略接口地址和密钥。";
  if (lastConfig.persist === true) return "上次已勾选保存。这次如果取消勾选并确认，会去掉后端配置文件，密钥只留在当前进程内存。";
  if (lastConfig.keySource === "memory") return "密钥只在本次服务进程的内存里。刷新页面后输入框为空，进程重启后改用环境变量。";
  if (lastConfig.keySource === "env") return "页面没有保存密钥。对话会使用当前提供方的环境变量。用户配置优先于环境变量。";
  return "还没有密钥。可以填写 API Key，或在服务进程中设置当前提供方的环境变量。";
}

function applyPublicConfig(config) {
  const modelId = typeof config.modelId === "string" && config.modelId !== "" ? config.modelId : (typeof config.model === "string" ? config.model : chosen.model);
  chosen = {
    choice: typeof config.choice === "string" && config.choice !== "" ? config.choice : chosen.choice,
    providerId: typeof config.providerId === "string" && config.providerId !== "" ? config.providerId : chosen.providerId,
    model: modelId,
    baseUrl: typeof config.apiBase === "string" ? config.apiBase : "",
  };
  if (typeof config.ragTopK === "number") ragTopK = config.ragTopK;
  ragToggle.checked = config.ragEnabled === true;
  lastConfig = config;
  modelButton.textContent = chosen.model || "选择模型";
  const settingsDialog = document.querySelector("#settings-dialog");
  const editingLayout = settingsDialog instanceof HTMLDialogElement && settingsDialog.open && !settingsSaved;
  if (!editingLayout) {
    if (typeof config.chatRatio === "number") layout.chatRatio = config.chatRatio;
    if (typeof config.fontSize === "number") layout.fontSize = config.fontSize;
    if (config.locale === "en" || config.locale === "zh-CN") layout.locale = config.locale;
    if (typeof config.developerMode === "boolean") layout.developerMode = config.developerMode;
    applyLayout(true);
    applyChrome();
  }
}

function fillModelDialog() {
  dialogChoice = chosen.choice || "deepseek";
  persistConfig.checked = lastConfig.persist === true;
  modelKey.value = "";
  modelKey.placeholder = lastConfig.hasApiKey ? "已配置密钥，留空则保留。完整密钥不会回显。" : "请输入 API Key";
  modelName.value = chosen.model === LOCAL_CHOICE ? "" : chosen.model;
  modelBase.value = chosen.model === LOCAL_CHOICE ? "" : chosen.baseUrl;
  modelName.disabled = dialogChoice === LOCAL_CHOICE;
  modelBase.disabled = dialogChoice === LOCAL_CHOICE;
  modelKey.disabled = dialogChoice === LOCAL_CHOICE;
  modelTestNote.textContent = "";
  modelHint.textContent = modelHintText();
  markPreset();
}

function showEnvironmentStatus(report) {
  const host = document.querySelector("#env-status");
  if (!host || !report) return;
  const lines = Array.isArray(report.summary)
    ? report.summary.filter((line) => typeof line === "string" && line.trim() !== "")
    : [];
  host.textContent = lines.join("\n");
}

async function loadEnvironmentStatus() {
  const host = document.querySelector("#env-status");
  try {
    const response = await fetch("/api/environment");
    const report = await response.json();
    showEnvironmentStatus(report);
  } catch (error) {
    if (host) host.textContent = error instanceof Error ? error.message : "环境检查没有连上本机服务。";
  }
}

async function loadModelConfig() {
  try {
    applyPublicConfig(await api("/api/llm/config"));
  } catch (error) {
    toolbarNote.textContent = error instanceof Error ? error.message : "读不到模型配置";
    showError("读不到模型配置", error);
  }
  await loadEnvironmentStatus();
}

document.querySelector("#open-import").addEventListener("click", () => {
  importDialog.showModal();
});

document.querySelector("#close-import").addEventListener("click", () => {
  importDialog.close();
});

document.querySelector("#open-model").addEventListener("click", () => {
  fillModelDialog();
  modelDialog.showModal();
});

document.querySelector("#cancel-model").addEventListener("click", () => {
  modelDialog.close();
});

modelDialog.addEventListener("close", () => {
  modelKey.value = "";
  modelTestNote.textContent = "";
});

for (const button of presetButtons) {
  button.addEventListener("click", () => {
    dialogChoice = button.dataset.modelChoice || "custom";
    const local = dialogChoice === LOCAL_CHOICE;
    modelName.disabled = local;
    modelBase.disabled = local;
    modelKey.disabled = local;
    if (dialogChoice === "custom") {
      modelName.value = "";
      modelBase.value = "";
      modelName.focus();
    } else if (!local) {
      modelName.value = button.dataset.modelName || "";
      modelBase.value = button.dataset.baseUrl || "";
    }
    markPreset();
  });
}

document.querySelector("#test-connection").addEventListener("click", () => {
  const button = document.querySelector(`[data-model-choice="${dialogChoice}"]`);
  runConnectionTest(modelTestNote, {
    choice: dialogChoice,
    model: dialogChoice === LOCAL_CHOICE ? LOCAL_CHOICE : modelName.value.trim(),
    providerId: button instanceof HTMLButtonElement ? button.dataset.provider : "local",
    apiBase: modelBase.value.trim(),
    apiKey: modelKey.value,
  });
});

document.querySelector("#confirm-model").addEventListener("click", async () => {
  const button = document.querySelector(`[data-model-choice="${dialogChoice}"]`);
  const providerId = button instanceof HTMLButtonElement ? button.dataset.provider : "local";
  if (dialogChoice !== LOCAL_CHOICE && modelName.value.trim() === "") {
    modelTestNote.textContent = "请填写模型名。";
    return;
  }
  if (dialogChoice === "custom" && modelBase.value.trim() === "") {
    modelTestNote.textContent = "请填写 API Base URL。";
    return;
  }
  try {
    const saved = await api("/api/llm/config", {
      method: "POST",
      body: JSON.stringify({
        choice: dialogChoice,
        model: dialogChoice === LOCAL_CHOICE ? LOCAL_CHOICE : modelName.value.trim(),
        providerId,
        apiBase: dialogChoice === LOCAL_CHOICE ? "" : modelBase.value.trim(),
        apiKey: modelKey.value,
        persist: persistConfig.checked,
      }),
    });
    modelKey.value = "";
    applyPublicConfig(saved);
    modelDialog.close();
    toolbarNote.textContent = saved.persist === true ? "已确认，并写入后端配置。" : "已确认。密钥只留在服务进程内存，未写入磁盘。";
  } catch (error) {
    modelTestNote.textContent = error instanceof Error ? error.message : "确认失败";
    showError("模型配置没有保存", error);
  }
});

function markSettingsPreset() {
  for (const button of document.querySelectorAll("[data-settings-model]")) {
    const selected = button.dataset.settingsModel === settingsChoice;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", selected ? "true" : "false");
  }
}

function fillSettingsDialog() {
  settingsChoice = chosen.choice || "deepseek";
  const base = document.querySelector("#settings-base-url");
  const name = document.querySelector("#settings-model-name");
  const key = document.querySelector("#settings-api-key");
  const persist = document.querySelector("#settings-persist");
  document.querySelector("#settings-test-note").textContent = "";
  document.querySelector("#settings-note").textContent = "";
  document.querySelector("#foundation-note").textContent = "";
  persist.checked = lastConfig.persist === true;
  document.querySelector("#settings-external-enabled").checked = lastConfig.externalCapabilitiesEnabled !== false;
  const geometryRelease = document.querySelector("#settings-geometry-release");
  if (geometryRelease) geometryRelease.checked = lastConfig.geometryReleaseDeclared === true;
  const unrestricted = document.querySelector("#settings-unrestricted");
  if (unrestricted) unrestricted.checked = lastConfig.unrestricted === true;
  const pythonCommand = document.querySelector("#settings-python-command");
  if (pythonCommand) pythonCommand.value = typeof lastConfig.pythonCommand === "string" ? lastConfig.pythonCommand : "";
  loadEnvironmentStatus().catch(() => undefined);
  api("/api/external/status").then((status) => {
    document.querySelector("#external-status").textContent = status.message;
    document.querySelector("#external-status").classList.toggle("status-error", status.enabled && !status.available);
    const gdal = document.querySelector("#gdal-switch");
    if (gdal) gdal.textContent = status.enabled && status.available ? t("settings.gdalOn") : t("settings.gdalOff");
  }).catch((error) => {
    document.querySelector("#external-status").textContent = error instanceof Error ? error.message : "GDAL 环境检查失败。";
    const gdal = document.querySelector("#gdal-switch");
    if (gdal) gdal.textContent = t("settings.gdalOff");
  });
  refreshProModelStatus();
  refreshEnginesStatus();
  const weightsNote = document.querySelector("#pro-model-note");
  if (weightsNote) weightsNote.textContent = "";
  key.value = "";
  key.placeholder = lastConfig.hasApiKey ? "已配置密钥，留空则保留。完整密钥不会回显。" : "请输入 API Key";
  const mcpCommand = document.querySelector("#mcp-command");
  const mcpArgs = document.querySelector("#mcp-args");
  if (mcpCommand) mcpCommand.value = typeof lastConfig.mcpCommand === "string" ? lastConfig.mcpCommand : "";
  if (mcpArgs) mcpArgs.value = typeof lastConfig.mcpArgsText === "string" ? lastConfig.mcpArgsText : (Array.isArray(lastConfig.mcpArgs) ? lastConfig.mcpArgs.join(" ") : "");
  refreshMemoryList().catch(() => undefined);
  const local = settingsChoice === LOCAL_CHOICE;
  name.value = local ? "" : chosen.model;
  base.value = local ? "" : chosen.baseUrl;
  name.disabled = local;
  base.disabled = local;
  key.disabled = local;
  markSettingsPreset();
  const localeSelect = document.querySelector("#settings-locale");
  if (localeSelect) localeSelect.value = layout.locale === "en" ? "en" : "zh-CN";
  syncLayoutControls();
  layoutSnapshot = {
    chatRatio: layout.chatRatio,
    fontSize: layout.fontSize,
    locale: layout.locale,
    developerMode: layout.developerMode === true,
  };
}

document.querySelector("#open-settings").addEventListener("click", () => {
  settingsSaved = false;
  fillSettingsDialog();
  document.querySelector("#settings-dialog").showModal();
});

function fillTemplate(key, values) {
  let text = t(key);
  for (const [name, value] of Object.entries(values)) text = text.split(`{${name}}`).join(String(value));
  return text;
}

function fillProModelSlots(status) {
  const select = document.querySelector("#pro-model-slot");
  if (!select) return;
  const slots = Array.isArray(status.slots) ? status.slots : [];
  select.replaceChildren();
  if (slots.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = t("settings.weightsEmpty");
    select.append(option);
    return;
  }
  for (const slot of slots) {
    const option = document.createElement("option");
    option.value = typeof slot.id === "string" ? slot.id : "";
    option.textContent = typeof slot.name === "string" ? slot.name : "";
    if (slot.id === status.activeId) option.selected = true;
    select.append(option);
  }
}

function refreshProModelStatus() {
  const node = document.querySelector("#pro-model-status");
  if (!node) return;
  api("/api/pro-model").then((status) => {
    fillProModelSlots(status);
    node.textContent = status.installed && status.name
      ? fillTemplate("settings.weightsInstalled", { name: status.name })
      : (status.message ? `${t("settings.weightsMissing")} ${status.message}` : t("settings.weightsMissing"));
  }).catch((error) => {
    node.textContent = error instanceof Error ? error.message : t("settings.weightsMissing");
  });
}

function refreshEnginesStatus() {
  const node = document.querySelector("#engines-status");
  if (!node) return;
  api("/api/engines").then((status) => {
    node.textContent = status.available ? status.message : `${t("settings.enginesMissing")} ${status.message || ""}`;
  }).catch((error) => {
    node.textContent = error instanceof Error ? error.message : t("settings.enginesMissing");
  });
}

document.querySelector("#engines-install").addEventListener("click", async () => {
  const node = document.querySelector("#engines-status");
  const button = document.querySelector("#engines-install");
  button.disabled = true;
  node.textContent = t("settings.enginesInstalling");
  try {
    const result = await api("/api/engines/install", { method: "POST", body: "{}" });
    node.textContent = result.message;
  } catch (error) {
    node.textContent = error instanceof Error ? error.message : t("settings.enginesMissing");
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#pro-model-activate").addEventListener("click", async () => {
  const select = document.querySelector("#pro-model-slot");
  const note = document.querySelector("#pro-model-note");
  const id = select ? select.value : "";
  if (!id) {
    note.textContent = t("settings.weightsEmpty");
    return;
  }
  try {
    const result = await api("/api/pro-model", { method: "POST", body: JSON.stringify({ action: "activate", id }) });
    note.textContent = fillTemplate("settings.weightsSwitched", { name: result.name || "" });
    refreshProModelStatus();
  } catch (error) {
    note.textContent = error instanceof Error ? error.message : t("settings.weightsBad");
  }
});

document.querySelector("#pro-model-install").addEventListener("click", async () => {
  const input = document.querySelector("#pro-model-file");
  const note = document.querySelector("#pro-model-note");
  const file = input && input.files ? input.files[0] : null;
  if (!file) {
    note.textContent = t("settings.weightsNeedFile");
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    note.textContent = t("settings.weightsBad");
    return;
  }
  try {
    const result = await api("/api/pro-model", { method: "POST", body: JSON.stringify(parsed) });
    note.textContent = fillTemplate("settings.weightsInstalled", { name: result.name || "" });
    refreshProModelStatus();
  } catch (error) {
    note.textContent = error instanceof Error ? error.message : t("settings.weightsBad");
  }
});

for (const button of document.querySelectorAll("[data-settings-model]")) {
  button.addEventListener("click", () => {
    settingsChoice = button.dataset.settingsModel || "custom";
    const base = document.querySelector("#settings-base-url");
    const name = document.querySelector("#settings-model-name");
    const key = document.querySelector("#settings-api-key");
    const local = settingsChoice === LOCAL_CHOICE;
    name.disabled = local;
    base.disabled = local;
    key.disabled = local;
    if (settingsChoice === "custom") {
      name.value = "";
      base.value = "";
      name.focus();
    } else if (!local) {
      name.value = button.dataset.modelName || "";
      base.value = button.dataset.baseUrl || "";
    }
    markSettingsPreset();
  });
}

document.querySelector("#settings-test").addEventListener("click", () => {
  const button = document.querySelector(`[data-settings-model="${settingsChoice}"]`);
  runConnectionTest(document.querySelector("#settings-test-note"), {
    choice: settingsChoice,
    model: settingsChoice === LOCAL_CHOICE ? LOCAL_CHOICE : document.querySelector("#settings-model-name").value.trim(),
    providerId: button instanceof HTMLButtonElement ? button.dataset.provider : "local",
    apiBase: document.querySelector("#settings-base-url").value.trim(),
    apiKey: document.querySelector("#settings-api-key").value,
  });
});

document.querySelector("#layout-ratio").addEventListener("input", (event) => {
  layout.chatRatio = Number(event.target.value);
  applyLayout();
});

document.querySelector("#layout-font").addEventListener("input", (event) => {
  layout.fontSize = Number(event.target.value);
  applyLayout();
});

document.querySelector("#settings-developer").addEventListener("change", (event) => {
  layout.developerMode = event.target.checked === true;
  renderMessages(lastMessages);
});

document.querySelector("#save-settings").addEventListener("click", async () => {
  const note = document.querySelector("#settings-note");
  try {
    const button = document.querySelector(`[data-settings-model="${settingsChoice}"]`);
    const modelNameValue = document.querySelector("#settings-model-name").value.trim();
    if (settingsChoice !== LOCAL_CHOICE && modelNameValue === "") {
      note.textContent = "请填写模型名。";
      return;
    }
    if (settingsChoice === "custom" && document.querySelector("#settings-base-url").value.trim() === "") {
      note.textContent = "请填写 API Base URL。";
      return;
    }
    const saved = await api("/api/llm/config", {
      method: "POST",
      body: JSON.stringify({
        choice: settingsChoice,
        model: settingsChoice === LOCAL_CHOICE ? LOCAL_CHOICE : modelNameValue,
        providerId: button instanceof HTMLButtonElement ? button.dataset.provider : "local",
        apiBase: settingsChoice === LOCAL_CHOICE ? "" : document.querySelector("#settings-base-url").value.trim(),
        apiKey: document.querySelector("#settings-api-key").value,
        persist: document.querySelector("#settings-persist").checked,
        chatRatio: layout.chatRatio,
        fontSize: layout.fontSize,
        locale: document.querySelector("#settings-locale") && document.querySelector("#settings-locale").value === "en" ? "en" : "zh-CN",
        developerMode: document.querySelector("#settings-developer") ? document.querySelector("#settings-developer").checked === true : false,
        externalCapabilitiesEnabled: document.querySelector("#settings-external-enabled").checked,
        geometryReleaseDeclared: document.querySelector("#settings-geometry-release") ? document.querySelector("#settings-geometry-release").checked === true : false,
        unrestricted: document.querySelector("#settings-unrestricted") ? document.querySelector("#settings-unrestricted").checked === true : false,
        pythonCommand: document.querySelector("#settings-python-command") ? document.querySelector("#settings-python-command").value.trim() : "",
        mcpCommand: document.querySelector("#mcp-command") ? document.querySelector("#mcp-command").value.trim() : "",
        mcpArgsText: document.querySelector("#mcp-args") ? document.querySelector("#mcp-args").value.trim() : "",
      }),
    });
    document.querySelector("#settings-api-key").value = "";
    settingsSaved = true;
    applyPublicConfig(saved);
    try {
      const status = await api("/api/external/status");
      const statusNode = document.querySelector("#external-status");
      if (statusNode) {
        statusNode.textContent = status.message;
        statusNode.classList.toggle("status-error", status.enabled && !status.available);
      }
    } catch {
      // 保存已经完成。状态探针失败时，下次打开设置仍会再查。
    }
    document.querySelector("#settings-dialog").close();
    toolbarNote.textContent = saved.persist === true ? t("settings.savedDisk") : t("settings.savedMemory");
  } catch (error) {
    note.textContent = error instanceof Error ? error.message : "保存失败";
    showError(t("settings.saveFailed"), error);
  }
});

document.querySelector("#cancel-settings").addEventListener("click", () => {
  document.querySelector("#settings-dialog").close();
});

document.querySelector("#settings-locale").addEventListener("change", (event) => {
  layout.locale = event.target.value === "en" ? "en" : "zh-CN";
  applyChrome();
  renderConversationList();
  renderMessages(lastMessages);
});

document.querySelector("#settings-dialog").addEventListener("close", () => {
  if (!settingsSaved && layoutSnapshot) {
    layout.chatRatio = layoutSnapshot.chatRatio;
    layout.fontSize = layoutSnapshot.fontSize;
    layout.locale = layoutSnapshot.locale === "en" ? "en" : "zh-CN";
    layout.developerMode = layoutSnapshot.developerMode === true;
    applyLayout(true);
    applyChrome();
    renderConversationList();
    renderMessages(lastMessages);
  }
  settingsSaved = false;
  document.querySelector("#settings-api-key").value = "";
  document.querySelector("#settings-test-note").textContent = "";
});

const GIS_PRIMARY_EXTENSIONS = new Set([".shp", ".geojson", ".json", ".gpkg", ".kml", ".kmz", ".mif", ".tab", ".dxf"]);

function gisPrimaryFiles(files) {
  return files.filter((file) => GIS_PRIMARY_EXTENSIONS.has(file.name.slice(file.name.lastIndexOf(".")).toLowerCase()));
}

function formatUploadSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function updateGisFileSummary() {
  const files = Array.from(gisFiles.files || []);
  gisFilesClear.hidden = files.length === 0;
  gisFilesClear.textContent = t("import.clear");
  if (files.length === 0) {
    gisFileSummary.textContent = t("import.none");
    return;
  }
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  const primaryCount = gisPrimaryFiles(files).length;
  const names = files.slice(0, 4).map((file) => file.name).join(layout.locale === "en" ? ", " : "、");
  const remainder = files.length > 4 ? t("import.more").replace("{count}", String(files.length)) : "";
  const sourceText = primaryCount > 0 ? t("import.primary").replace("{count}", String(primaryCount)) : t("import.waiting");
  gisFileSummary.textContent = `${names}${remainder} · ${formatUploadSize(totalSize)} · ${sourceText}`;
}

gisFiles.addEventListener("change", updateGisFileSummary);
gisFilesClear.addEventListener("click", () => {
  gisFiles.value = "";
  updateGisFileSummary();
});
document.addEventListener("dragover", (event) => {
  const types = event.dataTransfer ? Array.from(event.dataTransfer.types) : [];
  if (types.includes("Files") || (types.length === 0 && !draggedLayerId)) event.preventDefault();
});
gisUploadPicker.addEventListener("dragover", (event) => {
  event.preventDefault();
  gisUploadPicker.classList.add("dragging");
});
gisUploadPicker.addEventListener("dragleave", (event) => {
  if (!gisUploadPicker.contains(event.relatedTarget)) gisUploadPicker.classList.remove("dragging");
});
gisUploadPicker.addEventListener("drop", (event) => {
  event.preventDefault();
  gisUploadPicker.classList.remove("dragging");
  if (!event.dataTransfer?.files?.length) return;
  const transfer = new DataTransfer();
  for (const file of event.dataTransfer.files) transfer.items.add(file);
  gisFiles.files = transfer.files;
  updateGisFileSummary();
});

const mapDropTarget = document.querySelector("#map");
mapDropTarget.addEventListener("dragover", (event) => {
  const types = event.dataTransfer ? Array.from(event.dataTransfer.types) : [];
  if (types.includes("text/plain") && !types.includes("Files")) return;
  event.preventDefault();
  mapDropTarget.classList.add("file-drop-active");
});
mapDropTarget.addEventListener("dragleave", (event) => {
  if (!mapDropTarget.contains(event.relatedTarget)) mapDropTarget.classList.remove("file-drop-active");
});
mapDropTarget.addEventListener("drop", (event) => {
  if (!event.dataTransfer?.files?.length) return;
  event.preventDefault();
  mapDropTarget.classList.remove("file-drop-active");
  const transfer = new DataTransfer();
  for (const file of event.dataTransfer.files) transfer.items.add(file);
  gisFiles.files = transfer.files;
  document.querySelector("#load-map").checked = true;
  updateGisFileSummary();
  importDialog.showModal();
  importButton.click();
});

async function uploadSelectedGisFiles(files) {
  const form = new FormData();
  const entries = files.map((file, index) => ({
    field: `file-${index}`,
    relativePath: file.webkitRelativePath || file.name,
  }));
  form.append("metadata", JSON.stringify({
    files: entries,
    indexRag: indexRag.checked,
    loadMap: document.querySelector("#load-map").checked,
    conversationId: conversationState.activeId,
  }));
  files.forEach((file, index) => form.append(`file-${index}`, file, `upload-${index}`));
  return api("/api/import/upload", { method: "POST", headers: {}, body: form });
}

const importButton = document.querySelector("#import-btn");
importButton.addEventListener("click", async () => {
  const files = Array.from(gisFiles.files || []);
  importButton.disabled = true;
  importOut.textContent = files.length > 0 ? t("import.uploading") : t("import.preparing");
  try {
    if (files.length > 0) {
      const totalSize = files.reduce((sum, file) => sum + file.size, 0);
      if (totalSize > 1024 * 1024 * 1024) throw new Error("单次上传不能超过 1 GB，请分批选择文件。");
      const result = await uploadSelectedGisFiles(files);
      const lines = [`已检查 ${result.fileCount} 个上传文件，识别到 ${result.datasets?.length || 0} 个图层数据集。`];
      for (const dataset of result.datasets || []) {
        const missing = Array.isArray(dataset.missing) && dataset.missing.length > 0 ? `缺少 ${dataset.missing.join("、")}` : "文件齐全";
        lines.push(`• ${dataset.name}：${dataset.status === "missing" ? missing : "文件齐全"}`);
        for (const warning of dataset.warnings || []) lines.push(`  提示：${warning}`);
      }
      if (result.mergeNote) lines.push(result.mergeNote);
      lines.push(`识别到 ${result.chunks?.length || 0} 条数据摘要。`);
      if (result.indexed) lines.push(`已写入本地知识库 ${result.entryIds?.length || 0} 条。`);
      await activateConversationMap(conversationState.activeId);
      fitToBoundsList((result.layers || []).map((layer) => {
        const collection = displayCollections.get(layer.layerId);
        return collection ? collectionBounds(collection) : null;
      }));
      saveActiveMapScope();
      if (result.layers?.length) {
        lines.push(`已载入地图 ${result.layers.length} 个图层。`);
        showGeometryIssues(result.layers.flatMap((layer) => layer.geometryIssues || []));
      }
      importOut.textContent = lines.join("\n");
      gisFiles.value = "";
      updateGisFileSummary();
      return;
    }

    const absolutePath = filePath.value.trim();
    if (absolutePath === "") throw new Error("请选择 GIS 文件；如需使用已有路径，请展开高级选项。");
    const result = await api("/api/import", {
      method: "POST",
      body: JSON.stringify({ absolutePath, indexRag: indexRag.checked }),
    });
    importOut.textContent = JSON.stringify(result, null, 2);
    if (document.querySelector("#load-map").checked) {
      try {
        const loaded = await api("/api/map/load", {
          method: "POST",
          body: JSON.stringify({ absolutePath, conversationId: conversationState.activeId }),
        });
        importOut.textContent += `\n${t("import.loaded")}`;
        await activateConversationMap(conversationState.activeId);
        fitToBoundsList((loaded.layers || []).map((layer) => {
          const collection = displayCollections.get(layer.layerId);
          return collection ? collectionBounds(collection) : null;
        }));
        saveActiveMapScope();
        showGeometryIssues((loaded.layers || []).flatMap((layer) => layer.geometryIssues || []));
      } catch (error) {
        importOut.textContent += `\n${error instanceof Error ? error.message : t("import.loadFailed")}`;
        showError("载入地图失败", error);
      }
    }
  } catch (error) {
    importOut.textContent = error instanceof Error ? error.message : t("import.failed");
    showError("导入失败", error);
  } finally {
    importButton.disabled = false;
  }
});

const gdlOut = document.querySelector("#gdl-out");

async function gdlText() {
  const fileInput = document.querySelector("#gdl-file");
  const file = fileInput.files ? fileInput.files[0] : null;
  if (file) {
    if (file.size > 1024 * 1024) throw new Error("GDL 文件太大，请控制在 1MB 以内。");
    const text = await file.text();
    document.querySelector("#gdl-text").value = text;
    fileInput.value = "";
    return text;
  }
  return document.querySelector("#gdl-text").value;
}

function gdlErrorTitle(error) {
  const kind = error && error.payload ? error.payload.kind : "";
  if (kind === "gdl-syntax") return "GDL 语法错误";
  if (kind === "gdl-guard") return "GDL 不能这样写";
  if (kind === "gdl-runtime") return "GDL 执行失败";
  if (kind === "gis-core") return "几何或空间运算错误";
  return "GDL 处理失败";
}

document.querySelector("#gdl-check").addEventListener("click", async () => {
  gdlOut.textContent = "正在检查…";
  try {
    const result = await api("/api/gdl/parse", { method: "POST", body: JSON.stringify({ text: await gdlText() }) });
    gdlOut.textContent = `语法正确，共 ${result.statementCount} 条语句。\n${result.summary}`;
  } catch (error) {
    gdlOut.textContent = error instanceof Error ? error.message : "检查失败";
    showError(gdlErrorTitle(error), error);
  }
});

document.querySelector("#gdl-load").addEventListener("click", async () => {
  gdlOut.textContent = "正在载入…";
  try {
    const result = await api("/api/gdl/load", {
      method: "POST",
      body: JSON.stringify({
        text: await gdlText(),
        writeKnowledge: document.querySelector("#gdl-rag").checked,
        conversationId: conversationState.activeId,
      }),
    });
    const gdlBounds = [];
    for (const layer of result.layers || []) gdlBounds.push(await mountServerLayer(layer));
    fitToBoundsList(gdlBounds);
    await syncLayerStore();
    const names = (result.layers || []).map((layer) => layer.layerName).join("、");
    gdlOut.textContent = `已执行 ${result.steps} 条语句${names ? `，生成图层：${names}` : ""}。${result.indexed ? "摘要已写入知识库。" : ""}\n${result.summary}`;
    showGeometryIssues(result.geometryIssues);
  } catch (error) {
    const partial = error && error.payload && Array.isArray(error.payload.layers) ? error.payload.layers : [];
    for (const layer of partial) {
      try {
        await mountServerLayer(layer);
      } catch {
        // 部分结果挂不上时只报原始错误。
      }
    }
    if (partial.length > 0) await syncLayerStore();
    gdlOut.textContent = error instanceof Error ? error.message : "载入失败";
    showError(gdlErrorTitle(error), error);
  }
});

ragToggle.addEventListener("change", async () => {
  try {
    const saved = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ ragEnabled: ragToggle.checked, ragTopK }),
    });
    if (typeof saved.ragTopK === "number") ragTopK = saved.ragTopK;
    ragToggle.checked = saved.ragEnabled === true;
    toolbarNote.textContent = "";
  } catch (error) {
    toolbarNote.textContent = error instanceof Error ? error.message : "保存检索开关失败";
  }
});

function selectedLayerPayload() {
  if (!selectedLayerId || !knownLayers.has(selectedLayerId)) return null;
  return {
    layerId: selectedLayerId,
    layerName: (layerStyles[selectedLayerId] && layerStyles[selectedLayerId].name) || knownLayers.get(selectedLayerId).layerName || selectedLayerId,
  };
}

function askOperationConfirm(message) {
  const dialog = document.querySelector("#op-confirm");
  const textNode = document.querySelector("#op-confirm-text");
  textNode.textContent = message;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      resolve(value);
    };
    document.querySelector("#op-confirm-ok").onclick = () => finish(true);
    document.querySelector("#op-confirm-cancel").onclick = () => finish(false);
    dialog.addEventListener("close", () => finish(false), { once: true });
    dialog.showModal();
  });
}

function stripDisplayedRolePrefix(text) {
  return String(text || "").replace(/^(?:我|Me)[：:]\s*/i, "");
}

function withConversationId(path) {
  const id = conversationState.activeId;
  if (!id) return path;
  const joiner = path.includes("?") ? "&" : "?";
  return `${path}${joiner}conversationId=${encodeURIComponent(id)}`;
}

function scopeLayerIdsForChat() {
  const scope = typeof currentMapScope === "function" ? currentMapScope(false) : null;
  return scope && Array.isArray(scope.layerIds) ? scope.layerIds.filter((id) => typeof id === "string") : [];
}

async function postChat(text, extra) {
  const conversationId = extra && typeof extra.conversationId === "string" ? extra.conversationId : conversationState.activeId;
  const scopeLayerIds = extra && Array.isArray(extra.scopeLayerIds) ? extra.scopeLayerIds : scopeLayerIdsForChat();
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({
      text,
      stream: true,
      conversationId,
      scopeLayerIds,
      ragEnabled: ragToggle.checked,
      selectedLayer: selectedLayerPayload(),
      ...(extra && extra.confirm === true ? { confirm: true } : {}),
      ...(extra && (extra.outbound === "full" || extra.outbound === "pronoun") ? { outbound: extra.outbound } : {}),
      ...(chosen.model === LOCAL_CHOICE ? { model: LOCAL_CHOICE } : {}),
    }),
  });
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    const payload = await response.json();
    if (!response.ok || payload.ok === false) throw new Error(payload.message || t("chat.sendFailed"));
    return payload;
  }
  let result = null;
  await readSse(response, (event) => {
    if (event.type === "error") throw new Error(event.message || t("chat.sendFailed"));
    if (event.type === "done") result = event;
    else if (conversationState.activeId === conversationId && (!extra || extra.confirm !== true)) applyStreamEvent(event);
  });
  if (!response.ok && !result) throw new Error(t("chat.sendFailed"));
  if (result && result.ok === false) throw new Error(result.message || t("chat.sendFailed"));
  return result;
}

async function applyChatResult(result, originConversationId) {
  if (result && Array.isArray(result.messages) && conversationState.activeId === originConversationId) renderMessages(result.messages);
  await loadConversations();
  const storeTools = result && (result.calls || result.traces || []).some((call) => {
    const name = typeof call.tool === "string" ? call.tool : "";
    return name.startsWith("gdl.") || name === "run_gdl" || name === "map.style" || name === "set_layer_style" || name === "map.setVisibility" || name === "set_layer_visibility" || name === "map.setOrder" || name === "set_layer_order" || name === "delete_layer" || name === "clear_all_layers" || name === "delete_database" || name === "map.delete" || name === "map.clearAll" || name === "map.dropDatabase";
  });
  if (result && Array.isArray(result.layers)) {
    const chatBounds = [];
    for (const layer of result.layers) {
      // 结果归属发起对话：用户中途切走时只登记到原对话的地图范围，切回时显示，不串到新对话。
      if (conversationState.activeId === originConversationId) {
        chatBounds.push(await mountServerLayer(layer, undefined, false, originConversationId));
      } else {
        registerLayerInScope(originConversationId, layer.layerId);
      }
    }
    if (conversationState.activeId === originConversationId) fitToBoundsList(chatBounds);
    showGeometryIssues(result.layers.flatMap((layer) => layer.geometryIssues || []));
  }
  if (storeTools) await syncLayerStore();
  if (conversationState.activeId === originConversationId) {
    for (const id of (result && result.zoomLayerIds) || []) await zoomToLayer(id);
    if (result && result.exportMap === true) exportCurrentMap();
  }
  // L6 结果责任：AI 分析结果附"仅供参考"告知。
  if (result && (Array.isArray(result.layers) || Array.isArray(result.calls) || Array.isArray(result.traces))) {
    const disclaimer = document.createElement("p");
    disclaimer.className = "chat-disclaimer";
    disclaimer.textContent = t("result.disclaimer");
    messages.append(disclaimer);
    stickChatToBottom();
  }
}

function cloudModelSelected() {
  return chosen.choice !== LOCAL_CHOICE && chosen.providerId !== "local";
}

function outboundModeOf(conversationId) {
  const item = conversationState.conversations.find((entry) => entry.id === conversationId);
  return item && (item.outboundMode === "full" || item.outboundMode === "pronoun") ? item.outboundMode : null;
}

function rememberOutbound(conversationId, mode) {
  if (!conversationId || (mode !== "full" && mode !== "pronoun")) return;
  conversationState = {
    ...conversationState,
    conversations: conversationState.conversations.map((entry) => (
      entry.id === conversationId ? { ...entry, outboundMode: mode } : entry
    )),
  };
}

function askOutboundInChat(scrubbed) {
  const note = document.createElement("article");
  note.className = "chat-warning";
  const paragraph = document.createElement("p");
  paragraph.textContent = t("chat.outboundWarning");
  const actions = document.createElement("div");
  actions.className = "warning-actions";
  const send = document.createElement("button");
  send.type = "button";
  send.textContent = t("chat.outboundSend");
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ghost";
  cancel.textContent = t("chat.outboundCancel");
  const preview = document.createElement("p");
  preview.textContent = scrubbed;
  actions.append(send, cancel);
  note.append(paragraph, preview, actions);
  messages.append(note);
  chatFollowing = true;
  messages.scrollTop = messages.scrollHeight;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (mode) => {
      if (settled) return;
      settled = true;
      send.disabled = true;
      cancel.disabled = true;
      paragraph.textContent = mode === "full" ? t("chat.outboundSent") : t("chat.outboundKept");
      preview.remove();
      actions.remove();
      resolve(mode);
    };
    send.addEventListener("click", () => finish("full"));
    cancel.addEventListener("click", () => finish("pronoun"));
  });
}

async function chooseOutbound(text, conversationId) {
  if (!cloudModelSelected()) return null;
  const saved = outboundModeOf(conversationId);
  if (saved === "full" || saved === "pronoun") return saved;
  try {
    const preview = await api("/api/outbound/preview", { method: "POST", body: JSON.stringify({ text }) });
    if (!preview || preview.changed !== true) return null;
    return askOutboundInChat(typeof preview.scrubbed === "string" ? preview.scrubbed : "");
  } catch {
    return null;
  }
}

document.querySelector("#send").addEventListener("click", async () => {
  const text = stripDisplayedRolePrefix(question.value.trim());
  if (text === "" || sending) return;
  const originConversationId = conversationState.activeId;
  const outbound = await chooseOutbound(text, originConversationId);
  const scopeLayerIds = scopeLayerIdsForChat();
  const sendButton = document.querySelector("#send");
  sending = true;
  sendButton.disabled = true;
  sendButton.textContent = t("composer.sending");
  question.value = "";
  resizeQuestion();
  lastMessages = [...lastMessages, { role: "user", text, at: new Date().toISOString() }];
  appendUserBubble(text);
  applyStreamEvent({ type: "thought", kind: "status", code: "starting" });
  try {
    let result = await postChat(text, { conversationId: originConversationId, scopeLayerIds, ...(outbound ? { outbound } : {}) });
    if (result && result.outboundMode) rememberOutbound(originConversationId, result.outboundMode);
    if (result && result.confirmRequired === true) {
      if (Array.isArray(result.messages) && conversationState.activeId === originConversationId) renderMessages(result.messages);
      const accepted = await askOperationConfirm(typeof result.reply === "string" ? result.reply : "");
      if (!accepted) return;
      result = await postChat(text, { confirm: true, conversationId: originConversationId, scopeLayerIds, ...(outbound ? { outbound } : {}) });
      if (result && result.outboundMode) rememberOutbound(originConversationId, result.outboundMode);
    }
    await applyChatResult(result, originConversationId);
  } catch (error) {
    const live = document.querySelector("#live-assistant");
    if (live) live.remove();
    const note = document.createElement("p");
    note.className = "chat-error";
    note.textContent = error instanceof Error ? error.message : t("chat.sendFailed");
    messages.append(note);
    stickChatToBottom();
    showError(t("chat.failed"), error);
  } finally {
    sending = false;
    sendButton.disabled = false;
    sendButton.textContent = t("composer.send");
  }
});

function resizeQuestion() {
  question.style.height = "auto";
  question.style.height = `${Math.min(question.scrollHeight, 144)}px`;
}

question.addEventListener("input", resizeQuestion);
question.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  document.querySelector("#send").click();
});

loadModelConfig().catch(() => undefined);

api("/api/messages")
  .then((payload) => renderMessages(payload.messages))
  .catch(() => undefined);

document.querySelector("#turn-prev").addEventListener("click", () => moveTurn(-1));
document.querySelector("#turn-next").addEventListener("click", () => moveTurn(1));
document.querySelector("#turn-quote").addEventListener("click", () => {
  const text = selectedTurnText();
  if (text === "") return;
  const current = question.value.trim();
  question.value = current === "" ? `引用：\n「${text}」\n\n` : `${current}\n引用：\n「${text}」\n\n`;
  question.focus();
});
document.querySelector("#turn-continue").addEventListener("click", () => {
  const text = selectedTurnText();
  const prefix = text === "" ? "请继续。" : `请基于该轮继续：\n${text}\n\n`;
  question.value = prefix;
  question.focus();
});
document.querySelector("#turn-rollback").addEventListener("click", async () => {
  try {
    const result = await api("/api/conversations/rollback", { method: "POST", body: JSON.stringify({}) });
    renderMessages(result.messages);
    for (const id of result.removedLayerIds || []) {
      if (knownLayers.has(id)) {
        unmountMapLayer(id);
        knownLayers.delete(id);
        removeLayerFromMapScopes(id);
        delete layerStyles[id];
        const orderIndex = layerOrder.indexOf(id);
        if (orderIndex >= 0) layerOrder.splice(orderIndex, 1);
      }
    }
    saveStyles();
    await syncLayerStore();
    await refreshCheckpointSelect();
    toolbarNote.textContent = t("turn.rolled");
  } catch (error) {
    if (error?.payload && Array.isArray(error.payload.messages)) renderMessages(error.payload.messages);
    for (const id of error?.payload?.removedLayerIds || []) {
      if (knownLayers.has(id)) {
        unmountMapLayer(id);
        knownLayers.delete(id);
        removeLayerFromMapScopes(id);
        delete layerStyles[id];
        const orderIndex = layerOrder.indexOf(id);
        if (orderIndex >= 0) layerOrder.splice(orderIndex, 1);
      }
    }
    if (error?.payload?.removedLayerIds?.length) {
      saveStyles();
      await syncLayerStore();
    }
    toolbarNote.textContent = error instanceof Error ? error.message : t("turn.rollbackFailed");
    showError(t("turn.rollbackFailed"), error);
  }
});

document.querySelector("#checkpoint-rerun").addEventListener("click", async () => {
  try {
    const checkpointId = document.querySelector("#checkpoint-select").value;
    if (!checkpointId) throw new Error(t("turn.checkpointMissing"));
    const result = await api("/api/conversations/rollback-checkpoint", {
      method: "POST",
      body: JSON.stringify({ checkpointId }),
    });
    renderMessages(result.messages);
    for (const id of result.removedLayerIds || []) {
      if (knownLayers.has(id)) {
        unmountMapLayer(id);
        knownLayers.delete(id);
        removeLayerFromMapScopes(id);
        delete layerStyles[id];
        const orderIndex = layerOrder.indexOf(id);
        if (orderIndex >= 0) layerOrder.splice(orderIndex, 1);
      }
    }
    saveStyles();
    await syncLayerStore();
    question.value = result.replayText || "";
    resizeQuestion();
    question.focus();
    toolbarNote.textContent = t("turn.checkpointRerunDone");
    await refreshCheckpointSelect();
  } catch (error) {
    if (error?.payload && Array.isArray(error.payload.messages)) renderMessages(error.payload.messages);
    for (const id of error?.payload?.removedLayerIds || []) {
      if (knownLayers.has(id)) {
        unmountMapLayer(id);
        knownLayers.delete(id);
        removeLayerFromMapScopes(id);
        delete layerStyles[id];
        const orderIndex = layerOrder.indexOf(id);
        if (orderIndex >= 0) layerOrder.splice(orderIndex, 1);
      }
    }
    if (error?.payload?.removedLayerIds?.length) {
      saveStyles();
      await syncLayerStore();
    }
    toolbarNote.textContent = error instanceof Error ? error.message : t("turn.rollbackFailed");
    showError(t("turn.rollbackFailed"), error);
  }
});

document.addEventListener("keydown", (event) => {
  if (!event.altKey || event.shiftKey || event.ctrlKey || event.metaKey) return;
  if (event.key === "ArrowUp") {
    event.preventDefault();
    moveTurn(-1);
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    moveTurn(1);
  }
});

function renderConversationList() {
  pruneMapScopes();
  const list = document.querySelector("#conv-list");
  if (!list) return;
  const prevActive = list.querySelector(".conv-item.active");
  const prevActiveId = prevActive?.dataset?.convId || "";
  list.textContent = "";
  for (const item of conversationState.conversations) {
    const row = document.createElement("div");
    const isActive = item.id === conversationState.activeId;
    row.className = isActive ? "conv-item active" : "conv-item";
    row.dataset.convId = item.id;
    // Keep breath continuous when the same chat stays active across re-render.
    if (isActive && prevActiveId === item.id) row.classList.add("conv-keep-breath");
    const title = document.createElement("button");
    title.type = "button";
    title.className = "conv-item-title";
    title.textContent = item.title || t("conv.untitled");
    title.addEventListener("click", () => {
      switchConversation(item.id).catch((error) => showError(t("conv.switchFailed"), error));
    });
    const actions = document.createElement("div");
    actions.className = "conv-item-actions";
    const rename = document.createElement("button");
    rename.type = "button";
    rename.className = "ghost";
    rename.textContent = t("conv.rename");
    rename.addEventListener("click", async (event) => {
      event.stopPropagation();
      const next = window.prompt(t("conv.prompt"), item.title || "");
      if (next === null) return;
      try {
        const payload = await api("/api/conversations/rename", { method: "POST", body: JSON.stringify({ id: item.id, title: next }) });
        conversationState = { activeId: payload.activeId, conversations: payload.conversations || [] };
        renderConversationList();
      } catch (error) {
        showError(t("conv.renameFailed"), error);
      }
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost";
    remove.disabled = false;
    remove.textContent = t("conv.delete");
    remove.addEventListener("click", async (event) => {
      event.stopPropagation();
      const deletingActive = item.id === conversationState.activeId;
      try {
        if (deletingActive) saveActiveMapScope();
        const payload = await api("/api/conversations/delete", { method: "POST", body: JSON.stringify({ id: item.id }) });
        dropConversationMapScope(item.id);
        conversationState = { activeId: payload.activeId, conversations: payload.conversations || [] };
        renderConversationList();
        if (deletingActive) chatFollowing = true;
        renderMessages(payload.messages || []);
        if (deletingActive) {
          await activateConversationMap(conversationState.activeId);
          await refreshWorkspaceFiles();
        }
        if (deletingActive) await refreshCheckpointSelect();
      } catch (error) {
        showError(t("conv.deleteFailed"), error);
      }
    });
    actions.append(rename, remove);
    row.append(title, actions);
    list.append(row);
  }
}

async function loadConversations() {
  const payload = await api("/api/conversations");
  conversationState = { activeId: payload.activeId, conversations: payload.conversations || [] };
  renderConversationList();
  await refreshCheckpointSelect();
}

async function refreshCheckpointSelect() {
  const select = document.querySelector("#checkpoint-select");
  if (!select || !conversationState.activeId) return;
  const conversationId = conversationState.activeId;
  select.textContent = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = t("turn.checkpointPlaceholder");
  select.append(placeholder);
  try {
    const query = `?conversationId=${encodeURIComponent(conversationId)}`;
    const payload = await api(`/api/conversations/checkpoints${query}`);
    if (conversationId !== conversationState.activeId) return;
    for (const checkpoint of payload.checkpoints || []) {
      const option = document.createElement("option");
      option.value = checkpoint.id;
      const time = new Date(checkpoint.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const prompt = String(checkpoint.replayText || "").replace(/\s+/g, " ").slice(0, 32);
      option.textContent = `${time} · ${prompt}`;
      select.append(option);
    }
  } catch {
    select.textContent = "";
    select.append(placeholder);
  }
}

let switchSeq = 0;

async function switchConversation(id) {
  if (id === conversationState.activeId) return;
  saveActiveMapScope();
  const seq = ++switchSeq;
  // Optimistic highlight + suppress breath restart / chat flash while waiting.
  const chatRoot = document.querySelector(".chat");
  if (chatRoot) chatRoot.classList.add("chat-switching");
  conversationState = { ...conversationState, activeId: id };
  renderConversationList();
  const payload = await api("/api/conversations/switch", { method: "POST", body: JSON.stringify({ id }) });
  // 快速连续切换：只应用最后一次请求的响应，防止旧响应覆盖新对话。
  if (seq !== switchSeq) return;
  conversationState = { activeId: payload.activeId, conversations: payload.conversations || [] };
  selectedTurnIndex = -1;
  renderConversationList();
  chatFollowing = true;
  renderMessages(payload.messages || []);
  if (chatRoot) {
    requestAnimationFrame(() => chatRoot.classList.remove("chat-switching"));
  }
  // Map / files / checkpoints in parallel — do not serialize UI wait.
  await Promise.all([
    activateConversationMap(conversationState.activeId),
    refreshWorkspaceFiles(),
    refreshCheckpointSelect(),
  ]);
}

document.querySelector("#conv-new").addEventListener("click", async () => {
  try {
    saveActiveMapScope();
    const chatRoot = document.querySelector(".chat");
    if (chatRoot) chatRoot.classList.add("chat-switching");
    const payload = await api("/api/conversations", { method: "POST", body: JSON.stringify({}) });
    conversationState = { activeId: payload.activeId, conversations: payload.conversations || [] };
    selectedTurnIndex = -1;
    renderConversationList();
    chatFollowing = true;
    renderMessages(payload.messages || []);
    if (chatRoot) {
      requestAnimationFrame(() => chatRoot.classList.remove("chat-switching"));
    }
    await Promise.all([
      activateConversationMap(conversationState.activeId),
      refreshWorkspaceFiles(),
      refreshCheckpointSelect(),
    ]);
  } catch (error) {
    showError(t("conv.createFailed"), error);
  }
});

async function refreshMemoryList() {
  const payload = await api("/api/memory");
  const list = document.querySelector("#memory-list");
  const note = document.querySelector("#memory-note");
  if (!list) return;
  list.textContent = "";
  const items = payload.items || [];
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "还没有记忆。";
    list.append(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "memory-row";
    const text = document.createElement("p");
    text.textContent = item.text;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost";
    button.textContent = "删除";
    button.addEventListener("click", async () => {
      try {
        await api("/api/memory/delete", { method: "POST", body: JSON.stringify({ id: item.id }) });
        if (note) note.textContent = "已删除这条记忆。";
        await refreshMemoryList();
      } catch (error) {
        if (note) note.textContent = error instanceof Error ? error.message : "删除失败";
        showError("记忆没有删除", error);
      }
    });
    row.append(text, button);
    list.append(row);
  }
}

document.querySelector("#memory-add").addEventListener("click", async () => {
  const input = document.querySelector("#memory-text");
  const note = document.querySelector("#memory-note");
  try {
    await api("/api/memory/add", { method: "POST", body: JSON.stringify({ text: input.value }) });
    input.value = "";
    if (note) note.textContent = "已保存。";
    await refreshMemoryList();
  } catch (error) {
    if (note) note.textContent = error instanceof Error ? error.message : "没有保存";
    showError("记忆没有保存", error);
  }
});

const docsDrawer = document.querySelector("#docs-drawer");
const KIND_LABEL = { rag: "知识库", gdl: "GDL", export: "导出" };

async function refreshDocuments() {
  const payload = await api("/api/documents");
  const list = document.querySelector("#docs-list");
  list.textContent = "";
  const documents = payload.documents || [];
  if (documents.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "还没有可列出的项目文档。";
    list.append(empty);
    return;
  }
  for (const doc of documents) {
    const row = document.createElement("article");
    row.className = "doc-row";
    const title = document.createElement("p");
    title.textContent = `${KIND_LABEL[doc.kind] || doc.kind} · ${doc.title || doc.name}`;
    const actions = document.createElement("div");
    actions.className = "conv-item-actions";
    if (doc.canDownload) {
      const open = document.createElement("a");
      open.className = "tool-btn";
      open.textContent = "下载";
      open.href = `/api/documents/file?kind=${encodeURIComponent(doc.kind)}&id=${encodeURIComponent(doc.id)}`;
      open.setAttribute("download", doc.name || doc.id);
      actions.append(open);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost";
    remove.textContent = "删除";
    remove.addEventListener("click", async () => {
      try {
        await api("/api/documents/delete", { method: "POST", body: JSON.stringify({ kind: doc.kind, id: doc.id }) });
        document.querySelector("#docs-note").textContent = "已删除。";
        await refreshDocuments();
      } catch (error) {
        document.querySelector("#docs-note").textContent = error instanceof Error ? error.message : "删除失败";
        showError("文档没有删除", error);
      }
    });
    actions.append(remove);
    row.append(title, actions);
    list.append(row);
  }
}

document.querySelector("#open-docs").addEventListener("click", () => {
  const menu = document.querySelector("#records-menu");
  if (menu) menu.open = false;
  docsDrawer.classList.add("open");
  refreshDocuments().catch((error) => {
    document.querySelector("#docs-note").textContent = error instanceof Error ? error.message : "读不到文档";
    showError("读不到文档", error);
  });
});

document.querySelector("#close-docs").addEventListener("click", () => {
  docsDrawer.classList.remove("open");
});

document.querySelector("#docs-refresh").addEventListener("click", () => {
  refreshDocuments().catch((error) => showError("刷新文档失败", error));
});

document.querySelector("#docs-add").addEventListener("click", async () => {
  const fileInput = document.querySelector("#docs-file");
  const file = fileInput.files ? fileInput.files[0] : null;
  const note = document.querySelector("#docs-note");
  try {
    if (!file) throw new Error("请选择文本或 Markdown 文件。");
    const text = await readRagFile(file);
    await api("/api/documents/add", {
      method: "POST",
      body: JSON.stringify({
        title: document.querySelector("#docs-title").value.trim(),
        fileName: file.name,
        text,
      }),
    });
    fileInput.value = "";
    note.textContent = "已添加到知识库。";
    await refreshDocuments();
  } catch (error) {
    note.textContent = error instanceof Error ? error.message : "没有添加";
    showError("文档没有添加", error);
  }
});

const VIEW_KEY = "igis.v05.mapView";
const STYLE_KEY = "igis.v05.layerStyle";
const MAP_SCOPE_KEY = "igis.ui.conversationMapScopes.v1";
const FILLS = ["#2f6f5e", "#3d6f9a", "#8a5a2a", "#6b4c7a", "#8d3b3b"];
const OP_LABEL = {
  buffer: "缓冲",
  intersect: "相交",
  clip: "裁剪",
  "spatial-query": "空间查询",
  stats: "统计",
  "map-load": "载入地图",
  export: "导出",
  "gdl-load": "GDL 载入",
  "gdl-export": "GDL 导出",
  "rollback": "回退",
};

const mapNote = document.querySelector("#map-note");
const layerPanel = document.querySelector("#layer-panel");
const layerList = document.querySelector("#layer-list");
const mapPanel = document.querySelector("#map-panel");
const auditDrawer = document.querySelector("#audit-drawer");
const auditList = document.querySelector("#audit-list");
const layerStyles = readStyles();
const knownLayers = new Map();
const layerOrder = [];
let mapScopes = readMapScopes();
let selectedLayerId = null;
let draggedLayerId = "";
let map = null;
let mapReady = Promise.resolve();
let mapScopeRevision = 0;
let activeFeaturePopup = null;
let boxMode = false;
let boxStart = null;
let fitted = false;

function readMapScopes() {
  try {
    const parsed = JSON.parse(localStorage.getItem(MAP_SCOPE_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const normalized = {};
    for (const [conversationId, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") continue;
      const center = Array.isArray(value.view?.center) ? value.view.center : null;
      const zoom = value.view?.zoom;
      const validView = center?.length === 2
        && Number.isFinite(center[0])
        && Number.isFinite(center[1])
        && Math.abs(center[1]) <= 90
        && Number.isFinite(zoom)
        && zoom >= 0
        && zoom <= 24;
      normalized[conversationId] = {
        layerIds: Array.isArray(value.layerIds) ? [...new Set(value.layerIds.filter((id) => typeof id === "string"))] : [],
        order: Array.isArray(value.order) ? [...new Set(value.order.filter((id) => typeof id === "string"))] : [],
        selectedLayerId: typeof value.selectedLayerId === "string" ? value.selectedLayerId : null,
        view: validView
          ? { zoom, center }
          : null,
      };
    }
    return normalized;
  } catch {
    return {};
  }
}

function saveMapScopes() {
  try {
    localStorage.setItem(MAP_SCOPE_KEY, JSON.stringify(mapScopes));
  } catch {
    mapNote.textContent = "对话地图状态无法保存在此浏览器中。";
  }
}

function currentMapScope(create = true) {
  const id = conversationState.activeId;
  if (!id) return null;
  if (!mapScopes[id] && create) mapScopes[id] = { layerIds: [], order: [], selectedLayerId: null, view: null };
  return mapScopes[id] || null;
}

function layerInAnotherConversation(layerId) {
  return Object.entries(mapScopes).some(([conversationId, scope]) => (
    conversationId !== conversationState.activeId && scope.layerIds.includes(layerId)
  ));
}

function saveActiveMapScope() {
  const scope = currentMapScope(false);
  if (!scope) return;
  scope.order = layerOrder.filter((id) => knownLayers.has(id));
  if (selectedLayerId && knownLayers.has(selectedLayerId)) scope.selectedLayerId = selectedLayerId;
  if (map) {
    const center = map.getCenter();
    scope.view = { zoom: map.getZoom(), center: [center.lng, center.lat] };
  }
  saveMapScopes();
}

function pruneMapScopes() {
  const live = new Set(conversationState.conversations.map((item) => item.id));
  let changed = false;
  for (const id of Object.keys(mapScopes)) {
    if (live.has(id)) continue;
    delete mapScopes[id];
    changed = true;
  }
  if (changed) saveMapScopes();
}

function dropConversationMapScope(conversationId) {
  if (!conversationId || !Object.prototype.hasOwnProperty.call(mapScopes, conversationId)) return;
  delete mapScopes[conversationId];
  saveMapScopes();
}

function removeLayerFromMapScopes(layerId) {
  for (const scope of Object.values(mapScopes)) {
    scope.layerIds = scope.layerIds.filter((id) => id !== layerId);
    scope.order = scope.order.filter((id) => id !== layerId);
    if (scope.selectedLayerId === layerId) scope.selectedLayerId = null;
  }
  saveMapScopes();
}

function registerLayerInScope(conversationId, layerId) {
  if (!conversationId || typeof conversationId !== "string") return;
  const scope = mapScopes[conversationId] || (mapScopes[conversationId] = { layerIds: [], order: [], selectedLayerId: null, view: null });
  if (!scope.layerIds.includes(layerId) && !layerInAnotherConversation(layerId)) scope.layerIds.push(layerId);
  saveMapScopes();
}

function registerLayerInActiveMapScope(layerId) {
  const scope = currentMapScope();
  if (!scope) return;
  registerLayerInScope(conversationState.activeId, layerId);
}

function renderSceneList(node, items, emptyKey) {
  node.replaceChildren();
  if (items.length === 0) {
    const item = document.createElement("li");
    item.textContent = t(emptyKey);
    node.append(item);
    return;
  }
  for (const text of items) {
    const item = document.createElement("li");
    item.textContent = text;
    node.append(item);
  }
}

const sceneState = {
  view: null,
  conversationId: null,
  payload: null,
  grids: new Map(),
  collections: new Map(),
  stackKey: "",
  geologyKey: "",
  step: 0,
  timer: null,
  seriesScale: null,
};

function sceneView() {
  if (!sceneState.view) {
    if (!window.IgisScene) throw new Error(t("scene.noRenderer"));
    sceneState.view = window.IgisScene.create(document.querySelector("#scene-canvas"));
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(() => sceneState.view && sceneState.view.draw()).observe(document.querySelector("#scene-canvas"));
    }
  }
  return sceneState.view;
}

async function sceneGrid(query) {
  const key = `${sceneState.conversationId}|${query}`;
  if (!sceneState.grids.has(key)) {
    const promise = api(`/api/scene/terrain?conversationId=${encodeURIComponent(sceneState.conversationId)}&${query}`);
    sceneState.grids.set(key, promise);
    promise.catch(() => sceneState.grids.delete(key));
  }
  return sceneState.grids.get(key);
}

function fillSceneSelect(select, options, keep) {
  const previous = keep ? select.value : "";
  select.replaceChildren();
  for (const option of options) {
    const node = document.createElement("option");
    node.value = option.value;
    node.textContent = option.label;
    select.append(node);
  }
  if (options.some((option) => option.value === previous)) select.value = previous;
  return select.value;
}

function activeSceneSeries() {
  const id = document.querySelector("#scene-series").value;
  const series = sceneState.payload && Array.isArray(sceneState.payload.series) ? sceneState.payload.series : [];
  return series.find((item) => item.seriesId === id) || null;
}

function stopScenePlayback() {
  if (sceneState.timer) clearInterval(sceneState.timer);
  sceneState.timer = null;
  document.querySelector("#scene-play").textContent = t("scene.play");
}

function sceneLegendFor(kind, scale) {
  if (kind === "runoff") return fillTemplate("scene.legendRunoff", { max: String(Math.round(scale.max * 100) / 100) });
  if (kind === "landslide") return t("scene.legendLandslide");
  return fillTemplate("scene.legendRaster", { min: String(Math.round(scale.min * 100) / 100), max: String(Math.round(scale.max * 100) / 100) });
}

async function applySceneTerrain() {
  const view = sceneView();
  const value = document.querySelector("#scene-terrain").value;
  if (value === "") {
    view.setTerrain(null);
    return;
  }
  const [kind, id] = value.split(":");
  const grid = await sceneGrid(kind === "series" ? `series=${encodeURIComponent(id)}` : `handle=${encodeURIComponent(id)}`);
  view.setTerrain(grid);
}

async function applySceneDrape() {
  const view = sceneView();
  const legend = document.querySelector("#scene-legend");
  const series = activeSceneSeries();
  const label = document.querySelector("#scene-time-label");
  const slider = document.querySelector("#scene-time");
  document.querySelector("#scene-drape").disabled = series !== null;
  if (series) {
    const steps = Array.isArray(series.steps) ? series.steps : [];
    slider.max = String(Math.max(steps.length - 1, 0));
    sceneState.step = Math.min(sceneState.step, Math.max(steps.length - 1, 0));
    slider.value = String(sceneState.step);
    const step = steps[sceneState.step];
    if (!step) return;
    if (!sceneState.seriesScale || sceneState.seriesScale.id !== series.seriesId) {
      const grids = await Promise.all(steps.map((item) => sceneGrid(`handle=${encodeURIComponent(item.handle)}`)));
      const maxima = grids.map((grid) => (typeof grid.maximum === "number" ? grid.maximum : 0));
      const minima = grids.map((grid) => (typeof grid.minimum === "number" ? grid.minimum : 0));
      sceneState.seriesScale = { id: series.seriesId, min: Math.min(...minima), max: Math.max(...maxima) };
    }
    const grid = await sceneGrid(`handle=${encodeURIComponent(step.handle)}`);
    view.setDrape(grid, series.kind, sceneState.seriesScale);
    label.textContent = fillTemplate("scene.hour", { hours: String(Math.round(step.hours * 100) / 100) });
    legend.textContent = sceneLegendFor(series.kind, sceneState.seriesScale);
    return;
  }
  slider.max = "0";
  label.textContent = "";
  const handle = document.querySelector("#scene-drape").value;
  if (handle === "") {
    view.setDrape(null);
    legend.textContent = "";
    return;
  }
  const grid = await sceneGrid(`handle=${encodeURIComponent(handle)}`);
  const scale = { min: grid.minimum ?? 0, max: grid.maximum ?? 1 };
  view.setDrape(grid, "raster", scale);
  legend.textContent = sceneLegendFor("raster", scale);
}

async function applySceneStack(stack) {
  const view = sceneView();
  if (!stack || !Array.isArray(stack.order) || stack.order.length < 2) {
    if (sceneState.stackKey !== "") view.setStack(null);
    sceneState.stackKey = "";
    return;
  }
  const key = `${stack.gap}|${stack.order.map((item) => item.layerId).join(",")}`;
  if (key === sceneState.stackKey) return;
  const collections = await Promise.all(stack.order.map(async (item) => {
    if (!sceneState.collections.has(item.layerId)) {
      sceneState.collections.set(item.layerId, api(withConversationId(`/api/map/layers/${encodeURIComponent(item.layerId)}/geojson`)));
    }
    return sceneState.collections.get(item.layerId);
  }));
  const prepared = window.IgisScene.stackFromCollections(collections, stack.gap);
  view.setStack(prepared);
  sceneState.stackKey = key;
}

async function applySceneGeology(model) {
  const view = sceneView();
  const key = model ? JSON.stringify(model) : "";
  if (key === sceneState.geologyKey) return;
  sceneState.geologyKey = key;
  if (!model) {
    view.setGeology(null);
    return;
  }
  const voxels = await api(`/api/scene/geology?conversationId=${encodeURIComponent(sceneState.conversationId)}`);
  view.setGeology(voxels);
}

async function refreshScene() {
  const scenePanel = document.querySelector("#scene-panel");
  if (!scenePanel || scenePanel.hidden) return;
  const conversationId = conversationState.activeId;
  if (!conversationId) return;
  const payload = await api(`/api/scene?conversationId=${encodeURIComponent(conversationId)}`);
  const switched = sceneState.conversationId !== conversationId;
  if (switched) {
    stopScenePlayback();
    sceneState.grids.clear();
    sceneState.stackKey = "";
    sceneState.geologyKey = "";
    sceneState.step = 0;
    sceneState.seriesScale = null;
  }
  sceneState.conversationId = conversationId;
  sceneState.payload = payload;
  document.querySelector("#scene-note").textContent = typeof payload.note === "string" ? payload.note : "";
  const seriesList = Array.isArray(payload.series) ? payload.series.filter((item) => item && typeof item.seriesId === "string") : [];
  const handles = (Array.isArray(payload.rasters) ? payload.rasters : []).filter((item) => item && typeof item.handle === "string").map((item) => item.handle);
  const terrainOptions = [{ value: "", label: t("scene.none") }];
  for (const item of seriesList) terrainOptions.push({ value: `series:${item.seriesId}`, label: fillTemplate("scene.seriesTerrain", { label: item.label }) });
  if (payload.geologyModel && payload.geologyModel.clipped) terrainOptions.push({ value: "series:geology", label: t("scene.geologyTerrain") });
  for (const handle of handles) terrainOptions.push({ value: `handle:${handle}`, label: handle });
  const terrainSelect = document.querySelector("#scene-terrain");
  const keptTerrain = fillSceneSelect(terrainSelect, terrainOptions, !switched);
  fillSceneSelect(document.querySelector("#scene-drape"), [{ value: "", label: t("scene.none") }, ...handles.map((handle) => ({ value: handle, label: handle }))], !switched);
  const seriesSelect = document.querySelector("#scene-series");
  const keptSeries = fillSceneSelect(seriesSelect, [{ value: "", label: t("scene.none") }, ...seriesList.map((item) => ({ value: item.seriesId, label: item.label }))], !switched);
  if (keptSeries === "" && seriesList.length > 0 && switched) seriesSelect.value = seriesList[seriesList.length - 1].seriesId;
  if (keptTerrain === "" && terrainOptions.length > 1) {
    const series = activeSceneSeries();
    terrainSelect.value = series ? `series:${series.seriesId}` : terrainOptions[1].value;
  }
  const layers = Array.isArray(payload.layers) ? payload.layers : [];
  renderSceneList(document.querySelector("#scene-layers"), layers
    .filter((layer) => layer && typeof layer.layerId === "string")
    .map((layer) => `${typeof layer.layerName === "string" && layer.layerName !== "" ? layer.layerName : layer.layerId}（${layer.layerId}）`), "scene.emptyLayers");
  const rasters = Array.isArray(payload.rasters) ? payload.rasters : [];
  renderSceneList(document.querySelector("#scene-rasters"), rasters
    .filter((item) => item && typeof item.handle === "string")
    .map((item) => item.handle), "scene.emptyRasters");
  const stack = payload.stack;
  const stackNode = document.querySelector("#scene-stack");
  if (stack && Array.isArray(stack.order) && stack.order.length >= 2 && typeof stack.gap === "number") {
    const order = stack.order
      .filter((item) => item && typeof item.layerId === "string")
      .map((item) => `${item.layerName || item.layerId}（${item.layerId}）`)
      .join("、");
    stackNode.textContent = `${fillTemplate("scene.stack", { gap: String(stack.gap) })} ${order}`;
  } else {
    stackNode.textContent = t("scene.noStack");
  }
  const geology = payload.geology;
  const geologyNode = document.querySelector("#scene-geology");
  if (geology && typeof geology.layerId === "string" && geology.contactField && geology.dipField && geology.azimuthField) {
    geologyNode.textContent = fillTemplate("scene.geology", {
      layer: `${geology.layerName || geology.layerId}（${geology.layerId}）`,
      contact: geology.contactField,
      dip: geology.dipField,
      azimuth: geology.azimuthField,
    });
  } else {
    geologyNode.textContent = t("scene.noGeology");
  }
  const model = payload.geologyModel;
  if (model && Array.isArray(model.units) && Array.isArray(model.volumes)) {
    geologyNode.textContent += ` ${fillTemplate("scene.geologyModel", {
      units: model.units.slice(1).join("、"),
      volumes: model.units.map((unit, index) => `${index === 0 ? t("scene.belowLowest") : unit} ${Math.round(model.volumes[index] || 0)}`).join("，"),
    })}`;
  }
  if (terrainOptions.length === 1 && !payload.stack && !payload.geologyModel) {
    document.querySelector("#scene-note").textContent = t("scene.empty");
  }
  await Promise.all([applySceneTerrain(), applySceneStack(payload.stack), applySceneGeology(payload.geologyModel)]);
  await applySceneDrape();
}

function sceneFailure(error) {
  document.querySelector("#scene-note").textContent = error instanceof Error ? error.message : t("scene.failed");
}

document.querySelector("#scene-terrain").addEventListener("change", () => {
  applySceneTerrain().then(() => applySceneDrape()).catch(sceneFailure);
});
document.querySelector("#scene-drape").addEventListener("change", () => applySceneDrape().catch(sceneFailure));
document.querySelector("#scene-series").addEventListener("change", () => {
  stopScenePlayback();
  sceneState.step = 0;
  const series = activeSceneSeries();
  if (series) document.querySelector("#scene-terrain").value = `series:${series.seriesId}`;
  applySceneTerrain().then(() => applySceneDrape()).catch(sceneFailure);
});
document.querySelector("#scene-time").addEventListener("input", (event) => {
  sceneState.step = Number(event.target.value) || 0;
  applySceneDrape().catch(sceneFailure);
});
document.querySelector("#scene-play").addEventListener("click", () => {
  if (sceneState.timer) {
    stopScenePlayback();
    return;
  }
  const series = activeSceneSeries();
  if (!series || !Array.isArray(series.steps) || series.steps.length < 2) {
    document.querySelector("#scene-note").textContent = t("scene.needSeries");
    return;
  }
  document.querySelector("#scene-play").textContent = t("scene.pause");
  sceneState.timer = setInterval(() => {
    sceneState.step = (sceneState.step + 1) % series.steps.length;
    applySceneDrape().catch((error) => {
      stopScenePlayback();
      sceneFailure(error);
    });
  }, 1200);
});
document.querySelector("#scene-exaggeration").addEventListener("change", (event) => {
  if (sceneState.view) sceneState.view.setExaggeration(event.target.value);
});
for (const name of ["terrain", "drape", "stack", "geology"]) {
  document.querySelector(`#scene-show-${name}`).addEventListener("change", (event) => {
    if (sceneState.view) sceneState.view.setVisible(name, event.target.checked);
  });
}
document.querySelector("#scene-reset").addEventListener("click", () => {
  if (sceneState.view) sceneState.view.resetView();
});

function setWorkspaceView(scene) {
  const panel = document.querySelector("#map-panel");
  const scenePanel = document.querySelector("#scene-panel");
  const sceneGroup = document.querySelector("#resource-scene-group");
  const resourcePanel = document.querySelector("#file-tree");
  const resourceToggle = document.querySelector("#resource-toggle");
  panel.classList.toggle("showing-scene", scene);
  document.body.classList.toggle("workspace-scene", scene);
  scenePanel.hidden = !scene;
  if (sceneGroup) {
    sceneGroup.hidden = !scene;
    if (scene) sceneGroup.open = true;
  }
  document.querySelector("#view-flat").setAttribute("aria-selected", scene ? "false" : "true");
  document.querySelector("#view-scene").setAttribute("aria-selected", scene ? "true" : "false");
  if (scene) {
    if (resourcePanel && resourcePanel.classList.contains("is-collapsed")) {
      resourcePanel.classList.remove("is-collapsed");
      if (resourceToggle) resourceToggle.setAttribute("aria-expanded", "true");
    }
    refreshScene().catch(sceneFailure);
    requestAnimationFrame(() => {
      if (typeof map !== "undefined" && map) map.resize();
      if (sceneState.view) sceneState.view.draw();
    });
  } else if (typeof map !== "undefined" && map) {
    stopScenePlayback();
    requestAnimationFrame(() => map.resize());
  }
}

document.querySelector("#view-flat").addEventListener("click", () => setWorkspaceView(false));
document.querySelector("#view-scene").addEventListener("click", () => setWorkspaceView(true));

async function activateConversationMap(conversationId, payload) {
  const revision = ++mapScopeRevision;
  await ensureMap();
  if (!map || revision !== mapScopeRevision) return;
  for (const id of [...knownLayers.keys()]) unmountMapLayer(id);
  knownLayers.clear();
  layerOrder.length = 0;
  selectedLayerId = null;
  const selection = map.getSource("igis-selection");
  if (selection) selection.setData({ type: "FeatureCollection", features: [] });
  clearBoxRectangle();
  if (activeFeaturePopup) activeFeaturePopup.remove();
  activeFeaturePopup = null;
  boxMode = false;
  boxStart = null;
  map.dragPan.enable();
  map.getCanvas().style.cursor = "";
  document.querySelector("#box-select").textContent = t("map.box");
  mapNote.textContent = "";
  renderLayerPanel();
  refreshLayerChoices();

  const layersPayload = payload || await api(withConversationId("/api/map/layers"));
  if (revision !== mapScopeRevision) return;
  const listed = await api(`/api/workspace/layers?conversationId=${encodeURIComponent(conversationId)}`);
  if (revision !== mapScopeRevision) return;
  const serverIds = Array.isArray(listed.layerIds) ? listed.layerIds.filter((id) => typeof id === "string") : [];
  const layerList = Array.isArray(layersPayload.layers) ? layersPayload.layers : [];
  let scope = mapScopes[conversationId];
  if (!scope) {
    scope = { layerIds: [], order: [], selectedLayerId: null, view: null };
    mapScopes[conversationId] = scope;
  }
  const wanted = new Set(serverIds);
  const available = layerList.filter((layer) => wanted.has(layer.layerId));
  const serverOrder = Array.isArray(layersPayload.order) ? layersPayload.order : [];
  fitted = Boolean(scope.view);
  if (scope.view) {
    map.jumpTo({ center: scope.view.center, zoom: scope.view.zoom });
  } else {
    map.jumpTo({ center: [104.2, 35.6], zoom: 3.4 });
  }
  for (const layer of available) {
    if (revision !== mapScopeRevision) return;
    try {
      await mountServerLayer(layer, revision);
    } catch {
      mapNote.textContent = "有图层没有载入，其余图层仍可使用。";
    }
  }
  if (revision !== mapScopeRevision) return;
  const availableIds = new Set(available.map((layer) => layer.layerId));
  scope.layerIds = serverIds.filter((id) => availableIds.has(id));
  const preferredOrder = scope.order.length > 0 ? scope.order : serverOrder;
  layerOrder.length = 0;
  layerOrder.push(...preferredOrder.filter((id) => availableIds.has(id)));
  for (const layer of available) if (!layerOrder.includes(layer.layerId)) layerOrder.push(layer.layerId);
  selectedLayerId = scope.selectedLayerId && knownLayers.has(scope.selectedLayerId)
    ? scope.selectedLayerId
    : (layerOrder[0] || null);
  restackMapLayers();
  renderLayerPanel();
  refreshLayerChoices();
  saveActiveMapScope();
  requestAnimationFrame(() => map.resize());
  refreshScene().catch(() => undefined);
}

function readView() {
  try {
    const parsed = JSON.parse(localStorage.getItem(VIEW_KEY) || "");
    if (!parsed || typeof parsed.zoom !== "number" || !Array.isArray(parsed.center) || parsed.center.length !== 2) return null;
    const lng = parsed.center[0];
    const lat = parsed.center[1];
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || !Number.isFinite(parsed.zoom)) return null;
    if (parsed.zoom < 0 || parsed.zoom > 24) return null;
    return { zoom: parsed.zoom, center: [lng, lat] };
  } catch {
    return null;
  }
}

function readStyles() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STYLE_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveStyles() {
  const compact = {};
  for (const [id, style] of Object.entries(layerStyles)) {
    compact[id] = {
      name: style.name,
      visible: style.visible !== false,
      opacity: style.opacity,
      fill: style.fill,
      outline: style.outline,
      width: style.width,
    };
  }
  localStorage.setItem(STYLE_KEY, JSON.stringify(compact));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** maplibre-gl 6 把嵌套属性还原成对象，这里转回 JSON 文本，显示和 4.x 一致。 */
function propertyText(value) {
  return value !== null && typeof value === "object" ? JSON.stringify(value) : value;
}

function defaultStyle(id) {
  const saved = layerStyles[id];
  if (saved && typeof saved === "object") {
    return {
      name: typeof saved.name === "string" ? saved.name : id,
      visible: saved.visible !== false,
      opacity: typeof saved.opacity === "number" ? saved.opacity : 0.55,
      fill: typeof saved.fill === "string" ? saved.fill : FILLS[knownLayers.size % FILLS.length],
      outline: typeof saved.outline === "string" ? saved.outline : "#1c2430",
      width: typeof saved.width === "number" ? saved.width : 1.5,
      colorField: typeof saved.colorField === "string" ? saved.colorField : null,
      labelField: typeof saved.labelField === "string" ? saved.labelField : null,
    };
  }
  return {
    name: id,
    visible: true,
    opacity: 0.55,
    fill: FILLS[knownLayers.size % FILLS.length],
    outline: "#1c2430",
    width: 1.5,
    colorField: null,
    labelField: null,
  };
}

/** 样式写在当前对话自己的图层目录里。这里只做防抖同步。 */
const pendingStyleIds = new Set();
let styleSyncTimer = 0;
let orderSyncTimer = 0;

function storeStyleOf(style) {
  return {
    fill: style.fill,
    outline: style.outline,
    width: style.width,
    opacity: style.opacity,
    visible: style.visible !== false,
    colorField: typeof style.colorField === "string" && style.colorField !== "" ? style.colorField : null,
    labelField: typeof style.labelField === "string" && style.labelField !== "" ? style.labelField : null,
  };
}

function queueStyleSync(id) {
  pendingStyleIds.add(id);
  clearTimeout(styleSyncTimer);
  styleSyncTimer = setTimeout(() => {
    const styles = {};
    for (const pending of pendingStyleIds) {
      if (layerStyles[pending]) styles[pending] = storeStyleOf(layerStyles[pending]);
    }
    pendingStyleIds.clear();
    if (Object.keys(styles).length === 0) return;
    api("/api/map/layer/style", { method: "POST", body: JSON.stringify({ styles, conversationId: conversationState.activeId }) }).catch((error) => {
      showError("图层样式没有保存", error);
    });
  }, 300);
}

function queueOrderSync() {
  clearTimeout(orderSyncTimer);
  orderSyncTimer = setTimeout(() => {
    api("/api/map/layer/order", { method: "POST", body: JSON.stringify({ order: [...layerOrder], conversationId: conversationState.activeId }) }).catch((error) => {
      showError("图层顺序没有保存", error);
    });
  }, 300);
}

function adoptServerStyle(id, serverStyle) {
  const style = layerStyles[id] || defaultStyle(id);
  if (serverStyle && typeof serverStyle === "object") {
    if (typeof serverStyle.fill === "string") style.fill = serverStyle.fill;
    if (typeof serverStyle.outline === "string") style.outline = serverStyle.outline;
    if (typeof serverStyle.width === "number") style.width = serverStyle.width;
    if (typeof serverStyle.opacity === "number") style.opacity = serverStyle.opacity;
    if (typeof serverStyle.visible === "boolean") style.visible = serverStyle.visible;
    if (typeof serverStyle.colorField === "string" || serverStyle.colorField === null) style.colorField = serverStyle.colorField || null;
    if (typeof serverStyle.labelField === "string" || serverStyle.labelField === null) style.labelField = serverStyle.labelField || null;
  }
  layerStyles[id] = style;
  return style;
}

/** 地图只显示当前对话在服务端登记的图层。图层库里其余历史图层不挂到这张地图上。 */
async function syncLayerStore() {
  const conversationId = conversationState.activeId;
  const [payload, listed] = await Promise.all([
    api(withConversationId("/api/map/layers")),
    conversationId
      ? api(`/api/workspace/layers?conversationId=${encodeURIComponent(conversationId)}`)
      : Promise.resolve({ layerIds: [] }),
  ]);
  const allowed = new Set((listed.layerIds || []).filter((id) => typeof id === "string"));
  const visible = (payload.layers || []).filter((layer) => allowed.has(layer.layerId));
  const visibleIds = new Set(visible.map((layer) => layer.layerId));
  for (const id of [...knownLayers.keys()]) {
    if (visibleIds.has(id)) continue;
    unmountMapLayer(id);
    knownLayers.delete(id);
    delete layerStyles[id];
    const orderIndex = layerOrder.indexOf(id);
    if (orderIndex >= 0) layerOrder.splice(orderIndex, 1);
    if (selectedLayerId === id) selectedLayerId = null;
  }
  const scope = currentMapScope(false);
  if (scope) {
    scope.layerIds = scope.layerIds.filter((id) => visibleIds.has(id));
    if (scope.selectedLayerId && !visibleIds.has(scope.selectedLayerId)) scope.selectedLayerId = null;
  }
  for (const layer of visible) {
    if (knownLayers.has(layer.layerId)) {
      adoptServerStyle(layer.layerId, layer.style);
      if (layer.layerName) layerStyles[layer.layerId].name = layer.layerName;
      knownLayers.set(layer.layerId, { ...knownLayers.get(layer.layerId), ...layer });
      applyStyle(layer.layerId, false);
    } else {
      await mountServerLayer(layer);
    }
  }
  if (Array.isArray(payload.order)) {
    const scope = currentMapScope(false);
    const preferredOrder = scope && scope.order.length > 0 ? scope.order : payload.order;
    layerOrder.length = 0;
    layerOrder.push(...preferredOrder.filter((id) => knownLayers.has(id)));
    for (const id of knownLayers.keys()) if (!layerOrder.includes(id)) layerOrder.push(id);
  }
  restackMapLayers();
  renderLayerPanel();
  refreshLayerChoices();
  saveActiveMapScope();
}

const CLASS_COLORS = ["#1b4f72", "#148f77", "#b9770e", "#922b21", "#6c3483", "#1a5276", "#196f3d", "#9a7d0a", "#1abc9c", "#d35400", "#2c3e50", "#7d3c98"];
const LABEL_FONT = "600 12px sans-serif";
const LABEL_HEIGHT = 14;
const POINT_SYMBOL_RADIUS = 5;
let labelCanvas = null;
let labelFrame = 0;
/** 每个图层交给地图的显示用要素集合。设色和注记从这里读，不依赖地图库的内部字段。 */
const displayCollections = new Map();

function displayFeatures(id) {
  const collection = displayCollections.get(id);
  return collection && Array.isArray(collection.features) ? collection.features : [];
}

function classifiedColor(id, field, fallback) {
  if (!field || !map) return fallback;
  const features = displayFeatures(id);
  const keys = [];
  for (const feature of features) {
    const value = feature.properties ? feature.properties[field] : undefined;
    if (value === undefined || value === null) continue;
    const key = String(value);
    if (!keys.includes(key)) keys.push(key);
    if (keys.length >= 12) break;
  }
  if (keys.length === 0) return fallback;
  const expression = ["match", ["to-string", ["get", field]]];
  keys.forEach((key, index) => {
    expression.push(key, CLASS_COLORS[index % CLASS_COLORS.length]);
  });
  expression.push(fallback);
  return expression;
}

function projectPair(pair) {
  if (!Array.isArray(pair) || typeof pair[0] !== "number" || typeof pair[1] !== "number") return null;
  const point = map.project(pair);
  return [point.x, point.y];
}

function projectPath(path) {
  return Array.isArray(path) ? path.map(projectPair).filter((pair) => pair !== null) : [];
}

function ringArea(ring) {
  let area = 0;
  for (let i = 1; i < ring.length; i += 1) area += ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1];
  return Math.abs(area) / 2;
}

/** 一个要素的注记候选。面取屏幕面积最大的部件，线取屏幕最长的部件。 */
function labelCandidate(feature, text, width, rank, placement) {
  const geometry = feature.geometry;
  if (!geometry) return null;
  if (geometry.type === "Point") {
    const anchor = projectPair(geometry.coordinates);
    return anchor ? { kind: "point", anchors: [anchor], radius: POINT_SYMBOL_RADIUS, size: 0, rank, text, width, height: LABEL_HEIGHT } : null;
  }
  if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") {
    const parts = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
    let best = null;
    for (const part of parts) {
      const rings = (Array.isArray(part) ? part : []).map(projectPath).filter((ring) => ring.length >= 3);
      if (rings.length === 0) continue;
      const area = ringArea(rings[0]);
      if (!best || area > best.area) best = { rings, area };
    }
    if (!best || best.area < width * LABEL_HEIGHT) return null;
    const anchor = placement.polygonAnchor(best.rings);
    return anchor ? { kind: "polygon", anchors: [anchor.point], size: best.area, rank, text, width, height: LABEL_HEIGHT } : null;
  }
  if (geometry.type === "LineString" || geometry.type === "MultiLineString") {
    const parts = geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
    let best = null;
    for (const part of parts) {
      const anchors = placement.lineAnchors(projectPath(part));
      if (!best || anchors.length > best.length) best = anchors;
    }
    return best && best.anchors.length > 0 ? { kind: "line", anchors: best.anchors, size: best.length, rank, text, width, height: LABEL_HEIGHT } : null;
  }
  return null;
}

function ensureLabelCanvas() {
  if (!map) return null;
  const container = map.getContainer();
  if (!labelCanvas) {
    labelCanvas = document.createElement("canvas");
    labelCanvas.className = "map-label-layer";
    container.appendChild(labelCanvas);
  }
  const ratio = window.devicePixelRatio || 1;
  const width = container.clientWidth;
  const height = container.clientHeight;
  if (labelCanvas.width !== Math.round(width * ratio) || labelCanvas.height !== Math.round(height * ratio)) {
    labelCanvas.width = Math.round(width * ratio);
    labelCanvas.height = Math.round(height * ratio);
    labelCanvas.style.width = `${width}px`;
    labelCanvas.style.height = `${height}px`;
  }
  return labelCanvas;
}

function clearLabels() {
  if (!labelCanvas) return;
  const context = labelCanvas.getContext("2d");
  if (context) context.clearRect(0, 0, labelCanvas.width, labelCanvas.height);
}

/** 所有带注记字段的可见图层一起放置：上层图层先放，注记之间不重叠，也不压住点符号。 */
function renderLabels() {
  const placement = globalThis.IgisLabelPlacement;
  const canvas = ensureLabelCanvas();
  if (!canvas || !placement) return;
  const context = canvas.getContext("2d");
  if (!context) return;
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.width / ratio;
  const height = canvas.height / ratio;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.font = LABEL_FONT;
  context.textBaseline = "top";
  const items = [];
  const symbols = [];
  let skipped = 0;
  orderedLayerIds().forEach((id, rank) => {
    const style = layerStyles[id];
    if (!style || style.visible === false) return;
    const features = displayFeatures(id);
    for (const feature of features.slice(0, 5000)) {
      if (feature.geometry && feature.geometry.type === "Point") {
        const anchor = projectPair(feature.geometry.coordinates);
        if (anchor && anchor[0] >= -20 && anchor[1] >= -20 && anchor[0] <= width + 20 && anchor[1] <= height + 20) {
          symbols.push({ x: anchor[0], y: anchor[1], r: POINT_SYMBOL_RADIUS });
        }
      }
    }
    if (!style.labelField) return;
    for (const feature of features) {
      const value = feature.properties ? feature.properties[style.labelField] : undefined;
      if (value === undefined || value === null || value === "") continue;
      if (items.length >= 2000) {
        skipped += 1;
        continue;
      }
      const text = String(value).slice(0, 40);
      const candidate = labelCandidate(feature, text, Math.ceil(context.measureText(text).width), rank, placement);
      if (candidate) items.push({ id: items.length, ...candidate });
      else skipped += 1;
    }
  });
  const result = placement.placeLabels(items, { width, height, padding: 2, symbols });
  context.lineJoin = "round";
  context.lineWidth = 3;
  context.strokeStyle = "#f7f4ee";
  context.fillStyle = "#1c2430";
  for (const label of result.placed) {
    context.strokeText(label.text, label.x, label.y + 1);
    context.fillText(label.text, label.x, label.y + 1);
  }
  canvas.dataset.placed = String(result.placed.length);
  canvas.dataset.dropped = String(result.dropped.length + skipped);
}

function scheduleLabels() {
  if (labelFrame) return;
  labelFrame = requestAnimationFrame(() => {
    labelFrame = 0;
    renderLabels();
  });
}

function syncLabels() {
  scheduleLabels();
}

function applyStyle(id, sync) {
  if (!map) return;
  const style = layerStyles[id];
  if (!style) return;
  const visibility = style.visible ? "visible" : "none";
  for (const suffix of ["fill", "line", "circle"]) {
    const layerId = `${id}-${suffix}`;
    if (!map.getLayer(layerId)) continue;
    map.setLayoutProperty(layerId, "visibility", visibility);
  }
  const fillColor = classifiedColor(id, style.colorField, style.fill);
  if (map.getLayer(`${id}-fill`)) {
    map.setPaintProperty(`${id}-fill`, "fill-color", fillColor);
    map.setPaintProperty(`${id}-fill`, "fill-opacity", style.opacity);
  }
  if (map.getLayer(`${id}-line`)) {
    map.setPaintProperty(`${id}-line`, "line-color", style.colorField ? fillColor : style.outline);
    map.setPaintProperty(`${id}-line`, "line-width", style.width);
    map.setPaintProperty(`${id}-line`, "line-opacity", Math.min(1, style.opacity + 0.3));
  }
  if (map.getLayer(`${id}-circle`)) {
    map.setPaintProperty(`${id}-circle`, "circle-color", fillColor);
    map.setPaintProperty(`${id}-circle`, "circle-stroke-color", style.outline);
    map.setPaintProperty(`${id}-circle`, "circle-stroke-width", Math.max(0.5, style.width));
    map.setPaintProperty(`${id}-circle`, "circle-opacity", style.opacity);
  }
  syncLabels();
  saveStyles();
  if (sync !== false) queueStyleSync(id);
}

function queryLayerIds() {
  const ids = [];
  for (const id of knownLayers.keys()) {
    if (layerStyles[id]?.visible === false) continue;
    for (const suffix of ["fill", "line", "circle"]) ids.push(`${id}-${suffix}`);
  }
  return ids.filter((id) => map && map.getLayer(id));
}

function unmountMapLayer(id) {
  if (!map) return;
  if (activeFeaturePopup) activeFeaturePopup.remove();
  activeFeaturePopup = null;
  for (const suffix of ["fill", "line", "circle"]) {
    const layerId = `${id}-${suffix}`;
    if (map.getLayer(layerId)) map.removeLayer(layerId);
  }
  if (map.getSource(id)) map.removeSource(id);
  displayCollections.delete(id);
  scheduleLabels();
}

function rememberLayerOrder(id) {
  if (!layerOrder.includes(id)) layerOrder.unshift(id);
}

function orderedLayerIds() {
  for (const id of knownLayers.keys()) {
    if (!layerOrder.includes(id)) layerOrder.push(id);
  }
  return layerOrder.filter((id) => knownLayers.has(id));
}

function restackMapLayers() {
  if (!map) return;
  for (let index = layerOrder.length - 1; index >= 0; index -= 1) {
    const id = layerOrder[index];
    for (const suffix of ["fill", "line", "circle"]) {
      const layerId = `${id}-${suffix}`;
      if (map.getLayer(layerId)) map.moveLayer(layerId);
    }
  }
  if (map.getLayer("igis-box-fill")) map.moveLayer("igis-box-fill");
  if (map.getLayer("igis-box-line")) map.moveLayer("igis-box-line");
  if (map.getLayer("igis-selection-line")) map.moveLayer("igis-selection-line");
  if (map.getLayer("igis-selection-circle")) map.moveLayer("igis-selection-circle");
}

function moveLayerInOrder(fromId, beforeId) {
  if (fromId === "" || fromId === beforeId) return;
  const from = layerOrder.indexOf(fromId);
  const to = layerOrder.indexOf(beforeId);
  if (from < 0 || to < 0) return;
  layerOrder.splice(from, 1);
  layerOrder.splice(to, 0, fromId);
  restackMapLayers();
  renderLayerPanel();
  queueOrderSync();
  saveActiveMapScope();
}

function downloadText(fileName, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportLayerGdl(id) {
  const result = await api("/api/gdl/export", { method: "POST", body: JSON.stringify({ layerId: id }) });
  downloadText(result.fileName, result.text);
  mapNote.textContent = result.omitted > 0
    ? `已导出 ${result.fileName}（服务端也写入 var/gdl），省略了 ${result.omitted} 个几何集合要素。`
    : `已导出 ${result.fileName}，服务端也写入了 var/gdl。`;
}

async function indexLayerGdlSummary(id) {
  await api("/api/gdl/summary", { method: "POST", body: JSON.stringify({ layerId: id, writeKnowledge: true }) });
  mapNote.textContent = "已把这个图层的 GDL 摘要写入知识库，摘要不含几何。";
}

const layerMenu = document.createElement("div");
layerMenu.className = "layer-menu";
layerMenu.hidden = true;
layerMenu.addEventListener("click", (event) => event.stopPropagation());
document.body.append(layerMenu);

function closeLayerMenu() {
  layerMenu.hidden = true;
  layerMenu.textContent = "";
}

function openLayerMenu(x, y, id) {
  closeLayerMenu();
  const style = layerStyles[id];
  const hideButton = document.createElement("button");
  hideButton.type = "button";
  hideButton.textContent = style && style.visible === false ? "显示" : "隐藏";
  hideButton.addEventListener("click", () => {
    if (!layerStyles[id]) return;
    layerStyles[id].visible = style && style.visible === false;
    applyStyle(id);
    renderLayerList();
    closeLayerMenu();
  });
  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.textContent = "删除";
  deleteButton.addEventListener("click", () => {
    closeLayerMenu();
    deleteLayer(id).catch((error) => {
      mapNote.textContent = error instanceof Error ? error.message : "删除图层失败";
      showError("删除图层失败", error);
    });
  });
  const gdlButton = document.createElement("button");
  gdlButton.type = "button";
  gdlButton.textContent = "导出为GDL";
  gdlButton.addEventListener("click", () => {
    closeLayerMenu();
    exportLayerGdl(id).catch((error) => showError("导出 GDL 失败", error));
  });
  const summaryButton = document.createElement("button");
  summaryButton.type = "button";
  summaryButton.textContent = "GDL摘要写入知识库";
  summaryButton.addEventListener("click", () => {
    closeLayerMenu();
    indexLayerGdlSummary(id).catch((error) => showError("GDL 摘要没有写入", error));
  });
  layerMenu.append(hideButton, gdlButton, summaryButton, deleteButton);
  layerMenu.hidden = false;
  const width = 180;
  const height = 168;
  layerMenu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width))}px`;
  layerMenu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height))}px`;
}

document.addEventListener("click", () => closeLayerMenu());
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeLayerMenu();
});

function renderLayerList() {
  layerList.textContent = "";
  const ids = orderedLayerIds();
  if (ids.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "还没有图层。导入 GIS 后可以勾选载入地图。";
    layerList.append(empty);
    return;
  }
  if (!selectedLayerId || !knownLayers.has(selectedLayerId)) {
    selectedLayerId = ids[0] ?? null;
  }
  for (const id of ids) {
    const style = layerStyles[id];
    const meta = knownLayers.get(id);
    const title = style?.name || meta?.layerName || id;
    const row = document.createElement("article");
    row.className = "layer-list-row";
    row.draggable = true;
    if (id === selectedLayerId) row.classList.add("selected");
    row.innerHTML = `
      <span class="drag-handle" title="拖动调整叠放顺序">↕</span>
      <span class="layer-name">${escapeHtml(title)}</span>
      <label class="check"><input class="layer-visible" type="checkbox" ${style?.visible === false ? "" : "checked"} /> 显示</label>
      <button class="tool-btn layer-delete" type="button" aria-label="${escapeHtml(t("map.removeLayer"))}" title="${escapeHtml(t("map.removeLayer"))}">移除</button>
    `;
    row.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".check") || target.closest(".layer-delete")) return;
      selectedLayerId = id;
      saveActiveMapScope();
      renderLayerPanel();
    });
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      selectedLayerId = id;
      saveActiveMapScope();
      renderLayerPanel();
      openLayerMenu(event.clientX, event.clientY, id);
    });
    row.addEventListener("dragstart", (event) => {
      draggedLayerId = id;
      row.classList.add("dragging");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", id);
      }
      closeLayerMenu();
    });
    row.addEventListener("dragend", () => {
      draggedLayerId = "";
      row.classList.remove("dragging");
      for (const item of layerList.querySelectorAll(".drag-over")) item.classList.remove("drag-over");
    });
    row.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", (event) => {
      event.preventDefault();
      row.classList.remove("drag-over");
      const fromId = (event.dataTransfer && event.dataTransfer.getData("text/plain")) || draggedLayerId;
      moveLayerInOrder(fromId, id);
    });
    row.querySelector(".layer-visible").addEventListener("change", (event) => {
      layerStyles[id].visible = event.target.checked;
      applyStyle(id);
      updateMapEmptyState();
    });
    row.querySelector(".layer-delete").addEventListener("click", (event) => {
      event.stopPropagation();
      deleteLayer(id).catch((error) => {
        mapNote.textContent = error instanceof Error ? error.message : "删除图层失败";
        showError("删除图层失败", error);
      });
    });
    layerList.append(row);
  }
}

function renderStyleRow(id) {
  const style = layerStyles[id];
  const meta = knownLayers.get(id);
  const row = document.createElement("article");
  row.className = "layer-row";
  row.dataset.id = id;
  const title = style?.name || meta?.layerName || id;
  row.innerHTML = `
    <label>名称 <input class="layer-rename" type="text" value="${escapeHtml(title)}" /></label>
    <label>透明度 <input class="layer-opacity" type="range" min="0" max="100" value="${Math.round((style?.opacity ?? 0.55) * 100)}" /></label>
    <label>填充色 <input class="layer-fill" type="color" value="${style?.fill || "#2f6f5e"}" /></label>
    <label>轮廓色 <input class="layer-outline" type="color" value="${style?.outline || "#1c2430"}" /></label>
    <label>轮廓宽度 <input class="layer-width" type="number" min="0.5" max="12" step="0.5" value="${style?.width ?? 1.5}" /></label>
  `;
  row.querySelector(".layer-rename").addEventListener("change", async (event) => {
    const name = event.target.value.trim();
    if (name === "") return;
    layerStyles[id].name = name;
    saveStyles();
    try {
      await api("/api/map/rename", { method: "POST", body: JSON.stringify({ layerId: id, layerName: name, conversationId: conversationState.activeId }) });
    } catch (error) {
      mapNote.textContent = error instanceof Error ? error.message : "重命名失败";
      showError("重命名失败", error);
    }
    renderLayerList();
    refreshLayerChoices();
  });
  row.querySelector(".layer-opacity").addEventListener("input", (event) => {
    layerStyles[id].opacity = Number(event.target.value) / 100;
    applyStyle(id);
  });
  row.querySelector(".layer-fill").addEventListener("input", (event) => {
    layerStyles[id].fill = event.target.value;
    applyStyle(id);
  });
  row.querySelector(".layer-outline").addEventListener("input", (event) => {
    layerStyles[id].outline = event.target.value;
    applyStyle(id);
  });
  row.querySelector(".layer-width").addEventListener("input", (event) => {
    layerStyles[id].width = Number(event.target.value);
    applyStyle(id);
  });
  return row;
}

async function removeLayerFromStore(id) {
  await api("/api/map/layer/delete", { method: "POST", body: JSON.stringify({ layerId: id, confirm: true, conversationId: conversationState.activeId }) });
  unmountMapLayer(id);
  knownLayers.delete(id);
  delete layerStyles[id];
  removeLayerFromMapScopes(id);
  const orderIndex = layerOrder.indexOf(id);
  if (orderIndex >= 0) layerOrder.splice(orderIndex, 1);
  saveStyles();
  if (selectedLayerId === id) selectedLayerId = null;
  renderLayerPanel();
  refreshLayerChoices();
  mapNote.textContent = "已从 Igis 图层库移除这个图层。";
}

async function deleteLayer(id) {
  const confirmed = await askOperationConfirm("将从 Igis 图层库移除此图层及其派生输出文件。原始输入文件不会被删除。确认后才会执行。");
  if (!confirmed) return;
  await removeLayerFromStore(id);
}

document.querySelector("#clear-chat-layers").addEventListener("click", async () => {
  const ids = [...knownLayers.keys()];
  if (ids.length === 0) {
    mapNote.textContent = "本对话没有可移除的图层。";
    return;
  }
  const message = t("map.clearLayersConfirm").replace("{count}", String(ids.length));
  const confirmed = await askOperationConfirm(message);
  if (!confirmed) return;
  mapNote.textContent = "正在移除本对话图层…";
  const failed = [];
  for (const id of ids) {
    try {
      await removeLayerFromStore(id);
    } catch {
      failed.push(layerStyles[id]?.name || knownLayers.get(id)?.layerName || id);
    }
  }
  mapNote.textContent = failed.length > 0
    ? t("map.layersClearPartial").replace("{names}", failed.join("、"))
    : t("map.layersCleared");
});

function mapUsesSchematicDisplay() {
  for (const [id, meta] of knownLayers) {
    if (meta && meta.schematicDisplay === true && layerStyles[id]?.visible !== false) return true;
  }
  return false;
}

function layerCrsText(meta) {
  if (!meta) return "";
  const label = typeof meta.crsLabel === "string" ? meta.crsLabel.trim() : "";
  if (meta.schematicDisplay === true) {
    const base = label || t("map.crsUnknown");
    return `${base} · ${t("map.crsSchematic")}`;
  }
  return label;
}

function renderPreview(fields) {
  const write = (id, value) => {
    const node = document.querySelector(id);
    if (node) node.textContent = value === "" || value === undefined || value === null ? "—" : String(value);
  };
  write("#preview-name", fields.name);
  write("#preview-type", fields.type);
  write("#preview-count", fields.count);
  write("#preview-fields", fields.fields);
  write("#preview-crs", fields.crs);
}

function renderLayerDetail() {
  const id = selectedLayerId && knownLayers.has(selectedLayerId) ? selectedLayerId : null;
  if (!id) {
    renderPreview({ name: "", type: "", count: "", fields: "", crs: "" });
    return;
  }
  const meta = knownLayers.get(id);
  const name = layerStyles[id]?.name || meta?.layerName || id;
  const type = typeof meta?.geometryKind === "string" && meta.geometryKind !== "" ? meta.geometryKind : "图层";
  const count = Number.isFinite(meta?.featureCount) ? String(meta.featureCount) : "";
  const names = Array.isArray(meta?.fieldNames)
    ? meta.fieldNames.filter((item) => typeof item === "string" && item.trim() !== "").join("、")
    : "";
  const crs = layerCrsText(meta);
  renderPreview({ name, type, count, fields: names, crs });
}

function renderLayerPanel() {
  renderLayerList();
  renderLayerDetail();
  updateMapEmptyState();
  layerPanel.textContent = "";
  if (!selectedLayerId || !knownLayers.has(selectedLayerId)) {
    selectedLayerId = knownLayers.keys().next().value ?? null;
  }
  if (!selectedLayerId) {
    const empty = document.createElement("p");
    empty.textContent = "选择图层后，可以调整透明度、填充色、轮廓色和轮廓宽度。";
    layerPanel.append(empty);
    return;
  }
  layerPanel.append(renderStyleRow(selectedLayerId));
}

function updateMapEmptyState() {
  const emptyState = document.querySelector("#map-empty-state");
  if (!emptyState) return;
  const hasVisibleLayers = [...knownLayers.keys()].some((id) => layerStyles[id]?.visible !== false);
  emptyState.hidden = hasVisibleLayers;
  const title = emptyState.querySelector("strong");
  const hint = emptyState.querySelector("span:last-child");
  if (title) title.textContent = knownLayers.size > 0 ? "图层已隐藏" : "暂无图层数据";
  if (hint) hint.textContent = knownLayers.size > 0 ? "在图层列表中打开显示" : "导入 GIS 图层后将在此显示";
}

function refreshLayerChoices() {
  const exportName = document.querySelector("#export-layer-name");
  if (!exportName) return;
  const meta = selectedLayerId ? knownLayers.get(selectedLayerId) : null;
  const name = meta ? (layerStyles[selectedLayerId]?.name || meta.layerName || selectedLayerId) : "";
  exportName.textContent = name ? `导出图层：${name}` : "在资源树里选择要导出的图层";
}

function walkCoordinates(value, visit) {
  if (!Array.isArray(value) || value.length === 0) return;
  if (typeof value[0] === "number") {
    visit(value[0], value[1]);
    return;
  }
  for (const item of value) walkCoordinates(item, visit);
}

function collectionBounds(collection) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let geographic = true;
  for (const feature of collection.features || []) {
    walkCoordinates(feature.geometry && feature.geometry.coordinates, (x, y) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      if (Math.abs(x) > 180 || Math.abs(y) > 90) geographic = false;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    });
  }
  if (!Number.isFinite(minX)) return null;
  return { bounds: [[minX, minY], [maxX, maxY]], geographic };
}

/**
 * 平面坐标示意显示：局部/工程坐标按 1 单位 ≈ 1/111320 度线性映射到经纬度窗口，
 * 只用于绘图，图层库数据不变；同一坐标空间的图层保持相对位置。
 */
function planarDisplayCollection(collection) {
  const clone = JSON.parse(JSON.stringify(collection));
  const scale = 1 / 111320;
  const visit = (coords) => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === "number") {
      coords[0] = (coords[0] || 0) * scale;
      coords[1] = (coords[1] || 0) * scale;
      return;
    }
    for (const item of coords) visit(item);
  };
  for (const feature of clone.features || []) {
    if (feature.geometry && feature.geometry.coordinates) visit(feature.geometry.coordinates);
  }
  return clone;
}

/** 载入绘图用集合：非经纬度的坐标先做平面示意映射。返回值只用于地图显示。 */
function displayCollection(collection) {
  const bounds = collectionBounds(collection);
  if (!bounds || bounds.geographic) return collection;
  return planarDisplayCollection(collection);
}

/** 框选拖动时的实时矩形：屏幕坐标转经纬度画在 igis-box 上。 */
function drawBoxRectangle(start, end) {
  const source = map && map.getSource("igis-box");
  if (!source) return;
  const west = Math.min(start.x, end.x);
  const east = Math.max(start.x, end.x);
  const north = Math.min(start.y, end.y);
  const south = Math.max(start.y, end.y);
  if (east - west < 2 && south - north < 2) return;
  const sw = map.unproject([west, south]);
  const ne = map.unproject([east, north]);
  source.setData({
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [[[sw.lng, sw.lat], [ne.lng, sw.lat], [ne.lng, ne.lat], [sw.lng, ne.lat], [sw.lng, sw.lat]]],
      },
    }],
  });
}

function clearBoxRectangle() {
  const source = map && map.getSource("igis-box");
  if (source) source.setData({ type: "FeatureCollection", features: [] });
}

function exportCurrentMap() {
  if (!map) return;
  const source = map.getCanvas();
  const legendWidth = 220;
  const canvas = document.createElement("canvas");
  canvas.width = source.width + legendWidth;
  canvas.height = source.height + 56;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.fillStyle = "#f4f1ea";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0);
  renderLabels();
  if (labelCanvas) context.drawImage(labelCanvas, 0, 0, source.width, source.height);
  const meters = scaleBarMeters(source.width);
  context.fillStyle = "#1c2430";
  context.fillRect(16, source.height + 18, 80, 4);
  context.font = "12px sans-serif";
  context.fillText(meters, 16, source.height + 42);
  let top = 16;
  context.font = "13px sans-serif";
  for (const id of orderedLayerIds()) {
    const style = layerStyles[id];
    if (!style || style.visible === false) continue;
    context.fillStyle = style.fill || "#2f6f5e";
    context.fillRect(source.width + 16, top, 14, 14);
    context.fillStyle = "#1c2430";
    const label = style.colorField ? `${style.name || id}（${style.colorField}）` : (style.name || id);
    context.fillText(String(label).slice(0, 18), source.width + 38, top + 12);
    top += 22;
    if (top > canvas.height - 20) break;
  }
  const link = document.createElement("a");
  link.href = canvas.toDataURL("image/png");
  link.download = "igis-map.png";
  link.click();
  mapNote.textContent = "已导出当前地图。";
}

function scaleBarMeters(width) {
  if (!map) return "";
  const y = map.getContainer().clientHeight / 2;
  const left = map.unproject([width / 2 - 40, y]);
  const right = map.unproject([width / 2 + 40, y]);
  const geographic = Math.abs(left.lng) <= 180 && Math.abs(left.lat) <= 90 && Math.abs(right.lng) <= 180 && Math.abs(right.lat) <= 90;
  if (!geographic) return "80 px";
  const toRad = Math.PI / 180;
  const dLat = (right.lat - left.lat) * toRad;
  const dLng = (right.lng - left.lng) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(left.lat * toRad) * Math.cos(right.lat * toRad) * Math.sin(dLng / 2) ** 2;
  const meters = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  if (meters >= 1000) return `${(meters / 1000).toFixed(meters >= 10000 ? 0 : 1)} km`;
  return `${Math.round(meters)} m`;
}

async function zoomToLayer(id) {
  await ensureMap();
  if (!map || !id) return;
  fitted = true;
  let collection = null;
  try {
    const response = await fetch(withConversationId(`/api/map/layers/${id}/geojson`));
    if (response.ok) collection = displayCollection(await response.json());
  } catch {
    collection = null;
  }
  const bounds = collection ? collectionBounds(collection) : null;
  if (!bounds) {
    mapNote.textContent = "已经请求缩放到该图层，但没有可用范围。";
    return;
  }
  try {
    map.fitBounds(bounds.bounds, { padding: 28, maxZoom: 14, duration: 0 });
    mapNote.textContent = bounds.geographic ? "已缩放到图层。" : "已缩放到图层。坐标可能不是经纬度。";
  } catch {
    mapNote.textContent = "缩放到图层没有完成。";
  }
}

async function mountServerLayer(layer, expectedScopeRevision, fit = false, registerTo = undefined) {
  if (!layer || !layer.layerId) return null;
  if (expectedScopeRevision !== undefined && expectedScopeRevision !== mapScopeRevision) return;
  await ensureMap();
  if (expectedScopeRevision !== undefined && expectedScopeRevision !== mapScopeRevision) return;
  if (knownLayers.has(layer.layerId) && map && map.getSource(layer.layerId)) {
    registerLayerInScope(registerTo ?? conversationState.activeId, layer.layerId);
    layerStyles[layer.layerId].visible = true;
    applyStyle(layer.layerId);
    renderLayerPanel();
    saveActiveMapScope();
    return;
  }
  const response = await fetch(withConversationId(layer.mapUrl || `/api/map/layers/${layer.layerId}/geojson`));
  if (!response.ok) throw new Error("读不到图层几何");
  const rawCollection = await response.json();
  const collection = displayCollection(rawCollection);
  const schematicDisplay = collection !== rawCollection;
  if (expectedScopeRevision !== undefined && expectedScopeRevision !== mapScopeRevision) return;
  ensureMap();
  if (!map) throw new Error("地图没有准备好");
  const fromStore = layer.style && typeof layer.style === "object";
  const style = defaultStyle(layer.layerId);
  if (layer.layerName) style.name = fromStore ? layer.layerName : (layerStyles[layer.layerId]?.name || layer.layerName);
  layerStyles[layer.layerId] = style;
  if (fromStore) adoptServerStyle(layer.layerId, layer.style);
  knownLayers.set(layer.layerId, { ...layer, schematicDisplay });
  registerLayerInScope(registerTo ?? conversationState.activeId, layer.layerId);
  rememberLayerOrder(layer.layerId);
  displayCollections.set(layer.layerId, collection);
  map.addSource(layer.layerId, { type: "geojson", data: collection });
  map.addLayer({
    id: `${layer.layerId}-fill`,
    type: "fill",
    source: layer.layerId,
    filter: ["==", "$type", "Polygon"],
    paint: { "fill-color": style.fill, "fill-opacity": style.opacity },
  });
  map.addLayer({
    id: `${layer.layerId}-line`,
    type: "line",
    source: layer.layerId,
    filter: ["!=", "$type", "Point"],
    paint: { "line-color": style.outline, "line-width": style.width },
  });
  map.addLayer({
    id: `${layer.layerId}-circle`,
    type: "circle",
    source: layer.layerId,
    filter: ["==", "$type", "Point"],
    paint: {
      "circle-color": style.fill,
      "circle-radius": 5,
      "circle-stroke-color": style.outline,
      "circle-stroke-width": style.width,
      "circle-opacity": style.opacity,
    },
  });
  applyStyle(layer.layerId, !fromStore);
  restackMapLayers();
  renderLayerPanel();
  refreshLayerChoices();
  const bounds = collectionBounds(collection);
  // fit=true（导入、分析结果等用户动作）：无条件对准新图层，不受历史视图限制。
  // fit=false：沿用旧规则——本回合还没定位过且坐标是经纬度时才定位一次。
  const shouldFit = (fit || !fitted) && bounds && bounds.geographic;
  if (shouldFit) {
    try {
      map.fitBounds(bounds.bounds, { padding: 28, maxZoom: 14, duration: 0 });
      fitted = true;
    } catch {
      mapNote.textContent = "图层已载入。当前视图未改动。";
    }
  } else if (collectionBounds(rawCollection) && !collectionBounds(rawCollection).geographic) {
    mapNote.textContent = "图层已载入。局部平面坐标按示意比例显示，位置非真实地理位置。";
  } else if (bounds && !bounds.geographic) {
    mapNote.textContent = "图层已载入。坐标可能不是经纬度，地图位置可能不正确。";
  }
  saveActiveMapScope();
  return bounds;
}

/** 多图层联合定位：导入多个文件后一次对准全部新图层。 */
function fitToBoundsList(boundsList) {
  const validBounds = boundsList.filter((item) => item && Array.isArray(item.bounds));
  const geographic = validBounds.filter((item) => item.geographic);
  const selectedBounds = geographic.length > 0 ? geographic : validBounds.slice(-1);
  if (selectedBounds.length === 0) return;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const item of selectedBounds) {
    west = Math.min(west, item.bounds[0][0]);
    south = Math.min(south, item.bounds[0][1]);
    east = Math.max(east, item.bounds[1][0]);
    north = Math.max(north, item.bounds[1][1]);
  }
  if (!Number.isFinite(west) || !Number.isFinite(south)) return;
  try {
    map.fitBounds([[west, south], [east, north]], { padding: 28, maxZoom: 14, duration: 0 });
    fitted = true;
  } catch {
    // 定位失败不阻塞图层显示。
  }
}

function ensureMap() {
  if (typeof maplibregl === "undefined") {
    mapNote.textContent = "地图库没有加载。";
    return Promise.resolve();
  }
  if (map) return mapReady;
  const saved = readView();
  map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {},
      layers: [{ id: "background", type: "background", paint: { "background-color": mapEmptyColor(readStoredTheme()) } }],
    },
    center: saved ? saved.center : [104.2, 35.6],
    zoom: saved ? saved.zoom : 3.4,
    attributionControl: false,
    canvasContextAttributes: { preserveDrawingBuffer: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  // 缩放反馈：按住 +/- 或滚轮缩放结束后，短暂显示当前级别。
  const zoomBadge = document.createElement("div");
  zoomBadge.className = "map-zoom-badge";
  zoomBadge.setAttribute("aria-hidden", "true");
  map.getContainer().appendChild(zoomBadge);
  let zoomBadgeTimer;
  map.on("zoomend", () => {
    zoomBadge.textContent = `${t("map.zoomLevel")} ${map.getZoom().toFixed(1)}`;
    zoomBadge.classList.add("show");
    if (zoomBadgeTimer !== undefined) clearTimeout(zoomBadgeTimer);
    zoomBadgeTimer = setTimeout(() => zoomBadge.classList.remove("show"), 900);
  });
  mapReady = new Promise((resolve) => {
    map.on("load", () => {
      syncMapEmptyBackground(readStoredTheme());
      map.addSource("igis-selection", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addSource("igis-box", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "igis-box-fill",
        type: "fill",
        source: "igis-box",
        paint: { "fill-color": "#3d6f9a", "fill-opacity": 0.12 },
      });
      map.addLayer({
        id: "igis-box-line",
        type: "line",
        source: "igis-box",
        paint: { "line-color": "#3d6f9a", "line-width": 1.5, "line-dasharray": [4, 3] },
      });
      map.addLayer({
        id: "igis-selection-line",
        type: "line",
        source: "igis-selection",
        paint: { "line-color": "#c4551a", "line-width": 3 },
      });
      map.addLayer({
        id: "igis-selection-circle",
        type: "circle",
        source: "igis-selection",
        filter: ["==", "$type", "Point"],
        paint: { "circle-color": "#c4551a", "circle-radius": 6 },
      });
      resolve();
    });
  });
  map.on("mousemove", (event) => {
    const node = document.querySelector("#map-cursor");
    if (!node || !event.lngLat) return;
    const lng = Number(event.lngLat.lng).toFixed(5);
    const lat = Number(event.lngLat.lat).toFixed(5);
    node.textContent = mapUsesSchematicDisplay()
      ? t("map.cursorSchematic").replace("{lng}", lng).replace("{lat}", lat)
      : t("map.cursorGeo").replace("{lng}", lng).replace("{lat}", lat);
  });
  map.on("mouseout", () => {
    const node = document.querySelector("#map-cursor");
    if (node) node.textContent = "";
  });
  map.on("movestart", clearLabels);
  map.on("resize", scheduleLabels);
  map.on("moveend", () => {
    scheduleLabels();
    fitted = true;
    const center = map.getCenter();
    localStorage.setItem(VIEW_KEY, JSON.stringify({ zoom: map.getZoom(), center: [center.lng, center.lat] }));
    saveActiveMapScope();
  });
  map.on("click", (event) => {
    if (boxMode) return;
    const hits = map.queryRenderedFeatures(event.point, { layers: queryLayerIds() });
    const feature = hits[0];
    if (!feature) {
      if (activeFeaturePopup) activeFeaturePopup.remove();
      activeFeaturePopup = null;
      return;
    }
    const rows = Object.entries(feature.properties || {})
      .filter(([key]) => !key.startsWith("_"))
      .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(propertyText(value))}</td></tr>`)
      .join("");
    if (activeFeaturePopup) activeFeaturePopup.remove();
    activeFeaturePopup = new maplibregl.Popup({ maxWidth: "320px" })
      .setLngLat(event.lngLat)
      .setHTML(`<table class="popup-table">${rows || "<tr><td>没有属性</td></tr>"}</table>`)
      .addTo(map);
  });
  map.on("mousedown", (event) => {
    if (!boxMode) return;
    event.preventDefault();
    map.dragPan.disable();
    boxStart = event.point;
    // 拖出画布外松开也要结束框选：监听挂 document，up 后清理，避免 dragPan 卡死与监听器残留。
    const move = (ev) => {
      if (!boxStart) return;
      map.getCanvas().style.cursor = "crosshair";
      const rect = map.getCanvas().getBoundingClientRect();
      drawBoxRectangle(boxStart, { x: ev.clientX - rect.left, y: ev.clientY - rect.top });
    };
    const up = (ev) => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      map.dragPan.enable();
      clearBoxRectangle();
      const rect = map.getCanvas().getBoundingClientRect();
      const end = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
      const box = [
        [Math.min(boxStart.x, end.x), Math.min(boxStart.y, end.y)],
        [Math.max(boxStart.x, end.x), Math.max(boxStart.y, end.y)],
      ];
      boxStart = null;
      const hits = map.queryRenderedFeatures(box, { layers: queryLayerIds() });
      const source = map.getSource("igis-selection");
      // maplibre-gl 6 把 setData 的对象直接发给 worker，查询结果不能直接序列化，要先转成普通 GeoJSON。
      const plain = JSON.parse(JSON.stringify(hits.map((feature) => ({ type: "Feature", geometry: feature.geometry, properties: feature.properties }))));
      if (source) source.setData({ type: "FeatureCollection", features: plain });
      const names = hits.slice(0, 8).map((feature) => {
        const props = feature.properties || {};
        const pairs = Object.entries(props).filter(([key]) => !key.startsWith("_")).slice(0, 4)
          .map(([key, value]) => `${key}=${propertyText(value)}`);
        return pairs.join("，") || "无属性";
      });
      mapNote.textContent = hits.length === 0 ? "框选范围里没有要素。" : `已框选 ${hits.length} 个要素。${names.join("；")}`;
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
  if (saved) fitted = true;
  return mapReady;
}

document.querySelector("#toggle-map").addEventListener("click", () => {
  const collapsed = mapPanel.classList.toggle("collapsed");
  document.querySelector("main").classList.toggle("map-collapsed", collapsed);
  document.querySelector("#toggle-map").textContent = collapsed ? t("nav.showMap") : t("nav.toggleMap");
  if (map) requestAnimationFrame(() => map.resize());
});

document.querySelector("#box-select").addEventListener("click", () => {
  boxMode = !boxMode;
  document.querySelector("#box-select").textContent = boxMode ? t("map.boxStop") : t("map.box");
  if (map) map.getCanvas().style.cursor = boxMode ? "crosshair" : "";
  if (boxMode) mapNote.textContent = "在地图上拖出一个矩形，选中里面的要素。";
});

document.querySelector("#clear-select").addEventListener("click", () => {
  boxMode = false;
  boxStart = null;
  if (map) {
    map.dragPan.enable();
    map.getCanvas().style.cursor = "";
  }
  document.querySelector("#box-select").textContent = t("map.box");
  if (map && map.getSource("igis-selection")) {
    map.getSource("igis-selection").setData({ type: "FeatureCollection", features: [] });
  }
  if (activeFeaturePopup) activeFeaturePopup.remove();
  activeFeaturePopup = null;
  mapNote.textContent = "";
});

document.querySelector("#export-form").addEventListener("submit", (event) => event.preventDefault());

document.querySelector("#export-btn").addEventListener("click", async () => {
  const exportNote = document.querySelector("#export-note");
  const layerId = selectedLayerId && knownLayers.has(selectedLayerId) ? selectedLayerId : "";
  const destinationPath = document.querySelector("#export-path").value.trim();
  if (!layerId || destinationPath === "") {
    exportNote.textContent = "请在资源树里选择图层，并填写一个新的导出路径。";
    return;
  }
  try {
    const result = await api("/api/map/export", {
      method: "POST",
      body: JSON.stringify({ layerId, destinationPath, conversationId: conversationState.activeId }),
    });
    exportNote.textContent = result.message || "已导出。";
  } catch (error) {
    exportNote.textContent = error instanceof Error ? error.message : "导出失败";
    showError("导出失败", error);
  }
});

async function refreshWorkspaceFiles() {
  const list = document.querySelector("#workspace-files-list");
  list.textContent = t("map.readFiles");
  try {
    const payload = await api(`/api/workspace/files?conversationId=${encodeURIComponent(conversationState.activeId)}`);
    list.textContent = "";
    if (!payload.files?.length) {
      list.textContent = t("map.emptyFiles");
      return;
    }
    for (const name of payload.files) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "layer-list-row file-tree-file";
      const label = fileBaseName(name);
      row.textContent = label;
      row.addEventListener("click", () => {
        for (const item of list.querySelectorAll(".file-tree-file")) item.classList.remove("selected");
        row.classList.add("selected");
        renderPreview({ name: label, type: fileKind(name), count: "", fields: "", crs: "" });
      });
      list.append(row);
    }
  } catch (error) {
    list.textContent = error instanceof Error ? error.message : t("map.filesUnavailable");
  }
}

function fileBaseName(value) {
  const text = String(value);
  const parts = text.split(/[\\/]/);
  return parts[parts.length - 1] || text;
}

function fileKind(value) {
  const name = fileBaseName(value);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "文件";
}

document.querySelector("#file-tree-new").addEventListener("click", () => {
  importDialog.showModal();
});

document.querySelector("#resource-toggle").addEventListener("click", () => {
  const panel = document.querySelector("#file-tree");
  const button = document.querySelector("#resource-toggle");
  const open = panel.classList.toggle("is-collapsed") === false;
  button.setAttribute("aria-expanded", open ? "true" : "false");
  requestAnimationFrame(() => {
    if (typeof map !== "undefined" && map) map.resize();
    if (sceneState.view) sceneState.view.draw();
  });
});

document.querySelector("#file-tree-files").addEventListener("toggle", (event) => {
  if (event.target.open) refreshWorkspaceFiles();
});

async function openAudit() {
  auditDrawer.classList.add("open");
  auditList.textContent = "正在读取审计…";
  try {
    const payload = await api("/api/audit");
    auditList.textContent = "";
    const records = payload.records || [];
    if (records.length === 0) {
      auditList.textContent = "还没有空间操作记录。";
      return;
    }
    for (const record of records) {
      const item = document.createElement("article");
      item.className = "audit-item";
      const params = record.parameters || {};
      const bits = [
        OP_LABEL[record.operationType] || record.operationType,
        record.success ? "成功" : "失败",
        (record.inputLayerNames || []).join("、"),
        params.distance !== undefined ? `距离 ${params.distance} ${params.unit || ""}` : "",
        params.queryKind ? `查询 ${params.queryKind}` : "",
        params.attributeFilter ? `筛选 ${params.attributeFilter}` : "",
        record.outputFilePath || "",
        record.recordedAt || "",
        record.modelName || "",
        record.operator || "",
        record.note || "",
      ].filter(Boolean);
      const text = document.createElement("p");
      text.textContent = bits.join(" · ");
      item.append(text);
      if (record.layerId || record.outputFilePath) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "tool-btn";
        button.textContent = "载入此结果";
        button.addEventListener("click", () => jumpAudit(record).catch((error) => showError("载入审计结果失败", error)));
        item.append(button);
      }
      auditList.append(item);
    }
  } catch (error) {
    auditList.textContent = error instanceof Error ? error.message : "读不到审计";
    showError("读不到审计", error);
  }
}

async function jumpAudit(record) {
  mapPanel.classList.remove("collapsed");
  document.querySelector("main").classList.remove("map-collapsed");
  document.querySelector("#toggle-map").textContent = t("nav.toggleMap");
  if (record.layerId) {
    try {
      await mountServerLayer({
        layerId: record.layerId,
        layerName: (record.inputLayerNames && record.inputLayerNames[0]) || record.layerId,
        mapUrl: `/api/map/layers/${record.layerId}/geojson`,
        featureCount: 0,
        fieldNames: [],
      }, undefined, true);
      if (map) map.resize();
      mapNote.textContent = "已从审计记录载入图层。";
      return;
    } catch {
      // 图层文件不在时再按输出路径重新载入。
    }
  }
  if (!record.outputFilePath) {
    mapNote.textContent = "这条记录没有可载入的结果文件。";
    return;
  }
  const loaded = await api("/api/map/load", {
    method: "POST",
    body: JSON.stringify({ absolutePath: record.outputFilePath, conversationId: conversationState.activeId }),
  });
  const auditBounds = [];
  for (const layer of loaded.layers || []) auditBounds.push(await mountServerLayer(layer));
  fitToBoundsList(auditBounds);
  if (map) map.resize();
  mapNote.textContent = "已按审计里的输出路径载入。";
}

document.querySelector("#open-audit").addEventListener("click", () => {
  const menu = document.querySelector("#records-menu");
  if (menu) menu.open = false;
  openAudit().catch((error) => {
    auditList.textContent = error instanceof Error ? error.message : "读不到审计";
  });
});

document.querySelector("#close-audit").addEventListener("click", () => {
  auditDrawer.classList.remove("open");
});

function ragMessage(error) {
  const message = error instanceof Error ? error.message : "文件无法解析，请使用 UTF-8 文本。";
  showError("知识库操作失败", error instanceof Error ? error : message);
  return message;
}

async function refreshRagList() {
  const payload = await api("/api/rag/documents");
  ragList.textContent = "";
  const documents = payload.documents || [];
  if (documents.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "知识库里还没有文档。";
    ragList.append(empty);
    return;
  }
  for (const doc of documents) {
    const row = document.createElement("article");
    row.className = "rag-row";
    const title = document.createElement("p");
    const bits = [doc.title || doc.entryId];
    if (typeof doc.chunkCount === "number") bits.push(`${doc.chunkCount} 段`);
    title.textContent = bits.join(" · ");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tool-btn";
    button.textContent = "删除";
    button.addEventListener("click", () => {
      api("/api/rag/delete", { method: "POST", body: JSON.stringify({ entryId: doc.entryId }) })
        .then(async () => {
          ragNote.textContent = "已删除这篇文档。";
          await refreshRagList();
        })
        .catch((error) => {
          ragNote.textContent = ragMessage(error);
        });
    });
    row.append(title, button);
    ragList.append(row);
  }
}

function readRagFile(file) {
  return new Promise((resolve, reject) => {
    if (VECTOR_FILE.test(file.name || "")) {
      reject(new Error("不能读取 shp、gdb、mif 等矢量文件。请上传纯文本。"));
      return;
    }
    if (file.size > RAG_FILE_LIMIT) {
      reject(new Error("文件太大，请上传 1MB 以内的文本。"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string" || reader.result.includes("\u0000")) {
        reject(new Error("文件无法解析，请使用 UTF-8 文本。"));
        return;
      }
      resolve(reader.result);
    };
    reader.onerror = () => reject(new Error("文件无法解析，请使用 UTF-8 文本。"));
    reader.readAsText(file, "UTF-8");
  });
}

document.querySelector("#open-rag").addEventListener("click", () => {
  const menu = document.querySelector("#records-menu");
  if (menu) menu.open = false;
  ragNote.textContent = "";
  ragDialog.showModal();
  refreshRagList().catch((error) => {
    ragNote.textContent = ragMessage(error);
  });
});

document.querySelector("#close-rag").addEventListener("click", () => {
  ragDialog.close();
});

document.querySelector("#rag-add").addEventListener("click", async () => {
  const fileInput = document.querySelector("#rag-file");
  const file = fileInput.files ? fileInput.files[0] : null;
  if (!file) {
    ragNote.textContent = "请先选择一个文本文件。";
    return;
  }
  ragNote.textContent = "正在添加…";
  try {
    const text = await readRagFile(file);
    await api("/api/rag/add", {
      method: "POST",
      body: JSON.stringify({
        title: document.querySelector("#rag-title").value.trim(),
        fileName: file.name,
        text,
      }),
    });
    document.querySelector("#rag-file").value = "";
    ragNote.textContent = "已添加到知识库。";
    await refreshRagList();
  } catch (error) {
    ragNote.textContent = ragMessage(error);
  }
});

document.querySelector("#rag-clear").addEventListener("click", async () => {
  const confirmed = await askOperationConfirm("确认要删除数据库吗？确认后才会执行。");
  if (!confirmed) return;
  try {
    await api("/api/rag/clear", { method: "POST", body: JSON.stringify({ confirm: true }) });
    ragNote.textContent = "已清空知识库。";
    await refreshRagList();
  } catch (error) {
    ragNote.textContent = ragMessage(error);
  }
});

document.querySelector(".map-scroll").addEventListener("scroll", () => closeLayerMenu());

async function initializeMapWorkspace() {
  await loadConversations();
  const payload = await api(withConversationId("/api/map/layers"));
  await activateConversationMap(conversationState.activeId, payload);
}

initializeMapWorkspace().catch((error) => {
  mapNote.textContent = error instanceof Error ? error.message : "地图没有载入。";
});
