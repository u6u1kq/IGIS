# 版本变动总梳理（V0.1 → V0.97.1）

本文件是历史版本的变更总览与文件改动索引。各版本技术细节见 `docs/dev-log/` 对应篇；架构规范见 `ARCHITECTURE.md`。英文版本名录只记版本，见 `docs/VERSIONS.en.md`。

## 留档说明

V0.7x 及更早阶段的内部工作留档（任务审计稿、草稿、迁移笔记、阶段对照等）未按文档规范分类保存，已整体移除；其内容与改动由本索引和 `docs/dev-log/` 对应篇替代说明。需要回溯单份留档的，在内部归档（git 历史）中查。

---

## 未入库版本索引（V0.1 – V0.74，仓库建立之前）

以下版本未以规范形式入库，逐版本的内容与改动见 `docs/dev-log/2026-10-01~10-06` 各篇：

| 版本 | 内容与改动 |
|---|---|
| V0.1 | 项目脚手架：monorepo、包结构、启动链路 |
| V0.2 | 核心链路初版：本地隔离执行 + 模型调度骨架 |
| V0.3 | 工具、RAG、UI 三件套；读取回退模式（fallback）；gdal-js 只读元数据 |
| V0.4 | 界面化（对话/地图面板初版） |
| V0.5 | HTTP 接口层（map-http 起点）、图层操作、缓冲链路 |
| V0.6 / V0.61 | GDL 语言、GIS 内核与图层库（surtgis）、PPT 报告（后于 V0.78-C 移除）、统一错误弹窗 |
| V0.7 | GDL 导入/导出、图层样式/顺序接口、几何逐要素校验 |
| V0.71 | 模型自选（local-mock/deepseek/qwen/grok/自定义）、报告页签、预制数据库（合成样本）、启动脚本 |
| V0.72 | 中文包含匹配与候选列表、助手消息 traces/resultLayers、样式/显隐/顺序同步图层库 |
| V0.73 | MCP 服务器（stdio 暴露 GIS 工具）、对话列表、上一轮/下一轮、回退、用户记忆、文档面板 |
| V0.74 | 空对话修复、双语界面（中/英）、口语归一化（槽位齐则执行，缺则追问） |
| V0.75 | 开发者模式（解析轨迹）、运算耗时 durationMs、预制数据库下载 |

## 入库版本（V0.75-Clean 起，见下）

## V0.75-Clean 基线（e44ebb1 + 368cdde + 7d67d21）

- 主题：工作区基线；本地 HTTP 跨源访问收敛（origin-gate）；OperationRequest 边界检查记录。
- 文件改动：
  - e44ebb1 全仓基线（约 230 文件）：`packages/`（ai-sandbox、duckdb-spatial、experience-*、export-sink、finetune、gdal-wasm-adapter、gdl、gis-io、gis-kernel、gis-tools、io-openfilegdb、license-check、llm-dispatch、map-render、mcp-server、memory-bus、provenance、rag-meta、shared-types、spatial-ops、surtgis）、`apps/`（cli、desktop、web）、`config/`、`workers/`
  - 368cdde：`apps/cli/src/{desktop-api,gdl-http,map-http,origin-gate}.ts` + 安全阶段文档
  - 7d67d21：`docs/TASK-013A-BOUNDARY-CHECK.md`
- 记录：`docs/V075-CLEAN-PHASE*.md`、`docs/SECURITY-PHASE*.md`、`docs/dev-log/2026-10-01~10-06`（v0.1–v0.75 共 15 篇）。

## V0.81 基线（3102c7f）

- 主题：AI 数据边界与执行边界框架基线——ai-boundary（manifest/levels/sandbox）、ai-translation（allowlist/gateway）、executeGisOperation 统一执行边界、workflow-env 隔离执行、检查体系 v077–v081。
- 文件改动（按模块）：
  - 新增包：`packages/ai-boundary/`、`packages/ai-translation/`、`packages/workflow-env/`
  - 核心改造：`packages/spatial-ops/`（crs-policy、execute-gis-operation、operation-attempt、buffer-operation*、layer-resolution、ai-intent）、`packages/llm-dispatch/`（destructive、pending-plan、registry、validate 等）、`packages/mcp-server/`、`packages/surtgis/`（crs-identity、crs-transform）
  - 检查脚本：v077/v078×2/v079/v079b/v080/v081/workflow-env/layer-resolution×2/buffer-operation×2 共 12 个
  - 决策文档：`docs/TASK-013B~025`（13 篇）、LAYER-RESOLUTION 三篇、OPERATION-*、BUFFER-*、GIS-* 矩阵
