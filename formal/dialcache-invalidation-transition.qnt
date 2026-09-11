module dialcache_invalidation_transition {
  // An atomic invalidation transition over one Redis key, with exact decimal
  // argument text and complete prior type/content/retention. Each step resets
  // an independent external fixture, then records the script's observable reply
  // and after-state. C38/C39 define these seven portable wire obligations.
  // No cache caller, transport failure or concurrent Redis command participates.
  // Real Redis replay measures elapsed server time around setup/transition/read;
  // this logical model has no clock passage within that atomic observation.

  pure val ABSENT = 0
  pure val STRING = 1
  pure val LIST = 2
  pure val PENDING = 0
  pure val SUCCESS = 1
  pure val REJECTED = 2
  pure val MAX_SAFE_INTEGER = 9007199254740991
  pure val MAX_BUFFER_MS = 31536000000
  pure val RETENTION_FLOOR_MS = 7200000
  pure val TRACKED_VALUE_AND_MARGIN_MS = 3660000
  pure val PRIOR_STATE_COUNT = 12
  pure val ARGUMENT_COUNT = 24
  pure val CASE_COUNT = PRIOR_STATE_COUNT * ARGUMENT_COUNT

  // Text is a list of Unicode scalar values, so empty strings and malformed
  // numeric grammar remain explicit inputs independent of any host parser.
  type RedisState = { kind: int, value: List[int], values: List[List[int]], ttlMs: int }
  type Arguments = { label: str, buffer: List[int], timestamp: List[int] }
  type Input = {
    name: str, caseId: int, label: str, priorLabel: str,
    existing: RedisState, futureBuffer: List[int], invalidatedAt: List[int]
  }
  type State = { outcome: int, after: RedisState, remaining: Set[int] }
  var input: Input
  var s: State

  pure val absent = { kind: ABSENT, value: List(), values: List(), ttlMs: -2 }
  pure def decimalValue(text: List[int]): int =
    text.foldl(0, (number, code) => number * 10 + code - 48)
  pure def isDecimal(text: List[int]): bool =
    text.length() > 0 and text.indices().forall(i => text.nth(i) >= 48 and text.nth(i) <= 57)
  pure def parseSafeDecimal(text: List[int]): { valid: bool, value: int } = {
    val value = decimalValue(text)
    { valid: isDecimal(text) and value <= MAX_SAFE_INTEGER, value: value }
  }
  pure def decimalText(number: int): List[int] =
    List(1000000000000000, 100000000000000, 10000000000000, 1000000000000,
      100000000000, 10000000000, 1000000000, 100000000, 10000000, 1000000,
      100000, 10000, 1000, 100, 10, 1).foldl(List(), (out, place) =>
        if (out.length() == 0 and number < place and place > 1) out
        else out.append(48 + (number / place) % 10))

  pure def priorState(code: int): RedisState =
    if (code == 0) absent
    else if (code == 7 or code == 8) {
      // Ordered contents must survive rejected input byte-for-byte.
      kind: LIST, value: List(), values: List(List(102, 105, 114, 115, 116), List(115, 101, 99, 111, 110, 100)),
      ttlMs: if (code == 8) -1 else 20000000
    } else {
      kind: STRING, values: List(),
      value: if (code == 2) decimalText(10000000)
        else if (code == 4) decimalText(2000)
        else if (code == 5 or code == 6) List(98, 97, 100) // "bad"
        else if (code == 9) List(48, 48, 48, 48).concat(decimalText(900))
        else if (code == 10) decimalText(9007199254740992)
        else if (code == 11) List() else decimalText(900),
      ttlMs: if (code == 4 or code == 6) -1
        else if (code == 3 or code == 5 or code == 10) 20000000 else 100
    }
  pure def priorLabel(code: int): str = List(
    "absent", "valid finite", "future finite", "valid longer TTL", "valid persistent",
    "malformed finite", "malformed persistent", "ordered finite list", "ordered persistent list",
    "leading-zero stored decimal", "unsafe stored decimal", "empty stored string").nth(code)

  pure def arguments(code: int): Arguments = List(
    { label: "zero buffer", buffer: decimalText(0), timestamp: decimalText(1000) },
    { label: "buffered cutoff", buffer: decimalText(200), timestamp: decimalText(1000) },
    { label: "retention above floor", buffer: decimalText(4000000), timestamp: decimalText(1000) },
    { label: "maximum buffer", buffer: decimalText(MAX_BUFFER_MS), timestamp: decimalText(1000) },
    { label: "maximum safe sum", buffer: decimalText(1), timestamp: decimalText(MAX_SAFE_INTEGER - 1) },
    { label: "leading decimal zeros", buffer: List(48, 48, 48).concat(decimalText(200)), timestamp: List(48, 48, 48).concat(decimalText(1000)) },
    { label: "negative buffer", buffer: List(45, 49), timestamp: decimalText(1000) },
    { label: "fractional buffer", buffer: List(49, 46, 53), timestamp: decimalText(1000) },
    { label: "over-limit buffer", buffer: decimalText(MAX_BUFFER_MS + 1), timestamp: decimalText(1000) },
    { label: "unsafe buffer", buffer: decimalText(MAX_SAFE_INTEGER + 1), timestamp: decimalText(1000) },
    { label: "exponent timestamp", buffer: decimalText(0), timestamp: List(49, 101, 51) },
    { label: "negative timestamp", buffer: decimalText(0), timestamp: List(45, 49) },
    { label: "unsafe sum", buffer: decimalText(1), timestamp: decimalText(MAX_SAFE_INTEGER) },
    { label: "empty buffer", buffer: List(), timestamp: decimalText(1000) },
    { label: "explicit plus buffer", buffer: List(43, 49), timestamp: decimalText(1000) },
    { label: "space-prefixed buffer", buffer: List(32, 49), timestamp: decimalText(1000) },
    { label: "hexadecimal buffer", buffer: List(48, 120, 49, 48), timestamp: decimalText(1000) },
    { label: "newline-suffixed buffer", buffer: List(49, 10), timestamp: decimalText(1000) },
    { label: "fractional timestamp", buffer: decimalText(0), timestamp: List(49, 46, 53) },
    { label: "unsafe timestamp", buffer: decimalText(0), timestamp: decimalText(MAX_SAFE_INTEGER + 1) },
    { label: "maximum timestamp", buffer: decimalText(0), timestamp: decimalText(MAX_SAFE_INTEGER) },
    { label: "zero timestamp", buffer: decimalText(0), timestamp: decimalText(0) },
    { label: "empty timestamp", buffer: decimalText(0), timestamp: List() },
    { label: "all-zero decimal text", buffer: List(48, 48, 48), timestamp: List(48, 48, 48) }
  ).nth(code)

  pure def inputFor(caseId: int): Input = {
    val args = arguments(caseId / PRIOR_STATE_COUNT)
    val prior = caseId % PRIOR_STATE_COUNT
    { name: "invalidate", caseId: caseId, label: args.label, priorLabel: priorLabel(prior),
      existing: priorState(prior), futureBuffer: args.buffer, invalidatedAt: args.timestamp }
  }

  pure def invalidated(command: Input): { outcome: int, after: RedisState } = {
    val buffer = parseSafeDecimal(command.futureBuffer)
    val at = parseSafeDecimal(command.invalidatedAt)
    if (not(buffer.valid) or buffer.value > MAX_BUFFER_MS or
        not(at.valid) or at.value > MAX_SAFE_INTEGER - buffer.value)
      { outcome: REJECTED, after: command.existing }
    else {
      val previous = parseSafeDecimal(command.existing.value)
      val priorCutoff = if (command.existing.kind == STRING and previous.valid) previous.value else 0
      val proposed = at.value + buffer.value
      val cutoff = if (priorCutoff > proposed) priorCutoff else proposed
      val horizon = cutoff - at.value + TRACKED_VALUE_AND_MARGIN_MS
      val floor = if (horizon > RETENTION_FLOOR_MS) horizon else RETENTION_FLOOR_MS
      val oldTtl = if (command.existing.kind == STRING) command.existing.ttlMs else -2
      { outcome: SUCCESS, after: {
        kind: STRING, value: decimalText(cutoff), values: List(),
        ttlMs: if (oldTtl == -1) -1 else if (oldTtl > floor) oldTtl else floor
      } }
    }
  }

  action init = all {
    input' = { name: "init", caseId: -1, label: "", priorLabel: "", existing: absent,
      futureBuffer: List(), invalidatedAt: List() },
    s' = { outcome: PENDING, after: absent, remaining: 0.to(CASE_COUNT - 1) }
  }
  action applyCase(caseId: int): bool = all {
    s.remaining.contains(caseId),
    val command = inputFor(caseId)
    val result = invalidated(command)
    all {
      input' = command,
      s' = { outcome: result.outcome, after: result.after, remaining: s.remaining.exclude(Set(caseId)) }
    }
  }
  // Sampling without replacement exports the whole declared finite domain in
  // one history. Stable artifact ordering comes from caseId, not random order.
  action step = { nondet choice = s.remaining.oneOf(); applyCase(choice) }

  // Independent obligations use the input and recorded after-state. No check
  // calls invalidated(), and preservation compares all original state fields.
  val rejectedInputPreservesEntireRedisState = s.outcome != REJECTED or s.after == input.existing
  val argumentValidationIsExact = s.outcome == PENDING or {
    val buffer = input.futureBuffer
    val at = input.invalidatedAt
    val digits = buffer.length() > 0 and at.length() > 0 and
      buffer.indices().forall(i => buffer.nth(i) >= 48 and buffer.nth(i) <= 57) and
      at.indices().forall(i => at.nth(i) >= 48 and at.nth(i) <= 57)
    (s.outcome == SUCCESS) == (digits and decimalValue(buffer) <= 31536000000 and
      decimalValue(at) <= 9007199254740991 - decimalValue(buffer))
  }
  val successfulCutoffIsExactMaximum = s.outcome != SUCCESS or {
    val proposed = decimalValue(input.invalidatedAt) + decimalValue(input.futureBuffer)
    val old = input.existing.value
    val prior = if (input.existing.kind == STRING and isDecimal(old) and decimalValue(old) <= 9007199254740991)
      decimalValue(old) else 0
    decimalValue(s.after.value) == (if (proposed >= prior) proposed else prior)
  }
  val successfulRetentionMeetsBothFloors = s.outcome != SUCCESS or s.after.ttlMs == -1 or
    (s.after.ttlMs >= 7200000 and s.after.ttlMs >= decimalValue(s.after.value) - decimalValue(input.invalidatedAt) + 3660000)
  val stringsKeepExistingRetention = s.outcome != SUCCESS or input.existing.kind != STRING or
    (if (input.existing.ttlMs == -1) s.after.ttlMs == -1 else s.after.ttlMs >= input.existing.ttlMs)
  val unrelatedTypesReceiveFiniteRepair = s.outcome != SUCCESS or input.existing.kind == STRING or {
    val needed = decimalValue(s.after.value) - decimalValue(input.invalidatedAt) + 3660000
    s.after.ttlMs == (if (needed > 7200000) needed else 7200000)
  }
  val outputIsCanonicalDecimalString = s.outcome != SUCCESS or
    (s.after.kind == STRING and s.after.values == List() and isDecimal(s.after.value) and
      (s.after.value.length() == 1 or s.after.value.nth(0) != 48))
  val finiteRetentionIsExact = s.outcome != SUCCESS or s.after.ttlMs == -1 or {
    val needed = decimalValue(s.after.value) - decimalValue(input.invalidatedAt) + 3660000
    val prior = if (input.existing.kind == STRING) input.existing.ttlMs else -2
    val floor = if (needed > 7200000) needed else 7200000
    s.after.ttlMs == (if (prior > floor) prior else floor)
  }

  run absentMarkerGetsRetentionFloorTest = init.then(applyCase(0))
    .expect(s.outcome == SUCCESS and s.after.value == List(49, 48, 48, 48) and s.after.ttlMs == 7200000)
  run futureCutoffDoesNotMoveBackwardsTest = init.then(applyCase(2))
    .expect(s.after.value == decimalText(10000000) and s.after.ttlMs == 13659000)
  run longBufferExtendsRequiredRetentionTest = init.then(applyCase(24))
    .expect(s.after.value == decimalText(4001000) and s.after.ttlMs == 7660000)
  run persistentMalformedStringStaysPersistentTest = init.then(applyCase(6))
    .expect(s.after.value == decimalText(1000) and s.after.ttlMs == -1)
  run wrongTypeLongTtlIsNotInheritedTest = init.then(applyCase(7))
    .expect(s.after.kind == STRING and s.after.ttlMs == 7200000)
  run wrongTypePersistenceIsNotInheritedTest = init.then(applyCase(8))
    .expect(s.after.kind == STRING and s.after.ttlMs == 7200000)
  run rejectedFractionPreservesOrderedListTest = init.then(applyCase(7 * 12 + 7))
    .expect(s.outcome == REJECTED and s.after == priorState(7))
  run rejectedUnsafeSumPreservesPersistentMalformedTextTest = init.then(applyCase(12 * 12 + 6))
    .expect(s.outcome == REJECTED and s.after.kind == STRING and s.after.value == List(98, 97, 100) and s.after.ttlMs == -1)
  run maximumBufferAndTimestampSumAreAcceptedTest = init.then(applyCase(3 * 12))
    .expect(s.outcome == SUCCESS and s.after.ttlMs == 31539660000)
    .then(applyCase(4 * 12)).expect(s.outcome == SUCCESS and decimalValue(s.after.value) == 9007199254740991)
  run decimalZerosAreCanonicalizedTest = init.then(applyCase(5 * 12))
    .expect(s.after.value == List(49, 50, 48, 48))
    .then(applyCase(23 * 12)).expect(s.after.value == List(48))
  run newlineAndPlusAreNotDecimalGrammarTest = init.then(applyCase(17 * 12))
    .expect(s.outcome == REJECTED).then(applyCase(14 * 12)).expect(s.outcome == REJECTED)
  run emptyStringRetentionIsPreservedTest = init.then(applyCase(11))
    .expect(s.outcome == SUCCESS and s.after.value == decimalText(1000) and s.after.ttlMs == 7200000)
}
