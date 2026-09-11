import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

type Inventory = {
  packageName: string;
  profiles: Record<string, number>;
  witnessProfiles: string[];
  required: Array<{ name: string; category: string }>;
};
type Event = { Action: string; Package: string; Test?: string };
type Result = { status: string; generatedTraces: number; quintRegressionTraces: number; fixedScenarios: number; protocolVectors: number; witnessProfiles: string[] };
type InventoryInputs = {
  packageName: string;
  execution: { models: Array<{ profile?: string; generate?: { traces: number }; regressions?: string[]; replayRegressions?: string[] }> };
  scenarios: { scenarios: Array<{ feature: string; name: string }> };
  protocol: Record<string, unknown>;
};
const moduleUrl = new URL("../formal/check-go-replay.mjs", import.meta.url).href;
const { checkGoReplay, loadGoReplayInventory, buildGoReplayInventory } = await import(moduleUrl) as {
  loadGoReplayInventory(): Inventory;
  buildGoReplayInventory(input: InventoryInputs): Inventory;
  checkGoReplay(report: string, inventory: Inventory): Result;
};
const { protocolCorpus } = await import(new URL("../formal/vector-artifacts.mjs", import.meta.url).href) as {
  protocolCorpus(manifest?: InventoryInputs["execution"]): InventoryInputs["protocol"];
};
const inventory = loadGoReplayInventory();
const event = (Action: string, Test?: string): Event => ({ Action, Package: inventory.packageName, ...(Test ? { Test } : {}) });
const encode = (events: unknown[]): string => events.map(e => JSON.stringify(e)).join("\n") + "\n";
const completed = (): Event[] => {
  const events = [event("start")];
  const roots = [...new Set(inventory.required.map(entry => entry.name.split("/")[0]!))];
  for (const root of roots) {
    events.push(event("run", root));
    for (const { name } of inventory.required.filter(entry => entry.name.startsWith(`${root}/`))) {
      events.push(event("run", name), event("pass", name));
    }
    events.push(event("pass", root));
  }
  return [...events, event("pass")];
};
const check = (events: unknown[]): Result => checkGoReplay(encode(events), inventory);
const readFixture = (path: string): unknown => JSON.parse(readFileSync(new URL(`../formal/${path}`, import.meta.url), "utf8"));
const inventoryInputs = (): InventoryInputs => ({
  packageName: inventory.packageName,
  execution: readFixture("execution.json") as InventoryInputs["execution"],
  scenarios: readFixture("behavioral-scenarios.json") as InventoryInputs["scenarios"],
  protocol: protocolCorpus(),
});

