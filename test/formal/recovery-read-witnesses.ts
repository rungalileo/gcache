import { readFileSync } from "node:fs";
import { record } from "./itf.js";

// These boundary histories are intentionally narrow. Inputs identify the
// controlled schedule; the independently written public checks establish its
// consequence. Private model cache state, phase and eligibility never count.
interface PublicState {
  o: Record<string, unknown>;
  io: Record<string, unknown>;
  markers: unknown[];
  compression: unknown[];
}
interface Rule {
  name: string;
  regression: string;
  commands: string[];
  outcome: Partial<PublicState>;
}
const command = (name: string, choice = -1) => `${name}:${choice}`;
const init = (mode = 1) => command("init", mode);
const seed = (choice: number) => command("seed", choice);
const begin = (scope: number) => command("beginCall", scope);
const advance = (ms: number) => command("advance", ms);
const policy = (choice: number) => command("policy", choice);
const read = command("releaseRead"), load = command("releaseLoad");
const reject = command("rejectLoader"), resolve = command("resolveLoader");
const invalidate = command("invalidate"), marker = command("observeMarker");
const noSharedWrites = { dumps: 0, writes: 0 };
const rule = (name: string, regression: string, commands: string[], outcome: Partial<PublicState>): Rule =>
  ({ name, regression, commands, outcome });