- 记录：`docs/dev-log/2026-10-11`（v0.76–v0.81 六篇）。

## V0.82 执行上下文隔离（227da64）

- 主题：SpatialService 执行上下文 AsyncLocalStorage 化，修复并发操作审计归属串扰；基线 typecheck 清零。
- 文件改动：`packages/spatial-ops/src/service.ts`、`packages/provenance/src/ambient.d.ts`、`apps/cli/src/desktop-api.ts`、`apps/cli/src/v082-context-check.ts`（新）、v078/v079×2 check 适配。
- 记录：`docs/dev-log/2026-10-11-v0.82-context-isolation.md`；验证：v082-context-check。

## V0.83 CRS/单位框架收口（5b6905d + 6a58a8a）

- 主题：.prj 直读与 EPSG-only 身份、严格基准门（无 towgs84 拒绝）、proj4 WKT 变换对齐工作 CRS、aeqd 伪度平面米制缓冲（实测误差 <0.2%）、导出带 crs、降级三态说明；补记录读回的 crs 字段兼容。
- 文件改动：`packages/surtgis/src/core/{crs-identity,crs-transform,overlay,layer-store}.ts`、`packages/surtgis/src/proj4-ambient.ts`、`packages/spatial-ops/src/{crs-policy,service,operation-attempt}.ts`、`packages/gdal-wasm-adapter/src/vector-geojson.ts`、`apps/cli/src/{v083-crs-check,v083-crs-probe}.ts`（新）、map-http、v077 check 适配。
- 记录：`docs/dev-log/2026-10-11-v0.83-crs-framework.md`。

## V0.84 地图与缓存（91338f4）

- 主题：导入/分析结果自动对准图层（联合定位 fitBounds）、缩放反馈、框选实时矩形、缺 .prj 警告措辞、geometryHash 入库结果缓存、HTTP 强缓存 + UI ETag、LLM 出站审计（var/llm-requests）。
- 文件改动：`apps/desktop/ui/{app.js,app.css,i18n.js}`、`apps/cli/src/{desktop-api,map-http}.ts`、`packages/llm-dispatch/src/http.ts`、`packages/spatial-ops/src/service.ts`、`packages/surtgis/src/core/layer-store.ts`、`apps/cli/src/v084-map-cache-check.ts`（新）。
- 记录：`docs/dev-log/2026-10-11-v0.84-map-cache.md`。

## V0.85 契约框架冻结（79f7707）

- 主题：AI GIS Worker Contract——四契约（Capability/Visibility/Authorization/Audit）+ 法律合规禁止清单 L1–L6 + 数据流 + 能力缺口清单 + 微调对齐；契约代码锚点与一致性验证。
- 文件改动：`ARCHITECTURE.md`（新）、`packages/ai-boundary/src/capability-manifest.ts`（新）、`packages/ai-boundary/src/index.ts`、`apps/cli/src/v085-contract-check.ts`（新）。
- 记录：`docs/dev-log/2026-10-12-v0.85-contract.md`。

## V0.86 契约收口（65b5fbf）

- 主题：16 项修复（A1–A6 功能修复、C1–C5 正确性、L6 免责）+ 授权落地（ApprovalToken 一次性授权、B1 确认门收紧、B2 授权字段剥离、approvalState 入记录）+ 可见面闭环（loop 过 releaseToModel、numbers 扁平收紧）+ 17 个非空间状态变更留痕 + 出站审计 50MB 上限。
- 文件改动（34 个）：`packages/ai-boundary/`（capability-manifest、index）、`packages/ai-translation/src/allowlist.ts`、`packages/llm-dispatch/`（http、loop、pending-plan、registry、package.json）、`packages/spatial-ops/`（adapter、execute-gis-operation、operation-attempt、resolve-layer、service、index）、`packages/surtgis/src/core/overlay.ts`、`packages/workflow-env/src/run.ts`、三端（desktop-api、map-http、gdl-http、turn-rollback、ui×3）、检查（v086-fix/v086-auth/runtime-boundary/architecture 新增 + v079b/workflow-env/v085 适配）。
- 记录：`docs/dev-log/2026-10-12-v0.86-contract-close.md`；验证：typecheck 0、20 check 全过。
- **上传标记**：该历史提交中含一份外审材料（现行版本已移除，不随产品对外）——属"不上传历史"策略的直接原因。

