module dialcache_legacy_recovery_connection {
  import dialcache_recovery_conformance as profile from "./dialcache-recovery-conformance"
  import conformance_observations.* from "./conformance-observations"
  import cache_contract.* from "./cache-contract"

  // The legacy recovery profile acquires its read in beginCall. Project that
  // acquisition into a flight-owned snapshot; joined callers share its result.
  // Capture storage and policy from before the read, never candidate fields.
  var snapshot: RecoverySnapshot
  var before: {
    frame: int, created: int, maximum: int, wall: int,
    reads: int, calls: int, phase: int, pending: Set[int]
  }
  action init = all {
    profile::init,
    snapshot' = captureRecovery(-1, 0, 0, 0, 0),
    before' = { frame: 0, created: 0, maximum: 0, wall: 0,
      reads: 0, calls: 0, phase: profile::IDLE, pending: Set() }
  }
  val acquired = if (profile::s.o.reads > before.reads)
    captureRecovery(before.calls, before.frame, before.created, before.maximum, before.wall)
    else snapshot
  action step = all {
    snapshot' = acquired,
    before' = { frame: profile::s.frame, created: profile::s.created, maximum: profile::s.maxAge,
      wall: profile::s.wall, reads: profile::s.o.reads, calls: profile::s.o.calls.length(), phase: profile::s.phase,
      pending: profile::s.o.calls.indices().filter(owner => profile::s.o.calls.nth(owner) == CALL_PENDING) },
    profile::step
  }
  val flightKeepsAcquiredSnapshot = profile::s.phase == profile::IDLE or profile::s.candidate == 0 or {
    val reference = acquired
    profile::s.candidate == reference.payload and profile::s.candidateCreated == reference.created and
      profile::s.acceptedMaxAge == reference.maximum
  }
  val flightRecoveryMatchesContract = before.phase != profile::RECOVERY_DECODE or
    profile::input.name != "releaseLoad" or
    profile::s.o.recovery.nth(profile::s.o.recovery.length() - 1) != "served" or {
      // The snapshot belongs to the acquiring flight. Every caller waiting on
      // that flight, including followers, must receive its accepted value.
      before.pending.contains(snapshot.owner) and before.pending.forall(caller =>
        recoveryReturnAllowed(snapshot, snapshot.owner, profile::s.o.calls.nth(caller), before.wall))
    }
}
