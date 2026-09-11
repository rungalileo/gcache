import { publicPrefixWitnesses, publicPrefixRule as rule, publicCheckpoint as check, witnessCommand as command,
  type PublicPrefixWitnessRule } from "./public-prefix-witnesses.js";

const init = command("init");
const begin = (scope: number) => command("beginCall", scope);
const resolve = (value: number) => command("resolveLoader", value);
const fault = (enabled: number) => command("localFault", enabled);
const remoteOff = command("policy", 0);

export const localFailureWitnessRules: readonly PublicPrefixWitnessRule[] = [
  rule("failed-local-read-preserves-old-value-and-memoizes-remote", "localReadFailureFallsThroughAndPreservesOldLocalTest",
    [init, begin(2), resolve(1), command("seed", 2), fault(1), begin(0), fault(0), begin(2), begin(0)],
    check(2, { calls: [1], loaders: 1, reads: 1, writes: 1 }),
    check(5, { calls: [1, 2], loaders: 1, reads: 2, loads: 1, writes: 1 }),
    check(8, { calls: [1, 2, 1, 2], loaders: 1, reads: 2, writes: 1 })),
  rule("failed-local-read-suppresses-later-source-publication", "localReadFailureSkipsSourcePublicationButMemoizesTest",
    [init, begin(2), resolve(1), remoteOff, fault(1), begin(0), fault(0), resolve(2), begin(2), begin(0)],
    check(5, { calls: [1, 0], loaders: 2, reads: 1, writes: 1 }),
    // The fault is cleared before success. The old value must survive because
    // the invocation retained its failed-read disposition, not a second fault.
    check(7, { calls: [1, 2], loaders: 2, reads: 1, writes: 1 }),
    check(9, { calls: [1, 2, 1, 2], loaders: 2, reads: 1, writes: 1 })),
  rule("failed-local-write-keeps-result-and-request-memo", "localWriteFailureKeepsSourceAndRequestMemoTest",
    [init, begin(0), fault(1), resolve(1), fault(0), remoteOff, begin(0), begin(2), resolve(2), begin(2)],
    check(3, { calls: [1], loaders: 1, writes: 1 }),
    check(7, { calls: [1, 1, 0], loaders: 2, reads: 1, writes: 1 }),
    check(9, { calls: [1, 1, 2, 2], loaders: 2, reads: 1, writes: 1 })),
  rule("rejected-source-preserves-previous-local-publication", "sourceFailureKeepsPreviouslyAcceptedStorageTest",
    [init, begin(2), resolve(1), remoteOff, fault(1), begin(0), command("rejectLoader"), fault(0), begin(2)],
    check(2, { calls: [1], writes: 1 }),
    check(6, { calls: [1, 3], loaders: 2, writes: 1 }),
    check(8, { calls: [1, 3, 1], loaders: 2, reads: 1, writes: 1 })),
];

export function localFailureWitnesses(paths: readonly string[]): Set<string> {
  return publicPrefixWitnesses(paths, localFailureWitnessRules);
}
