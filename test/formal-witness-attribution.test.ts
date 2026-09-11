import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recoveryShadowWitnesses } from "../formal/replay/witnesses/recovery-shadow.mjs";

type RecordValue = Record<string, unknown>;
type Fixture = {
  witness: string;
  profile: string;
  source: string;
  initialState: RecordValue;
  steps: Array<{ action: string; statePatch: RecordValue }>;
};
type State = { input: { name: string; choice: { "#bigint": string } }; s: RecordValue };
const fixtures = JSON.parse(readFileSync(new URL("./fixtures/formal-witness-attribution.json", import.meta.url), "utf8")) as Fixture[];
const directories: string[] = [];

// Excerpts from real Quint histories preserve their final public outcome. The
// negative controls add another sufficient cause, or remove the distinguishing
// time change, so reaching that outcome alone must no longer earn the witness.
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
function fixtureFor(witness: string): Fixture {
  const fixture = fixtures.find(item => item.witness === witness);
  if (fixture === undefined) throw new Error(`Missing attribution fixture for ${witness}`);
  return fixture;
}
// These excerpts use native integers for private state; the shared classifiers
// key on the explicit input record, so each step declares one without a choice.
const noChoice = () => ({ name: "", choice: { "#bigint": "-1" } });
function statesFor(fixture: Fixture): State[] {
  const states: State[] = [{ input: { ...noChoice(), name: "excerpt" }, s: structuredClone(fixture.initialState) }];
  for (const step of fixture.steps) {
    states.push({ input: { ...noChoice(), name: step.action }, s: merge(states.at(-1)!.s, step.statePatch) });
  }
  return states;
}
function witnessed(fixture: Fixture, states: State[]): boolean {
  const directory = mkdtempSync(join(tmpdir(), "dialcache-witness-attribution-"));
  directories.push(directory);
  const path = join(directory, "trace.itf.json");
  writeFileSync(path, JSON.stringify({ states }));
  return recoveryShadowWitnesses(fixture.profile, [path]).has(fixture.witness);
}

afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true }); });

describe("Quint witnesses distinguish the rule responsible for an outcome", () => {
  it.each(fixtures)("recognizes an isolated real schedule: $witness", fixture => {
    expect(witnessed(fixture, statesFor(fixture))).toBe(true);
  });

  it.each(["maximum-age-read-preserves-source-error", "future-read-preserves-source-error"])(
    "does not credit %s when the watermark already prevents recovery", witness => {
      const fixture = fixtureFor(witness), states = statesFor(fixture);
      states[0]!.s.watermark = states[0]!.s.created;
      expect(witnessed(fixture, states)).toBe(false);
    },
  );

  it.each(["maximum-age-read-preserves-source-error", "future-read-preserves-source-error"])(
    "does not credit %s when physical storage already expired", witness => {
      const fixture = fixtureFor(witness), states = statesFor(fixture);
      states[0]!.s.expires = states[0]!.s.now;
      expect(witnessed(fixture, states)).toBe(false);
    },
  );

  it("does not credit a watermark when age already prevents recovery", () => {
    const fixture = fixtureFor("fenced-read-does-not-retain"), states = statesFor(fixture);
    const acquired = states[0]!.s;
    acquired.created = Number(acquired.wall) - Number(acquired.maxAge);
    expect(witnessed(fixture, states)).toBe(false);
  });

  it.each(["absent", "expired"])("requires a usable candidate to challenge classifier failure: %s", reason => {
    const fixture = fixtureFor("classifier-error-keeps-error-without-decode"), states = statesFor(fixture);
    const beforeRejection = states.at(-2)!.s;
    if (reason === "absent") beforeRejection.candidate = 0;
    else beforeRejection.acceptedMaxAge = Number(beforeRejection.wall) - Number(beforeRejection.candidateCreated);
    expect(witnessed(fixture, states)).toBe(false);
  });

  it("requires elapsed age to change while asynchronous decoding is pending", () => {
    const fixture = fixtureFor("recovery-age-sampled-at-successful-decode"), states = statesFor(fixture);
    // This real excerpt starts decoding at age 1,001 ms and rolls back to 1 ms
    // before completion. Undo the rollback and retain a matching telemetry value.
    const beforeReturn = states.at(-2)!.s, afterReturn = states.at(-1)!.s;
    beforeReturn.wall = Number(beforeReturn.candidateCreated) + 1001;
    (afterReturn.d as { ages: number[] }).ages = [1001];
    expect(witnessed(fixture, states)).toBe(false);
  });

  it("requires equal C1 bytes to isolate a watermark supersession", () => {
    const fixture = fixtureFor("fenced-c1-supersedes-without-repair"), states = statesFor(fixture);
    const confirmation = states.at(-2)!.s;
    confirmation.c0 = 1; // text '1'
    confirmation.frame = 3; // binary '1': identical payload bytes
    expect(witnessed(fixture, states)).toBe(true);
    confirmation.frame = 5; // binary ' 1': a replacement already supersedes C0
    expect(witnessed(fixture, states)).toBe(false);
  });
});