## V0.87 能力补全（cb4e602）

- 主题：12 个新 AI 能力（度量 area/length/distance/nearest、几何 convert/dissolve/merge/simplify、属性 groupStats/reclassify/qualityCheck、格网 splitByGrid），全部走契约登记→执行边界→OperationRecord→check；OperationKind 扩至 22 族、缓存键带全参数。
- 文件改动（20 个）：`packages/llm-dispatch/src/registry.ts`、`packages/ai-boundary/`（capability-manifest、levels）、`packages/ai-translation/src/allowlist.ts`、`packages/provenance/src/spatial-audit.ts`、`packages/spatial-ops/`（ops、service、adapter、execute-gis-operation、operation-attempt、text、index）、`packages/surtgis/`（overlay、index）、`packages/workflow-env/src/run.ts`、`apps/cli/src/{v087-capability-check,architecture-check}.ts`、`ARCHITECTURE.md`、`README.md`。
- 记录：`docs/dev-log/2026-10-12-v0.87-capability.md`；验证：typecheck 0、21 check 全过。

## 文档规范收口（a3bb407 + 193155e + 9adf4db）

- 主题：文档红线落地——移除外审材料与 V0.7x 留档过程件，dev-log 措辞脱水，补 V0.1–V0.74 未入库版本索引。
- 文件改动：docs/ 内删除 29 个留档过程件、`docs/dev-log` 措辞重置、`docs/VERSION-SUMMARY.md` 重拟、开发规则文档化。

## V0.88 外部能力边界与能力补全（4ea1de8 + 0067f17 + 48a9441 + T3b）

- 主题：External Capability Boundary（`packages/external-gateway`，可选适配器/单向依赖/能力可下线/上线开关）；GDAL 薄封装桥（makeValid/reproject/convertFormat + 栅格 info/DEM 衍生/栅格代数/等高线，栅格按 var/rasters 裸文件名引用）；几何构造 5 能力（voronoi/convexHull/minBBox/centroid/bearing）；坐标值报表（本地 CSV）。经度接缝明确不进本版。
- 文件改动：`packages/external-gateway/`（新包 + `scripts/gdal-bridge.py`）、`packages/spatial-ops/`（ops/service/adapter/execute-gis-operation/operation-attempt）、`packages/ai-boundary/`（capability-manifest/levels）、`packages/ai-translation/src/gateway.ts`、`packages/llm-dispatch/src/registry.ts`、`packages/provenance/src/spatial-audit.ts`、检查（v088-boundary/v088-capability 新增 + architecture 适配）。
- 记录：`docs/dev-log/2026-10-13-v0.88-external-capability.md`、`docs/GDAL-BACKEND-PROBE.md`；验证：typecheck 0、23 check 全过。

## V0.89 坐标系兼容、聊天交互与能力补全

- 主题：聊天交互（翻阅不打扰/回到最新按钮/发送后跟随/模型名标签）；坐标系兼容（局部平面身份取代"无效"判定、平面度量与平面构造放行、平面坐标示意显示、DBF 字段编码 UTF-8→GBK→Latin-1 兜底）；能力补全（split 三件、空间聚合、距离矩阵、精确最近距离、GDL QUERY/STATS/MEASURE、字段分级保守默认——字段名可见、敏感字段名黑名单、属性值只出聚合）。
- 文件改动：packages/surtgis/（crs-identity/crs-transform/index）、packages/spatial-ops/（crs-policy/ops/service/adapter/execute-gis-operation/operation-attempt/text）、packages/gdl/（ast/parser/execute/summary/guard）、packages/ai-boundary/（levels/capability-manifest/index）、packages/ai-translation/src/allowlist.ts、packages/llm-dispatch/（registry/aliases）、packages/gdal-wasm-adapter/src/runtime.ts、packages/provenance/src/spatial-audit.ts、pps/cli/src/gdl-http.ts、UI（app.js/index.html/app.css/i18n.js）、检查（v089-check 新增 + v083/v077/v078/v087/v079b 按新契约更新）。
- 记录：docs/dev-log/2026-10-13-v0.89-crs-compat.md；验证：typecheck 0、24 check 全过。

## V0.89.1 审查修复

