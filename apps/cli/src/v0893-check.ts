// SPDX-License-Identifier: Apache-2.0

/**
 * V0.89.3：解释器热切换、裸栅格名、对话工作区解析。
 * 不下载 micromamba，不探测 osgeo，不监听桌面端口。
 * 运行：npx tsx --tsconfig tsconfig.json apps/cli/src/v0893-check.ts
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { looksLikeFilePath } from "@igis/ai-boundary";
import { createProcessBackend, readGdalPythonLock, resolvePythonCommand, writeInterpreterSelection } from "@igis/external-gateway";
import { openSpatialStack } from "@igis/spatial-ops";

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

async function main(): Promise<void> {
  check(looksLikeFilePath("dem.tif") === false, "裸文件名 dem.tif 应放行");
  check(looksLikeFilePath("dem.tiff") === false, "裸文件名 dem.tiff 应放行");
  check(looksLikeFilePath("E:/data/dem.tif") === true, "盘符路径应拒绝");
  check(looksLikeFilePath("C:\\data\\dem.tif") === true, "反斜杠路径应拒绝");
  check(looksLikeFilePath("../evil.tif") === true, "上级目录应拒绝");
  check(looksLikeFilePath("sub/dir.tif") === true, "带斜杠的相对路径应拒绝");
  check(looksLikeFilePath("\\\\server\\share\\dem.tif") === true, "UNC 路径应拒绝");

  const lock = await readGdalPythonLock(resolve("."));
  check(lock.packages.some((item) => item.name === "python" && item.version !== ""), "锁文件应钉住 Python");
  check(lock.packages.some((item) => item.name === "gdal" && item.version !== ""), "锁文件应钉住 GDAL");
  check(lock.packages.some((item) => item.name === "numpy" && item.version !== ""), "锁文件应钉住 numpy");
  check(typeof lock.micromambaAssets["win-64"] === "string" && lock.micromambaAssets["win-64"].includes("micromamba"), "锁文件应给出 micromamba 地址");

  const root = await mkdtemp(join(tmpdir(), "igis-v0893-"));
  try {
    check(resolvePythonCommand(root, { IGIS_PYTHON: "C:/env/python.exe" }) === "C:/env/python.exe", "未保存时 IGIS_PYTHON 作为回退");
    await writeInterpreterSelection(root, "D:/custom/python.exe");
    check(resolvePythonCommand(root, { IGIS_PYTHON: "C:/env/python.exe" }) === "D:/custom/python.exe", "保存的自定义解释器应盖过 IGIS_PYTHON");
    await writeInterpreterSelection(root, "");
    check(resolvePythonCommand(root, { IGIS_PYTHON: "C:/env/python.exe" }) === "python", "保存为托管模式后不再使用 IGIS_PYTHON");

    let useNode = true;
    const backend = createProcessBackend({
      command: () => (useNode ? "node" : "igis-missing-python-command"),
      args: ["-e", "process.stdout.write(JSON.stringify({ok:true,message:'ran'}))"],
    });
    const first = await backend.invoke({ capability: "probe", inputResources: ["a"], parameters: {} });
    check(first.ok === true && first.message === "ran", "进程后端应按当前命令启动");
    useNode = false;
    let swapped = false;
    try {
      await backend.invoke({ capability: "probe", inputResources: ["a"], parameters: {} });
    } catch {
      swapped = true;
    }
    check(swapped, "更换命令后，下一次请求应使用新命令");

    const workspace = join(root, "workspace");
    await mkdir(join(workspace, "imports", "batch"), { recursive: true });
    await writeFile(join(workspace, "imports", "batch", "dem.tif"), "not-a-real-tif", { encoding: "utf8" });
    const port = {
      async invoke(request: { capability: string }) {
        if (request.capability === "raster.info") {
          return { ok: true, facts: { width: 2, height: 2, bands: 1, minimum: 0, maximum: 1, mean: 0.5 }, message: "已读取。" };
        }
        const produced = join(root, "out.tif");
        await writeFile(produced, "bytes", { encoding: "utf8" });
        return { ok: true, message: "已执行。", localOutputResources: [produced] };
      },
    };
    const stack = await openSpatialStack({
      layerDirectory: join(root, "layers"),
      auditDirectory: join(root, "audit"),
      cacheDirectory: join(root, "cache"),
      modelName: () => "v0893",
      external: port,
    });
    await stack.service.usingConversationWorkspace(workspace, async () => {
      const info = await stack.service.rasterInfo("dem.tif");
      check(info.message.includes("2×2"), "应按裸文件名读到对话工作区里的栅格");
      check(!info.message.includes("imports") && !info.message.includes("workspace"), "摘要不得带路径");
      for (const bad of ["C:/data/dem.tif", "../dem.tif", "sub/dem.tif"]) {
        let rejected = false;
        try {
          await stack.service.rasterInfo(bad);
        } catch {
          rejected = true;
        }
        check(rejected, `栅格名 ${bad} 应被拒绝`);
      }
      const slope = await stack.service.demDerivative("dem.tif", "slope");
      check(slope.layer === null && slope.message.includes("dem-slope.tif"), "坡度产物应留在本地并以裸文件名回报");
      check(!slope.message.includes(root), "坡度摘要不得带目录");
      const chained = await stack.service.rasterInfo("dem-slope.tif");
      check(chained.message.includes("2×2"), "后续裸文件名应找到刚登记的坡度栅格");
    });
    console.log("v0893-check passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

let failed: unknown = null;
try {
  await main();
} catch (error) {
  failed = error;
}
if (failed) throw failed;
