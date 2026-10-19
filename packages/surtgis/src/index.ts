// SPDX-License-Identifier: Apache-2.0

/**
 * SurtGIS 矢量内核：几何校验、缓冲、相交、裁剪和统一图层库。
 * 没有栅格算法接口。栅格能力走外部 GDAL 桥。
 */

/** 矢量内核只覆盖缓冲、相交、裁剪、几何校验和图层库。 */

export { SurtGisCoreError } from "./core/errors.js";
export type {
  CoreCollection,
  CoreDistanceUnit,
  CoreFeature,
  CoreGeometryKind,
  CoreOpResult,
  CoreScalarProps,
  GeometryIssue,
  GeometryIssueKind,
  LayerStyle,
} from "./core/types.js";
export {
  BUFFER_CAP,
  PAIR_CAP,
  bufferFeatures,
  clipFeatures,
  finishResult,
  intersectFeatures,
  isPolygonal,
  safeValid,
  simplifyFeatures,
  stampFeature,
  unionMask,
} from "./core/overlay.js";
export { geometryKindOfType, inspectFeature, isUnusableIssue, validateCollection } from "./core/validate.js";
export type { CollectionInspection } from "./core/validate.js";
export {
  DEFAULT_CRS_LABEL,
  LAYER_STORE_STATE_FILE,
  LayerStore,
  defaultLayerStyle,
  fieldNamesOf,
  geometryKindOf,
  mergeLayerStyle,
  samePath,
} from "./core/layer-store.js";
export type { LayerMeta, LayerStyleInput } from "./core/layer-store.js";
export {
  acceptCrsIdentity,
  compareCrs,
  crsAgrees,
  crsLabelFor,
  epsgFromWkt,
  identifyCrs,
  invalidCrs,
  planarCrs,
  resolveStoredCrs,
  unknownCrs,
} from "./core/crs-identity.js";
export {
  aeqdDefinition,
  canTransformLocally,
  datumGate,
  parsableDefinition,
  planarUnitToMeter,
  transformCollection,
  transformViaDefinitions,
} from "./core/crs-transform.js";
export type { DatumGateResult } from "./core/crs-transform.js";
export type {
  CrsComparison,
  CrsIdentity,
  IdentifyCrsOptions,
  InvalidCrsIdentity,
  KnownCrsIdentity,
  PlanarCrsIdentity,
  UnknownCrsIdentity,
} from "./core/crs-identity.js";
