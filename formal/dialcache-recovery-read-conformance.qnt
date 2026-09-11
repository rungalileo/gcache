module dialcache_recovery_read_conformance {
  import conformance_observations.* from "./conformance-observations"

  // One tracked or untracked operation crosses request, local and remote
  // storage. Reads and decoding can wait; successful source publication settles
  // within its action. C22/C28/C37/C38/C43/C45 are the selected contracts.
  // Two request scopes and one transient caller distinguish request memo from
  // process-local reuse. Only one execution is active: concurrent ownership and
  // source/read deadlines remain in the independent/effects profiles.
  // The read budget exceeds the entire elapsed-time domain; sources are
  // explicitly unbounded. Logical age and native retention remain independent.

  // Initialization choices are part of the replay input: keep these codes stable.
  pure val UNTRACKED_MODE = 0
  pure val TRACKED_MODE = 1
  pure val TRACKED_WITH_SHADOW_MODE = 2
  pure val IDLE = 0
  pure val READING = 1
  pure val FRESH_DECODE = 2
  pure val SOURCE_RUNNING = 3
  pure val RECOVERY_DECODE = 4
  pure val ABSENT_PAYLOAD = 0
  pure val RAW_ONE = 1
  pure val RAW_TWO = 2
  pure val RAW_ABSENCE = 16
  pure val COMPRESSED_ONE = 11
  pure val CORRUPT_COMPRESSED = 12
  pure val UNSUPPORTED_ENCODING = 13
  pure val UNSAFE_TIMESTAMP = 14
  pure val UNSUPPORTED_VERSION = 15
  pure val WALL_ORIGIN = 1000000000
  pure val TRACKED_CAP_MS = 3600000
  pure val MARKER_FLOOR_MS = 7200000
  pure val MARKER_MARGIN_MS = 60000
  pure val READ_BUDGET_MS = 30000000
  pure val MAX_ELAPSED_MS = 14400000
  pure val LOCAL_TTL_MS = 1000
  pure val MAX_CALLS = 10

  type Marker = { cutoffMs: int, ttlMs: int }
  type ReadReceipt = { validFrame: bool, age: int, freshMs: int, freshDecode: bool }
  type WriteReceipt = { requested: int, tracked: bool, ttl: int }
  type RecoveryReceipt = {
    dumpsBefore: int, dumpsAfter: int, writesBefore: int, writesAfter: int,
    localBefore: int, localAfter: int, age: int, maximum: int, served: bool
  }
  // now is monotonic elapsed milliseconds; wall is application wall-clock ms.
  // Stored frame/candidate timestamps use wall; local/remote/marker expiry uses
  // now. s.o, io, markers and compression predict observations checked by the
  // native drivers. Receipts retain before/after facts for independent invariants.
  type State = {
    o: Observation,
    io: { budgets: List[int], aborted: List[int], sourceErrors: List[int] },
    markers: List[Marker], compression: List[str],
    tracked: bool, shadowSelected: bool, now: int, wall: int, phase: int, writeFailed: bool,
    frame: int, created: int, expires: int,
    watermark: int, markerExpires: int,
    localValue: int, localExpires: int, localVersion: int,
    memo: List[int], closed: List[bool], scope: int,
    freshMs: int, maximumMs: int, acceptedFresh: int, acceptedMaximum: int,
    candidate: int, candidateCreated: int, canRecover: bool, canWrite: bool,
    observedFence: int, activeSource: int,
    readReceipts: List[ReadReceipt], writeReceipts: List[WriteReceipt],
    recoveryReceipts: List[RecoveryReceipt]
  }
  var s: State
  // These are external replay commands, never predicted observations. The
  // explicit record survives deterministic `quint test --out-itf` exports.
  var input: { name: str, choice: int }

  action initialized(mode: int): bool = all {
    input' = { name: "init", choice: mode },
    s' = {
      o: empty,
      io: { budgets: List(), aborted: List(), sourceErrors: List() },
      markers: List(),
      compression: List(),
      tracked: mode != UNTRACKED_MODE,
      shadowSelected: mode == TRACKED_WITH_SHADOW_MODE,
      now: 0,
      wall: WALL_ORIGIN,
      phase: IDLE,
      writeFailed: false,
      frame: ABSENT_PAYLOAD,
      created: 0,
      expires: 0,
      watermark: 0,
      markerExpires: 0,
      localValue: 0,
      localExpires: 0,
      localVersion: 0,
      memo: List(0, 0),
      closed: List(false, false),
      scope: 2,
      freshMs: 1000,
      maximumMs: 5000,
      acceptedFresh: 1000,
      acceptedMaximum: 5000,
      candidate: 0,
      candidateCreated: 0,
      canRecover: false,
      canWrite: false,
      observedFence: 0,
      activeSource: -1,
      readReceipts: List(),
      writeReceipts: List(),
      recoveryReceipts: List()
    }
  }
  action init = {
    nondet choice = Set(UNTRACKED_MODE, TRACKED_MODE, TRACKED_WITH_SHADOW_MODE).oneOf()
    initialized(choice)
  }

  pure def effectiveMarker(x: State): int = if (x.now < x.markerExpires) x.watermark else 0
  pure def payloadValue(payload: int): int =
    if (payload == RAW_ABSENCE) VALUE_ABSENT else if (payload == RAW_TWO) VALUE_TWO else VALUE_ONE
  pure def decodeFails(payload: int): bool = payload == CORRUPT_COMPRESSED
  pure def startedCompression(x: State, payload: int): List[str] =
    if (payload == COMPRESSED_ONE) x.compression.append("decompressed")
    else if (payload == CORRUPT_COMPRESSED) x.compression.append("fallback_raw")
    else x.compression
  pure def validCandidate(x: State): bool = x.candidate > 0 and
    x.candidateCreated <= x.wall and x.wall - x.candidateCreated < x.acceptedMaximum
  pure def complete(x: State, value: int): State = {
    phase: IDLE,
    memo: if (value != SOURCE_ERROR and x.scope < 2 and not(x.closed.nth(x.scope)))
      x.memo.replaceAt(x.scope, value) else x.memo,
    io: {
      sourceErrors: x.io.sourceErrors.replaceAt(x.io.sourceErrors.length() - 1,
        if (value == SOURCE_ERROR) x.activeSource + 1 else 0),
      ...x.io
    },
    o: finishPendingCalls(x.o, value), ...x
  }
  pure def startSource(x: State): State = {
    phase: SOURCE_RUNNING, activeSource: x.o.loaders,
    o: { loaders: x.o.loaders + 1, ...x.o }, ...x
  }

  // Request and local hits stop traversal. Local expiry uses the insertion
  // deadline; a hit never alters it. Policy is captured before a held read.
  // Contexts 0/1 own persistent request memos; context 2 is a transient caller.
  action beginIn(context: int): bool = all {
    s.phase == IDLE,
    s.o.calls.length() < MAX_CALLS,
    context == 2 or not(s.closed.nth(context)),
    input' = { name: "beginCall", choice: context },
    val memoValue = if (context < 2) s.memo.nth(context) else 0
    val localHit = memoValue == 0 and s.localValue > 0 and s.now < s.localExpires
    val value = if (memoValue > 0) memoValue else if (localHit) s.localValue else CALL_PENDING
    val admitted = {
      scope: context, acceptedFresh: s.freshMs, acceptedMaximum: s.maximumMs,
      candidate: 0, candidateCreated: 0,
      io: {
        sourceErrors: s.io.sourceErrors.append(0),
        budgets: if (value == CALL_PENDING) s.io.budgets.append(READ_BUDGET_MS) else s.io.budgets,
        ...s.io
      },
      o: {
        calls: s.o.calls.append(value), policyCalls: s.o.policyCalls + 1,
        reads: s.o.reads + (if (value == CALL_PENDING) 1 else 0), ...s.o
      }, ...s
    }
    s' = if (value == CALL_PENDING) { phase: READING, ...admitted }
      else complete(admitted, value)
  }
  action beginCall = { nondet choice = Set(0, 1, 2).oneOf(); beginIn(choice) }

  // The adapter observes current storage when its held read settles. Unsupported
  // encoding throws only after physical presence and the tracked fence pass.
  // Freshness samples the settlement wall clock, not read dispatch time.
  action releaseRead = all {
    s.phase == READING,
    input' = { name: "releaseRead", choice: -1 },
    val present = s.frame > 0 and s.now < s.expires
    val fenced = s.tracked and s.created <= effectiveMarker(s)
    val supportedFrame = s.frame != UNSUPPORTED_VERSION and s.frame != UNSAFE_TIMESTAMP
    val validFrame = present and not(fenced) and supportedFrame and s.frame != UNSUPPORTED_ENCODING
    val encodingError = present and not(fenced) and s.frame == UNSUPPORTED_ENCODING
    val age = s.wall - s.created
    val freshHit = validFrame and age >= 0 and age < s.acceptedFresh
    val retained = validFrame and age >= 0 and age < s.acceptedMaximum
    val acquired = {
      candidate: if (retained or freshHit) s.frame else 0, candidateCreated: s.created,
      canRecover: not(encodingError), canWrite: not(encodingError),
      observedFence: if (s.tracked and (not(present) or fenced or s.frame == UNSUPPORTED_VERSION)) effectiveMarker(s) else 0,
      readReceipts: s.readReceipts.append({ validFrame: validFrame, age: age,
        freshMs: s.acceptedFresh, freshDecode: freshHit }),
      ...s
    }
    s' = if (freshHit) {
      phase: FRESH_DECODE, compression: startedCompression(s, s.frame),
      o: { loads: s.o.loads + 1, ...s.o }, ...acquired
    } else startSource(acquired)
  }

  action rejectLoader = all {
    s.phase == SOURCE_RUNNING,
    input' = { name: "rejectLoader", choice: -1 },
    val decode = s.canRecover and validCandidate(s)
    val rejected = {
      o: { classifications: s.o.classifications + (if (s.canRecover) 1 else 0),
        loads: s.o.loads + (if (decode) 1 else 0),
        recovery: if (s.canRecover and not(decode)) s.o.recovery.append("miss") else s.o.recovery,
        ...s.o }, ...s
    }
    s' = if (decode) { phase: RECOVERY_DECODE, compression: startedCompression(s, s.candidate), ...rejected }
      else complete(rejected, SOURCE_ERROR)
  }
  action resolveLoader = all {
    s.phase == SOURCE_RUNNING,
    not(s.shadowSelected),
    input' = { name: "resolveLoader", choice: -1 },
    val requested = if (s.acceptedMaximum > s.acceptedFresh) s.acceptedMaximum else s.acceptedFresh
    val physicalTtl = if (s.tracked and requested > TRACKED_CAP_MS) TRACKED_CAP_MS else requested
    val publishRemote = s.canWrite and s.wall > s.observedFence
    val publishLocal = not(s.tracked)
    val published = {
      frame: if (publishRemote and not(s.writeFailed)) RAW_TWO else s.frame,
      created: if (publishRemote and not(s.writeFailed)) s.wall else s.created,
      expires: if (publishRemote and not(s.writeFailed)) s.now + physicalTtl else s.expires,
      localValue: if (publishLocal) VALUE_TWO else s.localValue,
      localExpires: if (publishLocal) s.now + LOCAL_TTL_MS else s.localExpires,
      localVersion: s.localVersion + (if (publishLocal) 1 else 0),
      writeReceipts: if (publishRemote) s.writeReceipts.append({ requested: requested,
        tracked: s.tracked, ttl: physicalTtl }) else s.writeReceipts,
      o: { dumps: s.o.dumps + (if (publishRemote) 1 else 0),
        writes: s.o.writes + (if (publishRemote) 1 else 0),
        writeTtls: if (publishRemote) s.o.writeTtls.append(physicalTtl) else s.o.writeTtls,
        ...s.o }, ...s
    }
    s' = complete(published, VALUE_TWO)
  }

  // Decoding holds the acquired bytes. Fresh hits warm process storage after
  // successful decode; retained recovery can publish only to its live request.
  action releaseLoad = all {
    s.phase == FRESH_DECODE or s.phase == RECOVERY_DECODE,
    input' = { name: "releaseLoad", choice: -1 },
    val failed = decodeFails(s.candidate)
    val recovery = s.phase == RECOVERY_DECODE
    val served = not(failed) and (not(recovery) or validCandidate(s))
    val value = if (served) payloadValue(s.candidate) else SOURCE_ERROR
    val decoded = {
      localValue: if (served and not(recovery)) value else s.localValue,
      localExpires: if (served and not(recovery)) s.now + LOCAL_TTL_MS else s.localExpires,
      localVersion: s.localVersion + (if (served and not(recovery)) 1 else 0),
      o: { recovery: if (recovery) s.o.recovery.append(
        if (failed) "deserialization_error" else if (served) "served" else "miss") else s.o.recovery, ...s.o },
      ...s
    }
    val completed = if (not(recovery) and failed)
      startSource({ canRecover: false, ...decoded }) else complete(decoded, value)
    s' = {
      recoveryReceipts: if (recovery) s.recoveryReceipts.append({
        dumpsBefore: s.o.dumps, dumpsAfter: completed.o.dumps,
        writesBefore: s.o.writes, writesAfter: completed.o.writes,
        localBefore: s.localVersion, localAfter: completed.localVersion,
        age: s.wall - s.candidateCreated, maximum: s.acceptedMaximum, served: served
      }) else s.recoveryReceipts,
      ...completed
    }
  }

  // External fixtures: codes select actual raw/enveloped bytes, age and physical
  // lifetime. Compressed bodies are fixed portable zstd examples in the driver;
  // this model states their decode outcome, not the compression algorithm.
  // TRACKED_WITH_SHADOW_MODE isolates recovery with a selected shadow policy.
  // Only stale bytes and failed sources are admitted in this mode, so fresh-hit
  // diagnostic jobs remain in the shadow profiles. Absence is stored data here;
  // ABSENT_PAYLOAD still means that the remote key itself does not exist.
  action seedWith(code: int): bool = all {
    not(s.shadowSelected) or code == 2 or code == 18,
    s.shadowSelected or code != 18,
    input' = { name: "seed", choice: code },
    val age = List(0, 999, 1000, 4999, 5000, 3600001, 7200000, 0, 1000, 1000, 0, 0, 4999, 0, 0, 1000, 0, 0, 1000).nth(code)
    val payload = if (code == 7) RAW_TWO else if (code == 8 or code == 12 or code == 13) COMPRESSED_ONE
      else if (code == 9 or code == 14) CORRUPT_COMPRESSED else if (code == 10) UNSUPPORTED_ENCODING
      else if (code == 18) RAW_ABSENCE else if (code == 16) UNSAFE_TIMESTAMP else if (code == 17) UNSUPPORTED_VERSION else RAW_ONE
    s' = { frame: payload, created: if (code == 16) 9007199254740993 else s.wall - age,
      expires: s.now + (if (code == 11 or code == 15) 1000 else 60000), ...s }
  }
  action seed = { nondet choice = 0.to(18).oneOf(); seedWith(choice) }
  action advanceBy(ms: int): bool = all {
    s.now + ms <= MAX_ELAPSED_MS,
    input' = { name: "advance", choice: ms },
    s' = { now: s.now + ms, wall: s.wall + ms, ...s }
  }
  action advance = { nondet choice = Set(1, 999, 1000, 4000, 60000, 3600000).oneOf(); advanceBy(choice) }
  action policyWith(code: int): bool = all {
    not(s.shadowSelected),
    input' = { name: "policy", choice: code },
    s' = {
      freshMs: if (code == 2) 7200000 else 1000,
      maximumMs: if (code == 2) 14400000 else if (code == 1) 7200000 else 5000, ...s
    }
  }
  action policy = { nondet choice = Set(0, 1, 2).oneOf(); policyWith(choice) }
  action closeContext(context: int): bool = all {
    not(s.closed.nth(context)),
    input' = { name: "closeScope", choice: context },
    s' = { closed: s.closed.replaceAt(context, true), memo: s.memo.replaceAt(context, 0), ...s }
  }
  action closeScope = { nondet choice = Set(0, 1).oneOf(); closeContext(choice) }

  // Invalidation owns marker creation/extension. Read and value-write actions
  // never update marker state; the separate command observes its external TTL.
  action invalidate = all {
    input' = { name: "invalidate", choice: -1 },
    val cutoff = if (s.wall > effectiveMarker(s)) s.wall else effectiveMarker(s)
    val requested = cutoff - s.wall + TRACKED_CAP_MS + MARKER_MARGIN_MS
    val ttl = if (requested > MARKER_FLOOR_MS) requested else MARKER_FLOOR_MS
    s' = if (s.writeFailed) {
      o: { invalidations: s.o.invalidations + 1, maintenance: s.o.maintenance.append("mutation_error"), ...s.o }, ...s
    } else { watermark: cutoff,
      markerExpires: if (s.markerExpires > s.now + ttl) s.markerExpires else s.now + ttl,
      o: { invalidations: s.o.invalidations + 1, maintenance: s.o.maintenance.append("ok"), ...s.o }, ...s }
  }
  action observeMarker = all {
    input' = { name: "observeMarker", choice: -1 },
    s' = { markers: s.markers.append(if (s.now < s.markerExpires)
      { cutoffMs: s.watermark - WALL_ORIGIN, ttlMs: s.markerExpires - s.now }
      else { cutoffMs: -1, ttlMs: -2 }), ...s }
  }
  action writeFaultWith(code: int): bool = all {
    input' = { name: "writeFault", choice: code },
    s' = { writeFailed: code == 1, ...s }
  }
  action writeFault = { nondet choice = Set(0, 1).oneOf(); writeFaultWith(choice) }
  action step = any {
    beginCall, releaseRead, rejectLoader, resolveLoader, releaseLoad,
    seed, advance, policy, closeScope, invalidate, observeMarker, writeFault
  }

  // Independent checks over retained observation receipts. Publication checks
  // compare the actual before/after state, not the predicate authorizing it.
  val freshnessUsesReadSettlement = s.readReceipts.indices().forall(i => { val r = s.readReceipts.nth(i)

    not(r.validFrame) or (r.freshDecode == (r.age >= 0 and r.age < r.freshMs)) })
  val trackedWritesRespectPhysicalCap = s.writeReceipts.indices().forall(i => { val r = s.writeReceipts.nth(i)

    r.ttl == (if (r.tracked and r.requested > 3600000) 3600000 else r.requested) })
  val recoveredResultsNeverPublishShared = s.recoveryReceipts.indices().forall(i => { val r = s.recoveryReceipts.nth(i)

    r.dumpsBefore == r.dumpsAfter and r.writesBefore == r.writesAfter and r.localBefore == r.localAfter })
  val recoveredAgeUsesLogicalMaximum = s.recoveryReceipts.indices().forall(i => { val r = s.recoveryReceipts.nth(i)

    not(r.served) or (r.age >= 0 and r.age < r.maximum) })
  val closedContextsStayEmpty = s.closed.indices().forall(i => not(s.closed.nth(i)) or s.memo.nth(i) == 0)
  val selectedShadowNeverAdmitsRecoveredResults = not(s.shadowSelected) or
    (s.o.shadow == List() and s.o.dumps == 0 and s.o.writes == 0 and s.localVersion == 0)
  val observationsHaveOwners = s.io.sourceErrors.length() == s.o.calls.length() and
    s.io.budgets.length() == s.o.reads and s.writeReceipts.length() == s.o.writes

  // A selected policy, outcome hook and available capacity make shadow work
  // otherwise eligible. Neither ordinary recovery nor its request-memo probe
  // may create a diagnostic source or any shared-cache publication.
  run recoveredAbsenceSkipsSelectedShadowTest = initialized(TRACKED_WITH_SHADOW_MODE).then(seedWith(18))
    .then(beginIn(0)).then(releaseRead).then(rejectLoader).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ABSENT) and s.o.loaders == 1 and s.o.reads == 1
      and s.o.loads == 1 and s.o.classifications == 1 and s.o.recovery == List("served")
      and s.o.shadow == List() and s.o.dumps == 0 and s.o.writes == 0)
    .then(beginIn(0))
    .expect(s.o.calls == List(VALUE_ABSENT, VALUE_ABSENT) and s.o.loaders == 1 and s.o.reads == 1
      and s.o.shadow == List() and s.o.dumps == 0 and s.o.writes == 0)
    .then(beginIn(1)).then(releaseRead).then(rejectLoader).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ABSENT, VALUE_ABSENT, VALUE_ABSENT)
      and s.o.loaders == 2 and s.o.reads == 2 and s.o.loads == 2
      and s.o.recovery == List("served", "served") and s.o.shadow == List()
      and s.o.dumps == 0 and s.o.writes == 0 and s.localValue == 0)
  run recoveredValueSkipsSelectedShadowTest = initialized(TRACKED_WITH_SHADOW_MODE).then(seedWith(2))
    .then(beginIn(0)).then(releaseRead).then(rejectLoader).then(releaseLoad)
    .then(beginIn(0))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1 and s.o.reads == 1
      and s.o.loads == 1 and s.o.classifications == 1 and s.o.recovery == List("served")
      and s.o.shadow == List() and s.o.dumps == 0 and s.o.writes == 0 and s.localValue == 0)

  // Deterministic replay uses only the same external commands as exploration.
  run freshnessAfterHeldReadTest = initialized(TRACKED_MODE).then(seedWith(0)).then(beginIn(2))
    .then(advanceBy(1000)).then(releaseRead)
    .expect(s.o.loaders == 1 and s.o.loads == 0)
    .then(rejectLoader).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.recovery == List("served") and s.o.writes == 0)
  run trackedEncodingFailureSuppressesRefillTest = initialized(TRACKED_MODE).then(seedWith(10))
    .then(beginIn(0)).then(releaseRead).then(resolveLoader)
    .expect(s.o.calls == List(VALUE_TWO) and s.o.loads == 0 and s.o.dumps == 0 and s.o.writes == 0)
    .then(beginIn(1)).expect(s.o.reads == 2 and s.o.calls == List(VALUE_TWO, CALL_PENDING))
  run untrackedEncodingFailureStillPublishesLocalTest = initialized(UNTRACKED_MODE).then(seedWith(10))
    .then(beginIn(0)).then(releaseRead).then(resolveLoader).then(beginIn(1))
    .expect(s.o.calls == List(VALUE_TWO, VALUE_TWO) and s.o.reads == 1
      and s.o.loads == 0 and s.o.dumps == 0 and s.o.writes == 0)
  run trackedPhysicalRetentionExpiresAtCapTest = initialized(TRACKED_MODE).then(policyWith(2))
    .then(beginIn(2)).then(releaseRead).then(resolveLoader)
    .expect(s.o.writeTtls == List(3600000))
    .then(advanceBy(3600000)).then(beginIn(2)).then(releaseRead)
    .expect(s.o.calls == List(VALUE_TWO, CALL_PENDING) and s.o.loaders == 2 and s.o.loads == 0)
  run physicalCapDoesNotClampLogicalRecoveryTest = initialized(TRACKED_MODE).then(policyWith(1))
    .then(seedWith(5)).then(beginIn(2)).then(releaseRead).then(rejectLoader).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.recovery == List("served")
      and s.o.writeTtls == List() and s.recoveryReceipts.nth(0).age == 3600001)
  run compressedRecoveryMemoizesWithoutLocalPublicationTest = initialized(TRACKED_MODE).then(seedWith(8))
    .then(beginIn(0)).then(releaseRead).then(rejectLoader).then(releaseLoad)
    .then(beginIn(0)).expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.reads == 1)
    .then(beginIn(1)).expect(s.o.reads == 2 and s.o.calls == List(VALUE_ONE, VALUE_ONE, CALL_PENDING))
    .expect(s.o.dumps == 0 and s.o.writes == 0 and s.localValue == 0)
  run corruptCompressedRecoveryKeepsOriginalSourceErrorTest = initialized(TRACKED_MODE).then(seedWith(9))
    .then(beginIn(0)).then(releaseRead).then(rejectLoader).then(releaseLoad)
    .expect(s.o.calls == List(SOURCE_ERROR) and s.io.sourceErrors == List(1)
      and s.o.recovery == List("deserialization_error") and s.o.loads == 1
      and s.o.dumps == 0 and s.o.writes == 0)
  run retainedCompressedRecoverySurvivesInvalidationTest = initialized(TRACKED_MODE).then(seedWith(8))
    .then(beginIn(0)).then(releaseRead).then(invalidate).then(rejectLoader).then(releaseLoad)
    .then(beginIn(0)).expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.reads == 1)
    .then(beginIn(1)).then(releaseRead).then(rejectLoader)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, SOURCE_ERROR) and s.io.sourceErrors == List(0, 0, 2)
      and s.o.recovery == List("served", "miss") and s.o.loads == 1 and s.o.writes == 0)
  run closedRequestCannotReceiveCompressedRecoveryTest = initialized(TRACKED_MODE).then(seedWith(8))
    .then(beginIn(0)).then(releaseRead).then(rejectLoader).then(closeContext(0)).then(releaseLoad)
    .then(beginIn(1)).expect(s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.o.reads == 2)
    .expect(s.memo == List(0, 0) and s.localValue == 0 and s.o.writes == 0)
  run trackedSourceNeedsRemoteValidationBeforeLocalReuseTest = initialized(TRACKED_MODE)
    .then(beginIn(0)).then(releaseRead).then(resolveLoader).then(beginIn(0))
    .expect(s.o.calls == List(VALUE_TWO, VALUE_TWO) and s.o.reads == 1)
    .then(beginIn(1)).then(releaseRead).then(releaseLoad).then(beginIn(2))
    .expect(s.o.calls == List(VALUE_TWO, VALUE_TWO, VALUE_TWO, VALUE_TWO)
      and s.o.reads == 2 and s.o.loaders == 1 and s.o.loads == 1)
  run ordinaryValueWorkDoesNotCreateMarkerTest = initialized(TRACKED_MODE).then(observeMarker)
    .then(beginIn(2)).then(releaseRead).then(resolveLoader).then(observeMarker)
    .then(beginIn(2)).then(releaseRead).then(releaseLoad).then(observeMarker)
    .expect(s.markers == List({ cutoffMs: -1, ttlMs: -2 },
      { cutoffMs: -1, ttlMs: -2 }, { cutoffMs: -1, ttlMs: -2 }))
  run ordinaryValueWorkDoesNotExtendMarkerTest = initialized(TRACKED_MODE).then(invalidate).then(observeMarker)
    .then(advanceBy(1)).then(policyWith(2)).then(beginIn(2)).then(releaseRead).then(resolveLoader)
    .then(observeMarker).then(beginIn(2)).then(releaseRead).then(releaseLoad).then(advanceBy(999)).then(observeMarker)
    .expect(s.markers == List({ cutoffMs: 0, ttlMs: 7200000 },
      { cutoffMs: 0, ttlMs: 7199999 }, { cutoffMs: 0, ttlMs: 7199000 }))

  run failedInvalidationPreservesExistingMarkerTest = initialized(TRACKED_MODE).then(invalidate).then(observeMarker)
    .then(advanceBy(1000)).then(writeFaultWith(1)).then(invalidate).then(observeMarker)
    .expect(s.o.maintenance == List("ok", "mutation_error"))
    .expect(s.markers == List({ cutoffMs: 0, ttlMs: 7200000 }, { cutoffMs: 0, ttlMs: 7199000 }))
  run failedInvalidationDoesNotCreateMarkerTest = initialized(TRACKED_MODE).then(writeFaultWith(1))
    .then(invalidate).then(observeMarker)
    .expect(s.o.maintenance == List("mutation_error") and s.markers == List({ cutoffMs: -1, ttlMs: -2 }))
  run freshCompressedReadReportsDecompressionTest = initialized(TRACKED_MODE).then(seedWith(13))
    .then(beginIn(0)).then(releaseRead)
    .expect(s.compression == List("decompressed") and s.o.calls == List(CALL_PENDING))
    .then(releaseLoad).expect(s.o.calls == List(VALUE_ONE) and s.o.loaders == 0 and s.o.loads == 1)
  run corruptCompressedReadReportsRawFallbackTest = initialized(TRACKED_MODE).then(seedWith(14))
    .then(beginIn(0)).then(releaseRead).expect(s.compression == List("fallback_raw"))
    .then(releaseLoad).then(resolveLoader)
    .expect(s.o.calls == List(VALUE_TWO) and s.o.loads == 1 and s.o.loaders == 1 and s.o.writes == 1)

  run heldReadJustBeforeFreshnessBoundaryStillHitsTest = initialized(TRACKED_MODE).then(seedWith(0))
    .then(beginIn(2)).then(advanceBy(999)).then(releaseRead).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.loaders == 0 and s.o.loads == 1 and s.o.recovery == List())
  run untrackedCompressedRecoveryDoesNotWarmLocalTest = initialized(UNTRACKED_MODE).then(seedWith(8))
    .then(beginIn(0)).then(releaseRead).then(rejectLoader).then(releaseLoad)
    .then(beginIn(1)).expect(s.o.calls == List(VALUE_ONE, CALL_PENDING)
      and s.o.reads == 2 and s.localValue == 0 and s.o.dumps == 0 and s.o.writes == 0)
  run compressedRecoveryRechecksMaximumAfterDecodeTest = initialized(TRACKED_MODE).then(seedWith(12))
    .then(beginIn(0)).then(releaseRead).then(rejectLoader)
    .expect(s.compression == List("decompressed") and s.o.calls == List(CALL_PENDING))
    .then(advanceBy(1)).then(releaseLoad)
    .expect(s.o.calls == List(SOURCE_ERROR) and s.io.sourceErrors == List(1)
      and s.o.recovery == List("miss") and s.o.dumps == 0 and s.o.writes == 0)

  // The retained bytes belong to the call. Native expiration affects the next
  // read, but cannot revoke that earlier snapshot while its logical age is valid.
  run retainedSnapshotSurvivesPhysicalExpiryTest = initialized(TRACKED_MODE).then(seedWith(15))
    .then(beginIn(0)).then(releaseRead).then(advanceBy(1000)).then(rejectLoader).then(releaseLoad)
    .then(beginIn(1)).then(releaseRead).then(rejectLoader)
    .expect(s.o.calls == List(VALUE_ONE, SOURCE_ERROR) and s.io.sourceErrors == List(0, 2)
      and s.o.loads == 1 and s.o.reads == 2 and s.o.recovery == List("served", "miss")
      and s.o.dumps == 0 and s.o.writes == 0)

  run unsafeTimestampSkipsSerializerAndAllowsRefillTest = initialized(TRACKED_MODE).then(seedWith(16))
    .then(beginIn(0)).then(releaseRead).expect(s.o.loads == 0 and s.o.loaders == 1)
    .then(resolveLoader).then(beginIn(1)).then(releaseRead).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_TWO, VALUE_TWO) and s.o.reads == 2
      and s.o.loaders == 1 and s.o.loads == 1 and s.o.dumps == 1 and s.o.writes == 1)
  run unsupportedVersionSkipsSerializerAndAllowsRefillTest = initialized(TRACKED_MODE).then(seedWith(17))
    .then(beginIn(0)).then(releaseRead).expect(s.o.loads == 0 and s.o.loaders == 1)
    .then(resolveLoader).then(beginIn(1)).then(releaseRead).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_TWO, VALUE_TWO) and s.o.reads == 2
      and s.o.loaders == 1 and s.o.loads == 1 and s.o.dumps == 1 and s.o.writes == 1)

  run maximumAgeBeforeDecodeKeepsOriginalErrorTest = initialized(TRACKED_MODE).then(seedWith(12))
    .then(beginIn(0)).then(releaseRead).then(advanceBy(1)).then(rejectLoader)
    .expect(s.o.calls == List(SOURCE_ERROR) and s.io.sourceErrors == List(1)
      and s.o.loads == 0 and s.compression == List() and s.o.recovery == List("miss")
      and s.o.dumps == 0 and s.o.writes == 0)

  // An absent read acquired the zero baseline. Invalidation before settlement
  // does not retroactively change that receipt, so the source still writes.
  // The write's equal timestamp is fenced for a subsequent independent read.
  run laterInvalidationDoesNotRewriteObservedMissFenceTest = initialized(TRACKED_MODE)
    .then(beginIn(0)).then(releaseRead).then(invalidate).then(resolveLoader)
    .then(beginIn(1)).then(releaseRead).then(rejectLoader)
    .expect(s.o.calls == List(VALUE_TWO, SOURCE_ERROR) and s.io.sourceErrors == List(0, 2)
      and s.o.dumps == 1 and s.o.writes == 1 and s.o.loads == 0 and s.o.reads == 2
      and s.o.recovery == List("miss"))
}
