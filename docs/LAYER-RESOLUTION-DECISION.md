# 图层解析语义边界决策（V0.75-Clean Phase 2 Task 008）

2026-10-18 补记：聊天和 MCP 的空间工具已经进入 `executeGisOperation`。栅格由本机 Python/GDAL 桥执行，不在 surtgis 里。下面第 14 节里「没有执行器」和「栅格尚未实现」是写这篇决策时的判断，不再是现状。决策正文保留，用来说明当时为什么没有把 `LayerResolutionResult` 接进运行路径。

本文记录：后续图层引用解析统一到哪一层。对照了 Task 007 文档和当前调用点。代码与文档不一致时，以代码为准。

本任务没有修改 `findByName`、`resolveLayerRef`、`SpatialService`、聊天、地图、GDL、MCP。没有新增查找函数，没有新增 Resolver，没有新增 Executor。`LayerResolutionResult` 仍只存在于类型和纯映射 `adaptLayerLookup`。运行路径不调用它。

文中四类标注：

| 标注 | 含义 |
| --- | --- |
| CURRENT FACT | 当前源码里能直接看到的行为 |
| ARCHITECTURE OBSERVATION | 从这些调用关系看出的结构差别 |
| FUTURE RECOMMENDATION | 本次建议以后怎么做。仓库里还没有按它改运行路径 |
| UNKNOWN | 当前源码支持不了的判断 |

---

## 1. 当前四入口解析方式

四条入口今天都把图层引用收成一个 `layerId` 再进入 `SpatialService`，但收的方式不是同一个函数。聊天和 MCP 共用 `openGisWorkspace` 的适配器；地图 HTTP 不经过适配器；GDL 执行另有宿主。

### Chat

**CURRENT FACT**

- 工具参数里的引用是字符串。`GIS_TOOL_REGISTRY` 把 `layerId` / `otherLayerId` 写成「图层标识或图层名」。本地计划从用户句子抽出名字；「当前图层」会被换成选中层的显示名（`pending-plan.ts` 的 `selectedName`、`gis-route.ts` 的 `bindSelectedNames` 都优先 `layerName`）。已有的纯映射把这段字符串记为 `kind: "name-or-id"`。该映射不在 `POST /api/chat` 的运行路径上。
- 页面选中层是另一段数据。`app.js` 的 `selectedLayerPayload()` 发送 `{ layerId, layerName }`，其中 `layerId` 是 `knownLayers` 的键。`desktop-api.ts` 用 `formatSelectedLayer` 在本轮已经排好的摘要数组里找第一条 `layerId` 或 `layerName` 与该字符串精确相等的项。这一步不调用 `LayerStore`，也不调用 `findByName` 或 `resolveLayerRef`。
- 空间工具的解析发生在 `packages/spatial-ops/src/adapter.ts` 的 `resolveRequired`。函数是 `resolveLayerRef`。`status === "ok"` 之后，才把得到的 `layerId` 传给 `SpatialService`。带图层参数的空间工具都走这里，不只有早期的缓冲、相交、裁剪和查询。
- 同一条聊天里的 `gdl.run` 不走 `resolveRequired`。外层 `createGdlAwareAdapter` 进入 `runGdl`，再由 `executeGdl` 调用宿主 `resolveLayer`，宿主调用 `findByName`。
- 同名：空间工具在精确名多于一层时得到 `ambiguous`，不取叠放最上层。`formatSelectedLayer` 若拿到的字符串等于某个显示名，按摘要数组顺序返回第一条；聊天构造该数组时用的是 `catalog.list()`，顺序为从上到下，因此按名字对上时落到最上层那条摘要。页面通常传来的是图层 id，这时按 id 对上对应的那一条。
- 找不到：`missing` 和 `empty` 经 `layerResolvePayload` 成为 `unknown-layer`。`SpatialService` 的运算方法不被调用。`formatSelectedLayer` 对不上则返回 `null`，计划侧把这一轮视为没有选中层。
- 多个候选：`ambiguous` 时工具返回 `ambiguous-layer`，候选最多 12 条，不执行运算。
- 旧语义：空间工具这条是现有的多名候选行为（AMBIGUITY-AWARE）。`gdl.run` 是取最上层（LEGACY）。`formatSelectedLayer` 按名字时取摘要里的第一条，和取最上层同类，但是另一个函数，不读图层库。
- 立即切换到 `LayerResolutionResult`：没有必须现在切换的理由。聊天运行时返回的是现有工具载荷。`adaptLayerLookup` 没有被 `POST /api/chat` 调用。

