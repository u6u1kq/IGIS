# 当前测试

当前尚未建立正式自动化测试体系。

根 `package.json` 的 `scripts` 只有 `typecheck` 和 `mcp`。没有 `test`。没有发现 Jest、Vitest、Mocha 的 npm script，也没有 `*.test.ts` / `*.spec.ts`。下面的脚本都要人手用 `tsx` 执行，导入它们不会自动跑。

最后一次实际执行：未在本次运行。本次只启动了桌面 HTTP 并做了健康检查和页面检查，没有跑下表。

| 名称 | 文件 | 测试什么 | 自动化 | 写 var | 可安全运行 | 最后一次实际执行 |
| --- | --- | --- | --- | --- | --- | --- |
| typecheck | 根 `package.json` `tsc -p tsconfig.json --noEmit` | TypeScript 类型 | 有 npm script，无测试框架 | 否 | 只读类型检查，相对安全。本次未跑 | 未在本次运行 |
| mcp | 根 `package.json`，入口 `apps/cli/src/mcp-server.ts` | 启动 stdio MCP，不是测试 | 有 npm script | 若有人连上并调用工具，会走与桌面相同的工作区，可能写 `var/` | 不要把它当测试来跑 | 未在本次运行 |
| v075-eval | `apps/cli/src/v075-eval.ts` | 本地计划、图层运算和回退。文件内 `assert(` 108 处。工作目录 `var/tmp/v075-eval` | 否 | 是 | 会改 `var/tmp` 并打开空间栈。本次不跑 | 未在本次运行 |
| chat-ux-eval | `apps/cli/src/chat-ux-eval.ts` | 对话删除与流式事件。`assert(` 56 处。目录 `var/tmp/chat-ux-delete`。成功时 stdout 带 `"version":"0.74"` | 否 | 是 | 会写 `var/tmp` | 未在本次运行 |
| pending-plan-eval | `apps/cli/src/pending-plan-eval.ts` | Pending Plan。`assert(` 32 处。目录 `var/tmp/pending-plan-eval` | 否 | 是 | 会写 `var/tmp` | 未在本次运行 |
| ai-eval | `apps/cli/src/ai-eval.ts` | 调用本地 mock、`resolveChatPlan`、`runLlmDispatchSelfCheck`、空间栈。源码里没有 `assert(`。目录 `var/tmp/ai-eval-layers`，并可能写 `var/tmp` | 否 | 是 | 会写 `var/tmp` | 未在本次运行 |
| llm-dispatch self-check | `packages/llm-dispatch/src/self-check.ts` 的 `runLlmDispatchSelfCheck`、`runLlmToolLoopSelfCheck` | 调度与工具循环。该文件没有 `writeFile` | 否。`ai-eval.ts` 会调用它们 | 该文件自身不写。被 ai-eval 调用时外层会写 | 单独调用看起来不写 var。本次未单独运行，不能把它记为通过 | 未在本次运行 |
| gdal self-check | `packages/gdal-wasm-adapter/src/self-check.ts` `runGdalWasmSelfCheck(directory)` | 合成 GeoTIFF、shapefile；无效 `.gdb` 必须失败。注释写明导入不自动执行 | 否 | 删除并重写调用方传入的目录 | 不要对 `var/map-layers` 调用 | 未在本次运行 |
| provenance self-check | `packages/provenance/src/self-check.ts` `runProvenanceSelfCheck`、`runProvenancePersistenceSelfCheck` | 拒绝几何字段；后者在传入目录写账本 | 否 | 后者写传入目录 | 不要指向 `var/provenance` | 未在本次运行 |

`var/tmp` 里还有以往留下的脚本，不是 npm script。本次没有打开每一份去核对断言，也没有运行：

`cleanup-layers.mjs`，`e2e-maplibre6.mjs`，`e2e-v07.mjs`，`e2e-v071.mjs`，`e2e-v072.mjs`，`e2e-v073.mjs`，`e2e-v073-edge.mjs`，`gdl-chat-smoke.mts`，`inspect-pptx.mjs`，`ppt-image-size-smoke.mjs`，`record-image-size.mts`，`record-maplibre-6.mts`，`record-v071-licenses.mts`，`smoke-v07.mjs`。

同目录还有 `e2e`、`e2e-edge-073`、`e2e-maplibre6`、`edge-v071`、`edge-v072`。最后一次实际执行：未在本次运行。
