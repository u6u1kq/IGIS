# Buffer 请求映射（V0.75-Clean Phase 2 Task 002）

Task 009 起，下面四个函数是 Raw Operation Input，不是最终 `BufferOperationRequest`。函数名是 `rawBufferInputFromChatLocal`、`rawBufferInputFromToolArgs`、`rawBufferInputFromMcp`、`rawBufferInputFromMapHttp`、`rawBufferInputFromGdl`。返回值是 `RawBufferOperationMapping`：`{ input, policy }`。`input.sourceLayer` 仍是 `LayerReference`。最终请求只在已有成功身份上由 `bufferRequestFromResolution` 组装，见 `docs/OPERATION-CONTRACT-DRAFT.md`。

四个纯函数把各入口**已经取出、但还没解析成图层身份**的值分成两半：`RawBufferOperationInput` 与 `ExecutionPolicy`。它们不解析用户文字，不合并四套解析器，不换算单位，不解析图层，不调用 `SpatialService.buffer`，也不按策略写知识库。下表里的「请求」读成原始输入 `input`。

`writeKnowledge` 只出现在 `policy` 上。请求描述缓冲本身。输出名 `outputName` 仍在请求上，因为 Task 002 把它当作用户点名的结果图层名。

实现：`packages/spatial-ops/src/buffer-operation.ts`。

运行时不导入该文件。`service.ts`、`adapter.ts`、`map-http.ts`、GDL、`desktop-api.ts` 都没有引用它。现有缓冲仍走原来的参数。

`steps` 不在请求里。`packages/surtgis/src/core/overlay.ts` 的 `bufferFeatures` 仍写死 `{ units, steps: 8 }`。

## 单位

请求里的单位只有这五种：`meters`、`kilometers`、`miles`、`feet`、`degrees`。

它们来自现有代码已经接受的集合：`normalizeUnit`（`packages/spatial-ops/src/text.ts`）、GDL `normalizeGdlUnit`、地图 `#analysis-unit` 下拉。映射函数不新增单位，也不把一种单位乘成另一种。

## 1. 聊天本地计划

函数：`rawBufferInputFromChatLocal`。

输入是本地计划已经放进 `map.buffer` 参数的值，不是用户原句。产生这些值的仍是 `normalizeInstruction` / `parseDistanceMeters`（`packages/llm-dispatch/src/local-intent.ts`）和 `draftPendingPlan`（`packages/llm-dispatch/src/pending-plan.ts`）。

| 字段 | 从哪来 | 可缺 |
| --- | --- | --- |
| `sourceLayer` | `args.layerId` 字符串，记为 `{ kind: "name-or-id", text }`。用户写出的图层名、选中图层名（空名时退回选中 id）、或回指得到的 id，都还是这一条字符串。不调用 `resolveLayerRef` | 计划里缺名字时槽位是 `missing: ["layerId"]`，还没有可抄的字符串，也就还不构成这次请求。函数自己不编一个图层 |
| `distance` | 调用方传入的 number。只来自句中写出的距离 | 函数没有默认值。句中没有距离时解析器留下缺槽，不填 200。200 只在用户写出 200、两百或 200米时出现 |
| `unit` | 调用方传入的单位。本地 `parseDistanceMeters` **一律是 `"meters"`**。千米先乘 1000，再把单位写成 meters | 随距离一起出现。函数不再乘 |
| `outputName` | 本地计划不写 | 请求里不出现 |
| `policy.writeKnowledge` | 本地缓冲计划经 `knowledge()` **固定 true**。调用方传入 true | 函数不自己写成 true。键在策略上，不在请求上 |

「300米」和「三百米」在解析器里都已经是 distance `300`、unit `"meters"`。映射结果相同：请求是 `operation: "buffer"`，图层指针为 name-or-id，距离 300，单位 meters；策略是 `{ writeKnowledge: true }`。

「300公里」若走本地解析，在到达本函数之前已经是 `300000` 与 `"meters"`。本函数不会把工具路径的 300 kilometers 再乘一次；那条语义属于下一节。

## 2. 聊天工具参数与 MCP

函数：`rawBufferInputFromToolArgs`。`rawBufferInputFromMcp` 就是这个函数。

MCP `map_buffer` 在 `executeMcpTool` 里先 `normalizeToolArguments`，再进入与聊天相同的 `createSpatialAwareAdapter`。参数形状与聊天工具参数相同：`layerId`、`distance`、`unit`，可选 `outputName`、`writeKnowledge`。

| 字段 | 从哪来 | 可缺 |
| --- | --- | --- |
| `sourceLayer` | `layerId` 字符串，记为 `{ kind: "name-or-id", text }`。工具表写明是图层标识或图层名。适配器里的 `resolveLayerRef` 仍在执行时发生，本函数不调用 | 工具表要求必填。函数不编图层 |
| `distance` | 已是 number。`splitDistance` 遇到 `"300公里"` 得到 300，不乘 1000。`distanceOf` 同样保留 300 | 工具表必填。函数不默认 200。`distanceOf` 在补图层名时也不再填 200 |
| `unit` | `"300公里"` 保持 `"kilometers"`。别名由 `normalizeUnitText` / `distanceOf` 收成五种单位之一 | 工具表必填。认不出的字符串今天仍能通过工具校验，要到 `normalizeUnit` 才抛错。映射函数不做这步校验 |
| `outputName` | 参数里有则抄入请求 | 可省略，请求里就不出现 |
| `policy.writeKnowledge` | 只有参数里已经是布尔值才抄入策略。本地计划和 `gis-route` 不再因「写入知识库」放上 true | 省略时策略是 `{}`，键不出现。运算不根据它写知识库 |

