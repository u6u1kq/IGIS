# GIS 运行依赖（V0.75-Clean Phase 2 Task 007）

图上的箭头是当前源码里的调用，不是设计稿。评测脚本可以自己再包适配器；下面画的是桌面进程和 MCP 进程。

`openGisWorkspace`（`apps/cli/src/gis-runtime.ts`）做一次组合，桌面 `desktop-api.ts` 和 MCP `mcp-server.ts` 都调用它：

```text
createGisToolAdapter          查询工具，最内层
        ↑ 认不出的工具才落到这里
createSpatialAwareAdapter     map.* 与 io.read
        ↑ gdl.run / gdl.describe 以外才落到这里
createGdlAwareAdapter         最外层，聊天和 MCP 拿到的 adapter
```

同时 `openSpatialStack` 创建一份 `SpatialService` 和一份 `LayerStore`（导出名 `MapLayerCatalog`）。空间适配器和 GDL 宿主共用这一份服务。

## 聊天

`desktop-api.ts` 的 `POST /api/chat`：

```text
POST /api/chat
  → formatMapLayerContext + formatSelectedLayer     摘要，不读几何
  → runLocalFirstTurn                               llm-dispatch
       本地计划或模型回合
  → adapter.execute                                 pending-plan / loop
  → createGdlAwareAdapter
       gdl.run / gdl.describe
       其余 ↓
  → createSpatialAwareAdapter
       map.* / io.read：resolveLayerRef，再调 SpatialService
       三个文件查询 ↓
  → createGisToolAdapter
       routeGisRead → GDAL-WASM 读端口
       样例：readGisSampleFeatures
  → SpatialService.buffer / intersect / clip / query / stats / loadFile
  → ops.ts
       缓冲、相交、裁剪转到 surtgis/core/overlay.ts
       查询和统计在 ops.ts
  → validateCollection（surtgis/core/validate.ts）在 derive 里、运算之前
  → LayerStore.insert / get / collection
```

聊天用 `spatialResultSink.run` 收集这一轮 `publish` 出去的图层摘要。

查询适配器只用 GDAL-WASM 读取。读失败就返回，不打开别的端口。

## 地图

`desktop-api.ts` 把 `/api/map/*`、`/api/spatial/run`、`/api/audit` 交给 `map-http.ts`。这里不经过工具适配器，也不经过 `llm-dispatch` 或 `gis-tools`。

```text
POST /api/spatial/run
  → SpatialService.buffer / intersect / clip / query / stats
  → 与聊天相同的 derive → ops.ts → overlay.ts → LayerStore

POST /api/map/load
  → SpatialService.loadFile
  → GeoJSON：normalizeGeoJsonText
  → 其他矢量：readVectorLayersAsGeoJson（gdal-wasm-adapter）
  → LayerStore.insert
```

`loadFile` 不调用 `routeGisRead`。图层参数是正文里的 `layerId` 字符串，接着 `requireCollection` → `LayerStore.get`。不调用 `resolveLayerRef`，也不调用 `findByName`。

## GDL

两条入口，运算都到同一个 `SpatialService`。

HTTP `POST /api/gdl/load`（`handleGdlRequest` → `runGdl`）不经过工具适配器：

```text
POST /api/gdl/load
  → executeGdl
  → 宿主 resolveLayer → LayerStore.findByName
  → 宿主 buffer / intersect / clip → SpatialService
  → derive → ops.ts → overlay.ts → LayerStore
```

聊天或 MCP 的工具 `gdl.run` 先到 `createGdlAwareAdapter`，然后同样进入 `runGdl`。`gdl.describe` 使用 `resolveLayerRef`，不使用 `findByName`。

## MCP

```text
mcp-server.ts
  → openGisWorkspace（与桌面同一函数）
  → executeMcpTool
  → adapter.execute
  → 与聊天工具相同的三层适配器
  → SpatialService → ops.ts → overlay.ts → LayerStore
```

MCP 的工具名单来自 `llm-dispatch` 的 `GIS_TOOL_REGISTRY`。名单本身不执行 GIS。

## 启动时实际建了什么

`openGisWorkspace` 会：

- 打开来源账本目录 `var/provenance`
- 打开 RAG 库 `var/rag`
- `createGisToolAdapter`：加载 GDAL 运行时，得到三个查询工具的执行函数。此时不调用 `routeGisRead`
- `openSpatialStack`：`LayerStore.restore`（`var/map-layers`）和空间审计
- 把 GDL 适配器、空间适配器、查询适配器套成一个 `ToolAdapterPort`

## 不在这张图上的代码

- `gis-kernel` 只有类型，没有任何运行路径调用它。
- `buffer-operation.ts`、`validateBufferOperation`、`adaptLayerLookup` 不被上述入口导入。
