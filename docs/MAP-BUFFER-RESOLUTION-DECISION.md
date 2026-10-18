# Map Buffer 的图层身份产生位置（V0.75-Clean Phase 2 Task 012）

本任务只做架构决定：Map Buffer 的完整图层身份在哪一层产生。

没有改业务代码。没有改 `SpatialService.buffer`。没有改 `OperationRequest` / `BufferOperationRequest`。没有改 `LayerResolutionIdentity`。没有改地图缓冲。没有新增查找、Resolver 或 Executor。没有改 `findByName`、`resolveLayerRef`。聊天、GDL、MCP 不在这个决定里。没有重做 Task 010。

代码里的显示名是已存储图层上的 `layerName`。没有名为 `displayName` 的字段。下面说的真实显示名都是指这一字段。

核对范围只有 Task 011 文档 `docs/MAP-BUFFER-LAYER-IDENTITY-SOURCE.md`，以及：

- `apps/cli/src/map-http.ts` 的 `POST /api/spatial/run`，`operation === "buffer"` 分支（约 248–264 行）
- `packages/spatial-ops/src/service.ts` 的 `SpatialService.buffer`（约 389–410 行）
- 同文件的 `requireCollection`（约 202–207 行），以及 `buffer` 经 `derive` 调用它的位置（约 579 行）

没有重扫整个 GIS 架构。核对没有推翻 Task 011。

## 1. Task 011 已确认的事实

**CURRENT FACT**

`apps/cli/src/map-http.ts` 在缓冲分支里调用：

```ts
deps.spatial.service.buffer(layerId, distance, unit, writeKnowledge)
```

第五个参数不传。调用前这一分支没有 `catalog.get`，没有图层对象，没有 `layerName`。

`SpatialService.buffer` 的参数仍是 `layerId: string`、`distance: number`、`unitText: string`、`writeKnowledge: boolean`、`outputName: string | null = null`。单位或距离不合法时，失败审计的 `inputLayerNames` 用 `safeLayerName(layerId)`，这一段不读图层库。通过之后调用 `this.derive("buffer", "缓冲", layerId, null, writeKnowledge, ...)`。

`derive` 调用 `requireCollection(layerId)`。`requireCollection` 执行 `this.catalog.get(layerId)` 与 `this.catalog.collection(layerId)`。命中时返回的 `meta` 是 `LayerMeta`，同时带有 `layerId` 与 `layerName`。`catalog.get` 即 `LayerStore.get`。

因此，这次请求的执行路径上，真实 `layerId` 与真实 `layerName` 第一次同时在手里，是进入 `SpatialService.buffer` 之后、`requireCollection` 成功返回的图层记录。Map handler 在调用前只有原始 `layerId`。

这条运行路径没有构造 `LayerResolutionIdentity`，也没有构造 `BufferOperationRequest`。`bufferRequestFromResolution` 没有被这条路径调用。

## 2. 方案 A

**ARCHITECTURE DECISION** 的对照项，本任务不采用。

在 Map handler 里先查找图层，组装 `LayerResolutionIdentity`，再交给 `SpatialService.buffer`。服务内部的现有查找仍会再取一次层。

```text
Map handler
    ↓
lookup layer（新的 get）
    ↓
LayerResolutionIdentity
    ↓
OperationRequest
    ↓
SpatialService.buffer(layerId, ...)
    ↓
derive → requireCollection → catalog.get（现有的又一次 get）
```

入口多一次查找。`SpatialService.buffer` 仍然按 id 查找。同一次缓冲对源图层元数据读两次。查找进入今天不读图层库的 HTTP 分发。这改变当前职责边界。

## 3. 方案 B

**ARCHITECTURE DECISION** 采用本方案。见第 6 节。

Map 只交出 `layerId`。`SpatialService.buffer` 使用它今天已经有的那一次查找。真实图层记录从这次查找得出。完整身份从这份已经取回的记录投影，不再另查一次。

```text
Map handler
    ↓
layerId
    ↓
SpatialService.buffer(layerId, distance, unit, writeKnowledge)
    ↓
已有 lookup：derive → requireCollection → catalog.get
    ↓
真实 LayerMeta（layerId + layerName）
    ↓
LayerResolutionIdentity = { layerId: meta.layerId, layerName: meta.layerName }
    ↓
继续现有 buffer 执行
```

不新增 lookup。不改变 `SpatialService.buffer` 的参数。不改变 Map 今天送出的输入。身份来自已经存在的图层记录。不把 `layerId` 抄进 `layerName`。

