module dialcache_admission_conformance {
  import conformance_observations.* from "./conformance-observations"
  import cache_rules.* from "./cache-rules"
  // Served Redis hits: three keys, two instances, two shadow slots per instance.
  // Read/decode effects are held explicitly. Only shadow jobs invoke sources.
  // Caller phases: 1 read, 2 decode, 3 done. Job phases: 1 source, 2 decode,
  // 3 confirmation, 4 done. A timed-out job retains its pending external work.
  // State: o is the public projection; calls/jobs and held effects explain
  // ownership and later results. Job completion never publishes shared values.
  // Environment: fresh served Redis hits, held reads/decodes, explicit source
  // settlements and elapsed clock steps. Timed-out work remains releasable.
  // Bounds: three keys, two instances, two job slots each, sixteen callers;
  // elapsed time stays below read deadlines and physical Redis expiration.

  // -- Stable caller/job phases and policy encodings -------------------------

  pure val CALL_READING = 1
  pure val CALL_DECODING = 2
  pure val CALL_FINISHED = 3
  pure val JOB_SOURCE_PENDING = 1
  pure val JOB_DECODING = 2
  pure val JOB_CONFIRMING = 3
  pure val JOB_FINISHED = 4
  pure val POLICY_DEFAULT = 0
  pure val POLICY_NO_SHADOW = 1
  pure val POLICY_NO_COALESCING = 2
  pure val POLICY_NO_SHADOW_OR_COALESCING = 3
  pure val NO_OWNER = -1
  pure val NO_ACQUIRED_VALUE = 0
  pure val KEYS_PER_INSTANCE = 3
  pure val JOBS_PER_INSTANCE = 2
  pure val MAX_CALLERS = 16
  pure val MAX_IDENTITY_CHOICE = 5
  pure val SOURCE_VALUE_COUNT = 2
  pure val MAX_RESOLVE_CHOICE = 32
  pure val SHADOW_TIMEOUT_MS = 10
  pure val MAX_ELAPSED_MS = 600

  // -- State and initial environment -----------------------------------------

