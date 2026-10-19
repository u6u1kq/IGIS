// SPDX-License-Identifier: Apache-2.0

import { compareCrs, crsAgrees, crsLabelFor, datumGate, parsableDefinition, planarUnitToMeter as planarUnitToMeterFrom, unknownCrs } from "@igis/surtgis";
import { ui } from "./locale.js";
import type { CrsComparison, CrsIdentity, PlanarCrsIdentity } from "@igis/surtgis";

/**
 * 空间运算的唯一坐标系策略。Chat、Map、GDL、MCP 不各自决定。
 * EPSG:4326/3857 走注册定义；其他标准 EPSG 坐标系用载入时读到的 WKT 变换，
 * 且必须先过严格基准门（WGS84 家族或自带 towgs84）。
 * 这里只做计划，不改坐标。
 */

export const CRS_UNKNOWN_SPATIAL = "输入坐标系未声明，不能保证空间含义。CRS is unknown and spatial operation requires explicit CRS identity.";
export const CRS_INVALID = "坐标系元数据无法解析，这是无效身份，不是未知。";
export const CRS_CALLER_CONFLICT = "调用方给出的坐标系和图层库里的坐标系不一致，已拒绝，没有改写图层上的坐标系。";
export const CRS_NO_EPSG = "该图层的坐标系没有标准 EPSG 代码，不能参与空间运算。请转换为标准 EPSG 坐标系后重新导入。";
export const CRS_DATUM_STRICT = "缺少基准改正参数（towgs84），严格模式不做近似变换。请转换为标准 EPSG 坐标系（如 EPSG:4326、EPSG:3857 或 CGCS2000）后重新导入。";
export const CRS_NO_DEFINITION = "没有可用的投影定义，无法变换。";
export const CRS_PLANAR_LIMITED = "该图层是局部平面坐标系（已声明投影、无标准 EPSG 代码）：只支持平面构造与平面度量（Voronoi、凸包、最小外接矩形、质心、分幅、几何转换、分割、空间聚合、距离矩阵、面积/长度/距离/最近距离），本次运算需要标准 EPSG 坐标系。";
export const CRS_PLANAR_MIXED = "参与运算的图层必须是同一段平面定义，或统一为标准 EPSG 坐标系。平面定义不同的图层不做隐式配准。";
export const CRS_PLANAR_NO_UNIT = "该平面坐标系没有可证明的长度单位，不能给出米制度量。平面构造不受影响。";

/** 用户看得到的坐标系拒绝。审计和检查仍使用上面的中文常量。 */
export function userCrsMessage(reason: string): string {
  if (reason === CRS_UNKNOWN_SPATIAL) return ui(reason, "The CRS is undeclared, so this spatial operation cannot run.");
  if (reason === CRS_INVALID) return ui(reason, "The CRS metadata cannot be parsed. This is an invalid CRS, not an unknown one.");
  if (reason === CRS_CALLER_CONFLICT) return ui(reason, "The caller's CRS does not match the layer CRS. The layer CRS was not changed.");
  if (reason === CRS_NO_EPSG) return ui(reason, "This layer has no standard EPSG code, so it cannot join this spatial operation. Reimport it with a standard EPSG CRS.");
  if (reason === CRS_DATUM_STRICT) return ui(reason, "There is no datum shift (towgs84). Convert to a standard EPSG CRS such as EPSG:4326, EPSG:3857, or CGCS2000 and import again.");
  if (reason === CRS_NO_DEFINITION) return ui(reason, "No projection definition is available, so the coordinates cannot be transformed. Convert to EPSG:4326 or EPSG:3857 and import again.");
  if (reason === CRS_PLANAR_LIMITED) return ui(reason, "This is a local projected CRS without an EPSG code. This operation needs a standard EPSG CRS.");
  if (reason === CRS_PLANAR_MIXED) return ui(reason, "The layers must share one planar definition, or all use a standard EPSG CRS.");
  if (reason === CRS_PLANAR_NO_UNIT) return ui(reason, "This planar CRS has no proven linear unit, so it cannot be measured in meters.");
  if (reason.includes(CRS_DATUM_STRICT)) return ui(reason, reason.replace(CRS_DATUM_STRICT, "has no datum shift (towgs84). Convert to a standard EPSG CRS and import again."));
  if (reason.includes(CRS_NO_DEFINITION)) return ui(reason, reason.replace(CRS_NO_DEFINITION, "has no usable projection definition."));
  return ui(reason, reason);
}