投影点在 `SpatialService.buffer` 已经进入之后、`requireCollection` 已经返回 `input.meta` 的地方。Map handler 仍然不是这份身份的产生点，也仍然不是 `BufferOperationRequest` 的组装点。

**CURRENT FACT**：上面的投影今天还没有写进运行路径。本决定规定它应当从哪里产生。本任务不把这行投影加进 `derive`。

## 4. 两者调用链

**CURRENT FACT** 上的现有链：

```text
POST /api/spatial/run
    ↓
textField(body, "layerId")、distance、unit、writeKnowledge
    ↓
SpatialService.buffer(layerId, distance, unit, writeKnowledge)
    ↓
单位合法后 derive
    ↓
requireCollection(layerId)
    ↓
catalog.get(layerId) 命中 → LayerMeta
```

**ARCHITECTURE DECISION** 下两条候选链的差别只在身份从哪一次读取产生：

| | 方案 A | 方案 B |
| --- | --- | --- |
| Map 在调用前交出什么 | 先查找，再交出完整身份 | 只交出 `layerId` |
| 源图层元数据读取次数 | handler 一次，`requireCollection` 再一次 | 只有 `requireCollection` 里现有的那一次 |
| `SpatialService.buffer` 参数 | 为了在调用前塞进身份，边界会被拉开 | 保持 `(layerId, distance, unit, writeKnowledge)`，第五参仍可不传 |
| 显示名 | 来自 handler 里新增的那次读取 | 来自同一次 `catalog.get` 已经返回的 `meta.layerName` |
| 身份产生层 | Map handler | `SpatialService.buffer` 内部已经取回的图层记录 |

## 5. 重复 lookup 风险

**CURRENT FACT**

`requireCollection` 已经按同一个 `layerId` 调用 `catalog.get` 和 `catalog.collection`。`buffer` 返回之后，`withStoreLayer` → `publicStoreLayer` 还会 `catalog.get`，键是结果图层的 `layerId`，不是源图层，发生在调用返回之后。那一次不能用来在调用前填源图层显示名。

**ARCHITECTURE DECISION**

方案 A 是 `DUPLICATE LOOKUP`：handler 为了得到 `layerName` 再 `get` 一次，`requireCollection` 对同一个源图层再 `get` 一次。本决定不采用方案 A，因此不把这次重复读取写进地图缓冲。

方案 B 不增加查找。身份是已取回记录上的两个字段，投影不再调用 `catalog.get`。

## 6. 最终选择

**ARCHITECTURE DECISION**

选择方案 B。

Map Buffer 的完整 Layer Identity 不由 Map handler 产生。它来自 `SpatialService.buffer` 内部已经完成的真实 layer lookup 所取回的图层记录。

这不是新增第二次查找。这也不是改变 `SpatialService.buffer` 的参数。

## 7. 为什么选择该方案

**CURRENT FACT**

第 1 节的核对与 Task 011 一致，没有新的反例。调用前手里没有同时带真实 `layerId` 与真实 `layerName` 的对象。这两个字段第一次同时出现，是 `requireCollection` 返回的 `input.meta`。

**ARCHITECTURE DECISION**

在这个事实上，默认就是方案 B。方案 A 要在 handler 里新增查找，并让 `requireCollection` 再查一次，从而改变今天的边界。方案 B 把身份放在已经发生的那一次取层之后，查找次数不变，参数列表不变，也不把标识字符串写成显示名。

## 8. Task 009 的规则如何准确表述

**ARCHITECTURE DECISION**

Task 009 的原则是：

> `OperationRequest` 不能携带未经解析的原始 layer reference。

`BufferOperationRequest.sourceLayer` 的类型是 `LayerResolutionIdentity`（`layerId` 与 `layerName`）。原始 `LayerReference`、NotFound、Ambiguous 不能成为这份请求。`bufferRequestFromResolution` 只在调用方已经拿着成功身份时组装请求，它自己不查找。

这条原则不应表述成：

> 每一个入口函数都必须先取得完整 `LayerResolutionIdentity`，然后才能调用 `SpatialService`。

两句不是同一件事。更准确的分层是：

```text
Raw Input
    ↓
Resolution
    ↓
Resolved Layer Identity
    ↓
OperationRequest / Execution
```

Resolution 可以坐在现有调用边界里面。它不必先被 Map handler 做完，再进入 `SpatialService.buffer`。

**CURRENT FACT**

地图这条链今天就是：

```text
Map handler
    ↓
Raw layerId
    ↓
SpatialService.buffer
    ↓
Resolution（requireCollection → catalog.get）
```

这是当前架构。本决定不把它当成现在就要擦掉的缺陷。

