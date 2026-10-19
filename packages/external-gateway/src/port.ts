// SPDX-License-Identifier: Apache-2.0

/**
 * External Capability Boundary。
 * 外部处理后端（GDAL 薄封装 / gdal-mcp / 其它本地后端）的通道契约：
 *   - 请求只有本地资源标识与标量参数：没有文件路径、没有坐标、没有授权字段；
 *   - 结果分两部分：facts（模型可见摘要，必须过白名单投影）与 outputResources（本地资源标识，永不出可见面）；
 *   - 后端是可选适配器：未配置 = 能力整体下线，核心能力不受影响。
 */

/** 外部能力请求：模型侧可见的只有 capability 名与标量参数。 */
export interface ExternalCapabilityRequest {
  /** 能力名，如 "gdal.makeValid"。与登记能力一一对应。 */
  readonly capability: string;
  /** 输入资源的本地标识（图层标识/资源标识）。解析成路径只发生在后端进程边界内。 */
  readonly inputResources: readonly string[];
  /** 输出资源命名提示（非路径）。 */
  readonly outputHint?: string;
  /** 标量参数。禁止授权字段、路径键、几何键。 */
  readonly parameters: Record<string, string | number | boolean | null>;
}

/** 后端原始结果。未经投影，永远不直接返回给调用方之外的任何通道。 */
export interface ExternalBackendResult {
  readonly ok: boolean;
  /** 本地资源标识（内部文件/图层标识）。永不出模型可见面。 */
  readonly outputResources?: readonly string[];
  /** 模型可见事实候选（计数、CRS 名、统计值等）。必须经投影后才可见。 */
  readonly facts?: Record<string, unknown>;
  readonly message?: string;
}

/** 边界处理后的结果：facts 已过投影；outputResources 标记为本地专用。 */
export interface ExternalCapabilityOutcome {
  readonly ok: boolean;
  /** 投影后的模型可见事实。 */
  readonly facts?: Record<string, unknown>;
  readonly message?: string;
  /** 本地资源标识。仅供运行时写图层库/留痕，禁止进入模型通道。 */
  readonly localOutputResources?: readonly string[];
  readonly code?: string;
}

export interface ExternalBackendPort {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  checkAvailability?(): Promise<{ readonly available: boolean; readonly message: string }>;
  invoke(request: ExternalCapabilityRequest): Promise<ExternalBackendResult>;
}
