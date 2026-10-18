// SPDX-License-Identifier: Apache-2.0

/**
 * 把当前仓库收成 dist/igis-win。不复制 var/、密钥和 git。
 * 运行：npx tsx --tsconfig tsconfig.json apps/cli/src/package-win.ts
 */

import { existsSync } from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(".");
const dest = join(root, "dist", "igis-win");

const copies = [
  "apps/cli/src",
  "apps/desktop/ui",
  "packages",
  "config/gdal.lock.json",
  "config/gdal-python.lock.json",
  "config/engines.lock.json",
  "config/retrieval.json",
  "config/audit.json",
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.base.json",
];

const launcher = `@echo off
setlocal
cd /d "%~dp0"
set IGIS_REQUIRE_LOCAL_RUNTIME=1
echo Starting Igis at http://127.0.0.1:39221
start "Igis" cmd /k node node_modules\\tsx\\dist\\cli.mjs --tsconfig tsconfig.json apps\\cli\\src\\desktop-api.ts
set /a tries=0
:waitloop
set /a tries+=1
if %tries% GTR 40 goto openwindow
curl -fsS http://127.0.0.1:39221/api/health >nul 2>&1
if errorlevel 1 (
  timeout /t 1 /nobreak >nul
  goto waitloop
)
:openwindow
set "IGIS_EXE=%~dp0igis.exe"
if not exist "%IGIS_EXE%" (
  echo Igis window was not built.
  endlocal
  exit /b 1
)
start "" "%IGIS_EXE%"
endlocal
`;

async function main(): Promise<void> {
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  for (const relative of copies) {
    await cp(join(root, relative), join(dest, relative), {
      recursive: true,
      dereference: true,
      filter: (source) => !source.split(/[\\/]/).includes("node_modules") && !source.split(/[\\/]/).includes("var"),
    });
  }
  await cp(join(root, "node_modules"), join(dest, "node_modules"), { recursive: true, dereference: true });
  const gdalPrefix = join(root, "var", "gdal-python");
  if (existsSync(gdalPrefix)) {
    await cp(gdalPrefix, join(dest, "var", "gdal-python"), { recursive: true, dereference: true });
  }
  const windowBinary = join(root, "apps", "desktop", "src-tauri", "target", "release", "igis.exe");
  if (!existsSync(windowBinary)) {
    throw new Error("缺少 apps/desktop/src-tauri/target/release/igis.exe。先编出窗口程序再打包。");
  }
  await cp(windowBinary, join(dest, "igis.exe"), { recursive: true, dereference: true });
  await writeFile(join(dest, "start-igis.cmd"), launcher, { encoding: "utf8" });
  console.log(dest);
}

await main();
