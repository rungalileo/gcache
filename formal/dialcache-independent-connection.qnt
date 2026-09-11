module dialcache_independent_connection {
  import dialcache_independent_conformance as profile from "./dialcache-independent-conformance"
  import conformance_observations.* from "./conformance-observations"
  import cache_contract.* from "./cache-contract"

  // Each independent caller owns its admission policy and later read snapshot.
  // The real profile executes; this projection captures external acquisition
  // fields separately and checks returned values, including reversed completion.
  var snapshots: List[RecoverySnapshot]
  var sources: List[SourceExecution]
  var before: {
    frame: int, created: int, maximum: int, wall: int, now: int,
    calls: int, sourceCount: int, reads: List[profile::Read],
    loads: List[profile::Load], timers: List[profile::Timer]
  }
  action init = all {
    profile::init,
    snapshots' = List(),
    sources' = List(),
    before' = { frame: 0, created: 0, maximum: 0, wall: 0, now: 0,
      calls: 0, sourceCount: 0, reads: List(), loads: List(), timers: List() }
  }
  val admitted = if (profile::s.calls.length() > snapshots.length())
    snapshots.append(captureRecovery(before.calls, 0, 0, before.maximum, 0)) else snapshots
  val acquired = if (profile::input.name == "releaseRead" or profile::input.name == "failRead") {
    val read = before.reads.nth(profile::input.choice)
    if (read.active) admitted.replaceAt(read.caller, captureRecovery(read.caller,
      before.frame, before.created, admitted.nth(read.caller).maximum, before.wall)) else admitted
  } else admitted

  // One reference slot per caller; -1 means its source has not started. Read
  // settlement and fresh-decode failure start at the preceding process clock.
  // Advancing time can start several sources: each starts at its owned read
  // deadline, even when the external advance ends much later. These origins
  // never come from the source's predicted startedAt/caller or source timer.
  val sourceSlots = if (profile::s.calls.length() > sources.length())
    sources.append(captureSource(before.calls, -1, profile::SOURCE_BUDGET_MS)) else sources
  val observedSources = if (profile::input.name == "advance") {
    before.timers.foldl(sourceSlots, (references, timer) =>
      if (timer.read and before.reads.nth(timer.index).active and
        timer.at > before.now and timer.at <= before.now + profile::input.choice) {
        val owner = before.reads.nth(timer.index).caller
        references.replaceAt(owner, captureSource(owner, timer.at, profile::SOURCE_BUDGET_MS))
      } else references)
  } else if (profile::s.sources.length() > before.sourceCount) {
    val owner = if (profile::input.name == "failLoad") before.loads.nth(profile::input.choice).caller
      else before.reads.nth(profile::input.choice).caller
    sourceSlots.replaceAt(owner, captureSource(owner, before.now, profile::SOURCE_BUDGET_MS))
  } else sourceSlots

  action step = all {
    snapshots' = acquired,
    sources' = observedSources,
    before' = { frame: profile::s.frame, created: profile::s.created, maximum: profile::s.maxAge,
      wall: profile::s.wall, now: profile::s.now, calls: profile::s.calls.length(),
      sourceCount: profile::s.sources.length(), reads: profile::s.reads, loads: profile::s.loads,
      timers: profile::s.timers },
    profile::step
  }
  val independentSnapshotsMatchAcquisition = acquired.length() == profile::s.calls.length() and
    acquired.indices().forall(owner => {
      val reference = acquired.nth(owner)
      val call = profile::s.calls.nth(owner)
      call.maxAge == reference.maximum and (call.candidate == 0 or
        (reference.owner == owner and call.candidate == reference.payload and
          call.created == reference.created and call.acquiredAt == reference.acquiredAt))
    })
  val independentRecoveryMatchesContract = profile::input.name != "releaseLoad" or {
    val load = before.loads.nth(profile::input.choice)
    not(load.recovery) or profile::s.o.recovery.nth(profile::s.o.recovery.length() - 1) != "served" or
      recoveryReturnAllowed(snapshots.nth(load.caller), load.caller,
        profile::s.o.calls.nth(load.caller), before.wall)
  }
  val independentSourceOriginsMatchContract =
    observedSources.select(source => source.started >= 0).length() == profile::s.sources.length() and
    profile::s.sources.indices().forall(index => {
      val source = profile::s.sources.nth(index)
      val reference = observedSources.nth(source.caller)
      reference.started >= 0 and reference.owner == source.caller and
        profile::s.calls.nth(reference.owner).source == index and source.startedAt == reference.started
    })

  // Both the source timer and accepted settlement must agree with the origin
  // captured from external events, never with another caller's source.
  val independentSourceMatchesTimerContract = profile::s.sources.indices().forall(index => {
    val source = profile::s.sources.nth(index)
    val reference = observedSources.nth(source.caller)
    val timers = profile::s.timers.select(timer => not(timer.read) and timer.index == index)
    timers.length() == 1 and timers.nth(0).at == reference.started + reference.budget and
      (source.outcome == CALL_PENDING or source.outcome == DEADLINE_ERROR or
        sourceReturnAllowed(reference, source.caller, source.settledAt))
  })
}
