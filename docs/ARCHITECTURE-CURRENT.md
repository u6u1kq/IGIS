# 当前运行架构

本文只写 `start-igis.cmd` 实际拉起的进程。不写理想中的 Parser → Planner → Validator → Policy → Executor。模块若存在但不在这条启动链上，记为 **NOT IN CURRENT RUNTIME PATH**。

观察日期：2026-10-18。证据是当前源码。`docs/dev-log/` 与 README 若与代码冲突，以代码为准。

## 启动

`start-igis.cmd` 切到仓库根目录，打印 `http://127.0.0.1:39221`，然后执行：

`npx --yes tsx --tsconfig tsconfig.json apps/cli/src/desktop-api.ts`

`desktop-api.ts` 在入口文件名包含 `desktop-api` 时调用 `main`。`main` 用 Node `http.createServer`，`server.listen(port, "127.0.0.1")`。端口默认 `39221`，可用命令行 `--port` 改。`start-igis.cmd` 没有传 `--port`。接口 `/api/health` 返回后，脚本打开 `apps/desktop/src-tauri/target/release/igis.exe`；发布版不存在时改开 debug 版。两个文件都不存在时，脚本退出并打印 `Igis window was not built.`

窗口地址是 `http://127.0.0.1:39221/connect.html`。该页在健康检查的 `ok` 为 true 后进入 `http://127.0.0.1:39221/`。页面仍由这个 Node 进程提供。主窗口 `dragDropEnabled` 为 `false`，文件拖放由页面接收。

## 当前进程里实际接上的链

```
start-igis.cmd
  → apps/cli/src/desktop-api.ts main
      → openGisWorkspace (apps/cli/src/gis-runtime.ts)
          → InMemoryProvenanceLedger  persistJson 目录 var/provenance
          → openSqliteVecRagStore 目录 var/rag
          → createGisToolAdapter
          → openSpatialStack
              → 启动时不打开总图层库。图层在各对话的 var/conversation-workspaces/<对话编号>/layers
              → SpatialAuditLedger 目录 var/spatial-audit
              → 结果缓存目录 var/cache
              → ExternalCapabilityBoundary → 本地 Python/osgeo GDAL 桥（设置可关闭；默认启用）
              → SpatialService（登记表里的 map.* 工具，经 executeGisOperation）
          → createSpatialAwareAdapter(gisAdapter, spatial.service)
          → createGdlAwareAdapter(...)
      → ConversationStore 目录 var/conversations
      → UserMemoryStore 目录 var/memory
      → 静态页 apps/desktop/ui （index.html / connect.html / app.js / app.css / i18n.js）
      → handleV05Request (map-http.ts) 在 /api/chat 之后
      → handleGdlRequest (gdl-http.ts) 在地图接口之后
```

窗口加载 `http://127.0.0.1:39221/`。地图在 `apps/desktop/ui/app.js` 里用页面加载的 `maplibre-gl` 画到 `#map`。

聊天只有 `POST /api/chat` 进入 `runLocalFirstTurn`：

```
app.js POST /api/chat
  → desktop-api.ts
  → spatialResultSink.run
  → runLocalFirstTurn
      → resolveChatPlan
      → execute：executePlannedCalls → 适配器
      → clarify / confirm：只回文字并保存 PendingPlan
      → model：runAssistantTurn → runLlmToolCallLoop → postLlmJson
  → 适配器顺序：createGdlAwareAdapter → createSpatialAwareAdapter → createGisToolAdapter
  → 可选：connectExternalMcp 把 map.ext_* 工具并进同一次聊天
```

本地 `execute` 使用传入的适配器，不包 `guardDangerous`。模型分支在 `callConfiguredModel` 里把适配器包进 `guardDangerous`：`map.delete`、`map.clearAll`、`map.dropDatabase` 在模型路径上返回 `confirm-required`，不执行删除。

同一进程里，下面这些请求不经过 `resolveChatPlan`：

`POST /api/map/load`、`/api/map/rename`、`/api/map/layer/delete`、`/api/map/layer/style`、`/api/map/layer/order`、`/api/map/export`、`/api/spatial/run`、`/api/gdl/load`、`/api/gdl/export`、`/api/conversations/rollback`。

空间分析走 `executeGisOperation`。样式、显隐、顺序和重命名不走这条执行边界。

## 这条链上的包

