import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { effectsAuthorityRules, effectsAuthorityWitnesses } from "./formal/effects-authority-witnesses.js";

// Public excerpts of real Quint regressions, used solely as classifier controls.
// These tests do not add behavioral examples or mutation assertion detections.
const fixtures = JSON.parse(readFileSync(new URL("./fixtures/effects-authority-witnesses.json", import.meta.url), "utf8")) as Array<{
  regression: string; trace: { states: Array<{ input: unknown; s: Record<string, unknown> }> };
}>;
const directory = mkdtempSync(join(tmpdir(), "dialcache-effects-authority-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
function traceFor(name: string) {
  return structuredClone(fixtures.find(fixture => fixture.regression === effectsAuthorityRules.find(rule => rule.name === name)!.regression)!.trace);
}
function classify(trace: unknown) {
  const path = join(directory, "trace.itf.json"); writeFileSync(path, JSON.stringify(trace));
  return effectsAuthorityWitnesses([path]);
}
describe("effects authority witness controls", () => {
  for (const rule of effectsAuthorityRules) it(`requires the actual consequence for ${rule.name}`, () => {
    const trace = traceFor(rule.name);
    expect(classify(trace).has(rule.name)).toBe(true);
    trace.states.at(-1)!.s.calls = [{ "#bigint": "0" }];
    expect(classify(trace).has(rule.name)).toBe(false);
  });
  it("requires a cache hit after the intervening fence, even when the initial source succeeds", () => {
    const name = "write-stamp-after-serialization", trace = traceFor(name);
    trace.states.at(-1)!.s.loaders = { "#bigint": "2" };
    trace.states.at(-1)!.s.loads = { "#bigint": "0" };
    expect(classify(trace).has(name)).toBe(false);
  });
  it("rejects a wrong observing layer with the same positive offset", () => {
    const name = "future-offset-observing-layer-positive-seconds", trace = traceFor(name);
    const events = trace.states.at(-1)!.s.events as Array<Record<string, unknown>>;
    events.find(event => event.event === "futureOffset")!.location = "remote_shadow";
    expect(classify(trace).has(name)).toBe(false);
  });
  it("rejects a zero offset at the right observing layer", () => {
    const name = "future-offset-observing-layer-positive-seconds", trace = traceFor(name);
    const events = trace.states.at(-1)!.s.events as Array<Record<string, unknown>>;
    events.find(event => event.event === "futureOffset")!.amount = { "#bigint": "0" };
    expect(classify(trace).has(name)).toBe(false);
  });
  it("rejects duplicated leader errors despite matching caller errors", () => {
    const name = "shared-failure-preserves-leader-and-follower-trail", trace = traceFor(name);
    const events = trace.states.at(-1)!.s.events as Array<Record<string, unknown>>;
    events.push(structuredClone(events.find(event => event.event === "error")!));
    expect(classify(trace).has(name)).toBe(false);
  });
});