- 主题：对话范围与回合绑定、失败时写入助手回复、显示用「我：」不入库、地图光标与图层 crsLabel/详情、白名单放行 crsLabel、缺槽失败可续计划与 priorInstruction、running_tools 不入库、量词「两」不当成距离或图层名；现行文档去掉已不存在的报告生成入口。
- 文件改动：`apps/cli/src/{conversations,desktop-api,v079b-boundary-check,review-fix-check}.ts`、`apps/desktop/ui/{app.js,app.css,i18n.js,index.html}`、`packages/llm-dispatch/src/{dispatch-policy,gis-prompt,index,layer-context,local-intent,pending-plan}.ts`、`packages/ai-translation/src/allowlist.ts`、`README.md`、`docs/{ARCHITECTURE-CURRENT,GIS-MUTATION-MAP,SECURITY-CURRENT,VERSION-SUMMARY}.md`。
- 记录：`docs/dev-log/2026-10-13-v0.89.1-review-fixes.md`；验证：typecheck 0、`review-fix-check`。未做浏览器实测，未改 `package.json` 版本号。
- 明确不做：P11 模型工具切换、空间分析页签保留、用户图层文件不重新导入、外部 GDAL 桥不启用。

## V0.89.2 重投影与对话工作区跟进

- 主题：GDAL Python 桥默认启用并提供运行时自检和设置开关；重投影拒绝缺少源 CRS 的输入并使用传统 GIS 轴序；旧图层依据已保存 WKT 恢复平面身份；桌面上传文件进入对话独立目录，地图载入、空间分析和聊天创建图层记录对话归属；删对话时清理相应文件与图层；地图支持拖放文件自动导入和定位。
- 已有能力：模型工具循环已把结构化工具失败回传模型，并在同一工具/参数/错误重复两次后停止（`repeat-failure`，含自检覆盖）。
- T6：新指令执行前自动保存最多 32 个对话检查点（包括待澄清计划状态）；可选择检查点，回退后续轮次及其 GIS/知识库副作用，并把原指令放回输入框供确认重跑。模型请求不拼接完整聊天历史，用户记忆也有数量与摘要长度上限，因此暂不额外压缩不存在的长上下文。
- 未闭环：当前环境 Python 没有 `osgeo`，无法完成 GDAL 真实重投影→EPSG→叠加链实测；不带对话上下文的 MCP 等入口仍使用全局工作区。
- 文件改动与验证：见 `docs/dev-log/2026-10-14-v0.89.2-followup.md`；类型检查通过。

## V0.89.3 解释器、资源树与失败指纹

- 主题：GDAL 解释器可在下一次请求热切换（托管环境或自定义路径，面板值优先于 `IGIS_PYTHON`）；侧栏改为资源树并去掉空间分析表单；失败停止改为规范工具名加错误码；裸栅格名在当前对话工作区可解析，已有 DEM 产物按短名登记且不上图。
- 未闭环：micromamba 2.0.5 能启动，但 conda-forge 求解 python 3.11.11、gdal 3.9.2、numpy 2.1.3 失败，真实 `osgeo` 导入未做。浏览器界面未验证。
- 记录：`docs/dev-log/2026-10-15-v0.89.3.md`。验证：`npm run typecheck` 退出码 0，`llm-dispatch` 自检退出码 0，`v0893-check` 退出码 0。未改 `package.json` 版本号。

## V0.89.4 预览字段、坐标系原文与对话内图层名

- 主题：本地预览补上字段名；局部平面坐标系拒绝缓冲时，原文和 `crs-refused` 交给用户与模型，不再被句中的斜杠改写成文件访问失败；有对话范围时图层名只在该范围内解析，空范围不回退到整个图层库；资源树改为地图旁边的侧栏。
- 未做：「先处理再缓冲」不另做分类引擎。micromamba 求解与真实 osgeo 仍未验证。重复失败规则未改。浏览器界面未验证。
- 记录：`docs/dev-log/2026-10-15-v0.89.4.md`。验证：`npm run typecheck` 退出码 0，`v0894-check` 退出码 0，`v0893-check` 退出码 0。未改 `package.json` 版本号。

## V0.89.5 平面米制运算、出站几何与目录包