**ARCHITECTURE OBSERVATION**

聊天里至少有三条与「点名图层」有关的路径：空间工具的 `resolveLayerRef`、`gdl.run` 的 `findByName`、选中层摘要的 `formatSelectedLayer`。把「Chat」写成只有一个查找函数，和调用点不符。

本地计划在绑定「当前图层」时使用显示名。用户在界面上点中的是一个 id。名字随后进入 `resolveLayerRef`。精确重名时，工具得到 `ambiguous`，不会退回当初那个 id。

**FUTURE RECOMMENDATION**

聊天空间工具以后可以按 `name-or-id`，把已经得到的 `LayerResolveHit` 映射成 `LayerResolutionResult`。现在不接。`gdl.run` 跟 GDL 宿主一起留到 GDL 自己的迁移任务。

### Map HTTP / Map UI

**CURRENT FACT**

- 引用是图层 id。`app.js` 里 `#analysis-layer`（以及 `#analysis-other`、`#export-layer`）的 `option.value` 是 `knownLayers` 的键，选项文字是显示名。`#analysis-run` 把这个值作为 `layerId` 发给 `POST /api/spatial/run`。已有纯映射把该字段记为 `kind: "id"`。映射不在这条 HTTP 路径上。
- 解析发生在 `apps/cli/src/map-http.ts`：正文里的 `layerId` 直接传入 `SpatialService.buffer` / `intersect` / `clip` / `query` / `stats`。服务内部 `requireCollection` 调用 `catalog.get(layerId)` 和 `catalog.collection(layerId)`。
- 函数是 `LayerStore.get`（以及按同一 id 取几何的 `collection`）。不调用 `resolveLayerRef`，不调用 `findByName`。
- 同名：存储是 `Map`，一个 id 一层。两个显示名相同的图层在下拉框里是两个选项，请求带的是被选中的那个 id。这条路径不按名字挑选。
- 找不到：`get` 为 `null` 或没有几何时，`requireCollection` 抛出「找不到输入图层。请先把图层载入地图。」`map-http` 把该错误收成 HTTP 400。正文缺少 `layerId` 时，在进入服务之前返回「需要操作类型和图层。」
- 多个候选：这条路径没有候选列表。
- 旧语义：不是「同名取最上层」。id 缺失为失败、id 命中为一条，与草案里 id 的 0 条 / 1 条一致。失败形态是异常，不是 `LayerResolutionResult`。
- 立即切换到 `LayerResolutionResult`：没有必须现在切换的理由。地图按钮已经用唯一 id 点名。把 400 异常改成 Ambiguous 契约，会改变这条 HTTP 的错误形状，而这里没有多名候选可表达。

同一文件里的重命名、删除、导出也读取正文中的 `layerId`，并用 `get`、`remove` 或 `exportLayer`。它们同样不按图层名查找。

**ARCHITECTURE OBSERVATION**

地图分析是四条入口里唯一一条在进入 `SpatialService` 之前就已经持有图层 id 的路径。`requireCollection` 是执行前按 id 取几何，不是名字解析。

### GDL

**CURRENT FACT**

