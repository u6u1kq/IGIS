// SPDX-License-Identifier: Apache-2.0

export interface PlannedGisCall {
  readonly name: string;
  readonly args: Readonly<Record<string, string | number | boolean>>;
}

export interface KnownMockLayer {
  readonly layerId: string;
  readonly layerName: string;
}

const COLOR_NAME: Readonly<Record<string, string>> = {
  红: "#c45c26",
  红色: "#c45c26",
  蓝: "#3d6f9a",
  蓝色: "#3d6f9a",
  绿: "#2f6f5e",
  绿色: "#2f6f5e",
};

export interface PlanGisOptions {
  readonly selectedLayer?: KnownMockLayer;
  readonly priorInstruction?: string;
}

const STOP = /^(的|地|得|和|与|再|后|然后|并|且|对|把|将|给|用|到|在|做|进行|一下|图层)$/;

const PLACEHOLDER_LAYER = /^(当前图层|另一图层|这个图层|该图层|其它图层|其他图层)$/;

const OP_WORDS = /缓冲|相交|求交|裁剪|分离|分析|删除|删掉|移除|点在面|统计|查询|样式|填充|隐藏|显示|置顶|缩放|导出|GDL|gdl|geojson/i;

/** 本轮只补了图层名，没有另说一种运算。 */
export function looksLikeLayerNameSupplement(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  if (OP_WORDS.test(trimmed)) return false;
  return /[A-Za-z0-9_\u4e00-\u9fff-]/.test(trimmed);
}

export function splitNamedLayers(text: string): string[] {
  return text
    .split(/[和与、,，]/)
    .map((part) => part.replace(/^图层\s*/, "").trim())
    .filter((name) => name !== "" && !STOP.test(name) && !PLACEHOLDER_LAYER.test(name) && name.length <= 40 && !OP_WORDS.test(name));
}

function bindSelectedNames(names: readonly string[], selected?: KnownMockLayer): string[] {
  const selectedName = selected && (selected.layerName.trim() !== "" ? selected.layerName : selected.layerId);
  const bound = names.map((name) => {
    if ((name === "当前图层" || name === "这个图层" || name === "该图层") && selectedName) return selectedName;
    return name;
  });
  return [...new Set(bound.filter((name) => !PLACEHOLDER_LAYER.test(name)))];
}

function quotedNames(text: string): string[] {
  const names: string[] = [];
  const pattern = /[「“"'《]([^」”"'》]{1,40})[」”"'》]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match[1]) names.push(match[1].trim());
  }
  return names;
}

function markedNames(text: string): string[] {
  const names: string[] = [];
  const pattern = /图层\s*[：:]?\s*([A-Za-z0-9_\u4e00-\u9fff-]{1,40})/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match[1] && !STOP.test(match[1]) && !OP_WORDS.test(match[1]) && !/^(做|进行)$/.test(match[1])) names.push(match[1]);
  }
  return names;
}

function knownHits(text: string, known: readonly KnownMockLayer[]): string[] {
  const ranked = [...known].sort((left, right) => right.layerName.length - left.layerName.length);
  const hits: string[] = [];
  for (const layer of ranked) {
    if (layer.layerName !== "" && text.includes(layer.layerName)) hits.push(layer.layerName);
    else if (layer.layerId !== "" && text.includes(layer.layerId)) hits.push(layer.layerId);
  }
  return [...new Set(hits)];
}

function prepositionNames(text: string): string[] {
  const names: string[] = [];
  const pattern = /(?:对|给|把|将|用|与|和|裁剪)\s*([A-Za-z0-9_\u4e00-\u9fff-]{1,40}?)(?:做|进行|缓冲|相交|裁剪|隐藏|显示|缩放|导出|放到|改|和|与|再|后|，|。|,|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const name = (match[1] ?? "").replace(/(?:做|进行)$/, "");
    if (name !== "" && !STOP.test(name) && !/^(缓冲|相交|裁剪|查询|统计|导出|隐藏|显示)/.test(name)) names.push(name);
  }
  return names;
}

