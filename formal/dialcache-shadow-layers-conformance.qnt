module dialcache_shadow_layers_conformance {
  import cache_rules.* from "./cache-rules"
  import conformance_observations.* from "./conformance-observations"
  import cohort_boundaries.* from "./cohort-boundaries"
  // Composition: request/local reuse, independent caller sources, and one
  // per-instance registry shared by served-hit and ramped-down shadow jobs.
  // C18/C21/C47/C49/C54 govern captured policy, admission, and publication.
  // Sources and serialization/writes can remain pending. Redis acquisition,
  // decoding and comparison are atomic here; their held-work races belong to
  // the shadow/admission profiles. Callers have no source deadline; every job
  // has the library's 60-second budget. A dark job can abandon its source wait
  // without finishing that caller, while a served job retains its raw source.
  // Three keys, two instances, three persistent scopes, twelve caller starts.
  // Coalescing is explicitly off. Ordinary stale-recovery reads are excluded;
  // dark acquisition includes stale bytes to distinguish its lack of recovery.
  // The explicit input envelope is the portable driver input, including in
  // deterministic regression traces. Expected cache/ownership state is not.

  pure val KEYS = 3
  pure val INSTANCES = 2
  pure val SCOPES = 3
  pure val MAX_CALLS = 12
  pure val JOB_CAPACITY = 2
  pure val JOB_BUDGET_MS = 60000
  pure val LOCAL_TTL_MS = 60000
  pure val SEED_TTL_MS = 180000
  pure val NO_OWNER = -1
  pure val NO_VALUE = 0
  pure val DARK_ALL = 0
  pure val DARK_REQUEST = 1
  pure val DARK_LOCAL = 2
  pure val DARK_NONE = 3
  pure val SERVED_NONE = 4
  pure val SERVED_NO_SHADOW = 5
  pure val DARK_NO_SHADOW = 6
  pure val DARK_INVALID_SHADOW = 7
  pure val DARK_CHANGED_FILL = 8
  pure val COHORT_BELOW = 9
  pure val COHORT_AT = 10
  pure val COHORT_ABOVE = 11
  pure val SERVED_ALL = 12
  pure val SERVED_CHANGED_FILL = 13
  pure val SHADOW_SAMPLE_NUMERATOR = 3203834406
  pure val WAITING_SOURCE = 0
  pure val SERIALIZING = 1
  pure val WRITING = 2
  pure val FINISHED = 3

  type Policy = {
    request: bool, local: bool, serving: bool, shadow: bool,
    freshMs: int, retainedMs: int, choice: int
  }
  type Call = { source: int, hit: int, slot: int }
  type Source = {
    call: int, instance: int, key: int, slot: int, local: bool,
    remote: bool, retainedMs: int, result: int
  }
  type Job = {
    source: int, instance: int, key: int, dark: bool, cached: int,
    admittedAt: int, cachedCreated: int, freshMs: int,
    policyChoice: int, retainedMs: int, phase: int,
    timedOut: bool
  }
  type Write = {
    source: int, job: int, key: int, retainedMs: int,
    phase: int, stamp: int
  }
  type State = {
    o: Observation, now: int, policy: Policy,
    calls: List[Call], sources: List[Source], jobs: List[Job],
    work: List[Write], dumps: List[int], writes: List[int],
    memo: List[int], localValues: List[int], localExpires: List[int],
    remoteValues: List[int], remoteCreated: List[int], remoteExpires: List[int],
    localWriters: List[int]
  }
  var s: State
  var input: { name: str, choice: int }

  pure def zeros(n: int): List[int] =
    0.to(n - 1).fold(List(), (out, _) => out.append(0))
  pure def policyFor(choice: int): Policy = {
    request: Set(DARK_ALL, DARK_REQUEST, DARK_CHANGED_FILL, SERVED_ALL).contains(choice),
    local: Set(DARK_ALL, DARK_LOCAL, DARK_INVALID_SHADOW, DARK_CHANGED_FILL, SERVED_ALL).contains(choice),
    serving: Set(SERVED_NONE, SERVED_NO_SHADOW, SERVED_ALL, SERVED_CHANGED_FILL).contains(choice),
    shadow: if (Set(COHORT_BELOW, COHORT_AT, COHORT_ABOVE).contains(choice))
      cohortAdmits(SHADOW_SAMPLE_NUMERATOR,
        thresholdForRelation(SHADOW_SAMPLE_NUMERATOR, choice - COHORT_BELOW))
      else not(Set(SERVED_NO_SHADOW, DARK_NO_SHADOW, DARK_INVALID_SHADOW,
        SERVED_CHANGED_FILL).contains(choice)),
    freshMs: if (Set(DARK_CHANGED_FILL, SERVED_CHANGED_FILL).contains(choice)) 120000 else 60000,
    retainedMs: if (Set(DARK_CHANGED_FILL, SERVED_CHANGED_FILL).contains(choice)) 180000 else 120000,
    choice: choice
  }
  pure def instance(context: int): int = if (context == 2 or context == 4) 1 else 0
  pure def liveJobs(state: State): Set[int] =
    state.jobs.indices().filter(i => state.jobs.nth(i).phase != FINISHED)
  pure def frame(state: State, key: int): int =
    if (state.now < state.remoteExpires.nth(key)) state.remoteValues.nth(key) else NO_VALUE
  pure def fresh(state: State, key: int): int =
    if (freshAgeAllowed(state.remoteCreated.nth(key), state.now, state.policy.freshMs)) frame(state, key) else NO_VALUE
  pure def ordinaryStaleCandidate(state: State, key: int): bool =
    frame(state, key) > NO_VALUE and fresh(state, key) == NO_VALUE
      and recoveryAgeAllowed(state.remoteCreated.nth(key), state.now, state.policy.retainedMs)

  action init = all {
    input' = { name: "init", choice: -1 },
    s' = {
      o: empty, now: 100000, policy: policyFor(DARK_ALL),
      calls: List(), sources: List(), jobs: List(), work: List(),
      dumps: List(), writes: List(), memo: zeros(SCOPES * KEYS),
      localValues: zeros(INSTANCES * KEYS), localExpires: zeros(INSTANCES * KEYS),
      remoteValues: zeros(KEYS), remoteCreated: zeros(KEYS), remoteExpires: zeros(KEYS),
      localWriters: 0.to(INSTANCES * KEYS - 1).fold(List(), (out, _) => out.append(NO_OWNER))
    }
  }

  // Public cache/source results are owned by callers. Detached served-hit
  // sources never enter this path and cannot warm request or local storage.
  pure def finishCaller(state: State, call: int, value: int): State = {
    val entry = state.calls.nth(call)
    {
      o: { calls: state.o.calls.replaceAt(call, value), ...state.o },
      memo: if (entry.slot >= 0 and value != SOURCE_ERROR)
        state.memo.replaceAt(entry.slot, value) else state.memo,
      ...state
    }
  }
  pure def publishSource(state: State, source: int): State = {
    val entry = state.sources.nth(source)
    val localSlot = entry.instance * KEYS + entry.key
    finishCaller({
      localValues: if (entry.local)
        state.localValues.replaceAt(localSlot, entry.result) else state.localValues,
      localExpires: if (entry.local)
        state.localExpires.replaceAt(localSlot, state.now + LOCAL_TTL_MS) else state.localExpires,
      localWriters: if (entry.local)
        state.localWriters.replaceAt(localSlot, source) else state.localWriters,
      ...state
    }, entry.call, entry.result)
  }
  // A validated serving hit can warm the active local layer. This publication
  // belongs to the foreground read; a dark C0 and a diagnostic source cannot
  // use it. Source ownership checks deliberately exclude this separate origin.
  pure def publishFreshHit(state: State, call: int, inst: int, key: int, value: int): State = {
    val slot = inst * KEYS + key
    finishCaller({
      localValues: if (state.policy.local)
        state.localValues.replaceAt(slot, value) else state.localValues,
      localExpires: if (state.policy.local)
        state.localExpires.replaceAt(slot, state.now + LOCAL_TTL_MS) else state.localExpires,
      localWriters: if (state.policy.local)
        state.localWriters.replaceAt(slot, NO_OWNER) else state.localWriters,
      ...state
    }, call, value)
  }
  pure def finishJob(state: State, job: int, outcome: str): State = {
    val entry = state.jobs.nth(job)
    {
      jobs: state.jobs.replaceAt(job, { phase: FINISHED, ...entry }),
      o: { shadow: if (entry.timedOut) state.o.shadow else state.o.shadow.append(outcome), ...state.o },
      ...state
    }
  }
  pure def beginWrite(state: State, source: int, job: int, retainedMs: int): State = {
    val entry = state.sources.nth(source)
    {
      work: state.work.append({ source: source, job: job, key: entry.key,
        retainedMs: retainedMs, phase: SERIALIZING, stamp: 0 }),
      dumps: state.dumps.append(state.work.length()),
      jobs: if (job >= 0) state.jobs.replaceAt(job, {
        phase: SERIALIZING, ...state.jobs.nth(job)
      }) else state.jobs,
      o: { dumps: state.o.dumps + 1, ...state.o },
      ...state
    }
  }

  // A job shares the source result, never the caller's cache-publication path.
  // Its C0 payload is acquired once. Later replacement only affects C1.
  pure def settleJob(state: State, job: int): State = {
    val entry = state.jobs.nth(job)
    val result = state.sources.nth(entry.source).result
    if (entry.timedOut) finishJob(state, job, "timeout")
    else if (result == SOURCE_ERROR) finishJob(state, job, "source_error")
    else if (entry.cached == NO_VALUE) beginWrite(state, entry.source, job, entry.retainedMs)
    else {
      val decoded = { o: { loads: state.o.loads + 1, ...state.o }, ...state }
      if (entry.cached == result) finishJob(decoded, job, "match")
      else finishJob({ o: { reads: decoded.o.reads + 1, ...decoded.o }, ...decoded }, job,
        if (frame(state, entry.key) == entry.cached) "mismatch" else "superseded")
    }
  }
  pure def admit(state: State, source: int, dark: bool, cached: int): State = {
    val entry = state.sources.nth(source)
    val active = liveJobs(state)
    val duplicate = active.exists(i => state.jobs.nth(i).instance == entry.instance
      and state.jobs.nth(i).key == entry.key)
    val full = active.filter(i => state.jobs.nth(i).instance == entry.instance).size() >= JOB_CAPACITY
    if (not(state.policy.shadow)) state
    else if (duplicate or full) {
      o: { shadow: state.o.shadow.append("dropped"), ...state.o }, ...state
    } else {
      jobs: state.jobs.append({ source: source, instance: entry.instance,
        key: entry.key, dark: dark, cached: cached, admittedAt: state.now,
        cachedCreated: state.remoteCreated.nth(entry.key), freshMs: state.policy.freshMs,
        policyChoice: state.policy.choice, retainedMs: state.policy.retainedMs,
        phase: WAITING_SOURCE, timedOut: false }),
      o: { reads: state.o.reads + (if (dark) 1 else 0), ...state.o },
      ...state
    }
  }
  pure def startCaller(state: State, call: int, inst: int, key: int, slot: int): State = {
    val source = state.sources.length()
    val started = {
      sources: state.sources.append({ call: call, instance: inst, key: key, slot: slot,
        local: state.policy.local and not(state.policy.serving),
        remote: state.policy.serving, retainedMs: state.policy.retainedMs, result: CALL_PENDING }),
      calls: state.calls.replaceAt(call, { source: source, ...state.calls.nth(call) }),
      o: { loaders: state.o.loaders + 1, sourceScopes: state.o.sourceScopes.append(true), ...state.o },
      ...state
    }
    if (state.policy.serving) started else admit(started, source, true, fresh(state, key))
  }
  pure def servedJob(state: State, inst: int, key: int, value: int): State = {
    val source = state.sources.length()
    val provisional = {
      sources: state.sources.append({ call: NO_OWNER, instance: inst, key: key,
        slot: NO_OWNER, local: false, remote: false, retainedMs: 0, result: CALL_PENDING }),
      ...state
    }
    val admitted = admit(provisional, source, false, value)
    if (admitted.jobs.length() == state.jobs.length()) {
      sources: state.sources, ...admitted
    } else {
      o: { loaders: state.o.loaders + 1, sourceScopes: state.o.sourceScopes.append(false), ...admitted.o },
      ...admitted
    }
  }
  pure def begin(state: State, choice: int): State = {
    val context = choice / KEYS
    val key = choice % KEYS
    val inst = instance(context)
    val slot = if (context < SCOPES and state.policy.request) context * KEYS + key else NO_OWNER
    val localSlot = inst * KEYS + key
    val requestHit = if (slot >= 0) state.memo.nth(slot) else NO_VALUE
    val localHit = if (state.policy.local and localEntryLiveAt(state.now, state.localExpires.nth(localSlot)))
      state.localValues.nth(localSlot) else NO_VALUE
    val remoteHit = if (state.policy.serving) fresh(state, key) else NO_VALUE
    val hit = if (requestHit > NO_VALUE) requestHit else if (localHit > NO_VALUE) localHit else remoteHit
    val call = state.calls.length()
    val entered = {
      calls: state.calls.append({ source: NO_OWNER, hit: hit, slot: slot }),
      o: { calls: state.o.calls.append(CALL_PENDING), policyCalls: state.o.policyCalls + 1, ...state.o },
      ...state
    }
    if (requestHit > NO_VALUE or localHit > NO_VALUE) finishCaller(entered, call, hit)
    else {
      val read = {
        o: { reads: entered.o.reads + (if (state.policy.serving) 1 else 0),
          loads: entered.o.loads + (if (remoteHit > NO_VALUE) 1 else 0), ...entered.o },
        ...entered
      }
      if (remoteHit > NO_VALUE)
        servedJob(publishFreshHit(read, call, inst, key, hit), inst, key, hit)
      else startCaller(read, call, inst, key, slot)
    }
  }
  action beginAt(choice: int): bool = all {
    s.calls.length() < MAX_CALLS,
    not(Set(COHORT_BELOW, COHORT_AT, COHORT_ABOVE).contains(s.policy.choice)) or choice % KEYS == 0,
    not(s.policy.serving and ordinaryStaleCandidate(s, choice % KEYS)),
    input' = { name: "beginCall", choice: choice },
    s' = begin(s, choice)
  }
  action beginCall = {
    nondet choice = 0.to(14).oneOf()
    beginAt(choice)
  }

  pure def settle(state: State, source: int, value: int): State = {
    val entry = state.sources.nth(source)
    val settled = { sources: state.sources.replaceAt(source, { result: value, ...entry }), ...state }
    // The ordinary serving path still classifies its original source error,
    // even when acquisition retained no candidate. A dark source never does.
    val failed = if (value == SOURCE_ERROR and entry.remote) {
      o: { classifications: settled.o.classifications + 1,
        recovery: settled.o.recovery.append("miss"), ...settled.o }, ...settled
    } else settled
    val caller = if (entry.call < 0) failed
      else if (value == SOURCE_ERROR) finishCaller(failed, entry.call, value)
      else if (entry.remote) beginWrite(settled, source, NO_OWNER, entry.retainedMs)
      else publishSource(settled, source)
    caller.jobs.indices().filter(i => caller.jobs.nth(i).source == source
      and caller.jobs.nth(i).phase == WAITING_SOURCE).fold(caller, (updated, job) => settleJob(updated, job))
  }
  action resolveAt(choice: int): bool = {
    val source = (choice - 1) / 2
    all {
      s.sources.indices().contains(source),
      s.sources.nth(source).result == CALL_PENDING,
      input' = { name: "resolveLoader", choice: choice },
      s' = settle(s, source, (choice - 1) % 2 + 1)
    }
  }
  action resolveLoader = {
    nondet choice = 1.to(MAX_CALLS * 4).oneOf()
    resolveAt(choice)
  }
  action rejectAt(choice: int): bool = all {
    s.sources.indices().contains(choice),
    s.sources.nth(choice).result == CALL_PENDING,
    input' = { name: "rejectLoader", choice: choice },
    s' = settle(s, choice, SOURCE_ERROR)
  }
  action rejectLoader = {
    nondet choice = s.sources.indices().filter(i => s.sources.nth(i).result == CALL_PENDING).oneOf()
    rejectAt(choice)
  }
  action rejectTimeoutAt(choice: int): bool = all {
    s.sources.indices().contains(choice),
    s.sources.nth(choice).result == CALL_PENDING,
    input' = { name: "rejectTimeout", choice: choice },
    s' = settle(s, choice, SOURCE_ERROR)
  }
  action rejectTimeout = {
    nondet choice = s.sources.indices().filter(i => s.sources.nth(i).result == CALL_PENDING).oneOf()
    rejectTimeoutAt(choice)
  }

  pure def dumpReply(state: State, index: int): State = {
    val workIndex = state.dumps.nth(index)
    val work = state.work.nth(workIndex)
    if (work.job >= 0 and state.jobs.nth(work.job).timedOut) {
      work: state.work.replaceAt(workIndex, { phase: FINISHED, ...work }),
      ...finishJob(state, work.job, "timeout")
    } else {
      work: state.work.replaceAt(workIndex, { phase: WRITING, stamp: state.now, ...work }),
      writes: state.writes.append(workIndex),
      jobs: if (work.job >= 0) state.jobs.replaceAt(work.job, {
        phase: WRITING, ...state.jobs.nth(work.job)
      }) else state.jobs,
      o: { writes: state.o.writes + 1, writeTtls: state.o.writeTtls.append(work.retainedMs), ...state.o },
      ...state
    }
  }
  action releaseDumpAt(choice: int): bool = all {
    s.dumps.indices().contains(choice),
    s.work.nth(s.dumps.nth(choice)).phase == SERIALIZING,
    input' = { name: "releaseDump", choice: choice },
    s' = dumpReply(s, choice)
  }
  action releaseDump = {
    nondet choice = s.dumps.indices().filter(i => s.work.nth(s.dumps.nth(i)).phase == SERIALIZING).oneOf()
    releaseDumpAt(choice)
  }
  pure def writeReply(state: State, index: int): State = {
    val workIndex = state.writes.nth(index)
    val work = state.work.nth(workIndex)
    val value = state.sources.nth(work.source).result
    val stored = {
      work: state.work.replaceAt(workIndex, { phase: FINISHED, ...work }),
      remoteValues: state.remoteValues.replaceAt(work.key, value),
      remoteCreated: state.remoteCreated.replaceAt(work.key, work.stamp),
      remoteExpires: state.remoteExpires.replaceAt(work.key, state.now + work.retainedMs),
      ...state
    }
    if (work.job >= 0) finishJob(stored, work.job, "filled")
    else publishSource(stored, work.source)
  }
  action releaseWriteAt(choice: int): bool = all {
    s.writes.indices().contains(choice),
    s.work.nth(s.writes.nth(choice)).phase == WRITING,
    input' = { name: "releaseWrite", choice: choice },
    s' = writeReply(s, choice)
  }
  action releaseWrite = {
    nondet choice = s.writes.indices().filter(i => s.work.nth(s.writes.nth(i)).phase == WRITING).oneOf()
    releaseWriteAt(choice)
  }

  pure def tick(state: State, elapsed: int): State = {
    val advanced = { now: state.now + elapsed, ...state }
    state.jobs.indices().fold(advanced, (updated, index) => {
      val job = updated.jobs.nth(index)
      if (job.phase == FINISHED or job.timedOut or deadlinePendingAt(updated.now, job.admittedAt + JOB_BUDGET_MS)) updated
      else {
        jobs: updated.jobs.replaceAt(index, {
          timedOut: true,
          phase: if (job.dark and job.phase == WAITING_SOURCE) FINISHED else job.phase,
          ...job
        }),
        o: { shadow: updated.o.shadow.append("timeout"), ...updated.o },
        ...updated
      }
    })
  }
  action advanceBy(choice: int): bool = all {
    s.now + choice <= 600000,
    input' = { name: "advance", choice: choice },
    s' = tick(s, choice)
  }
  action advance = {
    nondet choice = Set(1, JOB_BUDGET_MS, 120000).oneOf()
    advanceBy(choice)
  }
  action setPolicy(choice: int): bool = all {
    input' = { name: "policy", choice: choice },
    s' = { policy: policyFor(choice), ...s }
  }
  action policy = {
    nondet choice = 0.to(SERVED_CHANGED_FILL).oneOf()
    setPolicy(choice)
  }
  action seedAt(choice: int): bool = {
    val key = choice / 4
    val age = if (choice % 4 == 2) 59999 else if (choice % 4 == 3) 60000 else 0
    all {
      input' = { name: "seed", choice: choice },
      s' = {
        remoteValues: s.remoteValues.replaceAt(key, if (choice % 4 == 1) VALUE_TWO else VALUE_ONE),
        remoteCreated: s.remoteCreated.replaceAt(key, s.now - age),
        remoteExpires: s.remoteExpires.replaceAt(key, s.now + SEED_TTL_MS),
        ...s
      }
    }
  }
  action seed = {
    nondet choice = 0.to(11).oneOf()
    seedAt(choice)
  }
  action step = any { beginCall, resolveLoader, rejectLoader, rejectTimeout,
    releaseDump, releaseWrite, advance, policy, seed }

  // Independent checks use captured source/job facts, not admission helpers.
  val boundedSharedJobRegistry = 0.to(INSTANCES - 1).forall(inst =>
    s.jobs.indices().filter(i => s.jobs.nth(i).instance == inst
      and s.jobs.nth(i).phase != FINISHED).size() <= JOB_CAPACITY)
  val oneJobPerInstanceKey = s.jobs.indices().forall(a => s.jobs.indices().forall(b =>
    a == b or s.jobs.nth(a).phase == FINISHED or s.jobs.nth(b).phase == FINISHED
      or s.jobs.nth(a).instance != s.jobs.nth(b).instance or s.jobs.nth(a).key != s.jobs.nth(b).key))
  val localPublicationBelongsToCaller = s.localWriters.indices().forall(slot => {
    val owner = s.localWriters.nth(slot)
    owner < 0 or (s.sources.nth(owner).call >= 0 and s.sources.nth(owner).local
      and s.sources.nth(owner).result == s.localValues.nth(slot)
      and s.sources.nth(owner).result > CALL_PENDING and s.sources.nth(owner).result != SOURCE_ERROR)
  })
  val sourcesRemainIndependentOfJobs = s.o.loaders == s.sources.length()
    and s.o.sourceScopes == s.sources.foldl(List(), (scopes, source) => scopes.append(source.call >= 0))
  val hitResultsAreImmutable = s.calls.indices().forall(call =>
    s.calls.nth(call).hit == NO_VALUE or s.o.calls.nth(call) == s.calls.nth(call).hit)
  val callerSourceOwnsItsResult = s.calls.indices().forall(call => {
    val owner = s.calls.nth(call).source
    owner < 0 or s.o.calls.nth(call) == CALL_PENDING
      or s.o.calls.nth(call) == s.sources.nth(owner).result
  })
  val disabledCohortsNeverOwnJobs = s.jobs.indices().forall(i =>
    not(Set(SERVED_NO_SHADOW, DARK_NO_SHADOW, DARK_INVALID_SHADOW,
      COHORT_BELOW, COHORT_AT, SERVED_CHANGED_FILL).contains(s.jobs.nth(i).policyChoice)))
  val darkJobsNeverRecover = {
    val ordinaryFailures = s.sources.indices().filter(i =>
      s.sources.nth(i).remote and s.sources.nth(i).result == SOURCE_ERROR).size()
    s.o.classifications == ordinaryFailures
      and s.o.recovery == 0.to(ordinaryFailures - 1).fold(List(), (out, _) => out.append("miss"))
  }
  val fillKeepsCapturedRetention = s.work.indices().forall(i => s.work.nth(i).job < 0
    or s.work.nth(i).retainedMs == s.jobs.nth(s.work.nth(i).job).retainedMs)
  val servedJobsNeverWrite = s.work.indices().forall(i => s.work.nth(i).job < 0 or s.jobs.nth(s.work.nth(i).job).dark)
  val timedOutDarkSourceWaitReleases = s.jobs.indices().forall(i =>
    not(s.jobs.nth(i).dark and s.jobs.nth(i).timedOut and s.jobs.nth(i).phase == WAITING_SOURCE))
  val unboundedCallerKeepsPendingSource = s.sources.indices().forall(i =>
    s.sources.nth(i).call < 0 or s.sources.nth(i).result != CALL_PENDING
      or s.o.calls.nth(s.sources.nth(i).call) == CALL_PENDING)
  val retainedC0WasFreshWhenAcquired = s.jobs.indices().forall(i => {
    val job = s.jobs.nth(i)
    job.cached == NO_VALUE or job.admittedAt - job.cachedCreated < job.freshMs
  })
  val retentionComesFromAdmissionPolicy = s.jobs.indices().forall(i => {
    val job = s.jobs.nth(i)
    job.retainedMs == (if (job.policyChoice == DARK_CHANGED_FILL) 180000 else 120000)
  })

  // Each regression uses only public input transitions. Later calls distinguish
  // real storage reuse/publication from a counter or an internal phase alone.
  run darkSourcePublishesLocalBeforeShadowWriteTest = init
    .then(setPolicy(DARK_LOCAL)).then(beginAt(9)).then(resolveAt(1))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.dumps == 1 and s.o.writes == 0)
    .then(setPolicy(SERVED_ALL)).then(beginAt(9))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1
      and s.o.reads == 1 and s.o.shadow == List())

  run darkSourcePublishesRequestBeforeShadowWriteTest = init
    .then(setPolicy(DARK_REQUEST)).then(beginAt(0)).then(resolveAt(1))
    .then(setPolicy(SERVED_ALL)).then(beginAt(0))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1
      and s.o.reads == 1 and s.o.writes == 0)
    .then(setPolicy(DARK_REQUEST)).then(beginAt(3))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, CALL_PENDING)
      and s.o.loaders == 2 and s.o.shadow == List("dropped"))

  run darkPresentC0NeverBecomesLocalPublicationTest = init
    .then(setPolicy(DARK_LOCAL)).then(seedAt(0)).then(beginAt(9)).then(beginAt(9))
    .expect(s.o.calls == List(CALL_PENDING, CALL_PENDING) and s.o.loaders == 2
      and s.o.reads == 1 and s.o.loads == 0 and s.o.shadow == List("dropped"))
    .then(resolveAt(2)).then(setPolicy(SERVED_ALL)).then(beginAt(9))
    .expect(s.o.calls == List(VALUE_TWO, CALL_PENDING, VALUE_TWO)
      and s.o.loaders == 2 and s.o.reads == 2 and s.o.writes == 0
      and s.o.shadow == List("dropped", "mismatch"))

  run darkPresentC0NeverBecomesRequestPublicationTest = init
    .then(setPolicy(DARK_REQUEST)).then(seedAt(0)).then(beginAt(0)).then(beginAt(0))
    .expect(s.o.calls == List(CALL_PENDING, CALL_PENDING) and s.o.loaders == 2
      and s.o.reads == 1 and s.o.loads == 0 and s.o.shadow == List("dropped"))
    .then(resolveAt(2)).then(setPolicy(SERVED_ALL)).then(beginAt(0))
    .expect(s.o.calls == List(VALUE_TWO, CALL_PENDING, VALUE_TWO)
      and s.o.loaders == 2 and s.o.reads == 2 and s.o.writes == 0)
    .then(setPolicy(DARK_REQUEST)).then(beginAt(3))
    .expect(s.o.calls == List(VALUE_TWO, CALL_PENDING, VALUE_TWO, CALL_PENDING)
      and s.o.loaders == 3 and s.o.reads == 3)

  run deduplicatedJobKeepsIndependentCallerSourcesTest = init
    .then(setPolicy(DARK_NONE)).then(beginAt(9)).then(beginAt(9))
    .expect(s.o.loaders == 2 and s.o.reads == 1 and s.o.shadow == List("dropped"))
    .then(resolveAt(4))
    .expect(s.o.calls == List(CALL_PENDING, VALUE_TWO) and s.o.dumps == 0)
    .then(resolveAt(1)).then(releaseDumpAt(0)).then(releaseWriteAt(0))
    .then(setPolicy(SERVED_NO_SHADOW)).then(beginAt(9))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE)
      and s.o.loaders == 2 and s.o.writes == 1 and s.o.shadow == List("dropped", "filled"))

  run darkFailureDoesNotUseEligibleStaleBytesTest = init
    .then(setPolicy(DARK_NONE)).then(seedAt(3)).then(beginAt(9)).then(rejectAt(0))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.loads == 0 and s.o.dumps == 0
      and s.o.classifications == 0 and s.o.recovery == List() and s.o.shadow == List("source_error"))

  run invalidShadowKeepsLocalPublicationTest = init
    .then(setPolicy(DARK_INVALID_SHADOW)).then(beginAt(9)).then(resolveAt(1))
    .then(setPolicy(SERVED_ALL)).then(beginAt(9))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1
      and s.o.reads == 0 and s.o.writes == 0 and s.o.shadow == List())

  run unboundedCallerSurvivesDarkJobDeadlineTest = init
    .then(setPolicy(DARK_NONE)).then(beginAt(9)).then(advanceBy(JOB_BUDGET_MS))
    .expect(s.o.calls == List(CALL_PENDING) and s.o.shadow == List("timeout"))
    .then(beginAt(9))
    .expect(s.o.loaders == 2 and s.o.reads == 2 and s.o.shadow == List("timeout"))
    .then(resolveAt(1))
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.o.dumps == 0)
    .then(resolveAt(4))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO) and s.o.dumps == 1)

  run servedAndDarkJobsShareCapacityButNotSourceOwnershipTest = init
    .then(seedAt(0)).then(setPolicy(SERVED_NONE)).then(beginAt(9))
    .then(setPolicy(DARK_NONE)).then(beginAt(10)).then(beginAt(11))
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING, CALL_PENDING)
      and s.o.loaders == 3 and s.o.reads == 2 and s.o.shadow == List("dropped"))
    .then(advanceBy(JOB_BUDGET_MS)).then(beginAt(11))
    .expect(s.o.loaders == 4 and s.o.reads == 3
      and s.o.shadow == List("dropped", "timeout", "timeout"))
    // The new dark key occupies the released dark slot. A further distinct
    // key is still dropped until the served job's raw source settles.
    .then(beginAt(10))
    .expect(s.o.loaders == 5 and s.o.reads == 3
      and s.o.shadow == List("dropped", "timeout", "timeout", "dropped"))
    .then(resolveAt(2)).then(beginAt(10))
    .expect(s.o.loaders == 6 and s.o.reads == 4
      and s.o.shadow == List("dropped", "timeout", "timeout", "dropped"))
    .then(resolveAt(4))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, CALL_PENDING,
        CALL_PENDING, CALL_PENDING, CALL_PENDING)
      and s.o.loads == 1 and s.o.dumps == 0)

  run fullMixedInstanceDoesNotBlockAnotherInstanceTest = init
    .then(seedAt(0)).then(setPolicy(SERVED_NONE)).then(beginAt(9))
    .then(setPolicy(DARK_NONE)).then(beginAt(10)).then(beginAt(11)).then(beginAt(14))
    .expect(s.o.loaders == 4 and s.o.reads == 3 and s.o.shadow == List("dropped")
      and s.o.sourceScopes == List(false, true, true, true))

  run servedDiagnosticSourceDoesNotPopulateLocalTest = init
    .then(seedAt(0)).then(setPolicy(SERVED_NONE)).then(beginAt(9)).then(resolveAt(2))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.writes == 0 and s.o.shadow == List("mismatch"))
    .then(setPolicy(DARK_LOCAL)).then(beginAt(9))
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.o.loaders == 2)

  run validatedRemoteHitStopsFurtherShadowTest = init
    .then(seedAt(0)).then(setPolicy(SERVED_ALL)).then(beginAt(9)).then(beginAt(9))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1
      and s.o.reads == 1 and s.o.loads == 1 and s.o.shadow == List())
    .then(resolveAt(2)).then(beginAt(9))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE) and s.o.loaders == 1
      and s.o.reads == 2 and s.o.writes == 0 and s.o.shadow == List("mismatch"))

  run ordinaryServingMissDoesNotAdmitDiagnosticSourceTest = init
    .then(setPolicy(SERVED_NONE)).then(beginAt(9))
    .expect(s.o.calls == List(CALL_PENDING) and s.o.loaders == 1
      and s.o.reads == 1 and s.o.sourceScopes == List(true) and s.o.shadow == List())
    .then(resolveAt(2)).then(releaseDumpAt(0)).then(releaseWriteAt(0))
    .then(setPolicy(SERVED_NO_SHADOW)).then(beginAt(9))
    .expect(s.o.calls == List(VALUE_TWO, VALUE_TWO) and s.o.loaders == 1
      and s.o.writes == 1 and s.o.shadow == List())

  run shadowCohortBelowDoesNotAdmitTest = init
    .then(setPolicy(COHORT_BELOW)).then(beginAt(9)).then(resolveAt(1))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.reads == 0 and s.o.shadow == List())
  run shadowCohortEqualityDoesNotAdmitTest = init
    .then(setPolicy(COHORT_AT)).then(beginAt(9)).then(resolveAt(1))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.reads == 0 and s.o.shadow == List())
  run shadowCohortAboveAdmitsTest = init
    .then(setPolicy(COHORT_ABOVE)).then(beginAt(9)).then(resolveAt(1))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.reads == 1 and s.o.dumps == 1)

  run darkFillRetainsPolicyThroughSerializationTest = init
    .then(setPolicy(DARK_NONE)).then(beginAt(9)).then(setPolicy(DARK_CHANGED_FILL))
    .then(resolveAt(1)).then(setPolicy(SERVED_CHANGED_FILL))
    .then(releaseDumpAt(0)).then(releaseWriteAt(0))
    .expect(s.o.writeTtls == List(120000) and s.o.shadow == List("filled"))
    .then(advanceBy(120000)).then(setPolicy(SERVED_CHANGED_FILL)).then(beginAt(9)).then(rejectAt(1))
    .expect(s.o.calls == List(VALUE_ONE, SOURCE_ERROR) and s.o.recovery == List("miss")
      and s.o.classifications == 1 and s.o.loaders == 2)

  run retainedFreshC0StillComparesAfterFreshnessBoundaryTest = init
    .then(setPolicy(DARK_NONE)).then(seedAt(2)).then(beginAt(9))
    .then(advanceBy(1)).then(resolveAt(2))
    .expect(s.o.calls == List(VALUE_TWO) and s.o.loads == 1 and s.o.reads == 2
      and s.o.writes == 0 and s.o.shadow == List("mismatch"))

  run expiredC0CanFillAndServeNewValueTest = init
    .then(setPolicy(DARK_NONE)).then(seedAt(3)).then(beginAt(9)).then(resolveAt(2))
    .then(releaseDumpAt(0)).then(releaseWriteAt(0))
    .then(setPolicy(SERVED_NO_SHADOW)).then(beginAt(9))
    .expect(s.o.calls == List(VALUE_TWO, VALUE_TWO) and s.o.loaders == 1
      and s.o.reads == 2 and s.o.loads == 1 and s.o.shadow == List("filled"))

  run acquiredMissDoesNotRereadBeforeFillTest = init
    .then(setPolicy(DARK_NONE)).then(beginAt(9)).then(seedAt(0)).then(resolveAt(2))
    .then(releaseDumpAt(0)).then(releaseWriteAt(0))
    .expect(s.o.reads == 1 and s.o.writes == 1 and s.o.shadow == List("filled"))
    .then(setPolicy(SERVED_NO_SHADOW)).then(beginAt(9))
    .expect(s.o.calls == List(VALUE_TWO, VALUE_TWO) and s.o.reads == 2 and s.o.loaders == 1)

  run darkPropagatedTimeoutIsSourceFailureTest = init
    .then(setPolicy(DARK_NONE)).then(beginAt(9)).then(rejectTimeoutAt(0))
    .expect(s.o.calls == List(SOURCE_ERROR) and s.o.shadow == List("source_error"))
  run servedPropagatedTimeoutPreservesHitTest = init
    .then(seedAt(0)).then(setPolicy(SERVED_NONE)).then(beginAt(9)).then(rejectTimeoutAt(0))
    .expect(s.o.calls == List(VALUE_ONE) and s.o.shadow == List("source_error"))
}
