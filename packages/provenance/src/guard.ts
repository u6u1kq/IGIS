// SPDX-License-Identifier: Apache-2.0

import { findForbiddenPayloadKey } from "@igis/shared-types";
import { PROVENANCE_FORBIDDEN_FIELDS } from "./record.js";

export class ProvenanceLedgerError extends Error {
  readonly code: "forbidden-geometry" | "invalid-record";
  readonly fieldPath: string | null;
  constructor(code: "forbidden-geometry" | "invalid-record", fieldPath: string | null) {
    super(
      code === "forbidden-geometry"
        ? `来源账本拒绝几何字段: ${fieldPath ?? "payload"}`
        : `来源账本记录无效: ${fieldPath ?? "record"}`,
    );
    this.name = "ProvenanceLedgerError";
    this.code = code;
    this.fieldPath = fieldPath;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 拒绝载荷树中任何一层出现的几何键。二进制内容不按键扫描。 */
export function assertProvenancePayload(value: unknown): void {
  const hit = findForbiddenPayloadKey(value, PROVENANCE_FORBIDDEN_FIELDS, false);
  if (hit) throw new ProvenanceLedgerError("forbidden-geometry", hit);
}
