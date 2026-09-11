module conformance_observations {
  // Shared replay observations, not a shared cache state machine.
  // Cache contents, phases, policy snapshots and fences remain profile-local.
  // These integer values are part of the ITF driver contract; do not renumber.

  // -- Caller outcome encoding ----------------------------------------------

  pure val CALL_PENDING = 0
  pure val VALUE_ONE = 1
  pure val VALUE_TWO = 2
  pure val SOURCE_ERROR = 3
  pure val DEADLINE_ERROR = 4
  pure val VALUE_ABSENT = 5
  pure val VALUE_NULL = 6
  pure val VALUE_FALSE = 7
  pure val VALUE_ZERO = 8
  pure val VALUE_EMPTY_STRING = 9

  pure val values = List(
    VALUE_ONE, VALUE_TWO, VALUE_ABSENT, VALUE_NULL,
    VALUE_FALSE, VALUE_ZERO, VALUE_EMPTY_STRING
  )

  // -- Public observation records -------------------------------------------

  // Optional diagnostic projection: ages are integer milliseconds in the model.
  type Diagnostics = {
    warnings: int,
    ages: List[int],
    coalesced: List[str],
    fallbackErrors: List[str]
  }
  pure val noDiagnostics: Diagnostics = {
    warnings: 0,
    ages: List(),
    coalesced: List(),
    fallbackErrors: List()
  }
  type Observation = {
    calls: List[int],
    loaders: int,
    reads: int,
    writes: int,
    invalidations: int,
    maintenance: List[str],
    loads: int,
    dumps: int,
    policyCalls: int,
    classifications: int,
    comparisons: int,
    sourceScopes: List[bool],
    writeTtls: List[int],
    shadow: List[str],
    recovery: List[str]
  }
  pure val empty: Observation = {
    calls: List(),
    loaders: 0,
    reads: 0,
    writes: 0,
    invalidations: 0,
    maintenance: List(),
    loads: 0,
    dumps: 0,
    policyCalls: 0,
    classifications: 0,
    comparisons: 0,
    sourceScopes: List(),
    writeTtls: List(),
    shadow: List(),
    recovery: List()
  }

  // -- Caller completion helpers --------------------------------------------

  // Used by profiles with one currently shared execution. Settled callers
  // retain their outcome; every still-pending caller receives this result.
  pure def finishPendingCalls(o: Observation, result: int): Observation = {
    calls: o.calls.foldl(List(), (completed, current) =>
      completed.append(if (current == CALL_PENDING) result else current)),
    ...o
  }

  // Used by profiles with overlapping executions. The owners list is parallel
  // to calls. Ownership alone selects updates, matching each profile's former
  // fold; this helper adds no pending-state or publication condition.
  pure def finishOwnedCalls(
    calls: List[int], owners: List[int], owner: int, result: int
  ): List[int] = calls.foldl(List(), (completed, current) => {
    val callIndex = completed.length()
    completed.append(if (owners.nth(callIndex) == owner) result else current)
  })
}
