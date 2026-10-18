# Map Buffer 的图层身份来源（V0.75-Clean Phase 2 Task 011）

静态审计。只回答：地图缓冲在调用 `SpatialService.buffer` 之前，哪一个已经在手里的对象同时带有真实 `layerId` 和真实显示名。

代码里的显示名是存储图层上的 `layerName`。没有名为 `displayName` 的字段。下面说的「真实显示名」都是指这一字段，并且来自图层库里已经存下的那一层，而不是把标识字符串再写一遍。

本任务没有改业务代码，没有重做 Task 010，没有新增查找、Resolver 或 Executor。

## 1. Map Buffer 当前调用链

浏览器按钮只把下拉框的 option value 当作 `layerId` 放进正文。

`apps/desktop/ui/app.js` 的 `#analysis-layer` 由 `refreshLayerChoices` 填选项：`option.value` 是 `knownLayers` 的键（图层标识），`option.textContent` 是 `layerStyles[id]?.name || meta.layerName || id`。这段文字留在界面上。

`#analysis-run` 的点击处理（约 2071–2092 行）在 `layerId` 为空时直接返回，不发请求。否则 `POST /api/spatial/run`，JSON 字段是：

- `operation`
- `layerId`（`#analysis-layer` 的 value）
- `otherLayerId`
- `distance`
- `unit`
- `queryKind`
- `attributeFilter`
- `fieldName`
- `writeKnowledge`

正文没有 `layerName`，也没有结果图层名。`selectedLayerPayload()`（约 920–926 行）会同时带上 `layerId` 和名字，但只用于 `POST /api/chat` 的 `selectedLayer`，空间分析按钮不调用它。

`apps/cli/src/map-http.ts` 的 `POST /api/spatial/run`（约 248–264 行）：

1. `textField(body, "operation")` 与 `textField(body, "layerId")`。缺一则 HTTP 400「需要操作类型和图层。」
2. `operation === "buffer"` 时再检查 `body.distance` 是 number、`textField(body, "unit")` 非空。否则 HTTP 400「缓冲需要距离和单位。」
3. 调用 `deps.spatial.service.buffer(layerId, distance, unit, writeKnowledge)`。第五个参数不传。`writeKnowledge` 来自同一请求里更早的 `body.writeKnowledge === true`。
4. 返回值交给 `withStoreLayer`，再 `sendJson` 200。

这一分支在调用之前没有 `catalog.get`，没有 `catalog.list`，没有图层对象。

`packages/spatial-ops/src/service.ts` 的 `SpatialService.buffer`（约 389–410 行）先 `normalizeUnit` / `assertDistance`。单位或距离不合法时记一条失败审计，`inputLayerNames` 用的是 `safeLayerName(layerId)`，然后抛错。这一段不读图层库。通过之后调用 `this.derive("buffer", "缓冲", layerId, null, writeKnowledge, ...)`，`outputName` 仍是默认 `null`。

`derive`（约 579 行）调用 `this.requireCollection(layerId)`。`requireCollection`（约 202–207 行）：

```ts
const meta = this.catalog.get(layerId);
const collection = this.catalog.collection(layerId);
if (!meta || !collection) throw new SpatialOpError("找不到输入图层。请先把图层载入地图。");
return { meta, collection };
```

`catalog` 的类型是 `MapLayerCatalog`。`packages/spatial-ops/src/catalog.ts` 把它定义为 SurtGIS `LayerStore` 的别名。因此这里的 `catalog.get` 就是 `LayerStore.get`。

`packages/surtgis/src/core/layer-store.ts` 的 `get`（约 200–203 行）从内存 `Map` 取出 `StoredLayer`，经 `snapshot` 返回 `LayerMeta | null`。`snapshot` 复制 `layerId` 与 `layerName`。`LayerMeta`（约 19–28 行）同时声明这两个字段。`StoredLayer` 是私有接口，在 `LayerMeta` 上再加 `collection`。

