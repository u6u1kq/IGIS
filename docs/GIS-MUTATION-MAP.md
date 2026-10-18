# GIS 与相关写入入口

本文列出会创建、删除、重命名、改样式、改顺序、改几何、写 GIS 文件、写 RAG、写审计的主要入口。后来增加的矢量工具也走 `SpatialService.derive`。栅格工具走 Python/GDAL 桥，降雨径流、降雨滑坡和地层体走计算引擎桥。聊天里的这些工具经 `executeGisOperation`。地图 HTTP 的载入、删除、样式和顺序仍直接调 `SpatialService` 或图层库。

图例：校验 = 该函数自己做的检查。策略 = 危险确认。历史 = 对话/Pending Plan。审计 = `var/spatial-audit` 或 `var/operations`。RAG = `var/rag`。

## 创建图层（新的 GeoJSON）

| 写入 | 文件与函数 | HTTP 或工具入口 | 调用方 | 统一执行器 | 校验 | 策略 | 历史 | 审计 | RAG |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 从文件载入 | `SpatialService.loadFile` → `LayerStore.insert` | `POST /api/map/load`；工具 `map.load`、`io.read` | `map-http.ts`；`spatial-ops/src/adapter.ts` | 否。HTTP 不经聊天计划 | GeoJSON/JSON 走 `normalizeGeoJsonText`；其他走 GDAL。空要素且有警告则拒绝。`validateCollection` 记问题 | 无确认 | 不写对话 | `remember`，`operationType` `map-load` | 仅当 `writeKnowledge === true` |
| 派生新图层 | `SpatialService.derive` → `LayerStore.insert` | `POST /api/spatial/run`；`map.buffer`、`map.intersect`、`map.clip`、`map.query`，以及后来同样调用 `derive` 的矢量工具 | `map-http.ts`；适配器 | 聊天经 `executeGisOperation`。地图 HTTP 不经聊天计划 | `validateCollection`；缓冲还有距离和单位检查。要素上限在 `overlay.ts`：缓冲 2000，相交/裁剪 600 | 无确认 | 聊天路径会把新 `layerId` 记进助手消息 `createdLayerIds`。HTTP 路径不记 | `remember` | 仅 `writeKnowledge === true`。本地缓冲计划在 `pending-plan.ts` 的 `knowledge()` 里固定带 `writeKnowledge: true` |
| GDL 文本成图层 | `SpatialService.createLayer` → `LayerStore.insert` | `POST /api/gdl/load`；工具 `gdl.run` | `gdl-http.ts` `runGdl` | 否 | GDL 语法与 `gdl` guard；`validateCollection` 丢掉不可用要素 | 无确认 | 仅当来自聊天 | `gdl-load` | `createLayer` 的 `writeKnowledge` |

`LayerStore.insert`（`packages/surtgis/src/core/layer-store.ts`）立刻写 `<layerId>.geojson`、`.meta.json` 和 `layer-store.json`。没有单独的提交接口。

`loadFile` 对 GeoJSON 只采用文件自己写出的坐标系；没有投影定义时，空间分析不可用，不把未声明的文件改写成某个 EPSG。

统计 `SpatialService.stats` 不 `insert`。它只 `remember`。

## 删除

| 写入 | 函数 | 入口 | 调用方 | 统一执行器 | 校验 | 策略 | 历史 | 审计 | RAG |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 删一个图层的生成文件 | `LayerStore.remove` | `POST /api/map/layer/delete` | `map-http.ts` 直接 `catalog.remove` | 否。绕过聊天 | 不删与 `sourcePaths` 相同的源文件 | 无确认 | 不改对话 | 不写 | 不写 |
| 同上 | `LayerStore.remove` | 工具 `map.delete` | `adapter.ts` | 聊天计划内：`finishComplete` 在未确认时返回 confirm，不执行。模型路径另有 `guardDangerous` | 同上 | 仅聊天计划 | 聊天消息 | 删除本身不 `remember` | 不写 |
| 清空全部图层 | 循环 `LayerStore.remove` | 工具 `map.clearAll` | `adapter.ts` | 同上，只在聊天计划 | 逐个 `remove` | 仅聊天计划 | 聊天消息 | 不 `remember` | 不写 |
| 清空知识库，不删图层 | `SpatialService.dropDatabase` → `store.clear()` | 工具 `map.dropDatabase` | `adapter.ts`；`gis-runtime.ts` 把 `dropDatabase` 接到 RAG `clear` | 仅聊天计划 | 无 | 仅聊天计划。提示写「删除数据库」，实际清的是知识库 | 聊天消息 | 不 `remember` | 清空表 |
| 回退本轮新建图层 | `rollbackTurnEffects` → `catalog.remove` | `POST /api/conversations/rollback` | `desktop-api.ts` | 否 | 只删消息里的 `createdLayerIds` | 无第二道确认 | `ConversationStore.rollback` 先保存截短后的对话 | 之后再追加一条 `operationType: "rollback"`。清单内旧审计会被删掉 | 删清单内的 entry |

界面删除按钮调用的是 `POST /api/map/layer/delete`（`app.js`），不是 `map.delete` 工具。这是聊天确认的旁路。

## 重命名、样式、顺序

