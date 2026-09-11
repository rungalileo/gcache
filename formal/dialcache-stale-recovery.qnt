module dialcache_stale_recovery {
  import cache_rules.* from "./cache-rules"
  // Stale-on-error for one Redis frame and one caller/coalesced flight.
  // F is the fresh ceiling; M is the exclusive recovery ceiling. Recovery uses
  // retained bytes from the initial read and deliberately has no second read.
  // Selected rules from C40-C45. Time ranges from 0 through MAX_TIME; source deadlines
  // and independent callers are covered by conformance profiles. frame* fields
  // describe the environment; candidate* fields retain the acquired snapshot
  // and observation times. Later environment changes cannot rewrite that history.

  // Types, bounds and state

  type InitialRead = ReadPending | FreshHit | RetainedCandidate | PlainMiss | ReadFailed
  type SourceState = SourceIdle | SourceRunning | SourceSucceeded | SourceRejected
  type RecoveryState =
    RecoveryIdle | ClassifierDenied | CandidateChecking |
    CandidateLoading | RecoveryServed | RecoveryMissed
  type FinalOutcome = PendingOutcome | ServedFresh | ServedSource | ServedStale | RejectedSource

  pure val FRESH_AGE = 2
  pure val MAX_RECOVERY_AGE = 5
  pure val MAX_TIME = 8

  type State = {
    now: int,
    framePresent: bool,
    frameCreatedAt: int,
    frameValid: bool,
    frameFenced: bool,
    readHealthy: bool,
    initialRead: InitialRead,
    candidateRetained: bool,
    candidateCreatedAt: int,
    candidateRetainedAt: int,
    candidateServedAt: int,
    redisReads: int,
    sourceState: SourceState,
    classifierAllows: bool,
    recoveryState: RecoveryState,
    candidateDecoded: bool,
    redisWrites: int,
    processLocalWrites: int,
    requestLocalWrites: int,
    shadowJobs: int,
    finalOutcome: FinalOutcome
  }

  var s: State

  // Transition predicates. Retention requires F <= age < M; a later recovery
  // check only requires a nonfuture candidate younger than M.
  val initialFrameUsable =
    s.framePresent and s.frameValid and not(s.frameFenced) and s.frameCreatedAt <= s.now
  val freshAtInitialRead =
    s.readHealthy and initialFrameUsable and freshAgeAllowed(s.frameCreatedAt, s.now, FRESH_AGE)
  val candidateAtInitialRead =
    s.readHealthy and initialFrameUsable and
      retainedAgeAllowed(s.frameCreatedAt, s.now, FRESH_AGE, MAX_RECOVERY_AGE)
  val candidateWithinRecoveryAge =
    recoveryAgeAllowed(s.candidateCreatedAt, s.now, MAX_RECOVERY_AGE)

  // Initial state
  action init = s' = {
    now: 0,
    framePresent: false,
    frameCreatedAt: 0,
    frameValid: true,
    frameFenced: false,
    readHealthy: true,
    initialRead: ReadPending,
    candidateRetained: false,
    candidateCreatedAt: 0,
    candidateRetainedAt: 0,
    candidateServedAt: 0,
    redisReads: 0,
    sourceState: SourceIdle,
    classifierAllows: false,
    recoveryState: RecoveryIdle,
    candidateDecoded: false,
    redisWrites: 0,
    processLocalWrites: 0,
    requestLocalWrites: 0,
    shadowJobs: 0,
    finalOutcome: PendingOutcome
  }

  // Environment transitions
  action advanceTime = all {
    s.now < MAX_TIME,
    s' = { now: s.now + 1, ...s },
  }

  // Wall rollback affects candidate age but does not rewrite acquisition time.
  action rollbackWall = all {
    s.now > 0,
    s' = { now: s.now - 1, ...s },
  }

  action seedFrameNow = all {
    s.initialRead == ReadPending,
    s.redisReads == 0,
    s' = { framePresent: true, frameCreatedAt: s.now, ...s },
  }

  action makeFrameOlder = all {
    s.initialRead == ReadPending,
    s.redisReads == 0,
    s.framePresent,
    s.frameCreatedAt > 0,
    s' = { frameCreatedAt: s.frameCreatedAt - 1, ...s },
  }

  action seedFutureFrame = all {
    s.initialRead == ReadPending,
    s.redisReads == 0,
    s' = { framePresent: true, frameCreatedAt: s.now + 1, ...s },
  }

  action toggleFrameValidity = all {
    s.initialRead == ReadPending,
    s.redisReads == 0,
    s' = { frameValid: not(s.frameValid), ...s },
  }

  action toggleFence = all {
    s.initialRead == ReadPending,
    s.redisReads == 0,
    s' = { frameFenced: not(s.frameFenced), ...s },
  }

  action toggleReadHealth = all {
    s.initialRead == ReadPending,
    s.redisReads == 0,
    s' = { readHealthy: not(s.readHealthy), ...s },
  }

  action toggleClassifier = all {
    s.sourceState != SourceSucceeded,
    s.recoveryState == RecoveryIdle,
    s' = { classifierAllows: not(s.classifierAllows), ...s },
  }

  // Read acquisition, source settlement and recovery
  // Freshness is classified before ordinary deserialization. Only a valid,
  // unfenced, non-future frame with F <= age < M is retained as a candidate.
  action performInitialRead = all {
    s.initialRead == ReadPending,
    s.redisReads == 0,
    s' = {
      redisReads: 1,
      candidateRetainedAt: s.now,
      initialRead: if (not(s.readHealthy))
        ReadFailed
      else if (not(initialFrameUsable))
        PlainMiss
      else if (freshAgeAllowed(s.frameCreatedAt, s.now, FRESH_AGE))
        FreshHit
      else if (recoveryAgeAllowed(s.frameCreatedAt, s.now, MAX_RECOVERY_AGE))
        RetainedCandidate
      else
        PlainMiss,
      candidateRetained: candidateAtInitialRead,
      candidateCreatedAt: if (candidateAtInitialRead) s.frameCreatedAt else s.candidateCreatedAt,
      finalOutcome: if (freshAtInitialRead) ServedFresh else s.finalOutcome,
      ...s
    },
  }

  action startSource = all {
    s.initialRead != ReadPending,
    s.initialRead != FreshHit,
    s.sourceState == SourceIdle,
    s' = { sourceState: SourceRunning, ...s },
  }

  // A successful source path never needs to deserialize retained stale bytes.
  action sourceSucceeds = all {
    s.sourceState == SourceRunning,
    s' = {
      sourceState: SourceSucceeded,
      finalOutcome: ServedSource,
      redisWrites: if (s.initialRead == ReadFailed) 0 else 1,
      ...s
    },
  }

  action sourceRejects = all {
    s.sourceState == SourceRunning,
    s' = {
      sourceState: SourceRejected,
      recoveryState:
        if (s.initialRead == ReadFailed) RecoveryIdle
        else if (s.classifierAllows) CandidateChecking
        else ClassifierDenied,
      finalOutcome:
        if (s.classifierAllows and s.initialRead != ReadFailed) s.finalOutcome
        else RejectedSource,
      ...s
    },
  }

  action checkCandidate = all {
    s.recoveryState == CandidateChecking,
    s' = {
      recoveryState: if (s.candidateRetained and candidateWithinRecoveryAge)
        CandidateLoading
      else
        RecoveryMissed,
      finalOutcome: if (s.candidateRetained and candidateWithinRecoveryAge)
        s.finalOutcome
      else
        RejectedSource,
      ...s
    },
  }

  // Loading/decompression may take application-owned time, so age is checked
  // again after it settles. Exact M is already too old.
  action candidateLoadSucceeds = all {
    s.recoveryState == CandidateLoading,
    s' = {
      candidateDecoded: true,
      candidateServedAt: s.now,
      recoveryState: if (candidateWithinRecoveryAge)
        RecoveryServed
      else
        RecoveryMissed,
      finalOutcome: if (candidateWithinRecoveryAge)
        ServedStale
      else
        RejectedSource,
      requestLocalWrites: if (candidateWithinRecoveryAge)
        s.requestLocalWrites + 1
      else
        s.requestLocalWrites,
      ...s
    },
  }

  action candidateLoadFails = all {
    s.recoveryState == CandidateLoading,
    s' = { recoveryState: RecoveryMissed, finalOutcome: RejectedSource, ...s },
  }

  // Retained bytes live in process memory. Later Redis deletion/invalidation
  // cannot revoke that original candidate and recovery still performs no re-read.
  action mutateRedisAfterRetention = all {
    s.candidateRetained,
    s' = { framePresent: not(s.framePresent), frameFenced: true, ...s },
  }

  // Exploration order
  action step = any {
    advanceTime,
    rollbackWall,
    seedFrameNow,
    seedFutureFrame,
    makeFrameOlder,
    toggleFrameValidity,
    toggleFence,
    toggleReadHealth,
    toggleClassifier,
    performInitialRead,
    startSource,
    sourceSucceeds,
    sourceRejects,
    checkCandidate,
    candidateLoadSucceeds,
    candidateLoadFails,
    mutateRedisAfterRetention,
  }

  // Invariants: the age obligations are independent of transition predicates.
  val recoveryUsesSingleRedisRead =
    s.redisReads <= 1

  val retainedCandidateWasEligible =
    not(s.candidateRetained) or
      (s.frameValid and s.initialRead == RetainedCandidate and
       s.candidateRetainedAt - s.candidateCreatedAt >= FRESH_AGE and
       s.candidateRetainedAt - s.candidateCreatedAt < MAX_RECOVERY_AGE)

  // This is a property of the return event. Later time movement cannot revoke
  // an already returned value; using `now` here incorrectly required that.
  val servedStaleIsStrictlyWithinMaxAge =
    s.finalOutcome != ServedStale or
      (s.candidateCreatedAt <= s.candidateServedAt and
       s.candidateServedAt - s.candidateCreatedAt < MAX_RECOVERY_AGE)

  val staleRequiresAuthorizedSourceFailure =
    s.finalOutcome != ServedStale or
      (s.sourceState == SourceRejected and s.classifierAllows)

  val sourceSuccessDoesNotDecodeCandidate =
    s.sourceState != SourceSucceeded or not(s.candidateDecoded)

  val recoveredStaleHasNoSharedPublication =
    s.finalOutcome != ServedStale or
      (s.redisWrites == 0 and s.processLocalWrites == 0 and s.shadowJobs == 0)

  val readFailureNeverRetains =
    s.initialRead != ReadFailed or not(s.candidateRetained)

  val readFailureNeverAttemptsRecovery =
    s.initialRead != ReadFailed or s.recoveryState == RecoveryIdle

  // Deterministic regressions
  run servedValueCanAgeTest = init
    .then(seedFrameNow).then(advanceTime).then(advanceTime)
    .then(performInitialRead).then(toggleClassifier).then(startSource)
    .then(sourceRejects).then(checkCandidate).then(candidateLoadSucceeds)
    .expect(s.finalOutcome == ServedStale)
    .then(advanceTime).then(advanceTime).then(advanceTime)
    .expect(s.now - s.candidateCreatedAt == MAX_RECOVERY_AGE)
    .expect(servedStaleIsStrictlyWithinMaxAge)

  run decodingAtMaxAgeRejectsTest = init
    .then(seedFrameNow).then(advanceTime).then(advanceTime)
    .then(performInitialRead).then(toggleClassifier).then(startSource)
    .then(sourceRejects).then(checkCandidate)
    .then(advanceTime).then(advanceTime).then(advanceTime)
    .then(candidateLoadSucceeds)
    .expect(s.finalOutcome == RejectedSource and s.requestLocalWrites == 0)

  run futureFrameIsNotRetainedTest = init
    .then(seedFutureFrame).then(performInitialRead)
    .expect(s.initialRead == PlainMiss and not(s.candidateRetained))

  run failedReadSkipsRecoveryTest = init.then(toggleReadHealth).then(performInitialRead)
    .then(toggleClassifier).then(startSource).then(sourceRejects)
    .expect(s.finalOutcome == RejectedSource and s.recoveryState == RecoveryIdle)


  // These examples distinguish acquisition eligibility from recovery eligibility.
  // A rollback may make retained bytes fresh again; only future age or M rejects.
  action retainedFixture = init.then(seedFrameNow)
    .then(advanceTime).then(advanceTime).then(performInitialRead)

  run lastFreshAgeSkipsSourceTest = init.then(seedFrameNow).then(advanceTime)
    .then(performInitialRead)
    .expect(s.finalOutcome == ServedFresh and not(s.candidateRetained)
      and s.sourceState == SourceIdle and s.redisReads == 1)

  run firstStaleAgeRetainsWithoutDecodingTest = retainedFixture
    .expect(s.initialRead == RetainedCandidate and s.candidateRetained
      and not(s.candidateDecoded) and s.finalOutcome == PendingOutcome)

  run lastRecoveryAgeStillServesTest = retainedFixture
    .then(advanceTime).then(advanceTime).then(toggleClassifier)
    .then(startSource).then(sourceRejects).then(checkCandidate)
    .then(candidateLoadSucceeds)
    .expect(s.candidateServedAt - s.candidateCreatedAt == MAX_RECOVERY_AGE - 1
      and s.finalOutcome == ServedStale and s.redisWrites == 0
      and s.processLocalWrites == 0 and s.requestLocalWrites == 1)

  run exactMaximumAgeDoesNotRetainTest = init.then(seedFrameNow)
    .then(advanceTime).then(advanceTime).then(advanceTime)
    .then(advanceTime).then(advanceTime).then(performInitialRead)
    .then(toggleClassifier).then(startSource).then(sourceRejects).then(checkCandidate)
    .expect(not(s.candidateRetained) and not(s.candidateDecoded)
      and s.finalOutcome == RejectedSource and s.redisReads == 1)

  run invalidFrameNeverBecomesRecoveryCandidateTest = init.then(seedFrameNow)
    .then(advanceTime).then(advanceTime).then(toggleFrameValidity)
    .then(performInitialRead).then(toggleClassifier).then(startSource)
    .then(sourceRejects).then(checkCandidate)
    .expect(not(s.candidateRetained) and not(s.candidateDecoded)
      and s.finalOutcome == RejectedSource)

  // Rejected initial bytes cannot become a candidate just because their age
  // becomes acceptable later. These histories distinguish initial retention
  // from an implementation that retains everything and checks only at failure.
  run initiallyTooOldCannotRecoverAfterRollbackTest = init.then(seedFrameNow)
    .then(advanceTime).then(advanceTime).then(advanceTime).then(advanceTime).then(advanceTime)
    .then(performInitialRead).then(rollbackWall).then(toggleClassifier)
    .then(startSource).then(sourceRejects).then(checkCandidate)
    .expect(s.now - s.frameCreatedAt == MAX_RECOVERY_AGE - 1
      and not(s.candidateRetained) and not(s.candidateDecoded)
      and s.finalOutcome == RejectedSource and s.redisReads == 1)

  run initiallyFutureCannotRecoverAfterClockAdvanceTest = init.then(seedFutureFrame)
    .then(performInitialRead).then(advanceTime).then(advanceTime).then(advanceTime)
    .then(toggleClassifier).then(startSource).then(sourceRejects).then(checkCandidate)
    .expect(s.now - s.frameCreatedAt == FRESH_AGE
      and not(s.candidateRetained) and not(s.candidateDecoded)
      and s.finalOutcome == RejectedSource and s.redisReads == 1)

  run fencedFrameNeverBecomesRecoveryCandidateTest = init.then(seedFrameNow)
    .then(advanceTime).then(advanceTime).then(toggleFence)
    .then(performInitialRead).then(toggleClassifier).then(startSource)
    .then(sourceRejects).then(checkCandidate)
    .expect(not(s.candidateRetained) and not(s.candidateDecoded)
      and s.finalOutcome == RejectedSource)

  run acceptedSourceNeverDecodesRetainedBytesTest = retainedFixture
    .then(startSource).then(sourceSucceeds)
    .expect(s.finalOutcome == ServedSource and not(s.candidateDecoded)
      and s.redisReads == 1 and s.redisWrites == 1)

  run deniedRecoveryNeverDecodesRetainedBytesTest = retainedFixture
    .then(startSource).then(sourceRejects)
    .expect(s.finalOutcome == RejectedSource and not(s.candidateDecoded)
      and s.redisWrites == 0 and s.requestLocalWrites == 0)

  run maximumAgeBeforeDecodeSkipsLoadingTest = retainedFixture
    .then(toggleClassifier).then(startSource).then(sourceRejects)
    .then(advanceTime).then(advanceTime).then(advanceTime).then(checkCandidate)
    .expect(s.recoveryState == RecoveryMissed and not(s.candidateDecoded)
      and s.finalOutcome == RejectedSource and s.requestLocalWrites == 0)

  run recoveryDecodeFailureKeepsSourceOutcomeTest = retainedFixture
    .then(toggleClassifier).then(startSource).then(sourceRejects)
    .then(checkCandidate).then(candidateLoadFails)
    .expect(s.finalOutcome == RejectedSource and s.redisReads == 1
      and s.redisWrites == 0 and s.requestLocalWrites == 0)

  run retainedBytesSurviveRedisDeletionAndFenceTest = retainedFixture
    .then(mutateRedisAfterRetention).then(toggleClassifier).then(startSource)
    .then(sourceRejects).then(checkCandidate).then(candidateLoadSucceeds)
    .expect(not(s.framePresent) and s.frameFenced and s.finalOutcome == ServedStale
      and s.redisReads == 1 and s.redisWrites == 0 and s.processLocalWrites == 0)

  run rollbackBelowFreshAgeStillRecoversTest = retainedFixture
    .then(toggleClassifier).then(startSource).then(sourceRejects)
    .then(checkCandidate).then(rollbackWall).then(candidateLoadSucceeds)
    .expect(s.candidateServedAt - s.candidateCreatedAt == FRESH_AGE - 1
      and s.finalOutcome == ServedStale and s.requestLocalWrites == 1)

  run rollbackToFutureCandidateRejectsTest = init.then(advanceTime).then(seedFrameNow)
    .then(advanceTime).then(advanceTime).then(performInitialRead)
    .then(toggleClassifier).then(startSource).then(sourceRejects).then(checkCandidate)
    .then(rollbackWall).then(rollbackWall).then(rollbackWall).then(candidateLoadSucceeds)
    .expect(s.now < s.candidateCreatedAt and s.finalOutcome == RejectedSource
      and s.requestLocalWrites == 0)
}