命中之后，`derive` 使用 `input.meta.layerName` 作为输入图层名。地图这条缓冲不传 `outputName`，新结果图层名在同一次 `derive` 里由 `` `${input.meta.layerName}_缓冲` `` 经 `safeLayerName` 生成，然后 `catalog.insert`。那是结果图层，不是调用前的源图层身份。

`map-http.ts` 的 `withStoreLayer` → `publicStoreLayer` 在 `service.buffer` 返回之后才 `catalog.get`。它按结果里的 `layer.layerId` 取几何类型和坐标系标签，附加到 HTTP 响应。那一次读取的是结果图层，发生在缓冲返回之后。

地图缓冲不经过 `resolveLayerRef`，也不调用 `findByName`。找不到源图层时仍由 `requireCollection` 抛出「找不到输入图层。请先把图层载入地图。」，`map-http.ts` 收成 HTTP 400。

## 2. T1 / T2 / T3 数据状态

### T1：进入 Map Buffer handler

位置：`handleV05Request` 进入 `path === "/api/spatial/run"`。正文已经解析为对象，`writeKnowledge` 已经是布尔值。

此时手里有 HTTP 字段：`operation`、`layerId`、`otherLayerId`、`distance`、`unit`、`queryKind`、`attributeFilter`、`fieldName`、`writeKnowledge`。`layerId` 是去掉空白后的非空字符串，或随后因缺失而 400。没有图层对象，没有 `layerName`，没有 `LayerMeta`。

### T2：调用 `SpatialService.buffer` 之前

位置：缓冲分支通过距离和单位检查之后、`await deps.spatial.service.buffer(...)` 的实参。

此时手里有四个值：`layerId`（string）、`distance`（number）、`unit`（string）、`writeKnowledge`（boolean）。`outputName` 不在实参里。仍然没有 `layerName`，没有 `catalog.get` 的返回值。

### T3：`SpatialService.buffer` 内部解析 layer 之后

位置：`derive` 里 `requireCollection` 成功返回之后的 `input`。

`input.meta` 是 `LayerMeta`。`input.meta.layerId` 与 `input.meta.layerName` 同时在这个对象上。`layerName` 来自 `LayerStore` 内存记录的 `snapshot`，也就是已存储的图层数据。`input.collection` 是同一层的几何，本任务不把它当作身份。

单位校验失败时走不到这里。`get` 或 `collection` 为空时抛错，也没有这份 `meta`。

### 两个字段第一次同时在这次请求的执行路径上

第一次是 **T3**，对象是 `requireCollection` 返回的 `input.meta`（`LayerMeta`）。T1 和 T2 都只有图层标识字符串。

## 3. 所有候选 identity 来源

`LayerResolutionIdentity`（`packages/spatial-ops/src/layer-resolution.ts`）只有 `layerId` 与 `layerName`。下表按这个形状检查。模块职责按该对象今天实际做什么来写。

