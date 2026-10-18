# 法律与数据约束

- 自有代码使用 Apache-2.0。
- `.gdb` 只用 OpenFileGDB 只读打开。不写回 gdb / aprx，不做 ArcGIS Add-in。
- 矢量只读使用 npm 上的 `gdal-js@2.2.0`（MIT），其中 GDAL 2.4 为 MIT/X，且未启用 GEOS。wasm 留在 `node_modules`，不提交进版本库。`gdal3.js` 是 LGPL，没有安装。栅格和计算引擎使用本机 Python。
- 不使用 qgis-wasm。直接链接的 GPL、LGPL、AGPL 不进入本仓库。
- 地图渲染使用 MapLibre GL JS（BSD-3-Clause）。
- 向量库只保存元数据摘要。原始几何不入库，也不进入模型上下文。
- 用户数据只在本地内存中处理，不进入云端 RAG 或训练。处理结束后不保留用户数据副本。
- 来源账本记录源文件 SHA-256、只读标记、导出路径和图层名。几何坐标不进入账本。
- 不训练，不导出训练集，不连接 OSM。合成样本库若使用，不能含坐标，也不能嵌入 OSM 几何。
- 云端嵌入默认关闭。高级用户可在 `config/retrieval.json` 把 `cloudEnabled` 设为 `true`。