- 主题：已声明投影且单位为米时，缓冲和裁剪在该平面计算；坐标系拒绝且文本里有 EPSG 代码时先重投影再对新图层运算；普通几何和坐标仅在使用者声明后进入模型；启动检查 Node、tsx、地图库、wasm 和 osgeo；目录包脚本输出 `dist/igis-win`。
- 记录：`docs/dev-log/2026-10-15-v0.89.5.md`。验证：`npm run typecheck` 退出码 0，`v0895-check`、`v0894-check`、`v089-check`、`v083-crs-check` 和工具循环自检退出码 0。托管环境 `from osgeo import gdal` 已通过。浏览器界面未验证。未改 `package.json` 版本号。

## V0.89.2 至 V0.89.6

- 总览：`docs/dev-log/2026-10-15-v0.89.2-to-v0.89.6.md`。

## V0.89.6 清理未接入启动链的空包

- 主题：删除 DuckDB、map-render、ai-sandbox、export-sink、memory-bus、experience-log、experience-synth、experience-kg、workflow-env，以及 `apps/web`、`workers`、Tauri 外壳、命令目录入口和读取演示。`KgHit` 改到 `shared-types`。`surtgis` 去掉没有函数体的栅格声明，矢量 `core` 保留。
- 记录：`docs/dev-log/2026-10-15-v0.89.6.md`。未改 `package.json` 版本号。浏览器未验证。

## V0.89.7 侧栏、换行与新对话引导

- 启动仍打开系统浏览器。Electron 窗口未接入。
- 资源栏默认收起。图层名在框内换行，坐标系说明只在预览。环境检查失败不再弹出「读不到模型配置」。空对话第一条是欢迎引导，不写入对话文件。
- 记录：`docs/dev-log/2026-10-15-v0.89.7.md`。浏览器未验证。

## V0.89.8 未声明距离、折点转点、环境句子与对话图层

- 两个图层都未声明坐标系时，距离、最近距离、距离矩阵和精确最近按坐标原值计算，并写明不是米。一边有坐标系、一边没有仍拒绝。
- `map.vertices` 把面或线的节点变成点图层。
- 环境检查的 `summary` 只写未通过项和对应处理。开发启动不把缺少的仓库内 tsx 当成故障。
- 切换对话时按服务器上该对话的图层编号挂载地图。
- `start-igis.cmd` 打开 `apps/desktop/src-tauri/target/release/igis.exe`，窗口加载本机页面。目录包启动脚本仍打开系统浏览器。
- 记录：`docs/dev-log/2026-10-16-v0.89.8.md`。浏览器未验证。未改 `package.json` 版本号。

## V0.89f 窗口地址与目录包

- 窗口地址是 `http://127.0.0.1:39221/connect.html`。本机接口提供这个页面。`/api/health` 的 `ok` 为 true 时进入 `http://127.0.0.1:39221/`。
- 已核对：`/connect.html` 与 `/` 返回页面，`/api/health` 返回 `{"ok":true,"port":39221}`。打开 `igis.exe` 后，WebView2 与 `127.0.0.1:39221` 建立了连接。
- `package-win.ts` 把 `target/release/igis.exe` 复制为 `dist/igis-win/igis.exe`。包内启动脚本打开这个文件。
- 记录：`docs/dev-log/2026-10-16-v0.89f.md`。未改 `package.json` 版本号。

## V0.91 字段、连接、栅格和插值

- `map.calculateField` 用已有字段和常数做加减乘除、比较和 `if`。`map.join` 按字段等值做内连接，几何来自第一个图层。
- `map.rasterCast`、`map.rasterNoData`、`map.rasterSmooth` 和 `map.interpolate` 走现有 Python/GDAL 桥。插值只做 `invdist`、`nearest`、`linear`，并留出一部分点计算均方根误差和平均绝对误差。
- `README.md` 只介绍软件。版本沿革留在本文件和 `docs/dev-log/`。
- 记录：`docs/dev-log/2026-10-16-v0.91.md`。未改 `package.json` 版本号。浏览器未验证。

## V0.91.1 窗口接收文件拖放

- Windows 窗口不再拦截系统文件拖放，地图和导入框可以收到拖入的文件。
- 记录：`docs/dev-log/2026-10-16-v0.91.1.md`。未改 `package.json` 与窗口模块的 `0.3.0`。

## V0.92 英语界面

- 还没保存过语言时，跟着操作系统。英语系统第一次打开是英语界面。已经保存的选择不变。
- 导入、设置和 GDL 对话框走中英文字表。语言为英语时，坐标系拒绝、工具结果句、导入失败句，以及给模型的系统提示和工具说明用英语。本地意图认得 buffer、intersect、clip。
- 记录：`docs/dev-log/2026-10-16-v0.92.md`。未改 `package.json` 与窗口模块的 `0.3.0`。

