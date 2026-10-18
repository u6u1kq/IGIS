// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";
import { loadGdalRuntime, readGisSampleFeatures } from "@igis/gdal-wasm-adapter";
import type { GdalRuntime } from "@igis/gdal-wasm-adapter";
import { createGdalWasmReadPort } from "@igis/gdal-wasm-adapter";
import {
  GisIoReadError,
  readSourceDigestMaterial,
  routeGisRead,
} from "@igis/gis-io";
import type { GisLayerMetadata, GdalWasmReadPort } from "@igis/gis-io";
import { LlmInvokeError } from "@igis/llm-dispatch";
import type { ScheduledToolCall, ToolAdapterPort } from "@igis/llm-dispatch";
import { translateLocalToAi } from "@igis/ai-translation";
import { buildProvenanceRecord } from "@igis/provenance";
import type { ProvenanceLedger } from "@igis/provenance";
import type { GisQueryToolName } from "@igis/shared-types";

export interface GisToolContext {
  readonly ledger: ProvenanceLedger;
  readonly gdalWasm: GdalWasmReadPort;
  readonly runtime: GdalRuntime;
}

function argString(call: ScheduledToolCall, name: string): string {
  const value = call.args[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new LlmInvokeError("invalid-tool-arguments", `缺少参数 ${name}。`);
  }
  return value;
}

function publicMetadata(layer: GisLayerMetadata): Readonly<Record<string, unknown>> {
  return {
    layerName: layer.layerName,
    fields: layer.fields.map((field) => ({ name: field.name, fieldType: field.fieldType })),
    crs: layer.crs,
    featureCount: layer.featureCount,
    geometryType: layer.geometryType,
  };
}

async function writeCallAudit(
  ledger: ProvenanceLedger,
  toolName: GisQueryToolName,
  absolutePath: string,
  layerNames: readonly string[],
  success: boolean,
  started: number,
): Promise<void> {
  const sourceContent = await readSourceDigestMaterial(absolutePath);
  await ledger.append(
    buildProvenanceRecord({
      sourceContent,
      exportPath: null,
      layerNames,
      toolName,
      success,
      durationMs: Date.now() - started,
    }),
  );
}

export async function executeGisQuery(call: ScheduledToolCall, context: GisToolContext): Promise<Readonly<Record<string, unknown>>> {
  if (call.tool !== "list-layers" && call.tool !== "get-layer-metadata" && call.tool !== "get-sample-feature") {
    throw new LlmInvokeError("unknown-tool", `适配器不执行工具: ${call.tool}`);
  }
  const toolName = call.tool;
  const started = Date.now();
  const filePath = argString(call, "filePath");
  const absolutePath = resolve(filePath);
  let layerNames: string[] = [];
  try {
    if (toolName === "list-layers") {
      const result = await routeGisRead(context, { absolutePath, layerName: null }, context.ledger);
      layerNames = [...result.layerNames];
      const payload = { layerNames };
      await writeCallAudit(context.ledger, toolName, absolutePath, layerNames, true, started);
      return translateLocalToAi(payload) as Readonly<Record<string, unknown>>;
    }
    if (toolName === "get-layer-metadata") {
      const layerName = argString(call, "layerName");
      const result = await routeGisRead(context, { absolutePath, layerName }, context.ledger);
      const layer = result.metadata[0];
      if (!layer) throw new GisIoReadError("gdal-wasm", "请求的图层不存在。", "read-failed");
      layerNames = [layer.layerName];
      const payload = publicMetadata(layer);
      await writeCallAudit(context.ledger, toolName, absolutePath, layerNames, true, started);
      return translateLocalToAi(payload) as Readonly<Record<string, unknown>>;
    }
    if (toolName === "get-sample-feature") {
      const layerName = argString(call, "layerName");
      const sample = await readGisSampleFeatures(context.runtime, absolutePath, layerName);
      layerNames = [sample.layerName];
      const payload = {
        layerName: sample.layerName,
        geometryType: sample.geometryType,
        sampleCount: sample.features.length,
        stoppedAtLimit: sample.stoppedAtLimit,
        features: sample.features.map((feature) => ({
          featureId: feature.featureId,
          geometryType: feature.geometryType,
          attributes: feature.attributes,
        })),
      };
      await writeCallAudit(context.ledger, toolName, absolutePath, layerNames, true, started);
      return translateLocalToAi(payload) as Readonly<Record<string, unknown>>;
    }
    throw new LlmInvokeError("unknown-tool", `适配器不执行工具: ${toolName}`);
  } catch (error) {
    await writeCallAudit(context.ledger, toolName, absolutePath, layerNames, false, started);
    throw error;
  }
}

export async function createGisToolAdapter(ledger: ProvenanceLedger): Promise<ToolAdapterPort> {
  const gdalWasm = await createGdalWasmReadPort();
  const runtime = await loadGdalRuntime();
  const context: GisToolContext = { ledger, gdalWasm, runtime };
  return {
    execute(call) {
      return executeGisQuery(call, context);
    },
  };
}

export interface GisRagChunk {
  readonly title: string;
  readonly body: string;
  readonly layerNames: readonly string[];
}

function metadataText(layer: GisLayerMetadata): string {
  const fields = layer.fields.map((field) => `${field.name}:${field.fieldType}`).join(", ");
  return [
    `图层 ${layer.layerName}`,
    `坐标系 ${layer.crs}`,
    `几何类型 ${layer.geometryType}`,
    `要素数量 ${layer.featureCount ?? "未知"}`,
    `字段 ${fields || "无"}`,
  ].join("\n");
}

/** 把图层元数据和样例属性收成可入库的文字。不含坐标和范围。 */
export async function collectGisRagChunks(absolutePath: string, ledger: ProvenanceLedger): Promise<readonly GisRagChunk[]> {
  const gdalWasm = await createGdalWasmReadPort();
  const runtime = await loadGdalRuntime();
  const result = await routeGisRead({ gdalWasm }, { absolutePath: resolve(absolutePath), layerName: null }, ledger);
  const chunks: GisRagChunk[] = [];
  for (const layer of result.metadata) {
    chunks.push({
      title: `${layer.layerName} 元数据`,
      body: metadataText(layer),
      layerNames: [layer.layerName],
    });
    if (layer.geometryType === "raster") continue;
    const sample = await readGisSampleFeatures(runtime, absolutePath, layer.layerName);
    for (const feature of sample.features) {
      const pairs = Object.entries(feature.attributes)
        .map(([name, value]) => `${name}=${String(value)}`)
        .join("; ");
      const body = translateLocalToAi(`图层 ${layer.layerName}\n样例序号 ${feature.featureId}\n几何类型 ${feature.geometryType}\n属性 ${pairs || "无"}`);
      chunks.push({
        title: `${layer.layerName} 样例 ${feature.featureId}`,
        body: typeof body === "string" ? body : "几何已省略",
        layerNames: [layer.layerName],
      });
    }
  }
  return chunks;
}
