# 处理链路

数据面和控制面分开。

数据面顺序：

1. 只读打开磁盘上的矢量源文件。
2. GDAL-WASM 读入矢量。栅格 info、DEM、栅格代数和等高线走外部 Python/osgeo。
3. surtgis 做几何校验、缓冲、相交、裁剪和图层库。
4. 克里金和汇水在 `spatial-ops`，必须先在设置里启用一份本地专业权重。库里可以有多份，这两项只读当前这份。没有启用的权重时返回不可用，不会改用别的算法代替。
5. 降雨径流、降雨滑坡和地层体不在 surtgis 里。它们分别调用 ANUGA、TRIGRS 和 LoopStructural。
6. 导出为新文件。导出路径不得等于源文件路径。

控制面顺序：

1. RAG 检索元数据摘要和知识图谱。
2. 外部 LLM API 产出 function call。
3. 调度层把工具调用交给 `executeGisOperation`，由 `SpatialService` 执行。

控制面消息不携带几何字节。模型看到的是图层摘要、工具名、标量参数和不透明句柄。

V0.79 在云端对话和 MCP 前面加了本地边界：AI Gateway 与翻译层只把 L2 摘要和操作请求送进现有的 `executeGisOperation`。原始文件、坐标、WKT/WKB、栅格、GDAL 数据集和文件系统路径留在空间运行时。origin-gate 仍只挡住跨站网页，不是登录。

GIS 读取在 `@igis/gis-io`：只用 GDAL-WASM。读失败就返回这次失败，不连接别的进程。

空间运算是具名工具，经 `executeGisOperation` 进入 `SpatialService`。矢量叠置在 surtgis。栅格走本机 Python/GDAL。没有矢量 SQL 引擎。

模型调用在 `@igis/llm-dispatch`，提供方是 deepseek、千问、grok 和可选本地模型。发给模型的内容只有标量和不透明句柄。
