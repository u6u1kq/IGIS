// SPDX-License-Identifier: Apache-2.0

/**
 * V0.77 坐标系、缓存、查询类型、自相交和派生来源。
 * 只用操作系统临时目录，不读仓库 var/，不监听端口。
 * 运行：npx tsx --tsconfig tsconfig.json apps/cli/src/v077-consistency-check.ts
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ConversationStore } from "./conversations.js";
import { rollbackChatTurn } from "./turn-rollback.js";
import { SpatialResultCache, spatialCacheKey } from "../../../packages/spatial-ops/src/result-cache.js";
import { openSpatialStack } from "../../../packages/spatial-ops/src/service.js";
import type { SpatialStack, SpatialStackOptions } from "../../../packages/spatial-ops/src/service.js";
import { matchAttribute } from "../../../packages/spatial-ops/src/text.js";
import type { MapCollection } from "../../../packages/spatial-ops/src/types.js";

const REPO_ROOT = resolve("E:/ai工作区/Igis");

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

function samePath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function square(name: string, dx: number): MapCollection {
  const x0 = dx;
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { name },
      geometry: { type: "Polygon", coordinates: [[[x0, 0], [x0, 1], [x0 + 1, 1], [x0 + 1, 0], [x0, 0]]] },
    }],
  };
}

function namesOf(collection: MapCollection | null, field: string): string[] {
  if (!collection) return [];
  return collection.features.map((feature) => {
    const value = feature.properties[field];
    return value === null || value === undefined ? "" : String(value);
  });
}

async function expectReject(run: () => Promise<unknown>, parts: readonly string[]): Promise<string> {
  try {
    const value = await run();
    throw new Error(`应当拒绝，却成功返回 ${JSON.stringify(value).slice(0, 180)}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("应当拒绝")) throw error;
    const message = error instanceof Error ? error.message : String(error);
    for (const part of parts) {
      if (!message.includes(part)) throw new Error(`错误文案缺少「${part}」：${message}`);
    }
    return message;
  }
}

function assertOpposite(
  properties: Record<string, string | number | boolean | null>,
  equalFilter: string,
  notEqualFilter: string,
): void {
  const equal = matchAttribute(properties, equalFilter);
  const notEqual = matchAttribute(properties, notEqualFilter);
  if (equal === notEqual) {
    throw new Error(`= 与 != 没有互为否定：${equalFilter} => ${String(equal)}，${notEqualFilter} => ${String(notEqual)}`);
  }
}

async function openAt(
  root: string,
  name: string,
  extra: Partial<SpatialStackOptions> = {},
): Promise<SpatialStack & { readonly dir: string; readonly layerDirectory: string; readonly cacheDirectory: string }> {
  const dir = join(root, name);
  const layerDirectory = join(dir, "layers");
  const cacheDirectory = join(dir, "cache");
  await mkdir(dir, { recursive: true });
  check(resolve(dir).toLowerCase().startsWith(resolve(root).toLowerCase()), "用例目录必须在临时目录里");
  check(!resolve(dir).toLowerCase().startsWith(REPO_ROOT.toLowerCase()), "用例目录不能落在仓库里");
  const stack = await openSpatialStack({
    layerDirectory,
    auditDirectory: join(dir, "audit"),
    cacheDirectory,
    modelName: () => "v077-check",
    ...extra,
  });
  return { ...stack, dir, layerDirectory, cacheDirectory };
}

async function cacheRecords(directory: string): Promise<readonly { layerId: string; layerName: string; inputLayerIds: readonly string[] }[]> {
  let names: string[] = [];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const records = [];
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const parsed = JSON.parse(await readFile(join(directory, name), { encoding: "utf8" })) as {
      layerId?: string;
      layerName?: string;
      inputLayerIds?: string[];
    };
    check(typeof parsed.layerId === "string" && typeof parsed.layerName === "string", `缓存记录不完整 ${name}`);
    const text = JSON.stringify(parsed);
    check(!text.includes("coordinates"), "缓存文件不能写坐标");
    records.push({
      layerId: parsed.layerId,
      layerName: parsed.layerName,
      inputLayerIds: parsed.inputLayerIds ?? [],
    });
  }
  return records;
}

function assertNoOperationId(value: object, label: string): void {
  check(!("operationId" in value), `${label} 不应编造 operationId`);
}

class PutFails extends SpatialResultCache {
  override async put(): Promise<void> {
    throw new Error("缓存目录写入失败");
  }
}

class PutAndInvalidateFail extends SpatialResultCache {
  override async put(): Promise<void> {
    throw new Error("缓存目录写入失败");
  }

  override async invalidateLayer(): Promise<void> {
    throw new Error("缓存索引没有清掉");
  }
}

function attributeRules(): void {
  assertOpposite({ n: 10 }, "n=10", "n!=10");
  assertOpposite({ n: 10 }, "n=10.0", "n!=10.0");
  assertOpposite({ n: "10.0" }, "n=10.0", "n!=10.0");
  assertOpposite({ n: "10.0" }, "n=10", "n!=10");
  assertOpposite({ n: "10" }, "n=10", "n!=10");
  assertOpposite({ n: "10" }, "n=10.0", "n!=10.0");
  assertOpposite({ n: 10.5 }, "n=10.50", "n!=10.50");
  assertOpposite({}, "n=", "n!=");
  assertOpposite({ n: null }, "n=", "n!=");
  assertOpposite({ n: "" }, "n=", "n!=");
  assertOpposite({}, "n=1", "n!=1");
  assertOpposite({ n: null }, "n=1", "n!=1");
  assertOpposite({ n: "" }, "n=0", "n!=0");
  assertOpposite({ n: 0 }, "n=0", "n!=0");
  assertOpposite({ n: 0 }, "n=", "n!=");
  assertOpposite({ flag: true }, "flag=true", "flag!=true");
  check(matchAttribute({ n: 10 }, "n=10") === true, "数字 10 等于筛选 10");
  check(matchAttribute({ n: 10 }, "n=10.0") === false, "数字 10 不等于文字 10.0");
  check(matchAttribute({ n: 10 }, "n!=10.0") === true, "数字 10 与文字 10.0 的 != 为真");
  check(matchAttribute({ n: "10.0" }, "n=10") === false, "字符串 10.0 不等于筛选 10");
  check(matchAttribute({ n: "10.0" }, "n!=10") === true, "字符串 10.0 与筛选 10 的 != 为真");
  check(matchAttribute({}, "n=") === true && matchAttribute({}, "n!=") === false, "缺失等于空筛选，!= 为假");
  check(matchAttribute({ n: null }, "n=") === true && matchAttribute({ n: "" }, "n!=") === false, "null 和空字符串都是空值");
  check(matchAttribute({ n: 10 }, "n>9") === true, "数字可以比较大小");
  check(matchAttribute({ n: 10 }, "n>10.0") === false, "比较运算也不把 10.0 收成 10");
  check(matchAttribute({ n: "10" }, "n>9") === false, "字符串属性不做数字比较");
  check(matchAttribute({ n: 10 }, "n>=10") === true, "大于等于仍按数字");
  const keyA = spatialCacheKey("spatial-query", ["lyr-a"], { queryKind: "attribute", attributeFilter: "name=甲" }, "hash", ["EPSG:4326"]);
  const keyB = spatialCacheKey("spatial-query", ["lyr-a"], { queryKind: "attribute", attributeFilter: "name=乙" }, "hash", ["EPSG:4326"]);
  const keyC = spatialCacheKey("buffer", ["lyr-a"], { distance: 10, unit: "meters" }, "hash", ["EPSG:4326"]);
  const keyD = spatialCacheKey("buffer", ["lyr-a"], { distance: 10, unit: "meters" }, "hash", ["EPSG:3857"]);
  check(keyA !== keyB, "不同筛选的缓存键必须不同");
  check(keyC !== keyD, "同一图层 id 的不同 crsLabel 缓存键必须不同");
  console.log("ok 属性类型与缓存键");
}

async function crsPolicy(root: string): Promise<void> {
  const stack = await openAt(root, "crs");
  const unknown = await stack.catalog.insert({
    layerName: "未知",
    sourcePaths: ["memory"],
    collection: square("a", 0),
    crsLabel: "未声明",
  });
  const blank = await stack.catalog.insert({
    layerName: "空白",
    sourcePaths: ["memory"],
    collection: square("b", 2),
    crsLabel: "   ",
  });
  check(stack.catalog.get(blank.layerId)?.crsLabel === "未声明", "空白坐标系应存成未声明");
  const left = await stack.catalog.insert({
    layerName: "甲",
    sourcePaths: ["memory"],
    collection: square("甲", 0),
    crsLabel: "EPSG:4326",
  });
  const right = await stack.catalog.insert({
    layerName: "乙",
    sourcePaths: ["memory"],
    collection: square("乙", 0.5),
    crsLabel: "EPSG:4326",
  });
  const projected = await stack.catalog.insert({
    layerName: "丙",
    sourcePaths: ["memory"],
    collection: square("丙", 0),
    crsLabel: "EPSG:3857",
  });
  const projectedSame = await stack.catalog.insert({
    layerName: "丁",
    sourcePaths: ["memory"],
    collection: square("丁", 0),
    crsLabel: "EPSG:3857",
  });
  const lower = await stack.catalog.insert({
    layerName: "小写",
    sourcePaths: ["memory"],
    collection: square("戊", 4),
    crsLabel: "epsg:4326",
  });
  const points = await stack.catalog.insert({
    layerName: "点",
    sourcePaths: ["memory"],
    collection: {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: { kind: "in" },
        geometry: { type: "Point", coordinates: [0.5, 0.5] },
      }],
    },
    crsLabel: "EPSG:4326",
  });

  const beforeUnknown = JSON.stringify(stack.catalog.collection(unknown.layerId));
  const unknownMessage = await expectReject(
    () => stack.service.buffer(unknown.layerId, 10, "meters", false),
    ["未声明", "不能保证空间含义"],
  );
  check(!unknownMessage.includes("重投影"), "未声明不应说成重投影问题");
  check(JSON.stringify(stack.catalog.collection(unknown.layerId)) === beforeUnknown, "拒绝后输入坐标不能变");
  await expectReject(() => stack.service.buffer(blank.layerId, 10, "meters", false), ["未声明", "不能保证空间含义"]);
  const beforeLower = JSON.stringify(stack.catalog.collection(lower.layerId));
  check(stack.catalog.get(lower.layerId)?.crsLabel === "EPSG:4326", "epsg:4326 收成 EPSG:4326");
  const lowerBuffered = await stack.service.buffer(lower.layerId, 10, "meters", false);
  check(lowerBuffered.layer !== null, "规范后的 EPSG:4326 可以缓冲");
  check(stack.catalog.get(lowerBuffered.layer.layerId)?.crsLabel === "EPSG:4326", "同一坐标系的结果仍是 EPSG:4326");
  check(JSON.stringify(stack.catalog.collection(lower.layerId)) === beforeLower, "同一坐标系不改输入坐标");

  const allowed = await stack.service.intersect(left.layerId, right.layerId, false);
  check(allowed.layer !== null && allowed.featureCount > 0, "两个 EPSG:4326 可以相交");
  check(stack.catalog.get(allowed.layer.layerId)?.crsLabel === "EPSG:4326", "结果沿用输入的 EPSG:4326");
  const beforeProjected = JSON.stringify(stack.catalog.collection(projected.layerId));
  const differ = await stack.service.intersect(left.layerId, projected.layerId, false);
  check(differ.layer !== null, "4326 与 3857 在本地变换后可以相交");
  check(stack.catalog.get(differ.layer.layerId)?.crsLabel === "EPSG:4326", "相交结果使用第一个图层的坐标系");
  check(JSON.stringify(stack.catalog.collection(projected.layerId)) === beforeProjected, "变换不改写输入图层坐标");
  const sameProjected = await stack.service.intersect(projected.layerId, projectedSame.layerId, false);
  check(sameProjected.layer !== null, "两个 EPSG:3857 可以相交");
  check(stack.catalog.get(sameProjected.layer.layerId)?.crsLabel === "EPSG:3857", "相同 3857 的结果仍存在 3857，不改成 4326");
  check(JSON.stringify(stack.catalog.collection(projected.layerId)) === beforeProjected, "相同坐标系不改输入坐标");

  await expectReject(
    () => stack.service.query(points.layerId, unknown.layerId, "点在面内", null, false),
    ["未声明", "不能保证空间含义"],
  );
  const attribute = await stack.service.query(unknown.layerId, null, "属性", "name=a", false);
  check(attribute.ok === true && attribute.message.includes("属性筛选"), "属性筛选在未声明坐标系上仍可运行");
  check(!attribute.message.includes("相交") && !attribute.message.includes("点在面"), "属性筛选不能说成跑了空间谓词");
  const stats = await stack.service.stats(unknown.layerId, null, false);
  check(typeof stats.auditRecordId === "string" && stats.auditRecordId !== "", "统计成功要带回审计号");
  assertNoOperationId(stats, "统计");
  const found = (await stack.audit.list()).find((item) => item.recordId === stats.auditRecordId);
  check(found?.operationType === "stats" && found.success === true, "统计审计号必须是真正写出的记录");
  console.log("ok 坐标系");
}

async function loadFileCrs(root: string): Promise<void> {
  const stack = await openAt(root, "load");
  const nonePath = join(stack.dir, "none.geojson");
  const namedPath = join(stack.dir, "named.geojson");
  const otherPath = join(stack.dir, "other.json");
  const wktPath = join(stack.dir, "wkt.geojson");
  const urnPath = join(stack.dir, "urn.geojson");
  const feature = square("载入", 0).features[0];
  check(feature !== undefined, "样例要素");
  await writeFile(nonePath, JSON.stringify({ type: "FeatureCollection", features: [feature] }), { encoding: "utf8" });
  await writeFile(namedPath, JSON.stringify({
    type: "FeatureCollection",
    crs: { type: "name", properties: { name: "EPSG:4326" } },
    features: [feature],
  }), { encoding: "utf8" });
  await writeFile(otherPath, JSON.stringify({
    type: "FeatureCollection",
    crs: "EPSG:3857",
    features: [feature],
  }), { encoding: "utf8" });
  await writeFile(wktPath, JSON.stringify({
    type: "FeatureCollection",
    crs: { type: "name", properties: { name: "GEOGCS[\"WGS 84\",DATUM[\"WGS_1984\"]]" } },
    features: [feature],
  }), { encoding: "utf8" });
  await writeFile(urnPath, JSON.stringify({
    type: "FeatureCollection",
    crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::4326" } },
    features: [feature],
  }), { encoding: "utf8" });

  const undeclared = await stack.service.loadFile(nonePath, null, false);
  check(stack.catalog.get(undeclared[0]?.layerId ?? "")?.crsLabel === "未声明", "没有 CRS 的 GeoJSON 不能写成 EPSG:4326");
  await expectReject(() => stack.service.buffer(undeclared[0]?.layerId ?? "", 10, "meters", false), ["未声明", "不能保证空间含义"]);
  const other = await stack.service.loadFile(otherPath, null, false);
  check(stack.catalog.get(other[0]?.layerId ?? "")?.crsLabel === "EPSG:3857", "文件里写明的 EPSG:3857 收成规范代码");
  const wkt = await stack.service.loadFile(wktPath, null, false);
  check(stack.catalog.get(wkt[0]?.layerId ?? "")?.crsLabel === "局部平面", "写了投影定义但证明不了 EPSG 的 WKT 是局部平面身份（V0.89），不是未声明");
  const named = await stack.service.loadFile(namedPath, null, false);
  check(stack.catalog.get(named[0]?.layerId ?? "")?.crsLabel === "EPSG:4326", "写明 EPSG:4326 的文件保留该标签");
  const buffered = await stack.service.buffer(named[0]?.layerId ?? "", 10, "meters", false);
  check(buffered.layer !== null, "写明 EPSG:4326 的文件可以缓冲");
  const urn = await stack.service.loadFile(urnPath, null, false);
  check(stack.catalog.get(urn[0]?.layerId ?? "")?.crsLabel === "EPSG:4326", "GeoJSON 的 EPSG:4326 URN 记为 EPSG:4326");
  console.log("ok 载入 CRS");
}

async function cacheIdentity(root: string): Promise<void> {
  const stack = await openAt(root, "cache");
  const source = await stack.catalog.insert({
    layerName: "地块",
    sourcePaths: ["memory"],
    collection: {
      type: "FeatureCollection",
      features: [square("甲", 0).features[0], square("乙", 3).features[0]].filter((feature) => feature !== undefined),
    },
    crsLabel: "EPSG:4326",
  });
  const first = await stack.service.query(source.layerId, null, "属性", "name=甲", false);
  const second = await stack.service.query(source.layerId, null, "属性", "name=乙", false);
  check(first.layer !== null && second.layer !== null, "两次属性筛选都应有结果");
  check(second.cached === false && second.layer.layerId !== first.layer.layerId, "不同筛选不能命中同一缓存");
  check(namesOf(stack.catalog.collection(second.layer.layerId), "name").join(",") === "乙", "第二次筛选必须真的按乙过滤");
  const again = await stack.service.query(source.layerId, null, "属性", "name=甲", false);
  check(again.cached === true && again.layer?.layerId === first.layer.layerId, "相同筛选应命中");

  const buffered = await stack.service.buffer(source.layerId, 200, "meters", false);
  const bufferedHit = await stack.service.buffer(source.layerId, 200, "meters", false);
  check(buffered.layer !== null && bufferedHit.cached === true && bufferedHit.layer?.layerId === buffered.layer.layerId, "相同缓冲应命中");
  const farther = await stack.service.buffer(source.layerId, 201, "meters", false);
  check(farther.cached === false && farther.layer?.layerId !== buffered.layer.layerId, "不同距离不能命中");
  const kilometers = await stack.service.buffer(source.layerId, 200, "kilometers", false);
  check(kilometers.cached === false && kilometers.layer?.layerId !== buffered.layer.layerId, "不同单位不能命中");
  const named = await stack.service.buffer(source.layerId, 200, "meters", false, "结果甲");
  check(named.cached === false && named.layer?.layerName === "结果甲", "不同输出名不能命中");

  const metaPath = join(stack.layerDirectory, `${source.layerId}.meta.json`);
  const meta = JSON.parse(await readFile(metaPath, { encoding: "utf8" })) as { crsLabel?: string };
  meta.crsLabel = "EPSG:4490";
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, { encoding: "utf8" });
  const reloaded = await openAt(root, "cache");
  check(reloaded.catalog.get(source.layerId)?.crsLabel === "EPSG:4490", "同一图层 id 读回新的 crsLabel");
  const changed = await reloaded.service.query(source.layerId, null, "属性", "name=甲", false);
  check(changed.cached === false && changed.layer?.layerId !== first.layer.layerId, "crsLabel 变了不能返回旧结果");
  check(reloaded.catalog.get(changed.layer?.layerId ?? "")?.crsLabel === "EPSG:4490", "新结果带的是新 crsLabel");
  check(reloaded.catalog.get(first.layer.layerId)?.crsLabel === "EPSG:4326", "旧结果图层仍是原来的坐标系");
  const beforeReject = reloaded.catalog.list().length;
  // V0.83 起，非 4326/3857 且无 WKT 的坐标系按新文案拒绝（带转换指引），行为仍是拒绝且不产出结果。
  await expectReject(() => reloaded.service.buffer(source.layerId, 200, "meters", false), ["EPSG:4490", "没有可用的投影定义"]);
  check(reloaded.catalog.list().length === beforeReject, "坐标系变了以后不能把旧缓冲当成新结果");
  check(reloaded.catalog.get(buffered.layer.layerId)?.crsLabel === "EPSG:4326", "旧缓冲结果不能被改写成新的坐标系");

  meta.crsLabel = "EPSG:4326";
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, { encoding: "utf8" });
  const restored = await openAt(root, "cache");
  const hit = await restored.service.buffer(source.layerId, 200, "meters", false);
  check(hit.cached === true && hit.layer?.layerId === buffered.layer.layerId, "坐标系改回后应命中原来的缓冲");
  check(hit.layer?.layerName === restored.catalog.get(buffered.layer.layerId)?.layerName, "命中结果使用目录中的图层名");
  console.log("ok 缓存身份");
}

async function removalAndRename(root: string): Promise<void> {
  const stack = await openAt(root, "life");
  const userFile = join(stack.dir, "user-source.geojson");
  await writeFile(userFile, "{\"type\":\"FeatureCollection\",\"features\":[]}\n", { encoding: "utf8" });
  const area = await stack.catalog.insert({
    layerName: "甲地",
    sourcePaths: [userFile],
    collection: square("甲", 0),
    crsLabel: "EPSG:4326",
  });
  const other = await stack.catalog.insert({
    layerName: "乙地",
    sourcePaths: ["memory-b"],
    collection: square("乙", 5),
    crsLabel: "EPSG:4326",
  });
  const fromArea = await stack.service.buffer(area.layerId, 20, "meters", false);
  const fromOther = await stack.service.buffer(other.layerId, 20, "meters", false);
  const fromAreaLayer = fromArea.layer;
  const fromOtherLayer = fromOther.layer;
  if (fromAreaLayer === null || fromOtherLayer === null) throw new Error("两个缓冲都应生成");
  const derived = stack.catalog.get(fromAreaLayer.layerId);
  check(derived?.sourcePaths.some((path) => samePath(path, area.outputFilePath)) === true, "派生图层应记下输入的生成路径");
  const derivedGeometry = JSON.stringify(stack.catalog.collection(fromAreaLayer.layerId));
  await writeFile(join(stack.cacheDirectory, "keep.txt"), "keep", { encoding: "utf8" });
  await stack.catalog.remove(fromOtherLayer.layerId);
  const rerun = await stack.service.buffer(other.layerId, 20, "meters", false);
  check(rerun.cached === false && rerun.layer?.layerId !== fromOtherLayer.layerId, "删掉结果后再算不能复活原图层");
  check(stack.catalog.get(fromOtherLayer.layerId) === null, "被删结果不在目录里");
  const afterResultDelete = await cacheRecords(stack.cacheDirectory);
  check(afterResultDelete.every((record) => record.layerId !== fromOtherLayer.layerId), "结果图层的缓存条目应删掉");

  await stack.catalog.remove(area.layerId);
  const kept = stack.catalog.get(fromAreaLayer.layerId);
  check(kept !== null, "删除来源不能删掉派生图层");
  check(JSON.stringify(stack.catalog.collection(kept.layerId)) === derivedGeometry, "派生图层几何保持不变");
  check(!kept.sourcePaths.some((path) => samePath(path, area.outputFilePath)), "派生图层不能再把已删除的生成路径当活来源");
  check(kept.sourcePaths.some((path) => samePath(path, userFile)), "用户原始路径还在");
  check((await stat(userFile)).isFile(), "不能删除用户源文件");
  check((await stat(kept.outputFilePath)).isFile(), "派生几何文件还在");
  const afterInputDelete = await cacheRecords(stack.cacheDirectory);
  check(afterInputDelete.every((record) => !record.inputLayerIds.includes(area.layerId) && record.layerId !== area.layerId), "输入图层相关的缓存应作废");
  check(afterInputDelete.some((record) => record.inputLayerIds.includes(other.layerId)), "无关图层的缓存要留下");
  check((await readdir(stack.cacheDirectory)).includes("keep.txt"), "缓存目录里的无关文件不能删");
  console.log("ok 删除与来源");

  const renameStack = await openAt(root, "rename");
  const road = await renameStack.catalog.insert({
    layerName: "道路",
    sourcePaths: ["memory"],
    collection: square("道路", 0),
    crsLabel: "EPSG:4326",
  });
  const made = await renameStack.service.buffer(road.layerId, 15, "meters", false);
  const madeLayer = made.layer;
  if (madeLayer === null) throw new Error("重命名前先有结果");
  const geometryBefore = await readFile(renameStack.catalog.get(madeLayer.layerId)?.outputFilePath ?? "", { encoding: "utf8" });
  const oldName = madeLayer.layerName;
  await renameStack.service.rename(madeLayer.layerId, "缓冲新名");
  const geometryAfter = await readFile(renameStack.catalog.get(madeLayer.layerId)?.outputFilePath ?? "", { encoding: "utf8" });
  check(geometryBefore === geometryAfter, "重命名不能重算几何");
  const hit = await renameStack.service.buffer(road.layerId, 15, "meters", false);
  check(hit.cached === true && hit.layer?.layerId === madeLayer.layerId, "重命名后仍命中同一结果");
  check(hit.layer?.layerName === "缓冲新名", "命中返回目录中的新名字");
  const stored = (await cacheRecords(renameStack.cacheDirectory)).find((record) => record.layerId === madeLayer.layerId);
  check(stored?.layerName === "缓冲新名" && stored.layerName !== oldName, "缓存文件不能留着旧名字");
  console.log("ok 重命名");
}

async function rollback(root: string): Promise<void> {
  const stack = await openAt(root, "rollback");
  const source = await stack.catalog.insert({
    layerName: "回退源",
    sourcePaths: ["memory"],
    collection: square("回退", 0),
    crsLabel: "EPSG:4326",
  });
  const first = await stack.service.buffer(source.layerId, 30, "meters", false);
  const firstLayer = first.layer;
  const firstAudit = first.auditRecordId;
  if (firstLayer === null || typeof firstAudit !== "string") throw new Error("回退前的缓冲应有结果和审计号");
  const second = await stack.service.buffer(source.layerId, 30, "meters", false);
  check(second.cached === true && second.layer?.layerId === firstLayer.layerId, "回退前确认缓存已命中");
  const chats = new ConversationStore(join(stack.dir, "chat"), join(stack.dir, "legacy.json"));
  await chats.load();
  await chats.append([
    { role: "user", text: "缓冲", at: new Date().toISOString() },
    {
      role: "assistant",
      text: "已缓冲。",
      at: new Date().toISOString(),
      createdLayerIds: [firstLayer.layerId],
      ragEntryIds: [],
      auditRecordIds: [firstAudit],
    },
  ]);
  const effects = await rollbackChatTurn({
    conversations: chats,
    removeLayer: (layerId) => stack.catalog.remove(layerId),
    deleteRag: async () => false,
    deleteAudit: (recordId) => stack.audit.remove(recordId),
  });
  check(effects.ok === true, `回退应完成：${effects.message}`);
  check(stack.catalog.get(firstLayer.layerId) === null, "回退已删除结果图层");
  const stale = await cacheRecords(stack.cacheDirectory);
  check(stale.every((record) => record.layerId !== firstLayer.layerId), "回退后的缓存不能再指向已删结果");
  const third = await stack.service.buffer(source.layerId, 30, "meters", false);
  check(third.cached === false && third.layer?.layerId !== firstLayer.layerId, "回退后再次缓冲不能复活已删图层");
  check(stack.catalog.get(firstLayer.layerId) === null, "旧结果仍然不在");
  console.log("ok 回退");
}

async function spatialQueryAndSelf(root: string): Promise<void> {
  const stack = await openAt(root, "query");
  const areas = await stack.catalog.insert({
    layerName: "面",
    sourcePaths: ["memory"],
    collection: {
      type: "FeatureCollection",
      features: [square("甲", 0).features[0], square("乙", 0.2).features[0]].filter((feature) => feature !== undefined),
    },
    crsLabel: "EPSG:4326",
  });
  const mask = await stack.catalog.insert({
    layerName: "范围",
    sourcePaths: ["memory"],
    collection: square("范围", 0),
    crsLabel: "EPSG:4326",
  });
  const crossed = await stack.service.query(areas.layerId, mask.layerId, "相交", "name=甲", false);
  check(crossed.layer !== null, "相交查询应有结果");
  check(namesOf(stack.catalog.collection(crossed.layer.layerId), "name").join(",") === "甲", "相交查询必须套用同一套属性筛选");
  const points = await stack.catalog.insert({
    layerName: "点层",
    sourcePaths: ["memory"],
    collection: {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: { kind: "in" }, geometry: { type: "Point", coordinates: [0.5, 0.5] } },
        { type: "Feature", properties: { kind: "out" }, geometry: { type: "Point", coordinates: [0.2, 0.2] } },
        { type: "Feature", properties: { kind: "far" }, geometry: { type: "Point", coordinates: [5, 5] } },
      ],
    },
    crsLabel: "EPSG:4326",
  });
  const inside = await stack.service.query(points.layerId, mask.layerId, "点在面内", "kind=in", false);
  check(inside.layer !== null, "点在面内应有结果");
  check(namesOf(stack.catalog.collection(inside.layer.layerId), "kind").join(",") === "in", "点在面内必须套用属性筛选，不能把面内的 out 也留下");

  const mixed = await stack.catalog.insert({
    layerName: "自交",
    sourcePaths: ["memory"],
    collection: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { mark: "good" },
          geometry: { type: "Polygon", coordinates: [[[10, 10], [10, 11], [11, 11], [11, 10], [10, 10]]] },
        },
        {
          type: "Feature",
          properties: { mark: "bow" },
          geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 1], [0, 1], [1, 0], [0, 0]]] },
        },
      ],
    },
    crsLabel: "EPSG:4326",
  });
  const buffered = await stack.service.buffer(mixed.layerId, 10, "meters", false);
  check(buffered.layer !== null, "含自交要素的图层仍应分析其余要素");
  check(namesOf(stack.catalog.collection(buffered.layer.layerId), "mark").join(",") === "good", "自相交要素不能留在分析结果里");
  check(namesOf(stack.catalog.collection(mixed.layerId), "mark").join(",") === "good,bow", "跳过分析不能从源图层删掉要素");
  check(buffered.geometryIssues?.some((issue) => issue.message.includes("自相交") && issue.message.includes("跳过")) === true, "用户文案仍说明分析会跳过自相交");
  console.log("ok 空间查询与自相交");
}

async function statsAudit(root: string): Promise<void> {
  const blockedDir = join(root, "audit-block");
  const layerDirectory = join(blockedDir, "layers");
  const cacheDirectory = join(blockedDir, "cache");
  const auditDirectory = join(blockedDir, "audit");
  const stack = await openSpatialStack({
    layerDirectory,
    auditDirectory,
    cacheDirectory,
    modelName: () => "v077-check",
  });
  const layer = await stack.catalog.insert({
    layerName: "统计",
    sourcePaths: ["memory"],
    collection: square("统计", 0),
    crsLabel: "EPSG:4326",
  });
  await writeFile(auditDirectory, "blocked", { encoding: "utf8" });
  const stats = await stack.service.stats(layer.layerId, "name", false);
  const query = await stack.service.query(layer.layerId, null, "属性", "name=统计", false);
  check(stats.ok === true && query.ok === true, "审计写失败时统计和查询仍是运算成功");
  check(!("auditRecordId" in stats) && !("auditRecordId" in query), "审计没写成时，统计和查询都省略 auditRecordId");
  assertNoOperationId(stats, "统计失败审计");
  assertNoOperationId(query, "查询失败审计");
  console.log("ok 统计审计");
}

async function cacheWriteFailure(root: string): Promise<void> {
  const dir = join(root, "put-fail");
  const cacheDirectory = join(dir, "cache");
  const stack = await openSpatialStack({
    layerDirectory: join(dir, "layers"),
    auditDirectory: join(dir, "audit"),
    cacheDirectory,
    resultCache: new PutFails(cacheDirectory),
    modelName: () => "v077-check",
  });
  const source = await stack.catalog.insert({
    layerName: "源",
    sourcePaths: ["memory"],
    collection: square("源", 0),
    crsLabel: "EPSG:4326",
  });
  const message = await expectReject(
    () => stack.service.buffer(source.layerId, 10, "meters", false),
    ["结果缓存没有写入", "缓存目录写入失败", "已撤下刚写入的结果图层"],
  );
  check(!message.includes("几何无效"), "缓存失败不能伪装成几何无效");
  check(!message.includes("已完成"), "缓存失败不能报成功");
  check(stack.catalog.list().length === 1 && stack.catalog.list()[0]?.layerId === source.layerId, "缓存写失败后不能留下说不清的结果图层");

  const bothDir = join(root, "put-both");
  const bothCache = join(bothDir, "cache");
  const both = await openSpatialStack({
    layerDirectory: join(bothDir, "layers"),
    auditDirectory: join(bothDir, "audit"),
    cacheDirectory: bothCache,
    resultCache: new PutAndInvalidateFail(bothCache),
    modelName: () => "v077-check",
  });
  const bothSource = await both.catalog.insert({
    layerName: "源",
    sourcePaths: ["memory"],
    collection: square("源", 1),
    crsLabel: "EPSG:4326",
  });
  const bothMessage = await expectReject(
    () => both.service.buffer(bothSource.layerId, 10, "meters", false),
    ["结果缓存没有写入", "缓存目录写入失败", "撤下刚写入的结果图层也失败了", "缓存索引没有清掉"],
  );
  check(!bothMessage.includes("已完成"), "清理失败也不能报成功");
  console.log("ok 缓存写入失败");
}

async function sourceRefusal(root: string): Promise<void> {
  const stack = await openAt(root, "refuse");
  const layer = await stack.catalog.insert({
    layerName: "源文件",
    sourcePaths: ["memory"],
    collection: square("源", 0),
    crsLabel: "EPSG:4326",
  });
  const metaPath = join(stack.layerDirectory, `${layer.layerId}.meta.json`);
  const meta = JSON.parse(await readFile(metaPath, { encoding: "utf8" })) as { sourcePaths?: string[]; outputFilePath?: string };
  check(typeof meta.outputFilePath === "string", "元数据应有生成路径");
  meta.sourcePaths = [meta.outputFilePath];
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, { encoding: "utf8" });
  const reloaded = await openAt(root, "refuse");
  const message = await expectReject(() => reloaded.catalog.remove(layer.layerId), ["不会删除源数据文件"]);
  check(message.includes("不会删除源数据文件"), message);
  check(reloaded.catalog.get(layer.layerId) !== null, "拒绝删除时图层还在");
  check((await stat(layer.outputFilePath)).isFile(), "生成路径等于来源路径时不能删文件");
  console.log("ok 不删用户源");
}

async function invalidationFailure(root: string): Promise<void> {
  const stack = await openAt(root, "invalidate");
  const layer = await stack.catalog.insert({
    layerName: "要留",
    sourcePaths: ["memory"],
    collection: square("留", 0),
    crsLabel: "EPSG:4326",
  });
  const made = await stack.service.buffer(layer.layerId, 5, "meters", false);
  check(made.layer !== null, "先生成一条缓存");
  await rm(stack.cacheDirectory, { recursive: true, force: true });
  await writeFile(stack.cacheDirectory, "blocked", { encoding: "utf8" });
  const message = await expectReject(() => stack.catalog.remove(layer.layerId), ["缓存没有清掉"]);
  check(message.includes("缓存没有清掉"), message);
  check(stack.catalog.get(layer.layerId) !== null, "缓存清理失败时不能假装图层已经删除");
  console.log("ok 缓存清理失败可见");
}

async function main(root: string): Promise<void> {
  check(!resolve(root).toLowerCase().startsWith(REPO_ROOT.toLowerCase()), "临时目录不能在仓库内");
  attributeRules();
  await crsPolicy(root);
  await loadFileCrs(root);
  await cacheIdentity(root);
  await removalAndRename(root);
  await rollback(root);
  await spatialQueryAndSelf(root);
  await statsAudit(root);
  await cacheWriteFailure(root);
  await sourceRefusal(root);
  await invalidationFailure(root);
}

const root = await mkdtemp(join(tmpdir(), "igis-v077-"));
let failed: unknown = null;
try {
  await main(root);
  console.log("V077_CHECK_OK");
} catch (error) {
  failed = error;
  console.error(error instanceof Error ? error.stack ?? error.message : error);
} finally {
  check(root.includes("igis-v077-"), "拒绝删除意外路径");
  await rm(root, { recursive: true, force: true });
  console.log(`临时目录已删除 ${root}`);
}
if (failed) throw new Error("V077_CHECK_FAILED");
