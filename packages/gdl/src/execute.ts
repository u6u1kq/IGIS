// SPDX-License-Identifier: Apache-2.0

import type { GdlLayerStatement, GdlProgram, GdlStylePatch, GdlUnit } from "./ast.js";

export interface GdlLayerRef {
  readonly layerId: string;
  readonly layerName: string;
}

/**
 * 执行 GDL 时由宿主提供的能力。GDL 包本身不做几何计算，也不读写文件。
 * 缓冲、相交、裁剪由宿主转给 GIS 内核，结果作为新图层进入图层库。
 */
export interface GdlHost {
  resolveLayer(name: string): GdlLayerRef | null;
  createLayer(statement: GdlLayerStatement): Promise<GdlLayerRef>;
  buffer(input: GdlLayerRef, distance: number, unit: GdlUnit, output: string): Promise<GdlLayerRef>;
  intersect(input: GdlLayerRef, other: GdlLayerRef, output: string): Promise<GdlLayerRef>;
  clip(input: GdlLayerRef, other: GdlLayerRef, output: string): Promise<GdlLayerRef>;
  query(input: GdlLayerRef, filter: string, output: string): Promise<GdlLayerRef>;
  /** 字段统计摘要（数字文字，不含坐标）。 */
  stats(input: GdlLayerRef, field: string | null): Promise<string>;
  /** 度量摘要（数字文字，不含坐标）。 */
  measure(kind: "area" | "length" | "distance", input: GdlLayerRef, other: GdlLayerRef | null): Promise<string>;
  setStyle(layer: GdlLayerRef, style: Omit<GdlStylePatch, "order">): Promise<void>;
  setOrder(entries: readonly { readonly layer: GdlLayerRef; readonly order: number }[]): Promise<void>;
}

export interface GdlStep {
  readonly line: number;
  readonly kind: "layer" | "style" | "buffer" | "intersect" | "clip" | "query" | "stats" | "measure";
  readonly layerName: string;
  /** stats/measure 的数字摘要。 */
  readonly summary?: string;
}

export interface GdlExecution {
  readonly layers: readonly GdlLayerRef[];
  readonly steps: readonly GdlStep[];
}

/** 执行期错误。line 是出错语句的行号；cause 保留宿主原始错误（例如逐要素几何问题）。 */
export class GdlRuntimeError extends Error {
  readonly line: number;
  readonly cause: unknown;

  constructor(line: number, message: string, cause: unknown = null) {
    super(`GDL 第 ${line} 行：${message}`);
    this.name = "GdlRuntimeError";
    this.line = line;
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function withoutOrder(style: Readonly<GdlStylePatch>): Omit<GdlStylePatch, "order"> {
  const { order: _order, ...rest } = style;
  return rest;
}

function hasStyle(style: Omit<GdlStylePatch, "order">): boolean {
  return Object.keys(style).length > 0;
}

/** 按语句顺序执行。脚本里定义的名字优先，其次是图层库里的同名图层。 */
export async function executeGdl(program: GdlProgram, host: GdlHost): Promise<GdlExecution> {
  const scope = new Map<string, GdlLayerRef>();
  const created: GdlLayerRef[] = [];
  const steps: GdlStep[] = [];
  const orders = new Map<string, { layer: GdlLayerRef; order: number }>();
  const resolve = (name: string, line: number): GdlLayerRef => {
    const found = scope.get(name) ?? host.resolveLayer(name);
    if (!found) throw new GdlRuntimeError(line, `找不到图层 ${name}。请先载入它，或在前面用 LAYER 定义。`);
    return found;
  };
  for (const statement of program.statements) {
    try {
      if (statement.kind === "layer") {
        const layer = await host.createLayer(statement);
        scope.set(statement.name, layer);
        created.push(layer);
        if (statement.style.order !== undefined) orders.set(layer.layerId, { layer, order: statement.style.order });
        steps.push({ line: statement.line, kind: "layer", layerName: layer.layerName });
      } else if (statement.kind === "style") {
        const layer = resolve(statement.layer, statement.line);
        const style = withoutOrder(statement.style);
        if (hasStyle(style)) await host.setStyle(layer, style);
        if (statement.style.order !== undefined) orders.set(layer.layerId, { layer, order: statement.style.order });
        steps.push({ line: statement.line, kind: "style", layerName: layer.layerName });
      } else if (statement.kind === "buffer") {
        const input = resolve(statement.input, statement.line);
        const layer = await host.buffer(input, statement.distance, statement.unit, statement.output);
        scope.set(statement.output, layer);
        created.push(layer);
        steps.push({ line: statement.line, kind: "buffer", layerName: layer.layerName });
      } else if (statement.kind === "query") {
        const input = resolve(statement.input, statement.line);
        const layer = await host.query(input, statement.filter, statement.output);
        scope.set(statement.output, layer);
        created.push(layer);
        steps.push({ line: statement.line, kind: "query", layerName: layer.layerName });
      } else if (statement.kind === "stats") {
        const input = resolve(statement.input, statement.line);
        const summary = await host.stats(input, statement.field);
        steps.push({ line: statement.line, kind: "stats", layerName: input.layerName, summary });
      } else if (statement.kind === "measure") {
        const input = resolve(statement.input, statement.line);
        const other = statement.other === null ? null : resolve(statement.other, statement.line);
        const summary = await host.measure(statement.measure, input, other);
        steps.push({ line: statement.line, kind: "measure", layerName: input.layerName, summary });
      } else {
        const input = resolve(statement.input, statement.line);
        const other = resolve(statement.other, statement.line);
        const layer = statement.kind === "intersect"
          ? await host.intersect(input, other, statement.output)
          : await host.clip(input, other, statement.output);
        scope.set(statement.output, layer);
        created.push(layer);
        steps.push({ line: statement.line, kind: statement.kind, layerName: layer.layerName });
      }
    } catch (error) {
      if (error instanceof GdlRuntimeError) throw error;
      const message = error instanceof Error ? error.message : "执行失败。";
      throw new GdlRuntimeError(statement.line, message, error);
    }
  }
  if (orders.size > 0) {
    const entries = [...orders.values()].sort((left, right) => left.order - right.order);
    await host.setOrder(entries);
  }
  return { layers: created, steps };
}