| 包或目录 | 在这条链上做什么 |
| --- | --- |
| `apps/desktop/ui` | 页面、MapLibre 画布、图层列表、对话 |
| `packages/llm-dispatch` | 本地意图、Pending Plan、工具表、模型循环。用户说打包训练数据时，只把本机索引交给模型 |
| `packages/spatial-ops` | 载入、缓冲、相交、裁剪、查询、统计、导出、图层合并。克里金和汇水读 `var/models/igis-pro/model.json`。降雨径流、降雨滑坡和地层体从这里调用计算引擎 |
| `packages/surtgis/src/core` | `LayerStore` 与 `bufferFeatures` / `intersectFeatures` / `clipFeatures` |
| `packages/gdl` | 解析和执行 GDL；`gdl.run` 在适配器最外层 |
| `packages/gis-tools` | 只读 GIS 工具适配器；`/api/import` 用 `collectGisRagChunks` |
| `packages/gis-io` | 只读路由。只用 GDAL-WASM，读失败就返回 |
| `packages/gdal-wasm-adapter` | `gdal-js` 只读打开与矢量转 GeoJSON |
| `packages/io-openfilegdb` | OpenFileGDB 会话类型。打开实现在 `gdal-wasm-adapter/src/openfilegdb.ts` |
| `packages/rag-meta` | `var/rag/kb.sqlite` |
| `packages/provenance` | `var/provenance` 与 `var/spatial-audit` |
| `packages/mcp-server` | `composeAdapters`；`mcpCommand` 非空时 `StdioClientTransport` |
| `packages/finetune` | `/api/foundation/*` 写 `var/foundation` |
| `packages/shared-types` | 类型、`looksLikeGeometryText` |
`apps/cli/src/report-ppt.ts` 与 `POST /api/report/ppt` 不在当前代码里（V0.78-C 已移除）。

`packages/surtgis/src/core` 在路径上，负责图层库和矢量运算。栅格 info、DEM 衍生、栅格代数、等高线、整型转换、NoData、邻域平滑和点插值经外部 GDAL 桥调用。桥默认启用，在设置「外部能力」区可关闭，并在启动时检查 Python/osgeo。

## 不在桌面启动进程里

| 路径 | 说明 |
| --- | --- |
| `apps/cli/src/mcp-server.ts` | 根脚本 `npm run mcp`，另开 stdio 进程，共用 `openGisWorkspace` |
| `apps/cli/src/*-check.ts`、`*-eval.ts` | 检查与手工脚本，启动不调用 |
| `packages/gis-kernel` | 只有类型。没有执行函数，启动不调用 |

V0.89.6 已从仓库移除未接入启动链、且没有运行函数体的包：`duckdb-spatial`、`map-render`、`ai-sandbox`、`export-sink`、`memory-bus`、`experience-log`、`experience-synth`、`experience-kg`、`workflow-env`，以及 `apps/web`、`workers`、读取演示和命令目录入口。窗口在 `apps/desktop/src-tauri`，由 `start-igis.cmd` 打开。

## 数据落在哪里

| 数据 | 目录 | 谁写 |
| --- | --- | --- |
| 一条对话的图层 GeoJSON、`.meta.json`、`layer-store.json` | `var/conversation-workspaces/<对话编号>/layers` | `LayerStore`，由这条对话打开 |
| 对话与 Pending Plan | `var/conversations` | `ConversationStore` |
| 知识库 | `var/rag/kb.sqlite` | `SqliteVecRagStore` |
| 空间审计 | `var/spatial-audit` | `SpatialAuditLedger` |
| 来源账本 | `var/provenance` | `InMemoryProvenanceLedger` |
| 空间结果缓存引用 | `var/cache` | `SpatialService` 的 cache |
| GDL 文本 | `var/gdl` | `exportLayerAsGdl` |
| 用户记忆 | `var/memory` | `UserMemoryStore` |
| 合成样本库 | `var/foundation` | `ensureFoundationDatabase` / `insertFoundationSample`。不训练 |
| 专业权重 | `var/models/igis-pro/slots/` 与当前的 `model.json` | `installProModel` / `activateProModel`。克里金和汇水只读 `model.json` |
| 计算引擎 | `var/engines-python`、`var/engines` | 设置里的安装。版本在 `config/engines.lock.json` |
| 模型配置（仅 persist 为 true） | `config/llm.local.json` | `writePersistedSettings` |

几何正文在该对话目录的 `<id>.geojson`，以及带对话编号的 `GET /api/map/layers/:id/geojson` 响应里。聊天发给模型的 `mapLayers` 是图层摘要。`packages/llm-dispatch/src/gis-prompt.ts` 里的摘要字段是标识、名称、几何类型、要素数量、字段名、`crsKind`、能证明时的 `linearUnit`、`crsLabel`、显隐和叠放顺序；`selectedLayer` 标明无坐标。

`POST /api/import/upload` 一次接收多个图层主文件和配套文件，单次不超过 128 MB。缺配套的图层单独说明。齐全的面图层经 `SpatialService.merge` 合成一个面图层；坐标系没写明时不猜测，合并不了就仍然分开载入。

## 回退实际是什么

只有 `POST /api/conversations/rollback`。`ConversationStore.rollback` 先把上一轮用户消息和助手回复从对话文件删掉并保存，再由 `rollbackTurnEffects` 按该轮 `createdLayerIds`、`ragEntryIds`、`auditRecordIds` 删除图层、知识库行和审计文件。它不恢复被改过的样式、顺序、重命名，也不恢复被直接删除的旧图层。
