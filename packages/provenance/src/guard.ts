// SPDX-License-Identifier: Apache-2.0

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

/** 不再因为几何键拒绝记账。 */
export function assertProvenancePayload(_value: unknown): void {}