- 语句里的引用是图层名。`executeGdl` 先查本脚本的 `scope`（本脚本里 `LAYER` 或上一条运算刚写入的名字）。`scope` 没有该名字时，调用宿主 `resolveLayer(name)`。已有纯映射把 BUFFER 的输入记为 `kind: "name"`。映射不在运行路径上。
- 宿主在 `apps/cli/src/gdl-http.ts`：`catalog.findByName(name)`，命中则留下 `{ layerId, layerName }`，否则 `null`。
- 同名：`findByName` 沿 `orderIds` 从最上开始，精确名相等就返回那一层。`insert` 把新图层插到 `orderIds` 最前。`insert` 和 `rename` 都不拒绝重名。脚本 `scope` 里已有的名字优先于图层库，库里的同名层不会被问到。
- 找不到：宿主返回 `null`。`executeGdl` 抛出 `GdlRuntimeError`，文案为「找不到图层 ${name}。请先载入它，或在前面用 LAYER 定义。」
- 多个候选：宿主返回值里没有。其余同名层在 `findByName` 返回时已经不在结果中。
- 旧语义：LEGACY。精确同名取叠放最靠上的一层。
- `gdl.describe` 是同一个 GDL 适配器上的另一个工具。它调用 `resolveLayerRef`，精确同名多于一层时返回候选，不调用 `findByName`。
- 执行入口有两条，查找相同：`POST /api/gdl/load`，以及聊天或 MCP 的 `gdl.run`。二者都进入 `runGdl`。
- 立即切换到 `LayerResolutionResult`：没有必须现在切换的理由。`GdlHost.resolveLayer` 的类型是 `GdlLayerRef | null`。Ambiguous 放不进这个返回值。改成多名失败会改变今天仍能对上最上层并继续缓冲的语句。

**ARCHITECTURE OBSERVATION**

GDL 执行和 `gdl.describe` 已经是两种查找。以后的 GDL 迁移要分开处理这两处，不能因为都叫 GDL 就合成一次查找。

### MCP

**CURRENT FACT**

- 引用与聊天工具相同。`executeMcpTool` 用 `normalizeToolArguments` 整理参数，`layerId` 仍是「标识或名字」的字符串。`bufferRequestFromMcp` 与 `bufferRequestFromToolArgs` 是同一个函数，种类为 `name-or-id`。MCP 进程不调用 `formatSelectedLayer`。
- 解析位置：`apps/cli/src/mcp-server.ts` 调用 `openGisWorkspace`，再 `executeMcpTool` → `adapter.execute`。适配器就是桌面那一条：`createGdlAwareAdapter(createSpatialAwareAdapter(...))`。
- 函数：`map.*` 为 `resolveLayerRef`；`gdl.run` 为 `findByName`；`gdl.describe` 为 `resolveLayerRef`。MCP 没有另一份缓冲或另一份图层查找。
- 同名、找不到、多个候选：与聊天里对应的工具相同。
- 旧语义：空间工具是 AMBIGUITY-AWARE。`gdl.run` 是 LEGACY。
- 立即切换到 `LayerResolutionResult`：没有必须现在切换的理由。MCP 与聊天共用同一适配器。只改 MCP 会把这一份适配器拆开。

**ARCHITECTURE OBSERVATION**

MCP 不是第四套查找实现。它是聊天工具适配器的另一个调用方。四条「入口」里，独立的查找实现是：`resolveLayerRef`（聊天/MCP 的空间工具，外加 `gdl.describe`）、`LayerStore.get`（地图）、`findByName`（GDL 执行）、以及只用于选中层摘要的 `formatSelectedLayer`。

---

## 2. `findByName` 现状

**CURRENT FACT**

`LayerStore.findByName`（`packages/surtgis/src/core/layer-store.ts`）按 `orderIds` 从最上往下扫描，`layerName` 精确相等就返回该层的 `LayerMeta`，否则 `null`。注释写明「同名图层取叠放最靠上的那个」。其余同名层不出现在返回值里。

`list()` 的顺序与此一致：第一个在最上面。新插入的图层放在 `orderIds` 最前，因此同名时后插入的那层会先被取到。

业务调用点只有 `gdl-http.ts` 的宿主 `resolveLayer`。依赖这条行为的运行入口是：

- `POST /api/gdl/load`
- 聊天和 MCP 的工具 `gdl.run`（经同一个 `runGdl`）

`executeGdl` 不直接调用 `findByName`。它依赖宿主返回 `GdlLayerRef | null`。

下列代码不调用 `findByName`：

- `resolveLayerRef`
- `adapter.ts` 的 `resolveRequired`
- `map-http.ts` 的 `POST /api/spatial/run`
- `formatSelectedLayer`
- `adaptLayerLookup`（它只接收已经得到的一条 `LayerMeta` 或 `null`）

**ARCHITECTURE OBSERVATION**