describe("completed Go conformance report", () => {
  it("requires the exact current trace, fixed, protocol, and witness inventories", () => {
    const result = check(completed());
    expect(result).toMatchObject({ status: "pass", generatedTraces: 5280, quintRegressionTraces: 165, fixedScenarios: 244, protocolVectors: 1477 });
    expect(result.witnessProfiles).toEqual(["admission", "effects", "independent", "layers", "local-clock", "local-failure", "policy",
      "recovery", "recovery-read", "runtime-boundaries", "scope", "shadow", "shadow-layers", "source-budgets"]);
  });

  it("rejects a partial report even if every completed leaf passed", () => {
    expect(() => check(completed().slice(0, -1))).toThrow(/missing package pass/);
    const events = completed();
    events.splice(-1, 0, event("run", "TestStillRunning"));
    expect(() => check(events)).toThrow(/unfinished tests/);
  });

  it.each([
    { omitted: "the shadow profile", prefix: "TestFeatureConformance/shadow/" },
    { omitted: "the policy witness gate", prefix: "TestGeneratedWitnessEvidence/policy" },
    { omitted: "enablement scenarios", prefix: "TestBehaviorConformance/enablement/" },
    { omitted: "tracked protocol vectors", prefix: "TestProtocolDecoders/trackedDecodeVectors/" },
    { omitted: "the native local-clock corpus", prefix: "TestLocalClockConformance/" },
    { omitted: "the shared source-budget regression", prefix: "TestFeatureConformance/source-budgets/lateFollowerUsesLeadersRemainingBudgetTest.itf.json" },
  ])("rejects a report missing $omitted", ({ prefix }) => {
    const events = completed().filter(e => !e.Test?.startsWith(prefix));
    expect(() => check(events)).toThrow(/Missing completed Go replay leaf/);
  });

  it("rejects duplicate executions and added smoke or renamed trace leaves", () => {
    const events = completed();
    const index = events.findIndex(e => e.Action === "run" && e.Test?.startsWith("TestCoreConformance/"));
    events.splice(index + 2, 0, events[index]!);
    expect(() => check(events)).toThrow(/Duplicate or invalid Go test run/);
    const extra = completed();
    extra.splice(2, 0, event("run", "TestCoreConformance/conformance-smoke.itf.json"),
      event("pass", "TestCoreConformance/conformance-smoke.itf.json"));
    expect(() => check(extra)).toThrow(/Unexpected Go replay leaf/);
    expect(() => check(completed().map(e => e.Test?.endsWith("/trace_0.itf.json")
      ? { ...e, Test: e.Test.replace("trace_0.itf.json", "trace_0.itf.json#01") } : e))).toThrow(/Missing completed Go replay leaf/);
  });

  it("rejects skips, failures, build failures, and duplicate package completion", () => {
    for (const action of ["skip", "fail", "build-fail"]) {
      const events = completed();
      events.splice(-1, 0, event(action));
      expect(() => check(events)).toThrow(/Go replay (skip|fail|build-fail)/);
    }
    expect(() => check([...completed(), event("pass")])).toThrow(/continues after package completion/);
  });

  it("rejects malformed events and a report from another package", () => {
    expect(() => checkGoReplay("{", inventory)).toThrow(/Invalid Go JSON event/);
    expect(() => check(completed().map(e => ({ ...e, Package: "example.invalid/other" })))).toThrow(/Unexpected Go replay package/);
  });

  it("requires package start and real test results even when output claims success", () => {
    expect(() => checkGoReplay(" \n", inventory)).toThrow(/Empty Go replay report/);
    expect(() => check([event("run", "TestExample")])).toThrow(/precedes package start/);
    expect(() => check([event("start"), event("start")])).toThrow(/invalid Go package start/);
    expect(() => check([event("start", "TestExample")])).toThrow(/invalid Go package start/);
    expect(() => check([event("start"), { ...event("output"), Output: "PASS: all required histories" }, event("pass")]))
      .toThrow(/completed with unfinished tests/);
  });

  it("rejects malformed event objects, names, output, and unknown actions", () => {
    for (const invalid of [null, [], 1, "pass"]) {
      expect(() => check([invalid])).toThrow(/Invalid Go test event/);
    }
    for (const invalid of ["", null, 1]) {
      expect(() => check([event("start"), { ...event("run"), Test: invalid }])).toThrow(/Invalid Go test name/);
    }
    expect(() => check([event("start"), { ...event("output"), Output: 0 }])).toThrow(/Invalid Go output event/);
    expect(() => check([event("start"), event("run")])).toThrow(/invalid Go test run/);
    expect(() => check([event("start"), event("unexpected-action")])).toThrow(/Unsupported Go replay action/);
  });

  it("rejects fabricated completion and parents that finish before their children", () => {
    expect(() => check([event("start"), event("run", "TestParent/child")])).toThrow(/no running parent/);
    expect(() => check([event("start"), event("pass", "TestNeverStarted")])).toThrow(/Unexpected Go test completion/);
    expect(() => check([event("start"), event("run", "TestParent"), event("run", "TestParent/child"), event("pass", "TestParent")]))
      .toThrow(/parent completed before its children/);
  });

  it("rejects a child started after its intermediate parent completed", () => {
    expect(() => check([event("start"), event("run", "TestRoot"), event("run", "TestRoot/parent"),
      event("pass", "TestRoot/parent"), event("run", "TestRoot/parent/late")]))
      .toThrow(/parent already completed/);
  });

  it("accepts legal parallel scheduling but rejects impossible pause and resume transitions", () => {
    const events: unknown[] = completed();
    events.splice(2, 0, event("pause", "TestCoreConformance"),
      { ...event("output"), Output: "=== PAUSE TestCoreConformance\n" }, event("cont", "TestCoreConformance"));
    expect(check(events).status).toBe("pass");
    for (const action of ["pause", "cont"]) {
      expect(() => check([event("start"), event(action, "TestNotRunning")])).toThrow(/Invalid Go (pause|cont)/);
    }
    expect(() => check([event("start"), event("run", "TestPaused"), event("pause", "TestPaused"), event("pass", "TestPaused")]))
      .toThrow(/Unexpected Go test completion/);
  });
});

