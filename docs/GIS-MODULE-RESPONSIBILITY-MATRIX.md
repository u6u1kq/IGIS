# GIS 模块职责矩阵（V0.75-Clean Phase 2 Task 007）

这是当前代码的调用关系，不是目标架构。状态只根据 import 和调用点，不根据包名。

状态含义：

| 状态 | 含义 |
| --- | --- |
| CORE | 当前桌面或 MCP 运行链上，承担这件事的实现 |
| SUPPORT | 运行链会用到，但只做辅助（读文件、缓存、收集结果、调度名单） |
| EXPERIMENTAL | 仓库里有代码或类型，当前运行链不调用 |
| UNUSED | 导出了，但没有任何调用点 |
| UNKNOWN | 调用关系从当前源码无法确定 |

`buffer-operation.ts`、`buffer-operation-validate.ts`、`layer-resolution.ts` 不从 `packages/spatial-ops/src/index.ts` 导出。桌面、地图、GDL、MCP 都不导入它们。

| 模块 | 实际职责 | 当前运行链 | 调用谁 | 被谁调用 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `packages/gis-tools` | 三个文件只读查询的工具适配器：`list-layers`、`get-layer-metadata`、`get-sample-feature`。检查工具名和必填字符串，经 `routeGisRead` 读元数据，样例走 `readGisSampleFeatures`，并写来源账本。`collectGisRagChunks` 把元数据和样例属性收成文字。不执行缓冲、相交、裁剪，不打开图层库，不调用 `SpatialService` | 是，仅聊天和 MCP 的这三个查询工具。空间工具在外层适配器被截走。地图 HTTP 和 GDL HTTP 不经过它 | `@igis/gis-io` 的 `routeGisRead`、`readSourceDigestMaterial`；`@igis/gdal-wasm-adapter`；`@igis/provenance`。从 `llm-dispatch` 只用 `ToolAdapterPort` 类型和 `LlmInvokeError` | `apps/cli/src/gis-runtime.ts` 的 `createGisToolAdapter`；`desktop-api.ts` 的 `collectGisRagChunks` | SUPPORT |
| `packages/gis-kernel` | 只有类型：`GisBackendKind`、`GisBackendPlugin`、`GisKernel`、`ToolBinding`。没有类，没有 `register` / `execute` 的函数体 | 否 | `@igis/shared-types` 的类型 | 仅 `gdal-wasm-adapter` 作类型导入 | EXPERIMENTAL |
| `spatial-ops` `service.ts` `SpatialService` | 载入、派生新图层、度量、栅格、克里金、汇水、降雨和地层体。`derive` 按图层标识取几何，做检查，读写结果缓存，调用运算函数，`insert` 进图层库，并写审计。方法接收各自的参数，不接收 `BufferOperationRequest` | 是。聊天经 `executeGisOperation`，地图 `POST /api/spatial/run` 和 GDL 宿主直接进这些方法 | `ops.ts`；`surtgis`；`MapLayerCatalog`；`SpatialResultCache`；本机 Python/GDAL 桥；计算引擎桥；当前专业权重 | `adapter.ts`；`map-http.ts`；`gdl-http.ts`；`openSpatialStack` | CORE |
| `spatial-ops` `ops.ts` | 矢量运算：缓冲、相交、裁剪从 SurtGIS 转出，并实现查询、统计、度量、融合、合并、分割和后面追加的矢量函数 | 是，只被 `SpatialService` 调用 | `@igis/surtgis`；`@turf/turf` | `service.ts` | CORE |
| `spatial-ops` `adapter.ts` | 把 `map.*` 和 `io.read` 转成 `SpatialService` 调用。图层参数经 `resolveLayerRef`。认不出的工具交给内层适配器 | 是。`openGisWorkspace` 把它套在查询适配器外面 | `resolveLayerRef`；`SpatialService`；图层库的 list/remove/updateStyle/setOrder | `gis-runtime.ts`；评测 `ai-eval.ts` 自行再包一层，那不是桌面启动 | CORE |
| `spatial-ops` `resolve-layer.ts` | 用图层目录把一段字符串收成命中、找不到、多名或空白。精确标识优先，然后精确名、忽略大小写、包含。多名时返回候选，不挑选 | 是。空间工具适配器和 `gdl.describe` | 只读 `catalog.list()` 的 `LayerMeta` | `adapter.ts` 的 `resolveRequired`；`gdl-http.ts` 的 `gdl.describe`。包入口有导出。运行时缓冲不读 `layer-resolution.ts` | CORE |
| `spatial-ops` `catalog.ts` | 把 `LayerStore` 改名为 `MapLayerCatalog` 再导出。没有第二套存储 | 是 | `@igis/surtgis` 的 `LayerStore` | `SpatialService`、`openSpatialStack` | CORE |
| `spatial-ops` `normalize.ts` | 载入时把 GeoJSON 收成要素：跳过坏几何，上限 8000，补 `_fid`。不做缓冲或相交 | 是，`loadFile` | `surtgis` 的 `fieldNamesOf` | `service.ts`。`normalizeGeoJsonText` 不从包入口导出 | CORE |
| `spatial-ops` `sink.ts` | `AsyncLocalStorage`。`publish` 把新图层摘要推进当前对话的数组。不存几何算法 | 是，仅聊天 `POST /api/chat` 用 `run` 包住一轮 | 无 GIS 包 | `service.ts` 写入；`desktop-api.ts` 读取 | SUPPORT |
| `spatial-ops` `result-cache.ts` | `SpatialResultCache` 按运算、图层标识、参数和几何哈希，在 `var/cache` 记下结果图层的标识和名字，不写坐标。`derive` 直接 `get` / `put`。`takeCachedOrCompute` 有导出，源码里没有调用点 | 类在 `derive` 上。辅助函数没有调用点 | `@igis/provenance` 的 `hashSourceContent` | `service.ts` 使用类。`takeCachedOrCompute` 无调用 | SUPPORT（类）；`takeCachedOrCompute` 为 UNUSED |
| `spatial-ops` `buffer-operation.ts`、`buffer-operation-validate.ts`、`layer-resolution.ts` | 缓冲请求草案、该请求的结构校验、把已有查找结果映射成 `LayerResolutionResult`。映射函数不查图层库 | 否 | 彼此的类型；`layer-resolution.ts` 引用 `LayerResolveHit` 和 `LayerMeta` 类型，不调用 `resolveLayerRef` 或 `findByName` | 仅 `apps/cli/src/*-check.ts` 检查脚本 | EXPERIMENTAL |
| `surtgis` `core/overlay.ts` | 缓冲、相交、裁剪和辅助：`bufferFeatures`、`intersectFeatures`、`clipFeatures`、`unionMask`、`safeValid`、`stampFeature`、`finishResult`。缓冲调用 Turf，`steps` 写在该函数里 | 是 | `@turf/turf` | `ops.ts` 再被 `SpatialService` 调用 | CORE |
| `surtgis` `core/layer-store.ts` `LayerStore` | 图层顺序、显隐、样式和几何。几何在内存和 `var/map-layers` 的 geojson。`findByName` 同名取叠放最上层。`get` / `collection` 按标识 | 是。`openSpatialStack` 构造并 `restore` | 本目录文件读写 | 经 `MapLayerCatalog` 被 `SpatialService`、地图 HTTP、GDL、聊天上下文使用。`findByName` 的业务调用点只有 `gdl-http.ts` | CORE |
| `surtgis` `core/validate.ts` | 逐要素几何检查：空、结构、自相交、类型。`validateCollection`、`inspectFeature`、`isUnusableIssue` | 是。载入和 `derive` 在调用 Turf 之前使用 | `@turf/turf` 的 `booleanValid`、`kinks` | `service.ts` | CORE |
| `surtgis` `core/types.ts` | 内核集合、要素、单位、问题种类、样式的类型 | 是，作为上述文件的数据类型 | 无 | overlay、validate、layer-store、spatial-ops | SUPPORT |
| `packages/gis-io` | 文件读取路由。请求只有路径和图层名。只走注入的 GDAL-WASM 读端口，失败就返回。本包不派生进程 | 查询工具执行时会调用 `routeGisRead`。地图载入不经过它 | 来源账本 | `gis-tools`；`gdal-wasm-adapter` 自检。`SpatialService` 只引用错误类型 | SUPPORT |
| `packages/llm-dispatch` | 工具名单 `GIS_TOOL_REGISTRY`、参数规范化、本地意图、待确认计划、模型回合。真正执行交给注入的 `ToolAdapterPort`。本包不读图层库，不计算几何 | 是。`POST /api/chat` 调用 `runLocalFirstTurn`，工具执行在 `pending-plan.ts` / `loop.ts` 里 `adapter.execute` | 适配器由调用方注入。图层函数只处理已经传来的摘要 | `desktop-api.ts`、`mcp-server`、`gis-tools`（类型和错误）、`spatial-ops/adapter`（类型） | CORE |
| `apps/cli/src/gis-runtime.ts` | `openGisWorkspace`：建账本、RAG 库、查询适配器、`openSpatialStack`，再把 GDL 适配器套在空间适配器外面。不写缓冲公式，不解析图层名 | 是。桌面进程和 MCP stdio 都从这里打开同一份工作区 | `gis-tools`、`spatial-ops`、`gdl-http` 的 `createGdlAwareAdapter`、provenance、rag-meta | `desktop-api.ts`、`mcp-server.ts` | CORE |