一条 `LayerMeta` 里没有「当时还有哪些同名层」。`adaptLayerLookup` 收到这一条时只能映射为 Resolved（`ok: true`，带 `layerId` 和 `layerName`）。`null` 映射为 NotFound。Ambiguous 从这份返回值里恢复不出来。这是 LEGACY 查找里的信息丢失。

**FUTURE RECOMMENDATION**

保持 `findByName` 的现有返回：同名仍取最上层。将来若要让精确名在两层及以上时成为 Ambiguous，要改的是能返回候选集合的那一次查找，并且单独改 GDL 宿主的返回类型。只改适配器补不回已经丢掉的层。

---

## 3. `resolveLayerRef` 现状

**CURRENT FACT**

`resolveLayerRef`（`packages/spatial-ops/src/resolve-layer.ts`）读取调用方已经给出的 `catalog.list()`，返回 `LayerResolveHit`，不写图层库。

1. 去掉空白后为空：`status: "empty"`。
2. `layerId` 与字符串完全一致：`ok`。此后不再看名字。
3. 精确名 1 条：`ok`。多于 1 条：`ambiguous`，候选来自这些层。
4. 忽略大小写后 1 条：`ok`。多于 1 条：`ambiguous`。
5. 字符串短于 2 且上面都没对上：`missing`。
6. 双向包含 1 条：`ok`。多于 1 条：`ambiguous`。否则 `missing`。

`ambiguous` 和 `missing` 的候选按 `layerId` 去重后只留前 12 条。每条候选含 `layerId`、`layerName`、`geometryKind`、`featureCount`。成功值只有 `layerId` 和 `layerName`，不记录走的是 id、精确名、忽略大小写还是包含。

它能返回多个候选，并且不自行挑选。这是现有代码，不是草案。

运行中的调用者：

- `adapter.ts` 的 `resolveRequired`：聊天和 MCP 的 `map.*`（见第 1 节）
- `gdl-http.ts` 的 `gdl.describe`

`layerResolveMessage` / `layerResolvePayload` 把 `missing` 和 `empty` 说成 `unknown-layer`，把 `ambiguous` 说成 `ambiguous-layer`。那是工具文案，不是 `LayerResolutionResult`。

**ARCHITECTURE OBSERVATION**

对 `kind: "name-or-id"` 来说，这份函数已经是现成的查找底子：id 优先，精确重名不收成一条，多名时带候选。`adaptLayerLookup` 能把 `ok` / `missing` / `ambiguous` 收成契约，并丢掉候选上的几何种类和要素数。`empty` 不进入 `LayerResolutionResult`。

它不适合直接换成地图的 `get`，也不适合直接换成 GDL 的 `findByName`。地图只认 id。GDL 执行只认精确名，并且重名时取最上层。`resolveLayerRef` 另外还有忽略大小写和双向包含；成功值不记录匹配种类。候选在第 12 条处截断，第 13 条及以后不在 `LayerResolveHit` 里，适配器不能把它们补回来。

**FUTURE RECOMMENDATION**

保持 `resolveLayerRef` 的现有多名返回。以后 Operation 若消费 `name-or-id`，以这份命中为输入做映射，不另写一套包含匹配。12 条上限若要在统一结果里保留或取消，留到接入该入口的那个任务里说明。

---

## 4. Resolution Contract 与 Lookup Implementation 的区别

A、B、C 是三件不同的事。

### A. 统一解析契约

**CURRENT FACT**

`packages/spatial-ops/src/layer-resolution.ts` 已经定义 `LayerResolutionResult`：

- Resolved：`ok: true`，字段为 `layerId` 与显示名 `layerName`
- NotFound：`ok: false`，`code: "NotFound"`
- Ambiguous：`ok: false`，`code: "Ambiguous"`，`candidates` 为 `{ layerId, layerName }` 列表

`adaptLayerLookup` 把已经得到的 `LayerResolveHit`（不含 `empty`）或 `LayerMeta | null` 映射成这个结果。它不查找。聊天、地图、GDL、MCP 都不调用它。包入口 `index.ts` 不导出这个文件。

**FUTURE RECOMMENDATION**

以后的 Operation 层依赖这个结果：先得到 Resolved / NotFound / Ambiguous 以及 layer id、显示名、候选，再谈执行。这一步现在就作为边界采用。调用方仍各自查找。