/** 平面身份直接可用的操作：平面构造 + 平面度量。其余空间操作仍要标准 EPSG。 */
export const PLANAR_OK_OPERATIONS: ReadonlySet<string> = new Set([
  "area",
  "length",
  "distance",
  "nearest",
  "voronoi",
  "convex-hull",
  "min-bbox",
  "centroid",
  "split-grid",
  "convert",
  "split-line",
  "explode",
  "vertices",
  "line-intersect",
  "transform",
  "nearest-on-line",
  "grid",
  "split-polygon",
  "spatial-aggregate",
  "distance-matrix",
  "nearest-exact",
]);

/** 平面度量操作：需要可证明的长度单位，其余平面操作不需要。 */
const PLANAR_MEASURE_OPERATIONS: ReadonlySet<string> = new Set(["area", "length", "distance", "nearest", "distance-matrix", "nearest-exact"]);

/** 双方都未声明坐标系时，按坐标原值计算，结果单位不是米。 */
const UNKNOWN_COORDINATE_DISTANCE_OPERATIONS: ReadonlySet<string> = new Set(["distance", "nearest", "distance-matrix", "nearest-exact", "nearest-on-line"]);

/** 未声明坐标系上只复制节点，不度量、不变换。 */
const UNKNOWN_COPY_OPERATIONS: ReadonlySet<string> = new Set(["vertices", "line-intersect", "transform", "grid"]);

/** 在图层原坐标上计算，不先变到经纬度。 */
const SOURCE_COORDINATE_OPERATIONS: ReadonlySet<string> = new Set(["line-intersect", "transform", "nearest-on-line", "grid"]);

/** 已声明投影且能证明米制单位时，在该平面上做缓冲和裁剪。没有投影或证明不了单位的仍拒绝。 */
const PLANAR_PROJECTED_METER_OPERATIONS: ReadonlySet<string> = new Set(["buffer", "clip"]);

