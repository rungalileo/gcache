import { AssertionError } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { bindTrace, profileActions } from "../formal/replay/bindings.mjs";
import { ReplayCoordinator, settlement } from "../formal/replay/coordinator.mjs";
import { expectedCoreObservation, parseItfTrace } from "../formal/replay/core.mjs";
import { featureInput, profiles } from "../formal/replay/features.mjs";
import { inputsFor } from "../formal/replay/effects.mjs";
import { emptyObservation } from "../formal/replay/observation.mjs";
import { assertSchema, schema, schemaViolation } from "../formal/replay/schema.mjs";
import { parseJSON, replayLines } from "../formal/replay/validation.mjs";
import { replaySources } from "../formal/replay/sources.mjs";
import type { Fixture } from "./formal/behavior-driver.js";
import { replayThroughCoordinator, smokeTracePath } from "./formal/coordinated-replay.js";

type Raw = { states: Array<Record<string, unknown> & { s: Record<string, unknown> }> };
function smoke(profile: string): Raw {
  const name = profile === "core" ? "conformance" : profile;
  return JSON.parse(readFileSync(resolve(`formal/${name}-smoke.itf.json`), "utf8")) as Raw;
}
const environment = { wallMs: 1_725_000_000_123 };
const roundtrip = (value: unknown) => parseJSON(JSON.stringify(value));

function replaySession(raw: Raw, profile = "core") {
  const coordinator = new ReplayCoordinator();
  let id = 0;
  const request = (fields: Record<string, unknown>) => coordinator.dispatch(roundtrip({ version: 1, id: ++id, ...fields }));
  const prepared = request({ op: "prepare", profile, path: "control.itf.json", raw: JSON.stringify(raw) });
  const observe = (index: number, observed: unknown) => request({
    op: "observe", session: prepared.session, index, settlement, observed, environment,
  });
  return { coordinator, prepared, request, observe };
}