### B. 统一解析入口

**CURRENT FACT**

仓库里没有一个函数同时被聊天、地图、GDL、MCP 用来解析图层引用。`resolveRequired` 只服务空间工具适配器。地图走 `requireCollection`。GDL 执行走宿主 `resolveLayer`。

**FUTURE RECOMMENDATION**

一个供全部调用方使用的 resolution API 现在不做。各入口以后各自迁移，每次只接一个入口。

### C. 统一底层查找实现

**CURRENT FACT**

`findByName` 与 `resolveLayerRef` 对同一组精确重名的结果相反：前者返回最上一条，后者返回 `ambiguous`。地图的 `get` 不参与名字比较。`formatSelectedLayer` 是第四个「按字符串在摘要里找一条」的函数，也不调用前两者。

**FUTURE RECOMMENDATION**

现在不把所有入口收成同一个 `findByName` 或同一个 `resolveLayerRef`。不新增 `findAllByName`，不新增第二套查找。

### 现在采用哪一层

**FUTURE RECOMMENDATION**

现在采用的是 A：共享结果契约。B 和 C 延期。

采用 A 的代码依据：契约类型和纯映射已经在 `spatial-ops` 里，而且可以同时描述「一条命中」和「多名候选」，不必先改任何入口。

延期 B 的代码依据：四个调用点的参数形状不同（工具字符串、HTTP 的 id、GDL 语句名、MCP 与聊天共用适配器）。合成一个 API 意味着现在就改这些调用点。

延期 C 的代码依据：精确重名的两条实现已经分叉。收成同一个函数会改变 GDL 执行，或改变聊天/MCP 空间工具，或同时改变两者。地图分析按钮不经过这两个函数，收成同一个名字查找也覆盖不了它。

---

## 5. 兼容性风险

**CURRENT FACT**

`findByName` 在返回前丢掉其余同名层。之后任何只看到这一条 `LayerMeta` 的代码，包括 GDL 宿主和 `adaptLayerLookup`，都无法再变成 Ambiguous。这是信息丢失，不是适配器可以选择的策略。

`resolveLayerRef` 在 `ambiguous` 时保留候选，但只保留前 12 条，并带上契约不需要的 `geometryKind` 和 `featureCount`。`missing` 上的 `candidates` 是给错误文案用的图层清单，不是匹配结果；映射成 NotFound 时这份清单被整份丢掉。

聊天本地计划把选中层收成显示名再交给 `resolveLayerRef`。界面上的 id 不会随这个名字一起进入空间工具。精确重名时，用户点中的那一层不会被自动挑中。

**ARCHITECTURE OBSERVATION**

若把 `findByName` 改成「两层及以上则 Ambiguous」，受影响的是今天依赖「取最上层」的 GDL 执行：

- `POST /api/gdl/load`
- 聊天与 MCP 的 `gdl.run`

宿主若改返回 `null`，`executeGdl` 会把这种情况说成「找不到图层」，和真正没有这层是同一句错误。宿主类型本身没有候选字段，Ambiguous 表达不出来，除非同时改 `GdlHost` 和 `executeGdl`。

下列行为不会因为 `findByName` 的返回值改变而改变，因为它们不调用它：

- 地图 `POST /api/spatial/run`（`get`）
- 聊天和 MCP 的 `map.*`（`resolveLayerRef`）
- `gdl.describe`（`resolveLayerRef`）
- `formatSelectedLayer`

反过来，若把 `resolveLayerRef` 改成取最上层，聊天和 MCP 的空间工具以及 `gdl.describe` 会从「多名则拒绝」变成「默默用一条」。那是另一方向的行为变化。本次两边都不改。

**FUTURE RECOMMENDATION**

迁移时，GDL 执行只能在查找结果真正含有候选集合之后才产生 Ambiguous。禁止把今天的单条 `findByName` 命中解释成 Ambiguous。聊天/MCP 的 `LayerResolveHit` 已经带有 `ambiguous`，映射时保留候选身份，并单独说明 12 条截断。地图按 id 的 `null` / 一条元数据可以映射为 NotFound / Resolved，不为 id 制造 Ambiguous。

---

## 6. 方案 1 / 2 / 3 对比

