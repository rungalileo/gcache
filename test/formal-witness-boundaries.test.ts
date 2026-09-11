import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recoveryShadowWitnesses } from "./formal/recovery-shadow-witnesses.js";
import { runtimeWitnesses } from "./formal/runtime-witnesses.js";

type RecordValue = Record<string, unknown>;
type Fixture = {
  witness: string;
  profile: string;
  initialState: RecordValue;
  steps: Array<{ action: string; choice?: unknown; statePatch: RecordValue }>;
};
type State = { "mbt::actionTaken": string; "mbt::nondetPicks"?: { choice: unknown }; s: RecordValue };
const fixtures = JSON.parse(readFileSync(new URL("./fixtures/formal-witness-boundaries.json", import.meta.url), "utf8")) as Fixture[];
const directories: string[] = [];

// The fixture file contains excerpts selected from real Quint histories. Store
// only changed fields to keep the examples readable without duplicating state.
function merge(before: RecordValue, patch: RecordValue): RecordValue {
  const result = structuredClone(before);
  for (const [key, value] of Object.entries(patch)) {
    const previous = result[key];
    result[key] = value !== null && previous !== null
      && typeof value === "object" && typeof previous === "object"
      && !Array.isArray(value) && !Array.isArray(previous)
      ? merge(previous as RecordValue, value as RecordValue)
      : structuredClone(value);
  }
  return result;
}
function statesFor(fixture: Fixture): State[] {
  const states: State[] = [{ "mbt::actionTaken": "excerpt", s: structuredClone(fixture.initialState) }];
  for (const step of fixture.steps) {
    states.push({
      "mbt::actionTaken": step.action,
      ...(step.choice === undefined ? {} : { "mbt::nondetPicks": { choice: step.choice } }),
      s: merge(states.at(-1)!.s, step.statePatch),
    });
  }
  return states;
}
function collect(fixture: Fixture, states: State[]): Set<string> {
  const directory = mkdtempSync(join(tmpdir(), "dialcache-witness-boundary-"));
  directories.push(directory);
  const path = join(directory, "trace.itf.json");
  writeFileSync(path, JSON.stringify({ states }));
  return fixture.profile === "layers" ? runtimeWitnesses(fixture.profile, [path])
    : recoveryShadowWitnesses(fixture.profile, [path]);
}
function fixtureFor(witness: string): Fixture {
  const fixture = fixtures.find(item => item.witness === witness);
  if (fixture === undefined) throw new Error(`Missing fixture for ${witness}`);
  return fixture;
}
function integer(value: number): RecordValue { return { "#bigint": String(value) }; }

afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true }); });