## V0.93.1 分析工具

- 矢量增加擦除、面联合、按位置连接、四叉树、高斯核密度、格网计数和直方图。EPSG:4326 的核密度按米，`_density` 是每平方公里的点数。
- 路网在本机建图。点落到边上并切开该边。沿路距离和服务范围在 EPSG:4326 下用米。平行线用 shapely 的 `offset_curve`，地理坐标拒绝。
- 栅格增加可视域、按面裁剪、栅格转面、面转栅格、按面统计、重采样、ndvi/ndwi/savi、3/5/7 邻域均值、最小费用走廊和监督分类。指数不接受自定义公式。
- 增加 Getis-Ord Gi*、地理加权回归、双约束重力模型、k 匿名四叉树和差分隐私格网计数。
- `map.style` 可以按一个字段分类设色，并用一个字段做注记。注记在画布上避让。`map.exportMap` 把当前视图、注记、图例和比例尺导出成图片。
- 桥的标准输入输出使用 UTF-8。记录：`docs/dev-log/2026-10-17-v0.93.1.md`。未改 `package.json` 与窗口模块的 `0.3.0`。桌面窗口里的注记没有在浏览器里点过。

## V0.93.2 本地专业模型

- 权重文件 `var/models/igis-pro/model.json` 单独提供，不入库，由 `apps/cli/src/pro-model-install.ts` 校验后安装。没有权重时克里金和汇水分析返回不可用，工具仍在登记表里。
- `map.kriging`：普通克里金，半变异函数从权重里的归一化先验出发，用这次的点拟合，结果附留一交叉验证误差和方差栅格。
- `map.watershed`：Priority-Flood 填洼、D8 流向、出水口捕捉，河道阈值和捕捉半径来自权重。流域面载入地图。
- `map.profile` 沿线采样 DEM，`map.cutFill` 计算两个高程面之间的填挖方。这两项不用权重。
- 记录：`docs/dev-log/2026-10-17-v0.93.2.md`。未改 `package.json` 与窗口模块的 `0.3.0`。

## V0.93.3 语言识别隔离

- 本地只执行没有歧义的句子。句中没写距离就追问。200 只来自用户写出的数字，不再当作空槽填充；原先那个 200 是早期测试句直接写进解析器的遗留。整句里还有对不上的词时，原文交给模型。
- 「这张图」在干净句子里指当前选中图层；含糊句由模型按这个规则处理。
- 思考里给出本机判断：是否本地执行、是否缺参数。含坐标的推理不显示。输入像坐标时，发送前先提醒，不改原文。
- 坐标系拒绝先说明原因。目标代码没定就问。重投影失败，或重投影后再失败一次，就停止。栅格本身要改时不调用只接受图层的重投影。同一工具同一错误出现两次就停止，不改参数。
- 记录：`docs/dev-log/2026-10-17-v0.93.3.md`。未改 `package.json` 与窗口模块的 `0.3.0`。

## V0.94.1 三维页、水面抬高和输入登记

- 地图栏增加平面 / 三维。三维页留在原来的地图栏里，左侧对话、输入框和模型按钮仍在。这一页只接收当前对话的图层标识和栅格句柄。
- `map.waterLevel` 用已有高程栅格做水面高程减地面高程，水深栅格回到平面图能接着用的句柄。没有流速，也没有时间。水位没写就追问。
- `map.layerStack` 只登记从下到上的图层顺序和层间竖向间距。少于两层时不登记，也不出图。
- `map.geologyInputs` 只核对界面点、界面字段、倾角和倾向。缺了就问。不生成地层体。
- 设置里显示 GDAL 开或关，以及专业权重未安装或已安装的名称。选择一个 `model.json` 即可安装。
- 知识库、文档和审计收进「记录」。
- 记录：`docs/dev-log/2026-10-17-v0.94.1.md`。未改 `package.json` 与窗口模块的 `0.3.0`。

## V0.94.2 三维地形、降雨情景和地层体

