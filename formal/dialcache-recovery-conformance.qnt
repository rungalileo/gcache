module dialcache_recovery_conformance {
  import conformance_observations.* from "./conformance-observations"
  import cache_rules.* from "./cache-rules"
  // Model boundary -----------------------------------------------------------
  // One registered tracked remote flight, with coalesced callers in two optional
  // request lifetimes. Selected aspects of C40-C46 cover retained recovery;
  // C03/C43 cover request publication; C57/C58 cover age and error observations.
  // See BEHAVIOR.md: "Generated feature profiles" and its recovery input table.
  // Reads/publication settle at action boundaries; decoding and sources may wait.
  // No local storage, independent same-key flights, or shadow work participates.
  // `now` is elapsed milliseconds and `wall` is the application clock. Retained
  // bytes, accepted age policy, and source error belong to the original flight.

  // Trace encodings and fixture bounds ---------------------------------------
  // Keep integer fields stable; shared caller results come from the import.
  pure val IDLE = 0
  pure val FRESH_DECODE = 1
  pure val SOURCE_RUNNING = 2
  pure val RECOVERY_DECODE = 3
  pure val SOURCE_REGISTERED = 0
  pure val SOURCE_ABANDONED = 1
  pure val SOURCE_SETTLED = 2
  pure val CLASSIFIER_ALLOW = 0
  pure val CLASSIFIER_DENY = 1
  pure val CLASSIFIER_ERROR = 2
  pure val CLASSIFIER_TIMEOUT_ONLY = 3
  pure val CLASSIFIER_INHERIT = 3
  pure val SETTLEMENT_SUCCESS = 0
  pure val SETTLEMENT_FAILURE = 1
  pure val SETTLEMENT_PROPAGATED_TIMEOUT = 2
  pure val FRESH_AGE_MS = 1000
  pure val SOURCE_BUDGET_MS = 10
  pure val WALL_ROLLBACK_MS = 1000
  pure val MAX_CALLS = 8

  // State: observed history, remote environment, and flight-owned snapshots.
  type State = {
    o: Observation, d: Diagnostics,
    now: int, wall: int, phase: int,
    frame: int, created: int, expires: int, watermark: int,
    candidate: int, candidateCreated: int, maxAge: int, acceptedMaxAge: int,
    classifier: int, instanceClassifier: int, readFailed: bool, loadFailed: bool,
    canRecover: bool, canWrite: bool, observedFence: int,
    request: bool, memo: List[int], closed: List[bool], attached: List[bool],
    sources: List[int], activeLoader: int, deadline: int, sourceError: int,
    recoveryReceipts: List[{ created: int, accepted: int, maximum: int }]
  }
  var s: State
  // Public commands, separate from the state that predicts their consequences.
  var input: { name: str, choice: int }

  // Initial fixture ----------------------------------------------------------
  action initialize(choice: int): bool = all {
    (0.to(7)).contains(choice),
    input' = { name: "init", choice: choice },
    s' = {
      o: empty, d: noDiagnostics,
      now: 10000, wall: 100000, phase: IDLE,
      frame: VALUE_ONE, created: 99000, expires: 70000, watermark: 0,
      candidate: 0, candidateCreated: 0, maxAge: 5000, acceptedMaxAge: 5000,
      classifier: CLASSIFIER_ALLOW,
      instanceClassifier: List(
        CLASSIFIER_TIMEOUT_ONLY, CLASSIFIER_ALLOW, CLASSIFIER_DENY, CLASSIFIER_ERROR
      ).nth(choice % 4),
      readFailed: false, loadFailed: false,
      canRecover: false, canWrite: false, observedFence: 0,
      request: choice >= 4, memo: List(0, 0),
      closed: List(false, false), attached: List(false, false),
      sources: List(), activeLoader: 0, deadline: 0, sourceError: SOURCE_ERROR,
      recoveryReceipts: List()
    }
  }
  action init = {
    nondet choice = 0.to(7).oneOf()
    initialize(choice)
  }

  // Read classification and request admission --------------------------------
  val readable = not(s.readFailed) and s.frame > 0 and s.now < s.expires and fenceAllows(s.created, s.watermark)
  val eligible = readable and recoveryAgeAllowed(s.created, s.wall, s.maxAge)
  val fresh = eligible and freshAgeAllowed(s.created, s.wall, FRESH_AGE_MS)
  pure def candidateValid(x: State): bool = x.candidate > 0 and
    recoveryAgeAllowed(x.candidateCreated, x.wall, x.acceptedMaxAge)

  pure def memoized(x: State, value: int): State = {
    memo: if (x.request and (value == VALUE_ONE or value == VALUE_TWO))
      x.memo.indices().fold(x.memo, (published, scope) =>
        if (x.attached.nth(scope) and not(x.closed.nth(scope)))
          published.replaceAt(scope, value)
        else published)
      else x.memo,
    ...x
  }
  def admitted(scope: int, policy: int): State =
    if (s.request and s.memo.nth(scope) > 0) {
      o: { calls: s.o.calls.append(s.memo.nth(scope)), policyCalls: s.o.policyCalls + 1, ...s.o },
      ...s
    } else {
      attached: List(false, false).replaceAt(scope, true),
      o: {
        calls: s.o.calls.append(CALL_PENDING), policyCalls: s.o.policyCalls + 1,
        reads: s.o.reads + 1, loads: s.o.loads + (if (fresh) 1 else 0),
        loaders: s.o.loaders + (if (fresh) 0 else 1),
        ...s.o
      },
      phase: if (fresh) FRESH_DECODE else SOURCE_RUNNING,
      classifier: if (policy == CLASSIFIER_INHERIT) s.instanceClassifier else policy,
      candidate: if (eligible) s.frame else 0, candidateCreated: s.created,
      acceptedMaxAge: s.maxAge, canRecover: not(s.readFailed), canWrite: not(s.readFailed),
      observedFence: if (readable) 0 else s.watermark,
      sources: if (fresh) s.sources else s.sources.append(SOURCE_REGISTERED),
      activeLoader: if (fresh) s.activeLoader else s.sources.length(),
      deadline: s.now + SOURCE_BUDGET_MS, sourceError: SOURCE_ERROR,
      ...s
    }
  action beginWith(choice: int): bool = all {
    (0.to(7).filter(code => not(s.closed.nth(code / 4)))).contains(choice),
    input' = { name: "beginCall", choice: choice },
    s.phase == IDLE, s.o.calls.length() < MAX_CALLS,
    s' = admitted(choice / 4, choice % 4)
  }
  action beginCall = {
    nondet choice = 0.to(7).filter(code => not(s.closed.nth(code / 4))).oneOf()
    beginWith(choice)
  }
  def joined(scope: int): State = {
    val memo = if (s.request) s.memo.nth(scope) else 0
    val joinScope = if (s.request and s.attached.nth(scope)) "request_local" else "process"
    {
      attached: if (memo > 0) s.attached else s.attached.replaceAt(scope, true),
      d: { coalesced: if (memo > 0) s.d.coalesced else s.d.coalesced.append(joinScope), ...s.d },
      o: { calls: s.o.calls.append(memo), policyCalls: s.o.policyCalls + 1, ...s.o },
      ...s
    }
  }
  action joinWith(choice: int): bool = all {
    (0.to(1).filter(scope => not(s.closed.nth(scope)))).contains(choice),
    input' = { name: "joinCall", choice: choice },
    all { s.phase != IDLE, s.o.calls.length() < MAX_CALLS, s' = joined(choice) }
  }
  action joinCall = {
    nondet choice = 0.to(1).filter(scope => not(s.closed.nth(scope))).oneOf()
    joinWith(choice)
  }
  action closeWith(choice: int): bool = all {
    (0.to(1).filter(scope => not(s.closed.nth(scope)))).contains(choice),
    input' = { name: "closeScope", choice: choice },
    s.request, s.o.calls.length() > 0,
    s' = {
      closed: s.closed.replaceAt(choice, true), memo: s.memo.replaceAt(choice, 0),
      attached: s.attached.replaceAt(choice, false),
      ...s
    }
  }
  action closeScope = {
    nondet choice = 0.to(1).filter(scope => not(s.closed.nth(scope))).oneOf()
    closeWith(choice)
  }

  // Source settlement and retained recovery ----------------------------------
  pure def rejected(x: State, error: int, timeout: bool): State = {
    val mayRecover = x.canRecover and
      (x.classifier == CLASSIFIER_ALLOW or (x.classifier == CLASSIFIER_TIMEOUT_ONLY and timeout))
    val mayDecode = mayRecover and candidateValid(x)
    {
      d: { fallbackErrors: x.d.fallbackErrors.append("remote"), ...x.d },
      phase: if (mayDecode) RECOVERY_DECODE else IDLE, sourceError: error,
      o: {
        classifications: x.o.classifications +
          (if (x.canRecover and x.classifier != CLASSIFIER_TIMEOUT_ONLY) 1 else 0),
        loads: x.o.loads + (if (mayDecode) 1 else 0),
        recovery: if (mayRecover and not(mayDecode)) x.o.recovery.append("miss") else x.o.recovery,
        ...finishPendingCalls(x.o, if (mayDecode) CALL_PENDING else error)
      },
      ...x
    }
  }
  def settled(index: int, failure: int): State = {
    val sourceSettled = { sources: s.sources.replaceAt(index, SOURCE_SETTLED), ...s }
    val mayWrite = s.canWrite and fenceAllows(s.wall, s.observedFence)
    if (s.sources.nth(index) == SOURCE_ABANDONED) sourceSettled
    else if (failure > SETTLEMENT_SUCCESS)
      rejected(sourceSettled, SOURCE_ERROR, failure == SETTLEMENT_PROPAGATED_TIMEOUT)
    else {
      phase: IDLE,
      o: {
        dumps: s.o.dumps + (if (mayWrite) 1 else 0), writes: s.o.writes + (if (mayWrite) 1 else 0),
        writeTtls: if (mayWrite) s.o.writeTtls.append(s.acceptedMaxAge) else s.o.writeTtls,
        ...finishPendingCalls(s.o, VALUE_TWO)
      },
      frame: if (mayWrite) VALUE_TWO else s.frame,
      created: if (mayWrite) s.wall else s.created,
      expires: if (mayWrite) s.now + s.acceptedMaxAge else s.expires,
      ...memoized(sourceSettled, VALUE_TWO)
    }
  }
  action resolveWith(choice: int): bool = all {
    (s.sources.indices().filter(i => s.sources.nth(i) != SOURCE_SETTLED)).contains(choice),
    input' = { name: "resolveLoader", choice: choice },
    s' = settled(choice, SETTLEMENT_SUCCESS)
  }
  action resolveLoader = {
    nondet choice = s.sources.indices().filter(i => s.sources.nth(i) != SOURCE_SETTLED).oneOf()
    resolveWith(choice)
  }
  action rejectWith(choice: int): bool = all {
    (s.sources.indices().filter(i => s.sources.nth(i) != SOURCE_SETTLED)).contains(choice),
    input' = { name: "rejectLoader", choice: choice },
    s' = settled(choice, SETTLEMENT_FAILURE)
  }
  action rejectLoader = {
    nondet choice = s.sources.indices().filter(i => s.sources.nth(i) != SOURCE_SETTLED).oneOf()
    rejectWith(choice)
  }
  action rejectTimeoutWith(choice: int): bool = all {
    (s.sources.indices().filter(i => s.sources.nth(i) != SOURCE_SETTLED)).contains(choice),
    input' = { name: "rejectTimeout", choice: choice },
    s' = settled(choice, SETTLEMENT_PROPAGATED_TIMEOUT)
  }
  action rejectTimeout = {
    nondet choice = s.sources.indices().filter(i => s.sources.nth(i) != SOURCE_SETTLED).oneOf()
    rejectTimeoutWith(choice)
  }
  action releaseLoad = all {
    input' = { name: "releaseLoad", choice: -1 },
    s.phase == FRESH_DECODE or s.phase == RECOVERY_DECODE,
    val recovered = not(s.loadFailed) and candidateValid(s)
    val retry = s.phase == FRESH_DECODE and s.loadFailed
    val result = if (retry) CALL_PENDING else if (s.phase == FRESH_DECODE or recovered) s.candidate else s.sourceError
    s' = {
      recoveryReceipts: if (s.phase == RECOVERY_DECODE and recovered)
        s.recoveryReceipts.append({ created: s.candidateCreated, accepted: s.wall, maximum: s.acceptedMaxAge })
        else s.recoveryReceipts,
      memo: memoized(s, result).memo,
      d: if (s.phase == RECOVERY_DECODE and recovered)
        { ages: s.d.ages.append(s.wall - s.candidateCreated), ...s.d }
        else s.d,
      phase: if (retry) SOURCE_RUNNING else IDLE, canRecover: if (retry) false else s.canRecover,
      sources: if (retry) s.sources.append(SOURCE_REGISTERED) else s.sources,
      activeLoader: if (retry) s.sources.length() else s.activeLoader,
      deadline: if (retry) s.now + SOURCE_BUDGET_MS else s.deadline,
      o: {
        loaders: s.o.loaders + (if (retry) 1 else 0),
        recovery: if (s.phase == FRESH_DECODE) s.o.recovery else s.o.recovery.append(
          if (s.loadFailed) "deserialization_error" else if (recovered) "served" else "miss"),
        ...finishPendingCalls(s.o, result)
      },
      ...s
    }
  }

  // Environmental storage, clocks, policy, and faults -------------------------
  action seedWith(choice: int): bool = all {
    (0.to(6)).contains(choice),
    input' = { name: "seed", choice: choice },
    val age = List(0, 999, 1000, 4999, 5000, -1, 1000).nth(choice)
    s' = {
      frame: if (choice == 6) VALUE_TWO else VALUE_ONE,
      created: s.wall - age, expires: s.now + 60000,
      ...s
    }
  }
  action seed = {
    nondet choice = 0.to(6).oneOf()
    seedWith(choice)
  }
  action advanceBy(choice: int): bool = all {
    (Set(1, 10, 1000, 4000)).contains(choice),
    input' = { name: "advance", choice: choice },
    val timedOut = if (s.phase == SOURCE_RUNNING and not(deadlinePendingAt(s.now + choice, s.deadline)))
      rejected({
        now: s.deadline, wall: s.wall + s.deadline - s.now,
        sources: s.sources.replaceAt(s.activeLoader, SOURCE_ABANDONED),
        ...s
      }, DEADLINE_ERROR, true)
      else s
    s' = { now: s.now + choice, wall: s.wall + choice, ...timedOut }
  }
  action advance = {
    nondet choice = Set(1, 10, 1000, 4000).oneOf()
    advanceBy(choice)
  }
  action invalidate = all {
    input' = { name: "invalidate", choice: -1 },
    s' = {
      watermark: if (s.wall > s.watermark) s.wall else s.watermark,
      o: { invalidations: s.o.invalidations + 1, maintenance: s.o.maintenance.append("ok"), ...s.o },
      ...s
    }
  }
  action rollbackWall = all {
    input' = { name: "rollbackWall", choice: -1 },
    s' = { wall: s.wall - WALL_ROLLBACK_MS, ...s }
  }
  action policyWith(choice: int): bool = all {
    (Set(2000, 5000)).contains(choice),
    input' = { name: "policy", choice: choice },
    s' = { maxAge: choice, ...s }
  }
  action policy = {
    nondet choice = Set(2000, 5000).oneOf()
    policyWith(choice)
  }
  action readFaultWith(choice: int): bool = all {
    (Set(0, 1)).contains(choice),
    input' = { name: "readFault", choice: choice },
    s' = { readFailed: choice == 1, ...s }
  }
  action readFault = {
    nondet choice = Set(0, 1).oneOf()
    readFaultWith(choice)
  }
  action loadFaultWith(choice: int): bool = all {
    (Set(0, 1)).contains(choice),
    input' = { name: "loadFault", choice: choice },
    s' = { loadFailed: choice == 1, ...s }
  }
  action loadFault = {
    nondet choice = Set(0, 1).oneOf()
    loadFaultWith(choice)
  }

  // Exploration schedule: preserve grouping and order for seeded sampling.
  action step = any {
    any { beginCall, joinCall, resolveLoader, any { rejectLoader, rejectTimeout }, releaseLoad },
    any { seed, advance, rollbackWall, invalidate, policy, readFault, loadFault, closeScope }
  }

  // Invariants: independent checks over state and observed history.
  val singleReadPerFlight = s.o.reads <= s.o.calls.length()
  val pendingDecodeHasCall = s.phase != RECOVERY_DECODE or s.o.calls.select(c => c == CALL_PENDING).length() > 0
  val writesHaveRetention = s.o.writes == s.o.writeTtls.length()

  val closedScopesHaveNoMemo = s.closed.indices().forall(scope => not(s.closed.nth(scope)) or s.memo.nth(scope) == 0)
  val agesRequireRecovery = s.d.ages.length() == s.o.recovery.select(x => x == "served").length()
  val sourcesMatchEffects = s.sources.length() == s.o.loaders
  val onlyRegisteredSourceOwnsDeadline = s.phase != SOURCE_RUNNING or s.sources.nth(s.activeLoader) == SOURCE_REGISTERED

  // Check accepted history, not the current age of a value returned earlier.
  // Keep these inequalities independent of the transition eligibility helper.
  val recoveredValueWasWithinAcceptedAge = s.recoveryReceipts.indices().forall(i => {
    val receipt = s.recoveryReceipts.nth(i)
    receipt.created <= receipt.accepted and receipt.accepted - receipt.created < receipt.maximum
  })

  // Deterministic public histories ------------------------------------------
  // The same commands drive exploration and implementation replay. Initialization
  // 0 is the timeout-only default, 1 permits ordinary errors, 2 denies recovery;
  // adding 4 enables request memoization. beginWith encodes 4 * scope + classifier.
  // No regression patches private cache state or invents an environment command.

  run futureFrameDoesNotCarryMissFenceTest = initialize(0).then(invalidate).then(seedWith(5))
    .then(beginWith(3)).then(resolveWith(0)).expect(s.o.writes == 1)

  run defaultRecoversOwnTimeoutTest = initialize(0).then(beginWith(3)).then(advanceBy(10)).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.classifications == 0 and s.o.recovery == List("served"))
  run explicitDenialReplacesDefaultTest = initialize(0).then(beginWith(1)).then(advanceBy(10))
    .expect(s.o.calls == List(DEADLINE_ERROR) and s.o.classifications == 1 and s.o.loads == 0)
  run defaultRejectsOrdinaryFailureTest = initialize(0).then(beginWith(3)).then(rejectWith(0))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.classifications == 0 and s.o.loads == 0)
  run defaultRecoversPropagatedTimeoutTest = initialize(0).then(beginWith(3)).then(rejectTimeoutWith(0)).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.classifications == 0)
  run lateSuccessCannotReplaceRecoveredValueTest = initialize(0).then(beginWith(3)).then(advanceBy(10))
    .then(resolveWith(0)).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.writes == 0 and s.o.dumps == 0)
  run failedRecoveryPreservesDeadlineErrorTest = initialize(0).then(beginWith(3)).then(advanceBy(10))
    .then(loadFaultWith(1)).then(releaseLoad)
    .expect(s.o.calls == List(DEADLINE_ERROR) and s.o.recovery == List("deserialization_error"))
  run recoveredValueMemoizesOnlyInAttachedRequestTest = initialize(5).then(beginWith(3))
    .then(rejectWith(0)).then(releaseLoad).expect(s.memo == List(1, 0) and s.o.writes == 0)
    .then(beginWith(3)).expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.reads == 1)
    .then(beginWith(7)).expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, CALL_PENDING) and s.o.reads == 2)
  run crossRequestRecoveryMemoizesBothScopesTest = initialize(5).then(beginWith(3))
    .then(joinWith(1)).then(joinWith(0)).then(rejectWith(0)).then(releaseLoad)
    .expect(s.memo == List(1, 1) and s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE) and
      s.d.coalesced == List("process", "request_local") and s.o.loads == 1)
  // Both request scopes join one flight, then independently reuse its recovered
  // value. These calls make request publication observable without shared writes.
  run recoveredFlightMemoIsReusedByBothRequestsTest = initialize(4)
    .then(beginWith(4)).then(joinWith(0)).then(advanceBy(1000)).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.recovery == List("served"))
    .then(beginWith(4)).then(beginWith(0))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE, VALUE_ONE)
      and s.o.reads == 1 and s.o.loaders == 1 and s.o.loads == 1
      and s.o.classifications == 1 and s.o.dumps == 0 and s.o.writes == 0)
  run closedRequestCannotReceiveLateRecoveryMemoTest = initialize(5).then(beginWith(3)).then(rejectWith(0))
    .then(closeWith(0)).then(releaseLoad)
    .expect(s.memo == List(0, 0) and s.o.calls == List(VALUE_ONE)).then(beginWith(7))
    .expect(s.o.reads == 2 and s.o.calls == List(VALUE_ONE, CALL_PENDING))
  run rollbackCannotLowerInvalidationWatermarkTest = initialize(0).then(invalidate).then(rollbackWall).then(invalidate)
    .expect(s.watermark == 100000)
    // Probe the retained fence through a real source result and suppressed refill.
    .then(beginWith(3)).then(resolveWith(0))
    .expect(s.o.calls == List(VALUE_TWO) and s.o.writes == 0 and s.o.dumps == 0)
  run rollbackDuringRetainedDecodeRejectsFutureSnapshotTest = initialize(0).then(beginWith(3))
    .then(advanceBy(10)).then(rollbackWall).then(rollbackWall).then(releaseLoad)
    .expect(s.o.calls == List(DEADLINE_ERROR) and s.o.recovery == List("miss") and s.d.ages == List())
  run instanceAllowReplacesTimeoutOnlyDefaultTest = initialize(1)
    .then(beginWith(3)).then(rejectWith(0)).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.classifications == 1)
  run instanceDenialReplacesTimeoutOnlyDefaultTest = initialize(2)
    .then(beginWith(3)).then(advanceBy(10)).expect(s.o.calls == List(DEADLINE_ERROR) and s.o.loads == 0)
  run operationDenialReplacesInstanceAllowTest = initialize(1)
    .then(beginWith(1)).then(rejectWith(0)).expect(s.o.calls == List(SOURCE_ERROR) and s.o.loads == 0)

  run lastFreshReadDoesNotInvokeSourceTest = initialize(1).then(seedWith(1))
    .then(beginWith(0)).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.loaders == 0
      and s.o.loads == 1 and s.o.recovery == List() and s.o.writes == 0)
  run lastRecoveryMillisecondIsServedTest = initialize(1).then(seedWith(3))
    .then(beginWith(0)).then(rejectWith(0)).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE) and s.d.ages == List(4999)
      and s.o.recovery == List("served") and s.o.dumps == 0 and s.o.writes == 0)
  run maximumAgeAtReadDoesNotDecodeTest = initialize(1).then(seedWith(4))
    .then(beginWith(0)).then(rejectWith(0))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.loads == 0
      and s.o.reads == 1 and s.o.recovery == List("miss"))
  run fencedInitialBytesNeverRecoverTest = initialize(1).then(invalidate)
    .then(beginWith(0)).then(rejectWith(0))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.loads == 0
      and s.o.reads == 1 and s.o.recovery == List("miss"))
  run classifierErrorPreservesSourceWithoutDecodeTest = initialize(1)
    .then(beginWith(2)).then(rejectWith(0))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.classifications == 1
      and s.o.loads == 0 and s.o.recovery == List() and s.o.writes == 0)
  run freshDecodeFailureCannotBeRetriedAsRecoveryTest = initialize(1)
    .then(seedWith(0)).then(loadFaultWith(1))
    .then(beginWith(0)).then(releaseLoad).then(rejectWith(0))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.loads == 1
      and s.o.classifications == 0 and s.o.recovery == List() and s.o.reads == 1)
  run initialReadFailureSkipsRecoveryClassificationTest = initialize(1)
    .then(readFaultWith(1)).then(beginWith(0)).then(rejectWith(0))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.loads == 0
      and s.o.classifications == 0 and s.o.recovery == List() and s.o.reads == 1)
  run rollbackBelowFreshCeilingStillRecoversTest = initialize(1)
    .then(beginWith(0)).then(rejectWith(0)).then(rollbackWall).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE) and s.d.ages == List(0)
      and s.o.recovery == List("served") and s.o.writes == 0)
  run replacementDoesNotChangeRetainedRecoveryTest = initialize(1)
    .then(beginWith(0)).then(seedWith(6)).then(rejectWith(0)).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE) and s.frame == VALUE_TWO
      and s.o.reads == 1 and s.o.loads == 1 and s.o.writes == 0)
  run maximumAgeBeforeDecodePreservesSourceTest = initialize(1)
    .then(seedWith(3)).then(beginWith(0)).then(advanceBy(1)).then(rejectWith(0))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.loads == 0
      and s.o.reads == 1 and s.o.recovery == List("miss"))
  run maximumAgeAfterDecodePreservesSourceTest = initialize(1)
    .then(beginWith(0)).then(rejectWith(0)).then(advanceBy(4000)).then(releaseLoad)
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.loads == 1
      and s.o.recovery == List("miss") and s.d.ages == List() and s.o.writes == 0)
  run operationAllowReplacesInstanceDenialTest = initialize(2)
    .then(beginWith(0)).then(rejectWith(0)).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.classifications == 1
      and s.o.loads == 1 and s.o.recovery == List("served") and s.o.writes == 0)
  run coalescedRecoveryClassifiesAndDecodesOnceTest = initialize(5)
    .then(beginWith(3)).then(joinWith(1)).then(joinWith(0))
    .then(rejectWith(0)).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE)
      and s.o.reads == 1 and s.o.loaders == 1 and s.o.classifications == 1
      and s.o.loads == 1 and s.o.recovery == List("served") and s.o.writes == 0)
  run recoveredValueKeepsOriginalFallbackDiagnosticTest = initialize(1)
    .then(beginWith(0)).then(rejectWith(0)).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.recovery == List("served")
      and s.d.fallbackErrors == List("remote") and s.o.classifications == 1
      and s.o.loads == 1 and s.o.dumps == 0 and s.o.writes == 0)
}
