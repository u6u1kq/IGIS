# 当前安全事实

观察日期：2026-10-07。只记录代码和本次 HTTP 响应。没有改代码。

## 监听

`apps/cli/src/desktop-api.ts` 的 `server.listen(port, "127.0.0.1")`。默认端口 `39221`。`--port` 可改端口，不能从这段调用改成 `0.0.0.0`。

本次 `GET http://127.0.0.1:39221/api/health` 返回 `200`，正文 `{"ok":true,"port":39221}`。响应头 `Access-Control-Allow-Origin` 的值是 `*`。

`netstat` 看到的监听行是 `TCP 127.0.0.1:39221 ... LISTENING`。检查结束后该监听进程已停。详见 `docs/V075-CLEAN-PHASE0.md`。

## CORS 与来源

`sendJson`（`desktop-api.ts`）和 `map-http.ts` 的 JSON 响应设置：

- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Headers: Content-Type`
- `Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS`（地图模块的 JSON 头是 `GET,POST,PUT,OPTIONS`）

`OPTIONS` 走 `sendJson(response, 204, {})`，因此预检也带 `*`。

`startSse`（`POST /api/chat` 的事件流）同样是 `Access-Control-Allow-Origin: *`。

成功返回 GeoJSON 的 `GET /api/map/layers/:id/geojson` 和成功返回静态文件、`/vendor/maplibre/*` 的 `writeHead` 没有这组 CORS 头。它们的错误 JSON 仍走 `sendJson`，带 `*`。

没有检查 `Origin` 或 `Host`。

## 认证

没有登录、Cookie 会话、Bearer 校验或角色。能访问该端口的本机客户端可以调用下面的读写删接口。

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

`POST /api/chat` 发给模型的图层上下文来自 `formatMapLayerContext`：图层 id、名称、几何类型、要素数量、字段名、`crsLabel`、显隐、顺序、颜色。`gis-prompt.ts` 写明这里没有坐标。

`validateToolArguments` 拒绝几何参数名。外部 MCP 返回文本若 `looksLikeGeometryText` 为真，则抛 `geometry-rejected`，不交给模型。RAG `assertStorableText` 拒绝像几何的正文。`ragSummary` 也不含坐标。

完整几何在：`var/map-layers/*.geojson`，以及 `GET /api/map/layers/:id/geojson`（给浏览器里的 MapLibre）。这条 GET 不是模型请求。用户原文若自带坐标，会作为 `question` 进入模型请求；代码没有在 `runLocalFirstTurn` 入口删掉用户句子里的数字。

## P0

已知 P0：服务只听 `127.0.0.1`，同时 JSON 和 SSE 发送 `Access-Control-Allow-Origin: *`。

同一台机器上，任意网页里的脚本都可以对 `http://127.0.0.1:39221` 发带 JSON 的跨源请求。预检会成功。因此在 Igis 开着的时候，其他网站可以调用删除、清空 RAG、导出、载入、空间运算、改 `mcpCommand`，并在下一次聊天时启动该命令。监听地址已经是本机，问题是 CORS `*` 把浏览器跨源调用放开了。

## 最小修复（未实现）

页面和 API 同源，都是 `http://127.0.0.1:39221`。同源的 `fetch` 不需要 CORS。

最小改动：删掉 `desktop-api.ts` 的 `sendJson`、`startSse`，以及 `map-http.ts` JSON 头上的 `Access-Control-Allow-Origin: *`（连同配套的 Allow-Headers / Allow-Methods）。不要为此加登录系统，不要把监听改成 `0.0.0.0`，不要改业务路由。

若以后确有另一个本机源要调用，再只回显 `http://127.0.0.1:<端口>`，不要回到 `*`。本次没有改这些头。

## P1（本次从代码看到的下一批，不是扫描器评级）

1. 直接 HTTP 可以删图层、改几何结果、清空 RAG，不经过聊天确认。
2. `mcpCommand` 可由未认证的 `POST /api/llm/config` 设置，并在聊天时启动进程。CORS 收紧后，本机非浏览器客户端仍然可以调用。
3. `persist: true` 把 API 密钥写入 `config/llm.local.json`。
4. `conversations.rollback` 先保存截短后的对话，再删图层。图层删除抛错时，消息已经是回退后的内容。
5. `execute` 分支不包 `guardDangerous`。确认后的本地计划会真正执行删除。模型分支会被 `guardDangerous` 挡住，再靠下一轮确认走 `execute`。
