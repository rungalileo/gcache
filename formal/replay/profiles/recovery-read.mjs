function encodeFrame(payload, stamp, encoding = 0) {
  const frame = Buffer.alloc(10);
  frame[0] = 1;
  frame.writeBigUInt64BE(BigInt(stamp), 1);
  frame[9] = encoding;
  return Buffer.concat([frame, Buffer.from(payload)]);
}
const seedAges = [0, 999, 1000, 4999, 5000, 3_600_001, 7_200_000, 0, 1000, 1000, 0, 0, 4999, 0, 0, 1000, 0, 0, 1000];
const compressedOne = "0128b52ffd200109000031";
const corruptCompressed = "016e6f742061207a737464206672616d65";
// Fixture bytes and clocks are external inputs. No predicted value, phase,
// memo, retention or observation is consulted when constructing a command.
function seedInput(choice, _observed, environment) {
  const base = { op: "seed", ageMs: seedAges[choice], ttlMs: choice === 11 || choice === 15 ? 1000 : 60_000 };
  if (choice === 18)
    return base;
  if (choice === 8 || choice === 12 || choice === 13)
    return { ...base, payloadHex: compressedOne };
  if (choice === 9 || choice === 14)
    return { ...base, payloadHex: corruptCompressed };
  if (choice === 16)
    return { ...base, frameHex: "0100200000000000010031" };
  if (choice === 17) {
    const frame = encodeFrame("1", environment.wallMs);
    frame[0] = 2;
    return { ...base, frameHex: frame.toString("hex") };
  }
  if (choice === 10)
    return { ...base, frameHex: encodeFrame("1", environment.wallMs, 255).toString("hex") };
  return { ...base, value: choice === 7 ? 2 : 1 };
}
export const recoveryReadProfile = {
  explicitInputs: true,
  markerIO: true,
  compressionIO: true,
  readIO: true,
  initChoices: [0, 1, 2],
  fixture: mode => ({
    policy: { requestLocal: true, ttlSec: { local: 1, remote: 1 }, staleOnErrorMaxAgeSec: 5,
      ...(mode === 2 ? { shadow: { ramp: 100 } } : {}),
    },
    tracked: mode !== 0, recovery: "allow", fallbackTimeoutMs: null,
    readTimeoutMs: 30_000_000, observe: ["readContext", "readAbort", "marker", "compression"],
  }),
  setup: [
    { op: "openScope", id: "0" }, { op: "openScope", id: "1" },
    { op: "faults", value: { holdReads: true, holdLoads: true } },
  ],
  actions: {
    beginCall: { choices: [0, 1, 2], input: choice => ({ op: "begin", ...(choice < 2 ? { scope: String(choice) } : {}) }) },
    releaseRead: { input: (_, observed) => ({ op: "release", effect: "read", index: observed.reads - 1 }) },
    releaseLoad: { input: (_, observed) => ({ op: "release", effect: "load", index: observed.loads - 1 }) },
    rejectLoader: { input: (_, observed) => ({ op: "reject", loader: observed.loaders - 1 }) },
    resolveLoader: { input: (_, observed) => ({ op: "resolve", loader: observed.loaders - 1, value: 2 }) },
    seed: { choices: seedAges.map((_, index) => index), input: seedInput },
    advance: { choices: [1, 999, 1000, 4000, 60_000, 3_600_000], input: ms => ({ op: "advance", ms }) },
    policy: { choices: [0, 1, 2], input: choice => ({ op: "policy", value: {
          ttlSec: { remote: choice === 2 ? 7200 : 1 },
          staleOnErrorMaxAgeSec: choice === 2 ? 14_400 : choice === 1 ? 7200 : 5,
        } }) },
    closeScope: { choices: [0, 1], input: choice => ({ op: "closeScope", id: String(choice) }) },
    invalidate: { input: () => ({ op: "invalidate" }) },
    observeMarker: { input: () => ({ op: "observeMarker" }) },
    writeFault: { choices: [0, 1], input: choice => ({ op: "faults", value: { write: choice === 1 } }) },
  },
};
