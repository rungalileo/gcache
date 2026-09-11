import assert from "node:assert/strict";
import { profiles, parseTrace, featureInput, assertFeatureObservation } from "./features.mjs";
import * as effects from "./effects.mjs";
import * as localClock from "./local-clock.mjs";
import * as core from "./core.mjs";
import { emptyObservation } from "./observation.mjs";

export function profileActions() {
  const features = Object.fromEntries(Object.entries(profiles)
    .map(([name, profile]) => [name, Object.keys(profile.actions)]));
  return {
    ...features,
    effects: effects.actions.filter(name => name !== "init"),
    "local-clock": localClock.localClockActions,
    core: core.actionNames.filter(name => name !== "init"),
  };
}

// This object is coordinator-owned. Only fixture/setup/command results cross
// the native boundary. The input mapping receives a fresh action descriptor,
// actual observations, and actual clocks; it cannot inspect model predictions.
// `observation` names the protocol.schema.json definition every observation
// for this binding must satisfy before any comparison runs.
export function bindTrace(name, raw, path) {
  if (Object.hasOwn(profiles, name)) {
    const profile = profiles[name];
    const trace = parseTrace(raw, path, profile);
    const fixture = typeof profile.fixture === "function"
      ? profile.fixture(trace.steps[0].choice)
      : profile.fixture;
    return {
      trace, fixture, setup: profile.setup, observation: "behaviorObservation",
      commands(index, observed, environment) {
        const { action, choice } = trace.steps[index];
        return action === "init" ? [] : [featureInput(profile, action, choice, observed, environment)];
      },
      assert(index, observed) {
        assertFeatureObservation(profile, trace.steps[index], observed);
      },
    };
  }
  if (name === "core") {
    const parsed = core.parseItfTrace(raw, path);
    const trace = { path, steps: parsed.states };
    return {
      trace, fixture: {}, setup: [], observation: "coreObservation",
      commands(index) {
        return core.coreCommands(trace.steps[index].action);
      },
      assert(index, observed) {
        core.assertCoreObservation(trace.steps[index].state, observed);
      },
    };
  }
  if (name === "local-clock") {
    const trace = localClock.parseLocalClockTrace(raw, path);
    return {
      trace, fixture: {}, setup: [], observation: "localClockObservation",
      commands(index) {
        const { action, choice } = trace.steps[index];
        return localClock.localClockInput(action, choice);
      },
      assert(index, observed) {
        localClock.assertLocalClockObservation(trace.steps[index], observed);
      },
    };
  }
  if (name === "effects") {
    const trace = effects.parseTrace(raw, path);
    const fixture = effects.fixtureFor(trace.steps[0].choice);
    const expected = effects.expectedObservations(trace);
    const initialInput = { action: "init", choice: trace.steps[0].choice };
    return {
      trace, fixture, observation: "behaviorObservation",
      setup: [
        { op: "faults", value: { holdReads: true, holdLoads: true, holdDumps: true, holdWrites: true } },
        ...effects.inputsFor(initialInput, emptyObservation(fixture), { wallMs: 0 }),
      ],
      commands(index, observed, environment) {
        const { action, choice } = trace.steps[index];
        const input = { action, ...(choice === undefined ? {} : { choice }) };
        return effects.inputsFor(input, observed, environment);
      },
      assert(index, observed) {
        assert.deepEqual(effects.project(observed), expected[index]);
      },
    };
  }
  throw new Error(`Unknown replay profile: ${name}`);
}
