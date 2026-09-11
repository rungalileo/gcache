module dialcache_source_budgets_conformance {
  import cache_rules.* from "./cache-rules"
  import conformance_observations.* from "./conformance-observations"

  // C01/C23-C27: source deadlines belong to source execution, not policy work
  // or the waiting caller. One local key and eight calls permit delayed policy,
  // shared followers, independent bypasses, and abandoned work beside a retry.
  // Sources and policy replies are external gates. Timers are delivered on an
  // advance; late settlement before timer delivery is covered by effects.
  // Remote I/O, request memo and shadow work are outside this focused profile.

  // Initialization choices are part of the replay input: keep these codes stable.
  pure val DEFAULT_BUDGET_MODE = 0
  pure val UNBOUNDED_BUDGET_MODE = 1
  pure val FINITE_BUDGET_MODE = 2
  pure val ENABLED = 0
  pure val OUTSIDE = 1
  pure val INVALID_KEY = 2
  pure val OUTSIDE_INVALID_KEY = 3
  pure val MAX_CALLS = 8
  pure val LOCAL_TTL_MS = 1000

  // All times are monotonic milliseconds. A budget of -1 is unbounded.
  // rawPending can remain true after result becomes DEADLINE_ERROR: the caller
  // has stopped waiting, but its abandoned source can still finish externally.
  type Source = {
    rawPending: bool, result: int, started: int, settled: int,
    budget: int, cacheable: bool, outside: bool
  }
  type State = {
    o: Observation, mode: int, now: int,
    kinds: List[int], owners: List[int], policyOwners: List[int],
    sources: List[Source], registered: int,
    localValue: int, localExpires: int, localWriter: int
  }
  var s: State
  // input records the external command. s.o predicts public observations;
  // owners, registered and local storage describe model-owned state, not inputs
  // a native replay driver may read to decide what the implementation should do.
  var input: { name: str, choice: int }

  pure def configuredBudget(mode: int): int =
    if (mode == DEFAULT_BUDGET_MODE) 60000
    else if (mode == UNBOUNDED_BUDGET_MODE) -1
    else 10

  action initialize(mode: int): bool = all {
    input' = { name: "init", choice: mode },
    s' = {
      o: empty,
      mode: mode,
      now: 0,
      kinds: List(),
      owners: List(),
      policyOwners: List(),
      sources: List(),
      registered: -1,
      localValue: 0,
      localExpires: 0,
      localWriter: -1
    }
  }
  action init = {
    nondet choice = Set(DEFAULT_BUDGET_MODE, UNBOUNDED_BUDGET_MODE, FINITE_BUDGET_MODE).oneOf()
    initialize(choice)
  }

  pure def startSource(x: State, call: int, kind: int): State = {
    val outside = kind == OUTSIDE or kind == OUTSIDE_INVALID_KEY
    val source = x.sources.length()
    {
      owners: x.owners.replaceAt(call, source),
      sources: x.sources.append({
        rawPending: true, result: CALL_PENDING, started: x.now, settled: -1,
        budget: if (outside) -1 else configuredBudget(x.mode),
        cacheable: kind == ENABLED, outside: outside
      }),
      registered: if (kind == ENABLED) source else x.registered,
      o: { loaders: x.o.loaders + 1, ...x.o }, ...x
    }
  }

  action begin(kind: int): bool = all {
    s.o.calls.length() < MAX_CALLS,
    input' = { name: "beginCall", choice: kind },
    val call = s.o.calls.length()
    val entered = {
      kinds: s.kinds.append(kind), owners: s.owners.append(-1),
      o: { calls: s.o.calls.append(CALL_PENDING), ...s.o }, ...s
    }
    s' = if (kind == ENABLED) {
      policyOwners: entered.policyOwners.append(call),
      o: { policyCalls: entered.o.policyCalls + 1, ...entered.o }, ...entered
    } else startSource(entered, call, kind)
  }
  action beginCall = {
    nondet choice = Set(ENABLED, OUTSIDE, INVALID_KEY, OUTSIDE_INVALID_KEY).oneOf()
    begin(choice)
  }

  action release(id: int): bool = all {
    id < s.policyOwners.length(),
    s.policyOwners.nth(id) >= 0,
    input' = { name: "releasePolicy", choice: id },
    val call = s.policyOwners.nth(id)
    val admitted = { policyOwners: s.policyOwners.replaceAt(id, -1), ...s }
    s' = if (s.registered >= 0) {
      owners: s.owners.replaceAt(call, s.registered), ...admitted
    } else if (s.localValue > 0 and localEntryLiveAt(s.now, s.localExpires)) {
      o: { calls: s.o.calls.replaceAt(call, s.localValue), ...s.o }, ...admitted
    } else startSource(admitted, call, ENABLED)
  }
  action releasePolicy = { nondet choice = 0.to(MAX_CALLS - 1).oneOf(); release(choice) }

  pure def complete(x: State, id: int, outcome: int): State = {
    val source = x.sources.nth(id)
    val accepted = outcome == VALUE_ONE or outcome == VALUE_TWO
    {
      sources: x.sources.replaceAt(id, { result: outcome, settled: x.now, ...source }),
      registered: if (x.registered == id) -1 else x.registered,
      localValue: if (source.cacheable and accepted) outcome else x.localValue,
      localExpires: if (source.cacheable and accepted) x.now + LOCAL_TTL_MS else x.localExpires,
      localWriter: if (source.cacheable and accepted) id else x.localWriter,
      o: { calls: finishOwnedCalls(x.o.calls, x.owners, id, outcome), ...x.o }, ...x
    }
  }
  pure def settleSource(x: State, id: int, outcome: int): State = {
    val source = x.sources.nth(id)
    val drained = { sources: x.sources.replaceAt(id, { rawPending: false, ...source }), ...x }
    if (source.result != CALL_PENDING) drained else complete(drained, id,
      if (not(sourceAcceptsAt(source.started, x.now, source.budget))) DEADLINE_ERROR else outcome)
  }
  action resolved(id: int, value: int): bool = all {
    id < s.sources.length(),
    s.sources.nth(id).rawPending,
    input' = { name: "resolveLoader", choice: id * 2 + value },
    s' = settleSource(s, id, value)
  }
  action resolveLoader = {
    nondet choice = 1.to(MAX_CALLS * 2).oneOf()
    resolved((choice - 1) / 2, (choice - 1) % 2 + 1)
  }
  action rejected(id: int): bool = all {
    id < s.sources.length(),
    s.sources.nth(id).rawPending,
    input' = { name: "rejectLoader", choice: id },
    s' = settleSource(s, id, SOURCE_ERROR)
  }
  action rejectLoader = { nondet choice = 0.to(MAX_CALLS - 1).oneOf(); rejected(choice) }

  action advanced(delta: int): bool = all {
    s.now + delta <= 180000,
    input' = { name: "advance", choice: delta },
    val advanced = { now: s.now + delta, ...s }
    s' = s.sources.indices().fold(advanced, (current, id) => {
      val source = current.sources.nth(id)
      if (source.result == CALL_PENDING
          and not(sourceAcceptsAt(source.started, current.now, source.budget)))
        complete(current, id, DEADLINE_ERROR) else current
    })
  }
  action advance = { nondet choice = Set(1, 3, 6, 9, 10, 100, 59999, 60001).oneOf(); advanced(choice) }
  action step = any { beginCall, releasePolicy, resolveLoader, rejectLoader, advance }

  val outsideSourcesHaveNoDeadline = s.sources.indices().forall(i => {
    val source = s.sources.nth(i)
    not(source.outside) or (source.budget == -1 and source.result != DEADLINE_ERROR and not(source.cacheable))
  })
  val acceptedSourceRespectsItsOwnStart = s.sources.indices().forall(i => {
    val source = s.sources.nth(i)
    not(source.result == VALUE_ONE or source.result == VALUE_TWO)
      or (source.settled >= source.started and
        (source.budget < 0 or source.settled < source.started + source.budget))
  })
  val registeredWorkIsNotAbandoned = s.registered < 0 or s.sources.nth(s.registered).result == CALL_PENDING
  val localPublicationRequiresAcceptedSource = s.localWriter < 0 or {
    val writer = s.sources.nth(s.localWriter)
    writer.cacheable and (writer.result == VALUE_ONE or writer.result == VALUE_TWO)
      and s.localValue == writer.result
  }
  val followersKeepTheirOwnersOutcome = s.owners.indices().forall(call => {
    val owner = s.owners.nth(call)
    owner < 0 or s.o.calls.nth(call) == s.sources.nth(owner).result
  })
  val onlyEnabledValidCallsResolvePolicy = s.o.policyCalls == s.kinds.foldl(0,
    (count, kind) => count + (if (kind == ENABLED) 1 else 0))

  run outsideAndInvalidOutsideCallsIgnoreDeadlineAndSharingTest = initialize(FINITE_BUDGET_MODE)
    .then(begin(OUTSIDE)).then(begin(OUTSIDE_INVALID_KEY)).then(advanced(100))
    .expect(s.o.calls == List(CALL_PENDING, CALL_PENDING) and s.o.policyCalls == 0 and s.o.loaders == 2)
    .then(resolved(0, VALUE_ONE)).then(resolved(1, VALUE_TWO))
    .then(begin(ENABLED)).then(release(0))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, CALL_PENDING) and s.o.loaders == 3)

  run defaultSourceBudgetExpiresAtSixtySecondsTest = initialize(DEFAULT_BUDGET_MODE)
    .then(begin(ENABLED)).then(release(0)).then(advanced(59999))
    .expect(s.o.calls == List(CALL_PENDING))
    .then(advanced(1)).then(resolved(0, VALUE_ONE))
    .then(begin(ENABLED)).then(release(1))
    .expect(s.o.calls == List(DEADLINE_ERROR, CALL_PENDING) and s.o.loaders == 2)

  run unboundedEnabledSourcePublishesAfterSixtySecondsTest = initialize(UNBOUNDED_BUDGET_MODE)
    .then(begin(ENABLED)).then(release(0)).then(advanced(60001))
    .expect(s.o.calls == List(CALL_PENDING))
    .then(resolved(0, VALUE_ONE)).then(begin(ENABLED)).then(release(1))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1)

  run lateFollowerUsesLeadersRemainingBudgetTest = initialize(FINITE_BUDGET_MODE)
    .then(begin(ENABLED)).then(release(0)).then(advanced(6))
    .then(begin(ENABLED)).then(release(1)).then(advanced(3))
    .expect(s.o.calls == List(CALL_PENDING, CALL_PENDING) and s.o.loaders == 1)
    .then(advanced(1))
    .expect(s.o.calls == List(DEADLINE_ERROR, DEADLINE_ERROR))

  run heldPolicyDoesNotSpendSourceBudgetTest = initialize(FINITE_BUDGET_MODE)
    .then(begin(ENABLED)).then(advanced(100))
    .expect(s.o.calls == List(CALL_PENDING) and s.o.loaders == 0)
    .then(release(0)).then(advanced(9)).then(resolved(0, VALUE_ONE))
    .then(begin(ENABLED)).then(release(1))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1)

  run invalidKeyStillKeepsEnabledSourceDeadlineTest = initialize(FINITE_BUDGET_MODE)
    .then(begin(INVALID_KEY)).then(advanced(9))
    .expect(s.o.calls == List(CALL_PENDING) and s.o.policyCalls == 0)
    .then(advanced(1)).then(resolved(0, VALUE_ONE))
    .then(begin(ENABLED)).then(release(0))
    .expect(s.o.calls == List(DEADLINE_ERROR, CALL_PENDING) and s.o.loaders == 2)

  run abandonedSourceCannotReplaceSuccessfulRetryTest = initialize(FINITE_BUDGET_MODE)
    .then(begin(ENABLED)).then(release(0)).then(advanced(10))
    .then(begin(ENABLED)).then(release(1)).then(resolved(1, VALUE_TWO))
    .then(resolved(0, VALUE_ONE)).then(begin(ENABLED)).then(release(2))
    .expect(s.o.calls == List(DEADLINE_ERROR, VALUE_TWO, VALUE_TWO) and s.o.loaders == 2)
}
