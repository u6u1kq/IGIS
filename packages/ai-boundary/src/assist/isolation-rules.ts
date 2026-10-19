// SPDX-License-Identifier: Apache-2.0

/**
 * 智能体规则模块 · 隔离规则。
 * 规则正文只加在 ISOLATION_RULES 里。
 * 执行只认这里的 id，不要在别的文件再写一套隔离条件。
 */

export interface IsolationRule {
  /** 稳定标识。一旦写上就不要改。 */
  readonly id: string;
  /** 这一条隔离要约束什么。 */
  readonly statement: string;
}

/**
 * 隔离规则表。
 * 新规则追加在这里，不要另开文件。
 */
export const ISOLATION_RULES: readonly IsolationRule[] = [
  {
    id: "user-api",
    statement: "不读取用户的 API 密钥，也不把密钥放进给模型的内容。",
  },
  {
    id: "storage-file",
    statement: "不跳过用户直接读取系统内的存储文件。打开文件由用户在界面完成。",
  },
];

/** 读取当前隔离规则。执行层只调用这个函数。 */
export function isolationRules(): readonly IsolationRule[] {
  return ISOLATION_RULES;
}

function hasRule(id: string): boolean {
  return ISOLATION_RULES.some((rule) => rule.id === id);
}

/** 按 user-api 去掉密钥。没有这条规则时原样返回。 */
export function concealUserApi(value: unknown, depth = 0): unknown {
  if (!hasRule("user-api")) return value;
  if (typeof value === "string") {
    return value
      .replace(/sk-[A-Za-z0-9_-]{10,}/g, "密钥")
      .replace(/Bearer\s+\S+/gi, "密钥")
      .replace(/(?:api[_-]?key|secret|token)\s*[:=]\s*\S+/gi, "密钥");
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (depth > 12) return value;
  if (Array.isArray(value)) return value.map((item) => concealUserApi(item, depth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/^(?:api[_-]?key|secret|token|password|authorization)$/i.test(key)) continue;
      out[key] = concealUserApi(item, depth + 1);
    }
    return out;
  }
  return value;
}

const STORAGE_READ = /readfile|read_file|readgis|io\.read|read_gis_file|map\.load|load_map_layer|fs\.read|gdal|ogr2ogr|ogrinfo|powershell|\bcmd\b|\beval\b|file:\/\//;

/** 按 storage-file 拒绝跳过用户去读系统内的存储文件。 */
export function rejectStorageRead(toolName: string): { readonly ok: false; readonly code: string; readonly message: string } | null {
  if (!hasRule("storage-file")) return null;
  if (!STORAGE_READ.test(toolName.trim().toLowerCase())) return null;
  return {
    ok: false,
    code: "storage-read-rejected",
    message: "不能跳过用户直接读取系统内的存储文件。",
  };
}
