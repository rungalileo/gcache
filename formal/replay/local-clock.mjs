import assert from "node:assert/strict";
import { emptyObservation } from "./observation.mjs";
import { assertInputMetadata, itfInteger, itfSignedInteger, record } from "./itf.mjs";
const advances = [1, 100, 300, 400, 700, 999200, 999999, 1000000];
const choices = {
  init: [-1], constructInstance: [0, 1], advanceTicks: advances, call: [0, 1, 2, 3],
};
export function parseLocalClockTrace(raw, path) {
  const states = record(raw, path).states;
  if (!Array.isArray(states) || states.length < 2)
    throw new Error("Clock trace requires initialization and a transition");
  const shape = emptyObservation();
  const steps = states.map((value, index) => {
    const state = record(value, `${path} state${index}`);
    const input = record(state.input, "clock input");
    if (Object.keys(input).sort().join() !== "choice,name" || typeof input.name !== "string"
      || !Object.hasOwn(choices, input.name) || (index === 0) !== (input.name === "init")) {
      throw new Error("Unknown or misplaced clock action");
    }
    const choice = itfSignedInteger(input.choice, "clock choice");
    if (!choices[input.name].includes(choice))
      throw new Error("Invalid clock choice");
    assertInputMetadata(state, input.name, choice, input.name !== "init", `${path} state${index}`);
    const rawObservation = record(record(state.s, "clock state").o, "clock observation");
    if (Object.keys(rawObservation).sort().join() !== Object.keys(shape).sort().join())
      throw new Error("Missing clock observation fields");
    const expected = {};
    for (const [key, baseline] of Object.entries(shape)) {
      const observed = rawObservation[key];
      if (key === "calls") {
        if (!Array.isArray(observed))
          throw new Error("Invalid clock calls");
        expected[key] = observed.map(value => itfInteger(value, "clock returned value"));
      }
      else if (typeof baseline === "number")
        expected[key] = itfInteger(observed, `clock ${key}`);
      else {
        if (!Array.isArray(observed) || observed.length !== 0)
          throw new Error(`Unsupported clock ${key}`);
        expected[key] = [];
      }
    }
    return { action: input.name, choice, expected: expected };
  });
  return { path, steps };
}
export function localClockInput(action, choice) {
  if (!Object.hasOwn(choices, action) || !choices[action].includes(choice)) {
    throw new Error("Invalid local-clock action/choice");
  }
  switch (action) {
    case "init": return [];
    case "constructInstance": return [{ op: action, instance: choice }];
    case "advanceTicks": return [{ op: action, ticks: choice }];
    case "call": return [{ op: action, instance: Math.floor(choice / 2), offered: choice % 2 + 1 }];
  }
}
export function assertLocalClockObservation(step, observed) {
  assert.deepEqual(observed, step.expected);
}
export const localClockActions = Object.keys(choices).filter(action => action !== "init");