因此工具 / MCP 的「300公里」是 distance `300`、unit `"kilometers"`。

## 3. 地图 HTTP

函数：`rawBufferInputFromMapHttp`。

入口是 `POST /api/spatial/run`（`apps/cli/src/map-http.ts`）。`operation === "buffer"` 时今天直接 `service.buffer(layerId, distance, unit, writeKnowledge)`，没有 `outputName`。本函数不替换这次调用。

| 字段 | 从哪来 | 可缺 |
| --- | --- | --- |
| `sourceLayer` | `body.layerId`，记为 `{ kind: "id", id }`。界面 `#analysis-layer` 的 option value 是图层 id，不是显示名 | HTTP 要求非空字符串。未选图层时按钮不发请求。函数不按名字查找 |
| `distance` | `body.distance`，HTTP 要求 `typeof === "number"`。界面输入框初始 value 是 `"100"`，那是页面默认，不是本函数的默认 | 不是 number 时 HTTP 400，不会到映射。空输入在页面上会变成 `0`，仍是调用方传入的数；函数不改它 |
| `unit` | `#analysis-unit`：meters、kilometers、miles、feet、degrees。下拉第一项是 meters | HTTP 要求非空字符串 |
| `outputName` | 不发送 | 请求里不出现 |
| `policy.writeKnowledge` | `body.writeKnowledge === true` 之后的布尔值。复选框默认不勾，所以通常是 false | 调用方传入已经得到的布尔值，抄进策略。`false` 会留下。函数不另设默认 |

## 4. GDL

函数：`rawBufferInputFromGdl`。

输入是 `parseGdl` 已经得到的语句：`{ kind: "buffer", input, distance, unit, output }`（`packages/gdl/src/ast.ts`）。`input` 是图层名。`executeGdl` 稍后才用脚本作用域或 `findByName` 变成 id，再由 `host.buffer` 调用 `service.buffer`。本函数抄的是解析后的名字，不抄解析后的 id。

| 字段 | 从哪来 | 可缺 |
| --- | --- | --- |
| `sourceLayer` | 语句 `input`，记为 `{ kind: "name", name }`。匹配仍是精确同名，本函数不查找 | 语法要求有名字。没有名字则没有语句 |
| `distance` | 语句里的 number。`300米` 可以粘成一个词，解析后是 300 与 meters。`300公里` 是 300 与 kilometers，不乘 1000 | 语法必填，且解析器要求 `> 0`。函数不再查 |
| `unit` | `GdlUnit`：meters、kilometers、miles、feet、degrees | 不在别名表里则语法错误，没有语句 |
| `outputName` | `AS` 后面的 `output` | 语法必填。没有 `AS` 则没有语句。请求里带上这个名字 |
| `policy.writeKnowledge` | 语句里没有 | 策略是 `{}`，键不出现。`gdl-http.ts` 的 `host.buffer` 调用 `service.buffer` 时仍固定 `false`。脚本级 RAG 仍是 `runGdl` 的另一条路。这两处都没有改 |

## 校验仍在原处

映射函数不校验。下面这些检查保持原样：

| 仍由谁做 | 做什么 |
| --- | --- |
| `parseDistanceMeters` / `normalizeInstruction` | 本地文字、中文数字、公里乘 1000。没有距离则缺槽，不填数 |
| `normalizeToolArguments` / `validateToolArguments` | 工具与 MCP 的别名、距离字符串、必填、几何字段名 |
| `distanceOf` | 仅 local-mock 后备，公里不乘 1000 |
| `POST /api/spatial/run` | distance 必须是 number，unit 与 layerId 必须是非空字符串。不在这里查 `> 0` |
| GDL 解析器 | 距离 `> 0`，单位必须在别名表，必须有 `AS` |
| `resolveLayerRef` | 聊天与 MCP 执行时才把 name-or-id 字符串变成图层 id |
| `findByName` | GDL 执行时按精确同名取层 |
| `requireCollection` | 地图只按 id 取层 |
| 适配器 | 距离必须有限且 `> 0` |
| `normalizeUnit` / `assertDistance` | 服务层认单位、查正数和上限。`degrees` 上限 180，`kilometers` 上限 20000，其余 10000000 |

## 四个入口抄进请求后仍不同

这些差异被保留在映射结果里，没有抹平：

- 本地「300米 / 三百米」是 300 meters；工具 / MCP「300公里」是 300 kilometers。GDL 的公里也不乘 1000。
- 200 不是空槽的填充值。它来自早期测试句（「做 200 米缓冲」「两百」）被直接写进解析器的遗留。句中没有距离就追问或交给模型。工具、地图和 GDL 这三个入口本来就不填 200。映射函数自己也没有 200。
- 图层指针种类不同：聊天与 MCP 是 name-or-id，地图是 id，GDL 是 name。
- `outputName`：本地和地图没有；工具可选；GDL 有。
- `writeKnowledge` 在策略上：本地传入 true；地图传入复选框布尔值；工具 / MCP 可省略；GDL 策略里不写，宿主调用仍是 false。请求上没有这个键。
- 谁拒绝非法距离、谁写失败审计，仍按 `docs/BUFFER-CURRENT-FLOW.md` 第 4 节和第 6 节，没有收成一个校验器。
