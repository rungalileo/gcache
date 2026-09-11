module cache_contract {
  import cache_rules.* from "./cache-rules"

  // Small reference contracts for acquired recovery bytes and source ownership.
  // Profiles project their external acquisition/start events into these records.
  // Later storage, policy and caller changes cannot rewrite an acquired record.
  type RecoverySnapshot = {
    owner: int, payload: int, created: int, maximum: int, acquiredAt: int
  }
  pure def captureRecovery(owner: int, payload: int, created: int, maximum: int, at: int): RecoverySnapshot =
    { owner: owner, payload: payload, created: created, maximum: maximum, acquiredAt: at }

  pure def recoveryReturnAllowed(snapshot: RecoverySnapshot, owner: int, payload: int, at: int): bool =
    owner == snapshot.owner and payload == snapshot.payload and
      recoveryAgeAllowed(snapshot.created, at, snapshot.maximum)

  type SourceExecution = { owner: int, started: int, budget: int }
  pure def captureSource(owner: int, started: int, budget: int): SourceExecution =
    { owner: owner, started: started, budget: budget }

  pure def sourceReturnAllowed(source: SourceExecution, owner: int, settled: int): bool =
    owner == source.owner and settled >= source.started and
      sourceAcceptsAt(source.started, settled, source.budget)
}
