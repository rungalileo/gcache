module dialcache_local_clock_conformance {
  import cache_rules.* from "./cache-rules"
  import conformance_observations.* from "./conformance-observations"

  // C09/B02: default instances share a whole-millisecond local expiry grid.
  // Environment time is expressed in microsecond ticks, while local insertion
  // and lookup project that common time to whole milliseconds. This differs
  // from source/read/shadow budgets, which measure precise elapsed intervals.
  // Two instances, one key per instance, healthy immediate sources, a fixed
  // one-second local TTL, and no request memo or remote layer bound this model.
  // The replay creates real default caches at the declared fractional times.

  pure val TICKS_PER_MS = 1000
  pure val LOCAL_TTL_MS = 1000
  pure val INSTANCE_IDS = Set(0, 1)
  pure val ADVANCES = Set(1, 100, 300, 400, 700, 999200, 999999, 1000000)
  pure val EMPTY_ENTRY = 0
  pure val MAX_CALLS = 20

  type Entry = { value: int, insertedTicks: int }
  type Fill = { instance: int, value: int, ticks: int }
  type Probe = {
    instance: int, ticks: int, offered: int, returned: int,
    previous: Entry, ranSource: bool
  }
  type State = {
    o: Observation,
    ticks: int,
    constructed: List[bool],
    entries: List[Entry],
    fills: List[Fill],
    probes: List[Probe]
  }
  var s: State
  var input: { name: str, choice: int }

  pure def entryIsLive(entry: Entry, ticks: int): bool =
    entry.value != EMPTY_ENTRY and localEntryLiveOnGrid(ticks, entry.insertedTicks, LOCAL_TTL_MS, TICKS_PER_MS)

  action init = all {
    s' = {
      o: empty,
      ticks: 0,
      constructed: List(false, false),
      entries: List({ value: EMPTY_ENTRY, insertedTicks: 0 }, { value: EMPTY_ENTRY, insertedTicks: 0 }),
      fills: List(),
      probes: List()
    },
    input' = { name: "init", choice: -1 }
  }

  action construct(instance: int): bool = all {
    not(s.constructed.nth(instance)),
    s' = { constructed: s.constructed.replaceAt(instance, true), ...s },
    input' = { name: "constructInstance", choice: instance }
  }
  action constructInstance = {
    nondet choice = INSTANCE_IDS.filter(instance => not(s.constructed.nth(instance))).oneOf()
    construct(choice)
  }

  action elapse(ticks: int): bool = all {
    s' = { ticks: s.ticks + ticks, ...s },
    input' = { name: "advanceTicks", choice: ticks }
  }
  action advanceTicks = {
    nondet choice = ADVANCES.oneOf()
    elapse(choice)
  }

  action call(instance: int, offered: int): bool = all {
    s.constructed.nth(instance),
    s.o.calls.length() < MAX_CALLS,
    val previous = s.entries.nth(instance)
    val hit = entryIsLive(previous, s.ticks)
    val returned = if (hit) previous.value else offered
    s' = {
      entries: if (hit) s.entries else s.entries.replaceAt(instance, { value: offered, insertedTicks: s.ticks }),
      fills: if (hit) s.fills else s.fills.append({ instance: instance, value: offered, ticks: s.ticks }),
      probes: s.probes.append({
        instance: instance, ticks: s.ticks, offered: offered, returned: returned,
        previous: previous, ranSource: not(hit)
      }),
      o: { calls: s.o.calls.append(returned), loaders: s.o.loaders + (if (hit) 0 else 1), ...s.o },
      ...s
    },
    input' = { name: "call", choice: instance * 2 + offered - 1 }
  }
  action callCache = {
    nondet choice = 0.to(3).filter(code => s.constructed.nth(code / 2)).oneOf()
    call(choice / 2, choice % 2 + 1)
  }
  action step = any { constructInstance, advanceTicks, callCache }

  // Deliberately spell out the integer projection here instead of reusing the
  // transition's localEntryLiveOnGrid helper. A precise-TTL substitution and
  // a renewed insertion timestamp must both violate an independent obligation.
  val localReadsUseCommonWholeMilliseconds = s.probes.indices().forall(index => {
    val probe = s.probes.nth(index)
    val ageTicks = probe.ticks - probe.ticks % TICKS_PER_MS
      - (probe.previous.insertedTicks - probe.previous.insertedTicks % TICKS_PER_MS)
    val mustHit = probe.previous.value != EMPTY_ENTRY and ageTicks < LOCAL_TTL_MS * TICKS_PER_MS
    probe.ranSource != mustHit and probe.returned ==
      (if (mustHit) probe.previous.value else probe.offered)
  })
  val readsNeverRenewLocalInsertion = INSTANCE_IDS.forall(instance => {
    val last = s.fills.foldl({ value: EMPTY_ENTRY, insertedTicks: 0 }, (entry, fill) =>
      if (fill.instance == instance) { value: fill.value, insertedTicks: fill.ticks } else entry)
    s.entries.nth(instance) == last
  })
  val publicCallsPreserveProbeResults = s.o.calls == s.probes.foldl(List(), (calls, probe) => calls.append(probe.returned))
    and s.o.loaders == s.probes.foldl(0, (count, probe) => count + (if (probe.ranSource) 1 else 0))

  run fractionalInsertionExpiresAtWholeMillisecondTest = init
    .then(construct(0)).then(elapse(700)).then(call(0, VALUE_ONE))
    .then(elapse(999200)).then(call(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1)
    .then(elapse(100)).then(call(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_TWO) and s.o.loaders == 2)

  run fractionalConstructionKeepsCommonInstanceGridTest = init
    .then(construct(0)).then(elapse(400)).then(construct(1)).then(elapse(300))
    .then(call(0, VALUE_ONE)).then(call(1, VALUE_ONE))
    .then(elapse(999200)).then(call(0, VALUE_TWO)).then(call(1, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE, VALUE_ONE) and s.o.loaders == 2)
    .then(elapse(100)).then(call(0, VALUE_TWO)).then(call(1, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_ONE, VALUE_ONE, VALUE_TWO, VALUE_TWO)
      and s.o.loaders == 4)

  run nonzeroOriginKeepsWholeMillisecondBoundaryTest = init
    .then(elapse(1000000)).then(construct(0)).then(elapse(700)).then(call(0, VALUE_ONE))
    .then(elapse(999200)).then(call(0, VALUE_TWO)).then(elapse(100)).then(call(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_TWO) and s.o.loaders == 2)

  run integerInsertionRetainsFullTtlTest = init
    .then(construct(0)).then(call(0, VALUE_ONE))
    .then(elapse(999999)).then(call(0, VALUE_TWO)).then(elapse(1)).then(call(0, VALUE_TWO))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, VALUE_TWO) and s.o.loaders == 2)
}
