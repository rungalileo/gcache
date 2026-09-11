module dialcache_local_failure_conformance {
  import conformance_observations.* from "./conformance-observations"

  // C27: local plumbing can fail without changing an accepted caller result.
  // Two persistent requests and a transient request distinguish memo ownership
  // from process-local publication. The remote layer is untracked. One source
  // is active at a time, with unbounded source time and no elapsed-time steps.
  // Native bindings inject failure at local storage/its integer-clock boundary.
  // A read fault is exercised on a present entry; a write fault is armed while
  // source work is pending. Successful operations use the real native storage.

  type Receipt = {
    readFailed: bool, writeFailed: bool, before: int, after: int,
    returned: int, call: int
  }
  type State = {
    o: Observation, memo: List[int], localValue: int, remoteValue: int,
    remoteEnabled: bool, failed: bool, pending: bool, scope: int,
    localMiss: bool, readFailed: bool, acceptedRemote: bool,
    localBefore: int, receipts: List[Receipt]
  }
  var s: State
  var input: { name: str, choice: int }

  action init = all {
    input' = { name: "init", choice: -1 },
    s' = {
      o: empty, memo: List(0, 0), localValue: 0, remoteValue: 0,
      remoteEnabled: true, failed: false, pending: false, scope: 2,
      localMiss: false, readFailed: false, acceptedRemote: false,
      localBefore: 0, receipts: List()
    }
  }

  pure def complete(x: State, value: int): State = {
    pending: false,
    memo: if (value != SOURCE_ERROR and x.scope < 2)
      x.memo.replaceAt(x.scope, value) else x.memo,
    o: finishPendingCalls(x.o, value),
    ...x
  }

  pure def recordPublication(x: State, value: int): State = {
    receipts: x.receipts.append({
      readFailed: x.readFailed,
      writeFailed: x.localMiss and x.failed and value != SOURCE_ERROR,
      before: x.localBefore, after: x.localValue,
      returned: value, call: x.o.calls.length() - 1
    }), ...x
  }

  pure def acquired(x: State, value: int): State = {
    val published = {
      localValue: if (x.localMiss and not(x.failed)) value else x.localValue,
      ...x
    }
    complete(recordPublication(published, value), value)
  }

  pure def admitted(x: State, scope: int): State = {
    val call = {
      scope: scope, localBefore: x.localValue, readFailed: x.failed,
      localMiss: not(x.failed), acceptedRemote: x.remoteEnabled,
      o: { calls: x.o.calls.append(CALL_PENDING), policyCalls: x.o.policyCalls + 1, ...x.o }, ...x
    }
    if (scope < 2 and x.memo.nth(scope) != 0) complete(call, x.memo.nth(scope))
    else if (not(x.failed) and x.localValue != 0) complete(call, x.localValue)
    else {
      val read = { o: { reads: call.o.reads + (if (x.remoteEnabled) 1 else 0), ...call.o }, ...call }
      if (x.remoteEnabled and x.remoteValue != 0)
        acquired({ o: { loads: read.o.loads + 1, ...read.o }, ...read }, x.remoteValue)
      else { pending: true, o: { loaders: read.o.loaders + 1, ...read.o }, ...read }
    }
  }

  action begin(scope: int): bool = all {
    not(s.pending), s.o.calls.length() < 10,
    // The two native injection bindings share this fallible-read domain.
    not(s.failed) or s.localValue != 0,
    input' = { name: "beginCall", choice: scope },
    s' = admitted(s, scope)
  }
  action beginCall = { nondet choice = Set(0, 1, 2).oneOf(); begin(choice) }

  action resolve(value: int): bool = all {
    s.pending,
    input' = { name: "resolveLoader", choice: value },
    val remote = if (s.acceptedRemote) {
      remoteValue: value,
      o: {
        dumps: s.o.dumps + 1, writes: s.o.writes + 1,
        writeTtls: s.o.writeTtls.append(60000), ...s.o
      }, ...s
    } else s
    s' = acquired(remote, value)
  }
  action resolveLoader = { nondet choice = Set(VALUE_ONE, VALUE_TWO).oneOf(); resolve(choice) }
  action rejectLoader = all {
    s.pending, input' = { name: "rejectLoader", choice: -1 },
    s' = complete(recordPublication(s, SOURCE_ERROR), SOURCE_ERROR)
  }
  action fault(selected: int): bool = all {
    input' = { name: "localFault", choice: selected },
    s' = { failed: selected == 1, ...s }
  }
  action localFault = { nondet choice = Set(0, 1).oneOf(); fault(choice) }
  action remotePolicy(selected: int): bool = all {
    input' = { name: "policy", choice: selected },
    s' = { remoteEnabled: selected == 1, ...s }
  }
  action policy = { nondet choice = Set(0, 1).oneOf(); remotePolicy(choice) }
  action seeded(value: int): bool = all {
    input' = { name: "seed", choice: value }, s' = { remoteValue: value, ...s }
  }
  action seed = { nondet choice = Set(VALUE_ONE, VALUE_TWO).oneOf(); seeded(choice) }
  action step = any { beginCall, resolveLoader, rejectLoader, localFault, policy, seed }

  // Independent receipts compare the old storage identity and accepted result;
  // they do not call the transition's publication-eligibility helpers.
  val failedReadKeepsPriorLocalValue = s.receipts.indices().forall(i => {
    val receipt = s.receipts.nth(i)
    not(receipt.readFailed) or receipt.after == receipt.before
  })
  val failedWriteKeepsAcceptedCallerResult = s.receipts.indices().forall(i => {
    val receipt = s.receipts.nth(i)
    not(receipt.writeFailed) or (receipt.after == receipt.before
      and s.o.calls.nth(receipt.call) == receipt.returned)
  })
  val sourceErrorsNeverReplaceLocalValue = s.receipts.indices().forall(i => {
    val receipt = s.receipts.nth(i)
    receipt.returned != SOURCE_ERROR or receipt.after == receipt.before
  })

  run localReadFailureFallsThroughAndPreservesOldLocalTest = init
    .then(begin(2)).then(resolve(VALUE_ONE))
    .then(seeded(VALUE_TWO)).then(fault(1)).then(begin(0))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO) and s.o.reads == 2 and s.o.loaders == 1)
    .then(fault(0)).then(begin(2)).then(begin(0))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE, VALUE_TWO)
      and s.o.reads == 2 and s.o.loaders == 1)

  run localReadFailureSkipsSourcePublicationButMemoizesTest = init
    .then(begin(2)).then(resolve(VALUE_ONE))
    .then(remotePolicy(0)).then(fault(1)).then(begin(0)).then(fault(0))
    .then(resolve(VALUE_TWO)).then(begin(2)).then(begin(0))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_TWO, VALUE_ONE, VALUE_TWO)
      and s.o.loaders == 2 and s.o.writes == 1)

  run localWriteFailureKeepsSourceAndRequestMemoTest = init
    .then(begin(0)).then(fault(1)).then(resolve(VALUE_ONE)).then(fault(0))
    .then(remotePolicy(0)).then(begin(0)).then(begin(2))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, CALL_PENDING)
      and s.o.loaders == 2 and s.o.writes == 1)
    .then(resolve(VALUE_TWO)).then(begin(2))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_TWO, VALUE_TWO)
      and s.o.loaders == 2)

  run sourceFailureKeepsPreviouslyAcceptedStorageTest = init
    .then(begin(2)).then(resolve(VALUE_ONE)).then(remotePolicy(0))
    .then(fault(1)).then(begin(0)).then(rejectLoader).then(fault(0)).then(begin(2))
    .expect(s.o.calls == List(VALUE_ONE, SOURCE_ERROR, VALUE_ONE)
      and s.o.loaders == 2 and s.o.writes == 1)
}
