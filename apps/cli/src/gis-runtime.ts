// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";
import { env as nodeEnv } from "node:process";
import { createGisToolAdapter } from "@igis/gis-tools";
import { createSpatialAwareAdapter, openSpatialStack } from "@igis/spatial-ops";
import { createProcessBackend, enginesDirectory, enginesPythonPath, ExternalCapabilityBoundary, resolvePythonCommand } from "@igis/external-gateway";
import { InMemoryProvenanceLedger } from "@igis/provenance";
import { openSqliteVecRagStore } from "@igis/rag-meta";
import type { SqliteVecRagStore } from "@igis/rag-meta";
import type { ToolAdapterPort } from "@igis/llm-dispatch";
import { createGdlAwareAdapter } from "./gdl-http.js";
import type { GdlDeps } from "./gdl-http.js";
import type { SpatialStack } from "@igis/spatial-ops";
import type { ProvenanceLedger } from "@igis/provenance";

export interface GisWorkspace {
  readonly adapter: ToolAdapterPort;
  readonly spatial: SpatialStack;
  readonly store: SqliteVecRagStore;
  readonly ledger: ProvenanceLedger;
  readonly gdlDeps: GdlDeps;
  readonly external: ExternalCapabilityBoundary;
  readonly engines: ExternalCapabilityBoundary;
}

/**
 * 工作区连接。桌面进程和 MCP 只从这里把各模块装到一起。
 * 查询在 gis-tools，空间运算在 spatial-ops，GDL 在 gdl-http，
 * 外部进程在 external-gateway，账本在 provenance。
 * 各模块的实现文件不互相打开对方的存储。
 */
export async function openGisWorkspace(root: string, options: { readonly modelName: () => string; readonly entry?: "chat" | "mcp"; readonly externalEnabled?: boolean; readonly env?: Readonly<Record<string, string | undefined>> }): Promise<GisWorkspace> {
  const ledger = new InMemoryProvenanceLedger({ persistJson: true, directory: resolve(root, "var/provenance") });
  await ledger.load();
  const store = await openSqliteVecRagStore(resolve(root, "var/rag"), ledger);
  const gisAdapter: ToolAdapterPort = await createGisToolAdapter(ledger);
  const gdalScript = resolve(root, "packages/external-gateway/scripts/gdal-bridge.py");
  const pythonEnv = options.env ?? nodeEnv;
  const external = new ExternalCapabilityBoundary({
    enabled: options.externalEnabled !== false,
    backend: createProcessBackend({
      name: "python-osgeo-gdal",
      command: () => resolvePythonCommand(root, pythonEnv),
      args: [gdalScript],
      availabilityArgs: [gdalScript, "--check"],
      env: { IGIS_BACKEND_ROOT: resolve(root) },
    }),
  });
  const engineScript = resolve(root, "packages/external-gateway/scripts/engine-bridge.py");
  const engines = new ExternalCapabilityBoundary({
    enabled: options.externalEnabled !== false,
    backend: createProcessBackend({
      name: "engines-python",
      command: () => enginesPythonPath(root) ?? "python",
      args: [engineScript],
      availabilityArgs: [engineScript, "--check"],
      env: { IGIS_BACKEND_ROOT: resolve(root), IGIS_ENGINE_DIR: enginesDirectory(resolve(root)) },
    }),
  });
  const spatial = await openSpatialStack({
    // 启动时的空句柄。用户图层只在进入某条对话后写到该对话的 layers 目录。
    layerDirectory: resolve(root, "var/conversation-workspaces/_idle/layers"),
    auditDirectory: resolve(root, "var/spatial-audit"),
    cacheDirectory: resolve(root, "var/cache"),
    modelName: options.modelName,
    external,
    engines,
    modelDirectory: resolve(root, "var/models/igis-pro"),
  });
  const gdlDeps: GdlDeps = {
    spatial,
    gdlDirectory: resolve(root, "var/gdl"),
    operationsRoot: root,
  };
  const adapter: ToolAdapterPort = createGdlAwareAdapter(
    createSpatialAwareAdapter(gisAdapter, spatial.service, { entry: options.entry ?? "chat", operationsRoot: root }),
    gdlDeps,
  );
  return { adapter, spatial, store, ledger, gdlDeps, external, engines };
}
