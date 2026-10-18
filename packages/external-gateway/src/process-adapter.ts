// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { env } from "node:process";
import type { ExternalBackendPort, ExternalBackendResult, ExternalCapabilityRequest } from "./port.js";

/**
 * 本地进程后端适配器：每请求起一次受控进程，stdin 喂 JSON 请求，stdout 收 JSON 结果。
 * T3 的 GDAL 薄封装走这里。进程参数只有命令与固定参数；请求体不含路径（资源标识由后端自己解析）。
 */
export interface ProcessBackendOptions {
  readonly name?: string;
  /** 字符串，或每次 spawn 时重新取值。保存新解释器后，下一次请求就会用新命令。 */
  readonly command: string | (() => string);
  readonly args?: readonly string[];
  readonly availabilityArgs?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export function createProcessBackend(options: ProcessBackendOptions): ExternalBackendPort {
  function commandText(): string {
    const raw = typeof options.command === "function" ? options.command() : options.command;
    const trimmed = raw.trim();
    return trimmed === "" ? "python" : trimmed;
  }
  /** Node 用 UTF-8 解码管道。放在调用方环境之后，避免系统代码页把中文消息写乱。 */
  function childEnv(): Record<string, string | undefined> {
    return { ...env, ...options.env, PYTHONIOENCODING: "utf-8" };
  }
  async function checkAvailability(): Promise<{ readonly available: boolean; readonly message: string }> {
    if (!options.availabilityArgs) return { available: true, message: "外部进程已配置。" };
    return new Promise((resolve) => {
      const child = spawn(commandText(), [...options.availabilityArgs!], { stdio: ["ignore", "pipe", "pipe"], env: childEnv() });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer | string) => { stdout += typeof chunk === "string" ? chunk : String(chunk); });
      child.stderr.on("data", (chunk: Buffer | string) => { stderr += typeof chunk === "string" ? chunk : String(chunk); });
      child.on("error", (error: Error) => resolve({ available: false, message: error.message.slice(0, 300) }));
      child.on("close", (code: number | null) => {
        try {
          const result = JSON.parse(stdout) as { readonly ok?: unknown; readonly message?: unknown; readonly gdalVersion?: unknown };
          resolve({
            available: code === 0 && result.ok === true,
            message: typeof result.message === "string" ? result.message.slice(0, 300)
              : typeof result.gdalVersion === "string" ? result.gdalVersion.slice(0, 300)
                : code === 0 ? "外部进程自检完成。" : "外部进程自检失败。",
          });
        } catch {
          resolve({ available: false, message: stderr.trim().slice(0, 300) || "外部进程自检没有返回有效状态。" });
        }
      });
    });
  }
  return {
    name: options.name ?? "local-process",
    async isAvailable(): Promise<boolean> {
      return (await checkAvailability()).available;
    },
    checkAvailability,
    async invoke(request: ExternalCapabilityRequest): Promise<ExternalBackendResult> {
      return new Promise<ExternalBackendResult>((resolve, reject) => {
        const child = spawn(commandText(), [...(options.args ?? [])], { stdio: ["pipe", "pipe", "pipe"], env: childEnv() });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer | string) => {
          stdout += typeof chunk === "string" ? chunk : String(chunk);
        });
        child.stderr.on("data", (chunk: Buffer | string) => {
          stderr += typeof chunk === "string" ? chunk : String(chunk);
        });
        child.on("error", (error: Error) => reject(error));
        child.on("close", (code: number | null) => {
          if (code !== 0) {
            reject(new Error(stderr.trim().slice(0, 500) || `外部进程退出码 ${String(code)}。`));
            return;
          }
          try {
            resolve(JSON.parse(stdout) as ExternalBackendResult);
          } catch {
            reject(new Error("外部进程输出不是合法 JSON。"));
          }
        });
        child.stdin.write(JSON.stringify(request));
        child.stdin.end();
      });
    },
  };
}
