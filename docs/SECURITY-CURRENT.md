# 当前安全事实

观察日期：2026-10-18。来源门和 CORS 按当前 `origin-gate.ts` 与 `desktop-api.ts`。2026-10-07 记下的接口条数没有在这次重数。

## 监听

`apps/cli/src/desktop-api.ts` 的 `server.listen(port, "127.0.0.1")`。默认端口 `39221`。`--port` 可改端口，不能从这段调用改成 `0.0.0.0`。

## CORS 与来源

`sendJson` 和 `startSse` 本身不写 `Access-Control-Allow-Origin`。

带 `Origin` 的写请求，以及会返回几何、文件或配置的读请求，先经过 `isAllowedOrigin`。只允许 `http://127.0.0.1:<端口>`。没有 `Origin` 的本机客户端仍然允许。`localhost` 和字符串 `null` 不算本机页面。这不是登录。

`OPTIONS` 只在来源正好是本机页面时回显该来源，并带 `Vary: Origin`。不使用 `*`。

## 认证

没有登录、Cookie 会话、Bearer 校验或角色。能访问该端口、且不带外来 `Origin` 的本机客户端可以调用读写删接口。

## HTTP 入口数量

按方法加路径，从 `desktop-api.ts`、`map-http.ts`、`gdl-http.ts` 的条件数出 **49** 条。另有任意路径的 `OPTIONS`，它不是第 50 个资源。

静态 5：`GET /`、`/index.html`、`/app.js`、`/app.css`、`/i18n.js`。

桌面 API 29：

`GET /api/health`，`GET|POST /api/llm/config`，`POST /api/llm/test`，`POST /api/foundation/prepare`，`GET /api/foundation/file`，`POST /api/foundation/sample`，`GET /api/settings`，`PUT /api/settings`，`GET /api/messages`，`GET|POST /api/conversations`，`POST /api/conversations/switch|rename|delete|rollback`，`GET /api/memory`，`POST /api/memory/add|delete`，`GET /api/documents`，`POST /api/documents/add|delete`，`GET /api/documents/file`，`GET /api/rag/documents`，`POST /api/rag/add|delete|clear`，`POST /api/import`，`POST /api/chat`。

地图与 GDL 15：

`GET /vendor/maplibre/*`，`GET /api/map/layers`，`GET /api/map/layers/:id/geojson`，`GET /api/audit`，`POST /api/map/load|rename|export`，`POST /api/map/layer/delete|style|order`，`POST /api/spatial/run`，`POST /api/gdl/parse|load|export|summary`。

## 读、写、删

读：图层列表与完整 GeoJSON、审计、对话、记忆、文档、RAG、foundation 文件、模型配置（返回掩码，不返回完整密钥）。

写：载入、空间运算、GDL 载入、导出、样式、顺序、重命名、聊天、RAG、文档、记忆、foundation 样本、`persist: true` 时的 `config/llm.local.json`。

删：`POST /api/map/layer/delete`，聊天工具 `map.delete` / `map.clearAll`，`POST /api/rag/delete` 与 `/api/rag/clear`，`map.dropDatabase`（清 RAG），对话删除，回退删除本轮新建图层。

聊天确认只包住计划路径上的 `map.delete`、`map.clearAll`、`map.dropDatabase`。`POST /api/map/layer/delete` 与 `POST /api/rag/clear` 不经过它。

## MCP 命令与子进程

`POST /api/llm/config` 可保存 `mcpCommand` 和 `mcpArgs`。下一次 `POST /api/chat` 若命令非空，`connectExternalMcp` 用 MCP SDK 的 `StdioClientTransport({ command, args })` 启动该命令。

外部 MCP 命令由该 SDK 的传输启动。失败时函数返回 `null`，内置工具仍可用。

## 本机进程

矢量读取在进程内的 GDAL-WASM，不另开读取端口。栅格和计算引擎由外部网关启动本机 Python。`gis-io` 不连接 ArcPy 或 QGIS。

## 自定义模型地址与密钥

`POST /api/llm/config` 与 `POST /api/llm/test` 接受 `baseUrl`。`assertHttpUrl` 限制为 http/https URL，并避免把密钥嵌进 URL。`POST /api/llm/test` 向该地址的 chat completions 发请求，会访问网络。

密钥来源：内存中的 `settings.apiKey`，否则环境变量（DeepSeek 预设读 `DEEPSEEK_API_KEY`）。`persist === true` 时 `writePersistedSettings` 把 `apiKey` 明文写入 `config/llm.local.json`。本次仓库里没有这个文件。`var/tmp` 下有两个 `llm.local.json*.bak`，JSON 含 `apiKey` 键，值为空字符串。备份没有复制它们。

`GET /api/llm/config` 返回 `apiKeyMask`，不返回完整密钥。聊天错误和 SSE 文本经过 `scrubSecrets`。启动日志本次只看到监听地址和 gdal-js / sqlite 警告，没有密钥。没有逐行证明所有 `stdout` 都不会带上密钥。

## 几何会不会进模型

`POST /api/chat` 发给模型的图层上下文来自 `formatMapLayerContext`：图层 id、名称、几何类型、要素数量、字段名、`crsKind`、能证明时的长度单位、`crsLabel`、显隐、顺序、颜色。默认没有坐标。设置里勾选允许普通工程几何后，这一轮可以带上普通坐标；路径、范围和已标密内容仍然不发送。

`validateToolArguments` 拒绝几何参数名。外部 MCP 返回文本若 `looksLikeGeometryText` 为真，则抛 `geometry-rejected`，不交给模型。RAG `assertStorableText` 拒绝像几何的正文。`ragSummary` 也不含坐标。

完整几何在：`var/conversation-workspaces/<对话编号>/layers/*.geojson`，以及带对话编号的 `GET /api/map/layers/:id/geojson`（给浏览器里的 MapLibre）。这条 GET 不是模型请求。用户原文若自带坐标，会作为 `question` 进入模型请求；代码没有在 `runLocalFirstTurn` 入口删掉用户句子里的数字。

## 来源门

写请求和敏感读请求会拒绝外来 `Origin`。同一台机器上的其他网站不能再靠 `Access-Control-Allow-Origin: *` 调用这些接口。没有 `Origin` 的本机程序仍然可以调用，因为这不是登录。

## 仍在的风险

1. 直接 HTTP 可以删图层、改几何结果、清空 RAG，不经过聊天确认。调用方只要是本机、且不带外来 `Origin`。
2. `mcpCommand` 可由未认证的 `POST /api/llm/config` 设置，并在聊天时启动进程。
3. `persist: true` 把 API 密钥写入 `config/llm.local.json`。
4. `conversations.rollback` 先保存截短后的对话，再删图层。图层删除抛错时，消息已经是回退后的内容。
5. 本地计划确认后会执行删除。模型分支上的破坏性工具先被挡住，再靠下一轮确认执行。