describe("Quint recovery and shadow witness consequences", () => {
  it.each(fixtures)("recognizes the replayed consequence: $witness", fixture => {
    expect(collect(fixture, statesFor(fixture)).has(fixture.witness)).toBe(true);
  });

  it.each(fixtures)("does not credit inputs without the consequence: $witness", fixture => {
    const states = statesFor(fixture);
    const final = states.at(-1)!.s;
    if (fixture.witness === "late-shadow-dump-cannot-dispatch-write") {
      // Merely reaching a timed-out serialization is insufficient: a late
      // dispatch violates the very consequence the witness must establish.
      const observations = final.o as RecordValue;
      const writes = Number((observations.writes as RecordValue)["#bigint"]);
      observations.writes = integer(writes + 1);
    } else {
      // Preserve phase, clocks, private candidate, and external input. Remove
      // only the final public result/effect transition from the real trace.
      final.o = structuredClone(states.at(-2)!.s.o);
    }
    expect(collect(fixture, states).has(fixture.witness)).toBe(false);
  });

  it("confirms equal bytes across text/binary encodings but excludes different JSON bytes", () => {
    const fixture = fixtureFor("same-c1-bytes-confirm-mismatch");
    const states = statesFor(fixture), before = states.at(-2)!.s;
    before.c0 = integer(1); // text '1'
    before.frame = integer(3); // binary '1'
    expect(collect(fixture, states).has(fixture.witness)).toBe(true);
    before.frame = integer(5); // binary ' 1 ', same decoded value, different bytes
    expect(collect(fixture, states).has(fixture.witness)).toBe(false);
  });

  it("requires different bytes for a replacement witness even when a verdict says superseded", () => {
    const fixture = fixtureFor("different-c1-bytes-supersede");
    const states = statesFor(fixture), before = states.at(-2)!.s;
    before.c0 = integer(1); before.frame = integer(5);
    expect(collect(fixture, states).has(fixture.witness)).toBe(true);
    before.frame = integer(3);
    expect(collect(fixture, states).has(fixture.witness)).toBe(false);
  });

  it("does not claim capacity retention from late-effect suppression alone", () => {
    const fixture = fixtureFor("late-shadow-dump-cannot-dispatch-write");
    const witnesses = collect(fixture, statesFor(fixture));
    expect(witnesses.has(fixture.witness)).toBe(true);
    expect([...witnesses].filter(name => /capacity|keeps-slot|ownership/.test(name))).toEqual([]);
  });

  it("requires the exact F boundary, not merely a served stale value", () => {
    const fixture = fixtureFor("first-stale-age-recovers-without-publication");
    const states = statesFor(fixture);
    const acquisition = states.findIndex(state => state["mbt::actionTaken"] === "beginCall") - 1;
    const before = states[acquisition]!.s;
    before.created = integer(Number((before.created as RecordValue)["#bigint"]) - 1);
    expect(collect(fixture, states).has(fixture.witness)).toBe(false);
  });

  it("requires exact M after decode, not merely a generic recovery miss", () => {
    const fixture = fixtureFor("exact-maximum-after-decode-rejects");
    const states = statesFor(fixture), before = states.at(-2)!.s;
    before.wall = integer(Number((before.wall as RecordValue)["#bigint"]) + 1);
    expect(collect(fixture, states).has(fixture.witness)).toBe(false);
  });
});


describe("Quint invalidation memo witness provenance", () => {
  const examples = JSON.parse(readFileSync(new URL("./fixtures/formal-runtime-witness-boundaries.json", import.meta.url), "utf8")) as Array<Fixture & { title: string }>;
  it.each(examples)("distinguishes retained memo from later publication: $title", fixture => {
    expect(collect(fixture, statesFor(fixture)).has(fixture.witness))
      .toBe(fixture.title === "preexisting-memo-survives");
  });

  it("does not credit a same-value replacement after invalidation as the original memo", () => {
    const fixture = examples.find(item => item.title === "preexisting-memo-survives")!;
    const states = statesFor(fixture);
    const invalidation = states.findIndex(state => state["mbt::actionTaken"] === "invalidate");
    const replacement = structuredClone(states[invalidation]!);
    const beforeProbe = states.at(-2)!.s;
    const memo = beforeProbe.memo as RecordValue[];
    const owners = beforeProbe.owners as RecordValue[];
    const slots = beforeProbe.memoSlots as RecordValue[];
    const retainedSlot = memo.findIndex(value => Number(value["#bigint"]) > 0);
    const call = slots.findIndex(value => Number(value["#bigint"]) === retainedSlot);
    const loader = Number(owners[call]!["#bigint"]);
    const value = Number(memo[retainedSlot]!["#bigint"]);
    // Challenge provenance with an observed publication of the same bytes.
    // Public replay remains a separate gate; this test isolates classification.
    replacement["mbt::actionTaken"] = "resolveLoader";
    replacement["mbt::nondetPicks"] = { choice: { tag: "Some", value: integer(loader * 2 + value) } };
    states.splice(invalidation + 1, 0, replacement);
    expect(collect(fixture, states).has(fixture.witness)).toBe(false);
  });
});
