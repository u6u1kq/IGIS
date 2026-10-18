// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
const nodeVersion = (globalThis as { process?: { version?: string } }).process?.version ?? "0";
import { resolvePythonCommand } from "@igis/external-gateway";

export interface EnvironmentItem {
  readonly name: string;
  readonly required: boolean;
  readonly ok: boolean;
  readonly message: string;
}

export interface EnvironmentReport {
  readonly ok: boolean;
  readonly requiredOk: boolean;
  /** 只含未通过项的用户句子：缺什么，以及怎么处理。通过项不在这里。 */
  readonly summary: readonly string[];
  readonly items: readonly EnvironmentItem[];
}

export function environmentSummary(items: readonly EnvironmentItem[]): readonly string[] {
  return items.filter((item) => item.ok !== true && item.message.trim() !== "").map((item) => item.message);
}

function nodeItem(): EnvironmentItem {
  const major = Number(nodeVersion.replace(/^v/, "").split(".")[0]);
  const ok = Number.isInteger(major) && major >= 20;
  return {
    name: "node",
    required: true,
    ok,
    message: ok ? `Node ${nodeVersion}` : `缺少 Node 20 以上，当前是 ${nodeVersion}。安装 Node 20 后再打开。`,
  };
}

/** 开发启动用 npx tsx，仓库里没有 tsx 不算故障。目录包要求本机运行库时，缺 tsx 才是故障。 */
export function tsxEnvironmentItem(present: boolean, packaged: boolean): EnvironmentItem {
  if (present) return { name: "tsx", required: packaged, ok: true, message: "目录内已有 tsx" };
  if (!packaged) return { name: "tsx", required: false, ok: true, message: "开发启动由 npx tsx 提供。" };
  return {
    name: "tsx",
    required: true,
    ok: false,
    message: "缺少 node_modules/tsx/package.json。在程序目录安装依赖后再打开。",
  };
}

function mapLibreItem(root: string): EnvironmentItem {
  const present = existsSync(join(root, "node_modules/maplibre-gl/dist/maplibre-gl.js"))
    || existsSync(join(root, "node_modules/maplibre-gl/dist/maplibre-gl.mjs"));
  return {
    name: "maplibre",
    required: true,
    ok: present,
    message: present ? "地图库已在" : "缺少地图库 node_modules/maplibre-gl。在程序目录安装依赖后再打开。",
  };
}

function gdalWasmItem(root: string): EnvironmentItem {
  const present = existsSync(join(root, "node_modules/gdal-js/gdal.wasm"));
  return {
    name: "gdal-wasm",
    required: true,
    ok: present,
    message: present ? "gdal-js wasm 已在" : "缺少 node_modules/gdal-js/gdal.wasm。在程序目录安装依赖后再打开。",
  };
}

const OSGEO_MISSING = "缺少本机 Python/osgeo，只影响重投影。可等待托管 GDAL 环境，或在设置里填写可用的 Python。";

function probeOsgeo(command: string): Promise<EnvironmentItem> {
  return new Promise((resolve) => {
    const child = spawn(command, ["-c", "from osgeo import gdal; print(gdal.VersionInfo())"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill();
    }, 20_000);
    child.stdout.on("data", (chunk: Buffer | string) => { stdout += String(chunk); });
    child.stderr.on("data", () => undefined);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ name: "osgeo", required: false, ok: false, message: OSGEO_MISSING });
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      const ok = code === 0 && stdout.trim() !== "";
      resolve({
        name: "osgeo",
        required: false,
        ok,
        message: ok ? `GDAL ${stdout.trim()}` : OSGEO_MISSING,
      });
    });
  });
}

/** 打开界面所需的 Node、地图库和 wasm。开发启动不要求仓库内的 tsx。osgeo 只影响重投影。 */
export async function checkRuntimeEnvironment(root: string, env: Readonly<Record<string, string | undefined>>): Promise<EnvironmentReport> {
  const packaged = env.IGIS_REQUIRE_LOCAL_RUNTIME === "1";
  const items: EnvironmentItem[] = [
    nodeItem(),
    tsxEnvironmentItem(existsSync(join(root, "node_modules/tsx/package.json")), packaged),
    mapLibreItem(root),
    gdalWasmItem(root),
  ];
  items.push(await probeOsgeo(resolvePythonCommand(root, env)));
  const requiredOk = items.filter((item) => item.required).every((item) => item.ok);
  const summary = environmentSummary(items);
  return { ok: requiredOk, requiredOk, summary, items };
}
