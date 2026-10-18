// SPDX-License-Identifier: Apache-2.0

import type {
  CoreCollection,
  CoreDistanceUnit,
  CoreFeature,
  CoreOpResult,
  CoreScalarProps,
  GeometryIssue,
} from "@igis/surtgis";

/** V0.7 起这些类型来自 SurtGIS 内核，形状与 V0.5 相同。 */
export type ScalarProps = CoreScalarProps;

export type MapFeature = CoreFeature;

export type MapCollection = CoreCollection;

export type DistanceUnit = CoreDistanceUnit;

export type QueryKind = "attribute" | "point-in-polygon" | "intersects";

export interface PublicMapLayer {
  readonly layerId: string;
  readonly layerName: string;
  readonly featureCount: number;
  readonly fieldNames: readonly string[];
  readonly mapUrl: string;
  readonly message: string;
  /** V0.7 追加。逐要素几何问题，只有序号和中文原因。 */
  readonly geometryIssues?: readonly GeometryIssue[];
}

export type OpResult = CoreOpResult;

export interface StatsResult {
  readonly featureCount: number;
  readonly fieldName: string | null;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly mean: number | null;
  readonly coordinateField: boolean;
  readonly numericCount: number;
}
