// SPDX-License-Identifier: Apache-2.0

/**
 * 模型清单。记录的是模型权限，不是产品版本号。
 * 网关用 forbidden 检查即将离开本机、朝向模型的载荷。
 * 正文与 packages/ai-boundary/model-manifest.json 相同。
 * modelVersion 为 unpinned。这里没有模型哈希或签名。
 * 模型供应链签名是 FUTURE HARDENING，尚未实现。
 */

export interface ModelManifest {
  readonly modelName: string;
  readonly modelVersion: string;
  readonly permissions: readonly string[];
  readonly forbidden: readonly ("raw_geometry" | "filesystem")[];
}

const MANIFEST_TEXT = `{
  "modelName": "igis-cloud",
  "modelVersion": "unpinned",
  "permissions": ["operation_request"],
  "forbidden": ["raw_geometry", "filesystem"]
}
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseModelManifest(value: unknown): ModelManifest {
  if (!isRecord(value)) throw new Error("模型清单必须是对象。");
  if (typeof value.modelName !== "string" || value.modelName.trim() === "") throw new Error("模型清单缺少模型名。");
  if (typeof value.modelVersion !== "string" || value.modelVersion.trim() === "") throw new Error("模型清单缺少模型版本。");
  if (!Array.isArray(value.permissions) || !value.permissions.includes("operation_request")) {
    throw new Error("模型清单必须允许 operation_request。");
  }
  if (!Array.isArray(value.forbidden) || !value.forbidden.includes("raw_geometry") || !value.forbidden.includes("filesystem")) {
    throw new Error("模型清单必须禁止 raw_geometry 和 filesystem。");
  }
  const permissions = value.permissions.filter((item): item is string => typeof item === "string");
  const forbidden = value.forbidden.filter((item): item is "raw_geometry" | "filesystem" => item === "raw_geometry" || item === "filesystem");
  return {
    modelName: value.modelName.trim(),
    modelVersion: value.modelVersion.trim(),
    permissions: ["operation_request", ...permissions.filter((item) => item !== "operation_request")],
    forbidden,
  };
}

export function loadModelManifest(): ModelManifest {
  return parseModelManifest(JSON.parse(MANIFEST_TEXT) as unknown);
}
