module cache_rules {
  // Canonical transition judgments for C09/C23-C26/C33-C34/C40/C45.
  // These definitions consume normalized policy and acquired timestamps. They
  // do not validate wire frames, choose a clock, or decide who owns a snapshot.
  // Callers supply times in one common unit. Wall-clock age can be negative;
  // elapsed clocks are monotonic. Assertions independently restate obligations.

  // Fresh reads and retained recovery both reject future values. Recovery has
  // no fresh-age lower bound: wall rollback may make retained bytes fresh again.
  pure def ageBeforeCeiling(created: int, observed: int, ceiling: int): bool =
    created <= observed and observed - created < ceiling
  pure def freshAgeAllowed(created: int, observed: int, fresh: int): bool =
    ageBeforeCeiling(created, observed, fresh)
  pure def recoveryAgeAllowed(created: int, observed: int, maximum: int): bool =
    ageBeforeCeiling(created, observed, maximum)

  // Classify an initially stale candidate: F <= age < M. A profile may also
  // retain bytes for fresh decoding. Later recovery uses the acquired maximum
  // and timestamp, not current storage or a new policy reply.
  pure def retainedAgeAllowed(created: int, observed: int, fresh: int, maximum: int): bool =
    recoveryAgeAllowed(created, observed, maximum) and observed - created >= fresh

  // Local hits never renew insertion expiry. Fractional environment time is
  // projected on the common whole-millisecond grid before computing local age.
  pure def localEntryLiveAt(observed: int, expires: int): bool = observed < expires
  pure def localEntryLiveOnGrid(observedTicks: int, insertedTicks: int, ttlMs: int, ticksPerMs: int): bool =
    localEntryLiveAt(observedTicks / ticksPerMs, insertedTicks / ticksPerMs + ttlMs)

  // Negative budget is the canonical unbounded representation. Profiles with
  // other sentinel codes normalize them here; finite zero is already expired.
  // The source begins after policy/cache lookup. Equality belongs to timeout.
  pure def deadlinePendingAt(observed: int, deadline: int): bool = observed < deadline
  pure def sourceAcceptsAt(started: int, settled: int, budget: int): bool =
    budget < 0 or deadlinePendingAt(settled, started + budget)

  // A missing watermark is normalized to zero. Timestamp validity, primary
  // atomicity and marker lifetime remain explicit responsibilities of callers.
  pure def fenceAllows(created: int, watermark: int): bool = created > watermark
}