类型形状不用为了这句改写。`BufferOperationRequest` 已经只接受已解析身份。本任务不修改该类型，也不修改 `LayerResolutionIdentity`。

## 9. 当前 Map Buffer 的特殊性

**CURRENT FACT**

地图缓冲的入口事实是：handler 持有原始 `layerId`，解析发生在 `SpatialService` 内部。浏览器分析按钮的 POST 正文不带 `layerName`。`knownLayers` 里可能有更早抄来的名字，这次点击不发送它。

单位校验失败时走不到 `requireCollection`，因此那条失败路径上没有图层记录，也没有可投影的身份。

**ARCHITECTURE DECISION**

因为解析坐在现有的 `buffer` 调用里面，Map handler 继续只传 `layerId`。完整身份的产生点定为服务内部已经取回的 `LayerMeta`，而不是 HTTP 分发函数。

在这个决定落地为代码之前，运行路径仍然直接调用 `service.buffer(layerId, distance, unit, writeKnowledge)`。Map Buffer 仍然暂时不接 `OperationRequest`。本任务不把 `BufferOperationRequest` 接到这条路径上。

## 10. 未来统一 Operation 执行时可能需要处理的问题

**FUTURE RECOMMENDATION**

如果将来 `OperationRequest` 成为唯一执行入口，地图这条 `layerId` → `SpatialService` 内部 lookup 的路径可能需要再重构：入口交出的将是已经接受的请求，而不是今天这种把原始 id 交进 `buffer`、由内部查找完成解析。

那不是 Task 012 的工作。不要为了提前统一去修改 `SpatialService.buffer`。

聊天、GDL、MCP 的查找位置不由本决定改写。

## 11. CURRENT FACT

- `#analysis-run` 的缓冲请求交给 `POST /api/spatial/run` 的是 `layerId`，不是 `layerName`。
- `map-http.ts` 的 buffer 分支调用 `service.buffer(layerId, distance, unit, writeKnowledge)`。调用前没有图层对象，没有 `catalog.get`。
- `SpatialService.buffer` 的参数列表未改。第五个参数 `outputName` 默认为 `null`。
- 单位合法后，`derive` 通过 `requireCollection` 调用 `catalog.get(layerId)`。命中的 `LayerMeta` 同时有 `layerId` 与 `layerName`。
- 这两个字段第一次同时在这次请求的执行路径上，是该 `LayerMeta`。
- 运行路径今天没有 `LayerResolutionIdentity` 的值，也没有 `BufferOperationRequest`。
- 方案 A 若实施，会在 handler 与 `requireCollection` 对同一源图层各 `get` 一次。
- 本任务没有改 `.ts` / `.js`。

## 12. ARCHITECTURE DECISION

选择方案 B。

Map Buffer 的完整 Layer Identity 不由 Map handler 产生。它由 `SpatialService.buffer` 内部已经取回的图层记录产生：`{ layerId: meta.layerId, layerName: meta.layerName }`。不再次查找。不伪造 `layerName`。`SpatialService.buffer` 的参数保持不变。

Task 009 准确表述为：`OperationRequest` 不得携带未解析的原始图层引用。Resolution 允许留在现有调用边界内。地图的事实是 handler 持有原始 `layerId`，解析发生在 `SpatialService` 内部。这是当前架构，不是现在要消除的异常。

Map Buffer 因此仍然暂时不接 `OperationRequest`。本决定不要求在本任务里把投影写进 `derive`。

## 13. FUTURE RECOMMENDATION

若 `OperationRequest` 以后成为唯一执行入口，地图路径上的 `layerId` → 服务内部 lookup 可能要再重构。只记录，不在本任务实施，也不修改 `SpatialService.buffer`。

聊天、GDL、MCP 仍分开处理。

## 14. UNKNOWN

- 将来若在 `derive` 内把 `input.meta` 投影成 `LayerResolutionIdentity`，这份对象是否算 Task 009 所说的「执行之前已经接受的 OperationRequest」。当前运行路径没有这份对象，行为证明不了。
- 浏览器 `knownLayers` 里的 `layerName` 在用户点击分析时，是否仍等于 `LayerStore.get(layerId).layerName`。点击处理不刷新图层库。静态阅读不能把客户端副本当成本次存储数据。方案 B 不使用这份副本。
- 单位或距离在进入 `derive` 之前就失败时，没有 `LayerMeta`。这条失败路径如何与「请求必须已解析」对齐，本决定没有规定新的失败对象。
- 没有名为 `LayerRecord` 的类型参与这条链。身份来源写成 `requireCollection` 返回的 `LayerMeta`，不写成一个未出现的记录类型。
