// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cwd } from "node:process";
import { installProModel, ProModelError } from "@igis/spatial-ops";

/**
 * 安装本地专业模型权重：校验后放入 var/models/igis-pro/slots，并启用为 model.json。
 * 用法：npx --yes tsx --tsconfig tsconfig.json apps/cli/src/pro-model-install.ts <权重文件>
 * 权重文件不入库，单独提供。不装也能用其他工具，克里金和汇水分析返回不可用。
 */

async function main(): Promise<void> {
  const source = (globalThis as { process?: { argv?: readonly string[] } }).process?.argv?.[2];
  if (!source) throw new ProModelError("请给出权重文件。");
  const text = await readFile(resolve(source), { encoding: "utf8" });
  const model = await installProModel(resolve(cwd(), "var", "models", "igis-pro"), JSON.parse(text) as unknown);
  console.log(`已安装并启用权重 ${model.name}（${model.trainingSets} 组训练数据）：克里金 ${model.kriging.model}，汇水阈值 ${model.watershed.streamArea} 平方米。库里可以保留多份。`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  (globalThis as { process?: { exitCode?: number } }).process!.exitCode = 1;
});
