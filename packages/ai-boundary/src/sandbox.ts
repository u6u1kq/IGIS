// SPDX-License-Identifier: Apache-2.0

/**
 * 能力边界在网关里执行，不是另一套操作系统沙箱。
 * 模型可以提出操作、读取 L2 摘要、接收标识和状态。
 * 模型不能拿到文件系统、外壳、原始图层或数据库转储。
 * 破坏性确认仍用现有的 gateDestructive，这里不另做一套确认。
 * FUTURE CAPABILITY SANDBOX: NOT IMPLEMENTED。
 * 外部 MCP 进程、文件系统和网络不受这里控制，不能把它说成已经隔离。
 */

export const AI_SANDBOX_ALLOW = ["create_operation", "read_l2_summary", "read_id_status"] as const;

export const AI_SANDBOX_DENY = ["filesystem", "shell", "raw_layer", "database_dump"] as const;

export type SandboxDeny = (typeof AI_SANDBOX_DENY)[number];
