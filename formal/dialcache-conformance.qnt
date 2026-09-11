module dialcache_conformance {
  // Conformance-facing model for model-based testing. Unlike the verification
  // models, actions here map directly to public DialCache operations that a
  // language-specific driver can replay against a real implementation.
  // State: return values and counters are observed. The cached/readable flags
  // and stored source versions are predictions tested by subsequent calls.
  // Environment: source version changes, enabled/disabled calls, successful
  // publication/invalidation, and injected remote-read failures.
  // Bounds: one entity, distinct operation identities, sequential actions
  // except the explicitly paired calls; no expiry, skew, or delayed writes.

  // -- Initial values and state ---------------------------------------------

  pure val INITIAL_SOURCE_VERSION = 1
  pure val NO_RESULT = 0

  type State = {
    sourceVersion: int,
    lastResult: int,
    outsideLoaderCalls: int,
    requestLoaderCalls: int,
    localLoaderCalls: int,
    coalescedLoaderCalls: int,
    remoteLoaderCalls: int,
    localCached: bool,
    localValue: int,
    coalescedCached: bool,
    coalescedValue: int,
    remoteReadable: bool,
    remoteValue: int,
    redisReads: int,
    redisWrites: int
  }

  var s: State
  var input: { name: str, choice: int }

  action init = all {
    input' = { name: "init", choice: -1 },
    s' = {
      sourceVersion: INITIAL_SOURCE_VERSION,
      lastResult: NO_RESULT,
      outsideLoaderCalls: 0,
      requestLoaderCalls: 0,
      localLoaderCalls: 0,
      coalescedLoaderCalls: 0,
      remoteLoaderCalls: 0,
      localCached: false,
      localValue: NO_RESULT,
      coalescedCached: false,
      coalescedValue: NO_RESULT,
      remoteReadable: false,
      remoteValue: NO_RESULT,
      redisReads: 0,
      redisWrites: 0
    }
  }

  // -- External source changes and public calls ------------------------------

  // Changes the backing source without changing any cache state.
  action bumpSource = all {
    input' = { name: "bumpSource", choice: -1 },
    s' = { sourceVersion: s.sourceVersion + 1, ...s }
  }

  // Outside enable(), getOrLoad is true pass-through.
  action outsideCall = all {
    input' = { name: "outsideCall", choice: -1 },
    s' = {
      lastResult: s.sourceVersion,
      outsideLoaderCalls: s.outsideLoaderCalls + 1,
      ...s
    }
  }

  // Two same-key calls within one request-local scope share one source result.
  // Request-local state does not survive the operation boundary represented by
  // this action, so every action performs exactly one loader execution.
  action requestLocalPair = all {
    input' = { name: "requestLocalPair", choice: -1 },
    s' = {
      lastResult: s.sourceVersion,
      requestLoaderCalls: s.requestLoaderCalls + 1,
      ...s
    }
  }

  // Process-local cache survives across enabled invocations.
  action localCall = all {
    input' = { name: "localCall", choice: -1 },
    s' = if (s.localCached) {
      lastResult: s.localValue,
      ...s
    } else {
      lastResult: s.sourceVersion,
      localLoaderCalls: s.localLoaderCalls + 1,
      localCached: true,
      localValue: s.sourceVersion,
      ...s
    }
  }

  // Two concurrent same-key process-local calls create at most one source
  // execution and both observe the leader result.
  action coalescedLocalPair = all {
    input' = { name: "coalescedLocalPair", choice: -1 },
    s' = if (s.coalescedCached) {
      lastResult: s.coalescedValue,
      ...s
    } else {
      lastResult: s.sourceVersion,
      coalescedLoaderCalls: s.coalescedLoaderCalls + 1,
      coalescedCached: true,
      coalescedValue: s.sourceVersion,
      ...s
    }
  }

  // Tracked remote reads always perform one Redis observation. A semantic miss
  // loads and publishes; an accepted hit returns the stored source version.
  action remoteCall = all {
    input' = { name: "remoteCall", choice: -1 },
    s' = if (s.remoteReadable) {
      lastResult: s.remoteValue,
      redisReads: s.redisReads + 1,
      ...s
    } else {
      lastResult: s.sourceVersion,
      remoteLoaderCalls: s.remoteLoaderCalls + 1,
      remoteReadable: true,
      remoteValue: s.sourceVersion,
      redisReads: s.redisReads + 1,
      redisWrites: s.redisWrites + 1,
      ...s
    }
  }

  // Invalidation advances the shared fence. Existing bytes may remain in Redis
  // but are no longer readable through the tracked protocol.
  action invalidateRemote = all {
    input' = { name: "invalidateRemote", choice: -1 },
    s' = {
      remoteReadable: false,
      redisWrites: s.redisWrites + 1,
      ...s
    }
  }

  // A Redis read failure fails open to the source and suppresses refill. The
  // pre-existing remote value/fence state is unchanged.
  action remoteReadFailureCall = all {
    input' = { name: "remoteReadFailureCall", choice: -1 },
    s' = {
      lastResult: s.sourceVersion,
      remoteLoaderCalls: s.remoteLoaderCalls + 1,
      redisReads: s.redisReads + 1,
      ...s
    }
  }

  // -- Exploration schedule (order preserves sampling) -----------------------

  action step = any {
    bumpSource,
    outsideCall,
    requestLocalPair,
    localCall,
    coalescedLocalPair,
    remoteCall,
    invalidateRemote,
    remoteReadFailureCall,
  }

  // -- Independently stated safety properties --------------------------------

  val loaderCountsNonNegative = and {
    s.outsideLoaderCalls >= 0,
    s.requestLoaderCalls >= 0,
    s.localLoaderCalls >= 0,
    s.coalescedLoaderCalls >= 0,
    s.remoteLoaderCalls >= 0,
  }

  val redisCountsNonNegative =
    s.redisReads >= 0 and s.redisWrites >= 0

  val readableRemoteHasValue =
    not(s.remoteReadable) or s.remoteValue > 0
  // Public sequences keep the introductory behaviors executable in every port.
  run disabledAndRequestCallsKeepTheirOwnLifetimesTest = init
    .then(outsideCall).then(requestLocalPair).then(bumpSource)
    .then(outsideCall).then(requestLocalPair)
    .expect(s.lastResult == 2 and s.outsideLoaderCalls == 2 and s.requestLoaderCalls == 2
      and s.redisReads == 0 and s.redisWrites == 0)
  run localValueSurvivesSourceChangeTest = init.then(localCall).then(bumpSource).then(localCall)
    .expect(s.lastResult == 1 and s.localLoaderCalls == 1)
  run coalescedPairPublishesOneReusableValueTest = init
    .then(coalescedLocalPair).then(bumpSource).then(coalescedLocalPair)
    .expect(s.lastResult == 1 and s.coalescedLoaderCalls == 1)
  run invalidationRefillsFromCurrentSourceTest = init
    .then(remoteCall).then(bumpSource).then(remoteCall)
    .expect(s.lastResult == 1 and s.remoteLoaderCalls == 1)
    .then(invalidateRemote).then(remoteCall)
    .expect(s.lastResult == 2 and s.remoteLoaderCalls == 2 and s.redisReads == 3 and s.redisWrites == 3)
  run failedReadPreservesPreviouslyStoredBytesTest = init
    .then(remoteCall).then(bumpSource).then(remoteReadFailureCall)
    .expect(s.lastResult == 2 and s.remoteLoaderCalls == 2 and s.redisWrites == 1)
    .then(remoteCall)
    .expect(s.lastResult == 1 and s.remoteLoaderCalls == 2 and s.redisReads == 3 and s.redisWrites == 1)
}
