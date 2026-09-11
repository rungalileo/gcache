module dialcache_effects_connection {
  import dialcache_effects_conformance as profile from "./dialcache-effects-conformance"
  import cache_contract.* from "./cache-contract"

  // Source starts are observed independently from the profile's shared deadline
  // field. Read timeout starts a source at the end of tick; other source starts
  // occur at the preceding clock. Settlement receipts come from the external
  // resolve/reject input and preceding clock, not acceptedAt. Pending publication
  // and new dump/write effects require that exact source's timely success.
  // Application-owned serialization may finish after the source deadline.
  // This checks source timing/ownership, not payload provenance or refill fences.
  type Settlement = { source: int, at: int, succeeded: bool }
  var sources: List[SourceExecution]
  var settlements: List[Settlement]
  var before: { now: int, dumps: int, writes: int }
  action init = all {
    profile::init,
    sources' = List(),
    settlements' = List(),
    before' = { now: 0, dumps: 0, writes: 0 }
  }
  val observedSources = if (profile::s.loaders > sources.length())
    sources.append(captureSource(profile::s.activeLoader,
      if (profile::input.name == "tick") before.now + profile::CLOCK_STEP_MS else before.now,
      profile::SOURCE_BUDGET_MS)) else sources
  val observedSettlements = if (profile::input.name == "resolveLoader" or profile::input.name == "rejectLoader")
    settlements.append({ source: profile::input.choice, at: before.now,
      succeeded: profile::input.name == "resolveLoader" }) else settlements
  action step = all {
    sources' = observedSources,
    settlements' = observedSettlements,
    before' = { now: profile::s.now, dumps: profile::s.dumps, writes: profile::s.writes },
    profile::step
  }
  val effectsDeadlineMatchesSourceStart = profile::s.phase != profile::SOURCE_RUNNING or
    profile::s.deadline == observedSources.nth(profile::s.activeLoader).started + profile::SOURCE_BUDGET_MS
  val effectsPublicationMatchesAcceptedSource = {
    val publishes = profile::s.phase == profile::SERIALIZE_PENDING or profile::s.phase == profile::WRITE_PENDING or
      profile::s.dumps > before.dumps or profile::s.writes > before.writes
    not(publishes) or {
      val receipts = observedSettlements.select(receipt => receipt.source == profile::s.activeLoader)
      receipts.length() == 1 and {
        val receipt = receipts.nth(0)
        receipt.succeeded and profile::s.acceptedAt == receipt.at and
          sourceReturnAllowed(observedSources.nth(receipt.source), receipt.source, receipt.at)
      }
    }
  }
}
