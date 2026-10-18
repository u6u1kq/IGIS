// SPDX-License-Identifier: Apache-2.0

export const PROJECT_LICENSE = "Apache-2.0" as const;

/** 数据面：读取后经 GDAL-WASM 与 surtgis 矢量内核，导出时写新文件。 */
export const DATA_PLANE_ORDER = [
  "disk-read",
  "gdal-wasm-memory",
  "surtgis",
  "export-new-file",
] as const;

/** 控制面：只传递摘要与工具请求，不携带几何字节。 */
export const CONTROL_PLANE_ORDER = [
  "rag-metadata",
  "llm-function-call",
  "kernel-execute",
] as const;

export type DataPlaneStage = (typeof DATA_PLANE_ORDER)[number];
export type ControlPlaneStage = (typeof CONTROL_PLANE_ORDER)[number];

/**
 * 不连接真实 OSM 数据。
 * 后续版本才可能用 OSM 验证算子。微调样本不得嵌入 OSM 几何（ODbL）。
 */
export const OSM_POLICY = {
  connectedInV01: false,
  realOsmConnected: false,
  allowedUse: "operator-validation-only",
  embedGeometryInTrainingSamples: false,
} as const;

/**
 * qgis-wasm 不进入本仓库。
 * 直接链接的 GPL、LGPL、AGPL 拒绝入库。
 * 独立进程里的 GPL 可执行文件未链入本程序，许可证门禁不拦截。
 */
export const GPL_POLICY = {
  qgisWasmInThisRepository: false,
  qgisWasmInMainDistribution: false,
  formalReleaseDirectGplDependency: false,
  externalProcessGplIntercepted: false,
} as const;

export const PERMISSIVE_LICENSES = [
  "Apache-2.0",
  "MIT",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "PostgreSQL",
  "X11",
] as const;

export type PermissiveLicense = (typeof PERMISSIVE_LICENSES)[number];
