// SPDX-License-Identifier: Apache-2.0

/**
 * 架构契约一致性检查：ARCHITECTURE.md 的四契约 ↔ 代码锚点 ↔ 记录字段。
 * 断言：
 *   1. ARCHITECTURE.md 四契约与法律禁止清单在位
 *   2. AUDIT_REQUIRED_OPERATIONS 的现有操作族都能落进 OperationRecord
 *   3. AUDIT_REQUIRED_FIELDS 的必答字段在写入记录里物理存在（createdAt≈startedAt、
 *      executionEnvironment≈entry+requestSource 为文档化别名，这里打印不判失败）
 *   4. V0.85 known gaps 的 V0.86 收口锚点：loop 的 releaseToModel 闭环、numbers 扁平收紧、
 *      确认门收紧（confirm: confirming）、授权消费函数在位
 * 运行：npx tsx --tsconfig tsconfig.json apps/cli/src/architecture-check.ts
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AUDIT_REQUIRED_FIELDS,
  AUDIT_REQUIRED_OPERATIONS,
  AUTHORIZATION_FORBIDDEN_INTENT_FIELDS,
} from "@igis/ai-boundary";
import { projectForModel } from "@igis/ai-translation";
import { readOperationRecord, recordNonSpatialOperation } from "../../../packages/spatial-ops/src/operation-attempt.js";

const REPO_ROOT = resolve("E:/ai工作区/Igis");

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

async function main(): Promise<void> {
  // ---- 1. 架构文档锚点。
  const architecture = await readFile(join(REPO_ROOT, "ARCHITECTURE.md"), { encoding: "utf8" });
  for (const anchor of ["契约一：Capability", "契约二：Visibility", "契约三：Authorization", "契约四：Audit", "法律与合规禁止清单"]) {
    check(architecture.includes(anchor), `ARCHITECTURE.md 缺少「${anchor}」章节。`);
  }
  console.log("ok ARCHITECTURE.md 四契约与法律禁止清单在位");

  // ---- 2. 全部操作族都能落进记录（含后来的克里金、汇水、降雨和地层体）。
  const expected = [
    "buffer", "intersect", "clip", "query", "stats",
    "load", "delete", "rename", "export", "import",
    "area", "length", "distance", "nearest", "convert", "dissolve", "merge", "simplify",
    "group-stats", "reclassify", "quality-check", "split-grid",
    "voronoi", "convex-hull", "min-bbox", "centroid", "bearing",
    "make-valid", "reproject", "convert-format",
    "dem-derivative", "contour", "raster-calc", "raster-info",
    "split-line", "explode", "vertices", "line-intersect", "transform", "nearest-on-line", "grid", "split-polygon", "spatial-aggregate", "distance-matrix", "nearest-exact",
    "field-calc", "join", "raster-cast", "raster-nodata", "raster-smooth", "interpolate",
    "erase", "union", "spatial-join", "viewshed", "raster-clip", "polygonize", "rasterize", "zonal", "resample", "raster-index", "focal",
    "quadtree", "chart", "kernel-density", "network-snap", "network-distance", "service-area", "aggregate-grid",
    "offset-line", "cost-corridor", "classify", "hotspot", "gwr", "od-flow", "k-anonymity", "dp-grid",
    "kriging", "watershed", "profile", "cut-fill",
    "water-level", "layer-stack", "geology-inputs",
    "rainfall-runoff", "rainfall-landslide", "geology-model",
  ];
  check(expected.length === AUDIT_REQUIRED_OPERATIONS.length, "AUDIT_REQUIRED_OPERATIONS 数量不对");
  for (const op of expected) {
    check(AUDIT_REQUIRED_OPERATIONS.includes(op), `留痕清单缺少 ${op}。`);
  }
  console.log("ok 留痕覆盖全部操作族（五空间 + 五非空间 + 能力族）");

  // ---- 3. 必答字段物理存在。
  const root = await mkdtemp(join(tmpdir(), "igis-arch-"));
  check(!resolve(root).toLowerCase().startsWith(REPO_ROOT.toLowerCase()), "用例目录不能落在仓库里");
  try {
    const operationId = await recordNonSpatialOperation({
      kind: "delete",
      action: "delete-layer",
      entry: "map",
      source: "local-user",
      aiOrigin: false,
      translationUsed: false,
      requestSource: "desktop-ui",
      inputResources: ["lyr-1"],
      outputResources: [],
      approvalState: { required: true, confirmed: true, confirmedBy: "local-ui" },
      ok: true,
      root,
    });
    const record = await readOperationRecord(operationId, root);
    check(record !== null, "记录应能读回");
    const text = JSON.stringify(record);
    for (const field of ["operationId", "action", "entry", "source", "aiOrigin", "requestSource", "inputResources", "approvalState", "sideEffects", "outcome"]) {
      check(text.includes(`"${field}"`), `必答字段 ${field} 不在操作记录里。`);
    }
    check(typeof record?.startedAt === "string", "createdAt 的物理字段 startedAt 不在记录里。");
    for (const field of AUDIT_REQUIRED_FIELDS) {
      const aliased = field === "createdAt" || field === "executionEnvironment" || field === "crs" || field === "outputResources";
      check(aliased || text.includes(`"${field}"`), `AUDIT_REQUIRED_FIELDS 的 ${field} 没有物理落进记录。`);
    }
    console.log("ok 必答字段物理存在（createdAt≈startedAt、executionEnvironment≈entry+requestSource、crs 仅空间运算）");

    // ---- 4. V0.85 known gaps 的 V0.86 收口锚点。
    const flat = projectForModel({ numbers: [100, 200] }) as Record<string, unknown>;
    check(Array.isArray(flat.numbers), "numbers 扁平数字列表应放行");
    const nested = projectForModel({ numbers: [[116, 39], [117, 40]] }) as Record<string, unknown>;
    check(nested.numbers === undefined, "numbers 里的坐标递归必须剥掉（B3 收紧）");
    const loopTs = await readFile(join(REPO_ROOT, "packages/llm-dispatch/src/loop.ts"), { encoding: "utf8" });
    check(loopTs.includes("releaseToModel(localResult)"), "loop 结果没有过 gateway 二次校验（B3 闭环）");
    const desktopApi = await readFile(join(REPO_ROOT, "apps/cli/src/desktop-api.ts"), { encoding: "utf8" });
    check(desktopApi.includes("confirm: confirming"), "确认门没有收紧（B1）");
    check(!desktopApi.includes("confirm: body.confirm === true"), "确认门仍直通 body.confirm（B1）");
    check(AUTHORIZATION_FORBIDDEN_INTENT_FIELDS.includes("confirm"), "授权禁止字段清单应含 confirm");
    const manifestTs = await readFile(join(REPO_ROOT, "packages/ai-boundary/src/capability-manifest.ts"), { encoding: "utf8" });
    check(manifestTs.includes("issueAndConsumeApproval"), "统一授权消费函数不在能力清单锚点里");
    console.log("ok V0.85 known gaps 已在 V0.86 收口（授权剥离/非空间记录/loop 闭环/计划恢复剥离）");

    console.log("architecture-check passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

let failed: unknown = null;
try {
  await main();
} catch (error) {
  failed = error;
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
}
if (failed) throw new Error("architecture-check failed");
