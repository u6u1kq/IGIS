// SPDX-License-Identifier: Apache-2.0

/**
 * 图层坐标系身份。只承认能从文本里证明的 EPSG 写法。
 * 不猜测坐标范围，不把缺省当成 EPSG:4326，也不做坐标变换。
 */

export interface UnknownCrsIdentity {
  readonly kind: "unknown";
  readonly canonical: "unknown";
}

export interface InvalidCrsIdentity {
  readonly kind: "invalid";
  readonly canonical: "invalid";
  readonly raw: string;
}

export interface KnownCrsIdentity {
  readonly kind: "known";
  readonly canonical: string;
  readonly epsg: number;
}

/** 已声明投影/局部平面：写了投影定义但没有标准 EPSG 代码。raw 是规范化后的定义文本。 */
export interface PlanarCrsIdentity {
  readonly kind: "planar";
  readonly canonical: "planar";
  readonly raw: string;
}

export type CrsIdentity = UnknownCrsIdentity | InvalidCrsIdentity | KnownCrsIdentity | PlanarCrsIdentity;

export type CrsComparison = "same" | "different" | "unknown" | "invalid";

export interface IdentifyCrsOptions {
  /** 只有调用方已经证明这段文字是 EPSG 代码时，才接受单独的数字。 */
  readonly epsgCodeContext?: boolean;
}

const UNKNOWN_IDENTITY: UnknownCrsIdentity = { kind: "unknown", canonical: "unknown" };

export function unknownCrs(): UnknownCrsIdentity {
  return UNKNOWN_IDENTITY;
}

export function invalidCrs(raw: string): InvalidCrsIdentity {
  const trimmed = raw.trim().replace(/\s+/g, " ").slice(0, 80);
  return { kind: "invalid", canonical: "invalid", raw: trimmed === "" ? "invalid" : trimmed };
}

function normalizeDefinition(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/** 已声明投影/局部平面身份。同一段定义文本才算同一个平面坐标系。 */
export function planarCrs(definition: string): PlanarCrsIdentity {
  return { kind: "planar", canonical: "planar", raw: normalizeDefinition(definition) };
}

function knownCrs(code: number): KnownCrsIdentity | null {
  if (!Number.isInteger(code) || code <= 0 || code > 1_000_000) return null;
  return { kind: "known", canonical: `EPSG:${code}`, epsg: code };
}

function isUnknownToken(value: string): boolean {
  if (value === "" || value === "未声明") return true;
  return value.toLowerCase() === "unknown";
}

/** 整段文本本身就是一条能证明的 EPSG 引用时，返回代码。 */
function epsgCodeOf(value: string): number | null {
  const short = /^(?:epsg)\s*:\s*:?\s*(\d+)$/i.exec(value);
  if (short?.[1]) return Number(short[1]);
  const urn = /^urn:ogc:def:crs:epsg:(?::|(?:[^:]+:))(\d+)$/i.exec(value);
  if (urn?.[1]) return Number(urn[1]);
  const authority = /^(?:authority|id)\s*\[\s*"epsg"\s*,\s*"?(\d+)"?\s*\]$/i.exec(value);
  if (authority?.[1]) return Number(authority[1]);
  return null;
}

/**
 * null、undefined、空串、未声明、unknown、UNKNOWN 收成同一个未知身份。
 * EPSG:4326、epsg:4326、URN 和整段 AUTHORITY/ID 收成同一个已知身份。
 * 单独的 4326 只有在 epsgCodeContext 里才算 EPSG 代码。
 * 写了但证明不了的元数据是无效，不是未知。
 */
export function identifyCrs(value: unknown, options?: IdentifyCrsOptions): CrsIdentity {
  if (value === null || value === undefined) return unknownCrs();
  if (typeof value !== "string") return invalidCrs("非文本坐标系");
  const trimmed = value.trim();
  if (isUnknownToken(trimmed)) return unknownCrs();
  const code = epsgCodeOf(trimmed);
  if (code !== null) return knownCrs(code) ?? invalidCrs(trimmed);
  if (options?.epsgCodeContext === true && /^\d+$/.test(trimmed)) {
    return knownCrs(Number(trimmed)) ?? invalidCrs(trimmed);
  }
  // 投影/局部坐标系 WKT 文本：先看能不能证明 EPSG 代码，证明不了才是平面身份。
  if (/^(?:PROJCS|LOCAL_CS|GEOGCS|GEODCRS|PROJCRS|ENGCRS|COMPD_CS)\s*\[/i.test(trimmed)) {
    const fromWkt = epsgFromWkt(trimmed);
    if (fromWkt !== null) return knownCrs(fromWkt) ?? invalidCrs(trimmed);
    return planarCrs(trimmed);
  }
  return invalidCrs(trimmed);
}

/** WKT 文本里 CRS 级的 EPSG 代码。取最后一个 AUTHORITY["EPSG",n]：WKT 惯例 CRS 本身的授权写在末尾。 */
export function epsgFromWkt(wkt: string): number | null {
  const pattern = /AUTHORITY\s*\[\s*"EPSG"\s*,\s*"?(\d+)"?\s*\]/gi;
  let code: number | null = null;
  for (const match of wkt.matchAll(pattern)) {
    const parsed = Number(match[1]);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 1_000_000) code = parsed;
  }
  return code;
}

export function crsLabelFor(identity: CrsIdentity): string {
  if (identity.kind === "known") return identity.canonical;
  if (identity.kind === "unknown") return "未声明";
  if (identity.kind === "planar") return "局部平面";
  return "无效";
}

export function crsAgrees(left: CrsIdentity, right: CrsIdentity): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "known" && right.kind === "known") return left.epsg === right.epsg;
  if (left.kind === "invalid" && right.kind === "invalid") return left.raw === right.raw;
  if (left.kind === "planar" && right.kind === "planar") return left.raw === right.raw;
  return true;
}

