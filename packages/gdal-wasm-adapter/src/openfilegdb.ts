// SPDX-License-Identifier: Apache-2.0

import type { LayerSummary } from "@igis/shared-types";
import { GisIoReadError, readSourceDigestMaterial } from "@igis/gis-io";
import type { GisLayerMetadata } from "@igis/gis-io";
import type { OpenFileGdbReader, OpenFileGdbSession } from "@igis/io-openfilegdb";
import { hashSourceContent } from "@igis/provenance";
import { readGisMetadata } from "./read.js";
import { loadGdalRuntime } from "./runtime.js";

function toSummary(layer: GisLayerMetadata): LayerSummary {
  if (layer.extent === null || layer.featureCount === null) {
    throw new GisIoReadError(
      "gdal-wasm",
      `图层 ${layer.layerName} 没有可靠的范围或要素数量，拒绝用 0 填充。`,
      "read-failed",
    );
  }
  return {
    layerName: layer.layerName,
    geometryType: layer.geometryType,
    crs: layer.crs,
    fieldNames: layer.fields.map((field) => field.name),
    featureCount: layer.featureCount,
    extent: layer.extent,
  };
}

/**
 * OpenFileGDB 只读会话。
 * 驱动若未编入预编译包，open 直接失败，不伪造图层。
 * 该路径不等价于 ArcGIS Pro，也没有写回方法。
 */
export async function createOpenFileGdbReader(): Promise<OpenFileGdbReader> {
  const runtime = await loadGdalRuntime();
  return {
    driver: "OpenFileGDB",
    mode: "readonly",
    openFlags: ["GDAL_OF_READONLY"],
    async open(absolutePath: string): Promise<OpenFileGdbSession> {
      if (!absolutePath.toLowerCase().endsWith(".gdb")) {
        throw new GisIoReadError("gdal-wasm", "OpenFileGDB 只接受 .gdb 路径。", "open-failed");
      }
      const result = await readGisMetadata(runtime, { absolutePath, layerName: null });
      const sourceContentHash = hashSourceContent(await readSourceDigestMaterial(absolutePath));
      return {
        driver: "OpenFileGDB",
        readOnly: true,
        hashAlgorithm: "SHA-256",
        sourceContentHash,
        async listLayers(): Promise<readonly LayerSummary[]> {
          return result.metadata.filter((layer) => layer.geometryType !== "raster").map((layer) => toSummary(layer));
        },
        async readLayer(layerName: string) {
          const index = result.metadata.findIndex((layer) => layer.layerName === layerName);
          const layer = index >= 0 ? result.metadata[index] : undefined;
          if (!layer) {
            throw new GisIoReadError("gdal-wasm", "请求的图层不存在。", "read-failed");
          }
          return {
            handle: `${result.memory.handle}-l${index}`,
            kind: result.memory.kind,
            byteLength: result.memory.byteLength,
            crs: layer.crs,
            ephemeral: true,
          };
        },
      };
    },
  };
}
