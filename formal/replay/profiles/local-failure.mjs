export const localFailureProfile = {
  explicitInputs: true,
  fixture: { policy: { requestLocal: true, ttlSec: { local: 60, remote: 60 } }, fallbackTimeoutMs: null, localFaultInjection: true },
  setup: [{ op: "openScope", id: "0" }, { op: "openScope", id: "1" }],
  actions: {
    beginCall: { choices: [0, 1, 2], input: choice => ({ op: "begin", ...(choice < 2 ? { scope: String(choice) } : {}) }) },
    resolveLoader: { choices: [1, 2], input: (value, observed) => ({ op: "resolve", loader: observed.loaders - 1, value }) },
    rejectLoader: { input: (_, observed) => ({ op: "reject", loader: observed.loaders - 1 }) },
    localFault: { choices: [0, 1], input: choice => ({ op: "faults", value: { localStorage: choice === 1 } }) },
    policy: { choices: [0, 1], input: choice => ({ op: "policy", value: { ramp: { remote: choice * 100 } } }) },
    seed: { choices: [1, 2], input: value => ({ op: "seed", value }) },
  },
};
