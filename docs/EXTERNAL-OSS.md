# 外部开源调用

记录日期：2026-10-18。

这里只记运行时真正调用的外部开源程序。各包 `package.json` 里的模块版本、以及文档里的产品记录，不在这张表里。传递依赖和 Tauri 的全部 Cargo 依赖也不在这里。

协议以该版本包内声明的 `license` 为准。宽松协议可以调用。BSD-3-Clause 必须保留版权声明。Apache-2.0 必须保留声明；若上游带 NOTICE，再分发时要带上。

## 矢量与坐标

| 程序 | 版本 | 协议 | 调用 | 成熟度 |
|---|---|---|---|---|
| `@turf/turf` | 7.2.0 | MIT | `packages/surtgis/src/core/overlay.ts`、`validate.ts`，`packages/spatial-ops/src/ops.ts`、`v093-ops.ts`、`v093-models.ts`。缓冲、相交、裁剪、擦除、联合、点在面内、融合、面积、长度、距离、泰森多边形、折点转点、线交点、分割、简化、有效性、质心 | 这组函数在 Turf 7 里稳定，作为本机矢量运算使用。它不是测量级拓扑引擎。平行偏移 `lineOffset` 在尖角上会交坏，当前代码不调用。路网、核密度、四叉树、格网聚合、热点、地理加权回归和重力模型是本机代码 |
| `proj4` | 2.15.0 | MIT | `packages/surtgis/src/core/crs-transform.ts`。已知坐标系之间的变换 | 成熟。定义里没有 `towgs84` 时不做基准移动；本项目因此拒绝这种变换，不把结果当成已改正 |

## 地图显示

| 程序 | 版本 | 协议 | 调用 | 成熟度 |
|---|---|---|---|---|
| `maplibre-gl` | 6.12.0 | BSD-3-Clause | `apps/desktop/ui/app.js` 创建地图，并按字段做分类设色。脚本从 `node_modules/maplibre-gl/dist` 提供，库文件不入库 | 现行版本，只负责显示，不参与空间运算。样式里没有字形服务，注记由 `apps/desktop/ui/label-placement.js` 在画布上避让后绘制，导出时画进图片。再分发时保留 BSD 版权声明 |

## 读数与栅格

| 程序 | 版本 | 协议 | 调用 | 成熟度 |
|---|---|---|---|---|
| `gdal-js`（内含 GDAL 2.4） | 包 2.2.0；上游 GDAL 2.4 | 包 MIT；GDAL 核心 MIT/X | `packages/gdal-wasm-adapter`。只读打开矢量，wasm 为 `node_modules/gdal-js/gdal.wasm` | 这是 2019 年前后的社区预编译，仓库不再跟随现行 GDAL。未链入 GEOS，不能当成现行 GDAL。只适合这个构建里能打开的只读格式 |
| Python | 3.11.17 | PSF | `var/gdal-python`，由 micromamba 按 `config/gdal-python.lock.json` 创建。二进制不入库 | 现行版本。打开界面不依赖它 |
| GDAL / osgeo | 3.13.3 | MIT | `packages/external-gateway/scripts/gdal-bridge.py`：`vector_make_valid`、`vector_reproject`、`vector_convert_format`、`vector_offset`、`raster_info`、`raster_calc`、`dem_derivative`、`contour`、`raster_cast`、`raster_nodata`、`raster_smooth`、`raster_grid`、`raster_viewshed`、`raster_clip`、`raster_polygonize`、`raster_rasterize`、`raster_zonal`、`raster_resample`、`raster_index`、`raster_focal`、`raster_costCorridor`、`raster_classify`、`raster_kriging`、`raster_watershed`、`raster_profile`、`raster_cut_fill`、`raster_water_level` | 现行 GDAL。`raster_grid` 只用 `invdist`、`nearest`、`linear`。`raster_index` 只做 ndvi、ndwi、savi。桥的标准输入输出使用 UTF-8。环境没建成时这些能力不可用，不把 gdal-js 的旧构建算成同一套 |
| shapely | 2.2.0 | BSD-3-Clause | `vector_offset` 调用 `offset_curve` 生成平行线 | 现行版本。再分发时保留 BSD 版权声明 |
| NumPy | 2.4.6 | BSD-3-Clause | `raster_calc` 的同尺寸运算，`raster_smooth` 的 3×3 均值，`raster_grid` 的留出误差，`raster_focal` 的邻域均值，`raster_index`、`raster_zonal`、`raster_costCorridor`、`raster_classify`，克里金的半变异函数拟合和批量求解，汇水的流向和累积量，剖面和填挖方 | 成熟。再分发时保留 BSD 版权声明 |
| micromamba | 2.0.5 | BSD-3-Clause | `packages/external-gateway/src/gdal-env.ts` 下载并创建上面的前缀。二进制在 `var/micromamba`，不入库 | 作为环境安装器可用。它不计算地理结果 |

## 计算引擎

版本钉在 `config/engines.lock.json`。由 `packages/external-gateway/scripts/engine-bridge.py` 以独立进程调用，不链进 TypeScript。`config/licenses.lock.json` 没有收录这三项，协议以各程序自己的许可证文件为准。

| 程序 | 版本 | 调用 | 说明 |
|---|---|---|---|
| ANUGA | 4.0.1 | `map.rainfallRunoff` | 装在 `var/engines-python`。浅水方程。降雨和模拟不超过 24 小时，高程栅格有空值就拒绝 |
| TRIGRS | 2.1.0 | `map.rainfallLandslide` | 从 USGS 源码编译到 `var/engines`，安装时核对锁文件里的 sha256。无限边坡加一维入渗，不做汇流 |
| LoopStructural | 1.8.2 | `map.geologyModel` | 装在 `var/engines-python`。用界面点和产状建地层体，没有断层 |

## 本机知识库与外部工具协议

| 程序 | 版本 | 协议 | 调用 | 成熟度 |
|---|---|---|---|---|
| `sqlite-wasm-vec` | 0.1.11 | Apache-2.0 | `packages/rag-meta/src/store.ts`。本地 `var/rag/kb.sqlite` 还在。对话、导入和空间运算当前不写入、不检索。等知识库重新规划 | 能完成本地检索。版本号仍是 0.1，接口以后可能变。不是空间分析库 |
| `@modelcontextprotocol/sdk` | 1.18.2 | MIT | `packages/mcp-server` 的 stdio 服务，以及 `packages/external-gateway/src/mcp-adapter.ts` 的可选外部进程 | 这是该协议的参考实现，协议本身仍在改。只传工具调用，不传几何引擎 |

## 窗口

| 程序 | 版本 | 协议 | 调用 | 成熟度 |
|---|---|---|---|---|
| Tauri | 2.12.4 | MIT OR Apache-2.0 | `apps/desktop/src-tauri`。窗口打开 `connect.html`，再进入 `http://127.0.0.1:39221` | 打开本机页面这一用法可用。空间运算不经过 Tauri。Windows 上的页面由系统已安装的 WebView2 绘制；WebView2 不是本仓库调用的开源库 |

## 直接依赖但源码未调用

根 `package.json` 里的 `zod` 3.24.2（MIT）没有被本仓库源码 import。它随 `@modelcontextprotocol/sdk` 使用。
