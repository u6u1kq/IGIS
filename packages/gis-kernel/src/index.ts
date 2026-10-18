// SPDX-License-Identifier: Apache-2.0

import type {
  FunctionCall,
  FunctionResult,
  PermissiveLicense,
} from "@igis/shared-types";

export type GisBackendKind = "io" | "vector" | "raster";

export interface GisKernelContext {
  readonly sessionId: string;
  readonly readOnlySource: true;
}

/** 可插拔 GIS 后端。主仓库只接受宽松许可证实现。 */
export interface GisBackendPlugin {
  readonly id: string;
  readonly kind: GisBackendKind;
  readonly licenseClass: PermissiveLicense;
  execute(call: FunctionCall, ctx: GisKernelContext): Promise<FunctionResult>;
}

export interface ToolBinding {
  readonly toolPrefix: "io" | "vector" | "raster";
  readonly pluginId: string;
}

/**
 * V0.1 的 GIS 内核抽象。
 * 本接口不包含 SurtGIS、GDAL 或 DuckDB 的算法实现。
 */
export interface GisKernel {
  register(plugin: GisBackendPlugin): void;
  unregister(id: string): void;
  get(id: string): GisBackendPlugin | undefined;
  list(): readonly GisBackendPlugin[];
  execute(call: FunctionCall, ctx: GisKernelContext): Promise<FunctionResult>;
}
