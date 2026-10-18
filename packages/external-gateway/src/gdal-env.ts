// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { arch, env as nodeEnv, platform } from "node:process";

/**
 * 托管 GDAL Python 环境与解释器选择。
 * 默认用 var/gdal-python（micromamba 按锁文件创建）。
 * 面板保存的自定义解释器只用于下一次 spawn，不改写那份 Python。
 * 还没保存过时，IGIS_PYTHON 才作为无界面回退。
 */

export interface GdalPythonLock {
  readonly micromambaVersion: string;
  readonly micromambaAssets: Readonly<Record<string, string>>;
  readonly packages: readonly { readonly name: string; readonly version: string }[];
  readonly channel: string;
  readonly prefix: string;
}

export interface InterpreterSelection {
  readonly saved: boolean;
  readonly mode: "managed" | "custom";
  readonly command: string;
}

type MicromambaPlatform = "win-64" | "linux-64" | "osx-64" | "osx-arm64";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function interpreterFile(root: string): string {
  return join(root, "var", "gdal", "interpreter.json");
}

export function managedPrefix(root: string): string {
  return join(root, "var", "gdal-python");
}

export function managedPythonPath(root: string): string | null {
  const prefix = managedPrefix(root);
  const candidate = platform === "win32" ? join(prefix, "python.exe") : join(prefix, "bin", "python");
  return existsSync(candidate) ? candidate : null;
}

export function readInterpreterSelection(root: string): InterpreterSelection | null {
  try {
    const parsed = JSON.parse(readFileSync(interpreterFile(root), { encoding: "utf8" })) as unknown;
    if (!isRecord(parsed) || parsed.saved !== true) return null;
    const command = typeof parsed.command === "string" ? parsed.command.trim() : "";
    if (parsed.mode === "custom" && command !== "") return { saved: true, mode: "custom", command };
    return { saved: true, mode: "managed", command: "" };
  } catch {
    return null;
  }
}

/** 面板回显。没保存过，或保存的是托管模式时，输入框为空。 */
export function savedPythonCommandForPanel(root: string): string {
  const saved = readInterpreterSelection(root);
  if (!saved || saved.mode !== "custom") return "";
  return saved.command;
}

