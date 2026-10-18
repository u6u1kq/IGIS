// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateProModel, installProModel, listProModelSlots, loadProModel, openSpatialStack } from "@igis/spatial-ops";
import { indexTrainingDirectory, stripAbsolutePaths, trainingPackModelText } from "@igis/llm-dispatch";

const failures: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

function model(name: string): unknown {
  return {
    format: "igis-pro-model",
    version: 1,
    name,
    kriging: { model: "spherical", nuggetRatio: 0.1, rangeRatio: 0.4, priorWeight: 8, neighbors: 8 },
    watershed: { streamArea: 1000, snapDistance: 20 },
    trainingSets: 2,
  };
}

function polygon(name: string, x: number): { type: "FeatureCollection"; features: [{ type: "Feature"; properties: { name: string }; geometry: { type: "Polygon"; coordinates: number[][][] } }] } {
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { name },
      geometry: { type: "Polygon", coordinates: [[[x, 0], [x + 10, 0], [x + 10, 10], [x, 10], [x, 0]]] },
    }],
  };
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "igis-v0951-"));
  try {
    const directory = join(root, "weights");
    await installProModel(directory, model("alpha"));
    await installProModel(directory, model("beta"));
    const library = await listProModelSlots(directory);
    check(library.slots.length === 2, `应保留两份权重，实际 ${library.slots.length}`);
    check(library.model?.name === "beta", `后安装的应是当前权重，实际 ${library.model?.name ?? ""}`);
    const alpha = library.slots.find((slot) => slot.name === "alpha");
    check(alpha !== undefined, "库里应有 alpha");
    if (alpha) {
      await activateProModel(directory, alpha.id);
      const active = await loadProModel(directory);
      check(active?.name === "alpha", `切换后应启用 alpha，实际 ${active?.name ?? ""}`);
    }

    const data = join(root, "pack");
    const points = {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: { prcp_mm: 12, outlet: 1 },
        geometry: { type: "Point", coordinates: [121.501, 31.202] },
      }],
    };
    await mkdir(data, { recursive: true });
    await writeFile(join(data, "points.geojson"), JSON.stringify(points), { encoding: "utf8" });
    await writeFile(join(data, "dem.tif"), "", { encoding: "utf8" });
    await writeFile(join(data, "dem.prj"), `PROJCS["WGS 84 / Pseudo-Mercator",UNIT["metre",1],AUTHORITY["EPSG","3857"]]`, { encoding: "utf8" });
    const index = await indexTrainingDirectory(data);
    const encoded = JSON.stringify(index);
    check(!encoded.includes("121.501") && !encoded.includes("31.202"), "索引不能含坐标");
    check(!encoded.includes(data), "索引不能含绝对路径");
    const point = index.find((entry) => entry.name === "points.geojson");
    check(point?.kind === "points" && point.numericFields.includes("prcp_mm") && point.outletContiguous === true, "点索引应有数值字段，且 outlet 从 1 连续");
    const dem = index.find((entry) => entry.name === "dem.tif");
    check(dem?.kind === "raster" && dem.epsg === "EPSG:3857" && dem.metric === true, "栅格只采用文件自己写明的 EPSG");
    const shown = trainingPackModelText({ text: `打包训练数据 ${data}`, index, locale: "zh-CN" });
    check(shown.includes("不能写 valueField") && shown.includes("不能写 rivers"), "给模型的说明要求 field 和 streams");
    check(!shown.includes(data), "给模型的文字去掉绝对路径");
    check(stripAbsolutePaths("E:\\secret\\train.py failed").includes("[path]"), "训练报错里的路径应去掉");

    const stack = await openSpatialStack({
      layerDirectory: join(root, "layers"),
      auditDirectory: join(root, "audit"),
      modelName: () => "v0951",
    });
    const left = await stack.catalog.insert({
      layerName: "甲",
      sourcePaths: [],
      collection: polygon("甲", 0),
      crsLabel: "EPSG:3857",
    });
    const right = await stack.catalog.insert({
      layerName: "乙",
      sourcePaths: [],
      collection: polygon("乙", 20),
      crsLabel: "EPSG:3857",
    });
    const merged = await stack.service.merge(left.layerId, right.layerId, false, "导入面");
    check(merged.layer !== null && merged.featureCount === 2, `声明了同一 EPSG 的两个面应合成一层，要素 ${merged.featureCount}`);
    check(!merged.message.includes("EPSG:326"), "合成时不另编一个 EPSG");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    console.log(`v0951-check failed ${failures.length}`);
    throw new Error(failures.join("\n"));
  }
  console.log("v0951-check passed");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  (globalThis as { process?: { exitCode?: number } }).process!.exitCode = 1;
});
