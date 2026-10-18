// SPDX-License-Identifier: Apache-2.0

import { translateAiIntent } from "@igis/ai-translation";
import type { ScheduledToolCall, ToolAdapterPort, ToolCallProvenance } from "@igis/llm-dispatch";
import { createSpatialAwareAdapter } from "./adapter.js";
import type { SpatialService } from "./service.js";

/**
 * 模型意图先翻译，通过后才进入现有的 executeGisOperation。
 * 文件系统、GDAL 和原始几何在翻译层被拒绝，不会读取图层库。
 */
const CLOUD_PROVENANCE: ToolCallProvenance = {
  source: "cloud-ai",
  aiOrigin: true,
  translationUsed: true,
  requestSource: "cloud-ai",
  dataBoundaryLevel: "L2",
};

export async function executeAiIntent(
  service: SpatialService,
  raw: unknown,
  options?: { readonly entry?: "chat" | "mcp"; readonly root?: string },
): Promise<unknown> {
  const translated = translateAiIntent(raw);
  if (!translated.ok) {
    return { ok: false, code: translated.code, message: translated.message };
  }
  const entry = options?.entry ?? "chat";
  const inner: ToolAdapterPort = {
    async execute() {
      return { ok: false, code: "capability-rejected", message: "模型不能直接调用底层工具。" };
    },
  };
  const adapter = createSpatialAwareAdapter(inner, service, {
    entry,
    ...(options?.root !== undefined ? { operationsRoot: options.root } : {}),
  });
  if (translated.intent.kind === "summary") {
    return adapter.execute({ tool: "map.list", args: {}, provenance: CLOUD_PROVENANCE });
  }
  const call: ScheduledToolCall = { tool: translated.intent.tool, args: translated.intent.args, provenance: CLOUD_PROVENANCE };
  return adapter.execute(call);
}
