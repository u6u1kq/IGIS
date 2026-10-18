# 行为契约

本文是 Igis 的**契约规范**：AI 作为 GIS 工作者的能力、可见面、授权、留痕四条契约，以及法律合规禁止清单。四条契约从 V0.85 写下，V0.86 收口授权和留痕。能力清单和留痕清单后来加长了，以代码里的常量为准。
开发规范见 `docs/DEVELOPMENT-RULES.md`。本文是能力、可见面、授权和留痕的契约，也是审计基准。架构总览与版本历史见 `README.md`，版本过程记录见 `docs/dev-log/`。

**一句话**：AI 像一个真正的 GIS 工作者一样工作——能看到业务语义、能组合操作、能检查结果迭代；但权限、数据边界和审计永远由 Runtime 掌握。

---

## 数据流（正式链路）

```text
User
  ↓
Chat / Map / GDL / MCP
  ↓
AI Model / Local Parser
  ↓
AI Translation Layer（projectForModel / releaseToModel / ai-boundary，唯一 AI/GIS 数据边界）
  ↓
AI Intent / OperationRequest
  ↓
Authorization（destructive 时：PendingOperation → 用户确认 → ApprovalToken）
  ↓
executeGisOperation（唯一生产执行入口，写 OperationRecord）
  ↓
GIS Runtime（SpatialService / LayerStore / Cache / CRS）
  ↓
SurtGIS（矢量叠置 / proj4）· Python/GDAL（栅格）· 当前启用的专业权重（克里金、汇水）· 计算引擎（降雨径流、降雨滑坡、地层体）
  ↓
GIS Data（var/map-layers 等本地存储）
  ↓
Result Projection（语义摘要）→ AI
```

**铁律**：以后所有新功能必须进入这条链；不得产生第二套执行器、缓存、LayerStore 或 OperationRecord。

---

## 契约一：Capability（能力）

- AI 只能调用 `packages/ai-boundary/src/capability-manifest.ts` 的 `CAPABILITY_MANIFEST` 登记的能力。项数以这份清单为准。V0.85 记下的 22 项只是当时的登记；现在还包括度量、几何转换、属性、格网、栅格、克里金、汇水、降雨径流、降雨滑坡和地层体。`map.exportMap` 在清单里，`audited` 为 false，不在留痕操作清单中。
- **组合能力**：AI 可以把多个操作串成计划、查看结果摘要后继续下一步（`composable`）；每一步独立过执行边界与记录。
- **新能力入契约流程**（必须按序）：① 登记 CAPABILITY_MANIFEST（族/危险等级/授权要求）→ ② SpatialService 方法 → ③ OperationKind → ④ 注册表 → ⑤ Visibility 投影适配 → ⑥ check 更新。
- 新能力必须先登记再实现，不能绕过契约。

## 契约二：Visibility（可见面）

- AI **能看到**（语义投影）：图层 id/名称、几何类型、要素数、字段 schema、统计摘要（min/max/mean/count）、可用操作、操作结果摘要、CRS 标签与降级原因、审批请求文案。`crsKind` 和能证明时的长度单位也在图层摘要里。
- 默认看不到坐标、GeoJSON/WKT/WKB、bbox/extent、本地路径、栅格像素和文件系统信息。禁见键是 `VISIBILITY_FORBIDDEN_KEYS`。设置里勾选「允许把普通工程数据的几何和坐标发给模型」后，普通坐标可以进入这一轮模型上下文；路径、范围，以及已标密、控制点、转换参数和要害设施点位仍然不发送。
- 数字（统计摘要）允许，但数字数组不得递归嵌套坐标结构。
- Translation Layer 是唯一边界：模型可见的每一条数据都经 `projectForModel`/`releaseToModel`（含 gateway manifest 二次校验）；禁止任何生产路径把 GIS 原始对象直接交给 AI。

## 契约三：Authorization（授权）

- 只读与分析操作直接执行；**destructive 操作（map.delete / map.clearAll / map.dropDatabase）必须用户授权**。
- 生命周期（V0.86 落地）：

```text
AI Intent（不含任何授权字段）
  → PendingOperation（系统生成，绑定操作与上下文）
  → 用户确认（UI/chat 确认）
  → ApprovalToken（一次性，用后作废）
  → executeGisOperation
```

- **AI 永远不能产生授权**：`confirm`/`userConfirmed` 等字段从 AI schema 剥离（`AUTHORIZATION_FORBIDDEN_INTENT_FIELDS`）；args 里的确认值一律无效。
- 对话/计划恢复不得恢复旧授权；授权失效后不可复用。

## 契约四：Audit（留痕）

