module dialcache_source_connection {
  import dialcache_source_budgets_conformance as profile from "./dialcache-source-budgets-conformance"
  import conformance_observations.* from "./conformance-observations"
  import cache_contract.* from "./cache-contract"

  // The actual source-budgets transitions are the only executing machine.
  // Project each source-start event into an immutable reference record using
  // the preceding external clock and call/policy ownership, not the profile's
  // source.started or source.budget fields. This checks that their abstraction
  // preserves source-relative time, owners and accepted outcomes on each step.
  var sources: List[SourceExecution]
  var before: { now: int, calls: int, policies: List[int], registered: int, mode: int }

  action init = all {
    profile::init,
    sources' = List(),
    before' = { now: 0, calls: 0, policies: List(), registered: -1, mode: 0 }
  }

  val startedOwner = if (profile::input.name == "releasePolicy")
    before.policies.nth(profile::input.choice) else before.calls
  val startedOutside = profile::input.name == "beginCall" and
    (profile::input.choice == profile::OUTSIDE or profile::input.choice == profile::OUTSIDE_INVALID_KEY)
  val observedSources = if (profile::s.o.loaders > sources.length())
    sources.append(captureSource(startedOwner, before.now,
      if (startedOutside) -1 else profile::configuredBudget(before.mode))) else sources

  action step = all {
    sources' = observedSources,
    before' = { now: profile::s.now, calls: profile::s.o.calls.length(),
      policies: profile::s.policyOwners, registered: profile::s.registered, mode: profile::s.mode },
    profile::step
  }

  val sourceOriginsMatchContract = observedSources.length() == profile::s.sources.length() and
    observedSources.indices().forall(index => {
      val reference = observedSources.nth(index)
      val actual = profile::s.sources.nth(index)
      actual.started == reference.started and actual.budget == reference.budget
    })
  val sourceOwnersMatchContract = observedSources.indices().forall(index => {
    val reference = observedSources.nth(index)
    profile::s.owners.nth(reference.owner) == index
  })
  val acceptedSourcesMatchContract = observedSources.indices().forall(index => {
    val actual = profile::s.sources.nth(index)
    val reference = observedSources.nth(index)
    actual.result != VALUE_ONE and actual.result != VALUE_TWO or
      sourceReturnAllowed(reference, reference.owner, actual.settled)
  })
  val followerKeepsAcquiredOwner = profile::input.name != "releasePolicy" or before.registered < 0 or
    profile::s.owners.nth(before.policies.nth(profile::input.choice)) == before.registered
}
