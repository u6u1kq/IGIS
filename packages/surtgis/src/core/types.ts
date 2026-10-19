// SPDX-License-Identifier: Apache-2.0

import type { Geometry } from "geojson";

/** 内核里的要素属性。只允许标量，几何不进属性。 */
export type CoreScalarProps = Record<string, string | number | boolean | null>;

export interface CoreFeature {
  type: "Feature";
  properties: CoreScalarProps;
  geometry: Geometry;
}

export interface CoreCollection {
  type: "FeatureCollection";
  features: CoreFeature[];
}

export type CoreDistanceUnit = "meters" | "kilometers" | "miles" | "feet" | "degrees";

export type CoreGeometryKind = "point" | "line" | "polygon";

/** 单个算子的结果。notes 只写序号和原因，不写坐标。 */
export interface CoreOpResult {
  readonly collection: CoreCollection;
  readonly skipped: number;
  readonly notes: readonly string[];
  readonly corrupt: boolean;
}

export type GeometryIssueKind = "empty" | "invalid" | "self-intersection" | "mixed";

/** 逐要素的几何问题。message 是给用户看的中文。 */
export interface GeometryIssue {
  readonly featureIndex: number;
  readonly kind: GeometryIssueKind;
  readonly message: string;
}

/** 图层样式。颜色、宽度、透明度、显隐，以及按字段分类设色和单字段注记。不含几何。 */
export interface LayerStyle {
  readonly fill: string;
  readonly outline: string;
  readonly width: number;
  readonly opacity: number;
  readonly visible: boolean;
  /** 按该字段的取值分类设色。空表示使用单一填充色。 */
  readonly colorField: string | null;
  /** 用该字段的文字做注记。空表示不注记。 */
  readonly labelField: string | null;
}