| 方案 | 内容 | 和当前代码的关系 |
| --- | --- | --- |
| 1 | 现在统一所有入口的查找实现 | 要改 `findByName` 或 `resolveLayerRef` 或两者，并改地图、GDL 宿主或聊天适配器中的至少一处。精确重名的结果会变。`GdlHost` 目前返回不了候选。 |
| 2 | 只把 Resolution Contract 定为以后 Operation 依赖的结果；入口实现保持原样 | `LayerResolutionResult` 与 `adaptLayerLookup` 已经存在且未被运行路径调用。四条入口可以继续用现在的函数。 |
| 3 | 契约也不作为共同边界；四套入口继续完全独立 | 类型文件已经写了 Resolved / NotFound / Ambiguous。运行路径确实仍各查各的。方案 3 等于不再让以后的 Operation 依赖这份已有结果类型。 |

**ARCHITECTURE OBSERVATION**

方案 1 要求的统一，当前调用点做不到「不改变行为」。同一组精确重名，GDL 执行成功对上最上层，聊天空间工具则拒绝并列出候选。没有第三种现有函数已经同时满足这两边。

方案 2 不要求运行路径今天返回 `LayerResolutionResult`。它只确定：以后 Operation 要的解析结果是这份契约，查找仍留在现有函数里，直到某个入口自己的迁移任务。

方案 3 与「运行路径尚未统一」这个事实相符，但它不使用仓库里已经写好、且能描述两种查找结果的契约。Task 005/006 的类型会变成没有归属的草稿。代码没有表明这份类型与现有入口冲突；冲突的是底层同名规则，不是结果类型本身。

---

## 7. 最终选择

**FUTURE RECOMMENDATION**

选择方案 2。

以后 Operation 层依赖 `LayerResolutionResult`（Resolved / NotFound / Ambiguous，以及 layer id、显示名、候选）。`findByName` 保持同名取最上层。`resolveLayerRef` 保持多名候选、不挑选。不新增第二套查找。不修改聊天、地图、GDL、MCP 的运行逻辑。每个入口在以后各自的任务里再决定如何映射到这份契约。

**CURRENT FACT**

这个选择还没有落成运行时行为。今天四条入口仍按第 1 节的函数解析。没有任何 Operation Executor 在执行前读取 `LayerResolutionResult`。

选择方案 2 的理由来自调用点，不是来自「统一看起来更整齐」：

- 契约已经能表示一条命中和多名候选，入口不必先合并。
- 合并查找会改变 GDL 或改变聊天/MCP，地图 id 路径又用不上名字查找。
- 没有一条当前错误要求立刻改同名规则。各入口在自己的规则下能完成或拒绝一次调用。
- `gdl.describe` 与 GDL 执行不一致，说明 GDL 内部就要分开迁，而不是现在把全部入口收成一个函数。

代码里没有迫使改选方案 1 或方案 3 的反例。方案 1 的反例是同名语义已经分叉。方案 3 的不足是结果类型已经存在，并且可以在不改入口的情况下作为 Operation 的解析结果；拒绝这份契约并不会让四条入口变得更一致。

---

## 8. 为什么现在不修改 `findByName`

**CURRENT FACT**

它是 GDL 执行唯一的图层库名字查找。同名取最上层是注释和循环都写明的当前行为。返回类型是 `LayerMeta | null`，没有候选数组。

**FUTURE RECOMMENDATION**

现在不改。改成 Ambiguous 会让仍依赖最上层的 GDL 语句对不上原来的那一层，而宿主又无法把候选交还给 `executeGdl`。地图和聊天空间工具并不因此变得更正确，因为它们不调用这个方法。信息已经在返回时丢失；保持原样，避免把丢失误写成「已经能报告 Ambiguous」。

---

## 9. 为什么现在不创建 Resolver

**CURRENT FACT**

会返回多名候选的查找已经在 `resolve-layer.ts`。结果类型和纯映射已经在 `layer-resolution.ts`。二者都在 `packages/spatial-ops`。没有 `layer-resolver.ts`，也没有 Resolver 类。`GisKernel.execute` 只有接口，仓库里没有类实现它。

**ARCHITECTURE OBSERVATION**