describe("shared replay input and expectation boundary", () => {
  it.each(Object.keys(profileActions()))("keeps %s predictions out of fixture and action mappings", profile => {
    const original = smoke(profile);
    const changed = structuredClone(original);
    for (const state of changed.states) {
      const observation = profile === "core" || profile === "effects" ? state.s : state.s.o as Record<string, unknown>;
      observation[profile === "core" ? "redisReads" : "reads"] = { "#bigint": "123456" };
    }
    const baseline = bindTrace(profile, original, "original");
    const corrupted = bindTrace(profile, changed, "changed");
    expect(corrupted.fixture).toEqual(baseline.fixture);
    expect(corrupted.setup).toEqual(baseline.setup);

    const actual = profile === "core"
      ? expectedCoreObservation(parseItfTrace(original, "original").states[0]!.state)
      : emptyObservation(baseline.fixture as unknown as Fixture);
    expect(() => baseline.assert(0, actual)).not.toThrow();
    expect(() => corrupted.assert(0, actual)).toThrow(AssertionError);
    const session = replaySession(changed, profile);
    expect(() => session.observe(0, actual)).toThrow(/Observation mismatch\nexpected: [^\n]+\nactual: [^\n]+/);
    // Deliberately supply independently selected actual counters. Both bindings
    // must issue identical commands even when every prediction has changed.
    const observed = { ...actual, loaders: 16, reads: 16, writes: 16, loads: 16, dumps: 16, policyCalls: 16 };
    for (let index = 1; index < baseline.trace.steps.length; index++) {
      expect(corrupted.commands(index, observed, environment)).toEqual(baseline.commands(index, observed, environment));
    }
  });

  it("issues the same core command before rejecting a tampered later prediction", () => {
    const original = smoke("core");
    original.states = original.states.slice(0, 2);
    const changed = structuredClone(original);
    changed.states[1]!.s.redisReads = { "#bigint": "999" };
    const expected = parseItfTrace(original, "original").states.map(step => expectedCoreObservation(step.state));
    const first = replaySession(original);
    const second = replaySession(changed);
    const next = first.observe(0, expected[0]);
    expect(second.observe(0, expected[0])).toEqual(next);
    expect(JSON.stringify(next)).not.toMatch(/expected|prediction|localCached|redisReads/);
    expect(first.observe(1, expected[1])).toEqual({ complete: true, steps: 2 });
    expect(() => second.observe(1, expected[1])).toThrow(/step 1 action outsideCall: Observation mismatch\nexpected: .*"redisReads":999.*\nactual: .*"redisReads":0/);
    expect(() => second.observe(1, expected[1])).toThrow(/Unknown replay session/);
  });

  it("resolves dynamic effect IDs and frame timestamps from actual observations and clocks", () => {
    const profile = profiles["recovery-read"]!;
    const observed = { ...emptyObservation(), reads: 7, loads: 4, loaders: 3 };
    expect(featureInput(profile, "releaseRead", -1, observed, environment)).toEqual({ op: "release", effect: "read", index: 6 });
    expect(featureInput(profile, "rejectLoader", -1, observed, environment)).toEqual({ op: "reject", loader: 2 });
    expect(inputsFor({ action: "releaseLoad" }, observed, environment)[1]).toEqual({ op: "release", effect: "load", index: 3 });
    const seed = featureInput(profile, "seed", 17, observed, environment);
    if (seed.op !== "seed" || seed.frameHex === undefined) throw new Error("Missing malformed-frame fixture");
    const frame = Buffer.from(seed.frameHex, "hex");
    expect(frame[0]).toBe(2);
    expect(frame.readBigUInt64BE(1)).toBe(BigInt(environment.wallMs));
  });

  it.each(Object.keys(profileActions()))("requires explicit %s inputs and coherent optional MBT metadata", profile => {
    const raw = smoke(profile);
    const withoutMetadata = structuredClone(raw);
    for (const state of withoutMetadata.states) {
      delete state["mbt::actionTaken"];
      delete state["mbt::nondetPicks"];
    }
    expect(() => bindTrace(profile, withoutMetadata, "explicit")).not.toThrow();
    const missing = structuredClone(raw);
    delete missing.states[1]!.input;
    expect(() => bindTrace(profile, missing, "missing")).toThrow();
    raw.states[1]!["mbt::actionTaken"] = "wrongAction";
    expect(() => bindTrace(profile, raw, "conflicting")).toThrow(/conflicting action metadata/);
  });
});

describe("shared observation assertion attribution", () => {
  const labels = { cacheNamespace: "urn", useCase: "Behavior", keyType: "id" };
  const cases = [
    { name: "compression outcome", profile: "recovery-read", field: "outcome",
      event: { event: "compression", layer: "remote", outcome: "compressed" } },
    { name: "read event kind", profile: "independent", field: "event",
      event: { event: "marker", cutoffMs: -1, ttlMs: -2 } },
    { name: "future offset layer", profile: "shadow", field: "layer",
      event: { event: "futureOffset", layer: "remote", seconds: 1 } },
    { name: "nonpositive future offset", profile: "shadow", field: "seconds",
      event: { event: "futureOffset", layer: "remote_shadow", seconds: 0 } },
    { name: "fractional millisecond future offset", profile: "shadow", field: "seconds",
      event: { event: "futureOffset", layer: "remote_shadow", seconds: 0.0005 } },
  ];
  const failureOf = (action: () => unknown) => {
    try { action(); }
    catch (error) { return error; }
    throw new Error("Expected observation validation to fail");
  };

  it.each(cases)("attributes a well-shaped invalid $name to the observation", ({ profile, field, event }) => {
    const raw = smoke(profile);
    const binding = bindTrace(profile, raw, "domain-control");
    const observed = { ...emptyObservation(binding.fixture as unknown as Fixture), events: [{ ...labels, ...event }] };
    const error = failureOf(() => binding.assert(0, observed));
    expect(error).toBeInstanceOf(AssertionError);
    expect(error).toMatchObject({ actual: expect.objectContaining({ [field]: event[field as keyof typeof event] }) });
    const session = replaySession(raw, profile);
    const rendered = String(failureOf(() => session.observe(0, observed)));
    expect(rendered).toMatch(/Observation mismatch\nexpected: [^\n]+\nactual: [^\n]+/);
    expect(rendered).toContain(`"${field}"`);
  });

  it.each(cases)("keeps a malformed $name record as infrastructure failure", ({ profile, field, event }) => {
    const raw = smoke(profile);
    const binding = bindTrace(profile, raw, "shape-control");
    const malformed: Record<string, unknown> = { ...labels, ...event, [field]: null };
    const observed = { ...emptyObservation(binding.fixture as unknown as Fixture), events: [malformed] };
    const error = failureOf(() => binding.assert(0, observed));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AssertionError);
    const session = replaySession(raw, profile);
    expect(String(failureOf(() => session.observe(0, observed)))).not.toMatch(/expected:[\s\S]*actual:/);
  });
});