- 一切改变 GIS 状态的操作必须产生 OperationRecord，至少回答：谁/何时/从哪入口/做了什么/作用于什么/产生什么/删了什么/是否需授权/谁授权/是否 AI 发起/是否成功。
- 字段基准：`AUDIT_REQUIRED_FIELDS`（operationId/action/entry/source/aiOrigin/requestSource/inputResources/outputResources/approvalState/executionEnvironment/crs/sideEffects/outcome/createdAt）。记录里的物理字段别名：`createdAt`≈`startedAt`、`executionEnvironment`≈`entry`+`requestSource`；`crs` 仅空间运算记录。
- 覆盖操作以 `AUDIT_REQUIRED_OPERATIONS` 为准。V0.86 先记下五类空间操作和 load、delete、rename、export、import。后来的度量、几何、栅格、克里金、汇水、降雨和地层体也在这份清单里。失败操作同样留痕；回退（rollbackOperation）是记录的一部分。非空间变更经 `recordNonSpatialOperation` 写同一份 var/operations（V0.86 落地，schema 增量兼容旧记录）。

---

## 法律与合规禁止清单

| # | 禁止内容 | 依据类型 | 现有技术措施 | 状态 |
|---|---|---|---|---|
| L1 | **坐标/几何数据默认不得进入 AI 模型通道**（含云端模型出站请求体） | 测绘成果保密与数据出境合规（坐标属敏感地理信息） | 默认 L2 语义投影（ai-boundary/ai-translation）+ 出站审计 var/llm-requests（去查询串防密钥）。设置允许普通工程几何时，只放行普通坐标 | ✅ 默认禁止；普通几何需用户勾选 |
| L2 | **AI 不得伪造授权**、不得自行确认破坏性操作、不得绕过审计 | 产品安全与责任归属 | destructive 运行时门控 + OperationRecord；ApprovalToken 一次性授权（V0.86 落地：生成→同步消费→approvalState 入记录） | ✅ V0.86 已实现 |
| L3 | **依赖库必须是允许商用的宽松许可**，禁止 GPL/LGPL/AGPL 直接链接 | 开源协议与商业化许可 | 已审查的依赖记在 `config/licenses.lock.json` | ✅ 已记录 |
| L4 | **用户数据归属用户**，系统只在本地 var/ 存储，不外传；`cloudEnabled=false` | 数据产权 | 本地存储 + RAG 禁云端嵌入 | ✅ 已实现 |
| L5 | **教材/第三方数据仅限测试**，不得作为产品数据商用（《地理信息系统基础实验操作100例》版权属教材方） | 数据产权 | 测试数据不入库（test/ 与 %TEMP%），用户自行保管 | ✅ 约定 |
| L6 | **AI 分析结果须附"仅供参考/需人工复核"告知**，不得作为决策终稿 | 结果责任 | 聊天结果带免责声明（UI + analysisNote，V0.86 落地） | ✅ V0.86 已实现 |

**依赖许可**（版本以根 `package.json` 为准）：

| 依赖 | 版本 | 许可 | 商用 |
|---|---|---|---|
| @modelcontextprotocol/sdk | ^1.18.2 | MIT | ✅ |
| @turf/turf | 7.2.0 | MIT | ✅ |
| gdal-js（内含 GDAL） | 2.2.0 | MIT / MIT-X11 | ✅ |
| maplibre-gl | 6.12.0 | BSD-3-Clause | ✅（保留版权声明） |
| proj4 | 2.15.0 | MIT | ✅ |
| sqlite-wasm-vec | 0.1.11 | Apache-2.0 | ✅ |
| zod | ^3.24.2 | MIT | ✅ |

自有代码 Apache-2.0。全部宽松许可，无 copyleft；发布时随包保留 `THIRD_PARTY_NOTICES.md` 声明。

---

## 契约代码锚点

| 锚点 | 文件 | 用途 |
|---|---|---|
| CAPABILITY_MANIFEST / DangerLevel | `packages/ai-boundary/src/capability-manifest.ts` | 契约一单一事实源 |
| VISIBILITY_FORBIDDEN_KEYS | 同上 | 契约二禁见基准 |
| AUTHORIZATION_* / ApprovalToken / issueAndConsumeApproval | 同上 | 契约三类型、清单与一次性授权消费 |
| AUDIT_REQUIRED_* / recordNonSpatialOperation | 同上；`packages/spatial-ops/src/operation-attempt.ts` | 契约四字段、覆盖清单与非空间留痕写入 |
| 一致性验证 | `apps/cli/src/v085-contract-check.ts`、`architecture-check.ts`、`v086-auth-check.ts`、`runtime-boundary-check.ts`，以及同目录后来的 `*-check.ts` | 契约锚点仍由前四份核对。其后的检查按版本覆盖新能力。清单见 `docs/TEST-CURRENT.md`。更新本文时没有重跑整套检查 |

新增能力、修改授权、扩展审计前先改锚点，再实现，最后跑 check。
