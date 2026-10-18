// SPDX-License-Identifier: Apache-2.0

/**
 * 对话范围、量词「两」和 crsLabel 白名单。
 * 不读仓库 var/，不监听端口。
 * 运行：npx tsx --tsconfig tsconfig.json apps/cli/src/review-fix-check.ts
 */

import { projectForModel } from "@igis/ai-translation";
import { collectPartialEntities, layersForConversationScope, parseDistanceMeters } from "@igis/llm-dispatch";

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

function main(): void {
  const layers = [
    { layerId: "lyr-a", layerName: "道路" },
    { layerId: "lyr-b", layerName: "用地" },
  ];
  const scoped = layersForConversationScope(layers, ["lyr-a"]);
  check(scoped.length === 1 && scoped[0]?.layerId === "lyr-a", "对话范围只保留范围内的图层");
  check(layersForConversationScope(layers, []).length === 0, "空的对话范围不交出图层库全集");
  check(layersForConversationScope(layers, ["missing"]).length === 0, "范围里没有的图层不交给模型");

  const measure = parseDistanceMeters("对这两个图层做缓冲");
  check(measure === null || measure.distance !== 2, "量词「两」不是 2 米");
  const twoHundred = parseDistanceMeters("缓冲两百");
  check(twoHundred?.distance === 200, "两百仍是 200 米");
  const twoMeters = parseDistanceMeters("缓冲两米");
  check(twoMeters?.distance === 2, "两米仍是 2 米");

  const sentence = "请把这两个图层缓冲一下";
  const partial = collectPartialEntities(sentence, []);
  check(!partial.layerCandidates.includes(sentence), "整句不是图层名");
  check(!partial.layerCandidates.some((name) => name.includes("两个") || name.includes("缓冲")), "虚词碎片不是图层名");
  check(partial.numbers.length === 0 || !partial.numbers.includes(2), "整句里的量词两不进距离");
  const named = collectPartialEntities("对道路做200米缓冲", [{ layerId: "lyr-a", layerName: "道路" }]);
  check(named.layerCandidates.includes("道路"), "已载入图层名仍然能认出");
  check(named.numbers[0] === 200, "200米仍然是距离");
  const english = collectPartialEntities("Find heat islands using Kriging interpolation on the temperature points.", []);
  check(english.layerCandidates.length === 0, "未载入的英文单词不是图层名");
  const unloaded = collectPartialEntities("请把地块缓冲一下", []);
  check(unloaded.layerCandidates.length === 0, "没载入的词不会被猜成图层名");
  const loadedEnglish = collectPartialEntities("Buffer roads by 100 meters", [{ layerId: "lyr-r", layerName: "roads" }]);
  check(loadedEnglish.layerCandidates.includes("roads"), "已载入的英文图层名仍然能认出");
  check(loadedEnglish.layerCandidates.length === 1, "英文句子里的其它单词不是图层名");

  const projected = projectForModel({
    layerId: "lyr-1",
    layerName: "地块",
    geometryKind: "Polygon",
    featureCount: 1,
    fieldNames: ["地块编号"],
    crsLabel: "局部平面",
    visible: true,
    order: 0,
    coordinates: [[118.75, 41.25]],
    bbox: [118, 41, 119, 42],
    wkt: "POLYGON((0 0, 1 0, 1 1, 0 0))",
  }) as Record<string, unknown>;
  const text = JSON.stringify(projected);
  check(projected.crsLabel === "局部平面", "白名单放行 crsLabel 标签");
  check(text.includes("地块编号"), "白名单放行字段名");
  check(!text.includes("coordinates") && !text.includes("118.75") && !text.includes("bbox") && !text.includes("POLYGON"), "坐标、范围和 WKT 仍被拒绝");

  const leaked = projectForModel(JSON.stringify({ crsLabel: "局部平面", coordinates: [[118.75, 41.25]] }));
  const leakedText = JSON.stringify(leaked ?? "");
  check(!leakedText.includes("118.75") && !leakedText.includes("coordinates"), "嵌在字符串里的坐标仍被拒绝");

  const prose = projectForModel({
    instruction: "Find heat islands using Kriging on points/polygons...",
    originalText: "Buffer the layer at C:/secret/dem.tif by 100 meters.",
  }) as { instruction?: string; originalText?: string };
  check(typeof prose.instruction === "string" && prose.instruction.includes("Find heat islands"), "含斜杠和省略号的题面要留下");
  check(!prose.instruction?.includes("..") && !prose.instruction?.includes("/"), "题面里的斜杠和省略号要拿掉");
  check(typeof prose.originalText === "string" && prose.originalText.includes("Buffer"), "带路径的任务句要留下");
  check(!prose.originalText?.includes("C:/") && !prose.originalText?.includes("dem.tif"), "任务句里的路径要换成称呼");

  console.log("ok 对话范围、量词两、crsLabel 白名单");
}

main();
