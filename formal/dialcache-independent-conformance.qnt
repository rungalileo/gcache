module dialcache_independent_conformance {
  import cache_rules.* from "./cache-rules"
  import conformance_observations.* from "./conformance-observations"
  // Model boundary -----------------------------------------------------------
  // Six same-key callers with coalescing disabled exercise selected aspects of
  // C24/C56: each owns its read and source deadline. Read failure denies only
  // that caller's refill (C28); recovery keeps its captured policy, snapshot,
  // and original error (selected aspects of C36/C40-C46/C58).
  // See BEHAVIOR.md: "Generated feature profiles" and its independent input table.
  // No local/request storage, shadow work, or publication failures participate.
  // `now` is elapsed time; `wall` is the application clock. Pending external
  // effects remain in their historical lists after timeout, so late settlement
  // can be observed without regaining ownership of a completed caller.

  // Trace encodings and fixture bounds ---------------------------------------
  // Keep integer state/input fields stable; shared results come from the import.
  pure val READ_PENDING = 1
  pure val SOURCE_RUNNING = 2
  pure val FRESH_DECODE = 3
  pure val RECOVERY_DECODE = 4
  pure val CALL_DONE = 5
  pure val NO_SOURCE = -1
  pure val NO_CANDIDATE = 0
  pure val FRESH_AGE_MS = 1000
  pure val SOURCE_BUDGET_MS = 10
  pure val SHORT_READ_BUDGET_MS = 5
  pure val LONG_READ_BUDGET_MS = 10
  pure val SHORT_RETENTION_MS = 2000
  pure val LONG_RETENTION_MS = 5000
  pure val FIXTURE_TTL_MS = 60000
  pure val MAX_CALLS = 6
  pure val SOURCE_RESULT_COUNT = 2

  // State: effect owners, captured admission values, and observed history.
  type Call = {
    source: int, phase: int, maxAge: int,
    candidate: int, created: int, acquiredAt: int,
    canRecover: bool, canWrite: bool, fence: int, error: int
  }
  type Read = { caller: int, pending: bool, active: bool }
  type Source = {
    caller: int, pending: bool, active: bool,
    startedAt: int, settledAt: int, outcome: int
  }
  type Load = { caller: int, pending: bool, recovery: bool, value: int }
  type Timer = { read: bool, index: int, at: int }
  type State = {
    o: Observation,
    io: { budgets: List[int], aborted: List[int], sourceErrors: List[int] },
    now: int, wall: int,
    frame: int, created: int, expires: int, watermark: int, readBudget: int, maxAge: int,
    calls: List[Call], reads: List[Read], sources: List[Source], loads: List[Load], timers: List[Timer]
  }
  var s: State
  var input: { name: str, choice: int }

  // Initial fixture ----------------------------------------------------------
  action init = all {
    input' = { name: "init", choice: -1 },
    s' = {
      o: empty,
      io: { budgets: List(), aborted: List(), sourceErrors: List() },
      now: 0, wall: 100000,
      frame: VALUE_ONE, created: 99000, expires: FIXTURE_TTL_MS, watermark: 0,
      readBudget: SHORT_READ_BUDGET_MS, maxAge: LONG_RETENTION_MS,
      calls: List(), reads: List(), sources: List(), loads: List(), timers: List()
    }
  }

  // Caller completion and owned effects -------------------------------------
  pure def finished(x: State, caller: int, value: int): State = {
    calls: x.calls.replaceAt(caller, { phase: CALL_DONE, ...x.calls.nth(caller) }),
    io: {
      sourceErrors: x.io.sourceErrors.replaceAt(caller,
        if (value == SOURCE_ERROR) x.calls.nth(caller).source + 1 else 0),
      ...x.io
    },
    o: { calls: x.o.calls.replaceAt(caller, value), ...x.o },
    ...x
  }
  pure def startSource(x: State, caller: int): State = {
    calls: x.calls.replaceAt(caller, { phase: SOURCE_RUNNING, source: x.sources.length(), ...x.calls.nth(caller) }),
    sources: x.sources.append({ caller: caller, active: true, pending: true,
      startedAt: x.now, settledAt: -1, outcome: CALL_PENDING }),
    timers: x.timers.append({ read: false, index: x.sources.length(), at: x.now + SOURCE_BUDGET_MS }),
    o: { loaders: x.o.loaders + 1, ...x.o },
    ...x
  }
  pure def startLoad(x: State, caller: int, recovery: bool, value: int): State = {
    calls: x.calls.replaceAt(caller, { phase: if (recovery) RECOVERY_DECODE else FRESH_DECODE, ...x.calls.nth(caller) }),
    loads: x.loads.append({ caller: caller, pending: true, recovery: recovery, value: value }),
    o: { loads: x.o.loads + 1, ...x.o },
    ...x
  }
  pure def validCandidate(x: State, caller: int): bool = {
    val call = x.calls.nth(caller)
    call.candidate > NO_CANDIDATE and recoveryAgeAllowed(call.created, x.wall, call.maxAge)
  }
  pure def rejected(x: State, caller: int, error: int): State = {
    val call = x.calls.nth(caller)
    val classified = {
      calls: x.calls.replaceAt(caller, { error: error, ...call }),
      o: { classifications: x.o.classifications + (if (call.canRecover) 1 else 0), ...x.o },
      ...x
    }
    if (not(call.canRecover)) finished(classified, caller, error)
    else if (validCandidate(x, caller)) startLoad(classified, caller, true, call.candidate)
    else finished({
      o: { recovery: classified.o.recovery.append("miss"), ...classified.o },
      ...classified
    }, caller, error)
  }

  // Admission captures policy separately for each same-key caller. -----------
  pure def begin(x: State): State = {
    val caller = x.calls.length()
    {
      calls: x.calls.append({
        source: NO_SOURCE, phase: READ_PENDING, maxAge: x.maxAge,
        candidate: NO_CANDIDATE, created: 0, acquiredAt: 0,
        canRecover: false, canWrite: false, fence: 0, error: SOURCE_ERROR
      }),
      reads: x.reads.append({ caller: caller, active: true, pending: true }),
      timers: x.timers.append({ read: true, index: x.reads.length(), at: x.now + x.readBudget }),
      io: { budgets: x.io.budgets.append(x.readBudget), sourceErrors: x.io.sourceErrors.append(0), ...x.io },
      o: {
        calls: x.o.calls.append(CALL_PENDING),
        reads: x.o.reads + 1, policyCalls: x.o.policyCalls + 1,
        ...x.o
      },
      ...x
    }
  }
  action beginCall = all {
    s.calls.length() < MAX_CALLS,
    input' = { name: "beginCall", choice: -1 },
    s' = begin(s)
  }
  pure def expireRead(x: State, index: int): State = {
    val read = x.reads.nth(index)
    startSource({
      reads: x.reads.replaceAt(index, { active: false, ...read }),
      io: { aborted: x.io.aborted.append(index), ...x.io },
      ...x
    }, read.caller)
  }
  pure def expireSource(x: State, index: int): State = {
    val source = x.sources.nth(index)
    rejected({
      sources: x.sources.replaceAt(index, { active: false, settledAt: x.now, outcome: DEADLINE_ERROR, ...source }),
      ...x
    }, source.caller, DEADLINE_ERROR)
  }

  // External settlement: abandoned effects cannot reclaim caller ownership. --
  pure def readReply(x: State, index: int, failed: bool): State = {
    val read = x.reads.nth(index)
    val settled = {
      reads: x.reads.replaceAt(index, { pending: false, active: false, ...read }),
      ...x
    }
    val call = x.calls.nth(read.caller)
    val readable = x.frame > 0 and x.now < x.expires and fenceAllows(x.created, x.watermark)
    val fresh = readable and freshAgeAllowed(x.created, x.wall, FRESH_AGE_MS)
    val stale = readable and x.created <= x.wall and
      retainedAgeAllowed(x.created, x.wall, FRESH_AGE_MS, call.maxAge)
    val observed = {
      calls: settled.calls.replaceAt(read.caller, {
        canWrite: not(failed), canRecover: not(failed) and not(fresh),
        candidate: if (stale and not(failed)) x.frame else NO_CANDIDATE,
        created: x.created, acquiredAt: x.wall,
        fence: if (readable) 0 else x.watermark,
        ...call
      }),
      ...settled
    }
    if (not(read.active)) settled
    else if (failed or not(fresh)) startSource(observed, read.caller)
    else startLoad(observed, read.caller, false, x.frame)
  }
  action readAt(index: int): bool = all {
    input' = { name: "releaseRead", choice: index }, s' = readReply(s, index, false)
  }
  action releaseRead = {
    nondet choice = s.reads.indices().filter(i => s.reads.nth(i).pending).oneOf()
    readAt(choice)
  }
  action failReadAt(index: int): bool = all {
    input' = { name: "failRead", choice: index }, s' = readReply(s, index, true)
  }
  action failRead = {
    nondet choice = s.reads.indices().filter(i => s.reads.nth(i).pending).oneOf()
    failReadAt(choice)
  }
  pure def sourceReply(x: State, index: int, value: int): State = {
    val source = x.sources.nth(index)
    val call = x.calls.nth(source.caller)
    val settled = {
      sources: x.sources.replaceAt(index, { pending: false, active: false,
        settledAt: if (source.active) x.now else source.settledAt,
        outcome: if (source.active) value else source.outcome, ...source }),
      ...x
    }
    val mayWrite = call.canWrite and fenceAllows(x.wall, call.fence)
    if (not(source.active)) settled
    else if (value == SOURCE_ERROR) rejected(settled, source.caller, SOURCE_ERROR)
    else finished({
      frame: if (mayWrite) value else x.frame,
      created: if (mayWrite) x.wall else x.created,
      expires: if (mayWrite) x.now + call.maxAge else x.expires,
      o: {
        writes: x.o.writes + (if (mayWrite) 1 else 0),
        dumps: x.o.dumps + (if (mayWrite) 1 else 0),
        writeTtls: if (mayWrite) x.o.writeTtls.append(call.maxAge) else x.o.writeTtls,
        ...x.o
      },
      ...settled
    }, source.caller, value)
  }
  action resolveWith(code: int): bool = all {
    input' = { name: "resolveLoader", choice: code },
    s' = sourceReply(s, (code - 1) / SOURCE_RESULT_COUNT, (code - 1) % SOURCE_RESULT_COUNT + 1)
  }
  action resolveLoader = {
    // Wire choice 1..12 pairs each source index with result VALUE_ONE/VALUE_TWO.
    nondet choice = 1.to(MAX_CALLS * SOURCE_RESULT_COUNT).filter(code =>
      (code - 1) / SOURCE_RESULT_COUNT < s.sources.length() and
      s.sources.nth((code - 1) / SOURCE_RESULT_COUNT).pending).oneOf()
    resolveWith(choice)
  }
  action rejectAt(index: int): bool = all {
    input' = { name: "rejectLoader", choice: index }, s' = sourceReply(s, index, SOURCE_ERROR)
  }
  action rejectLoader = {
    nondet choice = s.sources.indices().filter(i => s.sources.nth(i).pending).oneOf()
    rejectAt(choice)
  }
  pure def loadReply(x: State, index: int, failed: bool): State = {
    val load = x.loads.nth(index)
    val call = x.calls.nth(load.caller)
    val settled = { loads: x.loads.replaceAt(index, { pending: false, ...load }), ...x }
    if (not(load.recovery)) {
      if (failed) startSource({
        calls: x.calls.replaceAt(load.caller, { canRecover: false, ...call }),
        ...settled
      }, load.caller)
      else finished(settled, load.caller, load.value)
    } else {
      val valid = validCandidate(x, load.caller)
      finished({
        o: {
          recovery: x.o.recovery.append(
            if (failed) "deserialization_error" else if (valid) "served" else "miss"),
          ...x.o
        },
        ...settled
      }, load.caller, if (failed or not(valid)) call.error else load.value)
    }
  }
  action loadAt(index: int): bool = all {
    input' = { name: "releaseLoad", choice: index }, s' = loadReply(s, index, false)
  }
  action releaseLoad = {
    nondet choice = s.loads.indices().filter(i => s.loads.nth(i).pending).oneOf()
    loadAt(choice)
  }
  action failLoadAt(index: int): bool = all {
    input' = { name: "failLoad", choice: index }, s' = loadReply(s, index, true)
  }
  action failLoad = {
    nondet choice = s.loads.indices().filter(i => s.loads.nth(i).pending).oneOf()
    failLoadAt(choice)
  }

  // Environmental clocks, storage, and policy --------------------------------
  pure def tick(x: State, ms: int): State = {
    val target = x.now + ms
    // At most one read deadline and one source deadline per admitted call.
    // Visit only due deadline instants, including sources started by read expiry.
    0.to(x.calls.length() * 2).fold(x, (elapsed, _) => {
      val dueAt = elapsed.timers.foldl(target, (earliest, timer) => {
        val timerActive = if (timer.read) elapsed.reads.nth(timer.index).active
          else elapsed.sources.nth(timer.index).active
        if (timerActive and timer.at > elapsed.now and timer.at < earliest) timer.at else earliest
      })
      val atDeadline = { now: dueAt, wall: elapsed.wall + dueAt - elapsed.now, ...elapsed }
      atDeadline.timers.foldl(atDeadline, (delivered, timer) =>
        if (timer.at != atDeadline.now) delivered
        else if (timer.read and delivered.reads.nth(timer.index).active)
          expireRead(delivered, timer.index)
        else if (not(timer.read) and delivered.sources.nth(timer.index).active)
          expireSource(delivered, timer.index)
        else delivered)
    })
  }
  action advanceBy(ms: int): bool = all {
    input' = { name: "advance", choice: ms }, s' = tick(s, ms)
  }
  action advance = {
    nondet choice = Set(1, 5, 10, 1000).oneOf()
    advanceBy(choice)
  }
  action seed = {
    // Fresh values and values just inside each admitted recovery age bound.
    nondet choice = 0.to(5).oneOf()
    all {
      input' = { name: "seed", choice: choice },
      s' = {
        frame: if (choice == 2 or choice == 4) VALUE_TWO else VALUE_ONE,
        created: s.wall - (if (choice == 0 or choice == 4) 0
        else if (choice == 3) 4999 else if (choice == 5) 1999 else 1000),
        expires: s.now + FIXTURE_TTL_MS,
        ...s
      }
    }
  }
  action invalidate = all {
    input' = { name: "invalidate", choice: -1 },
    s' = {
      watermark: s.wall,
      o: { invalidations: s.o.invalidations + 1, maintenance: s.o.maintenance.append("ok"), ...s.o },
      ...s
    }
  }

  // Wire choices 0/1 use long retention; parity chooses the read budget.
  action policyWith(choice: int): bool = all {
    (0.to(3)).contains(choice),
    input' = { name: "policy", choice: choice },
    s' = {
      readBudget: if (choice % 2 == 0) SHORT_READ_BUDGET_MS else LONG_READ_BUDGET_MS,
      maxAge: if (choice < 2) LONG_RETENTION_MS else SHORT_RETENTION_MS,
      ...s
    }
  }
  action policy = {
    nondet choice = 0.to(3).oneOf()
    policyWith(choice)
  }


  // Exploration schedule: preserve grouping and order for seeded sampling.
  action step = any {
    beginCall, releaseRead, any { resolveLoader, rejectLoader, releaseLoad },
    any { policy, seed }, any { advance, invalidate, failRead, failLoad }
  }

  // Invariants: independent checks over ownership and observed history.
  val oneReadPerCall = s.o.reads == s.o.calls.length() and
    s.io.budgets.length() == s.o.reads and s.io.sourceErrors.length() == s.o.calls.length()
  val effectsMatchOwners = s.o.reads == s.reads.length() and
    s.o.loads == s.loads.length() and s.o.loaders == s.sources.length()
  val completedCallsHaveNoActiveWork = s.calls.indices().forall(i => s.calls.nth(i).phase != CALL_DONE or
    (s.reads.indices().forall(j => s.reads.nth(j).caller != i or not(s.reads.nth(j).active)) and
      s.sources.indices().forall(j => s.sources.nth(j).caller != i or not(s.sources.nth(j).active))))
  val retainedSnapshotsWereEligible = s.calls.indices().forall(i => {
    val c = s.calls.nth(i)
    c.candidate == NO_CANDIDATE or
      (c.acquiredAt - c.created >= FRESH_AGE_MS and c.acquiredAt - c.created < c.maxAge)
  })
  val abortsAreUnique = s.io.aborted.indices().forall(i =>
    s.io.aborted.indices().forall(j => i == j or s.io.aborted.nth(i) != s.io.aborted.nth(j)))
  val writesKeepCapturedRetention = s.o.writeTtls.indices().forall(i =>
    s.o.writeTtls.nth(i) == SHORT_RETENTION_MS or s.o.writeTtls.nth(i) == LONG_RETENTION_MS)

  // Source timers retain the owner's start, even when another source expires.
  val eachSourceKeepsItsFullBudget = s.sources.indices().forall(i => {
    val source = s.sources.nth(i)
    s.timers.select(timer => not(timer.read) and timer.index == i).length() == 1 and
      s.timers.select(timer => not(timer.read) and timer.index == i).nth(0).at == source.startedAt + 10
  })
  val sourceSettlementsRespectOwnDeadline = s.sources.indices().forall(i => {
    val source = s.sources.nth(i)
    source.outcome == CALL_PENDING or
      (if (source.outcome == DEADLINE_ERROR) source.settledAt >= source.startedAt + 10
        else source.settledAt < source.startedAt + 10)
  })

  // Deterministic model regressions ------------------------------------------
  run independentReadDeadlinesStartSeparateSourcesTest = init.then(beginCall).then(advanceBy(1)).then(beginCall)
    .then(advanceBy(1)).then(advanceBy(1)).then(advanceBy(1)).then(advanceBy(1))
    .expect(s.io.aborted == List(0) and s.o.loaders == 1)
    .then(advanceBy(1)).expect(s.io.aborted == List(0, 1) and s.o.loaders == 2)
  run independentRecoveryKeepsDistinctSnapshotsTest = init.then(beginCall).then(readAt(0))
    .then(all { input' = input, s' = { frame: VALUE_TWO, ...s } }).then(beginCall).then(readAt(1))
    .then(rejectAt(0)).then(rejectAt(1)).then(invalidate)
    .then(loadAt(1)).then(loadAt(0))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO) and s.o.reads == 2 and s.o.writes == 0)
  run timedOutReadCannotAffectAnotherCallTest = init.then(beginCall).then(advanceBy(5))
    .then(beginCall).then(readAt(1)).then(readAt(0))
    .expect(s.o.loads == 0 and s.o.loaders == 2 and s.io.aborted == List(0))
  run acceptedFreshDecodeSurvivesOtherInvalidationTest = init.then(all { input' = input, s' = { created: s.wall, ...s } }).then(beginCall)
    .then(readAt(0)).then(invalidate).then(beginCall).then(readAt(1))
    .then(loadAt(0)).expect(s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.o.loaders == 1)
  run readFailureCannotBorrowAnotherCallsRefillTest = init.then(beginCall).then(beginCall)
    .then(failReadAt(0)).then(readAt(1))
    .then(resolveWith(4)).then(resolveWith(1))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO) and s.o.writes == 1 and s.frame == VALUE_TWO)
  run recoveryPolicyIsCapturedPerCallerTest = init.then(beginCall).then(readAt(0))
    .then(all { input' = input, s' = { maxAge: SHORT_RETENTION_MS, ...s } }).then(beginCall).then(readAt(1))
    .then(rejectAt(0)).then(rejectAt(1)).then(advanceBy(1000))
    .then(loadAt(0)).then(loadAt(1))
    .expect(s.o.calls == List(VALUE_ONE, SOURCE_ERROR) and s.io.sourceErrors == List(0, 2) and s.o.recovery == List("served", "miss"))

  // Release the shorter-policy decode first, while the longer-policy caller
  // still waits. At exactly its captured maximum it preserves its own error;
  // the other caller can still recover the same acquired bytes.
  run independentRecoveryAtCapturedAgeBoundaryTest = init
    .then(beginCall).then(readAt(0)).then(policyWith(2))
    .then(beginCall).then(readAt(1)).then(rejectAt(0)).then(rejectAt(1))
    .then(advanceBy(1000)).then(loadAt(1))
    .expect(s.o.calls == List(CALL_PENDING, SOURCE_ERROR)
      and s.o.recovery == List("miss") and s.io.sourceErrors == List(0, 2))
    .then(loadAt(0))
    .expect(s.o.calls == List(VALUE_ONE, SOURCE_ERROR)
      and s.o.recovery == List("miss", "served") and s.o.reads == 2
      and s.o.loaders == 2 and s.o.loads == 2 and s.o.dumps == 0 and s.o.writes == 0)

  // Fenced storage removes recovery as a competing explanation. The later
  // source succeeds after the earlier caller's deadline, within its own budget.
  run staggeredSourceStartsKeepIndependentBudgetsTest = init.then(invalidate)
    .then(beginCall).then(readAt(0)).then(advanceBy(5)).then(beginCall).then(readAt(1))
    .then(advanceBy(5)).expect(s.o.calls == List(DEADLINE_ERROR, CALL_PENDING))
    .then(advanceBy(1)).then(resolveWith(4))
    .expect(s.o.calls == List(DEADLINE_ERROR, VALUE_TWO) and s.o.loaders == 2
      and s.o.loads == 0 and s.o.writes == 1 and s.o.recovery == List("miss"))
  run staggeredSourcesExpireAtTheirOwnDeadlineTest = init.then(invalidate)
    .then(beginCall).then(readAt(0)).then(advanceBy(5)).then(beginCall).then(readAt(1))
    .then(advanceBy(5)).expect(s.o.calls == List(DEADLINE_ERROR, CALL_PENDING))
    .then(advanceBy(1)).then(advanceBy(1)).then(advanceBy(1)).then(advanceBy(1))
    .expect(s.o.calls == List(DEADLINE_ERROR, CALL_PENDING))
    .then(advanceBy(1)).expect(s.o.calls == List(DEADLINE_ERROR, DEADLINE_ERROR)
      and s.o.loaders == 2 and s.o.loads == 0 and s.o.writes == 0 and s.o.recovery == List("miss", "miss"))
}
