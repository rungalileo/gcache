import type { Policy } from "./behavior-driver.js";
import { cohortRamp } from "./cohort-inputs.js";
import type { Profile } from "./feature-profile.js";

// These published fixture numerators are inputs, never values obtained from
// the implementation under test. Quint independently compares the thresholds.
const localSample = 4292886220;
const remoteSample = 1018911151;
const sourceValues = [1, 2, undefined, "undefined", null, false, 0, ""] as const;

export const runtimeBoundariesProfile: Profile = {
  explicitInputs: true,
  initChoices: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  fixture: fixture => ({
    policy: fixture === 9 ? { requestLocal: true, ttlSec: { local: 60, remote: 60 }, staleOnErrorMaxAgeSec: 120, shadow: { ramp: 100 } }
      : fixture === 8 ? { requestLocal: false, ramp: { local: 0, remote: 0 }, staleOnErrorMaxAgeSec: 0, shadow: { ramp: 0 } }
      : fixture >= 6 ? {} : { ...(fixture < 3 ? { coalesce: false } : {}), ...(fixture % 3 === 0 ? { requestLocal: true }
        : { ttlSec: fixture % 3 === 1 ? { local: 60 } : { remote: 60 } }) },
    remote: fixture < 6 ? fixture % 3 === 2 : fixture === 7 || fixture === 9,
    fallbackTimeoutMs: null,
  }),
  setup: [{ op: "openScope", id: "0" }, { op: "faults", value: { holdPolicies: true } }],
  actions: {
    beginCall: { input: () => ({ op: "begin", scope: "0" }) },
    releasePolicy: { input: (_, observed) => ({ op: "release", effect: "policy", index: observed.policyCalls - 1 }) },
    closeScope: { input: () => ({ op: "closeScope", id: "0" }) },
    policy: {
      choices: Array.from({ length: 22 }, (_, i) => i),
      input: choice => {
        if (choice === 21) return { op: "policy", value: { requestLocal: false, ramp: { local: 0, remote: 0 }, staleOnErrorMaxAgeSec: 0, shadow: { ramp: 0 } } };
        if (choice === 12) return { op: "policy", value: null };
        if (choice === 13) return { op: "policy", value: { requestLocal: false } };
        if (choice === 18 || choice === 19) return { op: "policy", value: { ttlSec: choice === 18 ? { local: 60 } : { remote: 60 } } };
        if (choice === 20) return { op: "policy", value: { ttlSec: { local: 60 }, ramp: { local: 100 } } };
        if (choice >= 14) {
          const value = choice >= 16 ? null : "invalid";
          return { op: "policy", value: choice % 2 === 0
            ? { coalesce: value as unknown as boolean } : { requestLocal: value as unknown as boolean } };
        }
        const relation = Math.floor(choice / 3);
        const value: Policy = {
          ...(choice % 3 === 0 ? {} : { coalesce: choice % 3 === 2 }),
          ...(relation === 3 ? {} : { ramp: {
            local: cohortRamp(localSample, relation), remote: cohortRamp(remoteSample, relation),
          } }),
        };
        return { op: "policy", value };
      },
    },
    resolveLoader: {
      choices: Array.from({ length: 64 }, (_, i) => i),
      input: choice => {
        const value = sourceValues[choice % sourceValues.length];
        return { op: "resolve", loader: Math.floor(choice / sourceValues.length),
          ...(value === undefined ? {} : { value }) };
      },
    },
  },
};
