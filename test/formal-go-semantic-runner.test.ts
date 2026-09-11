import { describe, expect, it } from "vitest";

const moduleUrl = new URL("../formal/measure-go-semantics.mjs", import.meta.url).href;
const { evaluateGoTestEvents } = await import(moduleUrl) as {
  evaluateGoTestEvents(events: string, exitCode: number): { state: string; assertionKinds: Record<string, string> };
};

function localClockFailure(output: string): string {
  const parent = "TestLocalClockConformance", leaf = `${parent}/trace.itf.json`;
  return [
    { Action: "run", Test: parent },
    { Action: "run", Test: leaf },
    { Action: "output", Test: leaf, Output: `    local_clock_profile_test.go:84: ${output}\n` },
    { Action: "fail", Test: leaf },
    { Action: "fail", Test: parent },
    { Action: "fail" },
  ].map(event => JSON.stringify(event)).join("\n");
}

describe("Go local-clock mutation assertion attribution", () => {
  it("requires an observable replay mismatch for the new clock profile", () => {
    const result = evaluateGoTestEvents(localClockFailure("expected: {\"loaders\":1}\nactual: {\"loaders\":2}"), 1);
    expect(result).toMatchObject({ state: "detected", assertionKinds: {
      "TestLocalClockConformance/trace.itf.json": "observation-mismatch",
    } });
  });
  it.each(["unknown trace input", "call before instance construction", "default clock started with negative elapsed time"])(
    "does not credit infrastructure failure: %s", message => {
      expect(() => evaluateGoTestEvents(localClockFailure(message), 1)).toThrow(/replay failure lacks observation/);
    },
  );
});
