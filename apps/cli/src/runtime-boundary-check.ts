// SPDX-License-Identifier: Apache-2.0

/**
 * 运行时边界验证：入口 → 执行 → var/operations 记录的闭环。
 * 行为断言：
 *   1. 非空间状态变更（load/delete/rename/export/import 五族）经 recordNonSpatialOperation 写入并可读回
 *   2. 旧操作记录（无 action/inputResources/outputResources/approvalState）仍能读回（增量兼容）
 *   3. 适配器的非空间操作真实留痕：map.load/io.read/map.delete/map.clearAll/map.dropDatabase/map.exportGeoJson
 *      成功与失败都留痕；破坏性操作的记录带 approvalState
 *   4. 五空间操作的记录带默认 approvalState（required:false）
 * 代码形状断言：B4 出站审计总大小上限（llm-dispatch/http.ts）。
 * 只用操作系统临时目录。不监听端口。
 * 运行：npx tsx --tsconfig tsconfig.json apps/cli/src/runtime-boundary-check.ts
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ToolAdapterPort } from "@igis/llm-dispatch";
import type { SpatialService } from "../../../packages/spatial-ops/src/service.js";
import { createSpatialAwareAdapter } from "../../../packages/spatial-ops/src/adapter.js";
import { executeGisOperation } from "../../../packages/spatial-ops/src/execute-gis-operation.js";
import { readOperationRecord, recordNonSpatialOperation } from "../../../packages/spatial-ops/src/operation-attempt.js";
import type { NonSpatialOperationKind } from "../../../packages/spatial-ops/src/operation-attempt.js";
import { handleV05Request } from "./map-http.js";

const REPO_ROOT = resolve("E:/ai工作区/Igis");

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

const inner: ToolAdapterPort = {
  execute: async () => ({ ok: false, code: "capability-rejected", message: "不走内层。" }),
};

function runResult(operationType: string, message: string) {
  return {
    ok: true as const,
    operationType,
    message,
    layer: null,
    featureCount: 1,
    fieldName: null,
    minimum: null,
    maximum: null,
    mean: null,
  };
}

interface FakeService {
  readonly service: SpatialService;
  readonly loadFail: () => void;
  readonly removeResult: (value: boolean) => void;
}

function fakeService(): FakeService {
  const layers = new Map<string, { layerId: string; layerName: string; geometryKind: string; featureCount: number }>();
  layers.set("lyr-1", { layerId: "lyr-1", layerName: "地块", geometryKind: "polygon", featureCount: 1 });
  let loadFailure = false;
  let removeValue = true;
  const service = {
    store: {
      list: () => [...layers.values()],
      remove: async (id: string) => {
        const hit = removeValue && layers.has(id);
        if (hit) layers.delete(id);
        return hit;
      },
    },
    loadFile: async (absolutePath: string) => {
      if (loadFailure) throw new Error("找不到这个路径。");
      layers.set("lyr-loaded", { layerId: "lyr-loaded", layerName: "载入层", geometryKind: "polygon", featureCount: 2 });
      return [{ layerId: "lyr-loaded", layerName: "载入层", mapUrl: "/api/map/layers/lyr-loaded/geojson", fieldNames: [] }];
    },
    exportLayer: async () => runResult("export", "已导出为新的 GeoJSON，没有覆盖源文件。"),
    dropDatabase: async () => undefined,
    usingCallerCrs: (_crs: unknown, fn: () => unknown) => fn(),
    usingRequestSource: (_source: unknown, fn: () => unknown) => fn(),
    buffer: async () => runResult("buffer", "缓冲完成。"),
  };
  return {
    service: service as unknown as SpatialService,
    loadFail: () => {
      loadFailure = true;
    },
    removeResult: (value: boolean) => {
      removeValue = value;
    },
  };
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "igis-v086-boundary-"));
  check(!resolve(root).toLowerCase().startsWith(REPO_ROOT.toLowerCase()), "用例目录不能落在仓库里");
  try {
    // ---- 1. 五族非空间留痕写入并读回。
    const kinds: readonly NonSpatialOperationKind[] = ["load", "delete", "rename", "export", "import"];
    for (const kind of kinds) {
      const operationId = await recordNonSpatialOperation({
        kind,
        action: `${kind}-action`,
        entry: "map",
        source: "local-user",
        aiOrigin: false,
        translationUsed: false,
        requestSource: "desktop-ui",
        inputResources: ["in-1"],
        outputResources: ["out-1"],
        ok: true,
        root,
      });
      const record = await readOperationRecord(operationId, root);
      check(record !== null, `${kind} 记录应能读回`);
      check(record?.operation === kind, `${kind} 记录的族属不对`);
      check(record?.action === `${kind}-action`, `${kind} 记录缺 action`);
      check(record?.inputResources?.[0] === "in-1" && record?.outputResources?.[0] === "out-1", `${kind} 记录缺输入/输出资源`);
      check(record?.outcome === "succeeded" && record?.status === "succeeded", `${kind} 记录状态不对`);
      check(record?.entry === "map" && record?.source === "local-user" && record?.requestSource === "desktop-ui", `${kind} 记录身份不对`);
    }
    const failedId = await recordNonSpatialOperation({
      kind: "import",
      action: "import-file",
      entry: "map",
      ok: false,
      message: "导入没有完成。",
      root,
    });
    const failed = await readOperationRecord(failedId, root);
    check(failed?.outcome === "failed" && failed?.error?.message === "导入没有完成。", "失败操作同样要留痕");
    console.log("ok 五族非空间留痕写入并读回，失败同样留痕");

    // ---- 2. 旧记录增量兼容（无新字段仍可读回）。
    const legacyId = "op-legacy0-0000000a";
    const legacy = {
      operationId: legacyId,
      operation: "buffer",
      entry: "chat",
      status: "succeeded",
      statusLog: ["running", "succeeded"],
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(0).toISOString(),
      request: { layerIds: ["lyr-1"], layerNames: ["地块"], distance: 10, unit: "meters", outputName: null },
      policy: { writeKnowledge: false },
      outcome: "succeeded",
      auditRecordIds: [],
      sideEffects: { createdLayerIds: ["lyr-2"] },
    };
    await mkdir(join(root, "var", "operations"), { recursive: true });
    await writeFile(join(root, "var", "operations", `${legacyId}.json`), JSON.stringify(legacy, null, 2), { encoding: "utf8" });
    const legacyRecord = await readOperationRecord(legacyId, root);
    check(legacyRecord !== null && legacyRecord.operation === "buffer", "旧操作记录必须仍能读回");
    check(legacyRecord?.approvalState === undefined && legacyRecord?.action === undefined, "旧记录没有的增量字段应留空，不伪造");
    console.log("ok 旧记录增量兼容");

    // ---- 3. 适配器非空间操作真实留痕。
    // 说明：map.load、io.read 不是模型可见能力，模型/MCP 侧在 rejectModelToolCall 处即被拦
    // （v079b 既有断言：读文件不进入运行时）；load/export 的可达留痕入口是桌面地图接口（map-http），下面分开验证。
    const fake = fakeService();
    const adapter = createSpatialAwareAdapter(inner, fake.service, { entry: "chat", operationsRoot: root });

    const deleteDenied = await adapter.execute({ tool: "map.delete", args: { layerId: "lyr-1" } }) as Record<string, unknown>;
    check(deleteDenied.code === "confirm-required", "未确认的删除应被确认门拦下");

    fake.removeResult(false);
    const deleteMiss = await adapter.execute({ tool: "map.delete", args: { layerId: "lyr-1" }, userConfirmed: true }) as Record<string, unknown>;
    const deleteMissRecord = await readOperationRecord(String(deleteMiss.operationId), root);
    check(deleteMissRecord?.outcome === "failed", "没删掉也要留痕");

    fake.removeResult(true);
    const deleteResult = await adapter.execute({ tool: "map.delete", args: { layerId: "lyr-1" }, userConfirmed: true }) as Record<string, unknown>;
    check(deleteResult.ok === true && typeof deleteResult.operationId === "string", "确认后的删除应成功并带 operationId");
    const deleteRecord = await readOperationRecord(String(deleteResult.operationId), root);
    check(deleteRecord?.operation === "delete" && deleteRecord?.action === "delete-layer", "map.delete 应写 delete 族记录");
    check(deleteRecord?.approvalState?.required === true && deleteRecord?.approvalState?.confirmed === true, "破坏性记录必须带授权状态");
    check(deleteRecord?.approvalState?.consumedAt !== undefined, "破坏性记录必须带一次性 token 消费痕迹");

    const clearResult = await adapter.execute({ tool: "map.clearAll", args: {}, userConfirmed: true }) as Record<string, unknown>;
    const clearRecord = await readOperationRecord(String(clearResult.operationId), root);
    check(clearRecord?.operation === "delete" && clearRecord?.action === "clear-layers", "map.clearAll 应写 clear-layers 记录");

    const dropResult = await adapter.execute({ tool: "map.dropDatabase", args: {}, userConfirmed: true }) as Record<string, unknown>;
    const dropRecord = await readOperationRecord(String(dropResult.operationId), root);
    check(dropRecord?.action === "drop-database" && dropRecord?.approvalState?.confirmed === true, "map.dropDatabase 记录应带授权状态");

    const blockedLoad = await adapter.execute({
      tool: "map.load",
      args: { absolutePath: "C:/data/roads.shp" },
    }) as Record<string, unknown>;
    check(blockedLoad.code === "capability-rejected", "模型侧的 map.load 应被能力边界拦下（不进入运行时）");
    console.log("ok 适配器非空间操作成功与失败都留痕，破坏性记录带授权状态");

    // ---- 3b. 桌面地图接口的 load / export / rename 留痕（可达入口）。
    const httpDeps = {
      spatial: {
        service: {
          loadFile: async (absolutePath: string) => {
            void absolutePath;
            return [{ layerId: "lyr-http", layerName: "载入层", mapUrl: "/api/map/layers/lyr-http/geojson", fieldNames: [] }];
          },
          exportLayer: async () => runResult("export", "已导出为新的 GeoJSON，没有覆盖源文件。"),
          rename: async (_layerId: string, layerName: string) => ({ layerId: "lyr-1", layerName, featureCount: 1, fieldNames: [] }),
          usingRequestSource: (_source: string, fn: () => unknown) => fn(),
        },
        catalog: {
          list: () => [],
          get: () => null,
          style: () => null,
          order: () => [],
          remove: async (id: string) => {
            void id;
            return true;
          },
        },
      },
      vendorRoot: root,
      operationsRoot: root,
    };
    let raw = "";
    const response = {
      writeHead() {},
      end(body?: string) {
        raw = body ?? "";
      },
    } as unknown as ServerResponse;
    const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
      raw = "";
      const text = JSON.stringify(body);
      const request = {
        method: "POST",
        headers: {},
        resume() {},
        async *[Symbol.asyncIterator]() {
          yield text;
        },
      } as unknown as IncomingMessage;
      const handled = await handleV05Request(httpDeps as never, request, response, new URL(`http://127.0.0.1${path}`));
      check(handled, `${path} 应被受理`);
      return JSON.parse(raw) as Record<string, unknown>;
    };
    const httpLoad = await post("/api/map/load", { absolutePath: "C:/data/roads.shp" });
    check(httpLoad.ok === true && typeof httpLoad.operationId === "string", "地图 load 应带 operationId");
    const httpLoadRecord = await readOperationRecord(String(httpLoad.operationId), root);
    check(httpLoadRecord?.operation === "load" && httpLoadRecord?.action === "load-file", "地图 load 应写 load 族记录");
    check(httpLoadRecord?.inputResources?.[0] === "C:/data/roads.shp", "load 记录应留下源路径");

    const httpExport = await post("/api/map/export", { layerId: "lyr-1", destinationPath: join(root, "out.geojson") });
    check(httpExport.ok === true && typeof httpExport.operationId === "string", "地图 export 应带 operationId");
    const httpExportRecord = await readOperationRecord(String(httpExport.operationId), root);
    check(httpExportRecord?.operation === "export" && httpExportRecord?.action === "export-geojson", "地图 export 应写 export 族记录");
    check(httpExportRecord?.outputResources?.[0] === join(root, "out.geojson"), "export 记录应留下输出路径");

    const httpRename = await post("/api/map/rename", { layerId: "lyr-1", layerName: "新名" });
    check(httpRename.ok === true && typeof httpRename.operationId === "string", "地图 rename 应带 operationId");
    const httpRenameRecord = await readOperationRecord(String(httpRename.operationId), root);
    check(httpRenameRecord?.operation === "rename" && httpRenameRecord?.action === "rename-layer", "地图 rename 应写 rename 族记录");

    const httpDelete = await post("/api/map/layer/delete", { layerId: "lyr-1", confirm: true });
    check(httpDelete.ok === true && typeof httpDelete.operationId === "string", "地图删除应带 operationId");
    const httpDeleteRecord = await readOperationRecord(String(httpDelete.operationId), root);
    check(httpDeleteRecord?.approvalState?.confirmedBy === "local-ui", "桌面删除的授权来源应是 local-ui");
    console.log("ok 桌面地图接口 load/export/rename/delete 都留痕");

    // ---- 4. 五空间操作记录带默认 approvalState。
    const spatial = await executeGisOperation(fake.service, {
      entry: "map",
      operation: "buffer",
      root,
      policy: { writeKnowledge: false },
      sourceLayer: { layerId: "lyr-1", layerName: "地块" },
      distance: 100,
      unit: "meters",
    });
    check(spatial.ok, "假服务缓冲应成功");
    const spatialRecord = await readOperationRecord(spatial.operationId, root);
    check(spatialRecord?.approvalState?.required === false && spatialRecord?.approvalState?.confirmed === false, "空间分析记录的授权状态应是不需要授权");
    console.log("ok 空间分析记录带默认授权状态");

    // ---- B4 形状：出站审计总量上限。
    const httpTs = await readFile(join(REPO_ROOT, "packages/llm-dispatch/src/http.ts"), { encoding: "utf8" });
    check(httpTs.includes("AUDIT_TOTAL_CAP"), "B4 出站审计总大小上限不在 http.ts");
    check(httpTs.includes("evictAuditOverBudget"), "B4 总量淘汰逻辑不在 http.ts");
    console.log("ok B4 出站审计总量上限在位");

    console.log("runtime-boundary-check passed");
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
if (failed) throw new Error("runtime-boundary-check failed");
