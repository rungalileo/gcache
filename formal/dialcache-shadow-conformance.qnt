module dialcache_shadow_conformance {
  import conformance_observations.* from "./conformance-observations"
  // Model boundary -----------------------------------------------------------
  // One ramped-down caller source and its selected dark C0/source/C1 job.
  // Selected rules from C47/C49-C54 govern admission, comparison, fill authority,
  // and timeout ownership; C57/C60 cover snapshot age and captured logging.
  // See BEHAVIOR.md: "Generated feature profiles" for fixtures and payloads.
  // Each source/read/decode/serialize/write can remain externally pending. This
  // profile excludes serving hits, request/local storage, and overlapping jobs.
  // `now` is elapsed milliseconds; `wall` is independent application time.
  // C0, fence, accepted logging, and dispatched write stamp are retained history.
  // C0 must be strictly younger than sixty seconds. C1 checks payload bytes
  // independently of logical age; application time may change while it waits.

  // Trace encodings and fixture bounds ---------------------------------------
  pure val IDLE = 0
  pure val C0_READ = 1
  pure val SOURCE_WAIT = 2
  pure val SNAPSHOT_DECODE = 3
  pure val CONFIRMATION_READ = 4
  pure val FILL_SERIALIZE = 5
  pure val FILL_WRITE = 6
  pure val JOB_DONE = 7
  pure val SOURCE_NOT_STARTED = 0
  pure val SOURCE_PENDING = 1
  pure val SOURCE_ACCEPTED = 2
  pure val SOURCE_FAILED = 3
  pure val SOURCE_TIMED_OUT = 4
  pure val COMPARE_DEFAULT = 0
  pure val COMPARE_EQUAL = 1
  pure val COMPARE_UNEQUAL = 2
  pure val COMPARE_ERROR = 3
  pure val COMPARATOR_COUNT = 4
  pure val FIRST_LOGGING_FIXTURE = 4
  pure val FIXTURE_NO_HOOK = 8
  pure val FIXTURE_SLOW_EQUAL = 9
  pure val FIXTURE_SLOW_ERROR = 10
  pure val FIXTURE_SOURCE_WORK_BEFORE_DEADLINE = 11
  pure val FIXTURE_SOURCE_WORK_AT_DEADLINE = 12
  pure val SHADOW_ENABLED = 0
  pure val SHADOW_DISABLED = 1
  pure val SHADOW_INVALID = 2
  pure val LOGGING_DISABLED = 0
  pure val LOGGING_ENABLED = 1
  pure val LOGGING_INVALID = 2
  pure val JOB_BUDGET_MS = 10
  pure val FRESHNESS_MS = 60000
  pure val WALL_ROLLBACK_MS = 1000
  pure val MAX_CALLS = 8

  // Payload identity is not decoded value identity. The Unicode fixture's
  // decoded symbol is 3; it never becomes a caller result in this profile.
  pure val NO_PAYLOAD = 0
  pure val TEXT_ONE = 1
  pure val TEXT_TWO = 2
  pure val BINARY_ONE = 3
  pure val BINARY_TWO = 4
  pure val BINARY_PADDED_ONE = 5
  pure val TEXT_PADDED_ONE = 6
  pure val TEXT_UNICODE = 7
  pure val BINARY_UNICODE = 8
  pure val DECODED_UNICODE = 3

  // Shadow profile v3 retains explicit external inputs and future timestamp
  // samples as well as verdict age, captured logging, and configuration errors.
  type ShadowDiagnostics = {
    configErrors: int, warnings: int, ages: List[int],
    coalesced: List[str], fallbackErrors: List[str],
    futureOffsets: List[{ layer: str, offsetMs: int }]
  }

  // State: diagnostics, independent source/job lifecycles, and remote bytes.
  type State = {
    o: Observation, d: ShadowDiagnostics,
    now: int, wall: int, comparator: int, comparisonMs: int, sourceWorkMs: int,
    hook: bool, shadowActive: bool, defaultLog: bool, log: bool, acceptedLog: bool,
    invalidShadow: bool, invalidLog: bool, acceptedInvalidLog: bool,
    mismatchAuthorizations: List[bool],
    c0Created: int, deadline: int, phase: int, source: int,
    sourcePending: bool, sourceValue: int, abandoned: bool,
    frame: int, created: int, watermark: int, c0: int, fence: int, writeStamp: int,
    readFailed: bool, loadFailed: bool, dumpFailed: bool, writeFailed: bool
  }
  var s: State
  var input: { name: str, choice: int }

  // Snapshot identity and job completion -------------------------------------
  // Text and binary representations can share bytes; different JSON bytes
  // can still decode to the same value. C1 uses bytes, C0/S uses decoded values.
  pure def payloadBytes(payload: int): int =
    if (payload == BINARY_ONE) TEXT_ONE
    else if (payload == BINARY_TWO) TEXT_TWO
    else if (payload == TEXT_PADDED_ONE) BINARY_PADDED_ONE
    else if (payload == BINARY_UNICODE) TEXT_UNICODE
    else payload
  pure def payloadValue(payload: int): int =
    if (payload >= TEXT_UNICODE) DECODED_UNICODE
    else if (payload == BINARY_ONE or payload == BINARY_PADDED_ONE or payload == TEXT_PADDED_ONE) VALUE_ONE
    else if (payload == BINARY_TWO) VALUE_TWO
    else payload
  pure def done(st: State, outcome: str): State = {
    val validated = outcome == "match" or outcome == "mismatch"
    val age = if (st.wall < st.c0Created) 0 else st.wall - st.c0Created
    {
      phase: JOB_DONE,
      mismatchAuthorizations: if (outcome == "mismatch")
        st.mismatchAuthorizations.append(st.acceptedLog and not(st.acceptedInvalidLog))
        else st.mismatchAuthorizations,
      o: { shadow: st.o.shadow.append(outcome), ...st.o },
      d: {
        warnings: st.d.warnings + (if (outcome == "mismatch" and st.acceptedLog) 1 else 0),
        ages: if (validated) st.d.ages.append(age) else st.d.ages,
        ...st.d
      },
      ...st
    }
  }
  pure def continueJob(st: State): State =
    if (st.phase != SOURCE_WAIT or st.source == SOURCE_PENDING) st
    else if (st.source == SOURCE_FAILED) done(st, "source_error")
    else if (st.source == SOURCE_TIMED_OUT) done(st, "timeout")
    else if (st.c0 > NO_PAYLOAD) { phase: SNAPSHOT_DECODE, o: { loads: st.o.loads + 1, ...st.o }, ...st }
    else if (st.wall <= st.fence) done(st, "fill_fenced")
    else { phase: FILL_SERIALIZE, o: { dumps: st.o.dumps + 1, ...st.o }, ...st }

  // Initial fixture ----------------------------------------------------------
  // Input fixtures: default/equal/unequal/error comparator, then the same four
  // with mismatch logging enabled; fixture 8 omits the outcome hook.
  // Fixtures 9/10 let successful/failing comparison consume the job budget.
  // Fixtures 11/12 consume 9/10 ms of synchronous external source work before
  // deferred job dispatch. This advances elapsed time without delivering
  // timers: job admission and eventual caller settlement remain separate.
  // Policy changes are captured at admission.
  action initialize(choice: int): bool = all {
    input' = { name: "init", choice: choice },
    s' = {
      o: empty, d: { configErrors: 0, warnings: 0, ages: List(), coalesced: List(), fallbackErrors: List(), futureOffsets: List() },
      now: 10000, wall: 100000,
      comparator: if (choice >= FIXTURE_SOURCE_WORK_BEFORE_DEADLINE) COMPARE_DEFAULT
        else if (choice == FIXTURE_SLOW_ERROR) COMPARE_ERROR else choice % COMPARATOR_COUNT,
      comparisonMs: if (choice == FIXTURE_SLOW_EQUAL or choice == FIXTURE_SLOW_ERROR) JOB_BUDGET_MS else 0,
      sourceWorkMs: if (choice == FIXTURE_SOURCE_WORK_AT_DEADLINE) JOB_BUDGET_MS
        else if (choice == FIXTURE_SOURCE_WORK_BEFORE_DEADLINE) JOB_BUDGET_MS - 1 else 0,
      hook: choice != FIXTURE_NO_HOOK, shadowActive: choice != FIXTURE_NO_HOOK,
      defaultLog: choice >= FIRST_LOGGING_FIXTURE and choice < FIXTURE_NO_HOOK,
      log: choice >= FIRST_LOGGING_FIXTURE and choice < FIXTURE_NO_HOOK,
      acceptedLog: false, invalidShadow: false, invalidLog: false, acceptedInvalidLog: false,
      mismatchAuthorizations: List(), c0Created: 0, deadline: 0,
      phase: IDLE, source: SOURCE_NOT_STARTED,
      sourcePending: false, sourceValue: 0, abandoned: false,
      frame: NO_PAYLOAD, created: 0, watermark: 0, c0: NO_PAYLOAD, fence: 0, writeStamp: 0,
      readFailed: false, loadFailed: false, dumpFailed: false, writeFailed: false
    }
  }
  action init = {
    nondet choice = 0.to(FIXTURE_SOURCE_WORK_AT_DEADLINE).oneOf()
    initialize(choice)
  }

  // Caller source and job admission ------------------------------------------
  action beginCall = all {
    input' = { name: "beginCall", choice: -1 },
    (s.phase == IDLE or s.phase == JOB_DONE), not(s.sourcePending), s.o.calls.length() < MAX_CALLS,
    val jobExpired = s.shadowActive and s.sourceWorkMs >= JOB_BUDGET_MS
    s' = {
      now: s.now + s.sourceWorkMs, wall: s.wall + s.sourceWorkMs,
      phase: if (s.shadowActive and not(jobExpired)) C0_READ else JOB_DONE,
      source: SOURCE_PENDING, sourcePending: true, sourceValue: 0,
      abandoned: jobExpired, deadline: s.now + JOB_BUDGET_MS,
      c0: NO_PAYLOAD, c0Created: 0, fence: 0, acceptedLog: s.log,
      acceptedInvalidLog: s.invalidLog,
      d: {
        configErrors: s.d.configErrors + (if (s.invalidShadow or (s.shadowActive and s.invalidLog)) 1 else 0),
        ...s.d
      },
      o: {
        calls: s.o.calls.append(CALL_PENDING), loaders: s.o.loaders + 1,
        reads: s.o.reads + (if (s.shadowActive and not(jobExpired)) 1 else 0), policyCalls: s.o.policyCalls + 1,
        shadow: if (jobExpired) s.o.shadow.append("timeout") else s.o.shadow,
        ...s.o
      },
      ...s
    }
  }
  action resolveAt(choice: int): bool = all {
      input' = { name: "resolveLoader", choice: choice },
      s.sourcePending,
      val expired = s.source == SOURCE_TIMED_OUT or s.now >= s.deadline
      s' = continueJob({
        sourcePending: false,
        source: if (expired) SOURCE_TIMED_OUT else SOURCE_ACCEPTED, sourceValue: choice,
        o: finishPendingCalls(s.o, if (expired) DEADLINE_ERROR else choice),
        d: {
          fallbackErrors: if (expired and s.source != SOURCE_TIMED_OUT) s.d.fallbackErrors.append("local")
            else s.d.fallbackErrors,
          ...s.d
        },
        ...s
      })
    }
  action resolveLoader = {
    nondet choice = Set(VALUE_ONE, VALUE_TWO).oneOf()
    resolveAt(choice)
  }
  action rejectLoader = all {
    input' = { name: "rejectLoader", choice: -1 },
    s.sourcePending,
    val expired = s.source == SOURCE_TIMED_OUT or s.now >= s.deadline
    s' = continueJob({
      sourcePending: false, source: if (expired) SOURCE_TIMED_OUT else SOURCE_FAILED,
      o: finishPendingCalls(s.o, if (expired) DEADLINE_ERROR else SOURCE_ERROR),
      d: {
        fallbackErrors: if (s.source == SOURCE_TIMED_OUT) s.d.fallbackErrors
          else s.d.fallbackErrors.append("local"),
        ...s.d
      },
      ...s
    })
  }

  // C0 acquisition, retained comparison, and C1 confirmation ------------------
  action releaseRead = all {
    input' = { name: "releaseRead", choice: -1 },
    s.phase == C0_READ or s.phase == CONFIRMATION_READ,
    val readable = s.frame > NO_PAYLOAD and s.created > s.watermark
    val snapshot = if (readable) s.frame else NO_PAYLOAD
    // Raw read validation has its own read budget. Within this profile's
    // elapsed-time bounds it may report a future timestamp even after the
    // shorter job budget expired; the abandoned job still cannot continue.
    val measured = {
      d: { futureOffsets: if (not(s.readFailed) and readable and s.created > s.wall)
        s.d.futureOffsets.append({ layer: "remote_shadow", offsetMs: s.created - s.wall })
        else s.d.futureOffsets, ...s.d }, ...s
    }
    s' = if (s.abandoned) { phase: JOB_DONE, ...measured }
      else if (s.phase == CONFIRMATION_READ) done(measured, if (s.readFailed) "confirmation_error"
        else if (payloadBytes(snapshot) == payloadBytes(s.c0)) "mismatch" else "superseded")
      else if (s.readFailed) done(measured, "redis_error")
      else continueJob({
        phase: SOURCE_WAIT,
        c0: if (s.created > s.wall or s.wall - s.created >= FRESHNESS_MS)
          NO_PAYLOAD else snapshot,
        c0Created: s.created,
        fence: if (readable) 0 else s.watermark,
        ...measured
      })
  }
  action releaseLoad = all {
    input' = { name: "releaseLoad", choice: -1 },
    s.phase == SNAPSHOT_DECODE,
    val compared = {
      now: s.now + s.comparisonMs, wall: s.wall + s.comparisonMs,
      o: { comparisons: s.o.comparisons + (if (s.comparator == COMPARE_DEFAULT) 0 else 1), ...s.o },
      ...s
    }
    val valuesMatch = s.comparator == COMPARE_EQUAL or
      (s.comparator == COMPARE_DEFAULT and payloadValue(s.c0) == s.sourceValue)
    s' = if (s.abandoned) { phase: JOB_DONE, ...s }
      else if (s.loadFailed) done(s, "deserialization_error")
      else if (compared.now >= s.deadline) done({ abandoned: true, ...compared }, "timeout")
      else if (s.comparator == COMPARE_ERROR) done(compared, "comparison_error")
      else if (valuesMatch) done(compared, "match")
      else { phase: CONFIRMATION_READ, o: { reads: s.o.reads + 1, ...compared.o }, ...compared }
  }

  // Conditional fill preparation and native write completion ------------------
  action releaseDump = all {
    input' = { name: "releaseDump", choice: -1 },
    s.phase == FILL_SERIALIZE,
    s' = if (s.abandoned) { phase: JOB_DONE, ...s }
      else if (s.dumpFailed) done(s, "fill_error")
      else if (s.wall <= s.fence) done(s, "fill_fenced")
      else {
        phase: FILL_WRITE, writeStamp: s.wall,
        o: { writes: s.o.writes + 1, writeTtls: s.o.writeTtls.append(60000), ...s.o },
        ...s
      }
  }
  action releaseWrite = all {
    input' = { name: "releaseWrite", choice: -1 },
    s.phase == FILL_WRITE,
    val stored = {
      frame: if (s.writeFailed) s.frame else s.sourceValue,
      created: if (s.writeFailed) s.created else s.writeStamp,
      ...s
    }
    s' = if (s.abandoned) { phase: JOB_DONE, ...stored }
      else done(stored, if (s.writeFailed) "fill_error" else "filled")
  }

  // Environmental clocks, storage, policy, and failures -----------------------
  action advanceBy(choice: int): bool = {
    val expired = s.now + choice >= s.deadline
    val callerTimeout = s.source == SOURCE_PENDING and expired
    val jobTimeout = s.phase > IDLE and s.phase < JOB_DONE and not(s.abandoned) and expired
    all {
      input' = { name: "advance", choice: choice },
      s' = {
        d: {
          fallbackErrors: if (callerTimeout) s.d.fallbackErrors.append("local") else s.d.fallbackErrors,
          ...s.d
        },
        now: s.now + choice, wall: s.wall + choice, source: if (callerTimeout) SOURCE_TIMED_OUT else s.source,
        abandoned: s.abandoned or jobTimeout,
        phase: if (jobTimeout and s.phase == SOURCE_WAIT) JOB_DONE else s.phase,
        o: {
          shadow: if (jobTimeout) s.o.shadow.append("timeout") else s.o.shadow,
          ...finishPendingCalls(s.o, if (callerTimeout) DEADLINE_ERROR else CALL_PENDING)
        },
        ...s
      }
    }
  }
  action advance = {
    // Blocked-source fixtures advance a full job budget so due timers run.
    nondet choice = (if (s.sourceWorkMs > 0) Set(JOB_BUDGET_MS) else Set(1, JOB_BUDGET_MS)).oneOf()
    advanceBy(choice)
  }

  action seedAt(choice: int): bool = all {
    input' = { name: "seed", choice: choice },
    s' = { frame: choice, created: s.wall, ...s }
  }
  action seed = {
    nondet choice = TEXT_ONE.to(BINARY_UNICODE).oneOf()
    seedAt(choice)
  }

  // A second external seed choice gives multibyte text/binary identities enough
  // exploration weight alongside the new blocked-source fixtures. The ordinary
  // seed action still admits every payload representation.
  action seedUnicode = {
    nondet choice = Set(TEXT_UNICODE, BINARY_UNICODE).oneOf()
    all {
      input' = { name: "seedUnicode", choice: choice },
      s' = { frame: choice, created: s.wall, ...s }
    }
  }
  // External replacement with identical bytes in the other supported form.
  // This targets confirmation's representation boundary, without fixing its outcome.
  action reencode = {
    nondet choice = Set(List(
      NO_PAYLOAD, BINARY_ONE, BINARY_TWO, TEXT_ONE, TEXT_TWO,
      TEXT_PADDED_ONE, BINARY_PADDED_ONE, BINARY_UNICODE, TEXT_UNICODE
    ).nth(s.frame)).oneOf()
    all { s.phase == CONFIRMATION_READ, s.frame > NO_PAYLOAD, input' = { name: "reencode", choice: choice },
      s' = { frame: choice, created: s.wall, ...s } }
  }
  action invalidate = {
    nondet choice = Set(0, 20).oneOf()
    all {
      input' = { name: "invalidate", choice: choice },
      s' = if (s.writeFailed) {
        o: {
          invalidations: s.o.invalidations + 1,
          maintenance: s.o.maintenance.append("mutation_error"),
          ...s.o
        },
        ...s
      } else {
        watermark: if (s.wall + choice > s.watermark) s.wall + choice else s.watermark,
        o: { invalidations: s.o.invalidations + 1, maintenance: s.o.maintenance.append("ok"), ...s.o },
        ...s
      }
    }
  }
  action rollbackWall = all {
    input' = { name: "rollbackWall", choice: -1 },
    s' = { wall: s.wall - WALL_ROLLBACK_MS, ...s }
  }
  // Application time is independent of elapsed deadline time and physical TTL.
  // Only an already acquired C0 may encounter this large forward change.
  action advanceWallBy(choice: int): bool = all {
    s.phase == CONFIRMATION_READ,
    input' = { name: "advanceWall", choice: choice },
    s' = { wall: s.wall + choice, ...s }
  }
  action advanceWall = {
    nondet choice = Set(1, 60000).oneOf()
    advanceWallBy(choice)
  }
  action setLogging(choice: int): bool = all {
    input' = { name: "logPolicy", choice: choice },
    s' = {
      log: choice == LOGGING_ENABLED, invalidLog: choice == LOGGING_INVALID,
      invalidShadow: false, shadowActive: s.hook, ...s
    }
  }
  action logPolicy = {
    nondet choice = Set(LOGGING_DISABLED, LOGGING_ENABLED, LOGGING_INVALID).oneOf()
    setLogging(choice)
  }
  def shadowPolicyFor(choice: int): State = {
    shadowActive: s.hook and choice == SHADOW_ENABLED, log: s.defaultLog,
    invalidShadow: choice == SHADOW_INVALID, invalidLog: false,
    ...s
  }
  action shadowPolicy = {
    nondet choice = Set(SHADOW_ENABLED, SHADOW_DISABLED, SHADOW_INVALID).oneOf()
    all {
      input' = { name: "shadowPolicy", choice: choice },
      s' = shadowPolicyFor(choice)
    }
  }
  action readFault = {
    nondet choice = Set(0, 1).oneOf()
    all {
      input' = { name: "readFault", choice: choice },
      s' = { readFailed: choice == 1, ...s }
    }
  }
  action loadFault = {
    nondet choice = Set(0, 1).oneOf()
    all {
      input' = { name: "loadFault", choice: choice },
      s' = { loadFailed: choice == 1, ...s }
    }
  }
  action dumpFault = {
    nondet choice = Set(0, 1).oneOf()
    all {
      input' = { name: "dumpFault", choice: choice },
      s' = { dumpFailed: choice == 1, ...s }
    }
  }
  action writeFault = {
    nondet choice = Set(0, 1).oneOf()
    all {
      input' = { name: "writeFault", choice: choice },
      s' = { writeFailed: choice == 1, ...s }
    }
  }

  // Exploration schedule: retain every progress/environment action.
  // At C1, favor completion and logging changes while retaining every
  // replacement, failure, clock, and admission-policy transition. Unicode seed
  // choices add exploration frequency, not another payload representation.
  action step = if (s.phase == CONFIRMATION_READ) any {
    releaseRead, logPolicy, reencode, advanceWall,
    any { seed, seedUnicode, invalidate, readFault, advance, rollbackWall, shadowPolicy }
  } else any {
    any { beginCall, resolveLoader, rejectLoader, releaseRead, releaseLoad, releaseDump, releaseWrite },
    any { advance, seed, seedUnicode, invalidate, readFault, loadFault, dumpFault, writeFault, rollbackWall, logPolicy, shadowPolicy }
  }

  // Invariants: independent checks over state and observed history.
  val oneSourcePerCaller = s.o.loaders == s.o.calls.length()
  val writesRequireMiss = s.phase != FILL_WRITE or (s.c0 == NO_PAYLOAD and s.source == SOURCE_ACCEPTED)
  val writesHaveRetention = s.o.writes == s.o.writeTtls.length()
  val missingHookHasNoShadowEffects = s.hook or (s.o.reads == 0 and s.o.loads == 0 and s.o.dumps == 0 and s.o.writes == 0)
  val agesRequireVerdicts = s.d.ages.length() == s.o.shadow.select(x => x == "match" or x == "mismatch").length()
  val warningsRequireMismatch = s.d.warnings <= s.o.shadow.select(x => x == "mismatch").length()
  val warningsRequireValidCapturedPolicy = s.d.warnings == s.mismatchAuthorizations.select(allowed => allowed).length()
  val invalidLoggingCannotBeCaptured = not(s.acceptedInvalidLog and s.acceptedLog)
  val expiredSourceWorkSkipsRedis = s.sourceWorkMs < JOB_BUDGET_MS or s.o.reads == 0

  // Deterministic model regressions ------------------------------------------
  // Fixtures can patch ownership to challenge a property. They preserve the
  // last declared input and are never exported as implementation histories.
  action modelFixture(snapshot: State): bool = all {
    input' = input, s' = snapshot
  }
  // Fixed model regressions anchor the callback and captured-policy contract.
  action compareFixture = init.then(modelFixture({
      phase: SNAPSHOT_DECODE, deadline: s.now + JOB_BUDGET_MS, comparisonMs: 0,
      hook: true, shadowActive: true,
      c0: TEXT_ONE, c0Created: s.wall - 1, sourceValue: VALUE_TWO,
      o: { calls: List(VALUE_TWO), loaders: 1, reads: 1, loads: 1, ...empty },
      ...s
    }))
  run identicalTextAndBinaryBytesConfirmMismatchTest = compareFixture
    .then(modelFixture({ comparator: COMPARE_UNEQUAL, frame: BINARY_ONE, created: s.wall, ...s })).then(releaseLoad).then(releaseRead)
    .expect(s.o.shadow == List("mismatch"))
  run sameDecodedValueWithDifferentBytesIsSupersededTest = compareFixture
    .then(modelFixture({ comparator: COMPARE_UNEQUAL, frame: BINARY_PADDED_ONE, created: s.wall, ...s })).then(releaseLoad).then(releaseRead)
    .expect(s.o.shadow == List("superseded"))
  run binarySnapshotComparesDecodedValueTest = compareFixture
    .then(modelFixture({ comparator: COMPARE_DEFAULT, c0: BINARY_ONE, sourceValue: VALUE_ONE, ...s })).then(releaseLoad)
    .expect(s.o.shadow == List("match") and s.o.reads == 1)
  run slowComparisonTimesOutBeforeConfirmationTest = compareFixture
    .then(modelFixture({ comparator: COMPARE_UNEQUAL, comparisonMs: 10, ...s })).then(releaseLoad)
    .expect(s.o.shadow == List("timeout") and s.o.reads == 1 and s.o.comparisons == 1 and s.o.calls == List(VALUE_TWO))
  run slowComparisonFailureStillTimesOutTest = compareFixture
    .then(modelFixture({ comparator: COMPARE_ERROR, comparisonMs: 10, ...s })).then(releaseLoad)
    .expect(s.o.shadow == List("timeout") and s.o.comparisons == 1 and s.o.calls == List(VALUE_TWO))
  run missingHookSkipsDarkJobTest = init.then(modelFixture({ hook: false, shadowActive: false, ...s }))
    .then(beginCall).then(resolveLoader).expect(s.o.calls.nth(0) > 0 and s.o.reads == 0 and s.o.shadow == List())
  run invalidShadowPolicySkipsDarkJobTest = init.then(modelFixture(shadowPolicyFor(SHADOW_INVALID))).then(beginCall).then(resolveLoader)
    .expect(s.o.calls.nth(0) > 0 and s.o.reads == 0 and s.o.shadow == List())
  run admittedComparisonSurvivesPolicyDisableTest = compareFixture.then(modelFixture({ comparator: COMPARE_EQUAL, ...s }))
    .then(modelFixture(shadowPolicyFor(SHADOW_DISABLED))).then(releaseLoad).expect(s.o.shadow == List("match"))
  run explicitEqualityOverridesValuesTest = compareFixture.then(modelFixture({ comparator: COMPARE_EQUAL, ...s })).then(releaseLoad)
    .expect(s.o.shadow == List("match") and s.o.comparisons == 1 and s.d.ages == List(1))
  run explicitInequalityRequiresConfirmationTest = compareFixture
    .then(modelFixture({ comparator: COMPARE_UNEQUAL, sourceValue: VALUE_ONE, frame: TEXT_ONE, created: s.wall, acceptedLog: true, ...s }))
    .then(releaseLoad).expect(s.phase == CONFIRMATION_READ and s.d.warnings == 0).then(releaseRead)
    .expect(s.o.shadow == List("mismatch") and s.o.comparisons == 1 and s.d.warnings == 1)
  run comparisonFailureKeepsCallerTest = compareFixture.then(modelFixture({ comparator: COMPARE_ERROR, ...s })).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_TWO) and s.o.shadow == List("comparison_error") and s.d.ages == List())
  run acceptedLoggingSurvivesPolicyChangeTest = compareFixture
    .then(modelFixture({ comparator: COMPARE_UNEQUAL, frame: TEXT_ONE, created: s.wall, acceptedLog: true, log: false, ...s }))
    .then(releaseLoad).then(releaseRead).expect(s.d.warnings == 1)
  run ageClampsAfterWallRollbackTest = compareFixture.then(modelFixture({ comparator: COMPARE_EQUAL, ...s }))
    .then(rollbackWall).then(releaseLoad).expect(s.d.ages == List(0))
  run confirmationKeepsOriginalAgeTest = compareFixture
    .then(modelFixture({ comparator: COMPARE_UNEQUAL, frame: TEXT_ONE, created: s.wall, ...s })).then(releaseLoad)
    .then(modelFixture({ wall: s.wall + 1, created: s.wall + 1000, ...s })).then(releaseRead)
    .expect(s.o.shadow == List("mismatch") and s.d.ages == List(2))

  run invalidLoggingKeepsComparisonWithoutWarningTest = init.then(modelFixture({
      hook: true, shadowActive: true, comparator: COMPARE_UNEQUAL, comparisonMs: 0, sourceWorkMs: 0,
      log: false, invalidLog: true, frame: TEXT_ONE, created: s.wall,
      ...s
    })).then(beginCall).expect(s.d.configErrors == 1 and s.o.reads == 1)
    .then(releaseRead).then(resolveLoader).then(releaseLoad).then(releaseRead)
    .expect(s.o.shadow == List("mismatch") and s.d.warnings == 0 and s.o.comparisons == 1)

  // Omission and an explicit false reply are distinct environment inputs. Both
  // keep diagnostic metrics, while neither authorizes a mismatch warning.
  run omittedLoggingKeepsMismatchMetricsOnlyTest = initialize(COMPARE_UNEQUAL)
    .expect(not(s.defaultLog) and not(s.log))
    .then(seedAt(TEXT_ONE)).then(beginCall).then(releaseRead).then(resolveAt(VALUE_TWO))
    .then(releaseLoad).then(releaseRead)
    .expect(s.o.shadow == List("mismatch") and s.d.ages == List(0)
      and s.d.warnings == 0 and s.d.configErrors == 0 and s.o.comparisons == 1)

  run explicitFalseLoggingOverridesEnabledDefaultTest = initialize(FIRST_LOGGING_FIXTURE + COMPARE_UNEQUAL)
    .expect(s.defaultLog and s.log)
    .then(setLogging(LOGGING_DISABLED)).then(seedAt(TEXT_ONE)).then(beginCall)
    .then(releaseRead).then(resolveAt(VALUE_TWO)).then(releaseLoad).then(releaseRead)
    .expect(s.o.shadow == List("mismatch") and s.d.ages == List(0)
      and s.d.warnings == 0 and s.d.configErrors == 0 and s.o.comparisons == 1)
  run sourceWorkBeforeDeadlineStillReadsTest = init.then(modelFixture({
      hook: true, shadowActive: true, sourceWorkMs: JOB_BUDGET_MS - 1, ...s
    })).then(beginCall).expect(s.o.reads == 1 and s.o.calls == List(CALL_PENDING) and s.o.shadow == List())
    .then(resolveLoader).expect(s.o.calls.nth(0) == VALUE_ONE or s.o.calls.nth(0) == VALUE_TWO)
  run sourceWorkAtDeadlineSkipsDeferredReadTest = init.then(modelFixture({
      hook: true, shadowActive: true, sourceWorkMs: JOB_BUDGET_MS, ...s
    })).then(beginCall)
    .expect(s.o.reads == 0 and s.o.calls == List(CALL_PENDING) and s.o.shadow == List("timeout")
      and s.d.fallbackErrors == List())
    .then(resolveLoader)
    .expect(s.o.calls == List(DEADLINE_ERROR) and s.o.reads == 0 and s.d.fallbackErrors == List("local"))
  run expiredDeferredJobRetainsSourceRejectionDeadlineTest = init.then(modelFixture({
      hook: true, shadowActive: true, sourceWorkMs: JOB_BUDGET_MS, ...s
    })).then(beginCall).then(rejectLoader)
    .expect(s.o.calls == List(DEADLINE_ERROR) and s.o.shadow == List("timeout") and s.o.reads == 0)


  // These histories distinguish failures at C0, decode, C1, serialization and
  // write settlement. Their effects remain subordinate to the caller result.
  action darkCallerFixture = init.then(modelFixture({
      hook: true, shadowActive: true, sourceWorkMs: 0, comparisonMs: 0,
      comparator: COMPARE_DEFAULT, ...s
    }))
  action fillFixture = darkCallerFixture.then(beginCall)
    .then(releaseRead).then(resolveLoader)

  run darkReadErrorCannotReplaceCallerSourceTest = darkCallerFixture
    .then(modelFixture({ readFailed: true, ...s })).then(beginCall).then(releaseRead)
    .expect(s.o.calls == List(CALL_PENDING) and s.o.shadow == List("redis_error"))
    .then(resolveLoader)
    .expect(s.o.calls.nth(0) == VALUE_ONE or s.o.calls.nth(0) == VALUE_TWO)
    .expect(s.o.shadow == List("redis_error") and s.o.loads == 0 and s.o.writes == 0)

  run sourceErrorDoesNotDecodePresentDarkBytesTest = darkCallerFixture
    .then(modelFixture({ frame: TEXT_ONE, created: s.wall, ...s }))
    .then(beginCall).then(releaseRead).then(rejectLoader)
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.shadow == List("source_error")
      and s.o.loads == 0 and s.o.dumps == 0 and s.o.writes == 0)

  run futureDarkBytesFillWithoutDecodingTest = darkCallerFixture
    .then(modelFixture({ frame: TEXT_ONE, created: s.wall + 1, ...s }))
    .then(beginCall).then(releaseRead).then(resolveLoader).then(releaseDump).then(releaseWrite)
    .expect(s.o.shadow == List("filled") and s.o.loads == 0
      and s.o.loaders == 1 and s.o.writes == 1)

  run fencedDarkBytesCanAdmitNewerFillTest = darkCallerFixture
    .then(modelFixture({ frame: TEXT_ONE, created: s.wall - 2, watermark: s.wall - 1, ...s }))
    .then(beginCall).then(releaseRead).then(resolveLoader).then(releaseDump).then(releaseWrite)
    .expect(s.o.shadow == List("filled") and s.o.loads == 0
      and s.o.writes == 1 and s.created > s.watermark)

  run fencedConfirmationNeverRepairsTest = compareFixture
    .then(modelFixture({ comparator: COMPARE_UNEQUAL, frame: TEXT_ONE, created: s.wall, watermark: s.wall, ...s }))
    .then(releaseLoad).then(releaseRead)
    .expect(s.o.shadow == List("superseded") and s.o.reads == 2
      and s.o.calls == List(VALUE_TWO) and s.o.writes == 0 and s.d.ages == List())

  run futureConfirmationStillComparesBytesTest = compareFixture
    .then(modelFixture({ comparator: COMPARE_UNEQUAL, frame: TEXT_ONE, created: s.wall + 1, ...s }))
    .then(releaseLoad).then(releaseRead)
    .expect(s.o.shadow == List("mismatch") and s.o.reads == 2
      and s.o.calls == List(VALUE_TWO) and s.o.writes == 0)

  run fillSerializationFailureNeverDispatchesWriteTest = fillFixture
    .then(modelFixture({ dumpFailed: true, ...s })).then(releaseDump)
    .expect(s.o.shadow == List("fill_error") and s.o.dumps == 1 and s.o.writes == 0)
    .expect(s.o.calls.nth(0) == VALUE_ONE or s.o.calls.nth(0) == VALUE_TWO)

  run fillWriteFailurePreservesCallerResultTest = fillFixture.then(releaseDump)
    .then(modelFixture({ writeFailed: true, ...s })).then(releaseWrite)
    .expect(s.o.shadow == List("fill_error") and s.o.dumps == 1 and s.o.writes == 1)
    .expect(s.o.calls.nth(0) == VALUE_ONE or s.o.calls.nth(0) == VALUE_TWO)

  action expirePendingJob = all {
    input' = input,
    s' = {
      abandoned: true, now: s.deadline, wall: s.wall + s.deadline - s.now,
      o: { shadow: s.o.shadow.append("timeout"), ...s.o },
      ...s
    }
  }
  run lateFillSerializationCannotDispatchWriteTest = fillFixture
    .then(expirePendingJob).then(releaseDump)
    .expect(s.o.shadow == List("timeout") and s.o.dumps == 1 and s.o.writes == 0)

  run lateFillWriteCannotEmitAnotherVerdictTest = fillFixture.then(releaseDump)
    .then(expirePendingJob).then(releaseWrite)
    .expect(s.o.shadow == List("timeout") and s.o.writes == 1)
    .expect(s.o.calls.nth(0) == VALUE_ONE or s.o.calls.nth(0) == VALUE_TWO)

  run lateDecodeCannotStartConfirmationTest = compareFixture
    .then(modelFixture({ comparator: COMPARE_UNEQUAL, ...s })).then(expirePendingJob).then(releaseLoad)
    .expect(s.o.shadow == List("timeout") and s.o.reads == 1 and s.o.comparisons == 0
      and s.o.calls == List(VALUE_TWO))

  run lateConfirmationCannotEmitAnotherVerdictTest = compareFixture
    .then(modelFixture({ comparator: COMPARE_UNEQUAL, ...s })).then(releaseLoad)
    .then(expirePendingJob).then(releaseRead)
    .expect(s.o.shadow == List("timeout") and s.o.reads == 2 and s.o.writes == 0
      and s.o.calls == List(VALUE_TWO))

  run lateDarkReadCannotStartDecodeOrFillTest = darkCallerFixture
    .then(beginCall).then(resolveLoader).then(expirePendingJob).then(releaseRead)
    .expect(s.o.shadow == List("timeout") and s.o.loads == 0 and s.o.dumps == 0 and s.o.writes == 0)
  run confirmationPastFreshnessKeepsOriginalPayloadAndAgeTest = initialize(FIRST_LOGGING_FIXTURE + COMPARE_UNEQUAL)
    .then(seedAt(TEXT_ONE)).then(beginCall).then(releaseRead).then(resolveAt(VALUE_TWO))
    .then(releaseLoad).then(advanceWallBy(60000)).then(releaseRead)
    .expect(s.o.calls == List(VALUE_TWO) and s.o.shadow == List("mismatch")
      and s.o.reads == 2 and s.o.loads == 1 and s.o.writes == 0
      and s.d.ages == List(60000) and s.d.warnings == 1 and s.d.futureOffsets == List())

  run confirmationRollbackKeepsPayloadAndClampsAgeTest = initialize(FIRST_LOGGING_FIXTURE + COMPARE_UNEQUAL)
    .then(seedAt(TEXT_ONE)).then(beginCall).then(releaseRead).then(resolveAt(VALUE_TWO))
    .then(releaseLoad).then(rollbackWall).then(releaseRead)
    .expect(s.o.calls == List(VALUE_TWO) and s.o.shadow == List("mismatch")
      and s.o.reads == 2 and s.o.loads == 1 and s.o.writes == 0
      and s.d.ages == List(0) and s.d.warnings == 1
      and s.d.futureOffsets == List({ layer: "remote_shadow", offsetMs: 1000 }))

  run futureDarkAcquisitionReportsOffsetAndFillsMissTest = initialize(COMPARE_DEFAULT)
    .then(seedAt(TEXT_ONE)).then(rollbackWall).then(beginCall).then(releaseRead)
    .expect(s.o.loads == 0 and s.o.dumps == 0
      and s.d.futureOffsets == List({ layer: "remote_shadow", offsetMs: 1000 }))
    .then(resolveAt(VALUE_TWO)).then(releaseDump).then(releaseWrite)
    .expect(s.o.calls == List(VALUE_TWO) and s.o.shadow == List("filled")
      and s.o.loads == 0 and s.o.writes == 1
      and s.d.futureOffsets == List({ layer: "remote_shadow", offsetMs: 1000 }))

  run futureLateDarkReadKeepsTimeoutAndReportsOffsetTest = initialize(COMPARE_DEFAULT)
    .then(seedAt(TEXT_ONE)).then(rollbackWall).then(beginCall).then(advanceBy(JOB_BUDGET_MS))
    .expect(s.o.calls == List(DEADLINE_ERROR) and s.o.shadow == List("timeout")
      and s.d.futureOffsets == List())
    .then(releaseRead)
    .expect(s.o.calls == List(DEADLINE_ERROR) and s.o.shadow == List("timeout")
      and s.o.loads == 0 and s.o.dumps == 0 and s.o.writes == 0
      and s.d.futureOffsets == List({ layer: "remote_shadow", offsetMs: 990 }))

}
