import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { runtimeBoundaryTraceWitnesses } from "./formal/runtime-boundary-witnesses.js";

interface Fixture { states: Array<{ input: { name: string; choice: { "#bigint": string } }; s: { o: { calls: Array<{ "#bigint": string }>; loaders: { "#bigint": string } } } }> }
const fixtures = JSON.parse(readFileSync("test/fixtures/formal-runtime-boundary-witnesses.json", "utf8")) as Record<string, Fixture>;
const fixture = (name: string): Fixture => structuredClone(fixtures[name]!);
const positive: Array<[string, string]> = [
  ["runtimeTrueEnablesSharingOverFalseDefaultTest", "runtime-enables-sharing"],
  ["inheritedFalseKeepsIndependentMemoizingSourcesTest", "inherited-false-request-last-writer"],
  ...["request", "local", "remote"].flatMap(layer => [
    [`${layer}AbsenceAndLiteralTextStayDistinctTest`, `absent-distinct-from-text:${layer}`],
    [`${layer}FalsyValuesRemainDistinctAndReusableTest`, `falsy-values:${layer}`],
  ] as Array<[string, string]>),
  ["localCohortEqualityBypassesBeforeAboveSampleCachesTest", "exact-serving-cohort:local"],
  ["remoteCohortEqualityBypassesBeforeAboveSampleCachesTest", "exact-serving-cohort:remote"],
  ["nullProviderInheritsConfiguredServingAndDefaultSharingTest", "null-provider-inherits-serving-and-sharing"],
  ["omittedRampAndSharingUseLibraryDefaultsTest", "default-ramp-and-sharing"],
  ["reenablingSharingUsesTheOmittedTrueDefaultTest", "reenabled-default-sharing"],
  ["falseRequestLeafPreservesMemoForReenablementTest", "bypass-preserves-cache:false-request-leaf"],
  ["invalidCoalesceBypassesWithoutReplacingRemoteTest", "bypass-preserves-cache:invalid-coalesce"],
  ["invalidRequestLocalBypassesWithoutReplacingRemoteTest", "bypass-preserves-cache:invalid-request-local"],
  ["explicitNullCoalesceBypassesWithoutReplacingRemoteTest", "bypass-preserves-cache:null-coalesce"],
  ["explicitNullRequestLocalBypassesWithoutReplacingRemoteTest", "bypass-preserves-cache:null-request-local"],
  ["runtimeLocalTtlWithoutRampActivatesLayerTest", "runtime-ttl-implies-ramp:local"],
  ["runtimeRemoteTtlWithoutRampActivatesLayerTest", "runtime-ttl-implies-ramp:remote"],
  ["disabledBaselineRampedUpKeepsDefaultSharingTest", "disabled-baseline-default-sharing"],
  ["fullFeatureKillSwitchKeepsOmittedSharingAndRetainedMemoTest", "full-feature-kill-switch"],
];
it.each(positive)("attributes the public consequence of %s", (name, witness) => {
  expect(runtimeBoundaryTraceWitnesses(fixture(name)).has(witness)).toBe(true);
});
it.each(["local", "remote"])("%s equality needs a later above-boundary cache probe", layer => {
  const trace = fixture(`${layer}CohortEqualityBypassesBeforeAboveSampleCachesTest`);
  trace.states.pop();
  expect(runtimeBoundaryTraceWitnesses(trace).has(`exact-serving-cohort:${layer}`)).toBe(false);
});
it("a full-ramp overlay cannot masquerade as the adjacent cohort quantum", () => {
  const trace = fixture("remoteCohortEqualityBypassesBeforeAboveSampleCachesTest");
  trace.states.find(s => s.input.name === "policy" && s.input.choice["#bigint"] === "8")!.input.choice["#bigint"] = "11";
  expect(runtimeBoundaryTraceWitnesses(trace).has("exact-serving-cohort:remote")).toBe(false);
});
it("coalesced completion under an inherited false overlay cannot credit runtime enablement", () => {
  const trace = fixture("runtimeTrueEnablesSharingOverFalseDefaultTest");
  trace.states.find(s => s.input.name === "policy")!.input.choice["#bigint"] = "9";
  expect(runtimeBoundaryTraceWitnesses(trace).has("runtime-enables-sharing")).toBe(false);
});
it("numeric input cannot receive literal-string coverage from the expected result alone", () => {
  const trace = fixture("requestAbsenceAndLiteralTextStayDistinctTest");
  trace.states.find(s => s.input.name === "resolveLoader" && Number(s.input.choice["#bigint"]) % 8 === 3)!.input.choice["#bigint"] = "8";
  expect(runtimeBoundaryTraceWitnesses(trace).has("absent-distinct-from-text:request")).toBe(false);
});
it.each(["request", "local", "remote"])("%s falsy evidence requires the final retained empty-string probe", layer => {
  const trace = fixture(`${layer}FalsyValuesRemainDistinctAndReusableTest`);
  trace.states.pop();
  expect(runtimeBoundaryTraceWitnesses(trace).has(`falsy-values:${layer}`)).toBe(false);
});
it("an empty provider response cannot credit a null provider response", () => {
  const trace = fixture("nullProviderInheritsConfiguredServingAndDefaultSharingTest");
  trace.states.find(s => s.input.name === "policy")!.input.choice["#bigint"] = "9";
  expect(runtimeBoundaryTraceWitnesses(trace).has("null-provider-inherits-serving-and-sharing")).toBe(false);
});
it.each(["invalidCoalesce", "invalidRequestLocal", "explicitNullCoalesce", "explicitNullRequestLocal"])("%s needs a retained-cache probe after bypass", prefix => {
  const trace = fixture(`${prefix}BypassesWithoutReplacingRemoteTest`);
  trace.states.pop();
  expect([...runtimeBoundaryTraceWitnesses(trace)].some(w => w.startsWith("bypass-preserves-cache:"))).toBe(false);
});
it("a TTL overlay with an explicit ramp cannot credit omitted-ramp inheritance", () => {
  const trace = fixture("runtimeLocalTtlWithoutRampActivatesLayerTest");
  trace.states.find(s => s.input.name === "policy")!.input.choice["#bigint"] = "20";
  expect(runtimeBoundaryTraceWitnesses(trace).has("runtime-ttl-implies-ramp:local")).toBe(false);
});
it("a disabled baseline needs an observed joined completion before default-sharing credit", () => {
  const trace = fixture("disabledBaselineRampedUpKeepsDefaultSharingTest");
  const resolution = trace.states.find(s => s.input.name === "resolveLoader" && s.input.choice["#bigint"] === "9")!;
  resolution.s.o.calls[2] = { "#bigint": "0" };
  expect(runtimeBoundaryTraceWitnesses(trace).has("disabled-baseline-default-sharing")).toBe(false);
});
it("the full kill switch needs independent killed sources and later memo reuse", () => {
  const trace = fixture("fullFeatureKillSwitchKeepsOmittedSharingAndRetainedMemoTest");
  trace.states.pop();
  expect(runtimeBoundaryTraceWitnesses(trace).has("full-feature-kill-switch")).toBe(false);
});
