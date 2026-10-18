// SPDX-License-Identifier: Apache-2.0

/**
 * V0.85 契约检查：验证 AI GIS Worker Contract 的代码锚点与运行时现实一致。
 * 断言（必须通过）：
 *   1. CAPABILITY_MANIFEST 覆盖 GIS_TOOL_REGISTRY 的全部工具
 *   2. destructive 能力的 requiresApproval 与运行时 destructive 门控一致
 *   3. projectForModel 剥离 VISIBILITY_FORBIDDEN_KEYS 的每个键（可见面契约）
 *   4. 可见面保留业务摘要键（要素数/图层名/操作结果摘要不被误删）
 * 输出（不判失败）：
 *   known gaps —— 契约要求但 V0.86 才实现的项（授权字段剥离、非空间操作记录等）
 * 纯行为断言，不写文件系统，不监听端口。
 * 运行：npx tsx --tsconfig tsconfig.json apps/cli/src/v085-contract-check.ts
 */

import {
  AUDIT_REQUIRED_OPERATIONS,
  AUTHORIZATION_FORBIDDEN_INTENT_FIELDS,
  AUTHORIZATION_REQUIRED_OPERATIONS,
  CAPABILITY_MANIFEST,
  VISIBILITY_FORBIDDEN_KEYS,
} from "@igis/ai-boundary";
import { projectForModel } from "@igis/ai-translation";
import { GIS_TOOL_REGISTRY } from "@igis/llm-dispatch";

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

function main(): void {
  // 1. 能力清单覆盖全部注册工具（能力契约：AI 只能调用登记的能力）。
  const registered: readonly string[] = GIS_TOOL_REGISTRY.map((tool) => tool.name as string);
  const manifested = new Set(CAPABILITY_MANIFEST.map((entry) => entry.tool));
  for (const name of registered) {
    check(manifested.has(name), `工具 ${name} 未登记到 CAPABILITY_MANIFEST，违反能力契约。`);
  }
  const extra = [...manifested].filter((name) => !registered.includes(name));
  check(extra.length === 0, `CAPABILITY_MANIFEST 中 ${extra.join("、")} 不在注册表（要么补注册要么删条目）。`);

  // 2. 危险等级与授权门一致（授权契约：destructive 必须授权）。
  for (const entry of CAPABILITY_MANIFEST) {
    if (entry.danger === "destructive") {
      check(entry.requiresApproval, `${entry.tool} 标记 destructive 但不要求授权。`);
    }
    if (AUTHORIZATION_REQUIRED_OPERATIONS.includes(entry.tool)) {
      check(entry.requiresApproval, `${entry.tool} 在 AUTHORIZATION_REQUIRED_OPERATIONS 中但不要求授权。`);
      check(entry.danger === "destructive", `${entry.tool} 要求授权但危险等级不是 destructive。`);
    }
  }
  for (const name of AUTHORIZATION_REQUIRED_OPERATIONS) {
    check(manifested.has(name), `授权清单中的 ${name} 不在能力清单。`);
  }

  // 3. 可见面契约：禁见键必须被 projectForModel 剥离。
  const payload: Record<string, unknown> = {};
  for (const key of VISIBILITY_FORBIDDEN_KEYS) payload[key] = "SENSITIVE";
  payload.layerName = "道路";
  payload.featureCount = 7;
  payload.message = "已完成缓冲";
  const projected = projectForModel(payload) as Record<string, unknown>;
  check(projected !== null && typeof projected === "object", "投影结果必须是对象。");
  for (const key of VISIBILITY_FORBIDDEN_KEYS) {
    check(!(key in projected), `可见面泄漏：${key} 未被 projectForModel 剥离。`);
  }
  check(projected.layerName === "道路", "业务摘要键 layerName 被误删。");
  check(projected.featureCount === 7, "业务摘要键 featureCount 被误删。");
  check(projected.message === "已完成缓冲", "结果摘要键 message 被误删。");

  // 4. 留痕契约清单的机械校验：五空间操作在清单内。
  for (const op of ["buffer", "intersect", "clip", "query", "stats"]) {
    check(AUDIT_REQUIRED_OPERATIONS.includes(op), `留痕清单缺少 ${op}。`);
  }

  console.log(`v085-contract-check passed（能力 ${CAPABILITY_MANIFEST.length} 项，注册 ${registered.length} 项）`);
  console.log("V0.85 known gaps 已由 V0.86 收口（验证见 v086-auth-check / runtime-boundary-check / architecture-check）：");
  console.log(`  - 授权字段从 AI schema 剥离：${AUTHORIZATION_FORBIDDEN_INTENT_FIELDS.join("/")}`);
  console.log("  - 非空间变更操作（load/delete/rename/export/import）的 OperationRecord 完整化");
  console.log("  - loop.ts 的 releaseToModel 闭环");
  console.log("  - parsePendingPlan 恢复剥离授权字段");
}

main();
