module dialcache_coalescing_liveness {
  // Selected rules from C11, C14 and C23-C26. One request/process flight, with followers
  // and older abandoned sources. Policy flags are environment inputs; phase and
  // flightScope are DialCache ownership. fallbackStartedAt records invocation
  // time so deadline properties can be checked independently of the transition.
  // Sampled time ranges from 0 through MAX_TIME; named library-budget regressions
  // also jump to 60,000/60,001 ms to check the real default boundary. Independently
  // admitted sources model successful settlement versus timeout, without cache
  // publication; the main flight also models rejection and publication ownership.
  // This checks deadline safety and cleanup, not scheduler fairness or progress.

  // Types, bounds and state
  type FlightScope = NoFlight | RequestFlight | ProcessFlight
  type FlightPhase = FlightIdle | CacheLookup | FallbackRunning | Publication | FlightDone
  type Outcome = NoOutcome | CacheHit | SourceSuccess | SourceFailure | SourceTimeout

  pure val MAX_TIME = 8
  pure val FALLBACK_TIMEOUT = 3
  pure val LIBRARY_FALLBACK_TIMEOUT_MS = 60000
  pure val OMITTED_FALLBACK_TIMEOUT = -1
  pure val NO_FALLBACK_TIMEOUT = 0

  // Independently admitted callers include disabled calls, enabled calls with
  // no serving layers, failed key construction, and coalescing-disabled calls.
  // A zero captured budget means no deadline; initially disabled callers always
  // capture zero regardless of the operation's configured source budget.
  type IndependentSource = {
    startedEnabled: bool,
    configuredBudget: int,
    budget: int,
    startedAt: int,
    acceptedAt: int,
    outcome: Outcome
  }

  type State = {
    now: int,
    scopeEnabled: bool,
    requestLayerActive: bool,
    sharedLayerActive: bool,
    coalesce: bool,
    phase: FlightPhase,
    flightScope: FlightScope,
    outcome: Outcome,
    followers: int,
    sourceExecutions: int,
    independentExecutions: int,
    independentSources: List[IndependentSource],
    configuredSourceBudget: int,
    keyConstructionFailed: bool,
    fallbackDeadline: int,
    fallbackStartedAt: int,
    fallbackDeadlineStarted: bool,
    activeSourceRunning: bool,
    abandonedSources: int,
    acceptedSourceResult: bool,
    publicationDispatched: bool
  }

  var s: State

