import type { Input, Policy } from "./behavior-driver.js";
import type { Profile } from "./feature-profile.js";
import { cohortRamp } from "./cohort-inputs.js";

// Published fixture numerator for {urn:id:0}#ShadowLayers:shadow, independently
// computed from W03's UTF-16 FNV specification, not the runtime's hash helper.
const shadowSample = 3_203_834_406;
const range = (length: number, start = 0) => Array.from({ length }, (_, index) => index + start);

function policy(choice: number): Policy {
  return {
    requestLocal: [0, 1, 8, 12].includes(choice),
    coalesce: false,
    ttlSec: { local: 60, remote: [8, 13].includes(choice) ? 120 : 60 },
    ramp: { local: [0, 2, 7, 8, 12].includes(choice) ? 100 : 0, remote: [4, 5, 12, 13].includes(choice) ? 100 : 0 },
    staleOnErrorMaxAgeSec: [8, 13].includes(choice) ? 180 : 120,
    shadow: { ramp: choice >= 9 && choice <= 11 ? cohortRamp(shadowSample, choice - 9)
      : choice === 7 ? 101 : [5, 6, 13].includes(choice) ? 0 : 100 },
  };
}

export const shadowLayersProfile: Profile = {
  explicitInputs: true,
  fixture: {
    policy: policy(0), tracked: true, fallbackTimeoutMs: null,
    readTimeoutMs: 120_000, shadowMaxInFlight: 2, recovery: "allow", probeSourceScope: true,
  },
  setup: [0, 1, 2].map((scope): Input => ({ op: "openScope", id: String(scope), instance: scope === 2 ? "1" : "0" }))
    .concat([{ op: "faults", value: { holdDumps: true, holdWrites: true } }]),
  actions: {
    beginCall: { choices: range(15), input: choice => {
      const context = Math.floor(choice / 3);
      return { op: "begin", key: String(choice % 3), useCase: "ShadowLayers",
        ...(context < 3 ? { scope: String(context) } : { instance: context === 4 ? "1" : "0" }) };
    } },
    resolveLoader: { choices: range(48, 1), input: choice => ({ op: "resolve", loader: Math.floor((choice - 1) / 2), value: (choice - 1) % 2 + 1 }) },
    rejectLoader: { choices: range(24), input: choice => ({ op: "reject", loader: choice }) },
    rejectTimeout: { choices: range(24), input: choice => ({ op: "reject", loader: choice, error: "timeout" }) },
    releaseDump: { choices: range(24), input: choice => ({ op: "release", effect: "dump", index: choice }) },
    releaseWrite: { choices: range(24), input: choice => ({ op: "release", effect: "write", index: choice }) },
    advance: { choices: [1, 60_000, 120_000], input: choice => ({ op: "advance", ms: choice }) },
    policy: { choices: range(14), input: choice => ({ op: "policy", value: policy(choice) }) },
    seed: { choices: range(12), input: choice => ({ op: "seed", key: String(Math.floor(choice / 4)), useCase: "ShadowLayers",
      value: choice % 4 === 1 ? 2 : 1, ageMs: choice % 4 === 2 ? 59_999 : choice % 4 === 3 ? 60_000 : 0, ttlMs: 180_000 }) },
  },
};
