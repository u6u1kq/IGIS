// SPDX-License-Identifier: Apache-2.0

import type { MemoryRef } from "./memory.js";
import type { ControlMessage } from "./pipeline.js";
import type { ControlPlaneStage, DataPlaneStage } from "./policy.js";

/**
 * 数据面引用。几何字节只存在于 ref 背后的进程内缓冲。
 * 本结构不携带 WKT、WKB 或坐标数组。
 * V0.3 只读元数据在 @igis/gdal-wasm-adapter。GeoArrow 与 DuckDB 仍未实现。
 */
export interface DataPlaneRef {
  readonly stage: DataPlaneStage;
  readonly ref: MemoryRef;
}

/**
 * 控制面信封。只放摘要和工具请求，不放几何字节。
 * LayerSummary.extent 是进程内范围四元组，不得写入来源账本，也不得发给模型。
 */
export interface ControlPlaneEnvelope {
  readonly stage: ControlPlaneStage;
  readonly message: ControlMessage;
}
