# 图层名 / 图层标识查找（V0.75-Clean Phase 2 Task 007）

只记录当前函数。没有改 `findByName`，没有新增 `findAllByName`，没有把任何查找接到新的运行路径。

`LayerStore.list()` 的顺序是叠放从上到下，第一个在最上面。`findByName` 按这个顺序取第一个同名。

`resolveLayerRef` 在精确同名多于一层时返回 `ambiguous` 和候选，不挑选。标识字符串与某个 `layerId` 完全一致时，直接 `ok`，不再看名字。

| 函数 | 文件 | 输入 | 输出 | 同名行为 | 调用者 | 当前用途 |
| --- | --- | --- | --- | --- | --- | --- |
| `findByName` | `packages/surtgis/src/core/layer-store.ts` | 图层名字符串 | `LayerMeta` 或 `null` | **LEGACY BEHAVIOR**：叠放从上到下，精确同名取最上层，其余同名丢掉 | `apps/cli/src/gdl-http.ts` 里 GDL 宿主的 `resolveLayer` | GDL 语句按名字引用已载入图层 |
| `get` | 同上 | 图层标识 | `LayerMeta` 或 `null` | 按标识。存储是 `Map`，一个标识一层。不看名字 | `SpatialService.requireCollection`、`exportLayer`、缓存命中；`map-http.ts` 的 `publicStoreLayer` 和样式更新；`gdl-http.ts` 的 `layerSource` | 已经有标识时取元数据 |
| `collection` | 同上 | 图层标识 | 要素集合或 `null` | 按标识取几何 | `requireCollection`；`GET /api/map/layers/:id/geojson`；GDL `layerSource` | 运算和地图取几何 |
| `list` | 同上 | 无 | 按叠放顺序的 `LayerMeta` 数组 | 全部返回，不挑选 | `resolveLayerRef`；`map.list`；`GET /api/map/layers`；聊天构造 `mapLayers` | 目录 |
| `resolveLayerRef` | `packages/spatial-ops/src/resolve-layer.ts` | 有 `list()` 的目录，加查询字符串 | `LayerResolveHit`：`ok` / `missing` / `ambiguous` / `empty` | **AMBIGUITY-AWARE BEHAVIOR**：精确名、忽略大小写、或包含关系多于一层时返回多名候选，不挑选。唯一一层才是 `ok`。先匹配标识 | `adapter.ts` 的 `resolveRequired`；`gdl-http.ts` 的 `gdl.describe` | 聊天和 MCP 的空间工具把参数收成图层标识；GDL 摘要同样 |
| `resolveRequired` | `packages/spatial-ops/src/adapter.ts` | `SpatialService` 加查询字符串 | `{ ok, layerId, layerName }` 或失败载荷 | 原样使用 `resolveLayerRef` 的结果 | 该文件里带图层参数的空间工具 | 工具参数到标识。失败时不调用 `SpatialService` 的运算方法 |
| `resolveLayer`（GDL 宿主） | `apps/cli/src/gdl-http.ts` | 图层名 | `{ layerId, layerName }` 或 `null` | **LEGACY BEHAVIOR**：函数体只调用 `catalog.findByName` | `packages/gdl/src/execute.ts` 的 `executeGdl` | GDL 执行时引用图层库 |
| `executeGdl` 内部 `resolve` | `packages/gdl/src/execute.ts` | 语句里的名字 | `GdlLayerRef`，没有则抛错 | 先查本脚本 `scope` 的精确名（刚创建或刚生成的图层）。没有再调用宿主 `resolveLayer`，因此落到 `findByName` | 只被 `executeGdl` 自己的语句循环调用 | 脚本里的名字优先于图层库里的同名 |
| `requireCollection` | `packages/spatial-ops/src/service.ts` | 图层标识 | 元数据加要素集合，没有则抛「找不到输入图层」 | 只调用 `catalog.get` 和 `collection`。传入名字且该名字不是标识时，视为找不到 | `derive`、`stats`，以及后来同样先取图层再运算的方法 | 运算前取几何。地图 HTTP 把正文里的 `layerId` 直接传进来，不经过 `resolveLayerRef` |
| `formatSelectedLayer` | `packages/llm-dispatch/src/layer-context.ts` | 已格式化的图层摘要数组，加选中字符串 | 一条 `MapLayerContext` 或 `null` | 数组中第一个 `layerId` 或 `layerName` 与字符串精确相等的项。不返回多名。聊天用 `catalog.list()` 构造数组，顺序从上到下，所以用名字当选中值时落到最上层 | `desktop-api.ts` 的 `POST /api/chat` | 告诉本地计划和模型「当前选中哪一层」。不读取图层库 |
| `isKnownLayer` | `packages/llm-dispatch/src/pending-plan.ts` | 名字、已知摘要、选中层 | 布尔 | 任一摘要的标识或名字精确相等则为真。不选出一层 | 待确认计划补槽位 | 判断补上的文字是不是已有图层名 |
| `isLoadedExact` | `packages/llm-dispatch/src/local-intent.ts` | 名字、已知摘要 | 布尔 | 同上，不选出一层 | 本地意图过滤标签 | 单个汉字只有在已载入图层就叫这个字时才当作图层名 |
| `knownHits` | `packages/llm-dispatch/src/gis-route.ts` | 用户句子、已知摘要 | 字符串数组 | 句子里包含的图层名和标识都收集。名字更长的先试。结果是字符串，不是图层对象 | `extractInstructionLayers` | 从句子抽出可能的图层名 |
| `extractInstructionLayers` | 同上 | 用户句子、已知摘要 | 去重后的字符串数组 | 引号、`图层` 标记、`knownHits`、介词片段。不访问图层库，不返回几何 | 本地 GIS 计划 | 意图里的图层名文本 |
| 回退时的 `list().find` | `apps/cli/src/desktop-api.ts` `POST /api/conversations/rollback` | 本轮创建的图层标识 | 对应 `LayerMeta` 或跳过 | 按标识 | 该接口自己 | 回退审计里写显示名 |
| `catalog.collection` 路径参数 | `apps/cli/src/map-http.ts` | URL 中的图层标识 | 要素集合或 404 | 按标识 | `GET /api/map/layers/:id/geojson` | 把几何交给地图 |
| `map.getLayer` | `apps/desktop/ui/app.js` | MapLibre 样式层标识，例如 `` `${id}-fill` `` | 地图样式层或空 | 不是图层库。不按 GIS 图层名查找 | 页面绘制、显隐、删除样式层 | 浏览器里的 MapLibre 图层。与 `LayerStore` 不是同一次查找 |
| `readVectorLayersAsGeoJson` 的 `layerName` | `packages/gdal-wasm-adapter`，由 `SpatialService.readWithGdal` 传入 | 文件路径和可选的文件内图层名 | 文件里的矢量层 | 选择 GIS 文件内部的层，不是 `var/map-layers` 里的地图图层 | `SpatialService.loadFile` | 载入 shp 等文件。GeoJSON 不走这里 |

`adaptLayerLookup` 在 `packages/spatial-ops/src/layer-resolution.ts`。它接收已经得到的 `LayerResolveHit` 或 `LayerMeta | null`，不自己查找。检查脚本调用它。聊天、地图、GDL、MCP 不调用它。

桌面分析按钮把下拉框的值当作 `layerId` 发给 `POST /api/spatial/run`（`apps/desktop/ui/app.js` 读取 `#analysis-layer`）。该接口不把这个字符串交给 `resolveLayerRef` 或 `findByName`。
