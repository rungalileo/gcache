module dialcache_recovery_connection {
  import dialcache_recovery_read_conformance as profile from "./dialcache-recovery-read-conformance"
  import cache_contract.* from "./cache-contract"

  // Bounded correspondence for the real recovery-read profile, not a second
  // replay machine. Its original actions run unchanged. This monitor acquires
  // a reference snapshot from storage at read settlement and checks subsequent
  // retained ownership and returned observations against that acquired record.
  // Frame validity/fence/decode checks remain profile obligations. One active
  // call and the profile's finite domain bound this connection; no fairness claim.
  var snapshot: RecoverySnapshot
  var capturedMaximum: int
  var before: { phase: int, wall: int, calls: int, maximum: int }

  action init = all {
    profile::init,
    snapshot' = captureRecovery(-1, 0, 0, 0, 0),
    capturedMaximum' = 0,
    before' = { phase: profile::IDLE, wall: profile::WALL_ORIGIN, calls: 0, maximum: 0 }
  }
  // Admission acquires the preceding policy reply, independently of the
  // profile's acceptedMaximum field. A held read cannot acquire a later reply.
  val admittedMaximum = if (profile::input.name == "beginCall") before.maximum else capturedMaximum
  // Capture immediately after the profile's read, before the next external
  // transition can replace storage or policy. Read the storage fields, not the
  // profile's predicted candidate fields: confusing those must be detectable.
  val acquired = if (profile::input.name == "releaseRead")
    captureRecovery(profile::s.o.calls.length() - 1,
      profile::payloadValue(profile::s.frame), profile::s.created,
      admittedMaximum, profile::s.wall)
    else snapshot

  action step = all {
    snapshot' = acquired,
    capturedMaximum' = admittedMaximum,
    before' = { phase: profile::s.phase, wall: profile::s.wall, calls: profile::s.o.calls.length(),
      maximum: profile::s.maximumMs },
    profile::step
  }

  val retainedSnapshotMatchesAcquisition =
    (profile::s.o.calls.length() == 0 or profile::s.acceptedMaximum == admittedMaximum) and
    (profile::s.phase != profile::SOURCE_RUNNING and profile::s.phase != profile::RECOVERY_DECODE or
    profile::s.candidate == 0 or {
      val reference = acquired
      reference.owner == profile::s.o.calls.length() - 1 and
        reference.payload == profile::payloadValue(profile::s.candidate) and
        reference.created == profile::s.candidateCreated and
        reference.maximum == profile::s.acceptedMaximum
    })

  val recoveryReturnMatchesAcquiredContract =
    before.phase != profile::RECOVERY_DECODE or profile::input.name != "releaseLoad" or
    profile::s.o.recovery.nth(profile::s.o.recovery.length() - 1) != "served" or
      recoveryReturnAllowed(snapshot, before.calls - 1, profile::s.o.calls.nth(profile::s.o.calls.length() - 1), before.wall)
}
