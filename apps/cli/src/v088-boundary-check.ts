// SPDX-License-Identifier: Apache-2.0

/**
 * V0.88-T1 External Capability Boundary 验证。
 * 行为断言（真实调用边界，临时目录、不监听端口）：
 *   1. 请求纪律：授权字段 / 路径键 / 几何键 / where 子句 / 路径值 / 几何值 / 坐标对一律拒绝
 *   2. 结果投影：facts 里的 bounds/transform/uri/path/geometry 等键剥离，计数与统计保留
 *   3. outputResources 只回 localOutputResources（本地专用），不进 facts
 *   4. 能力可下线：未配置后端 / 开关关闭 / 后端不可用，一律返回 unavailable，不留半截状态
 *   5. 单向依赖：核心包（spatial-ops/service.ts）不 import external-gateway
 * 运行：npx tsx --tsconfig tsconfig.json apps/cli/src/v088-boundary-check.ts
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ExternalCapabilityBoundary, createProcessBackend, validateExternalRequest } from "@igis/external-gateway";
import type { ExternalBackendPort, ExternalBackendResult, ExternalCapabilityRequest } from "@igis/external-gateway";

const REPO_ROOT = resolve("E:/ai工作区/Igis");

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

function request(parameters: Record<string, string | number | boolean | null>): ExternalCapabilityRequest {
  return { capability: "gdal.test", inputResources: ["lyr-1"], parameters };
}

function fakeBackend(result: ExternalBackendResult): ExternalBackendPort {
  return {
    name: "fake",
    isAvailable: async () => true,
    invoke: async () => result,
  };
}

async function main(): Promise<void> {
  // ---- 1. 请求纪律。
  check(validateExternalRequest(request({ distance: 100 })) === true, "纯标量参数应放行");
  const rejected: readonly (readonly [Record<string, string | number | boolean | null>, string])[] = [
    [{ confirm: true }, "授权字段"],
    [{ userConfirmed: true }, "授权字段"],
    [{ token: "ap-x" }, "授权字段"],
    [{ absolutePath: "C:/data/a.shp" }, "路径键"],
    [{ filePath: "C:/data/a.shp" }, "路径键"],
    [{ output: "C:/out/a.geojson" }, "路径键"],
    [{ geometry: "{}" }, "几何键"],
    [{ bbox: "1,2,3,4" }, "几何键"],
    [{ where: "pop > 10" }, "查询子句"],
    [{ note: "C:/data/roads.shp" }, "路径值"],
    [{ note: "POLYGON((0 0,1 0,1 1,0 1,0 0))" }, "几何值"],
    [{ note: "116.4, 39.9" }, "坐标对"],
  ];
  for (const [params, why] of rejected) {
    const verdict = validateExternalRequest(request(params));
    check(verdict !== true, `${why} 应被请求纪律拒绝：${JSON.stringify(params)}`);
    check(typeof verdict.code === "string", "拒绝应带错误码");
  }
  console.log("ok 请求纪律：授权/路径/几何/子句全部拒绝");

  // ---- 2/3. 结果投影。
  const boundary = new ExternalCapabilityBoundary({ enabled: true, backend: fakeBackend({
    ok: true,
    outputResources: ["var/backends/out-1.geojson"],
    facts: {
      featureCount: 12,
      crs: "EPSG:4326",
      minimum: 3,
      bounds: [116, 39, 117, 40],
      transform: [0.001, 0, 116, 0, -0.001, 40],
      uri: "C:/data/elevation.tif",
      path: "C:/data",
      geometry: { type: "Point", coordinates: [116, 39] },
    },
    message: "已完成，输出 C:/data/out.geojson",
  }) });
  const outcome = await boundary.invoke(request({ distance: 100 }));
  check(outcome.ok === true, "后端成功时结果应 ok");
  const facts = outcome.facts ?? {};
  // 投影现实：计数/统计值保留；crs 结构键不在 L2 白名单（CRS 名走 message 文本通道，V0.85 既定）。
  check(facts.featureCount === 12 && facts.minimum === 3, "计数/统计应保留");
  check(!("crs" in facts), "crs 结构键不在白名单，CRS 名走 message 文本通道");
  for (const key of ["bounds", "transform", "uri", "path", "geometry"]) {
    check(!(key in facts), `facts 不得携带 ${key}`);
  }
  check(JSON.stringify(facts).includes("coordinates") === false, "facts 不得含坐标");
  check(outcome.localOutputResources?.[0] === "var/backends/out-1.geojson", "输出资源应只回本地字段");
  check(JSON.stringify(facts).includes("var/backends") === false, "facts 不得含资源路径");
  console.log("ok 结果投影：bounds/transform/uri/geometry 剥离，计数统计保留");

  // ---- 4. 能力可下线。
  const offSwitch = new ExternalCapabilityBoundary({ enabled: false, backend: fakeBackend({ ok: true }) });
  const off = await offSwitch.invoke(request({}));
  check(off.ok === false && off.code === "external-capability-unavailable", "开关关闭应整体下线");

  const noBackend = new ExternalCapabilityBoundary({ enabled: true });
  const unavailable = await noBackend.invoke(request({}));
  check(unavailable.ok === false && unavailable.code === "external-capability-unavailable", "未配置后端应不可用");

  const deadBackend = new ExternalCapabilityBoundary({ enabled: true, backend: {
    name: "dead",
    isAvailable: async () => false,
    invoke: async () => ({ ok: true }),
  } });
  const dead = await deadBackend.invoke(request({}));
  check(dead.ok === false && dead.code === "external-capability-unavailable", "后端不可用应不可用");
  console.log("ok 能力可下线：开关/后端/可用性三层门都在");

  // ---- 5. 单向依赖 + 进程适配器存在。
  const serviceSource = await readFile(join(REPO_ROOT, "packages/spatial-ops/src/service.ts"), { encoding: "utf8" });
  check(!serviceSource.includes("external-gateway"), "核心包不得 import external-gateway");
  const gatewaySource = await readFile(join(REPO_ROOT, "packages/external-gateway/src/boundary.ts"), { encoding: "utf8" });
  check(gatewaySource.includes("projectForModel"), "边界必须强制白名单投影");
  check(typeof createProcessBackend === "function", "本地进程适配器应在位");

  // 进程适配器行为：起一次 node 跑 echo 脚本（临时目录）。
  const root = await mkdtemp(join(tmpdir(), "igis-v088-"));
  check(!resolve(root).toLowerCase().startsWith(REPO_ROOT.toLowerCase()), "用例目录不能落在仓库里");
  try {
    const backend = createProcessBackend({ command: "node", args: ["-e", "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const r=JSON.parse(s);process.stdout.write(JSON.stringify({ok:true,facts:{featureCount:r.parameters.distance}}))})"] });
    const viaProcess = new ExternalCapabilityBoundary({ enabled: true, backend });
    const echoed = await viaProcess.invoke(request({ distance: 42 }));
    check(echoed.ok === true && echoed.facts?.featureCount === 42, "进程适配器应打通请求-结果链路");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  console.log("ok 单向依赖 + 进程适配器链路");

  console.log("v088-boundary-check passed");
}

let failed: unknown = null;
try {
  await main();
} catch (error) {
  failed = error;
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
}
if (failed) throw new Error("v088-boundary-check failed");