export function extractInstructionLayers(text: string, known: readonly KnownMockLayer[]): string[] {
  const ordered = [...quotedNames(text), ...markedNames(text), ...knownHits(text, known), ...prepositionNames(text)];
  return [...new Set(ordered.filter((name) => name.trim() !== ""))];
}

export function distanceOf(text: string): { readonly distance: number; readonly unit: string } | null {
  const matched = /(\d+(?:\.\d+)?)\s*(米|千米|公里|英里|英尺|度|m|km|meters?|kilometers?|miles?|feet|foot|degrees?)/i.exec(text);
  if (!matched?.[1] || !matched[2]) return null;
  const unitText = matched[2].toLowerCase();
  const unit = unitText === "千米" || unitText === "公里" || unitText === "km" || unitText.startsWith("kilometer")
    ? "kilometers"
    : unitText === "英里" || unitText.startsWith("mile")
      ? "miles"
      : unitText === "英尺" || unitText === "feet" || unitText === "foot"
        ? "feet"
        : unitText === "度" || unitText.startsWith("degree")
          ? "degrees"
          : "meters";
  return { distance: Number(matched[1]), unit };
}

function hexColor(text: string): string | null {
  const hex = /#([0-9a-fA-F]{6})/.exec(text);
  if (hex?.[1]) return `#${hex[1].toLowerCase()}`;
  for (const [name, value] of Object.entries(COLOR_NAME)) {
    if (text.includes(name)) return value;
  }
  return null;
}

function writeFlag(_text: string, args: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
  return args;
}

