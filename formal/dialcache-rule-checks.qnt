module dialcache_rule_checks {
  import cache_rules.* from "./cache-rules"

  // Finite symbolic checks of the shared judgments, not an implementation or a
  // whole-cache refinement proof. Each step chooses another independent case.
  // Integer clock units are arbitrary; grid examples use ten ticks per ms.
  type Case = {
    created: int, observed: int, fresh: int, maximum: int,
    started: int, settled: int, budget: int, expires: int, watermark: int
  }
  var c: Case
  var actual: { fresh: bool, recovery: bool, retained: bool, local: bool, grid: bool, source: bool, fence: bool }

  action classify(input: Case): bool = all {
    c' = input,
    actual' = {
      fresh: freshAgeAllowed(input.created, input.observed, input.fresh),
      recovery: recoveryAgeAllowed(input.created, input.observed, input.maximum),
      retained: retainedAgeAllowed(input.created, input.observed, input.fresh, input.maximum),
      local: localEntryLiveAt(input.observed, input.expires),
      grid: localEntryLiveOnGrid(input.observed * 10 + 6, (input.created + 1) * 10 + 7, input.fresh, 10),
      source: sourceAcceptsAt(input.started, input.settled, input.budget),
      fence: fenceAllows(input.created, input.watermark)
    }
  }
  action init = {
    nondet created = (-1).to(3).oneOf()
    nondet observed = 0.to(6).oneOf()
    nondet fresh = 1.to(3).oneOf()
    nondet maximum = 2.to(5).oneOf()
    nondet started = 0.to(3).oneOf()
    nondet settled = 0.to(7).oneOf()
    nondet budget = Set(-1, 0, 1, 3).oneOf()
    nondet expires = 0.to(6).oneOf()
    nondet watermark = 0.to(3).oneOf()
    classify({ created: created, observed: observed, fresh: fresh, maximum: maximum,
      started: started, settled: settled, budget: budget, expires: expires, watermark: watermark })
  }
  action step = init

  // Each assertion states the contract directly; none calls its transition helper.
  val freshBoundaryIsExclusive = actual.fresh == (c.created <= c.observed and c.observed - c.created < c.fresh)
  val recoveryBoundaryIsExclusive = actual.recovery == (c.created <= c.observed and c.observed - c.created < c.maximum)
  val retentionStartsAtFreshBoundary = actual.retained ==
    (c.created <= c.observed and c.observed - c.created >= c.fresh and c.observed - c.created < c.maximum)
  val localBoundaryIsExclusive = actual.local == (c.observed < c.expires)
  val localGridUsesWholeMilliseconds = actual.grid == (c.observed - (c.created + 1) < c.fresh)
  val sourceBoundaryIsExclusive = actual.source == (c.budget < 0 or c.settled - c.started < c.budget)
  val fenceBoundaryIsExclusive = actual.fence == (c.created > c.watermark)

  run exactBoundariesRejectTest = classify({ created: 0, observed: 3, fresh: 3, maximum: 3,
    started: 0, settled: 3, budget: 3, expires: 3, watermark: 0 })
    .expect(not(actual.fresh) and not(actual.recovery) and not(actual.local)
      and not(actual.source) and not(actual.fence))
  run rollbackCanRecoverRetainedBytesTest = classify({ created: 1, observed: 2, fresh: 3, maximum: 5,
    started: 0, settled: 7, budget: -1, expires: 3, watermark: 0 })
    .expect(actual.fresh and actual.recovery and not(actual.retained) and actual.source)
  run futureAgeRejectsTest = classify({ created: 3, observed: 2, fresh: 3, maximum: 5,
    started: 0, settled: 0, budget: 0, expires: 3, watermark: 0 })
    .expect(not(actual.fresh) and not(actual.recovery) and not(actual.source))
}
