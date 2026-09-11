module dialcache_scope_conformance {
  import conformance_observations.* from "./conformance-observations"
  // Request-only caching: one key and two independent request lifetimes.
  // Handles 2/3 nest enabled/disabled under 0; 4 reenables inside 3.
  // Completed handles remain usable for detached work. Only an outer close
  // ends its memo lifetime. No language-specific executor ordering is modeled.
  // State: o/d are replay observations; memo, registration, ownership, and
  // source records predict future effects and are never implementation inputs.
  // Environment: one request-only key, two outer lifetimes, one held policy
  // reply, independently settled sources; no source deadline or TTL expiry.
  // Bounds: sixteen callers, five saved contexts plus an outside context.

  // -- Stable context, policy, and sentinel encodings -------------------------

  pure val ROOT_REQUEST = 0
  pure val REPLACEMENT_REQUEST = 1
  pure val NESTED_ENABLED = 2
  pure val NESTED_DISABLED = 3
  pure val REENABLED_REQUEST = 4
  pure val OUTSIDE_REQUEST = 5
  pure val POLICY_INHERIT = 0
  pure val POLICY_NO_REQUEST = 1
  pure val POLICY_NO_COALESCING = 2
  pure val NO_OWNER = -1
  pure val NO_MEMO = 0
  pure val MAX_CALLERS = 16
  pure val SOURCE_VALUE_COUNT = 7
  pure val MAX_RESOLVE_CHOICE = 112

  // -- State and initial environment -----------------------------------------

  type Source = {
    slot: int,
    shared: bool,
    result: int,
    metricLayer: str
  }
  type State = {
    o: Observation,
    d: Diagnostics,
    opened: List[bool],
    completed: List[bool],
    memo: List[int],
    registered: List[int],
    sources: List[Source],
    settlements: List[int],
    owners: List[int],
    policyCall: int,
    scope: int,
    overlay: int
  }
  var s: State
  // Explicit environment inputs also make deterministic Quint runs replayable.
  var input: { name: str, choice: int }
  action init = all {
    input' = { name: "init", choice: -1 },
    s' = {
      o: empty,
      d: noDiagnostics,
      opened: List(true, false, false, false, false),
      completed: List(false, false, false, false, false),
      memo: List(NO_MEMO, NO_MEMO),
      registered: List(NO_OWNER, NO_OWNER),
      sources: List(),
      settlements: List(),
      owners: List(),
      policyCall: NO_OWNER,
      scope: ROOT_REQUEST,
      overlay: POLICY_INHERIT
    }
  }

  // -- Scope ownership and caller admission ----------------------------------

  pure def holder(scope: int): int = if (scope == REPLACEMENT_REQUEST) REPLACEMENT_REQUEST else ROOT_REQUEST
  pure def activeScope(state: State, scope: int): bool =
    scope < OUTSIDE_REQUEST and scope != NESTED_DISABLED and not(state.completed.nth(holder(scope)))
  pure def source(state: State, call: int, slot: int, shared: bool, active: bool, metricLayer: str): State = {
    owners: state.owners.replaceAt(call, state.sources.length()),
    sources: state.sources.append({
      slot: slot,
      shared: shared,
      result: CALL_PENDING,
      metricLayer: metricLayer
    }),
    registered: if (shared) state.registered.replaceAt(slot, state.sources.length()) else state.registered,
    o: {
      loaders: state.o.loaders + 1,
      sourceScopes: state.o.sourceScopes.append(active),
      ...state.o
    },
    ...state
  }
  pure def begin(state: State, scope: int): State = {
    val active = activeScope(state, scope)
    val withCaller = {
      scope: scope,
      owners: state.owners.append(NO_OWNER),
      policyCall: if (active) state.o.calls.length() else NO_OWNER,
      o: {
        calls: state.o.calls.append(CALL_PENDING),
        policyCalls: state.o.policyCalls + (if (active) 1 else 0),
        ...state.o
      },
      ...state
    }
    if (active) withCaller else source(withCaller, state.o.calls.length(), NO_OWNER, false, false, "")
  }
  action startCall(scope: int): bool = all {
    s' = begin(s, scope),
    input' = { name: "beginCall", choice: scope }
  }
  action beginCall = {
    // Context 5 is outside every request.
    nondet choice = ROOT_REQUEST.to(OUTSIDE_REQUEST).filter(id => id == OUTSIDE_REQUEST or s.opened.nth(id)).oneOf()
    all {
      s.policyCall == NO_OWNER,
      s.o.calls.length() < MAX_CALLERS,
      startCall(choice)
    }
  }
  action releasePolicy = all {
    s.policyCall >= 0,
    val scopeStillOpen = activeScope(s, s.scope)
    val memoSlot = if (scopeStillOpen and s.overlay != POLICY_NO_REQUEST) holder(s.scope) else NO_OWNER
    val canShare = memoSlot >= 0 and s.overlay != POLICY_NO_COALESCING
    val registeredOwner = if (canShare) s.registered.nth(memoSlot) else NO_OWNER
    val memoValue = if (memoSlot >= 0) s.memo.nth(memoSlot) else NO_MEMO
    val afterPolicyReply = { policyCall: NO_OWNER, ...s }
    // Admission precedes the memo read, including when an independent call
    // has populated the memo while the registered source is still pending.
    s' = if (registeredOwner >= 0) {
      d: { coalesced: s.d.coalesced.append("request_local"), ...s.d },
      owners: s.owners.replaceAt(s.policyCall, registeredOwner),
      ...afterPolicyReply
    }
    else if (memoValue > 0) {
      o: {
        calls: s.o.calls.replaceAt(s.policyCall, memoValue),
        ...s.o
      },
      ...afterPolicyReply
    }
    else source(afterPolicyReply, s.policyCall, memoSlot, canShare, scopeStillOpen,
      if (not(scopeStillOpen)) "noop" else if (memoSlot >= 0) "request_local" else "local"),
    input' = { name: "releasePolicy", choice: -1 }
  }

  // -- Source settlement and request publication -----------------------------

  pure def settle(state: State, loader: int, result: int): State = {
    val sourceRecord = state.sources.nth(loader)
    val memoScopeStillOpen = sourceRecord.slot >= 0 and not(state.completed.nth(sourceRecord.slot))
    {
      d: {
        fallbackErrors: if (result == SOURCE_ERROR
          and sourceRecord.metricLayer != "") state.d.fallbackErrors.append(sourceRecord.metricLayer)
          else state.d.fallbackErrors,
        ...state.d
      },
      sources: state.sources.replaceAt(loader, { result: result, ...sourceRecord }),
      settlements: state.settlements.append(loader),
      memo: if (memoScopeStillOpen and result != SOURCE_ERROR) state.memo.replaceAt(sourceRecord.slot, result)
        else state.memo,
      registered: if (memoScopeStillOpen
        and state.registered.nth(sourceRecord.slot) == loader) state.registered.replaceAt(sourceRecord.slot,
        NO_OWNER) else state.registered,
      o: {
        calls: finishOwnedCalls(state.o.calls, state.owners, loader, result),
        ...state.o
      },
      ...state
    }
  }
  action finishSource(loader: int, result: int): bool = all {
    s' = settle(s, loader, result),
    input' = if (result == SOURCE_ERROR) { name: "rejectLoader", choice: loader }
      else { name: "resolveLoader", choice: loader * SOURCE_VALUE_COUNT
        + (if (result <= VALUE_TWO) result else result - 2) }
  }
  val pending = s.sources.indices().filter(i => s.sources.nth(i).result == CALL_PENDING)
  action resolveLoader = {
    nondet choice = 1.to(MAX_RESOLVE_CHOICE).filter(code => pending.contains((code - 1) / SOURCE_VALUE_COUNT)).oneOf()
    finishSource((choice - 1) / SOURCE_VALUE_COUNT, values.nth((choice - 1) % SOURCE_VALUE_COUNT))
  }
  action rejectLoader = {
    nondet choice = pending.oneOf()
    finishSource(choice, SOURCE_ERROR)
  }

  // -- Environment scope and policy changes ----------------------------------

  pure def open(state: State, scope: int): State = {
    opened: state.opened.replaceAt(scope, true),
    ...state
  }
  action openContext(scope: int): bool = all {
    s' = open(s, scope),
    input' = { name: "openScope", choice: scope }
  }
  action openScope = {
    nondet choice = REPLACEMENT_REQUEST.to(REENABLED_REQUEST).filter(id => not(s.opened.nth(id)) and
      (id == REPLACEMENT_REQUEST or (not(s.completed.nth(ROOT_REQUEST)) and (id != REENABLED_REQUEST
        or s.opened.nth(NESTED_DISABLED))))).oneOf()
    openContext(choice)
  }
  pure def close(state: State, scope: int): State = {
    completed: state.completed.replaceAt(scope, true),
    memo: state.memo.indices().fold(state.memo, (out, slot) =>
      if (scope < NESTED_ENABLED and slot == scope) out.replaceAt(slot, NO_MEMO) else out),
    registered: state.registered.indices().fold(state.registered, (out, slot) =>
      if (scope < NESTED_ENABLED and slot == scope) out.replaceAt(slot, NO_OWNER) else out),
    ...state
  }
  action closeContext(scope: int): bool = all {
    s' = close(s, scope),
    input' = { name: "closeScope", choice: scope }
  }
  action closeScope = {
    nondet choice = ROOT_REQUEST.to(REENABLED_REQUEST).filter(id => s.opened.nth(id)
      and not(s.completed.nth(id))).oneOf()
    all {
      s.o.calls.length() > 0,
      closeContext(choice)
    }
  }
  // 0 inherits request caching/sharing; 1 bypasses request caching;
  // 2 retains memoization while disabling flight sharing.
  action changePolicy(overlay: int): bool = all {
    s' = { overlay: overlay, ...s },
    input' = { name: "policy", choice: overlay }
  }
  action policy = {
    nondet choice = Set(POLICY_INHERIT, POLICY_NO_REQUEST, POLICY_NO_COALESCING).oneOf()
    changePolicy(choice)
  }

  // -- Exploration schedule (nesting/order preserve sampling weights) ---------

  action step = any {
    beginCall,
    releasePolicy,
    any {
      resolveLoader,
      rejectLoader
    },
    // Keep closure reachable without letting early closure consume most runs.
    any {
      openScope,
      policy,
      any {
        openScope,
        policy,
        closeScope
      }
    }
  }

  // -- Independently stated safety properties --------------------------------

  val closedScopesHaveNoMemo = s.memo.indices().forall(slot =>
    not(s.completed.nth(slot)) or (s.memo.nth(slot) == NO_MEMO and s.registered.nth(slot) == NO_OWNER))
  val registeredSourcesArePending = s.registered.indices().forall(slot => {
    val loader = s.registered.nth(slot)
    loader < 0 or (s.sources.nth(loader).slot == slot and s.sources.nth(loader).shared
      and s.sources.nth(loader).result == CALL_PENDING)
  })
  val callsKeepSourceOutcome = s.o.calls.indices().forall(i =>
    if (s.owners.nth(i) >= 0) s.o.calls.nth(i) == s.sources.nth(s.owners.nth(i)).result
  else (s.o.calls.nth(i) == CALL_PENDING) == (i == s.policyCall))
  val sourceCountsMatchEffects = s.sources.length() == s.o.loaders and
    s.o.sourceScopes.length() == s.o.loaders and s.owners.length() == s.o.calls.length()

  // Record external completion order separately from the memo transition.
  // Source admission order and coalescing do not determine the final value.
  val memoFollowsLatestSuccessfulSettlement = s.memo.indices().forall(slot => {
    val latest = s.settlements.foldl(NO_MEMO, (result, loader) => {
      val source = s.sources.nth(loader)
      if (source.slot == slot and values.indices().exists(index => values.nth(index) == source.result))
        source.result else result
    })
    s.completed.nth(slot) or s.memo.nth(slot) == latest
  })

  // -- Deterministic regression schedules ------------------------------------

  run lateSourceCannotPopulateReplacementTest = init
    .then(startCall(ROOT_REQUEST))
    .then(releasePolicy)
    .then(closeContext(ROOT_REQUEST))
    .then(openContext(REPLACEMENT_REQUEST))
    .then(finishSource(0, VALUE_ONE))
    .then(startCall(REPLACEMENT_REQUEST))
    .then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.o.loaders == 2 and s.memo == List(NO_MEMO, NO_MEMO))

  run policyReplyAfterCloseBypassesRequestTest = init
    .then(startCall(ROOT_REQUEST))
    .then(closeContext(ROOT_REQUEST))
    .then(releasePolicy)
    .then(finishSource(0, VALUE_ONE))
    .expect(s.o.sourceScopes == List(false) and s.memo == List(NO_MEMO, NO_MEMO))

  run nestedCloseAndDisabledBypassKeepOuterMemoTest = init
    .then(openContext(NESTED_ENABLED))
    .then(startCall(NESTED_ENABLED))
    .then(releasePolicy)
    .then(finishSource(0, VALUE_ONE))
    .then(closeContext(NESTED_ENABLED))
    .then(openContext(NESTED_DISABLED))
    .then(startCall(NESTED_DISABLED))
    .then(finishSource(1, VALUE_TWO))
    .then(openContext(REENABLED_REQUEST))
    .then(startCall(REENABLED_REQUEST))
    .then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE) and s.o.loaders == 2
      and s.o.sourceScopes == List(true, false))

  run rejectedFlightAllowsRetryTest = init
    .then(startCall(ROOT_REQUEST))
    .then(releasePolicy)
    .then(startCall(ROOT_REQUEST))
    .then(releasePolicy)
    .then(finishSource(0, SOURCE_ERROR))
    .then(startCall(ROOT_REQUEST))
    .then(releasePolicy)
    .expect(s.o.calls == List(SOURCE_ERROR, SOURCE_ERROR, CALL_PENDING) and s.o.loaders == 2)
  run sharedFailureHasOneAttributedErrorTest = init.then(startCall(ROOT_REQUEST))
    .then(releasePolicy)
    .then(startCall(ROOT_REQUEST))
    .then(releasePolicy)
    .then(finishSource(0, SOURCE_ERROR))
    .expect(s.d.coalesced == List("request_local") and s.d.fallbackErrors == List("request_local"))
  run disabledSourceFailureHasNoCacheTrailTest = init.then(startCall(OUTSIDE_REQUEST))
    .then(finishSource(0, SOURCE_ERROR))
    .expect(s.d.fallbackErrors == List() and s.o.calls == List(SOURCE_ERROR))
  run policyClosureFailureIsAttributedWithoutCachingTest = init.then(startCall(ROOT_REQUEST))
    .then(closeContext(ROOT_REQUEST))
    .then(releasePolicy)
    .then(finishSource(0, SOURCE_ERROR))
    .expect(s.d.fallbackErrors == List("noop"))
  run absentValueIsMemoizedTest = init.then(startCall(ROOT_REQUEST))
    .then(releasePolicy)
    .then(finishSource(0, VALUE_ABSENT))
    .then(startCall(ROOT_REQUEST))
    .then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ABSENT, VALUE_ABSENT) and s.o.loaders == 1)

  run independentRequestMemoUsesLastCompletionTest = init
    .then(changePolicy(POLICY_NO_COALESCING))
    .then(startCall(ROOT_REQUEST)).then(releasePolicy)
    .then(startCall(ROOT_REQUEST)).then(releasePolicy)
    .then(finishSource(1, VALUE_TWO))
    .then(finishSource(0, VALUE_ONE))
    .then(startCall(ROOT_REQUEST)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE)
      and s.o.loaders == 2 and s.d.coalesced == List())

  run pendingSourceKeepsRequestPolicyAcrossBypassAndClosureTest = init
    .then(changePolicy(POLICY_NO_COALESCING))
    .then(startCall(ROOT_REQUEST)).then(releasePolicy)
    .then(changePolicy(POLICY_NO_REQUEST))
    .then(startCall(ROOT_REQUEST)).then(releasePolicy)
    .then(closeContext(ROOT_REQUEST))
    .then(openContext(REPLACEMENT_REQUEST))
    .then(changePolicy(POLICY_INHERIT))
    .then(finishSource(1, VALUE_TWO)).then(finishSource(0, VALUE_ONE))
    .then(startCall(REPLACEMENT_REQUEST)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, CALL_PENDING)
      and s.o.loaders == 3 and s.memo == List(NO_MEMO, NO_MEMO))
}
