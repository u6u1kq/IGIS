# 当前测试

没有正式测试框架。根 `package.json` 的 `scripts` 只有 `typecheck` 和 `mcp`。没有 Jest、Vitest、Mocha，也没有 `*.test.ts` / `*.spec.ts`。下面的脚本要人手执行，导入它们不会自动跑。

```text
npx --yes -p typescript@5 tsc -p tsconfig.json --noEmit
npx --yes tsx --tsconfig tsconfig.json apps/cli/src/<脚本>.ts
```

更新本文时没有重跑整套检查。2026-10-18 写 V0.95.1 时跑过类型检查和 `v0951-check.ts`，当时通过。其余脚本的上次结果不在这里重写。

`apps/cli/src/*-check.ts` 是检查脚本。多数使用系统临时目录，不监听桌面端口。`v0942-check.ts` 需要已经安装的计算引擎。`v084-map-cache-check.ts` 会写仓库 `var/llm-requests`。

| 文件 | 检查什么 |
| --- | --- |
| `architecture-check.ts` | `ARCHITECTURE.md` 四契约标题还在；留痕清单与操作记录字段对齐 |
| `v085-contract-check.ts` | 能力清单覆盖工具注册表，禁见键会被投影剥掉 |
| `v086-auth-check.ts` | 一次性授权、确认门、授权字段不进可见面 |
| `v086-fix-check.ts` | V0.86 修复批，含结果免责文案 |
| `runtime-boundary-check.ts` | 非空间变更写入操作记录，破坏性操作带授权状态 |
| `v077-consistency-check.ts` | 坐标系、缓存、查询类型、自相交和派生来源 |
| `v078-operation-check.ts` | 操作记录、执行边界和回退 |
| `v078-correction-check.ts` | 翻译层、本地坐标系变换、破坏性确认 |
| `v079-boundary-check.ts` | 数据边界 |
| `v079b-boundary-check.ts` | 数据边界实现 |
| `v082-context-check.ts` | 并发时审计归属和 callerCrs 不串线 |
| `v083-crs-check.ts` | `.prj`、EPSG 变换、基准门、米制缓冲 |
| `v084-map-cache-check.ts` | 几何哈希、缓存、出站审计日志 |
| `v087-capability-check.ts` | 度量、几何转换、融合、属性和分幅 |
| `v088-boundary-check.ts` | 外部能力边界拒绝路径和几何 |
| `v088-capability-check.ts` | 泰森多边形、凸包、最小矩形、质心、方位、坐标报表 |
| `v089-check.ts` | 平面坐标系、分割、空间聚合、距离矩阵 |
| `v0893-check.ts` | 解释器切换、裸栅格名、对话工作区 |
| `v0894-check.ts` | 坐标系拒绝原文、对话内图层名 |
| `v0895-check.ts` | 米制投影上的缓冲；无投影的局部坐标拒绝 |
| `v0898-check.ts` | 未声明坐标系的距离、折点转点 |
| `v0899-check.ts` | 线交点、原坐标变换、垂足、格网 |
| `v091-check.ts` | 字段计算、属性连接、栅格整型、NoData、平滑、点插值 |
| `v092-check.ts` | 英语界面的本地意图、系统提示、坐标系拒绝句 |
| `v093-check.ts` | 擦除、联合、按位置连接、四叉树、核密度、路网、统计图 |
| `v093-gdal-check.ts` | 平行线、费用走廊、分类，以及可视域等栅格工具 |
| `v093-model-check.ts` | 注记避让、热点、地理加权回归、重力模型、k 匿名、差分隐私 |
| `v0932-check.ts` | 没有权重时克里金和汇水不可用；装上测试权重后跑通 |
| `v0932-grok-check.ts` | 克里金、汇水、剖面、填挖方的对照 |
| `v0933-check.ts` | 含糊句交给模型；缺距离不填 200 米 |
| `v0941-check.ts` | 水面抬高、爆炸图登记、地层输入、三维页载荷、权重安装 |
| `v0942-check.ts` | 降雨径流、降雨滑坡、地层体、三维页载荷、引擎锁 |
| `v0951-check.ts` | 权重切换、训练数据索引不含坐标、同一 EPSG 的两个面能合并 |
| `buffer-operation-check.ts` | 缓冲请求的输入映射，不执行缓冲 |
| `buffer-operation-validate-check.ts` | 缓冲请求的结构验证，不执行缓冲 |
| `layer-resolution-check.ts` | 图层解析结果的形状，不查找图层 |
| `layer-resolution-adapt-check.ts` | 把构造好的查找结果交给适配，不读图层库 |
| `review-fix-check.ts` | 对话范围、量词「两」、crsLabel 白名单 |

另外还有四份早期评估，会写 `var/tmp`，本次没有运行：

| 文件 | 检查什么 |
| --- | --- |
| `v075-eval.ts` | 本地计划、图层运算和回退 |
| `chat-ux-eval.ts` | 对话删除与流式事件 |
| `pending-plan-eval.ts` | Pending Plan |
| `ai-eval.ts` | 本地 mock、`resolveChatPlan`、调度自检和空间栈 |

包内自检不是 npm script：`packages/llm-dispatch/src/self-check.ts`、`packages/gdal-wasm-adapter/src/self-check.ts`、`packages/provenance/src/self-check.ts`。GDAL 自检会改写调用方传入的目录，不要指向某条对话的 `layers` 目录。来源账本的持久化自检会写传入目录，不要指向 `var/provenance`。

`environment-check.ts` 是启动时的环境报告（Node、tsx、Python），不是一套通过或失败的用例。

以前记在 `var/tmp` 里的页面冒烟脚本不在版本库中。本文不再把它们列成当前测试。
