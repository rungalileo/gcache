import { publicPrefixWitnesses, publicPrefixRule as rule, publicCheckpoint as check, witnessCommand as command,
  type PublicPrefixWitnessRule } from "./public-prefix-witnesses.js";

const init = (fixture: number) => command("init", fixture);
const seed = command("seed", 1), begin = command("beginCall"), read = command("releaseRead");
const resolve = command("resolveLoader", 2), load = command("releaseLoad");
const rollback = command("rollbackWall");
const mismatch = { calls: [2], reads: 2, loads: 1, writes: 0, comparisons: 1, shadow: ["mismatch"] };
const futureShadow = [{ layer: "remote_shadow", offsetMs: 1000 }];

export const shadowDiagnosticsWitnessRules: readonly PublicPrefixWitnessRule[] = [
  rule("omitted-shadow-logging-keeps-mismatch-metrics-only", "omittedLoggingKeepsMismatchMetricsOnlyTest",
    [init(2), seed, begin, read, resolve, load, read],
    check(6, mismatch, { warnings: 0, configErrors: 0, ages: [0], futureOffsets: [] })),
  rule("explicit-false-shadow-logging-overrides-enabled-default", "explicitFalseLoggingOverridesEnabledDefaultTest",
    [init(6), command("logPolicy", 0), seed, begin, read, resolve, load, read],
    check(7, mismatch, { warnings: 0, configErrors: 0, ages: [0], futureOffsets: [] })),
  rule("shadow-confirmation-past-freshness-preserves-payload-and-age", "confirmationPastFreshnessKeepsOriginalPayloadAndAgeTest",
    [init(6), seed, begin, read, resolve, load, command("advanceWall", 60_000), read],
    check(5, { calls: [2], reads: 2, loads: 1, writes: 0, shadow: [] }, { warnings: 0, ages: [] }),
    check(7, mismatch, { warnings: 1, ages: [60_000], futureOffsets: [] })),
  rule("shadow-confirmation-rollback-keeps-payload-and-reports-offset", "confirmationRollbackKeepsPayloadAndClampsAgeTest",
    [init(6), seed, begin, read, resolve, load, rollback, read],
    check(5, { calls: [2], reads: 2, loads: 1, writes: 0, shadow: [] }, { warnings: 0, ages: [], futureOffsets: [] }),
    check(7, mismatch, { warnings: 1, ages: [0], futureOffsets: futureShadow })),
  rule("future-dark-c0-reports-offset-and-fills-semantic-miss", "futureDarkAcquisitionReportsOffsetAndFillsMissTest",
    [init(0), seed, rollback, begin, read, resolve, command("releaseDump"), command("releaseWrite")],
    check(4, { calls: [0], reads: 1, loads: 0, dumps: 0, shadow: [] }, { futureOffsets: futureShadow }),
    check(7, { calls: [2], reads: 1, loads: 0, dumps: 1, writes: 1, shadow: ["filled"] },
      { warnings: 0, ages: [], futureOffsets: futureShadow })),
  rule("late-dark-read-reports-offset-without-reviving-job", "futureLateDarkReadKeepsTimeoutAndReportsOffsetTest",
    [init(0), seed, rollback, begin, command("advance", 10), read],
    check(4, { calls: [4], shadow: ["timeout"], reads: 1 }, { futureOffsets: [] }),
    check(5, { calls: [4], shadow: ["timeout"], reads: 1, loads: 0, dumps: 0, writes: 0 },
      { futureOffsets: [{ layer: "remote_shadow", offsetMs: 990 }] })),
];

export function shadowDiagnosticsWitnesses(paths: readonly string[]): Set<string> {
  return publicPrefixWitnesses(paths, shadowDiagnosticsWitnessRules);
}
