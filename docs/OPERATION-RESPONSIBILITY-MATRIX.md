# Operation 职责矩阵（V0.75-Clean Phase 2）

这是当前状态，不是未来目标。没有把还没做的层写成已完成。

| 概念 | 回答的问题 | 当前状态 |
| --- | --- | --- |
| Intent | 用户想做什么 | 已存在，当前实现分散 |
| OperationRequest | 要执行什么操作 | 已实现 Buffer 草案 |
| Validation | 请求结构是否合法 | 已实现 Buffer |
| Resolution | 引用是否能解析 | 草案。LayerResolution 未实现；LayerResolutionResult 已定义类型 |
| Policy | 允许怎么执行 | 草案 |
| Execution | 真正执行 GIS | 现有路径 |
| OperationRecord | 实际发生了什么 | 未实现 |

补充，仍是当前事实：

- Intent 散在本地解析、工具参数、地图 HTTP 和 GDL，没有单独模块。
- OperationRequest 只有缓冲这一种草案：`BufferOperationRequest`。其中 `LayerReference` 已实现，是 `sourceLayer`。运行路径不交出这份请求。
- Validation 只有 `validateBufferOperation`。它不接进运行时，也不检查策略。
- LayerResolution 只有草案 `docs/LAYER-RESOLUTION-DRAFT.md`。统一解析 **NOT IMPLEMENTED**。没有解析函数，没有接入运行时。
- `LayerResolutionResult` 已定义类型。运行时不读取它，也没有人用它去查图层。
- 现有查找仍是 `resolveLayerRef`、`findByName`、`requireCollection` 各做各的。
- Policy 草案是类型 `ExecutionPolicy`，目前只有可选的 `writeKnowledge`。策略运行机制 **NOT IMPLEMENTED**。运行时仍把原来的布尔值直接传给 `SpatialService.buffer`。
- Execution 是聊天、地图、GDL、MCP 原来的调用。统一入口 **NOT IMPLEMENTED**。
- OperationRecord **NOT IMPLEMENTED**。
