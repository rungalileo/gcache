import { publicPrefixWitnesses, publicPrefixRule as rule, publicCheckpoint as check, witnessCommand as command,
  type PublicPrefixWitnessRule } from "./public-prefix-witnesses.js";

const init = (mode: number) => command("init", mode);
const begin = (kind: number) => command("beginCall", kind);
const policy = (index: number) => command("releasePolicy", index);
const resolve = (choice: number) => command("resolveLoader", choice);
const advance = (ms: number) => command("advance", ms);

export const sourceBudgetsWitnessRules: readonly PublicPrefixWitnessRule[] = [
  rule("outside-calls-skip-source-deadlines-sharing-and-publication", "outsideAndInvalidOutsideCallsIgnoreDeadlineAndSharingTest",
    [init(2), begin(1), begin(3), advance(100), resolve(1), resolve(4), begin(0), policy(0)],
    check(3, { calls: [0, 0], policyCalls: 0, loaders: 2, reads: 0, writes: 0 }),
    check(5, { calls: [1, 2], policyCalls: 0, loaders: 2 }),
    check(7, { calls: [1, 2, 0], policyCalls: 1, loaders: 3, reads: 0, writes: 0 })),
  rule("default-source-budget-expires-at-sixty-seconds", "defaultSourceBudgetExpiresAtSixtySecondsTest",
    [init(0), begin(0), policy(0), advance(59_999), advance(1), resolve(1), begin(0), policy(1)],
    check(3, { calls: [0], loaders: 1 }),
    check(4, { calls: [4], loaders: 1 }),
    check(7, { calls: [4, 0], loaders: 2, writes: 0 })),
  rule("unbounded-enabled-source-publishes-after-sixty-seconds", "unboundedEnabledSourcePublishesAfterSixtySecondsTest",
    [init(1), begin(0), policy(0), advance(60_001), resolve(1), begin(0), policy(1)],
    check(3, { calls: [0], loaders: 1 }),
    check(6, { calls: [1, 1], loaders: 1, policyCalls: 2 })),
  rule("late-follower-keeps-leaders-remaining-source-budget", "lateFollowerUsesLeadersRemainingBudgetTest",
    [init(2), begin(0), policy(0), advance(6), begin(0), policy(1), advance(3), advance(1)],
    check(5, { calls: [0, 0], loaders: 1, policyCalls: 2 }),
    check(6, { calls: [0, 0], loaders: 1 }),
    check(7, { calls: [4, 4], loaders: 1 })),
  rule("policy-wait-does-not-spend-source-budget", "heldPolicyDoesNotSpendSourceBudgetTest",
    [init(2), begin(0), advance(100), policy(0), advance(9), resolve(1), begin(0), policy(1)],
    check(2, { calls: [0], loaders: 0, policyCalls: 1 }),
    check(4, { calls: [0], loaders: 1 }),
    check(7, { calls: [1, 1], loaders: 1, policyCalls: 2 })),
  rule("invalid-enabled-key-preserves-source-deadline", "invalidKeyStillKeepsEnabledSourceDeadlineTest",
    [init(2), begin(2), advance(9), advance(1), resolve(1), begin(0), policy(0)],
    check(2, { calls: [0], loaders: 1, policyCalls: 0 }),
    check(3, { calls: [4], loaders: 1, policyCalls: 0 }),
    check(6, { calls: [4, 0], loaders: 2, policyCalls: 1 })),
  rule("abandoned-source-cannot-replace-successful-retry", "abandonedSourceCannotReplaceSuccessfulRetryTest",
    [init(2), begin(0), policy(0), advance(10), begin(0), policy(1), resolve(4), resolve(1), begin(0), policy(2)],
    check(3, { calls: [4], loaders: 1 }),
    check(6, { calls: [4, 2], loaders: 2 }),
    check(7, { calls: [4, 2], loaders: 2 }),
    check(9, { calls: [4, 2, 2], loaders: 2, policyCalls: 3 })),
];

export function sourceBudgetsWitnesses(paths: readonly string[]): Set<string> {
  return publicPrefixWitnesses(paths, sourceBudgetsWitnessRules);
}
