// SPDX-License-Identifier: Apache-2.0

import type { Geometry } from "geojson";

export type GdlGeometryKind = "point" | "line" | "polygon" | "mixed";

export type GdlFieldType = "TEXT" | "INT" | "REAL" | "BOOL";

export type GdlScalar = string | number | boolean | null;

export type GdlUnit = "meters" | "kilometers" | "miles" | "feet" | "degrees";

export interface GdlStylePatch {
  fill?: string;
  outline?: string;
  width?: number;
  opacity?: number;
  visible?: boolean;
  order?: number;
}

export interface GdlField {
  readonly name: string;
  readonly type: GdlFieldType;
  readonly line: number;
}

export interface GdlFeature {
  readonly line: number;
  readonly attributes: Readonly<Record<string, GdlScalar>>;
  readonly geometry: Geometry;
}

export interface GdlLayerStatement {
  readonly kind: "layer";
  readonly line: number;
  readonly name: string;
  readonly geometry: GdlGeometryKind | null;
  readonly crs: string | null;
  readonly fields: readonly GdlField[];
  readonly style: Readonly<GdlStylePatch>;
  readonly features: readonly GdlFeature[];
  /** 摘要里的 FEATURES n。载入时忽略。 */
  readonly featureCountHint: number | null;
}

export interface GdlStyleStatement {
  readonly kind: "style";
  readonly line: number;
  readonly layer: string;
  readonly style: Readonly<GdlStylePatch>;
}

export interface GdlBufferStatement {
  readonly kind: "buffer";
  readonly line: number;
  readonly input: string;
  readonly distance: number;
  readonly unit: GdlUnit;
  readonly unitText: string;
  readonly output: string;
}

export interface GdlOverlayStatement {
  readonly kind: "intersect" | "clip";
  readonly line: number;
  readonly input: string;
  readonly other: string;
  readonly output: string;
}

/** 属性筛选查询：QUERY 图层 WITH 筛选文字 AS 结果图层。 */
export interface GdlQueryStatement {
  readonly kind: "query";
  readonly line: number;
  readonly input: string;
  readonly filter: string;
  readonly output: string;
}

/** 字段统计：STATS 图层 ON 字段。不出图层，只出数字摘要。 */
export interface GdlStatsStatement {
  readonly kind: "stats";
  readonly line: number;
  readonly input: string;
  readonly field: string | null;
}

/** 度量：MEASURE AREA|LENGTH 图层，或 MEASURE DISTANCE 甲 TO 乙。不出图层，只出数字摘要。 */
export interface GdlMeasureStatement {
  readonly kind: "measure";
  readonly line: number;
  readonly measure: "area" | "length" | "distance";
  readonly input: string;
  readonly other: string | null;
}

export type GdlStatement =
  | GdlLayerStatement
  | GdlStyleStatement
  | GdlBufferStatement
  | GdlOverlayStatement
  | GdlQueryStatement
  | GdlStatsStatement
  | GdlMeasureStatement;

export interface GdlProgram {
  readonly statements: readonly GdlStatement[];
}