- 三维页画出可旋转的地形。可以叠加水深、安全系数或其他栅格句柄，按时刻回放情景，竖向放大，地形、叠加、爆炸图、地层体分别开关。爆炸图按 `map.layerStack` 登记的顺序和间距画。平面图保留。
- 地形网格由本机接口按句柄或情景读出并降采样到不超过 160 格交给页面，不经过模型。登记文件只存栅格名和句柄，不存坐标或路径。
- `map.rainfallRunoff`：ANUGA 浅水方程。曼宁糙率和降雨情景必须给。默认 4 个输出时刻、水深统计下限 0.01 米、模拟时长等于降雨历时、四周自由出流，默认值写在回复里。封闭边界下雨量和存水相等。高程栅格超过 4096 格时按整数倍取平均变粗，有空值就拒绝，降雨和模拟时长都不超过 24 小时。格子较粗时，积水跟着较低的格子，圆形洼地会沿行列伸展。
- `map.rainfallLandslide`：TRIGRS 无限边坡加一维入渗，饱和模型。黏聚力、内摩擦角、重度、扩散系数、饱和渗透系数、土层厚度、初始地下水位埋深都要用户给。初始入渗率不给时按 0 并说明。不做径流汇流。像元必须是正方形。降雨时长不超过 720 小时。
- `map.geologyModel`：LoopStructural 隐式建模，用 `map.geologyInputs` 登记的界面点和产状。界面点按所标地层的底面处理，没有断层。给了高程栅格时，地面以上部分削掉。没给高程栅格时，模型顶面就是最高的界面点，最上面那一层没有厚度。向下延伸的深度没写就问。
- 几个降雨情景用 `30x2;60x1` 这样写，在同一个高程栅格上逐个算。某个失败就停，已完成的保留，后面的不算。再次计算时情景编号接着往下排，旧句柄不被覆盖。
- 设置里显示计算引擎是否可用，可以一键安装：ANUGA 和 LoopStructural 装进 `var/engines-python`，TRIGRS 从 USGS 2.1.0 源码（核对 sha256）编译到 `var/engines`。版本见 `config/engines.lock.json`。
- 记录：`docs/dev-log/2026-10-17-v0.94.2.md`。未改 `package.json` 与窗口模块的 `0.3.0`。

## V0.95 界面和项目整理

- 窗口换成暖色毛玻璃。三维控制从地图栏挪到资源栏的「三维」分组。进入三维时资源栏展开，平面图背景改为暖色。
- 处理链路按实际代码重写：surtgis 只做几何校验、缓冲、相交、裁剪和图层库。克里金和汇水在 `spatial-ops`，必须先安装专业权重。降雨径流、降雨滑坡和地层体分别调用 ANUGA、TRIGRS 和 LoopStructural。调度进入 `executeGisOperation` 和 `SpatialService`。
- 矢量读取只保留 GDAL-WASM。ArcPy / QGIS 的 TCP 回退、`config/gis-io.json` 和 `packages/license-check` 已删除。已审查的依赖仍在 `config/licenses.lock.json`。
- `packages/finetune` 只保留本机合成样本库。远期微调标记和空的隐私审查接口已去掉。不训练，不导出训练集。
- 记录：`docs/dev-log/2026-10-18-v0.95.md`。未改 `package.json` 与窗口模块的 `0.3.0`。

## V0.95.1 权重切换、训练数据索引和多图层导入

- 专业权重可以安装多份，放在 `var/models/igis-pro/slots/`。设置里选择一份后，写入 `model.json`。克里金和汇水只读这一份。同名再次安装会替换那一份，其他份保留。
- 用户说「打包训练数据」时，本机先做索引再交给模型。索引只有种类、相对名称、文件是否写明米制投影、文件里写明的 EPSG、要素数量、数值字段名，以及 outlet 是否从 1 连续。没有坐标、范围、高程或绝对路径。模型整理 `training.json` 时键必须是 `field` 和 `streams`。不运行 `train.py`，不编造 EPSG 或出水口编号，实验权重不算可发布。
- 导入可以一次带上多个图层和配套文件。缺 `.shx`、`.dbf` 或 `.mid` 的图层单独说明，不挡住其他齐全的图层。齐全的面图层用已有的图层合并合成一个面图层。坐标系没写明时不猜测，合并不了就仍然分开载入。单次上限仍是 128 MB。
- 记录：`docs/dev-log/2026-10-18-v0.95.1.md`。未改 `package.json` 与窗口模块的 `0.3.0`。

## V0.96 出站代词和大图汇水

