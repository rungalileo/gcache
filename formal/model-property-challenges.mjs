// Compiling semantic faults, checked against independent model obligations.
// This reviewed sample does not measure a percentage of all possible defects.
export const modelPropertyChallenges = [
  {
    "id": "source-deadline-epoch",
    "contract": "C23",
    "source": "formal/dialcache-flight-deadlines.qnt",
    "model": "formal/dialcache-flight-deadlines.qnt",
    "invariant": "fallbackDeadlineStartsWithFallback",
    "before": "fallbackDeadline: s.now + FALLBACK_TIMEOUT,",
    "after": "fallbackDeadline: FALLBACK_TIMEOUT,"
  },
  {
    "id": "recovery-inclusive-maximum",
    "contract": "C45",
    "source": "formal/cache-rules.qnt",
    "model": "formal/dialcache-rule-checks.qnt",
    "invariant": "recoveryBoundaryIsExclusive",
    "before": "created <= observed and observed - created < ceiling",
    "after": "created <= observed and observed - created <= ceiling"
  },
  {
    "id": "recovery-future-candidate",
    "contract": "C45",
    "source": "formal/cache-rules.qnt",
    "model": "formal/dialcache-rule-checks.qnt",
    "invariant": "recoveryBoundaryIsExclusive",
    "before": "created <= observed and observed - created < ceiling",
    "after": "observed - created < ceiling"
  },
  {
    "id": "legacy-recovery-inclusive-maximum",
    "contract": "C45",
    "source": "formal/cache-rules.qnt",
    "model": "formal/dialcache-recovery-conformance.qnt",
    "invariant": "recoveredValueWasWithinAcceptedAge",
    "before": "created <= observed and observed - created < ceiling",
    "after": "created <= observed and observed - created <= ceiling"
  },
  {
    "id": "policy-inclusive-local-expiry",
    "contract": "C09",
    "source": "formal/dialcache-policy-conformance.qnt",
    "model": "formal/dialcache-policy-conformance.qnt",
    "invariant": "localHitsRespectInsertionExpiry",
    "before": "val localHit = localEligible and localEntryLiveAt(s.now, s.localExpires)",
    "after": "val localHit = localEligible and s.now <= s.localExpires"
  },
  {
    "id": "local-precise-grid",
    "contract": "C09",
    "source": "formal/cache-rules.qnt",
    "model": "formal/dialcache-rule-checks.qnt",
    "invariant": "localGridUsesWholeMilliseconds",
    "before": "localEntryLiveAt(observedTicks / ticksPerMs, insertedTicks / ticksPerMs + ttlMs)",
    "after": "observedTicks - insertedTicks < ttlMs * ticksPerMs"
  },
  {
    "id": "source-inclusive-deadline",
    "contract": "C25",
    "source": "formal/cache-rules.qnt",
    "model": "formal/dialcache-rule-checks.qnt",
    "invariant": "sourceBoundaryIsExclusive",
    "before": "pure def deadlinePendingAt(observed: int, deadline: int): bool = observed < deadline",
    "after": "pure def deadlinePendingAt(observed: int, deadline: int): bool = observed <= deadline"
  },
  {
    "id": "fence-inclusive-timestamp",
    "contract": "C33",
    "source": "formal/cache-rules.qnt",
    "model": "formal/dialcache-rule-checks.qnt",
    "invariant": "fenceBoundaryIsExclusive",
    "before": "pure def fenceAllows(created: int, watermark: int): bool = created > watermark",
    "after": "pure def fenceAllows(created: int, watermark: int): bool = created >= watermark"
  },
  {
    "id": "profile-source-wrong-clock",
    "contract": "C23",
    "source": "formal/dialcache-source-budgets-conformance.qnt",
    "model": "formal/dialcache-source-connection.qnt",
    "invariant": "sourceOriginsMatchContract",
    "before": "rawPending: true, result: CALL_PENDING, started: x.now, settled: -1,",
    "after": "rawPending: true, result: CALL_PENDING, started: 0, settled: -1,"
  },
  {
    "id": "profile-source-wrong-owner",
    "contract": "C24",
    "source": "formal/dialcache-source-budgets-conformance.qnt",
    "model": "formal/dialcache-source-connection.qnt",
    "invariant": "sourceOwnersMatchContract",
    "before": "owners: x.owners.replaceAt(call, source),",
    "after": "owners: x.owners.replaceAt(call, 0),"
  },
  {
    "id": "profile-recovery-wrong-snapshot",
    "contract": "C44",
    "source": "formal/dialcache-recovery-read-conformance.qnt",
    "model": "formal/dialcache-recovery-connection.qnt",
    "invariant": "retainedSnapshotMatchesAcquisition",
    "before": "candidateCreated: s.created,",
    "after": "candidateCreated: s.created + 1,"
  },
  {
    "id": "recovery-read-wrong-admission-policy",
    "contract": "C45",
    "source": "formal/dialcache-recovery-read-conformance.qnt",
    "model": "formal/dialcache-recovery-connection.qnt",
    "invariant": "retainedSnapshotMatchesAcquisition",
    "before": "scope: context, acceptedFresh: s.freshMs, acceptedMaximum: s.maximumMs,",
    "after": "scope: context, acceptedFresh: s.freshMs, acceptedMaximum: s.maximumMs + 1,"
  },
  {
    "id": "legacy-recovery-wrong-snapshot",
    "contract": "C44",
    "source": "formal/dialcache-recovery-conformance.qnt",
    "model": "formal/dialcache-legacy-recovery-connection.qnt",
    "invariant": "flightKeepsAcquiredSnapshot",
    "before": "candidateCreated: s.created,",
    "after": "candidateCreated: s.created + 1,"
  },
  {
    "id": "independent-wrong-admission-policy",
    "contract": "C45",
    "source": "formal/dialcache-independent-conformance.qnt",
    "model": "formal/dialcache-independent-connection.qnt",
    "invariant": "independentSnapshotsMatchAcquisition",
    "before": "source: NO_SOURCE, phase: READ_PENDING, maxAge: x.maxAge,",
    "after": "source: NO_SOURCE, phase: READ_PENDING, maxAge: SHORT_RETENTION_MS,"
  },
  {
    "id": "independent-wrong-recovered-value",
    "contract": "C43",
    "source": "formal/dialcache-independent-conformance.qnt",
    "model": "formal/dialcache-independent-connection.qnt",
    "invariant": "independentRecoveryMatchesContract",
    "before": "call.error else load.value)",
    "after": "call.error else VALUE_TWO)"
  },
  {
    "id": "effects-source-wrong-clock",
    "contract": "C23",
    "source": "formal/dialcache-effects-conformance.qnt",
    "model": "formal/dialcache-effects-connection.qnt",
    "invariant": "effectsDeadlineMatchesSourceStart",
    "before": "activeLoader: x.sources.length(), deadline: x.now + SOURCE_BUDGET_MS,",
    "after": "activeLoader: x.sources.length(), deadline: SOURCE_BUDGET_MS,"
  },
  {
    "id": "effects-wrong-acceptance-receipt",
    "contract": "C25",
    "source": "formal/dialcache-effects-conformance.qnt",
    "model": "formal/dialcache-effects-connection.qnt",
    "invariant": "effectsPublicationMatchesAcceptedSource",
    "before": "acceptedAt: s.now, acceptedWall: s.wall,",
    "after": "acceptedAt: s.now + 1, acceptedWall: s.wall,"
  },
  {
    "id": "legacy-recovery-strands-followers",
    "contract": "C24",
    "source": "formal/dialcache-recovery-conformance.qnt",
    "model": "formal/dialcache-legacy-recovery-connection.qnt",
    "invariant": "flightRecoveryMatchesContract",
    "before": "...finishPendingCalls(s.o, result)",
    "after": "...{ calls: s.o.calls.replaceAt(s.o.calls.indices().filter(i => s.o.calls.nth(i) == CALL_PENDING).fold(s.o.calls.length(), (first, i) => if (i < first) i else first), result), ...s.o }"
  },
  {
    "id": "independent-source-wrong-clock",
    "contract": "C23",
    "source": "formal/dialcache-independent-conformance.qnt",
    "model": "formal/dialcache-independent-connection.qnt",
    "invariant": "independentSourceOriginsMatchContract",
    "before": "startedAt: x.now, settledAt: -1, outcome: CALL_PENDING }),\n    timers: x.timers.append({ read: false, index: x.sources.length(), at: x.now + SOURCE_BUDGET_MS }),",
    "after": "startedAt: 0, settledAt: -1, outcome: CALL_PENDING }),\n    timers: x.timers.append({ read: false, index: x.sources.length(), at: SOURCE_BUDGET_MS }),"
  },
  {
    "id": "independent-source-wrong-owner",
    "contract": "C24",
    "source": "formal/dialcache-independent-conformance.qnt",
    "model": "formal/dialcache-independent-connection.qnt",
    "invariant": "independentSourceOriginsMatchContract",
    "before": "sources: x.sources.append({ caller: caller, active: true, pending: true,",
    "after": "sources: x.sources.append({ caller: 0, active: true, pending: true,"
  },
  {
    "id": "tracked-read-inclusive-fence",
    "contract": "C33",
    "source": "formal/cache-rules.qnt",
    "model": "formal/dialcache-tracked-invalidation.qnt",
    "invariant": "servedSnapshotClearedObservedFence",
    "before": "pure def fenceAllows(created: int, watermark: int): bool = created > watermark",
    "after": "pure def fenceAllows(created: int, watermark: int): bool = created >= watermark"
  },
  {
    "id": "policy-inclusive-remote-freshness",
    "contract": "C22",
    "source": "formal/dialcache-policy-conformance.qnt",
    "model": "formal/dialcache-policy-conformance.qnt",
    "invariant": "remoteHitsRespectAcquiredFreshness",
    "before": "remoteEligible and freshAgeAllowed(s.remoteCreated.nth(s.key), s.wall, remoteTtl)",
    "after": "remoteEligible and s.remoteCreated.nth(s.key) <= s.wall and s.wall - s.remoteCreated.nth(s.key) <= remoteTtl"
  },
  {
    "id": "shadow-inclusive-c0-freshness",
    "contract": "C49",
    "source": "formal/dialcache-shadow-conformance.qnt",
    "model": "formal/dialcache-shadow-conformance.qnt",
    "invariant": "c0AcquisitionsRespectFreshness",
    "before": "val acquired = if (freshAgeAllowed(s.created, s.wall, FRESHNESS_MS)) snapshot else NO_PAYLOAD",
    "after": "val acquired = if (s.created <= s.wall and s.wall - s.created <= FRESHNESS_MS) snapshot else NO_PAYLOAD"
  }
];
