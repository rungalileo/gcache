module dialcache_layers_conformance {
  import conformance_observations.* from "./conformance-observations"
  // Composition boundary: request -> process flight -> local -> remote -> source.
  // Two entities x two operations; two instances; three persistent request scopes.
  // Fresh entries throughout this profile; policy/storage profiles cover expiry.
  // State: o is the replay projection. Memo/flight ownership, LRU membership,
  // remote frames and watermarks are predictions tested through public calls.
  // Environment: explicit request closure, source settlement, remote seeding,
  // invalidation, and 1 ms clock steps. All serving TTLs are 60 seconds.
  // Bounds: four identities (two entities x two operations), two instances,
  // three persistent contexts, two fresh-context choices, twenty callers.

  // -- Stable fixture, policy, context, and identity encodings ----------------

  pure val FIXTURE_UNTRACKED = 0
  pure val FIXTURE_TRACKED = 1
  pure val FIXTURE_ZERO_CAPACITY_UNTRACKED = 2
  pure val FIXTURE_ZERO_CAPACITY_TRACKED = 3
  pure val FIXTURE_WITHOUT_REMOTE = 4
  pure val FIXTURE_TRACKED_WITHOUT_REMOTE = 5
  pure val POLICY_ALL_LAYERS = 0
  pure val POLICY_NO_REQUEST = 1
  pure val POLICY_NO_LOCAL = 2
  pure val POLICY_NO_REMOTE = 3
  pure val POLICY_REQUEST_ONLY = 4
  pure val POLICY_NO_LAYERS = 5
  pure val FIRST_REQUEST_CONTEXT = 0
  pure val SECOND_REQUEST_CONTEXT = 1
  pure val OTHER_INSTANCE_REQUEST_CONTEXT = 2
  pure val FRESH_FIRST_INSTANCE_CONTEXT = 3
  pure val FRESH_OTHER_INSTANCE_CONTEXT = 4
  pure val FIRST_INSTANCE = 0
  pure val OTHER_INSTANCE = 1
  pure val KEY_A = 0
  pure val KEY_A_OTHER_OPERATION = 1
  pure val KEY_B = 2
  pure val KEY_B_OTHER_OPERATION = 3
  pure val KEYS_PER_INSTANCE = 4
  pure val OPERATIONS_PER_ENTITY = 2
  pure val PERSISTENT_CONTEXTS = 3
  pure val DEFAULT_LOCAL_CAPACITY = 2
  pure val NO_LOCAL_CAPACITY = 0
  pure val NO_OWNER = -1
  pure val NO_CACHED_VALUE = 0
  pure val MAX_CALLERS = 20
  pure val MAX_CONTEXT_KEY_CHOICE = 19
  pure val MAX_RESOLVE_CHOICE = 40
  pure val MAX_SEED_CHOICE = 7
  pure val SOURCE_VALUE_COUNT = 2
  pure val INITIAL_TIME_MS = 10000
  pure val SERVING_TTL_MS = 60000

  // -- State and fixture helpers ---------------------------------------------

  type Source = {
    instance: int,
    key: int,
    local: bool,
    remote: bool,
    fence: int,
    result: int,
    shared: bool
  }
  type State = {
    o: Observation,
    now: int,
    tracked: bool,
    remoteAvailable: bool,
    capacity: int,
    policy: int,
    closed: List[bool],
    memo: List[int],
    requestFlights: List[int],
    processFlights: List[int],
    localValues: List[int],
    lru: List[List[int]],
    remoteValues: List[int],
    created: List[int],
    watermark: List[int],
    sources: List[Source],
    owners: List[int],
    memoSlots: List[int],
    callerContexts: List[int],
    callerKeys: List[int]
  }
  var s: State
  var input: { name: str, choice: int }
  pure def zeros(n: int): List[int] = 0.to(n - 1).fold(List(), (out, _) => out.append(0))
  pure def slots(n: int): List[int] = 0.to(n - 1).fold(List(), (out, _) => out.append(NO_OWNER))
  pure def instance(context: int): int = if (context == OTHER_INSTANCE_REQUEST_CONTEXT
    or context == FRESH_OTHER_INSTANCE_CONTEXT) OTHER_INSTANCE else FIRST_INSTANCE
  pure def persistent(context: int): bool = context < PERSISTENT_CONTEXTS
  pure def active(state: State, context: int): bool = not(persistent(context)) or not(state.closed.nth(context))
  // 0 all; 1 no request; 2 no local; 3 no remote; 4 request only; 5 no layers.
  pure def requestEnabled(state: State): bool = state.policy != POLICY_NO_REQUEST and state.policy != POLICY_NO_LAYERS
  pure def localEnabled(state: State): bool = Set(POLICY_ALL_LAYERS, POLICY_NO_REQUEST,
    POLICY_NO_REMOTE).contains(state.policy)
  pure def remoteEnabled(state: State): bool = state.remoteAvailable and Set(POLICY_ALL_LAYERS,
    POLICY_NO_REQUEST, POLICY_NO_LOCAL).contains(state.policy)

  // -- Local LRU and request memo publication --------------------------------

  pure def touch(order: List[int], key: int): List[int] = order.select(k => k != key).append(key)
  pure def putLocal(state: State, inst: int, key: int, value: int): State = {
    val order = touch(state.lru.nth(inst), key)
    val evicts = order.length() > state.capacity
    val kept = if (evicts) order.slice(1, order.length()) else order
    if (state.capacity == NO_LOCAL_CAPACITY) state else {
      lru: state.lru.replaceAt(inst, kept),
      localValues: (if (evicts) state.localValues.replaceAt(inst * KEYS_PER_INSTANCE + order.nth(0),
        NO_CACHED_VALUE) else state.localValues).replaceAt(inst * KEYS_PER_INSTANCE + key, value),
      ...state
    }
  }
  pure def memoize(state: State, slot: int, value: int): State =
    if (slot < 0 or state.closed.nth(slot / KEYS_PER_INSTANCE)) state else {
      memo: state.memo.replaceAt(slot, value),
      ...state
    }
  pure def result(state: State, slot: int, value: int): State =
    memoize({
      o: {
        calls: state.o.calls.replaceAt(state.o.calls.length() - 1, value),
        ...state.o
      },
      ...state
    }, slot, value)

  // -- Caller admission and layer traversal ----------------------------------

  pure def start(state: State, inst: int, key: int, slot: int, participating: bool, read: bool): State = {
    val shared = participating and (localEnabled(state) or remoteEnabled(state))
    val index = state.sources.length()
    {
      sources: state.sources.append({
        instance: inst,
        key: key,
        local: participating and localEnabled(state) and not(state.tracked and read),
        remote: read,
        fence: if (state.tracked and read) state.watermark.nth(key / OPERATIONS_PER_ENTITY) else 0,
        result: CALL_PENDING,
        shared: shared
      }),
      owners: state.owners.replaceAt(state.owners.length() - 1, index),
      requestFlights: if (slot >= 0) state.requestFlights.replaceAt(slot, index) else state.requestFlights,
      processFlights: if (shared) state.processFlights.replaceAt(inst * KEYS_PER_INSTANCE + key, index)
        else state.processFlights,
      o: { loaders: state.o.loaders + 1, ...state.o },
      ...state
    }
  }
  pure def begin(state: State, choice: int): State = {
    val context = choice / KEYS_PER_INSTANCE
    val key = choice % KEYS_PER_INSTANCE
    val inst = instance(context)
    val participating = active(state, context)
    val slot = if (participating and persistent(context)
      and requestEnabled(state)) context * KEYS_PER_INSTANCE + key else NO_OWNER
    val requestOwner = if (slot < 0) NO_OWNER else state.requestFlights.nth(slot)
    val memoValue = if (slot < 0) NO_CACHED_VALUE else state.memo.nth(slot)
    val processOwner = if (participating and (localEnabled(state)
      or remoteEnabled(state))) state.processFlights.nth(inst * KEYS_PER_INSTANCE + key) else NO_OWNER
    val owner = if (requestOwner >= 0) requestOwner else if (memoValue == NO_CACHED_VALUE) processOwner else NO_OWNER
    val withCaller = {
      owners: state.owners.append(owner),
      memoSlots: state.memoSlots.append(slot),
      callerContexts: state.callerContexts.append(context),
      callerKeys: state.callerKeys.append(key),
      o: {
        calls: state.o.calls.append(CALL_PENDING),
        policyCalls: state.o.policyCalls + (if (participating) 1 else 0),
        ...state.o
      },
      ...state
    }
    val localValue = if (participating
      and localEnabled(state)) state.localValues.nth(inst * KEYS_PER_INSTANCE + key) else NO_CACHED_VALUE
    val readsRemote = participating and remoteEnabled(state)
    val remoteValue =
      if (readsRemote and (not(state.tracked)
        or state.created.nth(key) > state.watermark.nth(key / OPERATIONS_PER_ENTITY)))
        state.remoteValues.nth(key)
      else NO_CACHED_VALUE
    val withRemoteObservation = if (readsRemote) {
      o: {
        reads: withCaller.o.reads + 1,
        loads: withCaller.o.loads + (if (remoteValue > 0) 1 else 0),
        ...withCaller.o
      },
      ...withCaller
    } else withCaller
    if (owner >= 0) {
      requestFlights: if (slot < 0) withCaller.requestFlights else withCaller.requestFlights.replaceAt(slot, owner),
      ...withCaller
    }
    else if (memoValue > 0) result(withCaller, slot, memoValue)
    else if (localValue > 0) result({
      lru: withCaller.lru.replaceAt(inst, touch(withCaller.lru.nth(inst), key)),
      ...withCaller
    }, slot, localValue)
    else if (remoteValue > 0) result(if (localEnabled(state)) putLocal(withRemoteObservation, inst, key,
      remoteValue) else withRemoteObservation, slot, remoteValue)
    else start(withRemoteObservation, inst, key, slot, participating, readsRemote)
  }

  // -- Source settlement and owned publication -------------------------------

  pure def settle(state: State, index: int, value: int): State = {
    val source = state.sources.nth(index)
    val success = value != SOURCE_ERROR
    val write = success and source.remote and state.now > source.fence
    val withSourceResult = {
      sources: state.sources.replaceAt(index, { result: value, ...source }),
      processFlights: state.processFlights.foldl(List(), (out, owner) =>
        out.append(if (owner == index) NO_OWNER else owner)),
      requestFlights: state.requestFlights.foldl(List(), (out, owner) =>
        out.append(if (owner == index) NO_OWNER else owner)),
      remoteValues: if (write) state.remoteValues.replaceAt(source.key, value) else state.remoteValues,
      created: if (write) state.created.replaceAt(source.key, state.now) else state.created,
      o: {
        calls: finishOwnedCalls(state.o.calls, state.owners, index, value),
        dumps: state.o.dumps + (if (write) 1 else 0),
        writes: state.o.writes + (if (write) 1 else 0),
        writeTtls: if (write) state.o.writeTtls.append(SERVING_TTL_MS) else state.o.writeTtls,
        ...state.o
      },
      ...state
    }
    val withLocalPublication = if (success and source.local) putLocal(withSourceResult, source.instance,
      source.key, value) else withSourceResult
    if (not(success)) withLocalPublication else state.owners.indices().fold(withLocalPublication, (out, call) =>
      if (state.owners.nth(call) == index) memoize(out, state.memoSlots.nth(call), value) else out)
  }

  // -- Public fixture inputs and external effects ----------------------------

  action initialize(fixture: int): bool = all {
    s' = {
      o: empty,
      now: INITIAL_TIME_MS,
      tracked: fixture % 2 == FIXTURE_TRACKED,
      remoteAvailable: fixture < FIXTURE_WITHOUT_REMOTE,
      capacity: if (Set(FIXTURE_ZERO_CAPACITY_UNTRACKED, FIXTURE_ZERO_CAPACITY_TRACKED).contains(fixture))
        NO_LOCAL_CAPACITY else DEFAULT_LOCAL_CAPACITY,
      policy: POLICY_ALL_LAYERS,
      closed: List(false, false, false),
      memo: zeros(12),
      requestFlights: slots(12),
      processFlights: slots(8),
      localValues: zeros(8),
      lru: List(List(), List()),
      remoteValues: zeros(4),
      created: zeros(4),
      watermark: zeros(2),
      sources: List(),
      owners: List(),
      memoSlots: List(),
      callerContexts: List(),
      callerKeys: List()
    },
    input' = { name: "init", choice: fixture }
  }
  action init = {
    nondet choice = FIXTURE_UNTRACKED.to(FIXTURE_TRACKED_WITHOUT_REMOTE).oneOf()
    initialize(choice)
  }
  action startCall(choice: int): bool = all {
    s.o.calls.length() < MAX_CALLERS,
    s' = begin(s, choice),
    input' = { name: "beginCall", choice: choice }
  }
  action beginCall = {
    nondet choice = 0.to(MAX_CONTEXT_KEY_CHOICE).oneOf()
    startCall(choice)
  }
  action finishSource(loader: int, value: int): bool = all {
    s' = settle(s, loader, value),
    input' = if (value == SOURCE_ERROR) { name: "rejectLoader", choice: loader }
      else { name: "resolveLoader", choice: loader * SOURCE_VALUE_COUNT + value }
  }
  action resolveLoader = {
    nondet choice = 1.to(MAX_RESOLVE_CHOICE).filter(code =>
      (code - 1) / SOURCE_VALUE_COUNT < s.sources.length()
      and s.sources.nth((code - 1) / SOURCE_VALUE_COUNT).result == CALL_PENDING
    ).oneOf()
    finishSource((choice - 1) / SOURCE_VALUE_COUNT, (choice - 1) % SOURCE_VALUE_COUNT + VALUE_ONE)
  }
  action rejectLoader = {
    nondet choice = s.sources.indices().filter(i => s.sources.nth(i).result == CALL_PENDING).oneOf()
    finishSource(choice, SOURCE_ERROR)
  }
  action closeContext(context: int): bool = all {
    s' = {
      closed: s.closed.replaceAt(context, true),
      memo: s.memo.indices().fold(s.memo, (out, slot) =>
        if (slot / KEYS_PER_INSTANCE == context) out.replaceAt(slot, NO_CACHED_VALUE) else out),
      requestFlights: s.requestFlights.indices().fold(s.requestFlights, (out, slot) =>
        if (slot / KEYS_PER_INSTANCE == context) out.replaceAt(slot, NO_OWNER) else out),
      ...s
    },
    input' = { name: "closeScope", choice: context }
  }
  action closeScope = {
    nondet choice = FIRST_REQUEST_CONTEXT.to(OTHER_INSTANCE_REQUEST_CONTEXT)
      .filter(scope => not(s.closed.nth(scope))).oneOf()
    closeContext(choice)
  }
  action changePolicy(policy: int): bool = all {
    s' = { policy: policy, ...s },
    input' = { name: "policy", choice: policy }
  }
  action policy = {
    nondet choice = POLICY_ALL_LAYERS.to(POLICY_NO_LAYERS).oneOf()
    changePolicy(choice)
  }
  action seedRemote(key: int, value: int): bool = all {
    s' = {
      remoteValues: s.remoteValues.replaceAt(key, value),
      created: s.created.replaceAt(key, s.now),
      ...s
    },
    input' = { name: "seed", choice: key * SOURCE_VALUE_COUNT + value - 1 }
  }
  action seed = {
    nondet choice = 0.to(MAX_SEED_CHOICE).oneOf()
    seedRemote(choice / SOURCE_VALUE_COUNT, choice % SOURCE_VALUE_COUNT + VALUE_ONE)
  }
  action invalidateEntity(entity: int): bool = all {
    s' = if (not(s.remoteAvailable)) {
      o: { maintenance: s.o.maintenance.append("missing_remote"), ...s.o },
      ...s
    } else {
      watermark: s.watermark.replaceAt(entity, s.now),
      o: {
        invalidations: s.o.invalidations + 1,
        maintenance: s.o.maintenance.append("ok"),
        ...s.o
      },
      ...s
    },
    input' = { name: "invalidate", choice: entity }
  }
  action invalidate = {
    nondet choice = Set(0, 1).oneOf()
    invalidateEntity(choice)
  }
  action tick = all {
    s' = { now: s.now + 1, ...s },
    input' = { name: "tick", choice: -1 }
  }

  // -- Exploration schedule (nesting/order preserve sampling weights) ---------

  action step = any {
    beginCall,
    resolveLoader,
    any {
      rejectLoader,
      policy,
      seed,
      invalidate,
      tick,
      any {
        tick,
        closeScope
      }
    }
  }

  // -- Independently stated safety properties --------------------------------

  val absentRemoteHasNoAdapterEffects = s.remoteAvailable or (s.o.reads == 0 and s.o.writes == 0
    and s.o.invalidations == 0)
  val sourceEffectsMatch = s.sources.length() == s.o.loaders and s.owners.length() == s.o.calls.length()
  val capacityIsPerInstance = s.lru.indices().forall(i => s.lru.nth(i).length() <= s.capacity)
  val closedScopesHaveNoMemo = s.memo.indices().forall(slot => not(s.closed.nth(slot / KEYS_PER_INSTANCE))
    or s.memo.nth(slot) == NO_CACHED_VALUE)
  val registeredSourcesArePending = s.processFlights.indices().forall(identity => {
    val source = s.processFlights.nth(identity)
    source < 0 or (s.sources.nth(source).shared and s.sources.nth(source).result == CALL_PENDING)
  })
  val zeroCapacityHasNoLocalValues = s.capacity != NO_LOCAL_CAPACITY
    or s.localValues.select(v => v != NO_CACHED_VALUE).length() == 0
  val callsKeepSourceOutcome = s.owners.indices().forall(call =>
    s.owners.nth(call) < 0 or s.o.calls.nth(call) == s.sources.nth(s.owners.nth(call)).result)
  val sourceOwnershipNeverCrossesKeyOrInstance = s.owners.indices().forall(call => {
    val owner = s.owners.nth(call)
    owner < 0 or (s.sources.nth(owner).key == s.callerKeys.nth(call)
      and s.sources.nth(owner).instance == instance(s.callerContexts.nth(call)))
  })
  val localMembershipMatchesLru = s.localValues.indices().forall(i =>
    (s.localValues.nth(i) > 0)
      == (s.lru.nth(i / KEYS_PER_INSTANCE).select(key => key == i % KEYS_PER_INSTANCE).length() > 0))

  // -- Deterministic regression schedules ------------------------------------

  action untrackedFixture = initialize(FIXTURE_UNTRACKED)
  action trackedFixture = initialize(FIXTURE_TRACKED)
  run absentRemoteMaintenancePreservesLocalReuseTest = initialize(FIXTURE_WITHOUT_REMOTE)
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(finishSource(0, VALUE_ONE))
    .then(invalidateEntity(0))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.maintenance == List("missing_remote")
      and s.o.invalidations == 0)
  run absentRemotePreservesLocalReuseTest = initialize(FIXTURE_WITHOUT_REMOTE)
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(finishSource(0, VALUE_ONE))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1 and s.o.reads == 0 and s.o.writes == 0)
  run requestMissesShareProcessAndMemoizeSeparatelyTest = untrackedFixture
    .then(startCall(FIRST_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(startCall(SECOND_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.loaders == 1)
    .then(finishSource(0, VALUE_ONE))
    .then(changePolicy(POLICY_REQUEST_ONLY))
    .then(startCall(FIRST_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(startCall(SECOND_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE, VALUE_ONE) and s.o.loaders == 1)
  run localReadPromotesBeforeEvictionTest = untrackedFixture.then(changePolicy(POLICY_NO_REMOTE))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(finishSource(0, VALUE_ONE))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A_OTHER_OPERATION))
    .then(finishSource(1, VALUE_ONE))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_B))
    .then(finishSource(2, VALUE_ONE))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.loaders == 3)
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A_OTHER_OPERATION))
    .expect(s.o.loaders == 4 and s.o.calls.nth(5) == CALL_PENDING)
  run zeroCapacityKeepsSharingWithoutStorageTest = initialize(FIXTURE_ZERO_CAPACITY_UNTRACKED).then(changePolicy(POLICY_NO_REMOTE))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.loaders == 1)
    .then(finishSource(0, VALUE_ONE))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.loaders == 2)
  run trackedSourceWaitsForValidatedReadToWarmLocalTest = trackedFixture
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(finishSource(0, VALUE_ONE))
    .expect(s.localValues.nth(0) == 0)
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.reads == 2 and s.localValues.nth(0) == 1)
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.reads == 2)
  run invalidationGroupsOperationsButPreservesAcquiredCachesTest = trackedFixture
    .then(seedRemote(KEY_A, VALUE_ONE)).then(seedRemote(KEY_A_OTHER_OPERATION, VALUE_TWO))
    .then(startCall(FIRST_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(startCall(FIRST_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_A_OTHER_OPERATION))
    .then(invalidateEntity(0))
    .then(startCall(FIRST_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A_OTHER_OPERATION))
    .expect(s.o.loaders == 0)
    .then(changePolicy(POLICY_NO_LOCAL))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A_OTHER_OPERATION))
    .expect(s.o.loaders == 2)
  run requestMemoExceedsLocalCapacityTest = initialize(FIXTURE_ZERO_CAPACITY_UNTRACKED).then(changePolicy(POLICY_REQUEST_ONLY))
    .then(startCall(FIRST_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(finishSource(0, VALUE_ONE))
    .then(startCall(FIRST_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_A_OTHER_OPERATION))
    .then(finishSource(1, VALUE_ONE))
    .then(startCall(FIRST_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_B))
    .then(finishSource(2, VALUE_ONE))
    .then(startCall(FIRST_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.loaders == 3 and s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE, VALUE_ONE))

  run separateRequestRootsRetainIndependentValuesTest = untrackedFixture
    .then(changePolicy(POLICY_REQUEST_ONLY))
    .then(startCall(FIRST_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(startCall(SECOND_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.loaders == 2)
    .then(finishSource(0, VALUE_ONE)).then(finishSource(1, VALUE_TWO))
    .then(startCall(FIRST_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(startCall(SECOND_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE, VALUE_TWO) and s.o.loaders == 2)

  run oneInstanceEvictionCannotEvictAnotherInstanceTest = initialize(FIXTURE_WITHOUT_REMOTE)
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(finishSource(0, VALUE_ONE))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A_OTHER_OPERATION))
    .then(finishSource(1, VALUE_ONE))
    .then(startCall(FRESH_OTHER_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(finishSource(2, VALUE_TWO))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_B))
    .then(finishSource(3, VALUE_ONE))
    .then(startCall(FRESH_OTHER_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_TWO, VALUE_ONE, VALUE_TWO) and s.o.loaders == 4)
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.loaders == 5 and s.o.calls.nth(5) == CALL_PENDING)

  run pendingSourcesKeepEntityAndOperationIdentityTest = untrackedFixture
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A_OTHER_OPERATION))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_B))
    .expect(s.o.loaders == 3)
    .then(finishSource(1, VALUE_TWO)).then(finishSource(0, VALUE_ONE))
    .then(finishSource(2, VALUE_ONE))
    .then(changePolicy(POLICY_NO_LOCAL))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A_OTHER_OPERATION))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_B))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE, VALUE_ONE, VALUE_TWO, VALUE_ONE)
      and s.o.loaders == 3 and s.o.loads == 3)

  run settledRequestMemoSurvivesSharedLayerRampDownTest = untrackedFixture
    .then(startCall(FIRST_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(finishSource(0, VALUE_ONE))
    .then(changePolicy(POLICY_REQUEST_ONLY))
    .then(startCall(FIRST_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1
      and s.o.reads == 1 and s.o.writes == 1)
    .then(startCall(SECOND_REQUEST_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.loaders == 2 and s.o.reads == 1)

  run untrackedReadsIgnoreGroupedInvalidationTest = untrackedFixture
    .then(seedRemote(KEY_A, VALUE_ONE)).then(seedRemote(KEY_A_OTHER_OPERATION, VALUE_TWO))
    .then(invalidateEntity(0)).then(changePolicy(POLICY_NO_LOCAL))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A_OTHER_OPERATION))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO) and s.o.loaders == 0
      and s.o.reads == 2 and s.o.loads == 2 and s.o.invalidations == 1)

  run trackedWithoutRemotePublishesReusableLocalTest = initialize(FIXTURE_TRACKED_WITHOUT_REMOTE)
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .then(finishSource(0, VALUE_ONE))
    .then(startCall(FRESH_FIRST_INSTANCE_CONTEXT * KEYS_PER_INSTANCE + KEY_A))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1
      and s.o.reads == 0 and s.o.writes == 0 and s.o.dumps == 0)
}
