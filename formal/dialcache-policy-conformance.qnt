module dialcache_policy_conformance {
  import cache_rules.* from "./cache-rules"
  import conformance_observations.* from "./conformance-observations"
  // Two logical keys, one process-local slot, untracked Redis. At most one
  // provider reply is held at a time, but accepted sources can overlap and
  // settle in either order. Every source owns its accepted publication policy.
  // State: o is the replay projection. Cache entries, source ownership, and
  // accepted publication policies are predictions checked by later calls.
  // Environment: untracked Redis, separate wall/elapsed clocks, held policy
  // replies and sources, injectable provider/read/dump/write failures.
  // Bounds: two keys, one local slot, twelve callers; no source deadline.

  // -- Stable overlay, outcome, and duration encodings ------------------------

  pure val POLICY_INHERIT = 0
  pure val POLICY_LOCAL_TTL_TWO_SECONDS = 1
  pure val POLICY_REMOTE_TTL_TWO_SECONDS = 2
  pure val POLICY_NO_LOCAL = 3
  pure val POLICY_NO_REMOTE = 4
  pure val POLICY_INVALID_LOCAL_TTL = 5
  pure val POLICY_INVALID_REMOTE_TTL = 6
  pure val POLICY_RECOVERY_TWO_SECONDS = 7
  pure val POLICY_NO_SERVING = 8
  pure val POLICY_REMOTE_FOUR_SECONDS_NO_RECOVERY = 9
  pure val INDEPENDENT_POLICY_OFFSET = 10
  pure val POLICY_INVALID_READ_BUDGET = 20
  pure val POLICY_INVALID_LOCAL_RAMP = 21
  pure val POLICY_INVALID_REMOTE_RAMP = 22
  pure val POLICY_INVALID_RECOVERY_AGE = 23
  pure val POLICY_NEGATIVE_RECOVERY_AGE = 24
  pure val POLICY_INVALID_SHADOW_RAMP = 25
  pure val NO_OWNER = -1
  pure val NO_CACHED_VALUE = 0
  pure val DISABLED_TTL_MS = 0
  pure val HALF_SECOND_MS = 500
  pure val ONE_SECOND_MS = 1000
  pure val TWO_SECONDS_MS = 2000
  pure val FOUR_SECONDS_MS = 4000
  pure val DEFAULT_RETENTION_MS = 5000
  pure val MAX_CALLERS = 12
  pure val SOURCE_VALUE_COUNT = 7
  pure val MAX_RESOLVE_CHOICE = 84
  pure val FAULT_HEALTHY = 0
  pure val FAULT_FAILED = 1

  // -- State and initial environment -----------------------------------------

  type Source = {
    key: int,
    localTtl: int,
    remoteTtl: int,
    retention: int,
    shared: bool,
    result: int
  }
  type LocalReadReceipt = { eligible: bool, observed: int, expires: int, hit: bool }
  type RemoteReadReceipt = { eligible: bool, created: int, observed: int, fresh: int, hit: bool }
  type State = {
    o: Observation,
    policyErrors: List[{ layer: str, errorType: str }],
    policyReplies: List[{ providerFailed: bool, invalidBudget: bool }],
    localReadReceipts: List[LocalReadReceipt],
    remoteReadReceipts: List[RemoteReadReceipt],
    now: int,
    wall: int,
    policyCall: int,
    overlay: int,
    key: int,
    localKey: int,
    localValue: int,
    localExpires: int,
    remoteValues: List[int],
    remoteCreated: List[int],
    remoteExpires: List[int],
    sources: List[Source],
    owners: List[int],
    registered: List[int],
    providerFailed: bool,
    readFailed: bool,
    dumpFailed: bool,
    writeFailed: bool
  }
  var s: State
  // Recorded environment commands are replayable in sampled and fixed runs.
  var input: { name: str, choice: int }
  action init = all {
    input' = { name: "init", choice: -1 },
    s' = {
      o: empty,
      policyErrors: List(),
      policyReplies: List(), localReadReceipts: List(), remoteReadReceipts: List(),
      now: 0,
      wall: 100000,
      policyCall: NO_OWNER,
      overlay: POLICY_INHERIT,
      key: 0,
      localKey: 0,
      localValue: NO_CACHED_VALUE,
      localExpires: 0,
      remoteValues: List(NO_CACHED_VALUE, NO_CACHED_VALUE),
      remoteCreated: List(0, 0),
      remoteExpires: List(0, 0),
      sources: List(),
      owners: List(),
      registered: List(NO_OWNER, NO_OWNER),
      providerFailed: false,
      readFailed: false,
      dumpFailed: false,
      writeFailed: false
    }
  }

  // -- Effective policy for the pending provider reply -----------------------

  // Choices 10..19 repeat the same sparse overlays with coalescing disabled.
  val baseOverlay = if (s.overlay < POLICY_INVALID_READ_BUDGET) s.overlay % INDEPENDENT_POLICY_OFFSET
    else POLICY_INHERIT
  val localTtl =
    if (s.providerFailed or s.overlay == POLICY_INVALID_READ_BUDGET
      or s.overlay == POLICY_INVALID_LOCAL_RAMP
      or Set(POLICY_NO_LOCAL, POLICY_INVALID_LOCAL_TTL, POLICY_NO_SERVING).contains(baseOverlay))
      DISABLED_TTL_MS
    else if (baseOverlay == POLICY_LOCAL_TTL_TWO_SECONDS) TWO_SECONDS_MS
    else ONE_SECOND_MS
  val remoteTtl =
    if (s.providerFailed or s.overlay == POLICY_INVALID_READ_BUDGET
      or s.overlay == POLICY_INVALID_REMOTE_RAMP
      or Set(POLICY_NO_REMOTE, POLICY_INVALID_REMOTE_TTL, POLICY_NO_SERVING).contains(baseOverlay))
      DISABLED_TTL_MS
    else if (baseOverlay == POLICY_REMOTE_TTL_TWO_SECONDS) TWO_SECONDS_MS
    else if (baseOverlay == POLICY_REMOTE_FOUR_SECONDS_NO_RECOVERY) FOUR_SECONDS_MS
    else ONE_SECOND_MS
  val retention =
    if (s.overlay == POLICY_INVALID_RECOVERY_AGE or s.overlay == POLICY_NEGATIVE_RECOVERY_AGE)
      ONE_SECOND_MS
    else if (baseOverlay == POLICY_RECOVERY_TWO_SECONDS) TWO_SECONDS_MS
    else if (baseOverlay == POLICY_REMOTE_FOUR_SECONDS_NO_RECOVERY) FOUR_SECONDS_MS else DEFAULT_RETENTION_MS
  val pendingSources = s.sources.indices().filter(i => s.sources.nth(i).result == CALL_PENDING)

  // -- Caller admission and layer traversal ----------------------------------

  pure def begin(state: State, key: int): State = {
    key: key,
    policyCall: state.o.calls.length(),
    owners: state.owners.append(NO_OWNER),
    o: {
      calls: state.o.calls.append(CALL_PENDING),
      policyCalls: state.o.policyCalls + 1,
      ...state.o
    },
    ...state
  }
  action startCall(key: int): bool = all {
    s' = begin(s, key),
    input' = { name: "beginCall", choice: key }
  }
  action beginCall = {
    nondet choice = Set(0, 1).oneOf()
    all {
      s.policyCall == NO_OWNER,
      s.o.calls.length() < MAX_CALLERS,
      startCall(choice)
    }
  }
  action releasePolicy = all {
    s.policyCall >= 0,
    val shared = (s.overlay < INDEPENDENT_POLICY_OFFSET or s.overlay >= POLICY_INVALID_READ_BUDGET)
      and (localTtl > 0 or remoteTtl > 0)
    val joinsFlight = shared and s.registered.nth(s.key) >= 0
    // Flight admission precedes reading the first participating cache layer.
    val localEligible = not(joinsFlight) and localTtl > 0 and s.localKey == s.key and s.localValue > 0
    val localHit = localEligible and localEntryLiveAt(s.now, s.localExpires)
    val readsRemote = not(joinsFlight) and not(localHit) and remoteTtl > 0
    val remoteEligible = readsRemote and not(s.readFailed) and s.remoteValues.nth(s.key) > 0
      and s.now < s.remoteExpires.nth(s.key)
    val remoteHit = remoteEligible and freshAgeAllowed(s.remoteCreated.nth(s.key), s.wall, remoteTtl)
    val hitValue = if (localHit) s.localValue else if (remoteHit) s.remoteValues.nth(s.key) else NO_CACHED_VALUE
    val startsSource = not(joinsFlight) and hitValue == NO_CACHED_VALUE
    val owner = if (joinsFlight) s.registered.nth(s.key) else if (startsSource) s.sources.length() else NO_OWNER
    s' = {
      policyCall: NO_OWNER,
      localReadReceipts: s.localReadReceipts.append({
        eligible: localEligible, observed: s.now, expires: s.localExpires, hit: localHit
      }),
      remoteReadReceipts: s.remoteReadReceipts.append({
        eligible: remoteEligible, created: s.remoteCreated.nth(s.key),
        observed: s.wall, fresh: remoteTtl, hit: remoteHit
      }),
      policyReplies: s.policyReplies.append({
        providerFailed: s.providerFailed, invalidBudget: s.overlay == POLICY_INVALID_READ_BUDGET
      }),
      policyErrors: if (s.providerFailed or s.overlay == POLICY_INVALID_READ_BUDGET)
        s.policyErrors.append({ layer: "noop", errorType: "config_resolution" }) else s.policyErrors,
      owners: s.owners.replaceAt(s.policyCall, owner),
      sources: if (startsSource) s.sources.append({
        key: s.key,
        localTtl: localTtl,
        remoteTtl: if (readsRemote and not(s.readFailed)) remoteTtl else DISABLED_TTL_MS,
        retention: retention,
        shared: shared,
        result: CALL_PENDING
      }) else s.sources,
      registered: if (startsSource and shared) s.registered.replaceAt(s.key, owner) else s.registered,
      localKey: if (remoteHit and localTtl > 0) s.key else s.localKey,
      localValue: if (remoteHit and localTtl > 0) hitValue else s.localValue,
      localExpires: if (remoteHit and localTtl > 0) s.now + localTtl else s.localExpires,
      o: {
        calls: s.o.calls.replaceAt(s.policyCall, hitValue),
        reads: s.o.reads + (if (readsRemote) 1 else 0),
        loads: s.o.loads + (if (remoteHit) 1 else 0),
        loaders: s.o.loaders + (if (startsSource) 1 else 0),
        ...s.o
      },
      ...s
    },
    input' = { name: "releasePolicy", choice: -1 }
  }

  // -- Source settlement and accepted publication policy ---------------------

  pure def settle(state: State, loader: int, value: int): State = {
    val source = state.sources.nth(loader)
    val serializes = value != SOURCE_ERROR and source.remoteTtl > 0
    val dispatchesWrite = serializes and not(state.dumpFailed)
    val writeSucceeded = dispatchesWrite and not(state.writeFailed)
    val publishesLocal = value != SOURCE_ERROR and source.localTtl > 0
    {
      sources: state.sources.replaceAt(loader, { result: value, ...source }),
      registered: if (state.registered.nth(source.key) == loader) state.registered.replaceAt(source.key,
        NO_OWNER) else state.registered,
      localKey: if (publishesLocal) source.key else state.localKey,
      localValue: if (publishesLocal) value else state.localValue,
      localExpires: if (publishesLocal) state.now + source.localTtl else state.localExpires,
      remoteValues: if (writeSucceeded) state.remoteValues.replaceAt(source.key, value) else state.remoteValues,
      remoteCreated: if (writeSucceeded) state.remoteCreated.replaceAt(source.key, state.wall)
        else state.remoteCreated,
      remoteExpires: if (writeSucceeded) state.remoteExpires.replaceAt(source.key,
        state.now + source.retention) else state.remoteExpires,
      o: {
        calls: finishOwnedCalls(state.o.calls, state.owners, loader, value),
        dumps: state.o.dumps + (if (serializes) 1 else 0),
        writes: state.o.writes + (if (dispatchesWrite) 1 else 0),
        writeTtls: if (dispatchesWrite) state.o.writeTtls.append(source.retention) else state.o.writeTtls,
        ...state.o
      },
      ...state
    }
  }
  action finishSource(loader: int, value: int): bool = all {
    s' = settle(s, loader, value),
    input' = if (value == SOURCE_ERROR) { name: "rejectLoader", choice: loader }
      else { name: "resolveLoader", choice: loader * SOURCE_VALUE_COUNT
        + (if (value <= VALUE_TWO) value else value - 2) }
  }
  action resolveLoader = {
    // One portable choice records both the actual source index and its value.
    nondet choice = 1.to(MAX_RESOLVE_CHOICE)
      .filter(code => pendingSources.contains((code - 1) / SOURCE_VALUE_COUNT)).oneOf()
    finishSource((choice - 1) / SOURCE_VALUE_COUNT, values.nth((choice - 1) % SOURCE_VALUE_COUNT))
  }
  action rejectLoader = {
    nondet choice = pendingSources.oneOf()
    finishSource(choice, SOURCE_ERROR)
  }

  // -- External policy, clocks, storage, and failures -------------------------

  action changePolicy(overlay: int): bool = all {
    s' = { overlay: overlay, ...s },
    input' = { name: "policy", choice: overlay }
  }
  action policy = {
    nondet choice = POLICY_INHERIT.to(POLICY_INVALID_SHADOW_RAMP).oneOf()
    changePolicy(choice)
  }
  pure def advanceTime(state: State, elapsedMs: int): State = {
    now: state.now + elapsedMs,
    wall: state.wall + elapsedMs,
    ...state
  }
  action elapse(ms: int): bool = all {
    s' = advanceTime(s, ms),
    input' = { name: "advance", choice: ms }
  }
  action advance = {
    nondet choice = Set(1, HALF_SECOND_MS, ONE_SECOND_MS, TWO_SECONDS_MS, DEFAULT_RETENTION_MS).oneOf()
    elapse(choice)
  }
  action seedRemote(key: int, value: int): bool = all {
    s' = {
      remoteValues: s.remoteValues.replaceAt(key, value),
      remoteCreated: s.remoteCreated.replaceAt(key, s.wall),
      remoteExpires: s.remoteExpires.replaceAt(key, s.now + DEFAULT_RETENTION_MS),
      ...s
    },
    input' = { name: "seed", choice: key * 2 + value - 1 }
  }
  action seed = {
    nondet choice = 0.to(3).oneOf()
    seedRemote(choice / 2, choice % 2 + 1)
  }
  action rollbackWall = all {
    s' = { wall: s.wall - ONE_SECOND_MS, ...s },
    input' = { name: "rollbackWall", choice: -1 }
  }
  action setFault(name: str, failed: bool): bool = all {
    s' = if (name == "providerFault") { providerFailed: failed, ...s }
      else if (name == "readFault") { readFailed: failed, ...s }
      else if (name == "dumpFault") { dumpFailed: failed, ...s }
      else { writeFailed: failed, ...s },
    input' = { name: name, choice: if (failed) FAULT_FAILED else FAULT_HEALTHY }
  }
  action providerFault = {
    nondet choice = Set(FAULT_HEALTHY, FAULT_FAILED).oneOf()
    setFault("providerFault", choice == FAULT_FAILED)
  }
  action readFault = {
    nondet choice = Set(FAULT_HEALTHY, FAULT_FAILED).oneOf()
    setFault("readFault", choice == FAULT_FAILED)
  }
  action dumpFault = {
    nondet choice = Set(FAULT_HEALTHY, FAULT_FAILED).oneOf()
    setFault("dumpFault", choice == FAULT_FAILED)
  }
  action writeFault = {
    nondet choice = Set(FAULT_HEALTHY, FAULT_FAILED).oneOf()
    setFault("writeFault", choice == FAULT_FAILED)
  }

  // -- Exploration schedule (nesting/order preserve sampling weights) ---------

  action step = any {
    any {
      beginCall,
      releasePolicy,
      resolveLoader,
      rejectLoader
    },
    any {
      policy,
      seed,
      advance,
      rollbackWall,
      providerFault,
      readFault,
      dumpFault,
      writeFault
    }
  }

  // -- Independently stated safety properties --------------------------------

  // The decision is checked against the entry and elapsed time acquired before
  // this read. Do not call the transition helper from this independent check.
  val localHitsRespectInsertionExpiry = s.localReadReceipts.indices().forall(index => {
    val receipt = s.localReadReceipts.nth(index)
    receipt.hit == (receipt.eligible and receipt.observed < receipt.expires)
  })
  // Recheck the acquired wall time and policy, not later storage or policy.
  // Physical retention and layer eligibility are distinct from logical age.
  val remoteHitsRespectAcquiredFreshness = s.remoteReadReceipts.indices().forall(index => {
    val receipt = s.remoteReadReceipts.nth(index)
    receipt.hit == (receipt.eligible and receipt.created <= receipt.observed
      and receipt.observed - receipt.created < receipt.fresh)
  })

  val writesHaveRetention = s.o.writes == s.o.writeTtls.length()
  val hitsSkipSource = s.o.loaders <= s.o.calls.length()
  val callsKeepSourceOutcome = s.o.calls.indices().forall(i =>
    if (s.owners.nth(i) >= 0) s.o.calls.nth(i) == s.sources.nth(s.owners.nth(i)).result
  else (s.o.calls.nth(i) == CALL_PENDING) == (i == s.policyCall))
  val sourceCountsMatchEffects = s.sources.length() == s.o.loaders and s.owners.length() == s.o.calls.length()
  val registeredSourcesArePending = s.registered.indices().forall(key => {
    val loader = s.registered.nth(key)
    loader < 0 or (s.sources.nth(loader).key == key and s.sources.nth(loader).result == CALL_PENDING
      and s.sources.nth(loader).shared)
  })
  val sharedSourcesKeepRegistration = pendingSources.forall(i =>
    not(s.sources.nth(i).shared) or s.registered.nth(s.sources.nth(i).key) == i)
  // This projection owns invocation-level configuration failure only. Optional
  // layer errors retain their independent layer-policy cases. The replay maps
  // the public error label (not the source error object) into errorType.
  val policyResolutionErrorsHaveStableClassification = s.policyErrors.indices().forall(index => {
    val error = s.policyErrors.nth(index)
    error.layer == "noop" and error.errorType == "config_resolution"
  })
  val eachFailedPolicyReplyHasOneDiagnostic = s.policyErrors.length() ==
    s.policyReplies.select(reply => reply.providerFailed or reply.invalidBudget).length()

  // -- Deterministic regression schedules ------------------------------------

  run invalidReadBudgetBypassesAllCachingTest = init.then(changePolicy(POLICY_INVALID_READ_BUDGET))
    .then(startCall(0))
    .then(releasePolicy)
    .then(startCall(0))
    .then(releasePolicy)
    .expect(s.o.loaders == 2 and s.o.reads == 0)
    .then(finishSource(0, VALUE_ONE))
    .expect(s.localValue == NO_CACHED_VALUE and s.o.writes == 0)
  run invalidLocalRampPreservesRemoteTest = init.then(changePolicy(POLICY_INVALID_LOCAL_RAMP))
    .then(startCall(0))
    .then(releasePolicy)
    .then(finishSource(0, VALUE_ONE))
    .then(startCall(0))
    .then(releasePolicy)
    .expect(s.o.reads == 2 and s.o.loads == 1 and s.localValue == NO_CACHED_VALUE)
  run invalidRemoteRampPreservesLocalTest = init.then(changePolicy(POLICY_INVALID_REMOTE_RAMP))
    .then(startCall(0))
    .then(releasePolicy)
    .then(finishSource(0, VALUE_ONE))
    .then(startCall(0))
    .then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.reads == 0)
  run invalidRecoveryUsesOrdinaryRetentionTest = init.then(changePolicy(POLICY_INVALID_RECOVERY_AGE))
    .then(startCall(0))
    .then(releasePolicy)
    .then(finishSource(0, VALUE_ONE))
    .expect(s.o.writeTtls == List(ONE_SECOND_MS) and s.remoteExpires == List(ONE_SECOND_MS, 0))
  run invalidShadowPreservesNormalServingTest = init.then(changePolicy(POLICY_INVALID_SHADOW_RAMP))
    .then(startCall(0))
    .then(releasePolicy)
    .then(finishSource(0, VALUE_ONE))
    .then(startCall(1))
    .then(releasePolicy)
    .then(finishSource(1, VALUE_TWO))
    .then(startCall(0))
    .then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE) and s.o.loads == 1 and s.o.shadow == List())

  // A hit changes recency, but the insertion deadline stays at 1,000 ms.
  // The final probe distinguishes fixed TTL from renewing it on the middle hit.
  run localHitDoesNotRenewInsertionTtlTest = init
    .then(changePolicy(POLICY_NO_REMOTE))
    .then(startCall(0))
    .then(releasePolicy)
    .then(finishSource(0, VALUE_ONE))
    .then(elapse(HALF_SECOND_MS))
    .then(startCall(0))
    .then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.localExpires == ONE_SECOND_MS)
    .then(elapse(HALF_SECOND_MS))
    .then(startCall(0))
    .then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, CALL_PENDING) and s.o.loaders == 2)

  run wallRollbackDoesNotExtendLocalTtlTest = init.then(changePolicy(POLICY_NO_REMOTE))
    .then(startCall(0))
    .then(releasePolicy)
    .then(finishSource(0, VALUE_ONE))
    .then(rollbackWall)
    .then(startCall(0))
    .then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE))
    .then(elapse(ONE_SECOND_MS))
    .then(startCall(0))
    .then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, CALL_PENDING) and s.o.loaders == 2)
  run wallRollbackRejectsFutureRemoteFrameTest = init.then(changePolicy(POLICY_NO_LOCAL))
    .then(startCall(0))
    .then(releasePolicy)
    .then(finishSource(0, VALUE_ONE))
    .then(rollbackWall)
    .then(startCall(0))
    .then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.o.loaders == 2)

  run independentCompletionKeepsRegisteredLeaderTest = init
    .then(startCall(0))
    .then(releasePolicy)
    .then(changePolicy(INDEPENDENT_POLICY_OFFSET))
    .then(startCall(0))
    .then(releasePolicy)
    .then(finishSource(1, VALUE_TWO))
    .expect(s.o.calls == List(CALL_PENDING, VALUE_TWO) and s.registered == List(0, -1))
    .then(changePolicy(POLICY_INHERIT))
    .then(startCall(0))
    .then(releasePolicy)
    .expect(s.o.calls == List(CALL_PENDING, VALUE_TWO, CALL_PENDING) and s.o.loaders == 2 and s.o.reads == 2)
    .then(finishSource(0, VALUE_ONE))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE))

  run independentFailureKeepsRegisteredLeaderTest = init
    .then(startCall(0))
    .then(releasePolicy)
    .then(changePolicy(INDEPENDENT_POLICY_OFFSET))
    .then(startCall(0))
    .then(releasePolicy)
    .then(finishSource(1, SOURCE_ERROR))
    .expect(s.o.calls == List(CALL_PENDING, SOURCE_ERROR) and s.registered == List(0, -1))
    .then(changePolicy(POLICY_INHERIT))
    .then(startCall(0))
    .then(releasePolicy)
    .then(finishSource(0, VALUE_ONE))
    .expect(s.o.calls == List(VALUE_ONE, SOURCE_ERROR, VALUE_ONE))

  run eachSourceKeepsPublicationPolicyTest = init
    .then(startCall(0))
    .then(releasePolicy)
    .then(changePolicy(INDEPENDENT_POLICY_OFFSET + POLICY_REMOTE_FOUR_SECONDS_NO_RECOVERY))
    .then(startCall(0))
    .then(releasePolicy)
    .then(finishSource(1, VALUE_TWO))
    .then(finishSource(0, VALUE_ONE))
    .expect(s.o.writeTtls == List(FOUR_SECONDS_MS, DEFAULT_RETENTION_MS) and s.remoteValues == List(1, 0))
  run absentValueIsStoredAndReusedTest = init.then(startCall(0))
    .then(releasePolicy)
    .then(finishSource(0, VALUE_ABSENT))
    .then(startCall(0))
    .then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ABSENT, VALUE_ABSENT) and s.o.loaders == 1 and s.o.writes == 1)

  // Coalescing controls pending work. It does not turn off settled caching.
  run independentLocalCallsStillReuseSettledValueTest = init
    .then(changePolicy(INDEPENDENT_POLICY_OFFSET + POLICY_NO_REMOTE))
    .then(startCall(0)).then(releasePolicy)
    .then(finishSource(0, VALUE_ONE))
    .then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1 and s.o.reads == 0)

  run independentLocalPublicationUsesLastCompletionTest = init
    .then(changePolicy(INDEPENDENT_POLICY_OFFSET + POLICY_NO_REMOTE))
    .then(startCall(0)).then(releasePolicy)
    .then(startCall(0)).then(releasePolicy)
    .then(finishSource(1, VALUE_TWO)).then(finishSource(0, VALUE_ONE))
    .then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE) and s.o.loaders == 2)

  run independentRemotePublicationUsesLastCompletionTest = init
    .then(changePolicy(INDEPENDENT_POLICY_OFFSET + POLICY_NO_LOCAL))
    .then(startCall(0)).then(releasePolicy)
    .then(startCall(0)).then(releasePolicy)
    .then(finishSource(1, VALUE_TWO)).then(finishSource(0, VALUE_ONE))
    .then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE)
      and s.o.loaders == 2 and s.o.reads == 3 and s.o.writes == 2 and s.o.loads == 1)

  run providerFailureBypassesAndPreservesExistingLocalTest = init
    .then(startCall(0)).then(releasePolicy).then(finishSource(0, VALUE_ONE))
    .then(setFault("providerFault", true))
    .then(startCall(0)).then(releasePolicy).then(finishSource(1, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO) and s.o.reads == 1 and s.o.writes == 1)
    .then(setFault("providerFault", false))
    .then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE) and s.o.loaders == 2)

  run disablingServingKeepsExistingLocalForReenablementTest = init
    .then(startCall(0)).then(releasePolicy).then(finishSource(0, VALUE_ONE))
    .then(changePolicy(POLICY_NO_SERVING))
    .then(startCall(0)).then(releasePolicy).then(finishSource(1, VALUE_TWO))
    .then(changePolicy(POLICY_INHERIT))
    .then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE)
      and s.o.loaders == 2 and s.o.reads == 1 and s.o.writes == 1)

  // Redis physical retention may outlast logical freshness. Increasing the
  // fresh TTL can reuse retained bytes, but cannot recreate expired storage.
  run increasedFreshTtlCanReusePhysicallyRetainedValueTest = init
    .then(changePolicy(POLICY_NO_LOCAL))
    .then(startCall(0)).then(releasePolicy).then(finishSource(0, VALUE_ONE))
    .then(elapse(ONE_SECOND_MS))
    .then(changePolicy(POLICY_REMOTE_TTL_TWO_SECONDS))
    .then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE)
      and s.o.loaders == 1 and s.o.loads == 1 and s.o.writes == 1)

  run exactRemoteFreshBoundaryStartsSourceTest = init
    .then(changePolicy(POLICY_NO_LOCAL))
    .then(startCall(0)).then(releasePolicy).then(finishSource(0, VALUE_ONE))
    .then(elapse(ONE_SECOND_MS))
    .then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING)
      and s.o.loaders == 2 and s.o.loads == 0 and s.remoteExpires.nth(0) == DEFAULT_RETENTION_MS)

  // The first read proves the retained frame is usable; its hit cannot renew
  // logical freshness. Equality then refills and a later read reuses that fill.
  run remoteHitBeforeBoundaryDoesNotRenewFreshnessTest = init
    .then(changePolicy(POLICY_NO_LOCAL)).then(seedRemote(0, VALUE_ONE))
    .then(elapse(HALF_SECOND_MS)).then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.loaders == 0 and s.o.loads == 1)
    .then(elapse(HALF_SECOND_MS)).then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.o.loaders == 1 and s.o.loads == 1)
    .then(finishSource(0, VALUE_TWO)).then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_TWO)
      and s.o.loaders == 1 and s.o.loads == 2 and s.o.writes == 1)

  run increasedFreshTtlCannotResurrectExpiredStorageTest = init
    .then(changePolicy(POLICY_RECOVERY_TWO_SECONDS))
    .then(startCall(0)).then(releasePolicy).then(finishSource(0, VALUE_ONE))
    .then(elapse(TWO_SECONDS_MS))
    .then(changePolicy(POLICY_REMOTE_FOUR_SECONDS_NO_RECOVERY))
    .then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING)
      and s.o.loaders == 2 and s.o.loads == 0 and s.o.writes == 1)

  run remoteHitStartsFullLocalInsertionTtlTest = init
    .then(changePolicy(POLICY_NO_LOCAL))
    .then(startCall(0)).then(releasePolicy).then(finishSource(0, VALUE_ONE))
    .then(elapse(HALF_SECOND_MS))
    .then(changePolicy(POLICY_INHERIT))
    .then(startCall(0)).then(releasePolicy)
    .expect(s.localExpires == HALF_SECOND_MS + ONE_SECOND_MS)
    .then(elapse(HALF_SECOND_MS))
    .then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE)
      and s.o.loaders == 1 and s.o.reads == 2 and s.o.loads == 1)

  run untrackedReadFailureStillWarmsActiveLocalTest = init
    .then(setFault("readFault", true))
    .then(startCall(0)).then(releasePolicy).then(finishSource(0, VALUE_ONE))
    .then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE)
      and s.o.loaders == 1 and s.o.reads == 1 and s.o.dumps == 0 and s.o.writes == 0)

  run invalidRemoteTtlPreservesLocalServingTest = init
    .then(changePolicy(POLICY_INVALID_REMOTE_TTL))
    .then(startCall(0)).then(releasePolicy)
    .then(finishSource(0, VALUE_ONE))
    .then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1
      and s.o.reads == 0 and s.o.writes == 0 and s.o.loads == 0)

  run invalidLocalTtlStillServesFreshRemoteTest = init
    .then(seedRemote(0, VALUE_ONE)).then(changePolicy(POLICY_INVALID_LOCAL_TTL))
    .then(startCall(0)).then(releasePolicy)
    .then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 0
      and s.o.reads == 2 and s.o.loads == 2 and s.o.writes == 0)

  run recoveryAgeEqualToFreshTtlStillServesFreshRemoteTest = init
    .then(seedRemote(0, VALUE_ONE)).then(changePolicy(POLICY_INVALID_RECOVERY_AGE))
    .then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.loaders == 0
      and s.o.reads == 1 and s.o.loads == 1 and s.o.recovery == List())

  run negativeRecoveryAgeStillServesFreshRemoteTest = init
    .then(seedRemote(0, VALUE_ONE)).then(changePolicy(POLICY_NEGATIVE_RECOVERY_AGE))
    .then(startCall(0)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.loaders == 0
      and s.o.reads == 1 and s.o.loads == 1 and s.o.recovery == List())

  run providerFailureReportsStablePolicyCategoryTest = init
    .then(startCall(0)).then(releasePolicy).then(finishSource(0, VALUE_ONE))
    .then(setFault("providerFault", true))
    .then(startCall(0)).then(releasePolicy)
    .expect(s.policyErrors == List({ layer: "noop", errorType: "config_resolution" })
      and s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.o.loaders == 2
      and s.o.reads == 1 and s.o.writes == 1)
    .then(finishSource(1, VALUE_TWO)).then(setFault("providerFault", false))
    .then(startCall(0)).then(releasePolicy)
    .expect(s.policyErrors == List({ layer: "noop", errorType: "config_resolution" })
      and s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE) and s.o.loaders == 2)
}