| 写入 | 函数 | 入口 | 调用方 | 校验 | 策略 | 历史 | 审计 | RAG |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 改图层名 | `SpatialService.rename` → `LayerStore.rename` | `POST /api/map/rename`；界面在 `app.js` | `map-http.ts` | `safeLayerName` | 无 | 不写对话 | 不写 | 不写 |
| 改样式 | `LayerStore.updateStyle` → `writeState` | `POST /api/map/layer/style`；工具 `map.style` | `map-http.ts`；`adapter.ts`。界面拖动也会 POST | 图层必须已存在；HTTP 最多 200 条 | 无 | 不写 | 不写 | 不写 |
| 显隐 | `LayerStore.updateStyle({ visible })` | 工具 `map.setVisibility` | `adapter.ts`。没有单独的显隐 HTTP | 图层必须存在 | 无 | 聊天消息 | 不写 | 不写 |
| 叠放顺序 | `LayerStore.setOrder` | `POST /api/map/layer/order`；工具 `map.setOrder` | `map-http.ts`；`adapter.ts`；界面 | `order` 必须是字符串数组 | 无 | 不写 | 不写 | 不写 |

样式和顺序写在 `var/map-layers/layer-store.json`，不改 GeoJSON 几何。

## 几何运算（不经聊天时）

`POST /api/spatial/run` 的 `operation` 为 `buffer`、`intersect`、`clip`、`query`、`stats`。前四项成功时 `derive` 写入新 GeoJSON。`buffer` 不读取 `crsLabel`。见 `docs/UNKNOWN.md` 的 U002。

GDL 执行在 `packages/gdl` 的宿主里调用 `SpatialService`。`POST /api/gdl/parse` 只解析，不写图层。

## GIS 文件写出（不是图层库内部文件）

| 写入 | 函数 | 入口 | 说明 | 审计 | RAG |
| --- | --- | --- | --- | --- | --- |
| 新的 GeoJSON | `LayerStore.exportTo` | `POST /api/map/export`；工具 `map.exportGeoJson` | 拒绝覆盖源路径；目标已存在则拒绝 | `export` | 否 |
| GDL 文本 | `exportLayerAsGdl` | `POST /api/gdl/export` | 写 `var/gdl`，不覆盖源 GIS | `recordGdlExport` | 否 |
| 读用户给的路径 | `loadFile` / GDAL `withReadonlyDataset` | `POST /api/map/load`、`io.read` | 读盘。GeoJSON 分支会读全文再 `insert` | 见载入行 | 见载入行 |

`map.zoomToLayer` 在适配器里不写文件。

## RAG 写入

| 函数 | 入口 | 内容 | 几何 |
| --- | --- | --- | --- |
| `SpatialService.remember` → `addRag` | 空间操作且 `writeKnowledge` 为 true | `ragSummary`：图层名、操作名、要素数量、字段名 | `looksLikeGeometryText` 或正文含 `"coordinates"` 则不写 |
| `store.add` | `POST /api/rag/add`、`/api/documents/add`、`/api/import` 且 `indexRag`、`/api/gdl/summary` 且 `writeKnowledge` | 调用方给的标题和正文 | `assertStorableText` 拒绝像几何的文本 |
| `store.delete` | `POST /api/rag/delete`；回退 | 删一行 | |
| `store.clear` | `POST /api/rag/clear`；`map.dropDatabase` | 清空知识库表 | HTTP clear 不经聊天确认 |

## 审计写入

`SpatialService.remember` → `SpatialAuditLedger.append`。记录字段是操作类型、图层名、距离/单位/查询种类、输出路径、模型名、成败、备注、耗时。类型声明写明不含坐标、WKT、WKB、GeoJSON 几何。

不经过 `remember` 的写：HTTP 删除、重命名、样式、顺序、显隐、`map.delete`、`map.clearAll`。

回退成功后 `desktop-api.ts` 再 `append` 一条 `rollback`。审计追加失败被 catch 掉，不影响回退响应。

## 其他会写盘、但不是图层几何

| 函数 | 路径 | 入口 |
| --- | --- | --- |
| `ConversationStore` | `var/conversations` | 聊天与 `/api/conversations/*` |
| `UserMemoryStore` | `var/memory/user-memory.json` | `/api/memory/add`、`/api/memory/delete` |
| `writePersistedSettings` | `config/llm.local.json` | `POST /api/llm/config` 且 `persist === true`。文件含 `apiKey` |
| `ensureFoundationDatabase`、`insertFoundationSample` | `var/foundation` | `/api/foundation/prepare`、`/api/foundation/sample` |
| 结果缓存 `cache.put` | `var/cache` | `derive` 成功之后。缓存命中仍 `remember`，不重新 `insert` |

## 聊天旁路（刻意分开）

这些会改 GIS 或 RAG，且不调用 `resolveChatPlan`：

- `POST /api/map/load`
- `POST /api/map/rename`
- `POST /api/map/layer/delete`
- `POST /api/map/layer/style`
- `POST /api/map/layer/order`
- `POST /api/map/export`
- `POST /api/spatial/run`
- `POST /api/gdl/load`
- `POST /api/gdl/export`
- `POST /api/gdl/summary`（只在 `writeKnowledge` 时写 RAG）
- `POST /api/rag/add`、`/api/rag/delete`、`/api/rag/clear`
- `POST /api/import`（`indexRag` 时写 RAG）
- `POST /api/conversations/rollback`