describe("observation encoding contract", () => {
  const failureOf = (action: () => unknown) => {
    try { action(); }
    catch (error) { return String(error); }
    throw new Error("Expected the coordinator to reject the observation");
  };
  const coreObservation = () => expectedCoreObservation(parseItfTrace(smoke("core"), "core").states[0]!.state);
  const behaviorObservation = (profile: string) => emptyObservation(bindTrace(profile, smoke(profile), profile).fixture as unknown as Fixture);

  it.each([
    { profile: "independent", definition: "behaviorObservation", path: "observed.calls", observed: () => ({ ...behaviorObservation("independent"), calls: "none" }) },
    { profile: "independent", definition: "behaviorObservation", path: "observed.calls[0].value", observed: () => ({ ...behaviorObservation("independent"), calls: [{ status: "value" }] }) },
    { profile: "independent", definition: "behaviorObservation", path: "observed.calls[0].error", observed: () => ({ ...behaviorObservation("independent"), calls: [{ status: "error", error: "boom" }] }) },
    { profile: "independent", definition: "behaviorObservation", path: "observed.events[0]", observed: () => ({ ...behaviorObservation("independent"), events: [{ event: "invented" }] }) },
    { profile: "independent", definition: "behaviorObservation", path: "observed.events[0].timeoutMs", observed: () => ({ ...behaviorObservation("independent"), events: [{ event: "readContext", index: 0, aborted: false }] }) },
    { profile: "independent", definition: "behaviorObservation", path: "observed.maintenance[0]", observed: () => ({ ...behaviorObservation("independent"), maintenance: ["exploded"] }) },
    { profile: "independent", definition: "behaviorObservation", path: "observed.events", observed: () => ({ ...behaviorObservation("independent"), events: 5 }) },
    { profile: "independent", definition: "behaviorObservation", path: "observed.extra", observed: () => ({ ...behaviorObservation("independent"), extra: 1 }) },
    { profile: "shadow", definition: "behaviorObservation", path: "observed.events[0].seconds", observed: () => ({ ...behaviorObservation("shadow"), events: [{ event: "shadowAge", cacheNamespace: "urn", useCase: "Behavior", keyType: "id", outcome: "match", seconds: "1" }] }) },
    { profile: "effects", definition: "behaviorObservation", path: "observed.writeTtls[0]", observed: () => ({ ...behaviorObservation("effects"), writeTtls: [60000.5] }) },
    { profile: "core", definition: "coreObservation", path: "observed.redisReads", observed: () => ({ ...coreObservation(), redisReads: -1 }) },
    { profile: "core", definition: "coreObservation", path: "observed.redisWrites", observed: () => { const { redisWrites: _writes, ...rest } = coreObservation(); return rest; } },
    { profile: "local-clock", definition: "localClockObservation", path: "observed.calls[0]", observed: () => ({ ...emptyObservation(), calls: [{ status: "pending" }] }) },
    { profile: "local-clock", definition: "localClockObservation", path: "observed.events", observed: () => ({ ...emptyObservation(), calls: [], events: [] }) },
  ])("rejects a malformed $profile observation at $path as infrastructure failure", ({ profile, definition, path, observed }) => {
    const raw = smoke(profile);
    expect(schemaViolation(observed(), definition, "observed")).toBe(path);
    const session = replaySession(raw, profile);
    const rendered = failureOf(() => session.observe(0, observed()));
    expect(rendered).toContain(`Malformed replay observation: ${definition} at ${path}`);
    expect(rendered).not.toMatch(/expected:[\s\S]*actual:/);
    expect(rendered).not.toMatch(/Observation mismatch/);
    // The session is released like any other failed step; no partial credit.
    expect(failureOf(() => session.observe(0, observed()))).toMatch(/Unknown replay session/);
  });

  it("names each session's observation definition in the prepare result so ports can validate locally", () => {
    const definitions: Record<string, string> = { core: "coreObservation", "local-clock": "localClockObservation" };
    let prepared: Record<string, unknown> = {};
    for (const profile of Object.keys(profileActions())) {
      const binding = bindTrace(profile, smoke(profile), profile);
      prepared = new ReplayCoordinator().dispatch({ version: 1, id: 1, op: "prepare", profile, path: smokeTracePath(profile) });
      expect(prepared.observation).toBe(definitions[profile] ?? "behaviorObservation");
      expect(prepared.observation).toBe(binding.observation);
      expect(Object.hasOwn(schema.$defs as object, prepared.observation as string)).toBe(true);
    }
    const response = (result: unknown) => ({ version: 1, id: 1, ok: true, result });
    expect(() => assertSchema(response(prepared), "response")).not.toThrow();
    const { observation: _named, ...unnamed } = prepared;
    expect(() => assertSchema(response(unnamed), "response")).toThrow(/^Malformed replay response/);
    expect(() => assertSchema(response({ ...prepared, observation: "invented" }), "response")).toThrow(/^Malformed replay response/);
    expect(() => assertSchema(response({ ...prepared, observation: "observedEvent" }), "response")).toThrow(/^Malformed replay response/);
  });

  it("accepts every declared empty observation and names the definition in schema failures", () => {
    for (const profile of Object.keys(profileActions())) {
      const binding = bindTrace(profile, smoke(profile), profile);
      const observed = profile === "core" ? coreObservation() : emptyObservation(binding.fixture as unknown as Fixture);
      expect(schemaViolation(observed, binding.observation)).toBeUndefined();
    }
    expect(() => assertSchema({ status: "value" }, "callResult")).toThrow(/^Malformed replay callResult at callResult\.value$/);
    expect(() => assertSchema({ version: 1, id: 1, op: "observe", session: "1", index: 0, settlement, observed: {}, environment: { wallMs: 0.5 } }, "request"))
      .toThrow(/^Malformed replay request at request\.environment\.wallMs$/);
    expect(() => assertSchema({ op: "seed", ageMs: 1.5 }, "command")).toThrow(/^Malformed replay command at command\.ageMs$/);
    expect(() => assertSchema({ op: "invalidate", futureBufferMs: -1 }, "behaviorCommand")).toThrow(/^Malformed replay behaviorCommand at behaviorCommand\.futureBufferMs$/);
    // Two command families share the invalidate discriminator, so the union reports only itself.
    expect(() => assertSchema({ op: "invalidate", futureBufferMs: -1 }, "command")).toThrow(/^Malformed replay command$/);
    expect(() => assertSchema({ op: "seed", ageMs: -1, ttlMs: 1000 }, "command")).not.toThrow();
  });

  it("rejects fixtures outside the declared sentinel domains, including through the prepare response", () => {
    const fixture = bindTrace("independent", smoke("independent"), "fixture").fixture;
    expect(() => assertSchema(fixture, "fixture")).not.toThrow();
    expect(() => assertSchema({}, "fixture")).not.toThrow();
    const malformed: Array<[Record<string, unknown>, string]> = [
      [{ ...fixture, recovery: "maybe" }, "recovery"],
      [{ ...fixture, fallbackTimeoutMs: "none" }, "fallbackTimeoutMs"],
      [{ ...fixture, readTimeoutMs: null }, "readTimeoutMs"],
      [{ ...fixture, comparator: "same" }, "comparator"],
      [{ ...fixture, observe: ["invented"] }, "observe[0]"],
      [{ ...fixture, localMaxSize: -1 }, "localMaxSize"],
      [{ ...fixture, remote: "yes" }, "remote"],
      [{ ...fixture, invented: true }, "invented"],
    ];
    for (const [candidate, path] of malformed) {
      expect(schemaViolation(candidate, "behaviorFixture")).toBe(`behaviorFixture.${path}`);
      expect(() => assertSchema(candidate, "fixture")).toThrow(/^Malformed replay fixture$/);
    }
    // A fixture without a policy is neither the empty core fixture nor a behavior fixture.
    expect(() => assertSchema({ tracked: true }, "fixture")).toThrow(/Malformed replay fixture/);
    const response = (candidate: unknown) => ({ version: 1, id: 1, ok: true, result: {
      session: "1", settlement, observation: "behaviorObservation", fixture: candidate, setup: [], actions: ["beginCall"], steps: 2 } });
    expect(() => assertSchema(response(fixture), "response")).not.toThrow();
    expect(() => assertSchema(response({ ...fixture, recovery: "maybe" }), "response")).toThrow(/^Malformed replay response/);
    // Every profile's prepared fixture crosses the response schema.
    for (const profile of Object.keys(profileActions())) {
      const prepared = new ReplayCoordinator().dispatch({ version: 1, id: 1, op: "prepare", profile, path: smokeTracePath(profile) });
      expect(() => assertSchema(prepared.fixture, "fixture")).not.toThrow();
    }
  });
});