再做一个 Resolver 类或新包，就是在这两份文件之外增加一套查找或一套入口。那是方案 1 的方向。当前没有调用点在等这个类。

**FUTURE RECOMMENDATION**

现在不创建 Resolver，不创建 Resolver 包，不把解析服务挂到 `SpatialService` 上。名字或 id 的现有查找留在原函数。结果契约留在 `layer-resolution.ts`。

---

## 10. 后续迁移的原则

**FUTURE RECOMMENDATION**

1. Operation 层只依赖 `LayerResolutionResult` 里的身份：成功时的 `layerId` 和 `layerName`，失败时的 NotFound 或带候选的 Ambiguous。几何、要素数、匹配种类仍不放进这个结果。
2. 一次任务只迁移一个入口。聊天空间工具、地图 HTTP、GDL 执行、`gdl.describe` 不捆在同一次修改里。MCP 与聊天共用适配器，空间工具的迁移会同时覆盖 MCP，这是同一份代码，不是两个独立实现。
3. 迁移时保持该入口今天的同名规则，直到该任务明确要改规则。GDL 执行继续取最上层，直到有一次查找能返回全部精确同名候选，并且宿主能表达 Ambiguous。
4. 禁止把 `findByName` 的单条命中映射成 Ambiguous。禁止为了对称，给地图的 id 查找增加「挑一层」。
5. `resolveLayerRef` 继续作为 `name-or-id` 的现有底子。不并行再写一套包含匹配。
6. 空白引用仍留在现有校验和 `status: "empty"`。不把它收成 NotFound。
7. 不新增 `findAllByName`，除非某个已经单独立项的迁移证明：不增加这个函数就无法把候选交给契约。本决策不包含那个函数。
8. 本文件不启动下一次迁移。

---

## 11. CURRENT FACT

- 聊天和 MCP 的 `map.*` 用 `resolveLayerRef`。精确同名、忽略大小写或双向包含多于一层时返回候选，不取最上层。候选最多 12 条。找不到或空白时返回工具错误，不调用运算。
- 地图分析 UI 提交图层 id。`POST /api/spatial/run` 经 `requireCollection` → `LayerStore.get`。不按名字查找。没有则抛「找不到输入图层」。
- GDL 执行用 `findByName`。精确同名取 `orderIds` 最上层。没有则 `executeGdl` 抛「找不到图层」。`gdl.describe` 用 `resolveLayerRef`，与执行不是同一个函数。
- `formatSelectedLayer` 只在聊天里从摘要数组挑选中层。按名字匹配时取数组中第一条。它不执行 GIS。
- `findByName` 的业务调用点只有 GDL 宿主。`resolveLayerRef` 的业务调用点是空间工具适配器和 `gdl.describe`。
- `insert` 与 `rename` 不拒绝重名。图层 id 存在 `Map` 里，一个 id 至多一层。
- `LayerResolutionResult` 和 `adaptLayerLookup` 已在 `layer-resolution.ts`。运行中的聊天、地图、GDL、MCP 不调用它们。
- `BufferOperationRequest` 只描述引用种类（`id` / `name` / `name-or-id`），不解析图层。运行路径不导入该文件。
- 没有函数接收 `OperationRequest` 并执行 GIS。`SpatialService.buffer` 等方法接收的是已经分开的 `layerId`、距离、单位等参数。
- `GisKernel` / `GisBackendPlugin` 的 `execute` 只有类型。仓库里没有 `implements` 它们的类。
- MCP 与桌面共用 `openGisWorkspace` 的同一适配器和同一 `SpatialService`。MCP 没有第二套图层查找。

---

## 12. ARCHITECTURE OBSERVATION