export const recoveryReadWitnessRules: readonly Rule[] = [
  rule("read-settlement-crosses-freshness-and-recovers", "freshnessAfterHeldReadTest",
    [init(), seed(0), begin(2), advance(1000), read, reject, load],
    { o: { calls: [1], reads: 1, loaders: 1, loads: 1, classifications: 1, recovery: ["served"], ...noSharedWrites } }),
  rule("read-settlement-before-freshness-hits", "heldReadJustBeforeFreshnessBoundaryStillHitsTest",
    [init(), seed(0), begin(2), advance(999), read, load],
    { o: { calls: [1], reads: 1, loaders: 0, loads: 1, recovery: [], ...noSharedWrites } }),
  rule("tracked-encoding-error-denies-refill-and-local-reuse", "trackedEncodingFailureSuppressesRefillTest",
    [init(), seed(10), begin(0), read, resolve, begin(1)],
    { o: { calls: [2, 0], reads: 2, loaders: 1, loads: 0, ...noSharedWrites } }),
  rule("untracked-encoding-error-denies-refill-keeps-local-reuse", "untrackedEncodingFailureStillPublishesLocalTest",
    [init(0), seed(10), begin(0), read, resolve, begin(1)],
    { o: { calls: [2, 2], reads: 1, loaders: 1, loads: 0, ...noSharedWrites } }),
  rule("tracked-physical-cap-expires-before-logical-freshness", "trackedPhysicalRetentionExpiresAtCapTest",
    [init(), policy(2), begin(2), read, resolve, advance(3_600_000), begin(2), read],
    { o: { calls: [2, 0], reads: 2, loaders: 2, loads: 0, dumps: 1, writes: 1, writeTtls: [3_600_000] } }),
  rule("logical-recovery-age-exceeds-physical-cap", "physicalCapDoesNotClampLogicalRecoveryTest",
    [init(), policy(1), seed(5), begin(2), read, reject, load],
    { o: { calls: [1], reads: 1, loaders: 1, loads: 1, recovery: ["served"], ...noSharedWrites } }),
  rule("tracked-compressed-recovery-is-request-only", "compressedRecoveryMemoizesWithoutLocalPublicationTest",
    [init(), seed(8), begin(0), read, reject, load, begin(0), begin(1)],
    { o: { calls: [1, 1, 0], reads: 2, loaders: 1, loads: 1, recovery: ["served"], ...noSharedWrites }, compression: ["decompressed"] }),
  rule("untracked-compressed-recovery-does-not-warm-local", "untrackedCompressedRecoveryDoesNotWarmLocalTest",
    [init(0), seed(8), begin(0), read, reject, load, begin(1)],
    { o: { calls: [1, 0], reads: 2, loaders: 1, loads: 1, recovery: ["served"], ...noSharedWrites }, compression: ["decompressed"] }),
  rule("corrupt-compressed-recovery-keeps-original-error", "corruptCompressedRecoveryKeepsOriginalSourceErrorTest",
    [init(), seed(9), begin(0), read, reject, load],
    { o: { calls: [3], reads: 1, loaders: 1, loads: 1, recovery: ["deserialization_error"], ...noSharedWrites },
      io: { sourceErrors: [1] }, compression: ["fallback_raw"] }),
  rule("compressed-recovery-crossing-maximum-keeps-original-error", "compressedRecoveryRechecksMaximumAfterDecodeTest",
    [init(), seed(12), begin(0), read, reject, advance(1), load],
    { o: { calls: [3], reads: 1, loaders: 1, loads: 1, recovery: ["miss"], ...noSharedWrites },
      io: { sourceErrors: [1] }, compression: ["decompressed"] }),
  rule("retained-compressed-recovery-survives-fence-new-request-misses", "retainedCompressedRecoverySurvivesInvalidationTest",
    [init(), seed(8), begin(0), read, invalidate, reject, load, begin(0), begin(1), read, reject],
    { o: { calls: [1, 1, 3], reads: 2, loaders: 2, loads: 1, recovery: ["served", "miss"], ...noSharedWrites },
      io: { sourceErrors: [0, 0, 2] }, compression: ["decompressed"] }),
  rule("closed-request-recovery-keeps-new-request-cold", "closedRequestCannotReceiveCompressedRecoveryTest",
    [init(), seed(8), begin(0), read, reject, command("closeScope", 0), load, begin(1)],
    { o: { calls: [1, 0], reads: 2, loaders: 1, loads: 1, recovery: ["served"], ...noSharedWrites } }),
  rule("tracked-source-requires-validation-before-local-reuse", "trackedSourceNeedsRemoteValidationBeforeLocalReuseTest",
    [init(), begin(0), read, resolve, begin(0), begin(1), read, load, begin(2)],
    { o: { calls: [2, 2, 2, 2], reads: 2, loaders: 1, loads: 1, dumps: 1, writes: 1 } }),
  rule("ordinary-value-work-preserves-absent-marker", "ordinaryValueWorkDoesNotCreateMarkerTest",
    [init(), marker, begin(2), read, resolve, marker, begin(2), read, load, marker],
    { o: { calls: [2, 2], reads: 2, loaders: 1, loads: 1, writes: 1 },
      markers: [{ cutoffMs: -1, ttlMs: -2 }, { cutoffMs: -1, ttlMs: -2 }, { cutoffMs: -1, ttlMs: -2 }] }),
  rule("ordinary-value-work-preserves-marker-cutoff-and-expiry", "ordinaryValueWorkDoesNotExtendMarkerTest",
    [init(), invalidate, marker, advance(1), policy(2), begin(2), read, resolve, marker, begin(2), read, load, advance(999), marker],
    { o: { calls: [2, 2], reads: 2, loaders: 1, loads: 1, writes: 1, writeTtls: [3_600_000] },
      markers: [{ cutoffMs: 0, ttlMs: 7_200_000 }, { cutoffMs: 0, ttlMs: 7_199_999 }, { cutoffMs: 0, ttlMs: 7_199_000 }] }),
  rule("failed-maintenance-preserves-existing-marker", "failedInvalidationPreservesExistingMarkerTest",
    [init(), invalidate, marker, advance(1000), command("writeFault", 1), invalidate, marker],
    { o: { invalidations: 2, maintenance: ["ok", "mutation_error"] },
      markers: [{ cutoffMs: 0, ttlMs: 7_200_000 }, { cutoffMs: 0, ttlMs: 7_199_000 }] }),
  rule("failed-maintenance-preserves-absent-marker", "failedInvalidationDoesNotCreateMarkerTest",
    [init(), command("writeFault", 1), invalidate, marker],
    { o: { invalidations: 1, maintenance: ["mutation_error"] }, markers: [{ cutoffMs: -1, ttlMs: -2 }] }),
  rule("fresh-compressed-hit-reports-decompression", "freshCompressedReadReportsDecompressionTest",
    [init(), seed(13), begin(0), read, load],
    { o: { calls: [1], reads: 1, loaders: 0, loads: 1, ...noSharedWrites }, compression: ["decompressed"] }),
  rule("corrupt-compressed-read-reports-fallback-with-source-result", "corruptCompressedReadReportsRawFallbackTest",
    [init(), seed(14), begin(0), read, load, resolve],
    { o: { calls: [2], reads: 1, loaders: 1, loads: 1, dumps: 1, writes: 1 }, compression: ["fallback_raw"] }),

  rule("retained-snapshot-survives-physical-expiry-new-read-misses", "retainedSnapshotSurvivesPhysicalExpiryTest",
    [init(), seed(15), begin(0), read, advance(1000), reject, load, begin(1), read, reject],
    { o: { calls: [1, 3], reads: 2, loaders: 2, loads: 1, recovery: ["served", "miss"], ...noSharedWrites },
      io: { sourceErrors: [0, 2] } }),
  rule("unsafe-timestamp-skips-serializer-and-refills", "unsafeTimestampSkipsSerializerAndAllowsRefillTest",
    [init(), seed(16), begin(0), read, resolve, begin(1), read, load],
    { o: { calls: [2, 2], reads: 2, loaders: 1, loads: 1, dumps: 1, writes: 1 } }),
  rule("unsupported-version-skips-serializer-and-refills", "unsupportedVersionSkipsSerializerAndAllowsRefillTest",
    [init(), seed(17), begin(0), read, resolve, begin(1), read, load],
    { o: { calls: [2, 2], reads: 2, loaders: 1, loads: 1, dumps: 1, writes: 1 } }),
  rule("maximum-before-decode-preserves-original-error-without-load", "maximumAgeBeforeDecodeKeepsOriginalErrorTest",
    [init(), seed(12), begin(0), read, advance(1), reject],
    { o: { calls: [3], reads: 1, loaders: 1, loads: 0, recovery: ["miss"], ...noSharedWrites },
      io: { sourceErrors: [1] }, compression: [] }),
  rule("later-invalidation-keeps-captured-miss-fence-new-read-fences-write", "laterInvalidationDoesNotRewriteObservedMissFenceTest",
    [init(), begin(0), read, invalidate, resolve, begin(1), read, reject],
    { o: { calls: [2, 3], reads: 2, loaders: 2, loads: 0, dumps: 1, writes: 1, recovery: ["miss"] },
      io: { sourceErrors: [0, 2] } }),

];

