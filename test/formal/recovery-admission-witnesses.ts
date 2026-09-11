import { publicPrefixWitnesses, publicPrefixRule as rule, publicCheckpoint as check, witnessCommand as command,
  type PublicPrefixWitnessRule } from "./public-prefix-witnesses.js";

const init = command("init", 2), begin = command("beginCall", 0);
const read = command("releaseRead"), reject = command("rejectLoader"), load = command("releaseLoad");
const noShadow = { shadow: [], dumps: 0, writes: 0 };

// Mode 2 supplies a selected shadow policy, an outcome hook and available job
// capacity. Source/read counts distinguish skipped diagnostic admission from a
// detached job that simply has not emitted its outcome yet.
export const recoveryAdmissionWitnessRules: readonly PublicPrefixWitnessRule[] = [
  rule("recovered-absence-skips-selected-shadow-and-memoizes", "recoveredAbsenceSkipsSelectedShadowTest",
    [init, command("seed", 18), begin, read, reject, load, begin,
      command("beginCall", 1), read, reject, load],
    check(5, { calls: [5], reads: 1, loaders: 1, loads: 1, classifications: 1, recovery: ["served"], ...noShadow }),
    check(6, { calls: [5, 5], reads: 1, loaders: 1, loads: 1, classifications: 1, recovery: ["served"], ...noShadow }),
    check(10, { calls: [5, 5, 5], reads: 2, loaders: 2, loads: 2, classifications: 2,
      recovery: ["served", "served"], ...noShadow })),
  rule("recovered-value-skips-selected-shadow-and-memoizes", "recoveredValueSkipsSelectedShadowTest",
    [init, command("seed", 2), begin, read, reject, load, begin],
    check(5, { calls: [1], reads: 1, loaders: 1, loads: 1, classifications: 1, recovery: ["served"], ...noShadow }),
    check(6, { calls: [1, 1], reads: 1, loaders: 1, loads: 1, classifications: 1, recovery: ["served"], ...noShadow })),
];

export function recoveryAdmissionWitnesses(paths: readonly string[]): Set<string> {
  return publicPrefixWitnesses(paths, recoveryAdmissionWitnessRules);
}