  // Initial state
  action init = s' = {
    now: 0,
    scopeEnabled: false,
    requestLayerActive: false,
    sharedLayerActive: false,
    coalesce: true,
    phase: FlightIdle,
    flightScope: NoFlight,
    outcome: NoOutcome,
    followers: 0,
    sourceExecutions: 0,
    independentExecutions: 0,
    independentSources: List(),
    configuredSourceBudget: FALLBACK_TIMEOUT,
    keyConstructionFailed: false,
    fallbackDeadline: 0,
    fallbackStartedAt: 0,
    fallbackDeadlineStarted: false,
    activeSourceRunning: false,
    abandonedSources: 0,
    acceptedSourceResult: false,
    publicationDispatched: false
  }

  // Environment transitions
  action advanceTime = all {
    s.now < MAX_TIME,
    s' = { now: s.now + 1, ...s },
  }

  action toggleEnabled = all {
    s.phase == FlightIdle,
    s' = { scopeEnabled: not(s.scopeEnabled), ...s },
  }

  action toggleRequestLayer = all {
    s.phase == FlightIdle,
    s' = { requestLayerActive: not(s.requestLayerActive), ...s },
  }

  action toggleSharedLayer = all {
    s.phase == FlightIdle,
    s' = { sharedLayerActive: not(s.sharedLayerActive), ...s },
  }

  action toggleCoalesce = all {
    s.phase == FlightIdle,
    s' = { coalesce: not(s.coalesce), ...s },
  }

  action chooseSourceBudget = {
    nondet budget = Set(OMITTED_FALLBACK_TIMEOUT, NO_FALLBACK_TIMEOUT, FALLBACK_TIMEOUT).oneOf()
    s' = { configuredSourceBudget: budget, ...s }
  }

  action toggleKeyFailure = all {
    s.phase == FlightIdle,
    s' = { keyConstructionFailed: not(s.keyConstructionFailed), ...s },
  }

  // Flight admission and cache lookup
  // Request-local coalescing wraps process coalescing and therefore wins when
  // both scopes are eligible for the same key.
  action startLeader = all {
    s.phase == FlightIdle,
    s.scopeEnabled,
    s.coalesce,
    not(s.keyConstructionFailed),
    s.requestLayerActive or s.sharedLayerActive,
    s' = {
      phase: CacheLookup,
      flightScope: if (s.requestLayerActive) RequestFlight else ProcessFlight,
      outcome: NoOutcome,
      followers: 0,
      sourceExecutions: 0,
      fallbackDeadlineStarted: false,
      activeSourceRunning: false,
      acceptedSourceResult: false,
      publicationDispatched: false,
      ...s
    },
  }

  action joinFollower = all {
    s.phase != FlightIdle,
    s.phase != FlightDone,
    s.flightScope != NoFlight,
    s' = { followers: s.followers + 1, ...s },
  }

  action startIndependentCaller = all {
    s.phase == FlightIdle,
    s.keyConstructionFailed or
      not(s.scopeEnabled and s.coalesce and (s.requestLayerActive or s.sharedLayerActive)),
    val budget = if (not(s.scopeEnabled)) NO_FALLBACK_TIMEOUT
      else if (s.configuredSourceBudget == OMITTED_FALLBACK_TIMEOUT) LIBRARY_FALLBACK_TIMEOUT_MS
      else s.configuredSourceBudget
    s' = {
      independentExecutions: s.independentExecutions + 1,
      independentSources: s.independentSources.append({
        startedEnabled: s.scopeEnabled,
        configuredBudget: s.configuredSourceBudget,
        budget: budget,
        startedAt: s.now,
        acceptedAt: 0,
        outcome: NoOutcome
      }),
      ...s
    },
  }

  action settleIndependentSource = {
    nondet source = s.independentSources.indices()
      .filter(i => s.independentSources.nth(i).outcome == NoOutcome).oneOf()
    val pending = s.independentSources.nth(source)
    val expired = pending.budget > 0 and s.now - pending.startedAt >= pending.budget
    s' = {
      independentSources: s.independentSources.replaceAt(source, {
        outcome: if (expired) SourceTimeout else SourceSuccess,
        acceptedAt: s.now,
        ...pending
      }),
      ...s
    }
  }

  action finishCacheHit = all {
    s.phase == CacheLookup,
    s' = { outcome: CacheHit, phase: FlightDone, ...s },
  }

  // Source acceptance, abandonment and publication
  // Cache-read time is outside the fallback budget. The source deadline begins
  // exactly when the leader invokes the fallback.
  action cacheMissStartsFallback = all {
    s.phase == CacheLookup,
    s' = {
      sourceExecutions: s.sourceExecutions + 1,
      activeSourceRunning: true,
      fallbackDeadlineStarted: true,
      fallbackStartedAt: s.now,
      fallbackDeadline: s.now + FALLBACK_TIMEOUT,
      phase: FallbackRunning,
      ...s
    },
  }

  action sourceSucceedsBeforeDeadline = all {
    s.phase == FallbackRunning,
    s.now < s.fallbackDeadline,
    s.activeSourceRunning,
    s' = {
      activeSourceRunning: false,
      acceptedSourceResult: true,
      outcome: SourceSuccess,
      phase: Publication,
      ...s
    },
  }

  action sourceRejects = all {
    s.phase == FallbackRunning,
    s.activeSourceRunning,
    s.now < s.fallbackDeadline,
    s' = {
      activeSourceRunning: false,
      acceptedSourceResult: false,
      outcome: SourceFailure,
      phase: FlightDone,
      ...s
    },
  }

  // A late success or rejection can reach DialCache before the timer callback.
  // Settlement still checks the monotonic deadline and returns a timeout.
  action sourceSettlesAfterDeadline = all {
    s.phase == FallbackRunning,
    s.activeSourceRunning,
    s.now >= s.fallbackDeadline,
    s' = {
      activeSourceRunning: false,
      acceptedSourceResult: false,
      outcome: SourceTimeout,
      phase: FlightDone,
      flightScope: NoFlight,
      ...s
    },
  }

  // Timeout removes DialCache ownership immediately. The underlying operation is
  // not cancelled; it becomes abandoned external work that may settle later.
  action fallbackTimesOut = all {
    s.phase == FallbackRunning,
    s.fallbackDeadlineStarted,
    s.now >= s.fallbackDeadline,
    s.activeSourceRunning,
    s' = {
      activeSourceRunning: false,
      abandonedSources: s.abandonedSources + 1,
      acceptedSourceResult: false,
      outcome: SourceTimeout,
      phase: FlightDone,
      flightScope: NoFlight,
      ...s
    },
  }

  // This can happen while another flight is already active. It cannot affect the
  // current flight's accepted result or publication state.
  action abandonedSourceSettles = all {
    s.abandonedSources > 0,
    s' = { abandonedSources: s.abandonedSources - 1, ...s },
  }

  // Serialization/write work begins only after a result was accepted before the
  // fallback deadline, and is intentionally outside that deadline.
  action dispatchPublication = all {
    s.phase == Publication,
    s.acceptedSourceResult,
    s' = { publicationDispatched: true, phase: FlightDone, ...s },
  }

  action resetFlight = all {
    s.phase == FlightDone,
    s' = {
      phase: FlightIdle,
      flightScope: NoFlight,
      outcome: NoOutcome,
      followers: 0,
      sourceExecutions: 0,
      fallbackDeadlineStarted: false,
      activeSourceRunning: false,
      acceptedSourceResult: false,
      publicationDispatched: false,
      ...s
    },
  }

  // Exploration order
  action step = any {
    advanceTime,
    toggleEnabled,
    toggleRequestLayer,
    toggleSharedLayer,
    toggleCoalesce,
    startLeader,
    joinFollower,
    startIndependentCaller,
    finishCacheHit,
    cacheMissStartsFallback,
    sourceSucceedsBeforeDeadline,
    sourceRejects,
    sourceSettlesAfterDeadline,
    fallbackTimesOut,
    abandonedSourceSettles,
    dispatchPublication,
    resetFlight,
    chooseSourceBudget,
    toggleKeyFailure,
    settleIndependentSource,
  }

  // Invariants
  val flightsRequireEligibleCaching =
    s.flightScope == NoFlight or
      (s.scopeEnabled and s.coalesce and (s.requestLayerActive or s.sharedLayerActive))

  val oneSourcePerRegisteredFlight =
    s.sourceExecutions <= 1

  val fallbackDeadlineStartsWithFallback =
    not(s.fallbackDeadlineStarted) or
      ((s.phase == FallbackRunning or s.phase == Publication or s.phase == FlightDone) and
       s.fallbackStartedAt <= s.now and
       s.fallbackDeadline == s.fallbackStartedAt + FALLBACK_TIMEOUT)

  val timedOutSourceCannotPublish =
    s.outcome != SourceTimeout or
      (not(s.acceptedSourceResult) and not(s.publicationDispatched))

  val publicationRequiresAcceptedSource =
    not(s.publicationDispatched) or s.acceptedSourceResult

  val noFlightWhenCoalescingIneligible =
    (s.scopeEnabled and s.coalesce and (s.requestLayerActive or s.sharedLayerActive)) or
      s.flightScope == NoFlight

  // Abandoned work is explicitly not represented as an active registered source.
  val abandonedSourceIsNotAFlight =
    s.abandonedSources == 0 or not(s.activeSourceRunning) or s.phase == FallbackRunning

  val requestLayerOwnsOuterFlight =
    s.flightScope == NoFlight or not(s.requestLayerActive) or s.flightScope == RequestFlight

  val cacheHitNeverStartsSourceDeadline =
    s.outcome != CacheHit or (s.sourceExecutions == 0 and not(s.fallbackDeadlineStarted))

  val outsideSourceHasNoDeadline = s.independentSources.indices().forall(i => {
    val source = s.independentSources.nth(i)
    source.startedEnabled or (source.budget == 0 and source.outcome != SourceTimeout)
  })

  val omittedSourceBudgetUsesSixtySeconds = s.independentSources.indices().forall(i => {
    val source = s.independentSources.nth(i)
    not(source.startedEnabled) or source.configuredBudget != OMITTED_FALLBACK_TIMEOUT or source.budget == 60000
  })

  val disabledSourceDeadlineNeverTimesOut = s.independentSources.indices().forall(i => {
    val source = s.independentSources.nth(i)
    source.budget != NO_FALLBACK_TIMEOUT or source.outcome != SourceTimeout
  })

  val independentAcceptanceChecksCapturedDeadline = s.independentSources.indices().forall(i => {
    val source = s.independentSources.nth(i)
    and {
      source.outcome != SourceSuccess or source.budget == 0 or
        source.acceptedAt - source.startedAt < source.budget,
      source.outcome != SourceTimeout or
        (source.budget > 0 and source.acceptedAt - source.startedAt >= source.budget),
    }
  })

  // Deterministic regressions
  run lateSettlementBeforeTimerTest = init
    .then(toggleEnabled).then(toggleSharedLayer).then(startLeader)
    .then(cacheMissStartsFallback)
    .then(advanceTime).then(advanceTime).then(advanceTime)
    .then(sourceSettlesAfterDeadline)
    .expect(s.outcome == SourceTimeout and s.flightScope == NoFlight)
    .expect(timedOutSourceCannotPublish)

  run abandonedSourceMayOverlapNewFlightTest = init
    .then(toggleEnabled).then(toggleSharedLayer).then(startLeader)
    .then(cacheMissStartsFallback)
    .then(advanceTime).then(advanceTime).then(advanceTime)
    .then(fallbackTimesOut).then(resetFlight).then(startLeader)
    .then(cacheMissStartsFallback)
    .expect(s.abandonedSources == 1 and s.activeSourceRunning)
    .then(abandonedSourceSettles)
    .expect(s.activeSourceRunning and s.sourceExecutions == 1)

  run acceptedPublicationOutlivesDeadlineTest = init
    .then(toggleEnabled).then(toggleSharedLayer).then(startLeader)
    .then(cacheMissStartsFallback).then(sourceSucceedsBeforeDeadline)
    .then(advanceTime).then(advanceTime).then(advanceTime)
    .then(dispatchPublication)
    .expect(s.publicationDispatched and s.outcome == SourceSuccess)

  // C23: time spent reading the cache must not consume the source budget.
  run delayedLookupKeepsFullSourceBudgetTest = init
    .then(toggleEnabled).then(toggleSharedLayer).then(startLeader)
    .then(advanceTime).then(advanceTime)
    .then(cacheMissStartsFallback)
    .expect(s.fallbackStartedAt == 2 and s.fallbackDeadline == 5)
    .expect(fallbackDeadlineStartsWithFallback)
    .then(advanceTime).then(sourceSucceedsBeforeDeadline)
    .expect(s.outcome == SourceSuccess)

  run deadlineEpochMutationIsDetectedTest = init
    .then(toggleEnabled).then(toggleSharedLayer).then(startLeader)
    .then(advanceTime).then(advanceTime).then(cacheMissStartsFallback)
    .then(all { s' = { fallbackDeadline: FALLBACK_TIMEOUT, ...s } })
    .expect(not(fallbackDeadlineStartsWithFallback))

  run lateFollowerKeepsLeaderSourceDeadlineTest = init
    .then(toggleEnabled).then(toggleSharedLayer).then(startLeader)
    .then(cacheMissStartsFallback).then(advanceTime).then(advanceTime)
    .then(joinFollower)
    .expect(s.followers == 1 and s.sourceExecutions == 1
      and s.fallbackStartedAt == 0 and s.fallbackDeadline == 3)
    .then(advanceTime).then(fallbackTimesOut)
    .expect(s.outcome == SourceTimeout and s.flightScope == NoFlight)

  run inactiveServingLayersKeepConcurrentCallsIndependentTest = init
    .then(toggleEnabled).then(startIndependentCaller).then(startIndependentCaller)
    .expect(s.independentExecutions == 2 and s.flightScope == NoFlight)

  run coalescingDisabledKeepsConcurrentCallsIndependentTest = init
    .then(toggleEnabled).then(toggleSharedLayer).then(toggleCoalesce)
    .then(startIndependentCaller).then(startIndependentCaller)
    .expect(s.independentExecutions == 2 and s.flightScope == NoFlight)

  run sharedCacheHitDoesNotStartSourceTest = init
    .then(toggleEnabled).then(toggleSharedLayer).then(startLeader).then(joinFollower)
    .then(finishCacheHit)
    .expect(s.outcome == CacheHit and s.followers == 1
      and s.sourceExecutions == 0 and not(s.fallbackDeadlineStarted))

  run outsideCallsIgnoreConfiguredSourceDeadlineTest = init
    .then(toggleSharedLayer).then(startIndependentCaller).then(startIndependentCaller)
    .then(advanceTime).then(advanceTime).then(advanceTime).then(advanceTime)
    .then(settleIndependentSource).then(settleIndependentSource)
    .expect(s.independentExecutions == 2 and s.flightScope == NoFlight)
    .expect(s.independentSources.indices().forall(i =>
      s.independentSources.nth(i).outcome == SourceSuccess and s.independentSources.nth(i).budget == 0))

  run librarySourceDeadlineIsSixtySecondsTest = init.then(toggleEnabled)
    .then(s' = { configuredSourceBudget: OMITTED_FALLBACK_TIMEOUT, ...s })
    .then(startIndependentCaller)
    .expect(s.independentSources.nth(0).budget == 60000)
    .then(s' = { now: 60000, ...s }).then(settleIndependentSource)
    .expect(s.independentSources.nth(0).outcome == SourceTimeout)

  run explicitlyUnboundedEnabledSourceAcceptsLateValueTest = init.then(toggleEnabled)
    .then(s' = { configuredSourceBudget: NO_FALLBACK_TIMEOUT, ...s })
    .then(startIndependentCaller)
    .then(s' = { now: 60001, ...s }).then(settleIndependentSource)
    .expect(s.independentSources.nth(0).outcome == SourceSuccess
      and s.independentSources.nth(0).budget == 0)

  run keyFailureKeepsEnabledSourceDeadlineTest = init
    .then(toggleEnabled).then(toggleSharedLayer).then(toggleKeyFailure)
    .then(startIndependentCaller)
    .expect(s.flightScope == NoFlight and s.independentSources.nth(0).budget == 3)
    .then(advanceTime).then(advanceTime).then(advanceTime).then(settleIndependentSource)
    .expect(s.independentSources.nth(0).outcome == SourceTimeout)
}
