# Igis

Igis 是放在本机上的 GIS 工作台。用中文或英语说明要做的处理。句子清楚时，本机直接调用已登记的工具；句子含糊时，才由模型选择工具。计算在本机完成。矢量结果放上地图，栅格产物用句柄接着用，度量结果是数字。模型不写几何。

Igis is a local GIS workspace. Clear sentences run registered tools on this computer. Ambiguous sentences go to the model, which only chooses tools. The model does not write geometry.

当前产品记录是 V0.95。版本沿革在 `docs/VERSION-SUMMARY.md` 和 `docs/dev-log/`。

The current product record is V0.95. The short English version list is `docs/VERSIONS.en.md`.

## 能做什么

- 导入 Shapefile、GeoJSON、GPKG 等矢量，在地图上查看图层、属性和样式。
- 通过对话或 MCP 做缓冲、相交、裁剪、度量、几何变换、字段计算和属性连接。矢量结果是新图层，度量结果是数字摘要。
- 在本机做擦除、联合、路网距离、核密度、平行线、热点、地理加权回归和重力模型。矢量结果是新图层。
- 在本机 Python/GDAL 可用时处理栅格：查看信息、坡度坡向晕渲、代数、等高线、整型转换、NoData、邻域平滑、可视域、监督分类、点插值、地形剖面、填挖方和水面抬高。水面抬高是水面高程减地面高程，得到水深栅格，没有流速，也没有时间。环境没准备好时，这些能力不可用，软件仍然可以打开。
- 安装了本地专业模型权重后，做克里金和汇水分析。权重单独提供，不在版本库里；没有权重时这两项返回不可用。可以在设置里选择 `model.json` 安装，也可以执行 `npx --yes tsx --tsconfig tsconfig.json apps/cli/src/pro-model-install.ts <权重文件>`。
- 窗口是暖色毛玻璃界面。地图栏可以在平面和三维之间切换。三维画面占地图栏，地形、叠加、情景回放、竖向放大和各层开关在右侧资源栏的「三维」里；进入三维时资源栏会展开。可以拖动旋转地形，叠加水深、安全系数或其他栅格，按时刻回放，按登记的顺序和间距画爆炸图，并显示地层体。地形网格由本机接口降采样后交给页面，模型只看到句柄和摘要。
- 安装计算引擎后（设置里的「安装计算引擎」，版本钉在 `config/engines.lock.json`）：`map.rainfallRunoff` 用 ANUGA 算坡面降雨径流，给逐时刻水深、最大流速和水量平衡；`map.rainfallLandslide` 用 TRIGRS 算降雨入渗下的无限边坡安全系数；`map.geologyModel` 用 LoopStructural 从界面点和产状建地层体。一次可以给几个降雨情景，在同一个高程栅格上逐个算，某个失败就停，已完成的保留。曼宁糙率、土体参数、模型深度没写就追问，不填数。高程栅格要是米制投影坐标。ANUGA 的降雨和模拟不超过 24 小时，有空值就拒绝；TRIGRS 要正方形像元，降雨不超过 720 小时，不做汇流。格子较粗时，积水跟着较低的格子，圆形洼地会沿行列伸展。地层界面按所标地层的底面处理；没给高程栅格时，最上面那一层没有厚度。
- 矢量读取只用本机 GDAL-WASM。读失败就返回，不连接 ArcPy 或 QGIS。克里金和汇水必须先安装专业权重。软件不训练，也不导出训练集；设置里的合成样本库不含坐标。
- 句子含糊、有错别字或没写距离时，不在本地猜着执行。没写距离会追问，不会填成 200 米。输入像坐标时，发送前会提醒。
- 删除图层、清空地图和删除数据库需要在界面上确认。

尚未做成的工具记在 `docs/TOOL-GAPS.md`。

## 怎么打开

在 Windows 上，于仓库根目录执行：

```text
start-igis.cmd
```

脚本先启动本机接口 `http://127.0.0.1:39221`，接口健康检查通过后打开窗口。窗口先进入连接页，再进入工作区。

第一次使用先在仓库根目录执行 `npm install`。窗口程序是 `apps/desktop/src-tauri/target/release/igis.exe`。这个文件还不存在时，启动脚本会退出并说明窗口未构建。

也可以只启动接口：

```text
npx --yes tsx --tsconfig tsconfig.json apps/cli/src/desktop-api.ts
```

模型密钥放在环境变量或界面设置中。勾选保存后写入 `config/llm.local.json`，该文件不进入版本库。

## 许可证

自有代码使用 Apache-2.0。运行时调用的外部程序见 `docs/EXTERNAL-OSS.md`。

## 更多说明

- 行为契约：`ARCHITECTURE.md`
- 当前启动链：`docs/ARCHITECTURE-CURRENT.md`
- 配置：`config/README.md`