export async function writeInterpreterSelection(root: string, command: string): Promise<void> {
  const directory = join(root, "var", "gdal");
  await mkdir(directory, { recursive: true });
  const trimmed = command.trim();
  const payload: InterpreterSelection = trimmed === ""
    ? { saved: true, mode: "managed", command: "" }
    : { saved: true, mode: "custom", command: trimmed };
  await writeFile(interpreterFile(root), `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8" });
}

/**
 * 每次启动外部进程时重新解析，所以保存后的下一次请求就换解释器。
 * 已保存的面板值优先于 IGIS_PYTHON。没保存时才回退到环境变量，再回退到托管 Python。
 */
export function resolvePythonCommand(root: string, env: Readonly<Record<string, string | undefined>>): string {
  const saved = readInterpreterSelection(root);
  if (saved?.saved) {
    if (saved.mode === "custom" && saved.command !== "") return saved.command;
    return managedPythonPath(root) ?? "python";
  }
  const fromEnv = typeof env.IGIS_PYTHON === "string" ? env.IGIS_PYTHON.trim() : "";
  if (fromEnv !== "") return fromEnv;
  return managedPythonPath(root) ?? "python";
}

function micromambaPlatform(): MicromambaPlatform {
  if (platform === "win32") return "win-64";
  if (platform === "darwin") return arch === "arm64" ? "osx-arm64" : "osx-64";
  return "linux-64";
}

export async function readGdalPythonLock(root: string): Promise<GdalPythonLock> {
  const parsed = JSON.parse(await readFile(join(root, "config", "gdal-python.lock.json"), { encoding: "utf8" })) as unknown;
  if (!isRecord(parsed) || !isRecord(parsed.micromambaAssets) || !Array.isArray(parsed.packages)) {
    throw new Error("config/gdal-python.lock.json 不是有效的锁文件。");
  }
  const packages = parsed.packages.flatMap((item) => {
    if (!isRecord(item) || typeof item.name !== "string" || typeof item.version !== "string") return [];
    return [{ name: item.name, version: item.version }];
  });
  if (packages.length === 0 || typeof parsed.channel !== "string") {
    throw new Error("config/gdal-python.lock.json 没有钉住包版本。");
  }
  const assets: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.micromambaAssets)) {
    if (typeof value === "string" && value.trim() !== "") assets[key] = value.trim();
  }
  return {
    micromambaVersion: typeof parsed.micromambaVersion === "string" ? parsed.micromambaVersion : "",
    micromambaAssets: assets,
    packages,
    channel: parsed.channel,
    prefix: typeof parsed.prefix === "string" && parsed.prefix.trim() !== "" ? parsed.prefix : "var/gdal-python",
  };
}

function bootstrapErrorFile(root: string): string {
  return join(root, "var", "gdal", "bootstrap-error.txt");
}

export async function readBootstrapError(root: string): Promise<string> {
  try {
    return (await readFile(bootstrapErrorFile(root), { encoding: "utf8" })).trim().slice(0, 500);
  } catch {
    return "";
  }
}

async function rememberBootstrapError(root: string, message: string): Promise<void> {
  await mkdir(join(root, "var", "gdal"), { recursive: true });
  await writeFile(bootstrapErrorFile(root), `${message.slice(0, 2000)}\n`, { encoding: "utf8" });
}

function downloadFile(url: string): Promise<Uint8Array> {
  const fetchImpl = (globalThis as { fetch?: (input: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }> }).fetch;
  if (!fetchImpl) return Promise.reject(new Error("当前运行时不能下载 micromamba。"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`下载 micromamba 超时：${url}`)), 25_000);
    fetchImpl(url).then(async (response) => {
      clearTimeout(timer);
      if (!response.ok) {
        reject(new Error(`下载 micromamba 失败：HTTP ${response.status} ${url}`));
        return;
      }
      resolve(new Uint8Array(await response.arrayBuffer()));
    }).catch((error: unknown) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error("下载 micromamba 失败。"));
    });
  });
}

export function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  extraEnv: Readonly<Record<string, string>>,
  timeoutMs: number,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd,
      env: { ...nodeEnv, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : String(chunk);
    });
    child.on("error", (error: Error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: error.message });
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.slice(0, 2000), stderr: stderr.slice(0, 2000) });
    });
  });
}

const IMPORT_NAMES: Readonly<Record<string, string>> = { gdal: "osgeo" };

/** 锁文件里除 python 外每个包对应的 import 名。 */
export function lockImportNames(lock: GdalPythonLock): readonly string[] {
  return lock.packages.filter((item) => item.name !== "python").map((item) => IMPORT_NAMES[item.name] ?? item.name);
}

export async function micromambaBinary(root: string, lock: GdalPythonLock): Promise<string> {
  const target = micromambaPlatform();
  const url = lock.micromambaAssets[target];
  if (!url) throw new Error(`锁文件没有 ${target} 的 micromamba 下载地址。`);
  const binaryName = platform === "win32" ? "micromamba.exe" : "micromamba";
  const binaryDir = join(root, "var", "micromamba");
  const binary = join(binaryDir, binaryName);
  await mkdir(binaryDir, { recursive: true });
  if (!existsSync(binary)) {
    const response = await downloadFile(url);
    if (response.byteLength < 1000) throw new Error(`下载的 micromamba 过小（${response.byteLength} 字节）。`);
    await writeFile(binary, response);
  }
  return binary;
}

/**
 * 按锁文件准备托管环境。失败时把真实错误写进 var/gdal/bootstrap-error.txt，不假装 osgeo 可用。
 * 已有环境时只检查锁文件里的包能否 import；缺了才按锁文件版本补装进同一前缀。
 */
export async function ensureManagedGdalEnv(root: string): Promise<{ readonly ok: boolean; readonly message: string }> {
  try {
    const lock = await readGdalPythonLock(root);
    const prefix = managedPrefix(root);
    const specs = lock.packages.map((item) => `${item.name}=${item.version}`);
    const existing = managedPythonPath(root);
    if (existing) {
      const probe = await runProcess(existing, ["-c", `import ${lockImportNames(lock).join(", ")}`], root, {}, 120_000);
      if (probe.code === 0) {
        await rm(bootstrapErrorFile(root), { recursive: true, force: true });
        return { ok: true, message: "托管 GDAL 环境已在。" };
      }
      const binary = await micromambaBinary(root, lock);
      const installed = await runProcess(binary, ["install", "-y", "-p", prefix, "-c", lock.channel, "--override-channels", ...specs], root, {
        MAMBA_NO_BANNER: "1",
      }, 1_200_000);
      const recheck = await runProcess(existing, ["-c", `import ${lockImportNames(lock).join(", ")}`], root, {}, 120_000);
      if (installed.code !== 0 || recheck.code !== 0) {
        const detail = installed.stderr.trim() || recheck.stderr.trim() || installed.stdout.trim() || `micromamba 退出码 ${String(installed.code)}`;
        throw new Error(detail.slice(0, 800));
      }
      await rm(bootstrapErrorFile(root), { recursive: true, force: true });
      return { ok: true, message: "托管 GDAL 环境已按锁文件补齐。" };
    }
    const binary = await micromambaBinary(root, lock);
    const created = await runProcess(binary, ["create", "-y", "-p", prefix, "-c", lock.channel, ...specs], root, {
      MAMBA_NO_BANNER: "1",
    }, 1_200_000);
    if (created.code !== 0 || !managedPythonPath(root)) {
      const detail = created.stderr.trim() || created.stdout.trim() || `micromamba 退出码 ${String(created.code)}`;
      throw new Error(detail.slice(0, 800));
    }
    await rm(bootstrapErrorFile(root), { recursive: true, force: true });
    return { ok: true, message: "托管 GDAL 环境已创建。" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "创建托管 GDAL 环境失败。";
    await rememberBootstrapError(root, message);
    return { ok: false, message };
  }
}
