# GDAL 后端调研结论（V0.88-T2，只读核验）

范围：gdal-mcp（PyPI `gdal-mcp` 1.1.3）与"自研薄封装调 GDAL"路线对比；DXF 驱动与 TIN/水文依赖探测。数据来源：PyPI 元数据、TOOLS.md 工具参考、GDAL 文档面。未实测项已标注。

## 1. gdal-mcp 事实

- 发布：1.1.3（2026-02）；许可 **MIT**；运行时 Python ≥3.11；依赖 Rasterio / PyProj / pyogrio（fiona 回退）/ Shapely / NumPy / FastMCP（均为宽松系，逐包实测锁入 licenses.lock 留待接入时做）。
- 工具面（11 业务 + 反射）：
  - 栅格 5：`raster_info` / `raster_convert` / `raster_reproject` / `raster_stats` / `raster_query`
  - 矢量 7：`vector_info` / `vector_reproject` / `vector_convert` / `vector_clip` / `vector_buffer` / `vector_simplify` / `vector_query`
- 已知局限（其文档自述）：反射只覆盖 reproject 两工具；缓存内存态；矢量工具较新。

## 2. 边界合规判定（对照四契约）

- **输入面不合规直连**：参数含文件路径（`uri`/`output`）、GeoJSON 几何与 bbox（`geometry`/`bounds`/`mask` 路径）、SQL 过滤子句（`where`）——分别踩 FILE_KEYS、坐标通道、注入面三条线。
- **输出面不合规直连**：info 类返回 Bounds（minx/miny/maxx/maxy）+ 仿射变换 + CRS；convert/reproject 返回 ResourceRef（URI/路径/大小）+ 目标 CRS Bounds；query 返回所用几何——**几乎全部输出含坐标范围或路径**。
- 结论：只能作为 External Capability Boundary 后面的处理后端；输出必须逐字段投影（剥 bounds/transform/uri/geometry，只留计数、CRS 名、统计值、成功/失败）；`where` 不透传，映射到安全筛选语义；`geometry` 参数由本地图层解析产生，模型只给图层标识。

## 3. 覆盖面对照（相对 V0.88 需求）

| 需求 | gdal-mcp | 判定 |
|---|---|---|
| 栅格基础 IO（info/convert/reproject/stats） | 有 | 覆盖 |
| 格式转换（shp/gpkg/geojson/kml/gml） | 有 | 覆盖 |
| 重投影 | 有 | 覆盖 |
| MakeValid / 几何修复 | 无 | 需自研薄封装 |
| DEM 衍生（坡度/坡向/晕渲/等高线/栅格代数） | 无 | 需自研薄封装（GDAL DEMProcessing/contour/calc） |
| DXF | 转换表未列（仅 shp/gpkg/geojson/kml/gml 扩展名驱动） | OGR 本体有 DXF 读驱动，覆盖面**待本机实测** |
| 水文 / TIN | 无 | 见 §5 |
| clip/buffer/simplify/query | 有 | 与 V0.87 已有能力重叠，无增量 |

## 4. 路线结论

- **T1 边界照建**：通道设计为通用外部能力通道，后端以适配器接入（MCP 协议适配器 + 本地进程适配器双实现位），满足"可选适配器/单向依赖/能力可下线/上线开关"四条硬约束。
- **T3 能力实现优先自研薄封装**（调 GDAL 的 OGR MakeValid、DEMProcessing、gdal_contour、OGR SQL、OGR DXF）：接口天然按我们契约定义（无路径/坐标入参、输出直接过投影），覆盖面能补上 gdal-mcp 没有的修复/DEM；依赖同为 Python+GDAL，不多引入任何包。
- gdal-mcp 保留为可选后端适配器之一（走 T1 通道），不作为 T3 前置。

## 5. TIN / 水文依赖探测（先不搞，仅记录事实面）

- TIN：scipy.spatial.Delaunay（BSD-3）可做三角剖分；无现成"TIN 构建+三维渲染"完整栈。
- 水文：whitebox（MIT，内嵌 Rust 二进制 whitebox-tools）、pysheds（许可待核）、richdem（**GPL-3，copyleft，许可风险**）。
- 均列入缺口清单，动之前须审批；接入任何一项前必须过 L3 许可实测。

## 6. 未实测项（接入前完成）

1. gdal-mcp 11 业务工具的实际返回样本（确认投影剥离清单）；
2. 依赖逐包许可实测入 `config/licenses.lock.json`；
3. OGR DXF 读驱动在目标 GDAL 发行版的实际覆盖面；
4. DEMProcessing/contour 在该发行版的可用性。
