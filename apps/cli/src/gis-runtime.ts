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
 * 打开与桌面接口相同的 GIS 工具执行器：查询适配器 + 空间适配器 + GDL。
 * MCP 服务器和 desktop-api 共用这一份，不再实现第二套缓冲/相交。
 */
export async function openGisWorkspace(root: string, options: { readonly modelName: () => string; readonly entry?: "chat" | "mcp"; readonly externalEnabled?: boolean; readonly env?: Readonly<Record<string, string | undefined>> }): Promise<GisWorkspace> {
  const ledger = new InMemoryProvenanceLedger({ persistJson: true, directory: resolve(root, "var/provenance") });
  await ledger.load();
  const store = await openSqliteVecRagStore(resolve(root, "var/rag"), ledger);
  const gisAdapter: ToolAdapterPort = await createGisToolAdapter(ledger);
  const addRag = (input: { readonly title: string; readonly body: string; readonly layerNames: readonly string[]; readonly kind: "gis" }) => store.add(input);
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
    layerDirectory: resolve(root, "var/map-layers"),
    auditDirectory: resolve(root, "var/spatial-audit"),
    cacheDirectory: resolve(root, "var/cache"),
    modelName: options.modelName,
    addRag,
    external,
    engines,
    modelDirectory: resolve(root, "var/models/igis-pro"),
    dropDatabase: () => store.clear(),
  });
  const gdlDeps: GdlDeps = {
    spatial,
    gdlDirectory: resolve(root, "var/gdl"),
    addRag,
    operationsRoot: root,
  };
  const adapter: ToolAdapterPort = createGdlAwareAdapter(
    createSpatialAwareAdapter(gisAdapter, spatial.service, { entry: options.entry ?? "chat", operationsRoot: root }),
    gdlDeps,
  );
  return { adapter, spatial, store, ledger, gdlDeps, external, engines };
}
