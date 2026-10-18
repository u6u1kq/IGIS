// SPDX-License-Identifier: Apache-2.0

/**
 * V0.92 英语适配：本地意图、系统提示、坐标系拒绝句。
 * 运行：npx tsx --tsconfig tsconfig.json apps/cli/src/v092-check.ts
 */

import { buildGisSystemPrompt } from "@igis/llm-dispatch";
import { englishToolDescription } from "../../../packages/llm-dispatch/src/gis-prompt.js";
import { normalizeInstruction } from "../../../packages/llm-dispatch/src/local-intent.js";
import { CRS_UNKNOWN_SPATIAL, userCrsMessage } from "../../../packages/spatial-ops/src/crs-policy.js";
import { runWithUserLocale } from "../../../packages/spatial-ops/src/locale.js";
import { describeOp } from "../../../packages/spatial-ops/src/ops.js";

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

const english = normalizeInstruction("buffer roads by 500 meters", [{ layerId: "lyr-roads", layerName: "roads" }]);
check(english?.intent === "buffer", "英语 buffer 应识别为缓冲");
check(english?.distance?.distance === 500, "500 meters 应折成 500 米");
check(english?.layers.includes("roads") === true, "已载入的英语图层名应被认出");

const both = normalizeInstruction("buffer roads by 100 meters then clip parks", [
  { layerId: "lyr-roads", layerName: "roads" },
  { layerId: "lyr-parks", layerName: "parks" },
]);
check(both?.intent === "buffer-clip", "英语 buffer then clip 应识别为先缓冲再裁剪");

const chinese = normalizeInstruction("把道路缓冲 200 米", [{ layerId: "lyr-road", layerName: "道路" }]);
check(chinese?.intent === "buffer" && chinese.distance?.distance === 200, "中文缓冲意图保持可用");

const prompt = buildGisSystemPrompt(undefined, "en");
check(prompt.includes("Do not invent geometry") && prompt.includes("map.calculateField"), "英语系统提示应说明不生成几何");
check(englishToolDescription("map.buffer", "缓冲").toLowerCase().includes("buffer"), "英语工具说明应覆盖缓冲");

const refusal = runWithUserLocale("en", () => userCrsMessage(CRS_UNKNOWN_SPATIAL));
check(refusal.includes("undeclared"), "英语界面的未声明坐标系拒绝应为英语");
check(userCrsMessage(CRS_UNKNOWN_SPATIAL) === CRS_UNKNOWN_SPATIAL, "默认语言仍返回中文拒绝句");

const done = runWithUserLocale("en", () => describeOp("缓冲", { collection: { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [0, 0] } }] }, skipped: 0, notes: [], corrupt: false }));
check(done.startsWith("Finished buffer"), `英语工具结果句不对：${done}`);

console.log("v092-check passed");
