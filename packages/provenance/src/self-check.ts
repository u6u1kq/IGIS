// SPDX-License-Identifier: Apache-2.0

import { rm, writeFile } from "node:fs/promises";
import { ProvenanceLedgerError } from "./guard.js";
import { hashSourceContent } from "./hash.js";
import { InMemoryProvenanceLedger, buildProvenanceRecord, readProvenanceDirectory } from "./ledger.js";
import { PROVENANCE_FORBIDDEN_FIELDS } from "./record.js";
import type { ProvenanceRecord } from "./record.js";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** 不写盘。导入本包不会自动执行。 */
export async function runProvenanceSelfCheck(): Promise<void> {
  const hash = hashSourceContent("");
  if (hash !== EMPTY_SHA256) {
    throw new Error("SHA-256 自检失败。");
  }
  const bytes = new Uint8Array([97]);
  if (hashSourceContent("a") !== hashSourceContent(bytes)) {
    throw new Error("字符串与字节摘要不一致。");
  }
  let rejected = false;
  try {
    buildProvenanceRecord({
      sourceContent: "demo",
      exportPath: null,
      layerNames: ["roads"],
      nested: { lat: 1 },
    } as unknown as Parameters<typeof buildProvenanceRecord>[0]);
  } catch (error) {
    rejected = error instanceof ProvenanceLedgerError && error.code === "forbidden-geometry";
  }
  if (!rejected) throw new Error("嵌套几何字段未被拒绝。");
  const record = buildProvenanceRecord({
    sourceContent: "",
    exportPath: "out/demo.gpkg",
    layerNames: ["roads"],
    recordedAt: "2026-10-02T00:00:00.000Z",
  });
  if (record.sourceContentHash !== hash || record.readOnly !== true) {
    throw new Error("账本记录内容错误。");
  }
  for (const key of Object.keys(record)) {
    if ((PROVENANCE_FORBIDDEN_FIELDS as readonly string[]).includes(key)) {
      throw new Error("账本记录写入了禁止字段。");
    }
  }
  const ledger = new InMemoryProvenanceLedger();
  await ledger.append(record);
  const poisoned = {
    ...record,
    recordId: "prov-reject",
    coordinates: [1, 2],
  } as ProvenanceRecord;
  let appendRejected = false;
  try {
    await ledger.append(poisoned);
  } catch (error) {
    appendRejected = error instanceof ProvenanceLedgerError && error.code === "forbidden-geometry";
  }
  if (!appendRejected) throw new Error("账本接受了几何字段。");
  const listed = await ledger.list();
  if (listed.length !== 1) throw new Error("被拒绝的记录仍被写入。");
}

/** 读写 var 之外的临时目录。调用方负责传入目录。结束时删除该目录。 */
export async function runProvenancePersistenceSelfCheck(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
  const ledger = new InMemoryProvenanceLedger({ persistJson: true, directory });
  const record = buildProvenanceRecord({
    sourceContent: "persistence",
    exportPath: null,
    layerNames: ["roads"],
    recordedAt: "2026-10-02T00:00:00.000Z",
    recordId: "prov-disk-1",
  });
  await ledger.append(record);
  const reloaded = new InMemoryProvenanceLedger({ persistJson: true, directory });
  await reloaded.load();
  const listed = await reloaded.list();
  const first = listed[0];
  if (listed.length !== 1 || first?.sourceContentHash !== record.sourceContentHash || first.exportPath !== null) {
    throw new Error("账本落盘后读回的内容不一致。");
  }
  const dumped = JSON.stringify(first);
  if (dumped.includes("extent") || dumped.includes("coordinates") || dumped.includes("wkt")) {
    throw new Error("落盘记录含有几何字段名。");
  }
  let rejected = false;
  try {
    await ledger.append({
      ...record,
      recordId: "prov-disk-reject",
      nested: { lat: 1 },
    } as ProvenanceRecord);
  } catch (error) {
    rejected = error instanceof ProvenanceLedgerError && error.code === "forbidden-geometry";
  }
  if (!rejected) throw new Error("写盘前没有拒绝嵌套几何键。");
  await writeFile(
    `${directory.replace(/[\\/]+$/, "")}/poison.json`,
    `${JSON.stringify({ ...record, recordId: "prov-poison", nested: { bbox: [0, 0, 1, 1] } })}\n`,
    { encoding: "utf8" },
  );
  let readRejected = false;
  try {
    await readProvenanceDirectory(directory);
  } catch (error) {
    readRejected = error instanceof ProvenanceLedgerError && error.code === "forbidden-geometry";
  }
  if (!readRejected) throw new Error("读盘时没有拒绝嵌套几何键。");
  await rm(directory, { recursive: true, force: true });
}
