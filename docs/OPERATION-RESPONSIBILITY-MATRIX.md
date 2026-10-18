# 操作职责

这是当前运行路径，不是草案。工具名单以 `GIS_TOOL_REGISTRY` 和 `CAPABILITY_MANIFEST` 为准。

| 概念 | 当前状态 |
| --- | --- |
| Intent | 句子没有歧义时，本地意图直接选已登记的工具。含糊、缺距离或对不上工具时，交给模型，模型也只能选登记表里的工具 |
| Operation | 聊天和 MCP 的空间工具进入 `executeGisOperation`，再调用 `SpatialService` |
| Validation | 工具参数按登记表检查。坐标系和单位在 `SpatialService` 里决定是否放行，不另编 EPSG |
| Resolution | 聊天和 MCP 用 `resolveLayerRef`。地图 HTTP 直接使用图层标识。GDL 按图层名用 `findByName` |
| Authorization | `map.delete`、`map.clearAll`、`map.dropDatabase` 必须用户确认。模型参数里的确认值无效 |
| Execution | 矢量叠置在 surtgis。栅格走本机 Python/GDAL。克里金和汇水读当前启用的专业权重。降雨径流、降雨滑坡和地层体调用计算引擎 |
| OperationRecord | `AUDIT_REQUIRED_OPERATIONS` 里的操作写入 `var/operations`。失败也留痕 |

`LayerResolutionResult` 仍只是类型和纯映射，运行路径不读取它。
