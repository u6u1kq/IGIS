# 第三方声明

V0.3 引入一个第三方运行时依赖。wasm 随该依赖出现在 `node_modules`，不提交进版本库。没有放入模型权重。

| 名称 | 版本 | 许可证 | 链接方式 | 说明 |
|---|---|---|---|---|
| gdal-js | 2.2.0 | MIT | 直接依赖 | Derek Dohler 的 GDAL WebAssembly 预编译包 |
| GDAL | 2.4 | MIT/X | 编进上述 wasm | 只读打开。该构建的 wasm 写明未启用 GEOS |
| gdal3.js | 未安装 | LGPL-2.1-or-later | 不适用 | 直接链接 LGPL，已拒绝 |
| sqlite-wasm-vec | 0.1.11 | Apache-2.0 | 直接依赖 | SQLite WASM，静态编入 sqlite-vec。wasm 留在 node_modules |
| sqlite-vec | 0.1.7-alpha.2（编入上述 wasm） | MIT 或 Apache-2.0，本仓库按 MIT 使用 | 编进上述 wasm | 向量扩展。没有单独安装原生动态库 |
| @turf/turf | 7.2.0 | MIT | 直接依赖 | 缓冲、相交、裁剪和空间谓词。不手写几何引擎 |
| maplibre-gl | 6.12.0 | BSD-3-Clause | 直接依赖 | 地图画布。ESM 脚本和样式从 node_modules 提供，不把库文件提交进版本库。随附 @maplibre/geojson-vt（ISC）、@maplibre/vt-pbf（MIT）、@maplibre/mlt（MIT 或 Apache-2.0，本仓库按 MIT 使用）、bidi-js（MIT）、require-from-string（MIT） |

`config/licenses.lock.json` 的 `dependencies` 只有通过门禁的项。`gdal3.js` 在 `rejectedCandidates`。

后续再增加依赖时，必须先写入 `config/licenses.lock.json`，并满足：

- 主仓库与正式分发只接受 Apache-2.0、MIT、BSD、X11 等宽松许可证。GDAL 的 MIT / X11 / MIT/X 已允许。wasm 不提交，只在安装依赖后出现于 `node_modules`。
- 直接链接的 GPL、LGPL、AGPL 拒绝入库。独立进程中的 GPL 可执行文件不视为链入本程序。
- qgis-wasm 不在本仓库。若以后做原型，只能放在主分发之外的可选包。
- 地图渲染使用 MapLibre GL JS 6.12.0（BSD-3-Clause），从 node_modules 提供。
- DuckDB 在钉死版本并完成许可证复核之前，不得把二进制放进仓库。

用户数据的版权不因格式转换而改变。本软件不把用户数据用于训练、聚合或再分发。