  type Call = {
    identity: int,
    shared: bool,
    selected: bool,
    phase: int,
    value: int
  }
  type Job = {
    identity: int,
    phase: int,
    value: int,
    sourceValue: int,
    deadline: int,
    timedOut: bool
  }
  type Effect = {
    job: bool,
    owner: int,
    pending: bool
  }
  type State = {
    o: Observation,
    now: int,
    overlay: int,
    frames: List[int],
    calls: List[Call],
    owners: List[int],
    registered: List[int],
    jobs: List[Job],
    reads: List[Effect],
    loads: List[Effect]
  }
  var s: State
  var input: { name: str, choice: int }
  action init = all {
    input' = { name: "init", choice: -1 },
    s' = {
      o: empty,
      now: 0,
      overlay: POLICY_DEFAULT,
      frames: List(VALUE_ONE, VALUE_ONE, VALUE_ONE),
      calls: List(),
      owners: List(),
      registered: List(NO_OWNER, NO_OWNER, NO_OWNER, NO_OWNER, NO_OWNER, NO_OWNER),
      jobs: List(),
      reads: List(),
      loads: List()
    }
  }

  // -- Caller admission and job capacity -------------------------------------

  pure def liveJobs(state: State): Set[int] =
    state.jobs.indices().filter(i => state.jobs.nth(i).phase != JOB_FINISHED)
  pure def begin(state: State, identity: int): State = {
    val shared = state.overlay < POLICY_NO_COALESCING
    val leader = if (shared) state.registered.nth(identity) else NO_OWNER
    val starts = leader < 0
    val owner = if (starts) state.calls.length() else leader
    {
      calls: if (starts) state.calls.append({
        identity: identity,
        shared: shared,
        selected: state.overlay % 2 == POLICY_DEFAULT,
        phase: CALL_READING,
        value: NO_ACQUIRED_VALUE
      }) else state.calls,
      owners: state.owners.append(owner),
      registered: if (starts and shared) state.registered.replaceAt(identity, owner) else state.registered,
      reads: if (starts) state.reads.append({
        job: false,
        owner: owner,
        pending: true
      }) else state.reads,
      o: {
        calls: state.o.calls.append(CALL_PENDING),
        reads: state.o.reads + (if (starts) 1 else 0),
        policyCalls: state.o.policyCalls + 1,
        ...state.o
      },
      ...state
    }
  }
  action beginWith(choice: int): bool = all {
    (0.to(MAX_IDENTITY_CHOICE)).contains(choice),
    input' = { name: "beginCall", choice: choice },
    s.o.calls.length() < MAX_CALLERS,
    s' = begin(s, choice)
  }
  action beginCall = {
    nondet choice = 0.to(MAX_IDENTITY_CHOICE).oneOf()
    beginWith(choice)
  }
  pure def finishJob(state: State, job: int, outcome: str): State = {
    val entry = state.jobs.nth(job)
    {
      jobs: state.jobs.replaceAt(job, { phase: JOB_FINISHED, ...entry }),
      o: {
        shadow: if (entry.timedOut) state.o.shadow else state.o.shadow.append(outcome),
        ...state.o
      },
      ...state
    }
  }
  pure def finishCall(state: State, call: int): State = {
    val entry = state.calls.nth(call)
    val active = liveJobs(state)
    val duplicate = active.exists(i => state.jobs.nth(i).identity == entry.identity)
    val full = active.filter(i =>
      state.jobs.nth(i).identity / KEYS_PER_INSTANCE == entry.identity / KEYS_PER_INSTANCE
    ).size() >= JOBS_PER_INSTANCE
    val admitted = entry.selected and not(duplicate or full)
    {
      calls: state.calls.replaceAt(call, { phase: CALL_FINISHED, ...entry }),
      registered: if (state.registered.nth(entry.identity) == call) state.registered.replaceAt(entry.identity,
        NO_OWNER) else state.registered,
      jobs: if (admitted) state.jobs.append({
        identity: entry.identity,
        phase: JOB_SOURCE_PENDING,
        value: entry.value,
        sourceValue: NO_ACQUIRED_VALUE,
        deadline: state.now + SHADOW_TIMEOUT_MS,
        timedOut: false
      }) else state.jobs,
      o: {
        calls: finishOwnedCalls(state.o.calls, state.owners, call, entry.value),
        loaders: state.o.loaders + (if (admitted) 1 else 0),
        sourceScopes: if (admitted) state.o.sourceScopes.append(false) else state.o.sourceScopes,
        shadow: if (entry.selected and not(admitted)) state.o.shadow.append("dropped") else state.o.shadow,
        ...state.o
      },
      ...state
    }
  }

  // -- Held read/decode completion and source settlement ----------------------

  pure def readReply(state: State, index: int): State = {
    val effect = state.reads.nth(index)
    val updated = {
      reads: state.reads.replaceAt(index, { pending: false, ...effect }),
      ...state
    }
    if (effect.job) {
      val job = state.jobs.nth(effect.owner)
      finishJob(updated, effect.owner,
        if (state.frames.nth(job.identity % KEYS_PER_INSTANCE) == job.value) "mismatch" else "superseded")
    } else {
      val call = state.calls.nth(effect.owner)
      {
        calls: state.calls.replaceAt(effect.owner, {
          phase: CALL_DECODING,
          value: state.frames.nth(call.identity % KEYS_PER_INSTANCE),
          ...call
        }),
        loads: state.loads.append({
          job: false,
          owner: effect.owner,
          pending: true
        }),
        o: { loads: state.o.loads + 1, ...state.o },
        ...updated
      }
    }
  }
  action readWith(choice: int): bool = all {
    (s.reads.indices().filter(i => s.reads.nth(i).pending)).contains(choice),
    input' = { name: "releaseRead", choice: choice },
    s' = readReply(s, choice)
  }
  action releaseRead = {
    nondet choice = s.reads.indices().filter(i => s.reads.nth(i).pending).oneOf()
    readWith(choice)
  }
  pure def loadReply(state: State, index: int): State = {
    val effect = state.loads.nth(index)
    val updated = {
      loads: state.loads.replaceAt(index, { pending: false, ...effect }),
      ...state
    }
    if (effect.job) {
      val job = state.jobs.nth(effect.owner)
      if (job.timedOut or job.value == job.sourceValue) finishJob(updated, effect.owner, "match")
      else {
        jobs: state.jobs.replaceAt(effect.owner, { phase: JOB_CONFIRMING, ...job }),
        reads: state.reads.append({
          job: true,
          owner: effect.owner,
          pending: true
        }),
        o: { reads: state.o.reads + 1, ...state.o },
        ...updated
      }
    } else finishCall(updated, effect.owner)
  }
  action loadWith(choice: int): bool = all {
    (s.loads.indices().filter(i => s.loads.nth(i).pending)).contains(choice),
    input' = { name: "releaseLoad", choice: choice },
    s' = loadReply(s, choice)
  }
  action releaseLoad = {
    nondet choice = s.loads.indices().filter(i => s.loads.nth(i).pending).oneOf()
    loadWith(choice)
  }
  pure def settle(state: State, loader: int, value: int): State = {
    val job = state.jobs.nth(loader)
    if (job.timedOut or value == SOURCE_ERROR) finishJob(state, loader, "source_error")
    else {
      jobs: state.jobs.replaceAt(loader, {
        phase: JOB_DECODING,
        sourceValue: value,
        ...job
      }),
      loads: state.loads.append({
        job: true,
        owner: loader,
        pending: true
      }),
      o: { loads: state.o.loads + 1, ...state.o },
      ...state
    }
  }
  val pendingSources = s.jobs.indices().filter(i => s.jobs.nth(i).phase == JOB_SOURCE_PENDING)
  action resolveWith(choice: int): bool = all {
    (1.to(MAX_RESOLVE_CHOICE)
      .filter(code => pendingSources.contains((code - 1) / SOURCE_VALUE_COUNT))).contains(choice),
    input' = { name: "resolveLoader", choice: choice },
    s' = settle(s, (choice - 1) / SOURCE_VALUE_COUNT, (choice - 1) % SOURCE_VALUE_COUNT + VALUE_ONE)
  }
  action resolveLoader = {
    nondet choice = 1.to(MAX_RESOLVE_CHOICE)
      .filter(code => pendingSources.contains((code - 1) / SOURCE_VALUE_COUNT)).oneOf()
    resolveWith(choice)
  }
  action rejectWith(choice: int): bool = all {
    (pendingSources).contains(choice),
    input' = { name: "rejectLoader", choice: choice },
    s' = settle(s, choice, SOURCE_ERROR)
  }
  action rejectLoader = {
    nondet choice = pendingSources.oneOf()
    rejectWith(choice)
  }

  // -- External time, policy, and remote replacement -------------------------

  pure def tick(state: State, ms: int): State = {
    val expired = liveJobs(state).filter(i => not(state.jobs.nth(i).timedOut)
      and not(deadlinePendingAt(state.now + ms, state.jobs.nth(i).deadline)))
    {
      now: state.now + ms,
      jobs: state.jobs.foldl(List(), (out, job) => out.append({ timedOut: job.timedOut
        or expired.contains(out.length()), ...job })),
      o: {
        shadow: expired.fold(state.o.shadow, (out, _) => out.append("timeout")),
        ...state.o
      },
      ...state
    }
  }
  action advanceBy(choice: int): bool = all {
    (Set(1, SHADOW_TIMEOUT_MS)).contains(choice),
    input' = { name: "advance", choice: choice },
    // Stay below read deadlines and Redis expiry even in longer explorations.
    all {
      s.now + choice <= MAX_ELAPSED_MS,
      s' = tick(s, choice)
    }
  }
  action advance = {
    nondet choice = Set(1, SHADOW_TIMEOUT_MS).oneOf()
    advanceBy(choice)
  }
  // 0: defaults; 1: shadow off; 2: coalescing off; 3: both off.
  action policyWith(choice: int): bool = all {
    (POLICY_DEFAULT.to(POLICY_NO_SHADOW_OR_COALESCING)).contains(choice),
    input' = { name: "policy", choice: choice },
    s' = { overlay: choice, ...s }
  }
  action policy = {
    nondet choice = POLICY_DEFAULT.to(POLICY_NO_SHADOW_OR_COALESCING).oneOf()
    policyWith(choice)
  }
  action seedWith(choice: int): bool = all {
    (0.to(MAX_IDENTITY_CHOICE)).contains(choice),
    input' = { name: "seed", choice: choice },
    s' = {
      frames: s.frames.replaceAt(choice / 2, choice % 2 + 1),
      ...s
    }
  }
  action seed = {
    nondet choice = 0.to(MAX_IDENTITY_CHOICE).oneOf()
    seedWith(choice)
  }

  // -- Exploration schedule (nesting/order preserve sampling weights) ---------

  action step = any {
    beginCall,
    releaseRead,
    releaseLoad,
    any {
      resolveLoader,
      rejectLoader
    },
    any {
      advance,
      policy,
      seed
    }
  }

  // -- Independently stated safety properties --------------------------------

  val capacityIsPerInstance = Set(0, 1).forall(instance =>
    liveJobs(s).filter(i => s.jobs.nth(i).identity / KEYS_PER_INSTANCE == instance).size() <= JOBS_PER_INSTANCE)
  val oneJobPerIdentity = liveJobs(s).forall(i => liveJobs(s).forall(j =>
    i == j or s.jobs.nth(i).identity != s.jobs.nth(j).identity))
  val registeredCallsArePending = s.registered.indices().forall(identity => {
    val owner = s.registered.nth(identity)
    owner < 0 or (s.calls.nth(owner).identity == identity and s.calls.nth(owner).shared
      and s.calls.nth(owner).phase != CALL_FINISHED)
  })
  val callsKeepAcquiredValue = s.owners.indices().forall(i => {
    val call = s.calls.nth(s.owners.nth(i))
    s.o.calls.nth(i) == (if (call.phase == CALL_FINISHED) call.value else CALL_PENDING)
  })
  val jobsAreDiagnostic = s.o.writes == 0 and s.o.dumps == 0
    and s.o.sourceScopes.indices().forall(i => not(s.o.sourceScopes.nth(i)))
  val effectsMatchRecords = s.o.loaders == s.jobs.length() and s.o.reads == s.reads.length()
    and s.o.loads == s.loads.length()

  // -- Deterministic regression schedules ------------------------------------

  run coalescedHitAdmitsOneJobTest = init
    .then(beginWith(0))
    .then(beginWith(0))
    .then(readWith(0))
    .then(loadWith(0))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1 and s.o.reads == 1 and s.o.shadow == List())

  run duplicateDropsBeforeCapacityIsFullTest = init
    .then(beginWith(0))
    .then(readWith(0))
    .then(loadWith(0))
    .then(beginWith(0))
    .then(readWith(1))
    .then(loadWith(1))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1 and s.o.shadow == List("dropped"))

  run timeoutRetainsSourceCapacityTest = init
    .then(beginWith(0))
    .then(readWith(0))
    .then(loadWith(0))
    .then(advanceBy(SHADOW_TIMEOUT_MS))
    .expect(liveJobs(s) == Set(0) and s.o.shadow == List("timeout"))
    // A later caller still receives its cache hit, but its duplicate job drops
    // while the timed-out source owns the slot. Settlement permits admission.
    .then(beginWith(0)).then(readWith(1)).then(loadWith(1))
    .expect(s.o.loaders == 1 and s.o.shadow == List("timeout", "dropped"))
    .then(resolveWith(2))
    .expect(liveJobs(s) == Set())
    .then(beginWith(0)).then(readWith(2)).then(loadWith(2))
    .expect(s.o.loaders == 2 and s.o.loads == 3 and s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE)
      and s.o.shadow == List("timeout", "dropped"))

  run timeoutRetainsDecodeCapacityTest = init
    .then(beginWith(0))
    .then(readWith(0))
    .then(loadWith(0))
    .then(resolveWith(2))
    .then(advanceBy(SHADOW_TIMEOUT_MS))
    .expect(liveJobs(s) == Set(0))
    .then(beginWith(0)).then(readWith(1)).then(loadWith(2))
    .expect(s.o.loaders == 1 and s.o.shadow == List("timeout", "dropped"))
    .then(loadWith(1))
    .expect(liveJobs(s) == Set() and s.o.reads == 2)
    .then(beginWith(0)).then(readWith(2)).then(loadWith(3))
    .expect(s.o.loaders == 2 and s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE)
      and s.o.shadow == List("timeout", "dropped"))

  run timeoutRetainsConfirmationCapacityTest = init
    .then(beginWith(0))
    .then(readWith(0))
    .then(loadWith(0))
    .then(resolveWith(2))
    .then(loadWith(1))
    .then(advanceBy(SHADOW_TIMEOUT_MS))
    .expect(liveJobs(s) == Set(0))
    .then(beginWith(0)).then(readWith(2)).then(loadWith(2))
    .expect(s.o.loaders == 1 and s.o.shadow == List("timeout", "dropped"))
    .then(readWith(1))
    .expect(liveJobs(s) == Set())
    .then(beginWith(0)).then(readWith(3)).then(loadWith(3))
    .expect(s.o.loaders == 2 and s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE)
      and s.o.shadow == List("timeout", "dropped"))

  run fullInstanceDoesNotBlockOtherInstanceTest = init
    .then(beginWith(0))
    .then(readWith(0))
    .then(loadWith(0))
    .then(beginWith(1))
    .then(readWith(1))
    .then(loadWith(1))
    .then(beginWith(2))
    .then(readWith(2))
    .then(loadWith(2))
    .expect(s.o.loaders == 2 and s.o.shadow == List("dropped"))
    .then(beginWith(3))
    .then(readWith(3))
    .then(loadWith(3))
    .expect(s.o.loaders == 3 and s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE, VALUE_ONE)
      and s.o.shadow == List("dropped"))
}