/** 任一无效优先，其次任一未知。平面身份按定义文本比对，全部一致才是 same。 */
export function compareCrs(identities: readonly CrsIdentity[]): CrsComparison {
  if (identities.length === 0) return "unknown";
  if (identities.some((item) => item.kind === "invalid")) return "invalid";
  if (identities.some((item) => item.kind === "unknown")) return "unknown";
  const first = identities[0];
  if (first && first.kind === "planar") {
    const same = identities.every((item) => item.kind === "planar" && item.raw === first.raw);
    return same ? "same" : "different";
  }
  if (!first || first.kind !== "known") return "unknown";
  const same = identities.every((item) => item.kind === "known" && item.epsg === first.epsg);
  return same ? "same" : "different";
}

export function acceptCrsIdentity(value: unknown): CrsIdentity | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { readonly kind?: unknown; readonly canonical?: unknown; readonly epsg?: unknown; readonly raw?: unknown };
  if (record.kind === "unknown" && record.canonical === "unknown") return unknownCrs();
  if (record.kind === "known" && typeof record.epsg === "number" && record.canonical === `EPSG:${record.epsg}`) {
    return knownCrs(record.epsg);
  }
  if (record.kind === "planar" && record.canonical === "planar" && typeof record.raw === "string" && record.raw !== "") {
    return planarCrs(record.raw);
  }
  if (record.kind === "invalid" && record.canonical === "invalid" && typeof record.raw === "string") {
    return invalidCrs(record.raw);
  }
  return null;
}

/** 磁盘上的标签和已保存身份不一致时，以这次读到的标签重新识别。 */
export function resolveStoredCrs(label: unknown, stored: unknown, definition?: unknown): CrsIdentity {
  const fromLabel = identifyCrs(typeof label === "string" ? label : undefined);
  const fromStored = acceptCrsIdentity(stored);
  const storedDefinition = typeof definition === "string" ? identifyCrs(definition) : null;
  if (fromStored?.kind === "invalid" && storedDefinition?.kind === "planar"
    && ["wkt-no-epsg", "invalid", "无效", "无法读取的坐标系"].includes(fromStored.raw)) {
    return storedDefinition;
  }
  if (!fromStored) return fromLabel;
  if (fromStored.kind === "invalid" && fromLabel.kind === "invalid" && (fromLabel.raw === "无效" || fromLabel.raw === fromStored.raw)) {
    return fromStored;
  }
  if (fromStored.kind === "planar" && fromLabel.kind === "invalid" && fromLabel.raw === "局部平面") {
    return fromStored;
  }
  if (crsAgrees(fromLabel, fromStored)) return fromStored;
  return fromLabel;
}