function decoded(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decoded);
  if (value === null || typeof value !== "object") return value;
  const object = record(value, "recovery-read witness");
  if (Object.hasOwn(object, "#bigint")) {
    const text = object["#bigint"];
    if (Object.keys(object).length !== 1 || typeof text !== "string" || !/^-?\d+$/.test(text)
        || !Number.isSafeInteger(Number(text))) throw new Error("Invalid witness integer");
    return Number(text);
  }
  return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, decoded(item)]));
}
function contains(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== "object" || Array.isArray(expected)) {
    return JSON.stringify(actual) === JSON.stringify(expected);
  }
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
  return Object.entries(expected).every(([key, value]) => contains((actual as Record<string, unknown>)[key], value));
}

export function recoveryReadWitnesses(paths: readonly string[]): Set<string> {
  const seen = new Set<string>();
  for (const path of paths) {
    const raw = record(JSON.parse(readFileSync(path, "utf8")), path);
    if (!Array.isArray(raw.states)) throw new Error("Missing recovery-read witness states");
    const commands: string[] = [];
    const observations = raw.states.map(rawState => {
      const state = record(rawState, path);
      const input = record(decoded(state.input), path);
      if (typeof input.name !== "string" || typeof input.choice !== "number") throw new Error("Missing explicit witness input");
      commands.push(command(input.name, input.choice));
      const value = record(state.s, path);
      // Read only public observations. Private model predictions are irrelevant
      // to a schedule's claim, and cannot make an absent consequence count.
      return decoded({ o: value.o, io: value.io, markers: value.markers, compression: value.compression });
    });
    for (const rule of recoveryReadWitnessRules) {
      if (commands.length < rule.commands.length) continue;
      if (!rule.commands.every((value, index) => value === commands[index])) continue;
      if (contains(observations[rule.commands.length - 1], rule.outcome)) seen.add(rule.name);
    }
  }
  return seen;
}
