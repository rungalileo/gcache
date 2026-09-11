module dialcache_runtime_boundaries_conformance {
  import conformance_observations.* from "./conformance-observations"
  import cohort_boundaries.* from "./cohort-boundaries"

  // C06/C13/C16/C19: one key, one request lifetime and one initially selected layer.
  // Operation defaults either omit or disable coalescing. Runtime policy can inherit, disable,
  // or enable it independently of the serving cohort. Sources may overlap and
  // settle in either order; subsequent public calls observe retained values.
  // The all-features fixture permits only the full kill switch and restoration,
  // retaining its request memo. Thus its initial remote miss and subsequent
  // first-layer hits never admit shadow or recovery work. Other fixtures start
  // with one layer. A local-TTL overlay can add an earlier local layer to a
  // remote fixture; its retained value survives later remote-only overwrites.
  // Redis/codec work is healthy and immediate; no time advances.
  // The separate clock profile owns fractional expiry and instance clock grids.

  pure val REQUEST_LAYER = 0
  pure val LOCAL_LAYER = 1
  pure val REMOTE_LAYER = 2
  pure val INHERIT_SHARING = 0
  pure val DISABLE_SHARING = 1
  pure val ENABLE_SHARING = 2
  pure val FULL_COHORT = 3
  pure val DEFAULT_POLICY = 9
  pure val NULL_PROVIDER = 12
  pure val DISABLE_REQUEST = 13
  pure val INVALID_COALESCE = 14
  pure val INVALID_REQUEST_LOCAL = 15
  pure val NULL_COALESCE = 16
  pure val NULL_REQUEST_LOCAL = 17
  pure val DEFAULT_SHARING_FIXTURE_OFFSET = 3
  pure val NO_LOCAL_TTL_FIXTURE = 6
  pure val NO_REMOTE_TTL_FIXTURE = 7
  pure val DISABLED_BASELINE_FIXTURE = 8
  pure val RUNTIME_LOCAL_TTL = 18
  pure val RUNTIME_REMOTE_TTL = 19
  pure val RAMP_UP_DISABLED_BASELINE = 20
  pure val ALL_FEATURES_FIXTURE = 9
  pure val KILL_ALL_FEATURES = 21
  pure val EXTENDED_RETENTION_MS = 120000
  pure val VALUE_UNDEFINED_STRING = 11
  pure val SOURCE_VALUES = List(VALUE_ONE, VALUE_TWO, VALUE_ABSENT, VALUE_UNDEFINED_STRING, VALUE_NULL, VALUE_FALSE, VALUE_ZERO, VALUE_EMPTY_STRING)
  pure val MAX_CALLERS = 8
  pure val NO_OWNER = -1
  pure val EMPTY_CACHE = 0
  pure val TTL_MS = 60000

  // Fixed W03 fixture: untracked urn:id:1#Behavior, no arguments.
  // The independent uint32 samples bind the strict admission rule to exact
  // public percentage inputs, without consulting either implementation hash.
  pure val LOCAL_SAMPLE = 4292886220
  pure val REMOTE_SAMPLE = 1018911151

  type Source = { caches: bool, localCaches: bool, shared: bool, result: int }
  type Admission = {
    open: bool, policy: int, joined: bool, remoteReads: int, cacheHit: bool, localHit: bool
  }
  type State = {
    o: Observation,
    layer: int,
    defaultSharing: bool,
    configured: bool,
    disabledBaseline: bool,
    allFeatures: bool,
    open: bool,
    policy: int,
    waitingPolicy: int,
    cached: int,
    localCached: int,
    registered: int,
    owners: List[int],
    sources: List[Source],
    settlements: List[int],
    admissions: List[Admission]
  }
  var s: State
  var input: { name: str, choice: int }

  pure def sample(layer: int): int = if (layer == LOCAL_LAYER) LOCAL_SAMPLE else REMOTE_SAMPLE
  pure def cohortRelation(policy: int): int = if (policy >= NULL_PROVIDER) FULL_COHORT else policy / 3
  pure def sharingMode(policy: int): int = if (policy >= NULL_PROVIDER) INHERIT_SHARING else policy % 3
  pure def cohortThreshold(layer: int, policy: int): int =
    if (cohortRelation(policy) == FULL_COHORT) COHORT_DENOMINATOR
    else thresholdForRelation(sample(layer), cohortRelation(policy))
  pure def layerConfigured(state: State): bool = state.configured
    or (state.layer == LOCAL_LAYER and Set(RUNTIME_LOCAL_TTL, RAMP_UP_DISABLED_BASELINE).contains(state.policy))
    or (state.layer == REMOTE_LAYER and state.policy == RUNTIME_REMOTE_TTL)
  pure def participates(state: State): bool = state.open and state.policy != KILL_ALL_FEATURES
    and not(Set(INVALID_COALESCE, INVALID_REQUEST_LOCAL, NULL_COALESCE, NULL_REQUEST_LOCAL).contains(state.policy))
    and layerConfigured(state)
    and (not(state.disabledBaseline) or state.policy == RAMP_UP_DISABLED_BASELINE)
    and (if (state.layer == REQUEST_LAYER) state.policy != DISABLE_REQUEST
      else cohortAdmits(sample(state.layer), cohortThreshold(state.layer, state.policy)))
  pure def shares(state: State): bool = sharingMode(state.policy) == ENABLE_SHARING
    or (sharingMode(state.policy) == INHERIT_SHARING and state.defaultSharing)
  // Local storage exists even on an instance initially configured only for
  // Redis. Supplying its TTL admits it at the default full ramp. A remote TTL
  // cannot similarly add Redis when the fixture has no Redis client.
  pure def extraLocalParticipates(state: State): bool = state.open and state.layer == REMOTE_LAYER
    and Set(RUNTIME_LOCAL_TTL, RAMP_UP_DISABLED_BASELINE).contains(state.policy)

  action initialize(fixture: int): bool = all {
    s' = {
      o: empty,
      layer: if (fixture == ALL_FEATURES_FIXTURE) REQUEST_LAYER
        else if (fixture < NO_LOCAL_TTL_FIXTURE) fixture % DEFAULT_SHARING_FIXTURE_OFFSET
        else if (fixture == NO_REMOTE_TTL_FIXTURE) REMOTE_LAYER else LOCAL_LAYER,
      defaultSharing: fixture >= DEFAULT_SHARING_FIXTURE_OFFSET,
      configured: fixture < NO_LOCAL_TTL_FIXTURE or fixture == ALL_FEATURES_FIXTURE,
      disabledBaseline: fixture == DISABLED_BASELINE_FIXTURE,
      allFeatures: fixture == ALL_FEATURES_FIXTURE,
      open: true,
      policy: DEFAULT_POLICY,
      waitingPolicy: NO_OWNER,
      cached: EMPTY_CACHE,
      localCached: EMPTY_CACHE,
      registered: NO_OWNER,
      owners: List(),
      sources: List(),
      settlements: List(),
      admissions: List()
    },
    input' = { name: "init", choice: fixture }
  }
  action init = {
    nondet choice = REQUEST_LAYER.to(ALL_FEATURES_FIXTURE).oneOf()
    initialize(choice)
  }

  pure def startSource(state: State, caller: int, caches: bool, localCaches: bool, shared: bool): State = {
    sources: state.sources.append({ caches: caches, localCaches: localCaches, shared: shared, result: CALL_PENDING }),
    owners: state.owners.replaceAt(caller, state.sources.length()),
    registered: if (shared) state.sources.length() else state.registered,
    o: { loaders: state.o.loaders + 1, ...state.o },
    ...state
  }
  action beginCall = all {
    s.waitingPolicy == NO_OWNER,
    s.o.calls.length() < MAX_CALLERS,
    val admitted = {
      owners: s.owners.append(NO_OWNER),
      waitingPolicy: if (s.open) s.o.calls.length() else NO_OWNER,
      o: {
        calls: s.o.calls.append(CALL_PENDING),
        policyCalls: s.o.policyCalls + (if (s.open) 1 else 0),
        ...s.o
      },
      ...s
    }
    s' = if (s.open) admitted else startSource(admitted, s.o.calls.length(), false, false, false),
    input' = { name: "beginCall", choice: -1 }
  }
  action releasePolicy = all {
    s.waitingPolicy >= 0,
    val primaryActive = participates(s)
    val localActive = extraLocalParticipates(s)
    val active = primaryActive or localActive
    val shared = active and shares(s)
    val joined = shared and s.registered >= 0
    val localHit = not(joined) and localActive and s.localCached != EMPTY_CACHE
    val hit = localHit or (not(joined) and primaryActive and s.cached != EMPTY_CACHE)
    val returned = if (localHit) s.localCached else s.cached
    val reads = if (not(joined) and not(localHit) and primaryActive
      and (s.layer == REMOTE_LAYER or (s.allFeatures and not(hit)))) 1 else 0
    val afterRead = {
      waitingPolicy: NO_OWNER,
      // A remote hit fills the newly active local layer with the acquired
      // value. Later remote writes cannot change this process-local snapshot.
      localCached: if (localActive and hit and not(localHit)) returned else s.localCached,
      admissions: s.admissions.append({
        open: s.open, policy: s.policy, joined: joined, remoteReads: reads, cacheHit: hit, localHit: localHit
      }),
      o: { reads: s.o.reads + reads, loads: s.o.loads + (if (hit and reads == 1) 1 else 0), ...s.o },
      ...s
    }
    s' = if (joined) { owners: s.owners.replaceAt(s.waitingPolicy, s.registered), ...afterRead }
      else if (hit) { o: { calls: s.o.calls.replaceAt(s.waitingPolicy, returned), ...afterRead.o }, ...afterRead }
      else startSource(afterRead, s.waitingPolicy, primaryActive, localActive, shared),
    input' = { name: "releasePolicy", choice: -1 }
  }

  action changePolicy(policy: int): bool = all {
    s' = { policy: policy, ...s },
    input' = { name: "policy", choice: policy }
  }
  action policy = {
    nondet choice = 0.to(KILL_ALL_FEATURES)
      .filter(code => not(s.allFeatures) or Set(DEFAULT_POLICY, KILL_ALL_FEATURES).contains(code)).oneOf()
    changePolicy(choice)
  }
  action closeScope = all {
    s.layer == REQUEST_LAYER,
    not(s.allFeatures),
    s.open,
    s' = { open: false, cached: EMPTY_CACHE, registered: NO_OWNER, ...s },
    input' = { name: "closeScope", choice: -1 }
  }
  action finishSource(loader: int, valueIndex: int): bool = all {
    val source = s.sources.nth(loader)
    val value = SOURCE_VALUES.nth(valueIndex)
    val publish = source.caches and (s.layer != REQUEST_LAYER or s.open)
    val writes = publish and (s.layer == REMOTE_LAYER or s.allFeatures)
    s' = {
      cached: if (publish) value else s.cached,
      localCached: if (source.localCaches) value else s.localCached,
      registered: if (s.registered == loader) NO_OWNER else s.registered,
      sources: s.sources.replaceAt(loader, { result: value, ...source }),
      settlements: s.settlements.append(loader),
      o: {
        calls: finishOwnedCalls(s.o.calls, s.owners, loader, value),
        writes: s.o.writes + (if (writes) 1 else 0),
        dumps: s.o.dumps + (if (writes) 1 else 0),
        writeTtls: if (writes) s.o.writeTtls.append(if (s.allFeatures) EXTENDED_RETENTION_MS else TTL_MS) else s.o.writeTtls,
        ...s.o
      },
      ...s
    },
    input' = { name: "resolveLoader", choice: loader * SOURCE_VALUES.length() + valueIndex }
  }
  action resolveLoader = {
    nondet choice = 0.to(MAX_CALLERS * SOURCE_VALUES.length() - 1)
      .filter(code => code / SOURCE_VALUES.length() < s.sources.length()
        and s.sources.nth(code / SOURCE_VALUES.length()).result == CALL_PENDING).oneOf()
    finishSource(choice / SOURCE_VALUES.length(), choice % SOURCE_VALUES.length())
  }
  action step = any { beginCall, releasePolicy, resolveLoader, policy, closeScope }

  // These checks spell out the boundary independently of cohortAdmits/shares.
  val equalAndLowerCohortsNeverTraverse = s.admissions.indices().forall(index => {
    val admitted = s.admissions.nth(index)
    s.layer == REQUEST_LAYER or admitted.policy >= NULL_PROVIDER or admitted.policy / 3 > AT_SAMPLE or
      (not(admitted.joined) and admitted.remoteReads == 0 and not(admitted.cacheHit))
  })
  val inheritedDisabledSharingNeverJoins = s.admissions.indices().forall(index => {
    val admitted = s.admissions.nth(index)
    (admitted.policy < NULL_PROVIDER and admitted.policy % 3 == ENABLE_SHARING)
      or (s.defaultSharing and (admitted.policy >= NULL_PROVIDER or admitted.policy % 3 == INHERIT_SHARING))
      or not(admitted.joined)
  })
  val invalidBooleanLeavesBypassAllCaching = s.admissions.indices().forall(index => {
    val admitted = s.admissions.nth(index)
    admitted.policy < INVALID_COALESCE or admitted.policy > NULL_REQUEST_LOCAL or
      (not(admitted.joined) and admitted.remoteReads == 0 and not(admitted.cacheHit))
  })
  val callersKeepTheirSourceValue = s.owners.indices().forall(caller =>
    s.owners.nth(caller) < 0 or s.o.calls.nth(caller) == s.sources.nth(s.owners.nth(caller)).result)
  val retainedValueFollowsSettlementOrder = {
    val lastPublished = s.settlements.foldl(EMPTY_CACHE, (value, loader) =>
      if (s.sources.nth(loader).caches) s.sources.nth(loader).result else value)
    (s.layer == REQUEST_LAYER and not(s.open)) or s.cached == lastPublished
  }
  val earlierLocalHitStopsRemoteTraversal = s.admissions.indices().forall(index => {
    val admitted = s.admissions.nth(index)
    admitted.localHit implies (admitted.cacheHit and not(admitted.joined) and admitted.remoteReads == 0)
  })

  run runtimeLocalTtlAddsEarlierLayerToRemoteFixtureTest = initialize(REMOTE_LAYER)
    .then(changePolicy(RUNTIME_LOCAL_TTL))
    .then(beginCall).then(releasePolicy).then(beginCall)
    .then(finishSource(0, 7)).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_EMPTY_STRING, VALUE_EMPTY_STRING)
      and s.o.loaders == 1 and s.o.reads == 1 and s.o.loads == 0 and s.o.writes == 1)

  run runtimeLocalTtlEnablesSharingWithoutRemoteTtlTest = initialize(NO_REMOTE_TTL_FIXTURE)
    .then(changePolicy(RAMP_UP_DISABLED_BASELINE))
    .then(beginCall).then(releasePolicy)
    .then(changePolicy(RUNTIME_LOCAL_TTL))
    .then(beginCall).then(releasePolicy)
    .expect(s.o.loaders == 1 and s.o.calls == List(CALL_PENDING, CALL_PENDING))
    .then(finishSource(0, 2)).then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ABSENT, VALUE_ABSENT, VALUE_ABSENT)
      and s.o.reads == 0 and s.o.writes == 0 and s.o.loaders == 1)

  run remoteHitPromotesIntoNewlyEnabledLocalLayerTest = initialize(REMOTE_LAYER)
    .then(beginCall).then(releasePolicy).then(beginCall).then(releasePolicy)
    .then(finishSource(0, 0)).then(changePolicy(RUNTIME_LOCAL_TTL))
    .then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, CALL_PENDING, VALUE_ONE) and s.o.loads == 1)
    .then(finishSource(1, 1)).then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE, VALUE_ONE) and s.o.reads == 3)
    .then(changePolicy(DEFAULT_POLICY)).then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE, VALUE_ONE, VALUE_TWO)
      and s.o.reads == 4 and s.o.loads == 2 and s.o.writes == 2)

  run runtimeTrueEnablesSharingOverFalseDefaultTest = initialize(REQUEST_LAYER)
    .then(changePolicy(FULL_COHORT * 3 + ENABLE_SHARING))
    .then(beginCall).then(releasePolicy)
    .then(beginCall).then(releasePolicy)
    .expect(s.o.loaders == 1 and s.o.calls == List(CALL_PENDING, CALL_PENDING))
    .then(finishSource(0, 0))
    .then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE) and s.o.loaders == 1)

  run inheritedFalseKeepsIndependentMemoizingSourcesTest = initialize(REQUEST_LAYER)
    .then(beginCall).then(releasePolicy)
    .then(beginCall).then(releasePolicy)
    .then(finishSource(1, 1)).then(finishSource(0, 0))
    .then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE) and s.o.loaders == 2)

  run localCohortEqualityBypassesBeforeAboveSampleCachesTest = initialize(LOCAL_LAYER)
    .then(changePolicy(AT_SAMPLE * 3 + ENABLE_SHARING))
    .then(beginCall).then(releasePolicy).then(finishSource(0, 0))
    .then(changePolicy(ABOVE_SAMPLE * 3 + ENABLE_SHARING))
    .then(beginCall).then(releasePolicy).then(finishSource(1, 1))
    .then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_TWO) and s.o.loaders == 2)

  run remoteCohortEqualityBypassesBeforeAboveSampleCachesTest = initialize(REMOTE_LAYER)
    .then(changePolicy(AT_SAMPLE * 3 + ENABLE_SHARING))
    .then(beginCall).then(releasePolicy).then(finishSource(0, 0))
    .then(changePolicy(ABOVE_SAMPLE * 3 + ENABLE_SHARING))
    .then(beginCall).then(releasePolicy).then(finishSource(1, 1))
    .then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_TWO) and s.o.loaders == 2
      and s.o.reads == 2 and s.o.writes == 1 and s.o.loads == 1)

  run requestAbsenceAndLiteralTextStayDistinctTest = initialize(REQUEST_LAYER)
    .then(beginCall).then(releasePolicy).then(beginCall).then(releasePolicy)
    .then(finishSource(0, 2)).then(finishSource(1, 3))
    .then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ABSENT, VALUE_UNDEFINED_STRING, VALUE_UNDEFINED_STRING)
      and s.o.loaders == 2)

  run localAbsenceAndLiteralTextStayDistinctTest = initialize(LOCAL_LAYER)
    .then(beginCall).then(releasePolicy).then(beginCall).then(releasePolicy)
    .then(finishSource(0, 3)).then(finishSource(1, 2))
    .then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_UNDEFINED_STRING, VALUE_ABSENT, VALUE_ABSENT)
      and s.o.loaders == 2)

  run remoteAbsenceAndLiteralTextStayDistinctTest = initialize(REMOTE_LAYER)
    .then(beginCall).then(releasePolicy).then(beginCall).then(releasePolicy)
    .then(finishSource(0, 2)).then(finishSource(1, 3))
    .then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ABSENT, VALUE_UNDEFINED_STRING, VALUE_UNDEFINED_STRING)
      and s.o.loaders == 2 and s.o.loads == 1 and s.o.writes == 2)

  run requestFalsyValuesRemainDistinctAndReusableTest = initialize(REQUEST_LAYER)
    .then(beginCall).then(releasePolicy).then(beginCall).then(releasePolicy)
    .then(beginCall).then(releasePolicy).then(beginCall).then(releasePolicy)
    .then(finishSource(0, 4)).then(beginCall).then(releasePolicy)
    .then(finishSource(1, 5)).then(beginCall).then(releasePolicy)
    .then(finishSource(2, 6)).then(beginCall).then(releasePolicy)
    .then(finishSource(3, 7)).then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_NULL, VALUE_FALSE, VALUE_ZERO, VALUE_EMPTY_STRING,
      VALUE_NULL, VALUE_FALSE, VALUE_ZERO, VALUE_EMPTY_STRING) and s.o.loaders == 4)

  run localFalsyValuesRemainDistinctAndReusableTest = initialize(LOCAL_LAYER)
    .then(beginCall).then(releasePolicy).then(beginCall).then(releasePolicy)
    .then(beginCall).then(releasePolicy).then(beginCall).then(releasePolicy)
    .then(finishSource(0, 4)).then(beginCall).then(releasePolicy)
    .then(finishSource(1, 5)).then(beginCall).then(releasePolicy)
    .then(finishSource(2, 6)).then(beginCall).then(releasePolicy)
    .then(finishSource(3, 7)).then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_NULL, VALUE_FALSE, VALUE_ZERO, VALUE_EMPTY_STRING,
      VALUE_NULL, VALUE_FALSE, VALUE_ZERO, VALUE_EMPTY_STRING) and s.o.loaders == 4)

  run remoteFalsyValuesRemainDistinctAndReusableTest = initialize(REMOTE_LAYER)
    .then(beginCall).then(releasePolicy).then(beginCall).then(releasePolicy)
    .then(beginCall).then(releasePolicy).then(beginCall).then(releasePolicy)
    .then(finishSource(0, 4)).then(beginCall).then(releasePolicy)
    .then(finishSource(1, 5)).then(beginCall).then(releasePolicy)
    .then(finishSource(2, 6)).then(beginCall).then(releasePolicy)
    .then(finishSource(3, 7)).then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_NULL, VALUE_FALSE, VALUE_ZERO, VALUE_EMPTY_STRING,
      VALUE_NULL, VALUE_FALSE, VALUE_ZERO, VALUE_EMPTY_STRING) and s.o.loaders == 4)

  run nullProviderInheritsConfiguredServingAndDefaultSharingTest = initialize(DEFAULT_SHARING_FIXTURE_OFFSET + REMOTE_LAYER)
    .then(changePolicy(NULL_PROVIDER))
    .then(beginCall).then(releasePolicy).then(beginCall).then(releasePolicy)
    .then(finishSource(0, 0)).then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE) and s.o.loaders == 1
      and s.o.reads == 2 and s.o.loads == 1 and s.o.writeTtls == List(TTL_MS))

  run omittedRampAndSharingUseLibraryDefaultsTest = initialize(DEFAULT_SHARING_FIXTURE_OFFSET + REMOTE_LAYER)
    .then(beginCall).then(releasePolicy).then(beginCall).then(releasePolicy)
    .then(finishSource(0, 0)).then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE) and s.o.loaders == 1
      and s.o.reads == 2 and s.o.loads == 1 and s.o.writeTtls == List(TTL_MS)
      and s.o.shadow == List() and s.o.recovery == List())

  run reenablingSharingUsesTheOmittedTrueDefaultTest = initialize(DEFAULT_SHARING_FIXTURE_OFFSET + REQUEST_LAYER)
    .then(changePolicy(FULL_COHORT * 3 + DISABLE_SHARING))
    .then(beginCall).then(releasePolicy)
    .then(changePolicy(DEFAULT_POLICY))
    .then(beginCall).then(releasePolicy).then(beginCall).then(releasePolicy)
    .expect(s.o.loaders == 2)
    .then(finishSource(1, 1)).then(finishSource(0, 0))
    .then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_TWO, VALUE_ONE) and s.o.loaders == 2)

  run falseRequestLeafPreservesMemoForReenablementTest = initialize(DEFAULT_SHARING_FIXTURE_OFFSET + REQUEST_LAYER)
    .then(beginCall).then(releasePolicy).then(finishSource(0, 0))
    .then(changePolicy(DISABLE_REQUEST))
    .then(beginCall).then(releasePolicy).then(finishSource(1, 1))
    .then(changePolicy(DEFAULT_POLICY)).then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE) and s.o.loaders == 2)

  run invalidCoalesceBypassesWithoutReplacingRemoteTest = initialize(DEFAULT_SHARING_FIXTURE_OFFSET + REMOTE_LAYER)
    .then(beginCall).then(releasePolicy).then(finishSource(0, 0))
    .then(changePolicy(INVALID_COALESCE))
    .then(beginCall).then(releasePolicy).then(finishSource(1, 1))
    .then(changePolicy(DEFAULT_POLICY)).then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE) and s.o.loaders == 2
      and s.o.reads == 2 and s.o.writes == 1 and s.o.loads == 1)

  run invalidRequestLocalBypassesWithoutReplacingRemoteTest = initialize(DEFAULT_SHARING_FIXTURE_OFFSET + REMOTE_LAYER)
    .then(beginCall).then(releasePolicy).then(finishSource(0, 0))
    .then(changePolicy(INVALID_REQUEST_LOCAL))
    .then(beginCall).then(releasePolicy).then(finishSource(1, 1))
    .then(changePolicy(DEFAULT_POLICY)).then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE) and s.o.loaders == 2
      and s.o.reads == 2 and s.o.writes == 1 and s.o.loads == 1)

  run explicitNullCoalesceBypassesWithoutReplacingRemoteTest = initialize(DEFAULT_SHARING_FIXTURE_OFFSET + REMOTE_LAYER)
    .then(beginCall).then(releasePolicy).then(finishSource(0, 0))
    .then(changePolicy(NULL_COALESCE))
    .then(beginCall).then(releasePolicy).then(finishSource(1, 1))
    .then(changePolicy(DEFAULT_POLICY)).then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE) and s.o.loaders == 2
      and s.o.reads == 2 and s.o.writes == 1 and s.o.loads == 1)

  run explicitNullRequestLocalBypassesWithoutReplacingRemoteTest = initialize(DEFAULT_SHARING_FIXTURE_OFFSET + REMOTE_LAYER)
    .then(beginCall).then(releasePolicy).then(finishSource(0, 0))
    .then(changePolicy(NULL_REQUEST_LOCAL))
    .then(beginCall).then(releasePolicy).then(finishSource(1, 1))
    .then(changePolicy(DEFAULT_POLICY)).then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE) and s.o.loaders == 2
      and s.o.reads == 2 and s.o.writes == 1 and s.o.loads == 1)

  run runtimeLocalTtlWithoutRampActivatesLayerTest = initialize(NO_LOCAL_TTL_FIXTURE)
    .then(beginCall).then(releasePolicy).then(finishSource(0, 0))
    .then(changePolicy(RUNTIME_LOCAL_TTL))
    .then(beginCall).then(releasePolicy).then(finishSource(1, 1))
    .then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_TWO) and s.o.loaders == 2
      and s.o.reads == 0 and s.o.writes == 0)

  run runtimeRemoteTtlWithoutRampActivatesLayerTest = initialize(NO_REMOTE_TTL_FIXTURE)
    .then(beginCall).then(releasePolicy).then(finishSource(0, 0))
    .then(changePolicy(RUNTIME_REMOTE_TTL))
    .then(beginCall).then(releasePolicy).then(finishSource(1, 1))
    .then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_TWO) and s.o.loaders == 2
      and s.o.reads == 2 and s.o.loads == 1 and s.o.writeTtls == List(TTL_MS))

  run disabledBaselineRampedUpKeepsDefaultSharingTest = initialize(DISABLED_BASELINE_FIXTURE)
    .then(beginCall).then(releasePolicy).then(finishSource(0, 0))
    .then(changePolicy(RAMP_UP_DISABLED_BASELINE))
    .then(beginCall).then(releasePolicy).then(beginCall).then(releasePolicy)
    .expect(s.o.loaders == 2)
    .then(finishSource(1, 1)).then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_TWO, VALUE_TWO) and s.o.loaders == 2)

  run fullFeatureKillSwitchKeepsOmittedSharingAndRetainedMemoTest = initialize(ALL_FEATURES_FIXTURE)
    .then(beginCall).then(releasePolicy).then(beginCall).then(releasePolicy)
    .expect(s.o.loaders == 1 and s.o.reads == 1)
    .then(finishSource(0, 0))
    .then(changePolicy(KILL_ALL_FEATURES))
    .then(beginCall).then(releasePolicy).then(beginCall).then(releasePolicy)
    .expect(s.o.loaders == 3 and s.o.reads == 1)
    .then(finishSource(1, 1)).then(finishSource(2, 3))
    .then(changePolicy(DEFAULT_POLICY)).then(beginCall).then(releasePolicy)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_TWO, VALUE_UNDEFINED_STRING, VALUE_ONE)
      and s.o.loaders == 3 and s.o.reads == 1 and s.o.writes == 1
      and s.o.writeTtls == List(EXTENDED_RETENTION_MS)
      and s.o.shadow == List() and s.o.recovery == List())
}
