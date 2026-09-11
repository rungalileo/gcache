module dialcache_tracked_invalidation {
  import cache_rules.* from "./cache-rules"
  // One invalidation entity and one tracked Redis value. Reads atomically
  // snapshot value + watermark; later invalidation cannot revoke that snapshot.
  // Selected rules from C33 and C35-C36. Mutation/invalidation share a model step.
  // The finite time bound and stale-write/clock-lead assumptions below are part
  // of the claim. Watermark expiry, Redis failures and multiple entities are
  // covered elsewhere. value* describes external storage; snapshot* is the
  // caller's acquired observation, not a live alias of that storage.

  // Types, bounds and state

  type ReadPhase = ReadIdle | ReadAcquired | ReadServed | ReadMissed

  pure val MAX_TIME = 8
  pure val FUTURE_BUFFER_MS = 4
  pure val MAX_STALE_WRITE_DELAY_MS = 3
  pure val MAX_WRITER_CLOCK_LEAD_MS = 1

  pure val bufferCoversStaleWrites =
    FUTURE_BUFFER_MS >= MAX_STALE_WRITE_DELAY_MS + MAX_WRITER_CLOCK_LEAD_MS

  type State = {
    now: int,
    sourceVersion: int,
    mutationCommitted: bool,
    invalidatedAt: int,
    watermark: int,
    valuePresent: bool,
    valueCreatedAt: int,
    valueSourceVersion: int,
    loadInFlight: bool,
    loadSourceVersion: int,
    readPhase: ReadPhase,
    snapshotPresent: bool,
    snapshotCreatedAt: int,
    snapshotSourceVersion: int,
    snapshotWatermark: int
  }

  var s: State

  // Initial state
  action init = s' = {
    now: 0,
    sourceVersion: 0,
    mutationCommitted: false,
    invalidatedAt: 0,
    watermark: 0,
    valuePresent: false,
    valueCreatedAt: 0,
    valueSourceVersion: 0,
    loadInFlight: false,
    loadSourceVersion: 0,
    readPhase: ReadIdle,
    snapshotPresent: false,
    snapshotCreatedAt: 0,
    snapshotSourceVersion: 0,
    snapshotWatermark: 0
  }

  // Environment time, source work and invalidation
  action advanceTime = all {
    s.now < MAX_TIME,
    s' = { now: s.now + 1, ...s },
  }

  action startLoad = all {
    not(s.loadInFlight),
    s' = { loadInFlight: true, loadSourceVersion: s.sourceVersion, ...s },
  }

  // Source mutation commits before invalidation. We collapse those adjacent
  // application operations into one transition and keep the watermark monotonic.
  action commitAndInvalidate = all {
    not(s.mutationCommitted),
    s' = {
      mutationCommitted: true,
      sourceVersion: s.sourceVersion + 1,
      invalidatedAt: s.now,
      watermark: if (s.watermark > s.now + FUTURE_BUFFER_MS)
        s.watermark
      else
        s.now + FUTURE_BUFFER_MS,
      ...s
    },
  }

  // A source read captures its version at start. Pre-mutation work may write
  // after invalidation only within the documented stale-work delay assumption.
  action completeLoadWrite = all {
    s.loadInFlight,
    or {
      s.loadSourceVersion == s.sourceVersion,
      and {
        s.mutationCommitted,
        s.loadSourceVersion < s.sourceVersion,
        s.now <= s.invalidatedAt + MAX_STALE_WRITE_DELAY_MS,
      },
    },
    s' = {
      valuePresent: true,
      valueCreatedAt: s.now + MAX_WRITER_CLOCK_LEAD_MS,
      valueSourceVersion: s.loadSourceVersion,
      loadInFlight: false,
      ...s
    },
  }

  // Atomic acquisition and subsequent consumption
  action acquireTrackedRead = all {
    s.readPhase == ReadIdle,
    s' = {
      snapshotPresent: s.valuePresent,
      snapshotCreatedAt: s.valueCreatedAt,
      snapshotSourceVersion: s.valueSourceVersion,
      snapshotWatermark: s.watermark,
      readPhase: ReadAcquired,
      ...s
    },
  }

  // Acceptance is deliberately strict: createdAtMs > observed watermarkMs.
  action finishTrackedRead = all {
    s.readPhase == ReadAcquired,
    s' = {
      readPhase: if (s.snapshotPresent and fenceAllows(s.snapshotCreatedAt, s.snapshotWatermark))
        ReadServed
      else
        ReadMissed,
      ...s
    },
  }

  action resetRead = all {
    s.readPhase != ReadIdle,
    s.readPhase != ReadAcquired,
    s' = { readPhase: ReadIdle, ...s },
  }

  // Refill uses only the watermark observed by the original atomic miss. If the
  // proposed timestamp cannot clear it, no value mutation occurs and no re-read
  // is performed.
  action conditionalRefill = all {
    s.readPhase == ReadMissed,
    not(s.loadInFlight),
    s' = {
      valuePresent: if (not(fenceAllows(s.now + MAX_WRITER_CLOCK_LEAD_MS, s.snapshotWatermark)))
        s.valuePresent else true,
      valueCreatedAt: if (not(fenceAllows(s.now + MAX_WRITER_CLOCK_LEAD_MS, s.snapshotWatermark)))
        s.valueCreatedAt else s.now + MAX_WRITER_CLOCK_LEAD_MS,
      valueSourceVersion: if (not(fenceAllows(s.now + MAX_WRITER_CLOCK_LEAD_MS, s.snapshotWatermark)))
        s.valueSourceVersion else s.sourceVersion,
      readPhase: ReadIdle,
      ...s
    },
  }

  // Exploration order
  action step = any {
    advanceTime,
    startLoad,
    commitAndInvalidate,
    completeLoadWrite,
    acquireTrackedRead,
    finishTrackedRead,
    resetRead,
    conditionalRefill,
  }

  // Invariants
  val servedSnapshotClearedObservedFence =
    s.readPhase != ReadServed or
      (s.snapshotPresent and s.snapshotCreatedAt > s.snapshotWatermark)

  val staleValueAfterInvalidationIsFenced =
    not(bufferCoversStaleWrites) or
    not(s.mutationCommitted) or
    not(s.valuePresent) or
    s.valueSourceVersion >= s.sourceVersion or
    s.valueCreatedAt <= s.watermark

  val acquiredAfterInvalidationDoesNotServeStale =
    s.readPhase != ReadServed or
    s.snapshotWatermark < s.watermark or
    s.snapshotSourceVersion >= s.sourceVersion


  // Acquiring bytes and consuming them are separate from the shared store.
  run acquiredSnapshotSurvivesLaterInvalidationTest = init.then(startLoad)
    .then(completeLoadWrite).then(acquireTrackedRead).then(commitAndInvalidate)
    .then(finishTrackedRead)
    .expect(s.readPhase == ReadServed and s.snapshotSourceVersion == 0
      and s.sourceVersion == 1 and s.snapshotWatermark == 0 and s.watermark == 4)

  run acquisitionAfterInvalidationRejectsOldBytesTest = init.then(startLoad)
    .then(completeLoadWrite).then(commitAndInvalidate).then(acquireTrackedRead)
    .then(finishTrackedRead)
    .expect(s.readPhase == ReadMissed and s.snapshotCreatedAt <= s.snapshotWatermark)

  // At the last permitted stale completion, writer clock lead reaches the
  // watermark exactly. The strict comparison still excludes the old version.
  run staleWriteAtCoveredDelayEqualityRemainsFencedTest = init.then(startLoad)
    .then(commitAndInvalidate).then(advanceTime).then(advanceTime).then(advanceTime)
    .then(completeLoadWrite).then(acquireTrackedRead).then(finishTrackedRead)
    .expect(s.valueSourceVersion == 0 and s.valueCreatedAt == s.watermark
      and s.readPhase == ReadMissed and staleValueAfterInvalidationIsFenced)

  run freshWriteBeyondBufferBecomesReadableTest = init.then(commitAndInvalidate)
    .then(advanceTime).then(advanceTime).then(advanceTime).then(advanceTime)
    .then(startLoad).then(completeLoadWrite).then(acquireTrackedRead).then(finishTrackedRead)
    .expect(s.readPhase == ReadServed and s.valueSourceVersion == 1
      and s.valueCreatedAt > s.watermark)

  run readsAndValueWritesDoNotMoveWatermarkTest = init.then(commitAndInvalidate)
    .then(startLoad).then(completeLoadWrite).then(acquireTrackedRead).then(finishTrackedRead)
    .expect(s.watermark == FUTURE_BUFFER_MS)

  run observedFutureFenceSkipsRefillTest = init.then(commitAndInvalidate)
    .then(acquireTrackedRead).then(finishTrackedRead).then(conditionalRefill)
    .expect(not(s.valuePresent) and s.watermark == FUTURE_BUFFER_MS)

  run refillAtFenceEqualitySkipsWriteTest = init.then(commitAndInvalidate)
    .then(acquireTrackedRead).then(finishTrackedRead)
    .then(advanceTime).then(advanceTime).then(advanceTime).then(conditionalRefill)
    .expect(not(s.valuePresent) and s.watermark == FUTURE_BUFFER_MS)

  // A new fence is not substituted for the one captured by a miss. The write
  // can proceed, but the next authoritative read rejects its fenced timestamp.
  run laterInvalidationDoesNotRewriteMissFenceTest = init.then(acquireTrackedRead)
    .then(finishTrackedRead).then(commitAndInvalidate).then(conditionalRefill)
    .expect(s.valuePresent and s.snapshotWatermark == 0 and s.valueCreatedAt <= s.watermark)
    .then(acquireTrackedRead).then(finishTrackedRead)
    .expect(s.readPhase == ReadMissed)
}
