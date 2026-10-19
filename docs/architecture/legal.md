# 法律与数据约束

- 自有代码使用 Apache-2.0。
- `.gdb` 只用 OpenFileGDB 只读打开。不写回 gdb / aprx，不做 ArcGIS Add-in。
- 矢量只读使用 npm 上的 `gdal-js@2.2.0`（MIT），其中 GDAL 2.4 为 MIT/X，且未启用 GEOS。wasm 留在 `node_modules`，不提交进版本库。`gdal3.js` 是 LGPL，没有安装。栅格和计算引擎使用本机 Python。
- 不使用 qgis-wasm。直接链接的 GPL、LGPL、AGPL 不进入本仓库。
- 地图渲染使用 MapLibre GL JS（BSD-3-Clause）。
- 向量库文件仍可在本机 `var/rag`。对话当前不检索它。原始几何可以留在对话图层里，也可以出现在发给模型的工具结果里。
- 用户数据在本机处理。云端模型收到的是这一轮对话内容。处理文件留在该对话的工作区。
- 来源账本记录源文件 SHA-256、只读标记、导出路径和图层名。账本可以记下几何字段。
- 不运行训练程序，不连接 OSM。用户要求打包训练数据时，根据本机索引整理 `training.json`。合成样本库已从产品拿掉。
- 云端嵌入默认关闭。高级用户可在 `config/retrieval.json` 把 `cloudEnabled` 设为 `true`。
