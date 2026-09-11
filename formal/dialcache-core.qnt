module dialcache_core {
  // One-key behavioral model for caller-visible traversal and publication.
  // A single record state keeps every nondeterministic transition on the same
  // Quint update effect, while preserving the protocol-level distinctions.
  // Selected rules from C01-C03, C05, C18, C27-C28 and C31.
  // Values are presence bits; clocks, serializers,
  // asynchronous policy replies and flight ownership belong to other models.
  // Policy/health fields are environment inputs. call* fields capture admission;
  // counters and origin record what this call actually did within the model.

  // Types and state

  type ScopeState = OutsideScope | OpenScope | ClosedScope
  type CallPhase =
    CallIdle | RequestLookup | LocalLookup | RemoteLookup |
    LoaderRunning | RemotePublishing | CallDone
  type ResultOrigin = NoResult | RequestValue | LocalValue | RemoteValue | SourceValue

  type State = {
    scope: ScopeState,
    scopeId: int,
    callScopeId: int,
    requestValueScope: int,
    scopeDepth: int,
    scopeDisabled: bool,
    policyRequestLocal: bool,
    policyLocal: bool,
    policyRemote: bool,
    policyTracked: bool,
    callRequestLocal: bool,
    callLocal: bool,
    callRemote: bool,
    callTracked: bool,
    callStartedEnabled: bool,
    invalidInvocationPolicy: bool,
    requestHasValue: bool,
    localHasValue: bool,
    remoteHasValue: bool,
    remoteReadHealthy: bool,
    localReadHealthy: bool,
    localWriteHealthy: bool,
    localWriteFailures: int,
    phase: CallPhase,
    origin: ResultOrigin,
    requestReads: int,
    localReads: int,
    remoteReads: int,
    sourceCalls: int,
    requestWrites: int,
    localWrites: int,
    remoteWrites: int,
    configSnapshots: int,
    keyConstructions: int,
    remoteSemanticMiss: bool,
    remoteReadFailed: bool
  }

  var s: State

  // Transition predicates. Invariants below restate the obligations independently.
  val callScopeLive = s.scope == OpenScope and s.callScopeId == s.scopeId
  val requestMemoEligible = s.callRequestLocal and callScopeLive
  val localReadEligible = s.callLocal and s.localReadHealthy
  val localHit = localReadEligible and s.localHasValue
  val localWriteEligible = localReadEligible and s.localWriteHealthy
  val localWriteFails = localReadEligible and not(s.localWriteHealthy)

  // Initial state

  action init = s' = {
    scope: OutsideScope,
    scopeId: 0,
    callScopeId: 0,
    requestValueScope: 0,
    scopeDepth: 0,
    scopeDisabled: false,
    policyRequestLocal: false,
    policyLocal: false,
    policyRemote: false,
    policyTracked: false,
    callRequestLocal: false,
    callLocal: false,
    callRemote: false,
    callTracked: false,
    callStartedEnabled: false,
    invalidInvocationPolicy: false,
    requestHasValue: false,
    localHasValue: false,
    remoteHasValue: false,
    remoteReadHealthy: true,
    localReadHealthy: true,
    localWriteHealthy: true,
    localWriteFailures: 0,
    phase: CallIdle,
    origin: NoResult,
    requestReads: 0,
    localReads: 0,
    remoteReads: 0,
    sourceCalls: 0,
    requestWrites: 0,
    localWrites: 0,
    remoteWrites: 0,
    configSnapshots: 0,
    keyConstructions: 0,
    remoteSemanticMiss: false,
    remoteReadFailed: false
  }

  // Environment and request lifetime transitions
  action toggleRequestPolicy = all {
    s.phase == CallIdle,
    s' = { policyRequestLocal: not(s.policyRequestLocal), ...s },
  }

  action toggleLocalPolicy = all {
    s.phase == CallIdle,
    s' = { policyLocal: not(s.policyLocal), ...s },
  }

  action toggleRemotePolicy = all {
    s.phase == CallIdle,
    s' = { policyRemote: not(s.policyRemote), ...s },
  }

  action toggleTrackedPolicy = all {
    s.phase == CallIdle,
    s' = { policyTracked: not(s.policyTracked), ...s },
  }

  action toggleRedisHealth = all {
    s.phase == CallIdle,
    s' = { remoteReadHealthy: not(s.remoteReadHealthy), ...s },
  }

  // Local storage failures are environment outcomes of DialCache-owned
  // operations, not failures of the source. No LRU internals are modeled.
  action toggleLocalReadHealth = all {
    s.phase == CallIdle,
    s' = { localReadHealthy: not(s.localReadHealthy), ...s },
  }

  action toggleLocalWriteHealth = all {
    s.phase == CallIdle,
    s' = { localWriteHealthy: not(s.localWriteHealthy), ...s },
  }

  action openScope = all {
    s.scope != OpenScope,
    s' = {
      scope: OpenScope,
      scopeId: s.scopeId + 1,
      scopeDepth: 1,
      scopeDisabled: false,
      requestHasValue: false,
      ...s
    },
  }

  action closeScope = all {
    s.scope == OpenScope,
    s' = {
      scope: ClosedScope,
      scopeDepth: 0,
      scopeDisabled: false,
      requestHasValue: false,
      ...s
    },
  }

  action nestedEnable = all {
    s.phase == CallIdle,
    s.scope == OpenScope,
    not(s.scopeDisabled),
    s' = { scopeDepth: s.scopeDepth + 1, ...s },
  }

  action exitNestedEnable = all {
    s.phase == CallIdle,
    s.scopeDepth > 1,
    s' = { scopeDepth: s.scopeDepth - 1, ...s },
  }

  action disableScope = all {
    s.phase == CallIdle,
    s.scope == OpenScope,
    not(s.scopeDisabled),
    s' = { scopeDisabled: true, ...s },
  }

  action restoreScope = all {
    s.phase == CallIdle,
    s.scopeDisabled,
    s' = { scopeDisabled: false, ...s },
  }

  // Call admission and layer traversal
  // Outside enable(), DialCache is true pass-through: no key/config/cache work.
  action startPassThrough = all {
    s.phase == CallIdle,
    s.scope != OpenScope or s.scopeDisabled,
    s' = {
      callStartedEnabled: false,
      invalidInvocationPolicy: false,
      callRequestLocal: false,
      callLocal: false,
      callRemote: false,
      callTracked: false,
      phase: LoaderRunning,
      origin: NoResult,
      requestReads: 0,
      localReads: 0,
      remoteReads: 0,
      sourceCalls: 1,
      requestWrites: 0,
      localWrites: 0,
      localWriteFailures: 0,
      remoteWrites: 0,
      configSnapshots: 0,
      keyConstructions: 0,
      remoteSemanticMiss: false,
      remoteReadFailed: false,
      ...s
    },
  }

  // Runtime/default policy is snapshotted once at invocation start.
  action startEnabledCall = all {
    s.phase == CallIdle,
    s.scope == OpenScope,
    not(s.scopeDisabled),
    s' = {
      callScopeId: s.scopeId,
      callStartedEnabled: true,
      invalidInvocationPolicy: false,
      callRequestLocal: s.policyRequestLocal,
      callLocal: s.policyLocal,
      callRemote: s.policyRemote,
      callTracked: s.policyTracked,
      phase: RequestLookup,
      origin: NoResult,
      requestReads: 0,
      localReads: 0,
      remoteReads: 0,
      sourceCalls: 0,
      requestWrites: 0,
      localWrites: 0,
      localWriteFailures: 0,
      remoteWrites: 0,
      configSnapshots: 1,
      keyConstructions: 1,
      remoteSemanticMiss: false,
      remoteReadFailed: false,
      ...s
    },
  }

  // A malformed invocation-wide flag (for example an explicit null where a
  // boolean is required) differs from valid false. Host representations are
  // abstracted to invalid admission here; they remain fixed/native boundary tests.
  action rejectInvalidInvocationPolicy = all {
    s.phase == RequestLookup,
    s' = {
      invalidInvocationPolicy: true,
      callRequestLocal: false,
      callLocal: false,
      callRemote: false,
      sourceCalls: 1,
      phase: LoaderRunning,
      ...s
    },
  }

  action requestLookup = all {
    s.phase == RequestLookup,
    s' = {
      requestReads: if (requestMemoEligible) s.requestReads + 1 else s.requestReads,
      origin: if (requestMemoEligible and s.requestHasValue) RequestValue else s.origin,
      phase: if (requestMemoEligible and s.requestHasValue) CallDone else LocalLookup,
      ...s
    },
  }

  action localLookup = all {
    s.phase == LocalLookup,
    s' = {
      localReads: if (s.callLocal) s.localReads + 1 else s.localReads,
      origin: if (localHit) LocalValue else s.origin,
      requestHasValue: if (localHit and requestMemoEligible) true else s.requestHasValue,
      requestWrites: if (localHit and requestMemoEligible) s.requestWrites + 1 else s.requestWrites,
      requestValueScope: if (localHit and requestMemoEligible) s.callScopeId else s.requestValueScope,
      phase: if (localHit) CallDone else RemoteLookup,
      ...s
    },
  }

  action remoteLookupHealthy = all {
    s.phase == RemoteLookup,
    s.callRemote,
    s.remoteReadHealthy,
    s' = {
      remoteReads: s.remoteReads + 1,
      origin: if (s.remoteHasValue) RemoteValue else s.origin,
      localWriteFailures: if (s.remoteHasValue and localWriteFails) s.localWriteFailures + 1 else s.localWriteFailures,
      localHasValue: if (s.remoteHasValue and localWriteEligible) true else s.localHasValue,
      localWrites: if (s.remoteHasValue and localWriteEligible) s.localWrites + 1 else s.localWrites,
      requestHasValue: if (s.remoteHasValue and requestMemoEligible) true else s.requestHasValue,
      requestWrites: if (s.remoteHasValue and requestMemoEligible) s.requestWrites + 1 else s.requestWrites,
      requestValueScope: if (s.remoteHasValue and requestMemoEligible) s.callScopeId else s.requestValueScope,
      remoteSemanticMiss: not(s.remoteHasValue),
      sourceCalls: if (s.remoteHasValue) s.sourceCalls else s.sourceCalls + 1,
      phase: if (s.remoteHasValue) CallDone else LoaderRunning,
      ...s
    },
  }

  action remoteLookupFailure = all {
    s.phase == RemoteLookup,
    s.callRemote,
    not(s.remoteReadHealthy),
    s' = {
      remoteReads: s.remoteReads + 1,
      remoteReadFailed: true,
      sourceCalls: s.sourceCalls + 1,
      phase: LoaderRunning,
      ...s
    },
  }

  action skipRemote = all {
    s.phase == RemoteLookup,
    not(s.callRemote),
    s' = { sourceCalls: s.sourceCalls + 1, phase: LoaderRunning, ...s },
  }

  // Source outcomes and publication
  action loaderSuccessPassThrough = all {
    s.phase == LoaderRunning,
    not(s.callStartedEnabled),
    s' = { origin: SourceValue, phase: CallDone, ...s },
  }

  action loaderSuccessAfterSemanticMiss = all {
    s.phase == LoaderRunning,
    s.callStartedEnabled,
    s.remoteSemanticMiss,
    s' = { origin: SourceValue, phase: RemotePublishing, ...s },
  }

  // Redis read failure is fail-open but is not a semantic miss, so no refill.
  action loaderSuccessAfterRemoteFailure = all {
    s.phase == LoaderRunning,
    s.callStartedEnabled,
    s.remoteReadFailed,
    s' = {
      origin: SourceValue,
      localWriteFailures: if (localWriteFails and not(s.callTracked)) s.localWriteFailures + 1 else s.localWriteFailures,
      localHasValue: if (localWriteEligible and not(s.callTracked)) true else s.localHasValue,
      localWrites: if (localWriteEligible and not(s.callTracked)) s.localWrites + 1 else s.localWrites,
      requestHasValue: if (requestMemoEligible) true else s.requestHasValue,
      requestWrites: if (requestMemoEligible) s.requestWrites + 1 else s.requestWrites,
      requestValueScope: if (requestMemoEligible) s.callScopeId else s.requestValueScope,
      phase: CallDone,
      ...s
    },
  }

  action loaderSuccessWithoutRemote = all {
    s.phase == LoaderRunning,
    s.callStartedEnabled,
    not(s.callRemote),
    s' = {
      origin: SourceValue,
      localWriteFailures: if (localWriteFails) s.localWriteFailures + 1 else s.localWriteFailures,
      localHasValue: if (localWriteEligible) true else s.localHasValue,
      localWrites: if (localWriteEligible) s.localWrites + 1 else s.localWrites,
      requestHasValue: if (requestMemoEligible) true else s.requestHasValue,
      requestWrites: if (requestMemoEligible) s.requestWrites + 1 else s.requestWrites,
      requestValueScope: if (requestMemoEligible) s.callScopeId else s.requestValueScope,
      phase: CallDone,
      ...s
    },
  }

  action loaderFailure = all {
    s.phase == LoaderRunning,
    s' = {
      requestHasValue: if (s.scope == OpenScope) s.requestHasValue else false,
      phase: CallDone,
      origin: NoResult,
      ...s
    },
  }

  action finishRemotePublication = all {
    s.phase == RemotePublishing,
    s' = {
      remoteWrites: s.remoteWrites + 1,
      remoteHasValue: true,
      localWriteFailures: if (localWriteFails and not(s.callTracked)) s.localWriteFailures + 1 else s.localWriteFailures,
      localHasValue: if (localWriteEligible and not(s.callTracked)) true else s.localHasValue,
      localWrites: if (localWriteEligible and not(s.callTracked)) s.localWrites + 1 else s.localWrites,
      requestHasValue: if (requestMemoEligible) true else s.requestHasValue,
      requestWrites: if (requestMemoEligible) s.requestWrites + 1 else s.requestWrites,
      requestValueScope: if (requestMemoEligible) s.callScopeId else s.requestValueScope,
      phase: CallDone,
      ...s
    },
  }

  action resetCall = all {
    s.phase == CallDone,
    s' = { phase: CallIdle, origin: NoResult, ...s },
  }

  // Exploration order is intentional: preserve it when editing the model.
  action step = any {
    toggleRequestPolicy,
    toggleLocalPolicy,
    toggleRemotePolicy,
    toggleTrackedPolicy,
    toggleRedisHealth,
    toggleLocalReadHealth,
    toggleLocalWriteHealth,
    openScope,
    closeScope,
    nestedEnable,
    exitNestedEnable,
    disableScope,
    restoreScope,
    startPassThrough,
    startEnabledCall,
    requestLookup,
    rejectInvalidInvocationPolicy,
    localLookup,
    remoteLookupHealthy,
    remoteLookupFailure,
    skipRemote,
    loaderSuccessPassThrough,
    loaderSuccessAfterSemanticMiss,
    loaderSuccessAfterRemoteFailure,
    loaderSuccessWithoutRemote,
    loaderFailure,
    finishRemotePublication,
    resetCall,
  }

  // Invariants
  val closedScopeHasNoRequestValue =
    s.scope != ClosedScope or not(s.requestHasValue)

  val passThroughSkipsCacheMachinery =
    s.callStartedEnabled or
      (s.requestReads == 0 and s.localReads == 0 and s.remoteReads == 0 and
       s.configSnapshots == 0 and s.keyConstructions == 0 and
       s.requestWrites == 0 and s.localWrites == 0 and s.remoteWrites == 0)

  val firstHitStopsLowerTraversal = and {
    s.origin != RequestValue or (s.localReads == 0 and s.remoteReads == 0 and s.sourceCalls == 0),
    s.origin != LocalValue or (s.remoteReads == 0 and s.sourceCalls == 0),
    s.origin != RemoteValue or s.sourceCalls == 0,
  }

  val failedLocalReadSkipsReuseAndPublication =
    s.phase == CallIdle or s.localReadHealthy or
      (s.origin != LocalValue and s.localWrites == 0 and s.localWriteFailures == 0)

  val failedLocalWritePreservesAcceptedResult =
    s.phase != CallDone or s.localWriteFailures == 0 or
      (s.origin == RemoteValue or s.origin == SourceValue)

  val remoteFailureNeverRefills =
    not(s.remoteReadFailed) or s.remoteWrites == 0

  val trackedRemoteFallbackSuppressesLocalPublication =
    not(s.callTracked and s.remoteSemanticMiss and s.origin == SourceValue) or s.localWrites == 0

  val onePolicySnapshotPerEnabledInvocation =
    if (s.callStartedEnabled)
      (s.configSnapshots == 1 and s.keyConstructions == 1)
    else
      (s.configSnapshots == 0 and s.keyConstructions == 0)

  val requestValueBelongsToCurrentScope =
    not(s.requestHasValue) or (s.scope == OpenScope and s.requestValueScope == s.scopeId)

  val sourceFailureNeverPublishes =
    s.phase != CallDone or s.origin != NoResult or
      (s.requestWrites == 0 and s.localWrites == 0 and s.remoteWrites == 0)

  val noLayerPolicySkipsAllStorage =
    s.callRequestLocal or s.callLocal or s.callRemote or
      (s.requestReads == 0 and s.localReads == 0 and s.remoteReads == 0 and
       s.requestWrites == 0 and s.localWrites == 0 and s.remoteWrites == 0)

  val invalidInvocationPolicyNeverTouchesStorage =
    not(s.invalidInvocationPolicy) or
      (s.requestReads == 0 and s.localReads == 0 and s.remoteReads == 0 and
       s.requestWrites == 0 and s.localWrites == 0 and s.remoteWrites == 0)

  // Deterministic regressions
  run lateResultCannotEnterReplacementScopeTest = init.then(toggleRequestPolicy).then(openScope)
    .then(startEnabledCall).then(requestLookup).then(localLookup).then(skipRemote)
    .then(closeScope).then(openScope).then(loaderSuccessWithoutRemote)
    .expect(not(s.requestHasValue) and s.requestWrites == 0)

  run nestedDisablePreservesMemoTest = init.then(toggleRequestPolicy).then(openScope)
    .then(startEnabledCall).then(requestLookup).then(localLookup).then(skipRemote)
    .then(loaderSuccessWithoutRemote).then(resetCall).then(nestedEnable).then(exitNestedEnable)
    .then(disableScope).then(startPassThrough).then(loaderSuccessPassThrough).then(resetCall)
    .then(restoreScope).then(startEnabledCall).then(requestLookup)
    .expect(s.origin == RequestValue and s.sourceCalls == 0)

  run localReadFailureContinuesToRemoteTest = init.then(toggleLocalPolicy).then(toggleRemotePolicy).then(openScope)
    .then(startEnabledCall).then(requestLookup).then(localLookup).then(remoteLookupHealthy)
    .then(loaderSuccessAfterSemanticMiss).then(finishRemotePublication).then(resetCall)
    .then(toggleLocalReadHealth).then(startEnabledCall).then(requestLookup).then(localLookup).then(remoteLookupHealthy)
    .expect(s.origin == RemoteValue and s.localReads == 1 and s.remoteReads == 1 and s.sourceCalls == 0 and s.localWrites == 0)

  run localWriteFailurePreservesSourceAndMemoTest = init.then(toggleLocalPolicy).then(toggleRequestPolicy)
    .then(toggleLocalWriteHealth).then(openScope).then(startEnabledCall).then(requestLookup).then(localLookup)
    .then(skipRemote).then(loaderSuccessWithoutRemote)
    .expect(s.origin == SourceValue and not(s.localHasValue) and s.localWriteFailures == 1 and s.requestHasValue)

  run localWriteFailurePreservesRemoteHitTest = init.then(toggleRemotePolicy).then(openScope)
    .then(startEnabledCall).then(requestLookup).then(localLookup).then(remoteLookupHealthy)
    .then(loaderSuccessAfterSemanticMiss).then(finishRemotePublication).then(resetCall)
    .then(toggleLocalPolicy).then(toggleRequestPolicy).then(toggleLocalWriteHealth)
    .then(startEnabledCall).then(requestLookup).then(localLookup).then(remoteLookupHealthy)
    .expect(s.origin == RemoteValue and s.sourceCalls == 0 and s.localWriteFailures == 1 and s.requestHasValue)

  run localReadFailureSuppressesSourcePublicationTest = init.then(toggleLocalPolicy).then(toggleLocalReadHealth)
    .then(openScope).then(startEnabledCall).then(requestLookup).then(localLookup).then(skipRemote)
    .then(loaderSuccessWithoutRemote)
    .expect(s.origin == SourceValue and not(s.localHasValue) and s.localWrites == 0 and s.localWriteFailures == 0)

  run untrackedSourcePublishesToAllParticipatingLayersTest = init
    .then(toggleRequestPolicy).then(toggleLocalPolicy).then(toggleRemotePolicy)
    .then(openScope).then(startEnabledCall).then(requestLookup).then(localLookup)
    .then(remoteLookupHealthy).then(loaderSuccessAfterSemanticMiss).then(finishRemotePublication)
    .expect(s.origin == SourceValue and s.requestWrites == 1
      and s.localWrites == 1 and s.remoteWrites == 1)
    .then(resetCall).then(startEnabledCall).then(requestLookup)
    .expect(s.origin == RequestValue and s.localReads == 0
      and s.remoteReads == 0 and s.sourceCalls == 0)

  run localHitWarmsRequestAndSkipsRemoteTest = init.then(toggleLocalPolicy)
    .then(openScope).then(startEnabledCall).then(requestLookup).then(localLookup)
    .then(skipRemote).then(loaderSuccessWithoutRemote).then(resetCall)
    .then(toggleRequestPolicy).then(toggleRemotePolicy)
    .then(startEnabledCall).then(requestLookup).then(localLookup)
    .expect(s.origin == LocalValue and s.requestWrites == 1
      and s.remoteReads == 0 and s.sourceCalls == 0)

  run remoteReadFailureStillPublishesUntrackedLocalAndRequestTest = init
    .then(toggleRequestPolicy).then(toggleLocalPolicy).then(toggleRemotePolicy)
    .then(toggleRedisHealth).then(openScope).then(startEnabledCall)
    .then(requestLookup).then(localLookup).then(remoteLookupFailure)
    .then(loaderSuccessAfterRemoteFailure)
    .expect(s.origin == SourceValue and s.requestWrites == 1
      and s.localWrites == 1 and s.remoteWrites == 0)

  run trackedWithoutRemoteStillPublishesLocalTest = init
    .then(toggleLocalPolicy).then(toggleTrackedPolicy).then(openScope)
    .then(startEnabledCall).then(requestLookup).then(localLookup).then(skipRemote)
    .then(loaderSuccessWithoutRemote)
    .expect(s.origin == SourceValue and s.localWrites == 1 and s.remoteWrites == 0)

  run rejectedSourceNeverPublishesTest = init
    .then(toggleRequestPolicy).then(toggleLocalPolicy).then(toggleRemotePolicy)
    .then(openScope).then(startEnabledCall).then(requestLookup).then(localLookup)
    .then(remoteLookupHealthy).then(loaderFailure)
    .expect(s.origin == NoResult and s.requestWrites == 0
      and s.localWrites == 0 and s.remoteWrites == 0)

  run invalidBooleanOverlayBypassesAndPreservesMemoTest = init
    .then(toggleRequestPolicy).then(openScope).then(startEnabledCall)
    .then(requestLookup).then(localLookup).then(skipRemote)
    .then(loaderSuccessWithoutRemote).then(resetCall).then(startEnabledCall)
    .then(rejectInvalidInvocationPolicy).then(loaderSuccessWithoutRemote)
    .expect(s.origin == SourceValue and s.requestReads == 0 and s.requestWrites == 0)
    .then(resetCall).then(startEnabledCall).then(requestLookup)
    .expect(s.origin == RequestValue and s.sourceCalls == 0)
}