| 候选 | 有 layerId | 有真实 layerName | layerName 来自已存储图层 | 在 buffer 调用前已在调用方手里 | 要额外 lookup | 模块与职责 | 拿它当身份来源会不会改职责边界 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 请求正文 `body` | 有，字段 `layerId` | 无。分析按钮不发送 `layerName` | 否 | 正文在 T1 就在，但没有显示名 | 要显示名就必须另读图层库，或改浏览器去发送名字 | `map-http.ts` 解析 HTTP。职责是收字段并分发 | 会。处理函数今天不读图层库。为了补名字而 `get`，查找就进了 HTTP 分发 |
| handler 局部变量 | 有，`textField` 得到的字符串 | 无 | 否 | T2 只有 id、距离、单位、writeKnowledge | 同上 | 同上，缓冲分支只转调 `service.buffer` | 会。同上 |
| `SpatialService.buffer` 内部查找之后的对象 | 有，`input.meta.layerId` | 有，`input.meta.layerName` | 是，`LayerStore.get` → `snapshot` | 否。出现在进入 `buffer` 之后的 `derive` | 否。这就是现有那一次 `catalog.get`，不是另一次 | `spatial-ops` 的 `derive` / `requireCollection`。职责是按标识取出要运算的层 | 把它投影成身份，不再次 `get`，查找次数不变。但身份会诞生在执行方法内部。今天 `SpatialService.buffer` 不接收、也不构造 `BufferOperationRequest`。若在这里组装请求，请求就不再是执行之前由入口交出的对象 |
| `LayerStore.get` 的返回类型与返回值 | 类型 `LayerMeta` 上有 | 类型上有，命中时返回值上有 | 是 | 缓冲分支在调用前没有这份返回值。库内 `StoredLayer` 从载入或恢复起就在进程里，本次请求没有把它取出来 | 在 handler 里调用 `get` 才拿得到。`buffer` 里还会再 `get` 一次 | `packages/surtgis/src/core/layer-store.ts`。职责是按标识交元数据快照。`MapLayerCatalog.get` 就是这个方法 | 会，并且是重复查找。见第 6 节 |
| 已有元数据类型 | `LayerMeta` 两个字段都有。私有 `StoredLayer` 同样有。`GisLayerMetadata` 只有 `layerName`，没有 `layerId`，且属于读文件，不属于这条缓冲链。没有 `LayerRecord`、`LayerState` 这种同时作为本次缓冲输入的类型 | 见左栏 | `LayerMeta` / `StoredLayer` 的字段定义来自图层库。类型本身不是一次请求里的值 | 类型在编译期就在。本次缓冲在 T2 没有 `LayerMeta` 值 | 取得值仍要 `get` | 类型各自描述图层库或文件读取 | 用类型名字不能变出显示名。用一次尚未发生的 `get` 的返回值，边界问题与上一行相同 |
| 空间结果类型 | `PublicMapLayer`、`SpatialRunResult.layer`、`CachedLayerRef` 都有两个字段 | 有字段 | 结果图层的名字是运算之后写入的，或缓存里上次结果的名字 | 否。`SpatialRunResult` 是 `buffer` 的返回值。`CachedLayerRef` 在 `derive` 里、源图层 `requireCollection` 成功之后才读，指向的是缓存的结果图层标识，不是这次源图层 | 读缓存是另一次存储访问，而且发生在源图层已经取出之后 | `service.ts` 描述运算结果。`result-cache.ts` 记住上次结果图层 | 会张冠李戴。这些对象标识的是结果图层，不是缓冲的源图层。不能在调用前充当 `sourceLayer` |
| `LayerResolutionIdentity` | 类型上有 | 类型上有 | 类型不产生数据 | 地图缓冲路径没有构造它的值。`bufferRequestFromResolution` 没有被这条路径调用 | 类型不查找。要填 `layerName` 仍得先有一份已存储的名字 | `layer-resolution.ts`。职责是成功身份的形状，文件注释写明没有查找函数 | 会。在 T2 填这个类型，要么把 id 抄进 `layerName`，要么先查找。前者不是真实显示名，后者见第 6 节 |
| 浏览器 `knownLayers` 的值 | 有，`Map` 的键以及挂上的 `layer.layerId` | 挂上的对象可以有 `layerName`，那是更早一次列表或挂载时从服务端公开图层抄来的 | 抄写当时来自服务端 `LayerMeta`。本次点击不重新读图层库。重命名处理只改 `layerStyles[id].name` 并 `POST /api/map/rename`，不在该函数里写回 `knownLayers` 的 `layerName` | 对象在浏览器里，可以早于本次 POST。它不在 HTTP 正文里，handler 拿不到 | 不在服务端查找。要让 handler 使用它，就要改请求正文，把客户端副本送上来 | `app.js` 的界面内存。职责是画图层和填下拉框。下拉框可见文字优先用 `layerStyles[id].name` | 会。入口将开始信任浏览器里的一份名字副本，而运算仍按 id 再读图层库。副本与库内 `layerName` 是否仍相同，这次点击的代码没有核对 |

