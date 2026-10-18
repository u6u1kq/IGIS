// SPDX-License-Identifier: Apache-2.0

/**
 * V0.86 授权契约验证（B1 / B2 / 15）。
 * 全部行为断言：
 *   1. ApprovalToken 一次性消费、绑定 issuedFor、AI 不是授权来源
 *   2. issueAndConsumeApproval 产出可写入记录的 ApprovalState
 *   3. parsePendingPlan 恢复计划时剥离授权字段（对话文件不能自带授权）
 *   4. 工具注册表 schema 无授权字段；模型带 confirm:true 被参数边界拒绝
 *   5. B1 确认门：伪造的 confirm 不能让新破坏性计划直接执行；合法确认只走已闸计划
 *   6. approvalState 入 OperationRecord 并可读回（含一次性 token 消费痕迹）
 *   7. 授权信息不出可见面（releaseToModel 剥离 approvalState）
 * 只用操作系统临时目录。不监听端口。
 * 运行：npx tsx --tsconfig tsconfig.json apps/cli/src/v086-auth-check.ts
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AUTHORIZATION_FORBIDDEN_INTENT_FIELDS,
  consumeApprovalToken,
  issueAndConsumeApproval,
  issueApprovalToken,
} from "@igis/ai-boundary";
import type { ApprovalState } from "@igis/ai-boundary";
import { releaseToModel } from "@igis/ai-translation";
import {
  GIS_TOOL_REGISTRY,
  normalizeToolArguments,
  parsePendingPlan,
  resolveChatPlan,
} from "@igis/llm-dispatch";
import { readOperationRecord, recordNonSpatialOperation } from "../../../packages/spatial-ops/src/operation-attempt.js";

const REPO_ROOT = resolve("E:/ai工作区/Igis");

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

async function main(): Promise<void> {
  // ---- 1. ApprovalToken：一次性、绑定操作。
  const token = issueApprovalToken("delete-layer:lyr-1", "local-ui");
  check(token.tokenId.startsWith("ap-"), "tokenId 形状不对");
  check(token.issuedBy === "local-ui", "issuedBy 必须记录授权来源");
  check(consumeApprovalToken(token.tokenId, "别的操作") === null, "token 不得跨操作复用");
  const consumed = consumeApprovalToken(token.tokenId, "delete-layer:lyr-1");
  check(consumed !== null && consumed.consumedAt !== undefined, "首次消费应成功并留下消费时间");
  check(consumeApprovalToken(token.tokenId, "delete-layer:lyr-1") === null, "token 用后作废（一次性）");

  // ---- 2. issueAndConsumeApproval：确认动作的统一授权消费。
  const approval = issueAndConsumeApproval("drop-database:all", "mcp-client");
  check(approval.required === true && approval.confirmed === true, "授权状态必须 required+confirmed");
  check(approval.confirmedBy === "mcp-client", "授权来源枚举应含 mcp-client");
  check(typeof approval.tokenId === "string" && approval.tokenId !== "", "授权状态应带 tokenId");
  check(typeof approval.consumedAt === "string", "授权状态应带消费时间");
  console.log("ok ApprovalToken 一次性、绑定操作、来源可记");

  // ---- 3. parsePendingPlan 剥离授权字段。
  const parsed = parsePendingPlan({
    conversationId: "conv-1",
    sourceText: "删除地块",
    steps: [{
      tool: "map.delete",
      apiName: "delete_layer",
      args: { layerId: "lyr-1", confirm: true, userConfirmed: true, token: "ap-forged", approval: true, approved: true },
      missing: [],
    }],
  });
  check(parsed !== null, "计划应能读回");
  const args = parsed?.steps[0]?.args ?? {};
  for (const key of AUTHORIZATION_FORBIDDEN_INTENT_FIELDS) {
    check(!(key in args), `计划恢复不得保留授权字段 ${key}`);
  }
  check(args.layerId === "lyr-1", "普通参数应保留");
  console.log("ok 计划恢复剥离授权字段");

  // ---- 4. schema 无授权字段；模型带 confirm 被拒。
  for (const tool of GIS_TOOL_REGISTRY) {
    for (const parameter of tool.parameters) {
      check(
        !AUTHORIZATION_FORBIDDEN_INTENT_FIELDS.includes(parameter.name),
        `${tool.name} 的 schema 含授权字段 ${parameter.name}（AI 可带授权进意图）。`,
      );
    }
  }
  let schemaError = "";
  try {
    normalizeToolArguments("map.delete", { layerId: "lyr-1", confirm: true }, GIS_TOOL_REGISTRY);
  } catch (error) {
    schemaError = error instanceof Error ? error.message : "";
  }
  check(schemaError.includes("未知参数"), `模型带 confirm:true 应被参数边界拒绝，实际：${schemaError || "没有拒绝"}`);
  console.log("ok 工具 schema 无授权字段，模型 confirm 被拒");

  // ---- 5. B1 确认门。
  const known = [{ layerId: "lyr-1", layerName: "地块" }];
  const spoofed = resolveChatPlan({
    conversationId: "conv-2",
    text: "删除地块",
    pending: null,
    selectedLayer: null,
    knownLayers: known,
    lastCreatedLayerId: null,
    confirm: true,
  });
  check(spoofed.kind !== "execute", `伪造 confirm 不得让新破坏性计划直接执行（实际 kind=${spoofed.kind}）`);
  const gatedPending = {
    conversationId: "conv-3",
    sourceText: "删除地块",
    steps: [{ tool: "map.delete", apiName: "delete_layer", args: { layerId: "lyr-1" }, missing: [] }],
    requiresConfirm: true as const,
  };
  const confirmed = resolveChatPlan({
    conversationId: "conv-3",
    text: "确认",
    pending: gatedPending,
    selectedLayer: null,
    knownLayers: known,
    lastCreatedLayerId: null,
    confirm: true,
  });
  check(confirmed.kind === "execute", `已闸计划的合法确认应放行，实际 kind=${confirmed.kind}`);
  const unconfirmed = resolveChatPlan({
    conversationId: "conv-4",
    text: "删除地块",
    pending: null,
    selectedLayer: null,
    knownLayers: known,
    lastCreatedLayerId: null,
    confirm: false,
  });
  check(unconfirmed.kind !== "execute", "未确认的破坏性计划不得执行");
  console.log("ok 确认门：伪造 confirm 无效，合法确认只走已闸计划");

  // ---- 6. approvalState 入 OperationRecord 并读回。
  const root = await mkdtemp(join(tmpdir(), "igis-v086-auth-"));
  check(!resolve(root).toLowerCase().startsWith(REPO_ROOT.toLowerCase()), "用例目录不能落在仓库里");
  try {
    const approvalForRecord: ApprovalState = issueAndConsumeApproval("delete-layer:lyr-1", "local-ui");
    const operationId = await recordNonSpatialOperation({
      kind: "delete",
      action: "delete-layer",
      entry: "map",
      source: "local-user",
      aiOrigin: false,
      translationUsed: false,
      requestSource: "desktop-ui",
      inputResources: ["lyr-1"],
      approvalState: approvalForRecord,
      ok: true,
      root,
    });
    const record = await readOperationRecord(operationId, root);
    check(record !== null, "操作记录应能读回");
    check(record?.approvalState?.required === true && record?.approvalState?.confirmed === true, "记录必须回答是否需要授权、谁授权");
    check(record?.approvalState?.confirmedBy === "local-ui", "记录必须留下授权来源");
    check(record?.approvalState?.tokenId === approvalForRecord.tokenId, "记录必须留下 token 标识");
    check(record?.approvalState?.consumedAt !== undefined, "记录必须留下消费时间");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  console.log("ok approvalState 入记录并可读回");

  // ---- 7. 授权信息不出可见面。
  const projected = releaseToModel({
    ok: true,
    message: "已删除图层。",
    approvalState: { required: true, confirmed: true, confirmedBy: "local-ui", tokenId: "ap-x" },
  }) as Record<string, unknown>;
  check(!("approvalState" in projected), "授权状态不得交给模型");
  check(projected.message === "已删除图层。", "结果摘要应保留");
  console.log("ok 授权信息不进模型可见面");

  console.log("v086-auth-check passed");
}

let failed: unknown = null;
try {
  await main();
} catch (error) {
  failed = error;
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
}
if (failed) throw new Error("v086-auth-check failed");