- 发给模型的文字里，坐标串换成「这些点」，绝对路径和数据文件名换成「当前图层」。任务句子留下。整段消息不再因为出现这些字样就被删掉。坐标数字仍然不发送。
- 汇水去掉 100 万像元上限。Priority-Flood 和 D8 不变，高程和关闭标记留在数组里。小范围的填洼结果与原先一致。费用栅格仍超过 100 万像元就拒绝。
- 记录：`docs/dev-log/2026-10-18-v0.96.md`。未改 `package.json` 与窗口模块的 `0.3.0`。训练数据和权重不在本仓库。

## V0.96.1 按整句理解需求

- 模型先写清三件事再决定是否调用工具：用户要的结果、用到 `mapLayers` 里哪一层、登记表里有没有对应工具。用不到图层和工具时直接回答。
- 本地只匹配已经载入的图层名。没载入的词不再被猜成图层名。
- 选择文件上传的单次上限从 128 MB 改为 1 GB。本机绝对路径导入不走这道上限。
- 记录：`docs/dev-log/2026-10-19-v0.96.1.md`。未改 `package.json` 与窗口模块的 `0.3.0`。

## V0.96.2 出站选择和下一轮工具结果

- 识别先交给模型。只有用户确认过的计划在本地执行。删除确认之后，原句里删除后面的要求继续交给模型，不把这一轮停在删除上。
- 云端模型发出去之前，在对话里警告。仍然发送会把这句话，以及这一轮工具结果里的坐标和路径，一起发给模型，并记在这个对话上。下一轮把上一轮工具结果继续附上，模型不用再要一次坐标。不发送也会发出这句话，坐标收成「这些点」，路径收成「当前图层」。
- 出站判断和实际替换是同一套规则，警告里给出替换后的句子。经纬度小数、带「经度」「纬度」的数字、绝对路径和数据文件名都按这套规则处理。密钥去掉。外壳和脚本不发送。本机模型不警告，坐标留在本机。
- 很大的坐标数组只保留开头一段和数量，避免整幅图进模型。
- 记录：`docs/dev-log/2026-10-19-v0.96.2.md`。未改 `package.json` 与窗口模块的 `0.3.0`。

## V0.97 一条对话一份数据

- 一条对话自己保存记录、矢量图层、上传文件、栅格和三维场景。矢量图层写在 `var/conversation-workspaces/<对话编号>/layers`。桌面、地图接口、GDL 和 MCP 都打开这条对话的目录。没有对话编号的地图和 GDL 操作会拒绝。
- 删掉对话时，对话记录和它的工作区一起删掉，平面地图和三维都在里面。进程不再读取 `var/map-layers`。
- 地图只画这条对话登记的图层。刷新时不再把别处没人认领的图层挂上来。导入之后按这条对话的名单重画。
- 模型下一句读到的上下文是这条对话已经存下的来回记录。设置里的用户记忆仍只是整份程序共用的偏好。
- 记录：`docs/dev-log/2026-10-19-v0.97.md`。未改 `package.json` 与窗口模块的 `0.3.0`。

## V0.97.1 智能体规则和现行文档

- 智能体规则模块在 `packages/ai-boundary/src/assist/`。规范引导集中写给模型的工作方式。隔离规则目前只有两条：不读取、不转发用户的 API 密钥；不跳过用户直接读取系统内的存储文件。打开文件由用户在界面完成。
- 去掉原先散落的几何、路径和 WKT 改写：模型载荷、工具结果、计划、进度、审计、文件名和外部返回不再因为像几何就被丢掉或换成代词。对话里的出站警告，以及设置里的「完全不挡」「允许发送几何」，已经从界面移除。
- 空间运算和 GDL 载入不再把摘要写入知识库。对话不再在回答前检索知识库。导入、GDL 和图层菜单上的写入入口已去掉。`var/rag` 和文档、知识库接口还留着，等知识库重新规划。`map.dropDatabase` 不再清空那张表。
- 合成样本库不再生成或下载。`packages/finetune` 的准备、追加和读取直接失败。
- 统计字段名若是 `x`、`y`、`lat`、`lon`、经度、纬度等坐标列名，只返回要素个数。这是统计函数自己的规则。
- 桌面和 MCP 只在 `apps/cli/src/gis-runtime.ts` 把查询、空间运算、GDL、账本和外部进程装到一起。生产代码注释里的旧版本号已去掉。检查脚本和 `docs/dev-log/` 仍按原版本留档。
- 记录：`docs/dev-log/2026-10-20-v0.97.1.md`。根 `package.json` 的版本是 `0.97.1`。窗口模块仍是 `0.3.0`。