`MapHttpBufferParsed` 与 `rawBufferInputFromMapHttp` 只描述已经取出的 id 字符串，`sourceLayer` 是 `{ kind: "id", id }`。它们不是运行时对象，这条 HTTP 分支也不调用它们。

## 4. 最终找到的合法来源（如果存在）

在 **OperationRequest 组装点**（地图 handler，T2，调用 `SpatialService.buffer` 之前）没有找到同时具备真实 `layerId` 与真实 `layerName` 的现成对象。

沿这次请求，两个字段第一次一起出现在手里，是 T3 的 `input.meta`。那是 `LayerStore.get` 的 `LayerMeta` 快照，发生在 `SpatialService.buffer` 已经进入之后。它是执行过程中的图层元数据，不是调用前交给执行的身份对象。

## 5. 如果不存在，明确说明

情况 B。

当前代码没有在 OperationRequest 组装点提供完整 `LayerResolutionIdentity` 的现成对象。

地图 handler 在调用前只有 `layerId`。真实 `layerName` 要等 `SpatialService.buffer` → `derive` → `requireCollection` → `catalog.get` 命中之后，才出现在 `input.meta` 上。这不是缺陷记录，本任务也不为此新增查找。

## 6. 重复 lookup 风险

`DUPLICATE LOOKUP RISK`

若在 Map handler 里为了得到 `layerName` 而调用 `catalog.get` / `LayerStore.get`（或 `list` 再按 id 过滤），顺序将是：

```text
Map handler
    ↓
lookup layer（新的 get）
    ↓
OperationRequest
    ↓
SpatialService.buffer
    ↓
derive → requireCollection → catalog.get（现有的第二次 get）
```

`requireCollection` 今天已经按同一个 `layerId` 调用 `catalog.get` 和 `catalog.collection`。handler 再 `get` 一次，就是同一次缓冲上对源图层元数据的第二次读取。本任务不实施这条路径。

`buffer` 返回之后，`publicStoreLayer` 还会 `catalog.get`，键是结果图层的 `layerId`，不是源图层，发生在调用返回之后。那一次不能用来在 T2 填源图层显示名。

浏览器若把 `knownLayers.layerName` 放进正文，服务端可以不再为显示名而 `get`，但 `SpatialService.buffer` 仍会 `get`。那避免的是 handler 里的第二次元数据读取，换来的是一份未经本次图层库读取核对的客户端名字。第 3 节已说明重命名路径不会在点击时刷新 `knownLayers.layerName`。本任务同样不改请求正文。

## 7. 对 Task 009 类型边界的影响

Task 009 的规则是：最终 `OperationRequest`（这里是 `BufferOperationRequest`）的 `sourceLayer` 只接受 `LayerResolutionIdentity`，即已经解析成功的 `layerId` 与 `layerName`。原始图层引用、NotFound、Ambiguous 不能成为请求。`bufferRequestFromResolution` 只在调用方已经拿着成功身份时组装请求，它自己不查找。

地图缓冲的现有边界是：入口交出图层标识字符串，`SpatialService.buffer(layerId, distance, unit, writeKnowledge)` 在内部按这个标识取层。显示名是取层的结果，不是入口的输入。

这两条放在一起，在 **handler 作为组装点、且不新增查找、且不把 id 写成 layerName** 的前提下，地图缓冲交不出 Task 009 所要求的请求对象。这是组装点与数据出现时刻不一致，不是某一行赋值写错。

判断分四层，展开在第 8–11 节。本任务不修改 `BufferOperationRequest` 或 `LayerResolutionIdentity`。

## 8. CURRENT FACT

