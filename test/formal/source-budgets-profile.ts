import type { Profile } from "./feature-profile.js";

export const sourceBudgetsProfile: Profile = {
  explicitInputs: true, initChoices: [0, 1, 2],
  fixture: mode => ({ policy: { ttlSec: { local: 1 } }, tracked: true, remote: false,
    fallbackTimeoutMs: mode === 0 ? "default" : mode === 1 ? null : 10 }),
  setup: [{ op: "faults", value: { holdPolicies: true } }],
  actions: {
    beginCall: { choices: [0, 1, 2, 3], input: choice => ({ op: "begin",
      ...(choice === 1 || choice === 3 ? { outside: true } : {}), ...(choice >= 2 ? { key: "{invalid}" } : {}) }) },
    releasePolicy: { choices: Array.from({ length: 8 }, (_, i) => i), input: index => ({ op: "release", effect: "policy", index }) },
    resolveLoader: { choices: Array.from({ length: 16 }, (_, i) => i + 1), input: choice => ({ op: "resolve", loader: Math.floor((choice - 1) / 2), value: (choice - 1) % 2 + 1 }) },
    rejectLoader: { choices: Array.from({ length: 8 }, (_, i) => i), input: loader => ({ op: "reject", loader }) },
    advance: { choices: [1, 3, 6, 9, 10, 100, 59999, 60001], input: ms => ({ op: "advance", ms }) },
  },
};