describe("coordinated end-to-end replay with the real drivers", () => {
  it.each(Object.keys(profileActions()))("replays the committed %s smoke trace through the coordinator", async profile => {
    const result = await replayThroughCoordinator(profile, smokeTracePath(profile));
    expect(result.steps).toBe(smoke(profile).states.length);
  });

  it("reports a driver observation the model did not predict as a mismatch, not a shape error", async () => {
    const raw = smoke("core");
    raw.states[1]!.s.redisReads = { "#bigint": "999" };
    const directory = mkdtempSync(resolve(tmpdir(), "dialcache-coordinated-replay-"));
    try {
      const path = resolve(directory, "tampered.itf.json");
      writeFileSync(path, JSON.stringify(raw));
      await expect(replayThroughCoordinator("core", path)).rejects.toThrow(/step 1 action outsideCall: Observation mismatch\nexpected: .*"redisReads":999/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe("versioned replay protocol", () => {
  it("preserves absence, strings, null, false, zero and empty strings across JSON", () => {
    const values = [undefined, "undefined", null, false, 0, ""];
    for (const [index, value] of values.entries()) {
      const command = featureInput(profiles["runtime-boundaries"]!, "resolveLoader", index + 2, emptyObservation(), environment);
      const decoded = roundtrip(command) as Record<string, unknown>;
      assertSchema(decoded, "command");
      expect(Object.hasOwn(decoded, "value")).toBe(value !== undefined);
      expect(decoded.value).toBe(value);
    }
  });

  it("roundtrips request/reply schemas and keeps the declared profile list complete", () => {
    const coordinator = new ReplayCoordinator();
    const request = { version: 1, id: 1, op: "profiles" };
    assertSchema(roundtrip(request), "request");
    const result = coordinator.dispatch(roundtrip(request));
    const response = roundtrip({ version: 1, id: 1, ok: true, result });
    assertSchema(response, "response");
    const definitions = schema.$defs as { request: { oneOf: Array<{ properties: { profile?: { enum: string[] } } }> } };
    const declared = definitions.request.oneOf.find(option => option.properties.profile)?.properties.profile!.enum;
    expect(declared === undefined ? undefined : [...declared].sort()).toEqual(Object.keys(profileActions()).sort());
  });

  it.each([
    { version: 2, id: 1, op: "profiles" },
    { version: 1, id: 1, op: "unknown" },
    { version: 1, id: 1.5, op: "profiles" },
    { version: 1, id: 1, op: "profiles", expected: {} },
  ])("rejects malformed or unsupported requests: %j", request => {
    expect(() => new ReplayCoordinator().dispatch(request)).toThrow(/Malformed replay request/);
  });

  it.each([-1, 0.5, 1, 99])("rejects invalid/skipped initial observation index %s", index => {
    const session = replaySession(smoke("core"));
    expect(() => session.observe(index, {})).toThrow(/Malformed replay request|skipped replay observation/);
  });

  it("rejects duplicate request and observation indices and prevents reuse after completion", () => {
    const raw = smoke("core");
    raw.states = raw.states.slice(0, 2);
    const states = parseItfTrace(raw, "core").states;
    const session = replaySession(raw);
    session.observe(0, expectedCoreObservation(states[0]!.state));
    expect(() => session.observe(0, {})).toThrow(/Duplicate or skipped/);
    expect(() => session.observe(1, {})).toThrow(/Unknown replay session/);
    expect(() => session.coordinator.dispatch({ version: 1, id: 1, op: "profiles" })).toThrow(/out-of-order/);
    const completed = replaySession(raw);
    completed.observe(0, expectedCoreObservation(states[0]!.state));
    completed.observe(1, expectedCoreObservation(states[1]!.state));
    expect(() => completed.observe(1, {})).toThrow(/Unknown replay session/);
  });

  it("rejects a different settlement rule, unsafe clock, and expectation fields on commands", () => {
    const session = replaySession(smoke("core"));
    const base = { op: "observe", session: session.prepared.session, index: 0, settlement, observed: {}, environment };
    expect(() => session.request({ ...base, settlement: "advance-until-equal" })).toThrow(/Malformed replay request/);
    try {
      session.request({ ...base, settlement: "advance-until-equal" });
    } catch (cause) {
      expect(String(cause)).not.toMatch(/expected:[\s\S]*actual:/);
    }
    expect(() => session.request({ ...base, environment: { wallMs: Number.MAX_SAFE_INTEGER + 1 } })).toThrow(/Malformed replay request/);
    expect(() => assertSchema({ op: "release", effect: "read", index: -1 }, "command")).toThrow();
    expect(() => assertSchema({ op: "begin", expected: { calls: [] } }, "command")).toThrow();
    expect(() => assertSchema({ op: "invented" }, "command")).toThrow();
  });

  it.each(['{"a":1,"a":2}', String.raw`{"a":1,"\u0061":2}`, '{"nested":[{"x":0,"x":1}]}'])
    ("rejects duplicate JSON members: %s", text => {
      expect(() => parseJSON(text)).toThrow(/Duplicate JSON member/);
    });
});


describe("shared replay transport and source closure", () => {
  it("handles split UTF-8 and multiple frames without accepting oversized or unterminated input", async () => {
    const bytes = Buffer.from('{"value":"café"}\n{"value":0}\n');
    const frames = [];
    for await (const line of replayLines(Readable.from([...bytes].map(byte => Buffer.from([byte]))), 32)) {
      frames.push(parseJSON(line));
    }
    expect(frames).toEqual([{ value: "café" }, { value: 0 }]);
    const consume = async (chunks: string[], limit: number) => {
      for await (const _line of replayLines(Readable.from(chunks), limit)) { /* Consume framing only. */ }
    };
    await expect(consume(["1234", "5678", "9\n"], 8)).rejects.toThrow(/Oversized/);
    await expect(consume(['{"value":1}'], 32)).rejects.toThrow(/Unterminated/);
  });

  it("requires the exact shared source inventory before recording witness evidence", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "dialcache-replay-sources-"));
    try {
      mkdirSync(resolve(directory, "formal/replay"), { recursive: true });
      const source = "formal/replay/mapping.mjs";
      writeFileSync(resolve(directory, source), "export const mapping = 1;\n");
      writeFileSync(resolve(directory, "formal/profiles.json"), JSON.stringify({ replaySources: [source] }));
      expect(replaySources(directory)).toEqual([source]);
      writeFileSync(resolve(directory, "formal/replay/new-helper.mjs"), "new dependency");
      expect(() => replaySources(directory)).toThrow(/inventory differs/);
      rmSync(resolve(directory, "formal/replay/new-helper.mjs"));
      rmSync(resolve(directory, source));
      expect(() => replaySources(directory)).toThrow(/inventory differs/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
    expect(replaySources()).toContain("formal/replay/coordinator.mjs");
  });
});