- `#analysis-run` 的 POST 正文带 `layerId`，不带 `layerName`。
- `/api/spatial/run` 的 buffer 分支把 `layerId`、`distance`、`unit`、`writeKnowledge` 传给 `SpatialService.buffer`。调用前没有图层对象。
- `SpatialService.buffer` 在单位合法后进入 `derive`。`derive` 通过 `requireCollection` 调用 `catalog.get(layerId)`。该方法即 `LayerStore.get`，命中时返回的 `LayerMeta` 同时有 `layerId` 与 `layerName`。
- 这次请求的执行路径上，这两个字段第一次同时在手里，是 T3 的 `input.meta`。
- `LayerResolutionIdentity` 只是类型。这条运行路径没有它的值，也没有 `BufferOperationRequest`。
- `SpatialRunResult.layer` 是缓冲结果图层，在调用返回时才有。
- 浏览器 `knownLayers` 可以早于点击就带有以前抄来的 `layerName`。分析按钮不读取、不发送该字段。

## 9. ARCHITECTURE OBSERVATION

Task 009「OperationRequest 只接受 LayerResolutionIdentity」与地图缓冲的现有职责边界有结构性冲突。冲突点是组装时刻，不是字段名字。

地图入口的职责停在 HTTP 字段和 `SpatialService.buffer` 的现有参数。按标识取层、从而得到存储的 `layerName`，是 `requireCollection` 的职责，发生在执行方法内部。Task 009 要求请求在被接受时就已经同时具备两个字段。地图这条链上，能合法凑齐这两个字段的现成值出现在执行内部的 `LayerMeta`，晚于入口能够组装请求的时刻。

因此：在不增加查找、不改 `SpatialService.buffer` 参数、不把标识冒充显示名的条件下，不能在 Map handler 里满足「请求只接受完整身份」。把 `LayerMeta` 投影成 `LayerResolutionIdentity` 可以避免第二次 `get`，但投影点在 `derive` 之内，请求就变成执行过程中的产物，而不再是执行之前的入口合约。那是职责边界的移动，本任务只记录，不改代码。

`knownLayers` 不消除这个冲突。它不在服务端组装点，分析请求也没有把它交给 handler。

## 10. FUTURE RECOMMENDATION

Task 012 只做决定，不在本任务里改代码，也不重做 Task 010。

建议 Task 012 在下面两句里选一句，作为地图缓冲的身份规则，并保持 `SpatialService.buffer` 的参数列表不变：

1. 地图缓冲在调用 `SpatialService.buffer` 之前的合法产物仍是原始 id 引用（今天的 `layerId` 字符串，或已有的 Raw Operation Input `{ kind: "id", id }`）。`LayerResolutionIdentity` 不在这个组装点产生。
2. 身份只允许从 T3 已经返回的 `input.meta` 投影：`{ layerId: meta.layerId, layerName: meta.layerName }`。不在 handler 再调用 `LayerStore.get`。若采用这一句，需要同时写明：这份身份出现在 `derive` 内部，Map handler 仍然不是 `BufferOperationRequest` 的组装点。

不要为了满足第 2 句去改 `SpatialService.buffer` 的参数，也不要在 handler 里先 `get` 一次。那会落回第 6 节的 `DUPLICATE LOOKUP RISK`。

聊天、GDL、MCP 仍不在这个决定里。

## 11. UNKNOWN

- Task 009 是否把「组装点」规定死在 HTTP handler，还是允许组装发生在现有 `requireCollection` 之后、几何运算之前。源码里的 `BufferOperationRequest` 没有被任何入口调用，因此代码证明不了当初选定的组装点。
- 浏览器 `knownLayers` 里的 `layerName` 在用户点击分析的那一刻，是否仍等于 `LayerStore.get(layerId).layerName`。点击处理不刷新图层库，重命名回调也不写回 `knownLayers.layerName`。静态阅读不能把它当成本次存储数据。
- 若将来在 `derive` 内投影身份，这份对象算不算 Task 009 所说的「执行之前已经接受的 OperationRequest」。当前运行路径没有这份对象，无法从行为上证明。
- 没有名为 `LayerRecord` 的类型参与这条链。不能把某个未出现的记录类型写成身份来源。
