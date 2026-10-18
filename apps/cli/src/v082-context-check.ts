// SPDX-License-Identifier: Apache-2.0

/**
 * V0.82 执行上下文隔离检查。
 * callerCrs 与 requestSource 必须随各自的异步链路传播：
 * 并发操作交错时审计归属不能串，callerCrs 冲突检查不能读到别的操作的值。
 * 只用操作系统临时目录，不读仓库 var/，不监听端口。
 * 运行：npx tsx --tsconfig tsconfig.json apps/cli/src/v082-context-check.ts
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openSpatialStack } from "@igis/spatial-ops";
import type { SpatialStack } from "@igis/spatial-ops";
import type { MapCollection } from "@igis/spatial-ops";

const REPO_ROOT = resolve("E:/ai工作区/Igis");

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

/** 手动闸门：让另一个操作停在它自己的上下文窗口里，制造确定性交错。 */
function makeGate(): { readonly promise: Promise<void>; release(): void } {
  let release = (): void => {};
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}

function square(name: string): MapCollection {
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { name },
      geometry: { type: "Polygon", coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]] },
    }],
  };
}

async function auditRecordOf(stack: SpatialStack, recordId: string | null | undefined) {
  if (typeof recordId !== "string" || recordId === "") throw new Error("这次操作没有写审计。");
  const listed = await stack.audit.list();
  const found = listed.find((item) => item.recordId === recordId);
  if (!found) throw new Error(`找不到审计记录 ${recordId}。`);
  return found;
}

async function openAt(root: string, name: string): Promise<SpatialStack> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  check(resolve(dir).toLowerCase().startsWith(resolve(root).toLowerCase()), "用例目录必须在临时目录里");
  check(!resolve(dir).toLowerCase().startsWith(REPO_ROOT.toLowerCase()), "用例目录不能落在仓库里");
  return openSpatialStack({
    layerDirectory: join(dir, "layers"),
    auditDirectory: join(dir, "audit"),
    cacheDirectory: join(dir, "cache"),
    modelName: () => "v082-context-check",
  });
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "igis-v082-"));
  try {
    const stack = await openAt(root, "case");
    const service = stack.service;
    const inserted = await stack.catalog.insert({
      layerName: "甲面",
      sourcePaths: ["v082-fixture"],
      collection: square("甲面"),
      crsLabel: "EPSG:4326",
    });
    const layerId = inserted.layerId;

    // 1. 并发 requestSource：A(desktop-ui) 在 B(cloud-ai) 的窗口内恢复执行，
    //    A 的审计必须仍是 desktop-ui，B 的必须是 cloud-ai。
    {
      const gate = makeGate();
      const aPromise = service.usingRequestSource("desktop-ui", async () => {
        await delay(15);
        const result = await service.stats(layerId, null, false);
        gate.release();
        return result.auditRecordId;
      });
      const bPromise = service.usingRequestSource("cloud-ai", async () => {
        await delay(3);
        await gate.promise;
        const result = await service.stats(layerId, null, false);
        return result.auditRecordId;
      });
      const [aId, bId] = await Promise.all([aPromise, bPromise]);
      const aRecord = await auditRecordOf(stack, aId);
      const bRecord = await auditRecordOf(stack, bId);
      check(aRecord.requestSource === "desktop-ui", `并发时 A 的审计归属被串成了 ${String(aRecord.requestSource)}`);
      check(bRecord.requestSource === "cloud-ai", `并发时 B 的审计归属被串成了 ${String(bRecord.requestSource)}`);
    }

    // 2. 并发 callerCrs：A 声明 4326 且图层是 4326，应成功；
    //    B 声明 3857 停在自己的窗口里，不能把 A 的冲突检查带偏。
    {
      const gate = makeGate();
      const aPromise = service.usingCallerCrs("EPSG:4326", async () => {
        try {
          await delay(15);
          const result = await service.buffer(layerId, 10, "meters", false);
          gate.release();
          return result.ok;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`并发时 A 的缓冲被错误拒绝：${message}`);
        }
      });
      const bPromise = service.usingCallerCrs("EPSG:3857", async () => {
        await delay(3);
        await gate.promise;
      });
      const [okA] = await Promise.all([aPromise, bPromise]);
      check(okA === true, "并发 callerCrs 下与图层一致的声明仍应允许缓冲。");
    }

    // 3. 嵌套语义：外层 callerCrs、内层 requestSource，两个上下文同时可见。
    {
      const nestedId = await service.usingCallerCrs("EPSG:4326", () =>
        service.usingRequestSource("mcp", async () => {
          const result = await service.stats(layerId, null, false);
          return result.auditRecordId;
        }),
      );
      const nestedRecord = await auditRecordOf(stack, nestedId);
      check(nestedRecord.requestSource === "mcp", "嵌套内层的 requestSource 应写入审计。");
    }
    {
      // 反向嵌套：外层 requestSource、内层 callerCrs，缓冲不冲突且审计带外层来源。
      const outerId = await service.usingRequestSource("internal", () =>
        service.usingCallerCrs("EPSG:4326", async () => {
          const result = await service.buffer(layerId, 10, "meters", false, "嵌套缓冲");
          return result.auditRecordId;
        }),
      );
      const outerRecord = await auditRecordOf(stack, outerId);
      check(outerRecord.requestSource === "internal", "内层 callerCrs 不应冲掉外层 requestSource。");
    }

    // 4. 兼容性：不包 usingXxx 直接调用服务时，审计没有 requestSource，行为与修复前一致。
    {
      const plain = await service.stats(layerId, null, false);
      const plainRecord = await auditRecordOf(stack, plain.auditRecordId);
      check(plainRecord.requestSource === undefined, "没有上下文时审计不应带 requestSource。");
    }

    console.log("v082-context-check passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
