// SPDX-License-Identifier: Apache-2.0

import type { RetrievalConfig } from "@igis/shared-types";

/** 本地 SQLite WASM，sqlite-vec 编在 wasm 里。数据在 var/rag，没有外部向量服务。 */
export const RAG_IMPLEMENTATION = "sqlite-wasm-vec" as const;

/** 本地三元组嵌入，再用 vec0 做近邻检索。 */
export const RAG_LOCAL_STRATEGY = "local-trigram+sqlite-vec" as const;

export interface RagStyleSummary {
  readonly mode: "single" | "choropleth" | "category";
  readonly field: string | null;
  readonly ramp: string | null;
}

/**
 * 向量库文档。允许图层名、字段名、坐标系、要素数量、范围和样式摘要。
 * 不设置几何正文字段。范围留在进程内，不进入来源账本，也不发给模型。
 */
export interface RagMetadataDocument {
  readonly layerName: string;
  readonly fieldNames: readonly string[];
  readonly crs: string;
  readonly featureCount: number;
  readonly extent: readonly [number, number, number, number] | null;
  readonly style: RagStyleSummary | null;
}

export interface RagQuery {
  readonly layerName?: string;
  readonly fieldNames?: readonly string[];
  readonly text?: string;
}

export interface RagHit {
  readonly document: RagMetadataDocument;
  readonly score: number;
}

/**
 * 检索抽象。云端开关见 retrieval.cloudEnabled，出厂为 false。
 * query 若要落地，必须先按图层名、字段名和文本做结构化过滤。本接口不计算嵌入。
 */
export { VECTOR_DIMENSION, chunkPlainText, embedText } from "./embed.js";
export {
  RAG_DIRECTORY,
  RagStoreError,
  SqliteVecRagStore,
  loadSqliteVecWasm,
  normalizeTopK,
  openSqliteVecRagStore,
} from "./store.js";
export type { RagAddInput, RagAdded, RagDocumentSummary, RagHitResult } from "./store.js";

export interface RagStore {
  readonly retrieval: RetrievalConfig;
  upsert(document: RagMetadataDocument): Promise<void>;
  query(query: RagQuery): Promise<readonly RagHit[]>;
}