describe("Go conformance fixture inventory boundaries", () => {
  it("invalidates an otherwise successful report when a new scenario is required", () => {
    const inputs = inventoryInputs();
    inputs.scenarios.scenarios.push({ feature: "enablement", name: "new portable behavior" });
    expect(() => checkGoReplay(encode(completed()), buildGoReplayInventory(inputs))).toThrow(/Missing completed Go replay leaf.*new_portable_behavior/);
  });

  it("requires generated primitive rows and notices a newly added vector", () => {
    const inputs = inventoryInputs();
    expect(buildGoReplayInventory(inputs).required).toEqual(inventory.required);
    const generated = inventory.required.filter(entry => entry.category === "protocol" && entry.name.includes("/Quint"));
    expect(generated).toHaveLength(1343);
    for (const prefix of ["TestProtocolKeys/", "TestProtocolFrames/", "TestProtocolDecoders/", "TestProtocolRemainingVectors/"]) {
      const leaf = generated.find(entry => entry.name.startsWith(prefix))!.name;
      expect(() => check(completed().filter(event => event.Test !== leaf))).toThrow(/Missing completed Go replay leaf/);
    }
    (inputs.protocol.frameVectors as Array<{ name: string }>).push({ name: "new generated frame boundary" });
    expect(() => checkGoReplay(encode(completed()), buildGoReplayInventory(inputs)))
      .toThrow(/Missing completed Go replay leaf.*new_generated_frame_boundary/);
  });

  it("requires review for new or removed protocol groups and rejects empty groups", () => {
    const added = inventoryInputs();
    added.protocol.newPortableVectors = [{ name: "new codec boundary" }];
    expect(() => buildGoReplayInventory(added)).toThrow(/Review changed Go protocol vector group bindings/);
    const removed = inventoryInputs();
    delete removed.protocol.keyVectors;
    expect(() => buildGoReplayInventory(removed)).toThrow(/Review changed Go protocol vector group bindings/);
    const empty = inventoryInputs();
    empty.protocol.keyVectors = [];
    expect(() => buildGoReplayInventory(empty)).toThrow(/Empty protocol vector group/);
  });

  it("rejects fixture names that Go would escape or silently disambiguate", () => {
    const collision = inventoryInputs();
    collision.scenarios.scenarios = [{ feature: "enablement", name: "same name" }, { feature: "enablement", name: "same_name" }];
    expect(() => buildGoReplayInventory(collision)).toThrow(/Duplicate normalized Go case name/);
    for (const name of ["", "already#01", "line\nbreak", "café"]) {
      const inputs = inventoryInputs();
      inputs.scenarios.scenarios[0]!.name = name;
      expect(() => buildGoReplayInventory(inputs)).toThrow(/Unsupported Go fixture test name/);
    }
  });

  it("rejects empty fixed inventories and missing mandatory generated profiles", () => {
    const empty = inventoryInputs();
    empty.scenarios.scenarios = [];
    expect(() => buildGoReplayInventory(empty)).toThrow(/Empty fixed scenario inventory/);
    const missing = inventoryInputs();
    missing.execution.models = missing.execution.models.filter(model => model.profile !== "effects");
    expect(() => buildGoReplayInventory(missing)).toThrow(/Core and effects replay profiles are required/);
    const invalid = inventoryInputs();
    invalid.packageName = "";
    expect(() => buildGoReplayInventory(invalid)).toThrow(/Invalid Go replay input inventories/);
  });

  it("rejects duplicate profiles and invalid sampling counts", () => {
    const duplicate = inventoryInputs();
    duplicate.execution.models.push({ profile: "core", generate: { traces: 1 } });
    expect(() => buildGoReplayInventory(duplicate)).toThrow(/Invalid generated profile count/);
    for (const traces of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const inputs = inventoryInputs();
      inputs.execution.models.find(model => model.profile === "core")!.generate!.traces = traces;
      expect(() => buildGoReplayInventory(inputs)).toThrow(/Invalid generated profile count/);
    }
  });

  it("requires newly exported Quint regressions and rejects unscheduled or duplicate names", () => {
    const inputs = inventoryInputs();
    const model = inputs.execution.models.find(model => model.profile === "source-budgets")!;
    model.regressions!.push("newBoundaryTest");
    model.replayRegressions!.push("newBoundaryTest");
    expect(() => checkGoReplay(encode(completed()), buildGoReplayInventory(inputs)))
      .toThrow(/Missing completed Go replay leaf.*newBoundaryTest/);
    model.regressions!.pop();
    expect(() => buildGoReplayInventory(inputs)).toThrow(/Unscheduled Quint regression replay/);
    model.replayRegressions!.pop();
    model.replayRegressions!.push(model.replayRegressions![0]!);
    expect(() => buildGoReplayInventory(inputs)).toThrow(/Duplicate normalized Go case name/);
  });
});
