// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env as nodeEnv, platform } from "node:process";
import { managedPythonPath, micromambaBinary, readGdalPythonLock, runProcess } from "./gdal-env.js";

/**
 * 计算引擎环境（V0.94.2）。
 * var/engines-python：建在托管 GDAL Python 上的虚拟环境，装 ANUGA 和 LoopStructural，版本按 config/engines.lock.json。
 * var/engines/trigrs：TRIGRS 从 USGS 源码编译。发布版的 exe 依赖 cygwin1.dll，不用。
 */

export interface EnginesLock {
  readonly python: {
    readonly packages: readonly string[];
    readonly noDeps: readonly string[];
    readonly constraints: readonly string[];
  };
  readonly fortran: { readonly channel: string; readonly packages: readonly string[] };
  readonly trigrs: {
    readonly version: string;
    readonly urls: readonly string[];
    readonly sha256: string;
    readonly archive: string;
    readonly folder: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
}

export function enginesPrefix(root: string): string {
  return join(root, "var", "engines-python");
}

export function enginesDirectory(root: string): string {
  return join(root, "var", "engines");
}

export function enginesPythonPath(root: string): string | null {
  const candidate = platform === "win32" ? join(enginesPrefix(root), "Scripts", "python.exe") : join(enginesPrefix(root), "bin", "python");
  return existsSync(candidate) ? candidate : null;
}

export async function readEnginesLock(root: string): Promise<EnginesLock> {
  const parsed = JSON.parse(await readFile(join(root, "config", "engines.lock.json"), { encoding: "utf8" })) as unknown;
  if (!isRecord(parsed) || !isRecord(parsed.python) || !isRecord(parsed.fortran) || !isRecord(parsed.trigrs)) {
    throw new Error("config/engines.lock.json 不是有效的锁文件。");
  }
  const trigrs = parsed.trigrs;
  const lock: EnginesLock = {
    python: {
      packages: strings(parsed.python.packages),
      noDeps: strings(parsed.python.noDeps),
      constraints: strings(parsed.python.constraints),
    },
    fortran: { channel: typeof parsed.fortran.channel === "string" ? parsed.fortran.channel : "", packages: strings(parsed.fortran.packages) },
    trigrs: {
      version: typeof trigrs.version === "string" ? trigrs.version : "",
      urls: strings(trigrs.urls),
      sha256: typeof trigrs.sha256 === "string" ? trigrs.sha256.toLowerCase() : "",
      archive: typeof trigrs.archive === "string" ? trigrs.archive : "",
      folder: typeof trigrs.folder === "string" ? trigrs.folder : "",
    },
  };
  const pinned = (spec: string) => /==\S+$/.test(spec);
  if (![...lock.python.packages, ...lock.python.noDeps, ...lock.python.constraints].every(pinned) || lock.python.noDeps.length === 0) {
    throw new Error("config/engines.lock.json 的 Python 包没有全部钉住版本。");
  }
  if (!/^[0-9a-f]{64}$/.test(lock.trigrs.sha256) || lock.trigrs.archive === "" || lock.trigrs.folder === "" || lock.fortran.packages.length === 0) {
    throw new Error("config/engines.lock.json 缺 TRIGRS 源码哈希或编译器版本。");
  }
  return lock;
}

/** TRIGRS 主程序的源文件。并行版（_p）不编译；模块文件要先编译。 */
export function trigrsSourceOrder(names: readonly string[]): string[] {
  const modules = ["grids.f95", "input_vars.f95", "model_vars.f95", "input_file_defs.f95"];
  const serial = names.filter((name) => /\.(f95|f90|f)$/i.test(name) && !/_p\.f(90|95)?$/i.test(name) && !modules.includes(name));
  const rank = (name: string) => (/\.f95$/i.test(name) ? 0 : /\.f90$/i.test(name) ? 1 : 2);
  serial.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return [...modules.filter((name) => names.includes(name)), ...serial];
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const fetchImpl = (globalThis as { fetch?: (input: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }> }).fetch;
  if (!fetchImpl) throw new Error("当前运行时不能下载。");
  const response = await fetchImpl(url, { headers: { "User-Agent": "igis-engines" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** 先找 var/engines/src 里的源码包，没有再按锁文件地址下载。两种来源都核对哈希。 */
async function trigrsArchive(root: string, lock: EnginesLock): Promise<string> {
  const directory = join(enginesDirectory(root), "src");
  await mkdir(directory, { recursive: true });
  const local = join(directory, lock.trigrs.archive);
  if (existsSync(local)) {
    if (sha256(await readFile(local)) !== lock.trigrs.sha256) throw new Error(`${lock.trigrs.archive} 的哈希和锁文件不一致。请删掉它重新下载。`);
    return local;
  }
  const errors: string[] = [];
  for (const url of lock.trigrs.urls) {
    try {
      const bytes = await fetchBytes(url);
      if (sha256(bytes) !== lock.trigrs.sha256) {
        errors.push(`${url}：哈希不一致`);
        continue;
      }
      await writeFile(local, bytes);
      return local;
    } catch (error) {
      errors.push(`${url}：${error instanceof Error ? error.message : "下载失败"}`);
    }
  }
  throw new Error(`TRIGRS ${lock.trigrs.version} 源码下载失败（${errors.join("；")}）。可以手动把 ${lock.trigrs.archive} 放进 var/engines/src 后再安装。`);
}

async function installPythonEngines(root: string, lock: EnginesLock): Promise<string> {
  const base = managedPythonPath(root);
  if (!base) throw new Error("托管 GDAL Python 不在。请先在设置里准备 GDAL 环境。");
  const probe = enginesPythonPath(root);
  if (probe) {
    const imported = await runProcess(probe, ["-c", "import anuga, LoopStructural"], root, {}, 180_000);
    if (imported.code === 0) return "ANUGA 和 LoopStructural 已在。";
  }
  if (!enginesPythonPath(root)) {
    const created = await runProcess(base, ["-m", "venv", "--system-site-packages", enginesPrefix(root)], root, {}, 300_000);
    if (created.code !== 0 || !enginesPythonPath(root)) throw new Error(`建 engines-python 失败：${(created.stderr || created.stdout).trim().slice(0, 400)}`);
  }
  const python = enginesPythonPath(root)!;
  const work = await mkdtemp(join(tmpdir(), "igis-engines-"));
  try {
    const constraints = join(work, "constraints.txt");
    await writeFile(constraints, `${lock.python.constraints.join("\n")}\n`, { encoding: "utf8" });
    const deps = await runProcess(python, ["-m", "pip", "install", "--disable-pip-version-check", "--only-binary=:all:", "-c", constraints, ...lock.python.packages], root, {}, 1_800_000);
    if (deps.code !== 0) throw new Error(`装 Python 依赖失败：${(deps.stderr || deps.stdout).trim().slice(-400)}`);
    const main = await runProcess(python, ["-m", "pip", "install", "--disable-pip-version-check", "--only-binary=:all:", "--no-deps", ...lock.python.noDeps], root, {}, 1_800_000);
    if (main.code !== 0) throw new Error(`装 ANUGA 失败：${(main.stderr || main.stdout).trim().slice(-400)}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  const imported = await runProcess(python, ["-c", "import anuga, LoopStructural"], root, {}, 180_000);
  if (imported.code !== 0) throw new Error(`装完后仍然不能导入：${imported.stderr.trim().slice(-400)}`);
  return "ANUGA 和 LoopStructural 已装好。";
}

async function installTrigrs(root: string, lock: EnginesLock): Promise<string> {
  const target = join(enginesDirectory(root), "trigrs", platform === "win32" ? "trigrs.exe" : "trigrs");
  if (existsSync(target)) return "TRIGRS 已在。";
  if (platform !== "win32") throw new Error("这台机器不是 Windows。请用系统的 gfortran 编译 TRIGRS 后放到 var/engines/trigrs。");
  const archive = await trigrsArchive(root, lock);
  const base = managedPythonPath(root);
  if (!base) throw new Error("托管 GDAL Python 不在，无法解压 TRIGRS 源码。");
  const fortranPrefix = join(enginesDirectory(root), "fortran");
  const gfortranBin = join(fortranPrefix, "Library", "mingw-w64", "bin");
  if (!existsSync(join(gfortranBin, "gfortran.exe"))) {
    const micromamba = await micromambaBinary(root, await readGdalPythonLock(root));
    // micromamba 的包缓存放在含中文的目录里会找不到任何包，缓存放到系统临时目录。
    const cache = join(tmpdir(), "igis-mamba");
    const created = await runProcess(micromamba, ["create", "-y", "-p", fortranPrefix, "-c", lock.fortran.channel, "--override-channels", ...lock.fortran.packages], root, {
      MAMBA_ROOT_PREFIX: cache,
      MAMBA_NO_BANNER: "1",
    }, 1_800_000);
    if (created.code !== 0 || !existsSync(join(gfortranBin, "gfortran.exe"))) {
      throw new Error(`装 gfortran 失败：${(created.stderr || created.stdout).trim().slice(-400)}`);
    }
  }
  const work = await mkdtemp(join(tmpdir(), "igis-trigrs-"));
  try {
    const unpacked = await runProcess(base, ["-c", "import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", archive, work], root, {}, 120_000);
    if (unpacked.code !== 0) throw new Error(`解压 TRIGRS 源码失败：${unpacked.stderr.trim().slice(0, 300)}`);
    const sourceDir = join(work, lock.trigrs.folder, "src", "TRIGRS");
    const order = trigrsSourceOrder(await readdir(sourceDir));
    const env = { PATH: `${gfortranBin};${nodeEnv.PATH ?? ""}` };
    const compiled = await runProcess(join(gfortranBin, "gfortran.exe"), ["-w", "-O2", "-c", ...order], sourceDir, env, 600_000);
    if (compiled.code !== 0) throw new Error(`编译 TRIGRS 失败：${(compiled.stderr || compiled.stdout).trim().slice(-400)}`);
    const objects = (await readdir(sourceDir)).filter((name) => name.endsWith(".o"));
    const linked = await runProcess(join(gfortranBin, "gfortran.exe"), ["-w", "-O2", "-static", "-o", "trigrs.exe", ...objects], sourceDir, env, 300_000);
    if (linked.code !== 0 || !existsSync(join(sourceDir, "trigrs.exe"))) throw new Error(`链接 TRIGRS 失败：${(linked.stderr || linked.stdout).trim().slice(-400)}`);
    await mkdir(join(enginesDirectory(root), "trigrs"), { recursive: true });
    await writeFile(target, await readFile(join(sourceDir, "trigrs.exe")));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return `TRIGRS ${lock.trigrs.version} 已编译。`;
}

/** 按锁文件准备三个引擎。已经在的跳过。失败时返回真实原因，不假装可用。 */
export async function installEngines(root: string): Promise<{ readonly ok: boolean; readonly message: string }> {
  try {
    const lock = await readEnginesLock(root);
    const python = await installPythonEngines(root, lock);
    const trigrs = await installTrigrs(root, lock);
    return { ok: true, message: `${python}${trigrs}` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message.slice(0, 600) : "计算引擎安装失败。" };
  }
}