function resultName(text: string): string | undefined {
  const matched = /(?:结果(?:叫|名为?)|命名为|AS)\s*[「“"]?([A-Za-z0-9_\u4e00-\u9fff-]{1,40})/i.exec(text);
  return matched?.[1];
}

/**
 * 把一句中文 GIS 指令拆成按顺序的工具调用。图层名可以是中文。
 * 多步时后续步骤的图层用 "__prev__" 占位，由调用方替换成上一步结果。
 * 若上一轮在澄清、本轮只补图层名，用 priorInstruction 决定运算，用本轮名字填图层。
 */
export function planGisInstruction(
  text: string,
  known: readonly KnownMockLayer[] = [],
  options: PlanGisOptions = {},
): readonly PlannedGisCall[] {
  const prior = typeof options.priorInstruction === "string" ? options.priorInstruction.trim() : "";
  const supplement = prior !== "" && looksLikeLayerNameSupplement(text);
  const opText = supplement ? `${prior}\n${text}` : text;
  const nameText = supplement ? text : opText;
  const splitNames = supplement ? splitNamedLayers(nameText) : [];
  const layers = bindSelectedNames(
    [...splitNames, ...extractInstructionLayers(nameText, known), ...(!supplement ? extractInstructionLayers(opText, known) : [])],
    options.selectedLayer,
  );
  const first = layers[0];
  const second = layers[1];
  const named = resultName(opText);
  const steps: PlannedGisCall[] = [];
  const wantsBuffer = /缓冲/.test(opText);
  const wantsIntersect = /相交|求交/.test(opText) && !/查询/.test(opText);
  const wantsClip = /裁剪/.test(opText);
  const wantsQuery = /查询/.test(opText);
  const wantsStats = /统计/.test(opText);
  const wantsStyle = /样式|填充|轮廓|透明|颜色/.test(opText);
  const wantsHide = /隐藏/.test(opText);
  const wantsShow = /显示/.test(opText) && !/显示或隐藏/.test(opText);
  const wantsOrder = /置顶|最上层|最上|最下|底层|顺序/.test(opText);
  const wantsZoom = /缩放|定位到|转到图层|看这个图层/.test(opText);
  const wantsExport = /导出/.test(opText) && /geojson|GeoJSON|json/i.test(opText);
  const wantsList = /有哪些图层|列出.*图层/.test(opText) && !wantsBuffer && !wantsIntersect && !wantsClip;
  const dist = distanceOf(opText);
  const incompleteCombo = (wantsBuffer && wantsIntersect && !(first && second)) || (wantsBuffer && wantsClip && !(first && second));

  if (wantsList) steps.push({ name: "map.list", args: {} });
  if (!incompleteCombo) {
    if (wantsBuffer && first && dist) {
      const args: Record<string, string | number | boolean> = { layerId: first, distance: dist.distance, unit: dist.unit };
      if (named) args.outputName = named;
      steps.push({ name: "map.buffer", args: writeFlag(opText, args) });
    }
    if (wantsClip && first && second) {
      const usedAsMask = /用/.test(opText);
      steps.push({
        name: "map.clip",
        args: writeFlag(opText, {
          layerId: wantsBuffer ? "__prev__" : usedAsMask ? second : first,
          otherLayerId: wantsBuffer ? second : usedAsMask ? first : second,
        }),
      });
    } else if (wantsIntersect && first && second) {
      steps.push({
        name: "map.intersect",
        args: writeFlag(opText, {
          layerId: wantsBuffer ? "__prev__" : first,
          otherLayerId: second,
        }),
      });
    }
  }
  if (wantsQuery && first) {
    if (/点在面/.test(opText) && second) {
      steps.push({ name: "map.query", args: writeFlag(opText, { layerId: first, otherLayerId: second, queryKind: "point-in-polygon" }) });
    } else if (/相交/.test(opText) && second) {
      steps.push({ name: "map.query", args: writeFlag(opText, { layerId: first, otherLayerId: second, queryKind: "intersects" }) });
    } else if (/属性/.test(opText)) {
      const filter = /属性\s*(\S+)/.exec(opText);
      if (filter?.[1]) steps.push({ name: "map.query", args: writeFlag(opText, { layerId: first, queryKind: "attribute", attributeFilter: filter[1] }) });
    }
  }
  if (wantsStats && first) {
    const field = /字段\s*([A-Za-z0-9_\u4e00-\u9fff]+)/.exec(opText);
    const args: Record<string, string | number | boolean> = { layerId: first };
    if (field?.[1]) args.fieldName = field[1];
    steps.push({ name: "map.stats", args: writeFlag(opText, args) });
  }
  if (wantsStyle && first) {
    const args: Record<string, string | number | boolean> = { layerId: first };
    const fill = hexColor(opText);
    if (fill && /填充|颜色|样式/.test(opText)) args.fill = fill;
    const width = /宽度\s*(?:改成|设为|为)?\s*(\d+(?:\.\d+)?)/.exec(opText);
    if (width?.[1]) args.width = Number(width[1]);
    const opacity = /透明(?:度)?\s*(?:设为|为|到)?\s*(\d+(?:\.\d+)?)/.exec(opText);
    if (opacity?.[1]) {
      const value = Number(opacity[1]);
      args.opacity = value > 1 ? value / 100 : value;
    }
    if (Object.keys(args).length > 1) steps.push({ name: "map.style", args });
  }
  if (wantsHide && first) steps.push({ name: "map.setVisibility", args: { layerId: first, visible: false } });
  else if (wantsShow && first && /显示/.test(opText)) steps.push({ name: "map.setVisibility", args: { layerId: first, visible: true } });
  if (wantsOrder && first) {
    const place = /最下|底层/.test(opText) ? "bottom" : "top";
    steps.push({ name: "map.setOrder", args: { layerId: first, place } });
  }
  if (wantsZoom && first) steps.push({ name: "map.zoomToLayer", args: { layerId: first } });
  if (wantsExport && first) {
    const args: Record<string, string | number | boolean> = { layerId: first };
    const path = /(?:路径|保存到|导出到)\s*(\S+)/.exec(opText);
    if (path?.[1]) args.destinationPath = path[1];
    steps.push({ name: "map.exportGeoJson", args });
  }
  return steps;
}

export function looksLikeGisInstruction(text: string): boolean {
  return /缓冲|相交|求交|裁剪|分离|分析|删除|删掉|移除|点在面|统计|查询|样式|填充|隐藏|显示|置顶|缩放|导出|图层|geojson|GDL|gdl/i.test(text);
}
