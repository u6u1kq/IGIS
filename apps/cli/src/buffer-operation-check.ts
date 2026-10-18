// SPDX-License-Identifier: Apache-2.0

/**
 * 只检查缓冲的原始输入映射，以及从已解析身份组装请求。
 * 不执行缓冲，不写 var/。
 * 运行：npx tsx --tsconfig tsconfig.json apps/cli/src/buffer-operation-check.ts
 */

import {
  bufferRequestFromResolution,
  rawBufferInputFromChatLocal,
  rawBufferInputFromGdl,
  rawBufferInputFromMapHttp,
  rawBufferInputFromMcp,
  rawBufferInputFromToolArgs,
} from "../../../packages/spatial-ops/src/buffer-operation.js";
import type {
  BufferOperationRequest,
  LayerReference,
  RawBufferOperationInput,
} from "../../../packages/spatial-ops/src/buffer-operation.js";
import type { LayerResolutionIdentity, LayerResolutionResult } from "../../../packages/spatial-ops/src/layer-resolution.js";

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (!same(actual, expected)) {
    throw new Error(`${label}\n实际: ${JSON.stringify(actual)}\n期望: ${JSON.stringify(expected)}`);
  }
}

function same(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

type Extends<A, B> = [A] extends [B] ? true : false;

function assertTypeTrue<T extends true>(_value: T, label: string): void {
  assertEqual(_value, true, label);
}

function assertTypeFalse<T extends false>(_value: T, label: string): void {
  assertEqual(_value, false, label);
}

const forbiddenOnInput = [
  "createdLayers",
  "status",
  "startedAt",
  "finishedAt",
  "error",
  "rollback",
  "executionTime",
  "result",
  "geometry",
  "geojson",
  "GeoJSON",
  "operationId",
  "requestedBy",
  "steps",
  "writeKnowledge",
  "layerId",
  "layerName",
] as const;

const forbiddenOnRequest = [
  "createdLayers",
  "status",
  "startedAt",
  "finishedAt",
  "error",
  "rollback",
  "executionTime",
  "result",
  "geometry",
  "geojson",
  "GeoJSON",
  "operationId",
  "requestedBy",
  "steps",
  "writeKnowledge",
  "code",
  "candidates",
] as const;

const forbiddenOnPolicy = [
  "operation",
  "sourceLayer",
  "distance",
  "unit",
  "outputName",
  "createdLayers",
  "status",
  "startedAt",
  "finishedAt",
  "error",
  "rollback",
  "executionTime",
  "result",
  "geometry",
  "geojson",
  "GeoJSON",
  "operationId",
  "requestedBy",
  "steps",
] as const;

function assertInputShape(value: object): void {
  for (const key of forbiddenOnInput) {
    assertEqual(Object.hasOwn(value, key), false, key);
  }
  assertEqual(JSON.stringify(value).includes("coordinates"), false, "coordinates");
}

function assertRequestShape(value: BufferOperationRequest): void {
  for (const key of forbiddenOnRequest) {
    assertEqual(Object.hasOwn(value, key), false, key);
  }
  assertEqual(JSON.stringify(value).includes("coordinates"), false, "coordinates");
  assertEqual(Object.keys(value.sourceLayer).sort().join(","), "layerId,layerName", "sourceLayer keys");
  assertEqual(Object.hasOwn(value.sourceLayer, "ok"), false, "sourceLayer ok");
  assertEqual(Object.hasOwn(value.sourceLayer, "kind"), false, "sourceLayer kind");
}

function assertPolicyShape(value: object): void {
  for (const key of forbiddenOnPolicy) {
    assertEqual(Object.hasOwn(value, key), false, `policy ${key}`);
  }
  assertEqual(JSON.stringify(value).includes("coordinates"), false, "policy coordinates");
}

assertTypeFalse<Extends<RawBufferOperationInput, BufferOperationRequest>>(false, "raw input is not OperationRequest");
assertTypeFalse<Extends<LayerReference, BufferOperationRequest["sourceLayer"]>>(false, "raw reference is not sourceLayer");
assertTypeFalse<Extends<LayerResolutionResult, BufferOperationRequest["sourceLayer"]>>(false, "full resolution union is not sourceLayer");
assertTypeFalse<
  Extends<Extract<LayerResolutionResult, { readonly code: "NotFound" }>, BufferOperationRequest["sourceLayer"]>
>(false, "NotFound is not sourceLayer");
assertTypeFalse<
  Extends<Extract<LayerResolutionResult, { readonly code: "Ambiguous" }>, BufferOperationRequest["sourceLayer"]>
>(false, "Ambiguous is not sourceLayer");
assertTypeFalse<Extends<LayerReference, Parameters<typeof bufferRequestFromResolution>[0]>>(false, "builder rejects raw reference");
assertTypeTrue<Extends<LayerResolutionIdentity, BufferOperationRequest["sourceLayer"]>>(true, "identity is sourceLayer");

type Build = ReturnType<typeof bufferRequestFromResolution>;
type FailedBuild = Extract<Build, { readonly ok: false }>;
assertTypeFalse<Extends<FailedBuild, { readonly request: BufferOperationRequest }>>(false, "refusal has no request");

const chatRaw = rawBufferInputFromChatLocal({
  layerRef: "道路",
  distance: 300,
  unit: "meters",
  writeKnowledge: true,
});
assertEqual(chatRaw, {
  input: {
    operation: "buffer",
    sourceLayer: { kind: "name-or-id", text: "道路" },
    distance: 300,
    unit: "meters",
  },
  policy: { writeKnowledge: true },
}, "chat 300米");
assertEqual(Object.hasOwn(chatRaw.input, "outputName"), false, "chat outputName");
assertEqual(Object.hasOwn(chatRaw.input, "writeKnowledge"), false, "chat input writeKnowledge");
assertEqual("kind" in chatRaw.input.sourceLayer, true, "chat raw kind");
assertEqual("layerId" in chatRaw.input.sourceLayer, false, "chat raw layerId");

const chatCnMeters = rawBufferInputFromChatLocal({
  layerRef: "道路",
  distance: 300,
  unit: "meters",
  writeKnowledge: true,
});
assertEqual(chatCnMeters, chatRaw, "三百米与300米的已解析值");

const chatIdText = rawBufferInputFromChatLocal({
  layerRef: "lyr-1",
  distance: 300,
  unit: "meters",
  writeKnowledge: true,
});
assertEqual(chatIdText.input.sourceLayer, { kind: "name-or-id", text: "lyr-1" }, "chat id text");

const chatMissingDistanceAlreadyResolved = rawBufferInputFromChatLocal({
  layerRef: "道路",
  distance: 200,
  unit: "meters",
  writeKnowledge: true,
});
assertEqual(chatMissingDistanceAlreadyResolved.input.distance, 200, "chat 200");
assertEqual(chatMissingDistanceAlreadyResolved.input.unit, "meters", "chat 200 unit");
assertEqual(chatMissingDistanceAlreadyResolved.policy, { writeKnowledge: true }, "chat 200 policy");

const toolKilometers = rawBufferInputFromToolArgs({
  layerRef: "道路",
  distance: 300,
  unit: "kilometers",
});
assertEqual(toolKilometers, {
  input: {
    operation: "buffer",
    sourceLayer: { kind: "name-or-id", text: "道路" },
    distance: 300,
    unit: "kilometers",
  },
  policy: {},
}, "tool 300公里");
assertEqual(toolKilometers.input.distance, 300, "tool distance");
assertEqual(Object.hasOwn(toolKilometers.input, "outputName"), false, "tool outputName");
assertEqual(Object.hasOwn(toolKilometers.input, "writeKnowledge"), false, "tool input writeKnowledge");
assertEqual(Object.hasOwn(toolKilometers.policy, "writeKnowledge"), false, "tool policy writeKnowledge");

const toolWithOptionals = rawBufferInputFromToolArgs({
  layerRef: "道路",
  distance: 300,
  unit: "kilometers",
  outputName: "道路缓冲",
  writeKnowledge: true,
});
assertEqual(toolWithOptionals.input.outputName, "道路缓冲", "tool output");
assertEqual(toolWithOptionals.policy.writeKnowledge, true, "tool knowledge");
assertEqual(toolWithOptionals.input.distance, 300, "tool optional distance");
assertEqual(Object.hasOwn(toolWithOptionals.input, "writeKnowledge"), false, "tool optional input writeKnowledge");

const mcpKilometers = rawBufferInputFromMcp({
  layerRef: "道路",
  distance: 300,
  unit: "kilometers",
});
assertEqual(rawBufferInputFromMcp === rawBufferInputFromToolArgs, true, "mcp alias");
assertEqual(mcpKilometers, toolKilometers, "mcp shape");

const mapRaw = rawBufferInputFromMapHttp({
  layerId: "lyr-road",
  distance: 100,
  unit: "meters",
  writeKnowledge: false,
});
assertEqual(mapRaw, {
  input: {
    operation: "buffer",
    sourceLayer: { kind: "id", id: "lyr-road" },
    distance: 100,
    unit: "meters",
  },
  policy: { writeKnowledge: false },
}, "map");
assertEqual(Object.hasOwn(mapRaw.input, "outputName"), false, "map outputName");
assertEqual(Object.hasOwn(mapRaw.input, "writeKnowledge"), false, "map input writeKnowledge");

const gdlRaw = rawBufferInputFromGdl({
  layerName: "道路",
  distance: 300,
  unit: "kilometers",
  outputName: "道路_缓冲",
});
assertEqual(gdlRaw, {
  input: {
    operation: "buffer",
    sourceLayer: { kind: "name", name: "道路" },
    distance: 300,
    unit: "kilometers",
    outputName: "道路_缓冲",
  },
  policy: {},
}, "gdl");
assertEqual(gdlRaw.input.distance, 300, "gdl distance");
assertEqual(Object.hasOwn(gdlRaw.input, "writeKnowledge"), false, "gdl input writeKnowledge");
assertEqual(Object.hasOwn(gdlRaw.policy, "writeKnowledge"), false, "gdl policy writeKnowledge");

for (const mapped of [chatRaw, toolKilometers, mapRaw, gdlRaw, mcpKilometers, toolWithOptionals]) {
  assertInputShape(mapped.input);
  assertPolicyShape(mapped.policy);
  assertEqual(Object.hasOwn(mapped, "request"), false, "raw mapping has no request");
}

const resolvedIdentity = { layerId: "lyr-road", layerName: "道路" } as const satisfies LayerResolutionIdentity;
const fromIdentity = bufferRequestFromResolution(resolvedIdentity, 300, "meters", "道路缓冲");
const fromIdentityAgain = bufferRequestFromResolution(resolvedIdentity, 300, "meters", "道路缓冲");
assertEqual(fromIdentity, fromIdentityAgain, "identity stable");
assertEqual(fromIdentity, {
  ok: true,
  request: {
    operation: "buffer",
    sourceLayer: { layerId: "lyr-road", layerName: "道路" },
    distance: 300,
    unit: "meters",
    outputName: "道路缓冲",
  },
}, "identity builds request");
if (!fromIdentity.ok) throw new Error("identity should build");
assertRequestShape(fromIdentity.request);
assertEqual(Object.hasOwn(fromIdentity.request, "writeKnowledge"), false, "built request writeKnowledge");

const fromSuccess = bufferRequestFromResolution(
  { ok: true, layerId: "lyr-road", layerName: "道路" },
  300,
  "meters",
);
assertEqual(fromSuccess, {
  ok: true,
  request: {
    operation: "buffer",
    sourceLayer: { layerId: "lyr-road", layerName: "道路" },
    distance: 300,
    unit: "meters",
  },
}, "success result builds request");
if (!fromSuccess.ok) throw new Error("success result should build");
assertRequestShape(fromSuccess.request);
assertEqual(Object.hasOwn(fromSuccess.request, "outputName"), false, "success outputName omitted");
assertEqual(Object.hasOwn(fromSuccess.request.sourceLayer, "ok"), false, "success ok stripped");

const notFound = bufferRequestFromResolution({ ok: false, code: "NotFound" }, 300, "meters");
assertEqual(notFound, { ok: false, code: "NotFound" }, "NotFound");
assertEqual(Object.hasOwn(notFound, "request"), false, "NotFound has no request");

const ambiguous = bufferRequestFromResolution(
  {
    ok: false,
    code: "Ambiguous",
    candidates: [
      { layerId: "lyr-a", layerName: "道路" },
      { layerId: "lyr-b", layerName: "道路" },
    ],
  },
  300,
  "kilometers",
);
assertEqual(ambiguous, { ok: false, code: "Ambiguous" }, "Ambiguous");
assertEqual(Object.hasOwn(ambiguous, "request"), false, "Ambiguous has no request");
assertEqual(Object.hasOwn(ambiguous, "candidates"), false, "Ambiguous refusal drops candidates");

console.log(JSON.stringify({
  chatRaw,
  chatMissingDistanceAlreadyResolved,
  toolKilometers,
  mcpKilometers,
  mapRaw,
  gdlRaw,
  fromIdentity,
  fromSuccess,
  notFound,
  ambiguous,
}, null, 2));
console.log("buffer-operation-check: ok");
