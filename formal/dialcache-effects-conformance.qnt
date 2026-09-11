module dialcache_effects_conformance {
  import cache_rules.* from "./cache-rules"
  // Model boundary -----------------------------------------------------------
  // One registered remote-only execution, plus up to eight callers and late
  // external sources/reads. Selected aspects of C23-C28 cover budgets and
  // accepted publication; C33-C36 cover fences/snapshots; C55-C59 cover effects.
  // See BEHAVIOR.md: "Generated pending-effect profile" for the driver mapping.
  // No local storage, recovery, shadow work, or physical expiry participates.
  // `now` is elapsed milliseconds; `wall` is an independent application clock.
  // Adapter effects are environmental settlements, not language executor turns.

  // Trace encodings ----------------------------------------------------------
  // Keep these integers stable: this profile's result encoding intentionally
  // differs from the feature profiles in conformance-observations.qnt.
  pure val CALL_PENDING = 0
  pure val CALL_VALUE = 1
  pure val CALL_SOURCE_ERROR = 2
  pure val CALL_TIMEOUT = 3
  pure val EFFECT_REGISTERED = 0
  pure val EFFECT_ABANDONED = 1
  pure val EFFECT_SETTLED = 2
  pure val IDLE = 0
  pure val SOURCE_RUNNING = 1
  pure val WRITE_PENDING = 2
  pure val READ_PENDING = 3
  pure val DECODE_PENDING = 4
  pure val SERIALIZE_PENDING = 5
  pure val UNTRACKED = 0
  pure val TRACKED = 1
  pure val REFILL_DENIED = 0
  pure val REFILL_ALLOWED = 1
  pure val SOURCE_BUDGET_MS = 10
  pure val CLOCK_STEP_MS = 10
  pure val WALL_ROLLBACK_MS = 1000
  pure val FUTURE_BUFFER_MS = 20
  pure val MAX_CALLS = 8

  // Initial read-budget precedence fixtures; values are recorded input choices.
  pure val FIXTURE_LIBRARY_BUDGET = 0
  pure val FIXTURE_INSTANCE_BUDGET = 1
  pure val FIXTURE_OPERATION_BUDGET = 2
  pure val FIXTURE_RUNTIME_BUDGET = 3
  pure val FIXTURE_NULL_PROVIDER = 4
  pure val FIXTURE_UNTRACKED = 5

  // Queued reply classes used by the normalization branches. Other malformed
  // classes deliberately follow the default unclassified-miss branch.
  pure val NO_QUEUED_REPLY = 0
  pure val REPLY_UNKNOWN_WITH_FENCE = 7
  pure val REPLY_FRACTIONAL_FENCE = 10
  pure val REPLY_UNSAFE_FENCE = 11
  pure val REPLY_ABSENT_WITH_FENCE = 12
  pure val REPLY_EXPIRED_ZERO_FENCE = 13
  pure val REPLY_MISS_WITH_FRAME_FIELDS = 14
  pure val REPLY_FRAME_WITH_MISS_FIELDS = 15
  pure val REPLY_FENCED_WITH_VALID_FENCE = 16

  // State and observable history --------------------------------------------
  // Histories survive flight completion. Accepted timestamps and fences belong
  // to the execution that acquired them; stored state belongs to the environment.
  // Event amount is milliseconds for time, bytes for sizes, otherwise zero.
  type Event = { event: str, location: str, detail: str, amount: int }
  type State = {
    events: List[Event],
    readStarted: int, decodeStarted: int,
    tracked: int, reply: int, replyAt: int,
    now: int, wall: int,
    readBudget: int, baseReadBudget: int,
    phase: int, activeLoader: int, activeRead: int, deadline: int,
    observedFence: int, refill: int, acceptedAt: int, acceptedWall: int,
    writeTimestamp: int, storedTimestamp: int, watermark: int,
    calls: List[int], sources: List[int], readStates: List[int], readBudgets: List[int],
    loaders: int, reads: int, writes: int, invalidations: int,
    loads: int, dumps: int, policyCalls: int, readAborts: int, observerFailed: int
  }
  var s: State
  var input: { name: str, choice: int }

  // Observation and transition helpers ---------------------------------------
  pure def finishPendingCalls(calls: List[int], outcome: int): List[int] =
    calls.foldl(List(), (out, result) => out.append(if (result == CALL_PENDING) outcome else result))
  pure def startSource(x: State, allowed: int, fence: int): State = {
    phase: SOURCE_RUNNING,
    activeLoader: x.sources.length(), deadline: x.now + SOURCE_BUDGET_MS,
    loaders: x.loaders + 1,
    sources: x.sources.append(EFFECT_REGISTERED),
    refill: allowed, observedFence: fence,
    ...x
  }
  pure def emit(x: State, event: str, location: str, detail: str, amount: int): State = {
    events: x.events.append({ event: event, location: location, detail: detail, amount: amount }),
    ...x
  }
  pure def metric(x: State, event: str, detail: str, amount: int): State = emit(x, event, "remote", detail, amount)
  pure def readDone(x: State): State = metric(x, "get", "", x.now - x.readStarted)
  pure def sourceDone(x: State, failed: bool): State = metric(
    if (failed) metric(x, "error", "fallback", 0) else x,
    "fallback", "", x.now - (x.deadline - SOURCE_BUDGET_MS))
  pure def decoded(x: State, failed: bool): State = {
    val measured = metric(if (failed) metric(x, "error", "serialization_load", 0) else x,
      "serialization", "load", x.now - x.decodeStarted)
    readDone(if (failed) metric(measured, "miss", "unclassified", 0) else measured)
  }
  pure def serialized(x: State, failed: bool): State = {
    val measured = metric(if (failed) metric(x, "error", "serialization_dump", 0) else x,
      "serialization", "dump", x.now - x.acceptedAt)
    if (failed) measured else metric(metric(measured, "size", "", 1), "storedSize", "", 1)
  }
  val unfenced = s.storedTimestamp > 0 and (s.tracked == UNTRACKED or fenceAllows(s.storedTimestamp, s.watermark))
  val readable = unfenced and s.wall >= s.storedTimestamp

  // Initial fixture ----------------------------------------------------------
  pure def initial(mode: int): State = {
    events: List(), readStarted: 0, decodeStarted: 0,
    tracked: if (mode == FIXTURE_UNTRACKED) UNTRACKED else TRACKED,
    reply: NO_QUEUED_REPLY, replyAt: 0,
    now: 10000, wall: 100000, readBudget: List(50, 20, 10, 30, 10, 10).nth(mode),
    baseReadBudget: if (mode == FIXTURE_LIBRARY_BUDGET) 50
      else if (mode == FIXTURE_INSTANCE_BUDGET) 20 else 10,
    phase: IDLE, activeLoader: 0, activeRead: 0, deadline: 0,
    observedFence: 0, refill: REFILL_DENIED, acceptedAt: 0, acceptedWall: 0,
    writeTimestamp: 0, storedTimestamp: 0, watermark: 0,
    calls: List(), sources: List(), readStates: List(), readBudgets: List(),
    loaders: 0, reads: 0, writes: 0, invalidations: 0,
    loads: 0, dumps: 0, policyCalls: 0, readAborts: 0, observerFailed: 0
  }

  action initialized(mode: int): bool = all {
    input' = { name: "init", choice: mode }, s' = initial(mode)
  }
  action init = {
    nondet choice = FIXTURE_LIBRARY_BUDGET.to(FIXTURE_UNTRACKED).oneOf()
    initialized(choice)
  }

  // Call admission and bounded raw reads -------------------------------------
  action beginCall = all {
    input' = { name: "beginCall", choice: -1 },
    s.calls.length() < MAX_CALLS,
    val visited = emit(s, "disabled", "local", "policy_disabled", 0)
    val observed = if (s.phase == IDLE) metric(visited, "request", "", 0)
      else emit(visited, "coalesced", "process", "", 0)
    s' = {
      events: observed.events, readStarted: if (s.phase == IDLE) s.now else s.readStarted,
      calls: s.calls.append(CALL_PENDING), policyCalls: s.policyCalls + 1,
      reads: if (s.phase == IDLE) s.reads + 1 else s.reads,
      readStates: if (s.phase == IDLE) s.readStates.append(EFFECT_REGISTERED) else s.readStates,
      readBudgets: if (s.phase == IDLE) s.readBudgets.append(s.readBudget) else s.readBudgets,
      activeRead: if (s.phase == IDLE) s.reads else s.activeRead,
      deadline: if (s.phase == IDLE) s.now + s.readBudget else s.deadline,
      phase: if (s.phase == IDLE) READ_PENDING else s.phase, ...s
    }
  }

  def settledRead(index: int, failed: bool): State = {
    val settled = {
      reply: if (failed) s.reply else NO_QUEUED_REPLY,
      readStates: s.readStates.replaceAt(index, EFFECT_SETTLED),
      ...s
    }
    if (s.readStates.nth(index) == EFFECT_ABANDONED) settled
    else if (not(deadlinePendingAt(s.now, s.deadline))) {
      val cancelled = { readAborts: s.readAborts + 1, ...settled }
      val measured = readDone(metric(cancelled, "error", "cache_read_timeout", 0))
      startSource(measured, REFILL_DENIED, 0)
    }
    else if (failed) {
      val measured = readDone(metric(settled, "error", "cache_read", 0))
      startSource(measured, REFILL_DENIED, 0)
    }
    else if (s.reply > NO_QUEUED_REPLY) {
      // Normalize semantic adapter observations before choosing traversal or refill.
      val validFence = s.tracked == TRACKED and (
        s.reply == REPLY_UNKNOWN_WITH_FENCE or s.reply == REPLY_ABSENT_WITH_FENCE or
        s.reply == REPLY_FENCED_WITH_VALID_FENCE)
      val reason = if (
        s.reply == REPLY_FRACTIONAL_FENCE or s.reply == REPLY_UNSAFE_FENCE or
        s.reply == REPLY_ABSENT_WITH_FENCE or s.reply == REPLY_MISS_WITH_FRAME_FIELDS
      ) "value_absent"
        else if (s.reply == REPLY_EXPIRED_ZERO_FENCE) "expired"
        else if (s.reply == REPLY_FENCED_WITH_VALID_FENCE and validFence) "watermark_fenced"
        else "unclassified"
      if (s.reply == REPLY_FRAME_WITH_MISS_FIELDS and s.replyAt <= s.wall) {
        phase: DECODE_PENDING, loads: s.loads + 1, decodeStarted: s.now, ...settled
      }
      else {
        val observed = if (s.reply == REPLY_FRAME_WITH_MISS_FIELDS)
          metric(settled, "futureOffset", "", s.replyAt - s.wall) else settled
        startSource(
          readDone(metric(observed, "miss", reason, 0)), REFILL_ALLOWED,
          if (validFence) s.replyAt + FUTURE_BUFFER_MS else 0)
      }
    }
    else if (readable) {
      phase: DECODE_PENDING, loads: s.loads + 1, decodeStarted: s.now, ...settled
    }
    else {
      val observed = if (unfenced)
        metric(settled, "futureOffset", "", s.storedTimestamp - s.wall) else settled
      val reason = if (unfenced) "unclassified"
        else if (s.storedTimestamp == 0) "value_absent" else "watermark_fenced"
      startSource(
        readDone(metric(observed, "miss", reason, 0)), REFILL_ALLOWED,
        if (s.tracked == UNTRACKED or unfenced) 0 else s.watermark)
    }
  }
  action releaseRead = {
    nondet choice = s.readStates.indices().filter(i => s.readStates.nth(i) != EFFECT_SETTLED).oneOf()
    all {
      input' = { name: "releaseRead", choice: choice },
      s' = settledRead(choice, false)
    }
  }

  action failRead = {
    nondet choice = s.readStates.indices().filter(i => s.readStates.nth(i) != EFFECT_SETTLED).oneOf()
    all {
      input' = { name: "failRead", choice: choice },
      s' = settledRead(choice, true)
    }
  }

  action releaseLoad = all {
    input' = { name: "releaseLoad", choice: -1 },
    s.phase == DECODE_PENDING,
    // The acquired snapshot survives subsequent invalidation and time passage.
    s' = { phase: IDLE, calls: finishPendingCalls(s.calls, CALL_VALUE), ...decoded(s, false) }
  }

  action failLoad = all {
    input' = { name: "failLoad", choice: -1 },
    s.phase == DECODE_PENDING,
    s' = startSource(decoded(s, true), REFILL_ALLOWED, 0)
  }

  // Source acceptance and application-owned publication ----------------------
  def settledSource(index: int, failed: bool): State = {
    val settled = { sources: s.sources.replaceAt(index, EFFECT_SETTLED), ...s }
    val measured = if (s.sources.nth(index) == EFFECT_ABANDONED) settled
      else sourceDone(settled, failed or not(deadlinePendingAt(s.now, s.deadline)))
    if (s.sources.nth(index) == EFFECT_ABANDONED) measured
    else if (not(deadlinePendingAt(s.now, s.deadline))) {
      phase: IDLE, calls: finishPendingCalls(s.calls, CALL_TIMEOUT), ...measured
    }
    else if (failed) {
      phase: IDLE, calls: finishPendingCalls(s.calls, CALL_SOURCE_ERROR), ...measured
    }
    else if (s.refill == REFILL_DENIED or not(fenceAllows(s.wall, s.observedFence))) {
      phase: IDLE, calls: finishPendingCalls(s.calls, CALL_VALUE), ...measured
    }
    else {
      phase: SERIALIZE_PENDING, dumps: s.dumps + 1,
      acceptedAt: s.now, acceptedWall: s.wall,
      ...measured
    }
  }
  action resolveLoader = {
    nondet choice = s.sources.indices().filter(i => s.sources.nth(i) != EFFECT_SETTLED).oneOf()
    all {
      input' = { name: "resolveLoader", choice: choice },
      s' = settledSource(choice, false)
    }
  }

  action rejectLoader = {
    nondet choice = s.sources.indices().filter(i => s.sources.nth(i) != EFFECT_SETTLED).oneOf()
    all {
      input' = { name: "rejectLoader", choice: choice },
      s' = settledSource(choice, true)
    }
  }

  action releaseDump = all {
    input' = { name: "releaseDump", choice: -1 },
    s.phase == SERIALIZE_PENDING,
    // The native write is stamped after serialization, not at source acceptance.
    val prepared = serialized(s, false)
    s' = if (not(fenceAllows(s.wall, s.observedFence))) {
      phase: IDLE, calls: finishPendingCalls(s.calls, CALL_VALUE), ...prepared
    } else {
      phase: WRITE_PENDING, writes: s.writes + 1, writeTimestamp: s.wall,
      ...emit(prepared, "writeDispatch", "remote", "", s.writes)
    }
  }

  action failDump = all {
    input' = { name: "failDump", choice: -1 },
    s.phase == SERIALIZE_PENDING,
    s' = { phase: IDLE, calls: finishPendingCalls(s.calls, CALL_VALUE), ...serialized(s, true) }
  }

  action releaseWrite = all {
    input' = { name: "releaseWrite", choice: -1 },
    s.phase == WRITE_PENDING,
    s' = { storedTimestamp: s.writeTimestamp, phase: IDLE, calls: finishPendingCalls(s.calls, CALL_VALUE), ...s }
  }

  action failWrite = all {
    input' = { name: "failWrite", choice: -1 },
    s.phase == WRITE_PENDING,
    s' = {
      phase: IDLE, calls: finishPendingCalls(s.calls, CALL_VALUE),
      ...metric(s, "error", "cache_write", 0)
    }
  }

  // Environmental clock, storage, policy, and failure inputs ------------------
  action tick = {
    val advanced = { now: s.now + CLOCK_STEP_MS, wall: s.wall + CLOCK_STEP_MS, ...s }
    all {
      input' = { name: "tick", choice: -1 },
      s' = if (s.phase == READ_PENDING and not(deadlinePendingAt(s.now + CLOCK_STEP_MS, s.deadline))) {
        val cancelled = {
          readStates: s.readStates.replaceAt(s.activeRead, EFFECT_ABANDONED),
          readAborts: s.readAborts + 1,
          ...advanced
        }
        val measured = readDone(metric(cancelled, "error", "cache_read_timeout", 0))
        startSource(measured, REFILL_DENIED, 0)
      }
      else if (s.phase == SOURCE_RUNNING) {
        phase: IDLE,
        sources: s.sources.replaceAt(s.activeLoader, EFFECT_ABANDONED),
        calls: finishPendingCalls(s.calls, CALL_TIMEOUT),
        ...sourceDone(advanced, true)
      }
      else advanced
    }
  }

  // Clock observation without timer delivery also exercises settlement guards.
  action jumpClock = all {
    input' = { name: "jumpClock", choice: -1 },
    s.phase != READ_PENDING or s.readBudgets.nth(s.activeRead) == 10,
    s' = { now: s.now + CLOCK_STEP_MS, wall: s.wall + CLOCK_STEP_MS, ...s }
  }

  action rollbackWall = all {
    input' = { name: "rollbackWall", choice: -1 },
    s' = { wall: s.wall - WALL_ROLLBACK_MS, ...s }
  }

  action seedRemote = all {
    input' = { name: "seedRemote", choice: -1 },
    s' = { storedTimestamp: s.wall, ...s }
  }

  action invalidate = all {
    input' = { name: "invalidate", choice: -1 },
    s' = {
      invalidations: s.invalidations + 1,
      watermark: if (s.wall > s.watermark) s.wall else s.watermark, ...metric(s, "invalidation", "", 0)
    }
  }

  action futureFence = all {
    input' = { name: "futureFence", choice: -1 },
    s' = {
      invalidations: s.invalidations + 1,
      watermark: if (s.wall + FUTURE_BUFFER_MS > s.watermark) s.wall + FUTURE_BUFFER_MS else s.watermark,
      ...metric(s, "invalidation", "", 0)
    }
  }

  // One queued external reply, consumed by the next successfully settled raw read,
  // including abandoned reads. 0 means the normal fake Redis environment.
  action replyWith(code: int): bool = all {
    input' = { name: "adapterReply", choice: code },
    s.reply == NO_QUEUED_REPLY,
    s' = { reply: code, replyAt: s.wall, ...s }
  }
  action adapterReply = {
    nondet choice = 1.to(16).oneOf()
    replyWith(choice)
  }

  action readBudgetPolicy = {
    // Choice zero inherits the fixture's resolved base; 1..4 override it.
    nondet choice = 0.to(4).oneOf()
    all {
      input' = { name: "readBudgetPolicy", choice: choice },
      s' = {
        readBudget: if (choice == 0) s.baseReadBudget else List(0, 10, 20, 30, 50).nth(choice),
        ...s
      }
    }
  }

  action observerFaultWith(code: int): bool = all {
    input' = { name: "observerFault", choice: code }, s' = { observerFailed: code, ...s }
  }
  action observerFault = {
    nondet choice = Set(0, 1).oneOf()
    observerFaultWith(choice)
  }

  // Exploration schedule: preserve grouping and order for seeded sampling.
  action step = any {
    beginCall,
    any { releaseRead, releaseLoad, resolveLoader, releaseDump, releaseWrite },
    any { failRead, failLoad, rejectLoader, failDump, failWrite },
    // Favor the narrow second-fence check as well as unrestricted clock changes.
    all { s.phase == SERIALIZE_PENDING and s.observedFence > 0, rollbackWall },
    any {
      tick, jumpClock, seedRemote,
      any { rollbackWall, invalidate, futureFence, observerFault, readBudgetPolicy, adapterReply }
    }
  }

  // Invariants: independent checks over state and observed history.
  val oneRegisteredSource = s.sources.select(state => state == EFFECT_REGISTERED).length() <= 1
  val registeredFlightHasPendingCalls = s.phase == IDLE or s.calls.select(result => result == CALL_PENDING).length() > 0
  val writeRequiresAcceptedSource = (s.phase != WRITE_PENDING and s.phase != SERIALIZE_PENDING) or
    (s.sources.nth(s.activeLoader) == EFFECT_SETTLED and s.acceptedAt < s.deadline and
      s.acceptedWall > s.observedFence and s.refill == REFILL_ALLOWED)
  val registeredReadOwnsFlight =
    s.readStates.select(state => state == EFFECT_REGISTERED).length() == (if (s.phase == READ_PENDING) 1 else 0) and
    (s.phase != READ_PENDING or s.readStates.nth(s.activeRead) == EFFECT_REGISTERED)
  val oneRequestPerRead = s.events.select(e => e.event == "request").length() == s.reads
  val oneSourceDurationPerSettlement = s.events.select(e => e.event == "fallback").length() ==
    s.loaders - (if (s.phase == SOURCE_RUNNING) 1 else 0)
  val measurementsAreNonnegative = s.events.select(e => e.amount < 0).length() == 0
  val effectCountsMatchRecords = s.reads == s.readStates.length() and
    s.reads == s.readBudgets.length() and s.loaders == s.sources.length()

  val futureOffsetsArePositiveAtObservingLayer = s.events.indices().forall(i => {
    val event = s.events.nth(i)
    event.event != "futureOffset" or (event.location == "remote" and event.amount > 0)
  })

  // Deterministic model regressions ------------------------------------------
  action tenMillisecondFixture = initialized(FIXTURE_OPERATION_BUDGET)

  run unknownReasonKeepsValidFenceTest = tenMillisecondFixture.then(beginCall)
    .then(all { input' = input, s' = { reply: REPLY_UNKNOWN_WITH_FENCE, replyAt: s.wall, ...s } }).then(releaseRead).then(resolveLoader)
    .expect(s.calls == List(CALL_VALUE) and s.dumps == 0 and
      s.events.select(e => e.event == "miss").nth(0).detail == "unclassified")
  run untrackedReplyCannotCarryFenceTest = initialized(FIXTURE_UNTRACKED).then(beginCall)
    .then(all { input' = input, s' = { reply: REPLY_FENCED_WITH_VALID_FENCE, replyAt: s.wall, ...s } }).then(releaseRead).then(resolveLoader)
    .expect(s.dumps == 1 and s.observedFence == 0 and s.events.select(e => e.event == "miss").nth(0).detail == "unclassified")
  run missDiscriminatorWinsOverFrameFieldsTest = tenMillisecondFixture.then(beginCall)
    .then(all { input' = input, s' = { reply: REPLY_MISS_WITH_FRAME_FIELDS, replyAt: s.wall, ...s } }).then(releaseRead)
    .expect(s.loads == 0 and s.loaders == 1)
  run frameWithoutMissDiscriminatorIgnoresMetadataTest = tenMillisecondFixture.then(beginCall)
    .then(all { input' = input, s' = { reply: REPLY_FRAME_WITH_MISS_FIELDS, replyAt: s.wall, ...s } }).then(releaseRead).then(releaseLoad)
    .expect(s.calls == List(CALL_VALUE) and s.loaders == 0)
  run readDurationIncludesDecodeTest = tenMillisecondFixture.then(seedRemote).then(beginCall).then(releaseRead)
    .then(tick).then(releaseLoad)
    .expect(s.events.select(e => e.event == "get").foldl(List(), (out, e) => out.append(e.amount)) == List(10))
  run sourceDurationExcludesPublicationTest = tenMillisecondFixture.then(beginCall).then(releaseRead).then(resolveLoader)
    .then(tick).then(releaseDump).then(tick).then(releaseWrite)
    .expect(s.events.select(e => e.event == "fallback").foldl(List(), (out, e) => out.append(e.amount)) == List(0) and
      s.events.select(e => e.event == "serialization").foldl(List(), (out, e) => out.append(e.amount)) == List(10))
  run lateSourceCannotRepeatFailureMetricTest = tenMillisecondFixture.then(beginCall).then(releaseRead)
    .then(tick).then(rejectLoader).expect(s.events.select(e => e.event == "error" and e.detail == "fallback").length() == 1)
  run timedOutLoaderOverlapsNewFlightTest = tenMillisecondFixture.then(beginCall).then(releaseRead).then(tick)
    .then(beginCall).then(releaseRead)
    .expect(s.sources == List(EFFECT_ABANDONED, EFFECT_REGISTERED) and s.calls == List(CALL_TIMEOUT, CALL_PENDING))
  run acceptedWriteOutlivesDeadlineTest = tenMillisecondFixture.then(beginCall).then(releaseRead).then(resolveLoader)
    .then(tick).then(releaseDump).then(tick).expect(s.phase == WRITE_PENDING and s.calls == List(CALL_PENDING))
    .then(releaseWrite).expect(s.calls == List(CALL_VALUE))
  run delayedWriteRemainsFencedTest = tenMillisecondFixture.then(beginCall).then(releaseRead).then(resolveLoader)
    .then(releaseDump).then(tick).then(invalidate).then(releaseWrite).then(beginCall).then(releaseRead)
    .expect(not(readable) and s.calls == List(CALL_VALUE, CALL_PENDING) and s.loaders == 2)
  run readTimeoutStartsIndependentSourceDeadlineTest = tenMillisecondFixture.then(beginCall).then(beginCall).then(tick)
    .expect(s.calls == List(CALL_PENDING, CALL_PENDING) and s.deadline == 10020 and s.readAborts == 1)
    .then(resolveLoader).expect(s.calls == List(CALL_VALUE, CALL_VALUE) and s.dumps == 0 and s.writes == 0)
  run lateReadCannotBecomeHitTest = tenMillisecondFixture.then(seedRemote).then(beginCall).then(jumpClock).then(releaseRead)
    .expect(s.loads == 0 and s.loaders == 1 and s.readAborts == 1)
  run acquiredDecodeSurvivesInvalidationAndDeadlineTest = tenMillisecondFixture.then(seedRemote).then(beginCall)
    .then(releaseRead).then(tick).then(invalidate).then(releaseLoad)
    .expect(s.calls == List(CALL_VALUE) and s.loaders == 0 and s.readAborts == 0)
  run readFailureNeverRefillsTest = tenMillisecondFixture.then(beginCall).then(failRead).then(resolveLoader)
    .expect(s.calls == List(CALL_VALUE) and s.dumps == 0 and s.readAborts == 0)
  run decodeFailureMayRefillTest = tenMillisecondFixture.then(seedRemote).then(beginCall).then(releaseRead).then(failLoad)
    .then(resolveLoader).then(releaseDump).then(releaseWrite)
    .expect(s.calls == List(CALL_VALUE) and s.loads == 1 and s.writes == 1)
  run dumpFailurePreservesSourceTest = tenMillisecondFixture.then(beginCall).then(releaseRead).then(resolveLoader).then(failDump)
    .expect(s.calls == List(CALL_VALUE) and s.writes == 0)
  run writeFailurePreservesSourceTest = tenMillisecondFixture.then(beginCall).then(releaseRead).then(resolveLoader)
    .then(releaseDump).then(failWrite).expect(s.calls == List(CALL_VALUE) and s.storedTimestamp == 0)
  run rollbackDuringDumpRechecksObservedFenceTest = tenMillisecondFixture.then(invalidate).then(tick)
    .then(beginCall).then(releaseRead).then(resolveLoader).then(rollbackWall).then(releaseDump)
    .expect(s.calls == List(CALL_VALUE) and s.dumps == 1 and s.writes == 0)
  run rollbackDoesNotExtendSourceDeadlineTest = tenMillisecondFixture.then(beginCall).then(releaseRead)
    .then(rollbackWall).then(tick).expect(s.calls == List(CALL_TIMEOUT))
  run observerFailuresCannotReplaceSourceErrorTest = tenMillisecondFixture.then(observerFaultWith(1))
    .then(beginCall).then(failRead).then(rejectLoader).expect(s.calls == List(CALL_SOURCE_ERROR))
  run libraryReadBudgetIsFiftyMillisecondsTest = initialized(FIXTURE_LIBRARY_BUDGET).then(beginCall)
    .then(tick).then(tick).then(tick).then(tick).expect(s.phase == READ_PENDING and s.loaders == 0)
    .then(tick).expect(s.phase == SOURCE_RUNNING and s.deadline == 10060 and s.readBudgets == List(50))
  run followerKeepsAcceptedReadBudgetTest = initialized(FIXTURE_RUNTIME_BUDGET).then(beginCall)
    .then(all { input' = input, s' = { readBudget: 10, ...s } }).then(beginCall).then(tick).then(tick)
    .expect(s.phase == READ_PENDING and s.readBudgets == List(30) and s.calls == List(CALL_PENDING, CALL_PENDING))
    .then(tick).expect(s.phase == SOURCE_RUNNING and s.deadline == 10040 and s.readAborts == 1)

  // Deadline acceptance is checked when raw work settles, even if timer
  // delivery has not run. Rejection must receive the same deadline treatment
  // as fulfillment, without being recategorized as an ordinary adapter error.
  run lateReadRejectionUsesDeadlineCategoryTest = tenMillisecondFixture
    .then(beginCall).then(jumpClock).then(failRead)
    .expect(s.readAborts == 1 and s.loaders == 1 and s.refill == REFILL_DENIED and
      s.events.select(e => e.event == "error").foldl(List(), (out, e) => out.append(e.detail)) == List("cache_read_timeout"))

  run successfulReadClearsDeadlineBeforeDecodeTest = tenMillisecondFixture
    .then(seedRemote).then(beginCall).then(releaseRead).then(tick).then(tick)
    .then(releaseLoad)
    .expect(s.calls == List(CALL_VALUE) and s.readAborts == 0 and s.loaders == 0)

  // Each failure has its own diagnostic phase. The result and mutation
  // consequences are checked alongside the label; observing a label alone
  // would not establish fail-open behavior.
  run readFailureKeepsCategoryAndDeniesRefillTest = tenMillisecondFixture
    .then(beginCall).then(failRead).then(resolveLoader)
    .expect(s.calls == List(CALL_VALUE) and s.dumps == 0 and s.writes == 0 and
      s.events.select(e => e.event == "error").foldl(List(), (out, e) => out.append(e.detail)) == List("cache_read"))

  run decodeFailureKeepsCategoryAndAllowsRefillTest = tenMillisecondFixture
    .then(seedRemote).then(beginCall).then(releaseRead).then(failLoad)
    .then(resolveLoader).then(releaseDump).then(releaseWrite)
    .expect(s.calls == List(CALL_VALUE) and s.writes == 1 and
      s.events.select(e => e.event == "error").foldl(List(), (out, e) => out.append(e.detail)) == List("serialization_load"))

  run dumpFailureKeepsCategoryAndSourceValueTest = tenMillisecondFixture
    .then(beginCall).then(releaseRead).then(resolveLoader).then(failDump)
    .expect(s.calls == List(CALL_VALUE) and s.writes == 0 and
      s.events.select(e => e.event == "error").foldl(List(), (out, e) => out.append(e.detail)) == List("serialization_dump"))

  run writeFailureKeepsCategoryAndSourceValueTest = tenMillisecondFixture
    .then(beginCall).then(releaseRead).then(resolveLoader).then(releaseDump).then(failWrite)
    .expect(s.calls == List(CALL_VALUE) and s.storedTimestamp == 0 and
      s.events.select(e => e.event == "error").foldl(List(), (out, e) => out.append(e.detail)) == List("cache_write"))

  // Observer failure is an external callback condition. Its isolation preserves
  // traversal, public outcomes and accepted publication, not merely event count.
  run observerFailuresCannotPreventCacheHitTest = tenMillisecondFixture
    .then(observerFaultWith(1)).then(seedRemote)
    .then(beginCall).then(releaseRead).then(releaseLoad)
    .expect(s.calls == List(CALL_VALUE) and s.loaders == 0 and s.loads == 1 and s.writes == 0)
  run observerFailuresCannotPreventPublicationTest = tenMillisecondFixture
    .then(observerFaultWith(1)).then(beginCall).then(releaseRead)
    .then(resolveLoader).then(releaseDump).then(releaseWrite)
    .then(beginCall).then(releaseRead).then(releaseLoad)
    .expect(s.calls == List(CALL_VALUE, CALL_VALUE) and s.loaders == 1
      and s.reads == 2 and s.loads == 1 and s.dumps == 1 and s.writes == 1)

  // Source acceptance precedes the native frame stamp. A serialization delay
  // and intervening invalidation make the distinction visible to the next read.
  run writeStampAfterSerializationClearsInterveningFenceTest = tenMillisecondFixture
    .then(beginCall).then(releaseRead).then(resolveLoader).then(invalidate)
    .then(tick).then(releaseDump).then(releaseWrite)
    .expect(s.acceptedWall == 100000 and s.storedTimestamp == 100010 and s.watermark == 100000)
    .then(beginCall).then(releaseRead).then(releaseLoad)
    .expect(s.calls == List(CALL_VALUE, CALL_VALUE) and s.loaders == 1
      and s.loads == 1 and s.writes == 1)

  run instanceReadBudgetOverridesLibraryTest = initialized(FIXTURE_INSTANCE_BUDGET)
    .then(beginCall).then(tick).expect(s.calls == List(CALL_PENDING) and s.loaders == 0)
    .then(tick).then(resolveLoader)
    .expect(s.readBudgets == List(20) and s.readAborts == 1
      and s.calls == List(CALL_VALUE) and s.loaders == 1 and s.dumps == 0)
  run operationReadBudgetOverridesInstanceTest = initialized(FIXTURE_OPERATION_BUDGET)
    .then(beginCall).then(tick).then(resolveLoader)
    .expect(s.readBudgets == List(10) and s.readAborts == 1
      and s.calls == List(CALL_VALUE) and s.loaders == 1 and s.dumps == 0)
  run runtimeReadBudgetOverridesOperationTest = initialized(FIXTURE_RUNTIME_BUDGET)
    .then(beginCall).then(tick).then(tick).expect(s.calls == List(CALL_PENDING) and s.loaders == 0)
    .then(tick).then(resolveLoader)
    .expect(s.readBudgets == List(30) and s.readAborts == 1
      and s.calls == List(CALL_VALUE) and s.loaders == 1 and s.dumps == 0)

  // Amounts are model milliseconds, converted once to public seconds by both
  // projections. This is the serving remote location; shadow locations are a
  // separate interaction, not implied by this assertion.
  run futureFrameReportsPositiveObservingOffsetTest = tenMillisecondFixture
    .then(seedRemote).then(rollbackWall).then(beginCall).then(releaseRead).then(rejectLoader)
    .expect(s.calls == List(CALL_SOURCE_ERROR) and s.loads == 0 and s.loaders == 1
      and s.events.select(e => e.event == "futureOffset") ==
        List({ event: "futureOffset", location: "remote", detail: "", amount: 1000 }))

  run coalescedFailureKeepsOneLeaderAndFollowerTrailTest = tenMillisecondFixture
    .then(beginCall).then(beginCall).then(failRead).then(rejectLoader)
    .expect(s.calls == List(CALL_SOURCE_ERROR, CALL_SOURCE_ERROR)
      and s.reads == 1 and s.loaders == 1 and s.loads == 0 and s.writes == 0)
    .expect(s.events.select(e => e.event == "request" or e.event == "coalesced" or e.event == "error") == List(
      { event: "request", location: "remote", detail: "", amount: 0 },
      { event: "coalesced", location: "process", detail: "", amount: 0 },
      { event: "error", location: "remote", detail: "cache_read", amount: 0 },
      { event: "error", location: "remote", detail: "fallback", amount: 0 }))

  run nullReplyRefillsAndIsReadableTest = tenMillisecondFixture.then(replyWith(1))
    .then(beginCall).then(releaseRead).then(resolveLoader).then(releaseDump).then(releaseWrite)
    .then(beginCall).then(releaseRead).then(releaseLoad)
    .expect(s.calls == List(CALL_VALUE, CALL_VALUE) and s.loads == 1 and s.loaders == 1
      and s.reads == 2 and s.dumps == 1 and s.writes == 1)
    .expect(s.events.select(e => e.event == "miss").foldl(List(), (out, e) => out.append(e.detail)) == List("unclassified"))

  run primitiveReplyRefillsAndIsReadableTest = tenMillisecondFixture.then(replyWith(2))
    .then(beginCall).then(releaseRead).then(resolveLoader).then(releaseDump).then(releaseWrite)
    .then(beginCall).then(releaseRead).then(releaseLoad)
    .expect(s.calls == List(CALL_VALUE, CALL_VALUE) and s.loads == 1 and s.loaders == 1
      and s.reads == 2 and s.dumps == 1 and s.writes == 1)
    .expect(s.events.select(e => e.event == "miss").foldl(List(), (out, e) => out.append(e.detail)) == List("unclassified"))

  run legacyReplyRefillsAndIsReadableTest = tenMillisecondFixture.then(replyWith(3))
    .then(beginCall).then(releaseRead).then(resolveLoader).then(releaseDump).then(releaseWrite)
    .then(beginCall).then(releaseRead).then(releaseLoad)
    .expect(s.calls == List(CALL_VALUE, CALL_VALUE) and s.loads == 1 and s.loaders == 1
      and s.reads == 2 and s.dumps == 1 and s.writes == 1)
    .expect(s.events.select(e => e.event == "miss").foldl(List(), (out, e) => out.append(e.detail)) == List("unclassified"))

  run kindlessReplyRefillsAndIsReadableTest = tenMillisecondFixture.then(replyWith(4))
    .then(beginCall).then(releaseRead).then(resolveLoader).then(releaseDump).then(releaseWrite)
    .then(beginCall).then(releaseRead).then(releaseLoad)
    .expect(s.calls == List(CALL_VALUE, CALL_VALUE) and s.loads == 1 and s.loaders == 1
      and s.reads == 2 and s.dumps == 1 and s.writes == 1)
    .expect(s.events.select(e => e.event == "miss").foldl(List(), (out, e) => out.append(e.detail)) == List("unclassified"))

  run missingFenceRefillsAndIsReadableTest = tenMillisecondFixture.then(replyWith(8))
    .then(beginCall).then(releaseRead).then(resolveLoader).then(releaseDump).then(releaseWrite)
    .then(beginCall).then(releaseRead).then(releaseLoad)
    .expect(s.calls == List(CALL_VALUE, CALL_VALUE) and s.loads == 1 and s.loaders == 1
      and s.reads == 2 and s.dumps == 1 and s.writes == 1)
    .expect(s.events.select(e => e.event == "miss").foldl(List(), (out, e) => out.append(e.detail)) == List("unclassified"))

  run negativeFenceRefillsAndIsReadableTest = tenMillisecondFixture.then(replyWith(9))
    .then(beginCall).then(releaseRead).then(resolveLoader).then(releaseDump).then(releaseWrite)
    .then(beginCall).then(releaseRead).then(releaseLoad)
    .expect(s.calls == List(CALL_VALUE, CALL_VALUE) and s.loads == 1 and s.loaders == 1
      and s.reads == 2 and s.dumps == 1 and s.writes == 1)
    .expect(s.events.select(e => e.event == "miss").foldl(List(), (out, e) => out.append(e.detail)) == List("unclassified"))

  run fractionalFenceRefillsAndIsReadableTest = tenMillisecondFixture.then(replyWith(10))
    .then(beginCall).then(releaseRead).then(resolveLoader).then(releaseDump).then(releaseWrite)
    .then(beginCall).then(releaseRead).then(releaseLoad)
    .expect(s.calls == List(CALL_VALUE, CALL_VALUE) and s.loads == 1 and s.loaders == 1
      and s.reads == 2 and s.dumps == 1 and s.writes == 1)
    .expect(s.events.select(e => e.event == "miss").foldl(List(), (out, e) => out.append(e.detail)) == List("value_absent"))

  run unsafeFenceRefillsAndIsReadableTest = tenMillisecondFixture.then(replyWith(11))
    .then(beginCall).then(releaseRead).then(resolveLoader).then(releaseDump).then(releaseWrite)
    .then(beginCall).then(releaseRead).then(releaseLoad)
    .expect(s.calls == List(CALL_VALUE, CALL_VALUE) and s.loads == 1 and s.loaders == 1
      and s.reads == 2 and s.dumps == 1 and s.writes == 1)
    .expect(s.events.select(e => e.event == "miss").foldl(List(), (out, e) => out.append(e.detail)) == List("value_absent"))

  // Untracked reads demote a fenced-miss reply to an ordinary miss. Observe the
  // consequence through publication and a later hit, using only public inputs.
  run untrackedFencedReplyRefillsAndIsReadableTest = initialized(FIXTURE_UNTRACKED)
    .then(replyWith(REPLY_FENCED_WITH_VALID_FENCE)).then(beginCall).then(releaseRead)
    .then(resolveLoader).then(releaseDump).then(releaseWrite)
    .then(beginCall).then(releaseRead).then(releaseLoad)
    .expect(s.calls == List(CALL_VALUE, CALL_VALUE) and s.observedFence == 0
      and s.loads == 1 and s.loaders == 1 and s.reads == 2 and s.dumps == 1 and s.writes == 1)
    .expect(s.events.select(e => e.event == "miss").foldl(List(), (out, e) => out.append(e.detail)) == List("unclassified"))

}
