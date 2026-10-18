// SPDX-License-Identifier: Apache-2.0

import { PROVENANCE_FORBIDDEN_FIELDS } from "@igis/provenance";
import { findForbiddenPayloadKey } from "@igis/shared-types";
import { LlmInvokeError } from "./errors.js";

/**
 * 发给模型或从模型收回的载荷检查。
 * 禁止字段与来源账本的 PROVENANCE_FORBIDDEN_FIELDS 相同，并额外拒绝 WKT / GeoJSON 文本。
 * 只接受标量和不透明句柄。命中时不发起网络请求。
 */
const ORDINARY_GEOMETRY_KEYS = new Set([
  "coordinates", "coordinate", "wkt", "wkb", "geojson", "geometry", "geom", "rings", "paths", "points", "x", "y", "lat", "lon", "latitude", "longitude",
]);

export function assertLlmPayload(value: unknown, ordinaryGeometry = false): void {
  const forbidden = ordinaryGeometry
    ? PROVENANCE_FORBIDDEN_FIELDS.filter((key) => !ORDINARY_GEOMETRY_KEYS.has(key))
    : PROVENANCE_FORBIDDEN_FIELDS;
  const hit = findForbiddenPayloadKey(value, forbidden, !ordinaryGeometry);
  if (hit) {
    throw new LlmInvokeError("geometry-rejected", `模型载荷含有几何字段: ${hit}`);
  }
}