- A（结果契约）、B（一个解析 API）、C（一个底层查找）不是同一件事。当前代码只具备 A 的类型和纯映射。B 和 C 都没有。
- 同名规则已经分叉，所以 C 不能在保持行为的前提下完成。
- 聊天这一条入口内部就有 `resolveLayerRef`、`findByName`（经由 `gdl.run`）和 `formatSelectedLayer`。地图则在进服务之前已经是 id。
- `findByName` 折叠重名之后，Ambiguous 不可恢复。`resolveLayerRef` 是 `name-or-id` 上已经能交出多名候选的实现，同时带有大小写、包含和 12 条上限。
- `SpatialService` 把按 id 取几何、检查、缓存、运算、写入图层库、审计和可选 RAG 放在一起。它不读取 `LayerResolutionResult`，也不读取 `ExecutionPolicy`。把它当成「接收 OperationRequest 的执行器」和类的方法签名不符。
- 缓冲请求、请求校验、解析结果类型、`resolveLayerRef` 和 `SpatialService` 都在 `packages/spatial-ops`。`gis-kernel` 没有执行函数体。矢量运算和图层库在 `surtgis`。
- 解析结果类型在 `layer-resolution.ts`。会返回多名候选的查找函数在 `resolve-layer.ts`。图层库的 `findByName` 在 `layer-store.ts`。三份文件职责不同。

---

## 13. FUTURE RECOMMENDATION

- 采用方案 2。Operation 层依赖 `LayerResolutionResult`。入口实现保持今天的函数和今天的同名规则。
- 现在采用的层次是 A。B（统一解析 API）和 C（统一底层查找）延期到各入口自己的迁移任务。
- 不修改 `findByName`。不修改 `resolveLayerRef`。不新增第二套查找。不创建 Resolver。不把四个入口改成立刻返回 `LayerResolutionResult`。
- `spatial-ops` 继续作为 Operation 请求、校验和解析结果类型的已有位置。不新增顶层 GIS package。
- 查找行为继续留在现有函数：`name-or-id` 以 `resolve-layer.ts` 为底，GDL 精确名以 `findByName` 为底，地图 id 以 `get` 为底。结果类型继续留在 `layer-resolution.ts`。
- 迁移原则见第 10 节。本决策不执行迁移。

---

## 14. UNKNOWN

Task 007 的五条判断，凡是源码对得上的，写在上面的 FACT 或 OBSERVATION 里。下面只保留源码不能判定的部分。

1. **当前没有真正的 Operation Executor。** 源码支持这一条，见第 11 节。不标 UNKNOWN。这里的「Operation Executor」指接收 `OperationRequest`（或 `BufferOperationRequest`）并执行 GIS 的组件。`SpatialService` 在执行缓冲，但它接收的不是这份请求对象。

2. **`SpatialService` 不能直接等同于未来的 Operation Executor。** 源码支持「当前这个类不是那份请求的执行器」，见第 12 节。未来执行器的类名和文件名尚未存在，因此「它将来会叫什么、放在哪个新文件」是 UNKNOWN。本决策只确定：不要把今天的 `SpatialService.buffer(layerId, distance, unit, ...)` 签名写成已经是 Operation Executor。

3. **`spatial-ops` 是未来 Operation 能力最合理的已有归属位置。** 请求类型、校验、解析结果和当前执行服务已经在这个包里，`gis-kernel` 没有执行函数体。作为「已有位置」成立，见第 13 节。UNKNOWN 的是：以后若把运算从 `SpatialService` 拆出去，拆出去的那一部分是否仍在 `spatial-ops`。本任务的代码没有这个拆分。

4. **`resolve-layer.ts` 是未来 Resolution 能力最合理的已有归属位置。** 只对「今天会返回多名候选的查找」成立：那个函数在该文件。`LayerResolutionResult` 不在该文件，而在 `layer-resolution.ts`。UNKNOWN：以后新的查找函数体必须写在 `resolve-layer.ts`，还是写在 `layer-resolution.ts`，或改在 `findByName` 上。源码把查找和结果类型分成了两个文件，没有写下一处函数体的落点。本决策不新增第三个文件。

5. **当前不需要增加新的顶层 GIS package。** 作为现在这条决策的建议成立：契约和查找都已经在现有包内，没有未解析的顶层包引用。UNKNOWN 的是更远的产品范围（例如尚未实现的栅格执行）是否最终需要新包。`surtgis` 的栅格接口标记为 `not-in-v0.1`，没有函数体，不能由此推出要不要新包。

另外一条与五条判断无关、但源码同样给不出的事实：

- **外部 MCP 进程里、非 Igis 工具如何解释图层。** `composeAdapters` 会把额外工具名交给外部适配器。那些工具的实现不在本仓库。Igis 自己的 `map.*` 与 `gdl.*` 仍走第 1 节的适配器。
