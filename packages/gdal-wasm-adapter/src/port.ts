// SPDX-License-Identifier: Apache-2.0

import type { GdalWasmReadPort } from "@igis/gis-io";
import { readGisMetadata } from "./read.js";
import { loadGdalRuntime } from "./runtime.js";
import type { GdalDriverAvailability } from "./runtime.js";

/** 注入给 @igis/gis-io 的只读端口。失败时抛出读取错误，不在本端口里决定回退。 */
export async function createGdalWasmReadPort(): Promise<GdalWasmReadPort> {
  const runtime = await loadGdalRuntime();
  return {
    id: "gdal-wasm",
    read(request) {
      return readGisMetadata(runtime, request);
    },
  };
}

/** 报告当前预编译包里实际编进去的驱动，不把缺失驱动说成可用。 */
export async function probeGdalDrivers(): Promise<GdalDriverAvailability> {
  const runtime = await loadGdalRuntime();
  return runtime.drivers;
}
