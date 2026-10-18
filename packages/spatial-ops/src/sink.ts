// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";
import type { PublicMapLayer } from "./types.js";

/** 一次对话里新生成的图层。几何不放进这个列表。 */
export const spatialResultSink = new AsyncLocalStorage<PublicMapLayer[]>();