function projectedMeterFactor(wkt: string | null | undefined): number | null {
  if (typeof wkt !== "string") return null;
  const trimmed = wkt.trim();
  if (!/^(?:PROJCS|PROJCRS)\s*\[/i.test(trimmed)) return null;
  return planarUnitToMeterFrom(trimmed);
}

const WORKING_EPSG = 4326;
const LOCAL_EPSG = new Set<number>([4326, 3857]);

export interface CrsTransformStep {
  readonly from: string;
  readonly to: string;
  readonly purpose: "align-input" | "to-working" | "from-working";
}

/** 参与运算的一个图层的坐标系输入：身份加载入时读到的 WKT（没有就是 null）。 */
export interface CrsLayerInput {
  readonly identity: CrsIdentity;
  readonly wkt: string | null;
}

export interface CrsExecutionPlan {
  readonly comparison: CrsComparison;
  readonly spatial: boolean;
  readonly allow: boolean;
  readonly resultIdentity: CrsIdentity;
  readonly resultCrs: string | null;
  readonly failureReason?: string;
  readonly targetEpsg: number | null;
  /** 目标坐标系的变换定义（注册名或 WKT）。拒绝或非空间时为 null。 */
  readonly targetDefinition: string | null;
  readonly inputIdentities: readonly CrsIdentity[];
  readonly datumNotes: readonly string[];
  /** 平面身份直接在原坐标上计算（不做变换）。度量时给出坐标单位到米的系数。 */
  readonly planar: boolean;
  readonly planarUnitToMeter?: number;
  /** 未声明坐标系上的距离：数值是坐标原值，不是米。 */
  readonly coordinateUnits?: boolean;
}

/** 图层的变换定义。4326/3857 用注册名，其余用 WKT；没有 WKT 就是 null。 */
export function transformDefinitionOf(input: CrsLayerInput): string | null {
  const identity = input.identity;
  if (identity.kind !== "known") return null;
  if (LOCAL_EPSG.has(identity.epsg)) return `EPSG:${identity.epsg}`;
  return input.wkt;
}

function canTransformDefs(fromDef: string | null, toDef: string | null): boolean {
  if (fromDef === null || toDef === null) return false;
  if (fromDef === toDef) return true;
  return parsableDefinition(fromDef) && parsableDefinition(toDef);
}

/** 属性查询和统计不是空间运算，未知坐标系也允许。空间运算只在可变换的已知坐标系上继续。 */
export function planCrsExecution(inputs: readonly CrsLayerInput[], spatial: boolean, operation = ""): CrsExecutionPlan {
  const identities = inputs.map((item) => item.identity);
  const comparison = compareCrs(identities);
  const inherited = identities[0] ?? unknownCrs();
  const planarInPlay = identities.some((item) => item.kind === "planar");
  const planarDeny = (failureReason: string): CrsExecutionPlan => ({
    comparison,
    spatial,
    allow: false,
    resultIdentity: inherited,
    resultCrs: null,
    failureReason,
    targetEpsg: null,
    targetDefinition: null,
    inputIdentities: identities,
    datumNotes: [],
    planar: false,
  });
  if (!spatial) {
    return {
      comparison,
      spatial,
      allow: true,
      resultIdentity: inherited,
      resultCrs: inherited.kind === "known" ? inherited.canonical : null,
      targetEpsg: inherited.kind === "known" ? inherited.epsg : null,
      targetDefinition: null,
      inputIdentities: identities,
      datumNotes: [],
      planar: false,
    };
  }
  // 平面身份（局部/工程坐标系）：同一段定义才继续；纯平面构造与平面度量直接在原坐标上算。
  if (planarInPlay) {
    const first = identities.find((item): item is PlanarCrsIdentity => item.kind === "planar");
    const allSamePlanar = first !== undefined
      && identities.every((item) => item.kind === "planar" && item.raw === first.raw);
    if (!allSamePlanar) return planarDeny(CRS_PLANAR_MIXED);
    if (PLANAR_PROJECTED_METER_OPERATIONS.has(operation)) {
      const factor = projectedMeterFactor(inputs[0]?.wkt ?? first.raw);
      if (factor === null) return planarDeny(CRS_PLANAR_LIMITED);
      return {
        comparison,
        spatial,
        allow: true,
        resultIdentity: first,
        resultCrs: "planar",
        targetEpsg: null,
        targetDefinition: null,
        inputIdentities: identities,
        datumNotes: [],
        planar: true,
        planarUnitToMeter: factor,
      };
    }
    if (!PLANAR_OK_OPERATIONS.has(operation)) return planarDeny(CRS_PLANAR_LIMITED);
    let planarUnitToMeter: number | undefined;
    if (PLANAR_MEASURE_OPERATIONS.has(operation)) {
      const factor = planarUnitToMeterFrom(inputs[0]?.wkt ?? first.raw);
      if (factor === null) return planarDeny(CRS_PLANAR_NO_UNIT);
      planarUnitToMeter = factor;
    }
    return {
      comparison,
      spatial,
      allow: true,
      resultIdentity: first,
      resultCrs: "planar",
      targetEpsg: null,
      targetDefinition: null,
      inputIdentities: identities,
      datumNotes: [],
      planar: true,
      ...(planarUnitToMeter !== undefined ? { planarUnitToMeter } : {}),
    };
  }
  if (comparison === "unknown") {
    const allUnknown = identities.length > 0 && identities.every((item) => item.kind === "unknown");
    if (allUnknown && UNKNOWN_COORDINATE_DISTANCE_OPERATIONS.has(operation)) {
      return {
        comparison,
        spatial,
        allow: true,
        resultIdentity: inherited,
        resultCrs: null,
        targetEpsg: null,
        targetDefinition: null,
        inputIdentities: identities,
        datumNotes: [],
        planar: true,
        planarUnitToMeter: 1,
        coordinateUnits: true,
      };
    }
    if (allUnknown && UNKNOWN_COPY_OPERATIONS.has(operation)) {
      return {
        comparison,
        spatial,
        allow: true,
        resultIdentity: inherited,
        resultCrs: null,
        targetEpsg: null,
        targetDefinition: null,
        inputIdentities: identities,
        datumNotes: [],
        planar: true,
      };
    }
    return {
      comparison,
      spatial,
      allow: false,
      resultIdentity: inherited,
      resultCrs: null,
      failureReason: CRS_UNKNOWN_SPATIAL,
      targetEpsg: null,
      targetDefinition: null,
      inputIdentities: identities,
      datumNotes: [],
      planar: false,
    };
  }
  if (comparison === "invalid") {
    return {
      comparison,
      spatial,
      allow: false,
      resultIdentity: inherited,
      resultCrs: null,
      failureReason: CRS_INVALID,
      targetEpsg: null,
      targetDefinition: null,
      inputIdentities: identities,
      datumNotes: [],
      planar: false,
    };
  }
  const targetInput = inputs[0];
  if (!targetInput || targetInput.identity.kind !== "known") {
    return {
      comparison,
      spatial,
      allow: false,
      resultIdentity: inherited,
      resultCrs: null,
      failureReason: CRS_UNKNOWN_SPATIAL,
      targetEpsg: null,
      targetDefinition: null,
      inputIdentities: identities,
      datumNotes: [],
      planar: false,
    };
  }
  const target = targetInput.identity;
  const datumNotes: string[] = [];
  for (const item of inputs) {
    const identity = item.identity;
    if (identity.kind !== "known") continue;
    if (LOCAL_EPSG.has(identity.epsg)) continue;
    const wkt = item.wkt;
    if (wkt === null) {
      return {
        comparison,
        spatial,
        allow: false,
        resultIdentity: target,
        resultCrs: null,
        failureReason: `坐标系 EPSG:${identity.epsg} ${CRS_NO_DEFINITION}`,
        targetEpsg: null,
        targetDefinition: null,
        inputIdentities: identities,
        datumNotes,
        planar: false,
      };
    }
    const gate = datumGate(wkt);
    if (!gate.ok) {
      return {
        comparison,
        spatial,
        allow: false,
        resultIdentity: target,
        resultCrs: null,
        failureReason: `坐标系 EPSG:${identity.epsg} ${gate.reason}，${CRS_DATUM_STRICT}`,
        targetEpsg: null,
        targetDefinition: null,
        inputIdentities: identities,
        datumNotes,
        planar: false,
      };
    }
    if (gate.note !== undefined) datumNotes.push(gate.note);
    if (!parsableDefinition(wkt)) {
      return {
        comparison,
        spatial,
        allow: false,
        resultIdentity: target,
        resultCrs: null,
        failureReason: `坐标系 EPSG:${identity.epsg} ${CRS_NO_DEFINITION}`,
        targetEpsg: null,
        targetDefinition: null,
        inputIdentities: identities,
        datumNotes,
        planar: false,
      };
    }
  }
  const targetDef = transformDefinitionOf(targetInput);
  if (target.epsg !== WORKING_EPSG && !canTransformDefs(targetDef, "EPSG:4326")) {
    return {
      comparison,
      spatial,
      allow: false,
      resultIdentity: target,
      resultCrs: null,
      failureReason: `坐标系 EPSG:${target.epsg} ${CRS_NO_DEFINITION}`,
      targetEpsg: null,
      targetDefinition: null,
      inputIdentities: identities,
      datumNotes,
      planar: false,
    };
  }
  for (const item of inputs) {
    if (item === targetInput) continue;
    const epsg = item.identity.kind === "known" ? item.identity.epsg : null;
    if (!canTransformDefs(transformDefinitionOf(item), targetDef)) {
      return {
        comparison,
        spatial,
        allow: false,
        resultIdentity: target,
        resultCrs: null,
        failureReason: `坐标系 ${epsg === null ? "输入图层" : `EPSG:${epsg}`} 到 EPSG:${target.epsg} ${CRS_NO_DEFINITION}`,
        targetEpsg: null,
        targetDefinition: null,
        inputIdentities: identities,
        datumNotes,
        planar: false,
      };
    }
  }
  const stayOnSource = SOURCE_COORDINATE_OPERATIONS.has(operation);
  const sourceUnit = stayOnSource && target.epsg !== 4326 && typeof targetInput.wkt === "string"
    ? planarUnitToMeterFrom(targetInput.wkt)
    : null;
  return {
    comparison,
    spatial,
    allow: true,
    resultIdentity: target,
    resultCrs: target.canonical,
    targetEpsg: stayOnSource ? null : target.epsg,
    targetDefinition: stayOnSource ? null : transformDefinitionOf(targetInput),
    inputIdentities: identities,
    datumNotes,
    planar: stayOnSource,
    ...(sourceUnit !== null && sourceUnit !== undefined ? { planarUnitToMeter: sourceUnit } : {}),
  };
}

export function inheritedCrsLabel(identity: CrsIdentity): string {
  return crsLabelFor(identity);
}

/** 调用方没给坐标系时不算冲突。给了并且和图层库不一致就拒绝，不改图层。 */
export function callerConflicts(layer: CrsIdentity, caller: CrsIdentity): boolean {
  if (caller.kind === "unknown") return false;
  return !crsAgrees(layer, caller);
}
