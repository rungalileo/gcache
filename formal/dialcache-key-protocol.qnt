module dialcache_key_protocol {
  import wire_text.* from "./wire-text"
  import cohort_boundaries.* from "./cohort-boundaries"

  // W01/W02/W03: key identity, normalized argument order, and cohort sampling.
  // Text inputs are UTF-16 code units; encoded outputs are ASCII code units.
  // This exposes malformed host strings instead of repairing them in JSON.
  // Every key component is strict UTF-16. Namespace braces are forbidden;
  // tracked entity components also forbid braces to keep a single hash tag.
  // Ordered key arguments remain caller-owned; normalization is a separate API.
  // Integer and bigint normalization is modeled within signed 64-bit magnitude. Native
  // IEEE754 shortest decimal formatting remains a separately tested binding.

  pure val KEY = 0
  pure val NORMALIZE = 1
  pure val COHORT = 2
  pure val OMITTED = 0
  pure val TEXT = 1
  pure val NULL = 2
  pure val FALSE = 3
  pure val TRUE = 4
  pure val INTEGER = 5
  pure val BIGINT = 6
  pure val FNV_OFFSET = 2166136261
  pure val FNV_PRIME = 16777619
  pure val TEXT_CASE_COUNT = 24
  pure val COMPONENT_CASE_COUNT = TEXT_CASE_COUNT * 6 * 2
  pure val KEY_CASE_COUNT = COMPONENT_CASE_COUNT + 128 + 4
  pure val NORMALIZE_CASE_COUNT = 13
  pure val COHORT_CASE_COUNT = 24
  pure val CASE_COUNT = KEY_CASE_COUNT + NORMALIZE_CASE_COUNT + COHORT_CASE_COUNT

  type Pair = { name: List[int], value: List[int] }
  type KeyInput = {
    namespace: List[int], keyType: List[int], id: List[int], useCase: List[int],
    tracked: bool, args: List[Pair]
  }
  // Two base-billion magnitude limbs preserve an exact numeric input through
  // ITF/JSON implementations that cannot directly carry a signed 64-bit value.
  type Argument = {
    name: List[int], kind: int, text: List[int], integer: int,
    magnitude: List[int], negative: bool
  }
  type Input = {
    name: str, caseId: int, kind: int, label: str, key: KeyInput,
    arguments: List[Argument], discriminator: List[int]
  }
  type KeyOutput = { valid: bool, logical: List[int], valueKey: List[int], watermark: List[int] }
  type State = {
    key: KeyOutput, normalized: List[Pair], hash: int,
    below: bool, equal: bool, above: bool
  }
  var input: Input
  var s: State

  pure val URN = List(117, 114, 110)
  pure val FRAME_SUFFIX = List(58, 100, 105, 97, 108, 99, 97, 99, 104, 101, 45, 102, 114, 97, 109, 101, 45, 118, 49)
  pure val WATERMARK_SUFFIX = List(35, 119, 97, 116, 101, 114, 109, 97, 114, 107)
  pure val emptyKey = { valid: false, logical: List(), valueKey: List(), watermark: List() }
  pure val baseline: KeyInput = {
    namespace: URN, keyType: List(105, 100), id: List(49), useCase: List(71, 101, 116),
    tracked: false, args: List()
  }
  pure def containsBrace(units: List[int]): bool = units.indices().exists(i => Set(123, 125).contains(units.nth(i)))
  pure def validKey(key: KeyInput): bool = all {
    List(key.namespace, key.keyType, key.id, key.useCase).indices().forall(i =>
      validUtf16(List(key.namespace, key.keyType, key.id, key.useCase).nth(i))),
    key.args.indices().forall(i => validUtf16(key.args.nth(i).name) and validUtf16(key.args.nth(i).value)),
    not(containsBrace(key.namespace)),
    not(key.tracked) or (not(containsBrace(key.keyType)) and not(containsBrace(key.id)))
  }

  pure def uriSafe(byte: int): bool =
    (byte >= 65 and byte <= 90) or (byte >= 97 and byte <= 122)
      or (byte >= 48 and byte <= 57) or Set(126, 33, 42, 39, 40, 41, 45, 46, 95).contains(byte)
  pure def hexDigit(nibble: int): int = if (nibble < 10) 48 + nibble else 65 + nibble - 10
  pure def escapedByte(byte: int): List[int] =
    if (uriSafe(byte)) List(byte) else List(37, hexDigit(byte / 16), hexDigit(byte % 16))
  pure def encodeComponent(units: List[int]): List[int] =
    utf8FromUtf16(units).foldl(List(), (encoded, byte) => encoded.concat(escapedByte(byte)))
  pure def encodedEntity(key: KeyInput): List[int] =
    encodeComponent(key.namespace).append(58).concat(encodeComponent(key.keyType))
      .append(58).concat(encodeComponent(key.id))
  pure def encodedArguments(args: List[Pair]): List[int] =
    args.foldl(List(), (encoded, pair) => encoded.append(if (encoded.length() == 0) 63 else 38)
      .concat(encodeComponent(pair.name)).append(61).concat(encodeComponent(pair.value)))
  pure def constructKey(key: KeyInput): KeyOutput =
    if (not(validKey(key))) emptyKey else {
      val entity = encodedEntity(key)
      val prefix = if (key.tracked) List(123).concat(entity).append(125) else entity
      val logical = prefix.concat(encodedArguments(key.args)).append(35).concat(encodeComponent(key.useCase))
      { valid: true, logical: logical, valueKey: logical.concat(FRAME_SUFFIX),
        watermark: if (key.tracked) List(123).concat(entity).append(125).concat(WATERMARK_SUFFIX) else List() }
    }

  // JavaScript string ordering compares UTF-16 code units, including the high
  // surrogate of an astral character before U+E000. It is not scalar ordering.
  pure def textBefore(left: List[int], right: List[int]): bool = {
    val shared = if (left.length() < right.length()) left.length() else right.length()
    val ordering = range(0, shared).foldl(0, (order, i) =>
      if (order != 0) order
      else if (left.nth(i) < right.nth(i)) -1
      else if (left.nth(i) > right.nth(i)) 1 else 0)
    ordering < 0 or (ordering == 0 and left.length() < right.length())
  }
  pure def decimalUnits(number: int): List[int] = {
    val magnitude = if (number < 0) -number else number
    val digits = range(0, 19).foldl({ remaining: magnitude, units: List() }, (state, _) =>
      if (state.remaining == 0 and state.units.length() > 0) state
      else { remaining: state.remaining / 10, units: List(48 + state.remaining % 10).concat(state.units) }).units
    if (number < 0) List(45).concat(digits) else digits
  }
  pure def argumentText(arg: Argument): List[int] =
    if (arg.kind == TEXT) arg.text
    else if (arg.kind == NULL) List(110, 117, 108, 108)
    else if (arg.kind == FALSE) List(102, 97, 108, 115, 101)
    else if (arg.kind == TRUE) List(116, 114, 117, 101)
    else decimalUnits(arg.integer)
  pure def normalizeArguments(args: List[Argument]): List[Pair] = {
    val retained = args.select(arg => arg.kind != OMITTED)
    // Each input name is unique, as in a record. Insertion preserves the
    // association between a name and its own converted value.
    retained.foldl(List(), (ordered, arg) => {
      val pair = { name: arg.name, value: argumentText(arg) }
      ordered.select(retainedPair => textBefore(retainedPair.name, pair.name)).append(pair)
        .concat(ordered.select(retainedPair => not(textBefore(retainedPair.name, pair.name))))
    })
  }

  // XOR the low 16 bits with the next code unit, retain the high 16 bits, then
  // multiply modulo 2^32. No implementation hash or host bitwise op is used.
  pure def xorUnit(hash: int, unit: int): int =
    (hash / 65536) * 65536 + range(0, 16).foldl(0, (low, bit) =>
      low + (((hash / (2^bit)) % 2 + (unit / (2^bit)) % 2) % 2) * (2^bit))
  pure def fnv1a(units: List[int]): int =
    units.foldl(FNV_OFFSET, (hash, unit) => (xorUnit(hash, unit) * FNV_PRIME) % COHORT_DENOMINATOR)
  pure def cohortHash(logical: List[int], discriminator: List[int]): int =
    fnv1a(logical.append(58).concat(discriminator))

  // Each text family is moved independently through all six component roles,
  // with tracked and untracked identities. ASCII is additionally exhaustive.
  pure def textCase(code: int): { label: str, units: List[int] } = List(
    { label: "empty", units: List() },
    { label: "URI-safe punctuation", units: List(126, 33, 42, 39, 40, 41, 45, 46, 95) },
    { label: "reserved delimiters", units: List(32, 58, 47, 63, 35, 91, 93, 64, 36, 38, 43, 44, 59, 61) },
    { label: "literal percent escape", units: List(37, 50, 70) },
    { label: "opening brace", units: List(123) },
    { label: "closing brace", units: List(125) },
    { label: "ASCII controls", units: List(0, 1, 31, 127) },
    { label: "first two-byte scalar", units: List(128) },
    { label: "last two-byte scalar", units: List(2047) },
    { label: "first three-byte scalar", units: List(2048) },
    { label: "BMP boundary scalars", units: List(55295, 57344, 65535) },
    { label: "combining sequence", units: List(101, 769) },
    { label: "precomposed accented text", units: List(233) },
    { label: "CJK text", units: List(38634, 31278, 39006) },
    { label: "first astral scalar", units: List(55296, 56320) },
    { label: "emoji surrogate pair", units: List(55357, 56832) },
    { label: "last Unicode scalar", units: List(56319, 57343) },
    { label: "lone high surrogate", units: List(55296) },
    { label: "lone low surrogate", units: List(56320) },
    { label: "reversed surrogate pair", units: List(56320, 55296) },
    { label: "repeated high surrogate", units: List(55296, 55296) },
    { label: "high surrogate before ASCII", units: List(55296, 65) },
    { label: "ASCII before low surrogate", units: List(65, 56320) },
    { label: "valid pair followed by lone surrogate", units: List(55357, 56832, 55296) }
  ).nth(code)
  pure def replaceComponent(key: KeyInput, component: int, units: List[int]): KeyInput =
    if (component == 0) { namespace: units, ...key }
    else if (component == 1) { keyType: units, ...key }
    else if (component == 2) { id: units, ...key }
    else if (component == 3) { useCase: units, ...key }
    else if (component == 4) { args: List({ name: units, value: List(118) }), ...key }
    else { args: List({ name: List(110), value: units }), ...key }
  pure def keyCase(code: int): KeyInput =
    if (code < COMPONENT_CASE_COUNT) {
      val fixture = { tracked: code % 2 == 1, ...baseline }
      replaceComponent(fixture, (code / 2) % 6, textCase(code / 12).units)
    } else if (code < COMPONENT_CASE_COUNT + 128)
      { id: List(code - COMPONENT_CASE_COUNT), ...baseline }
    else {
      val ordered = List({ name: List(122), value: List(50) }, { name: List(97), value: List(49) },
        { name: List(122), value: List(51) })
      { tracked: code % 2 == 1,
        args: if (code < COMPONENT_CASE_COUNT + 130) ordered else ordered.foldl(List(), (reversed, pair) => List(pair).concat(reversed)), ...baseline }
    }
  pure def keyLabel(code: int): str =
    if (code < COMPONENT_CASE_COUNT) textCase(code / 12).label
    else if (code < COMPONENT_CASE_COUNT + 128) "individual ASCII code unit"
    else "ordered duplicate arguments"

  pure def arg(name: List[int], kind: int, units: List[int], number: int): Argument = {
    val absolute = if (number < 0) -number else number
    { name: name, kind: kind, text: units, integer: number,
      magnitude: List(absolute / 1000000000, absolute % 1000000000), negative: number < 0 }
  }
  pure def normalizationCase(code: int): List[Argument] =
    if (code == 0) List()
    else if (code == 1) List(arg(List(97), OMITTED, List(), 0))
    else if (code == 2) List(arg(List(122), NULL, List(), 0), arg(List(97), FALSE, List(), 0),
      arg(List(98), TRUE, List(), 0), arg(List(100), INTEGER, List(), 0), arg(List(99), TEXT, List(), 0),
      arg(List(101), OMITTED, List(), 0))
    else if (code == 3) List(arg(List(122), INTEGER, List(), -9007199254740991),
      arg(List(97), INTEGER, List(), 9007199254740991), arg(List(98), INTEGER, List(), -17))
    else if (code == 4) List(arg(List(122), BIGINT, List(), 9007199254740991123),
      arg(List(97), BIGINT, List(), -9007199254740991123), arg(List(98), BIGINT, List(), 0))
    else if (code == 5) List(arg(List(57344), TEXT, List(98), 0), arg(List(55357, 56832), TEXT, List(97), 0),
      arg(List(65535), TEXT, List(99), 0), arg(List(55295), TEXT, List(100), 0))
    else if (code == 6) List(arg(List(97, 97), TEXT, List(49), 0), arg(List(97), TEXT, List(50), 0),
      arg(List(), TEXT, List(51), 0), arg(List(97, 0), TEXT, List(52), 0))
    else if (code == 7) List(arg(List(233), TEXT, List(233), 0), arg(List(101, 769), TEXT, List(101, 769), 0))
    else if (code == 8) List(arg(List(50), INTEGER, List(), 2), arg(List(49, 48), INTEGER, List(), 10),
      arg(List(48, 49), INTEGER, List(), 1), arg(List(49), INTEGER, List(), 1))
    else if (code == 9) List(arg(List(97), TEXT, List(117, 110, 100, 101, 102, 105, 110, 101, 100), 0),
      arg(List(98), OMITTED, List(), 0), arg(List(99), TEXT, List(110, 117, 108, 108), 0), arg(List(100), NULL, List(), 0))
    else if (code == 10) List(arg(List(110), BIGINT, List(), 9007199254740992),
      arg(List(109), BIGINT, List(), -9007199254740992), arg(List(111), INTEGER, List(), 9007199254740991))
    else if (code == 11) List(arg(List(65), TEXT, List(32, 37, 38, 61), 0), arg(List(97), FALSE, List(), 0),
      arg(List(95), NULL, List(), 0), arg(List(90), TRUE, List(), 0))
    else List(arg(List(95,95,112,114,111,116,111,95,95), BIGINT, List(), 9007199254740992),
      arg(List(99,111,110,115,116,114,117,99,116,111,114), INTEGER, List(), 1),
      arg(List(116,111,83,116,114,105,110,103), TRUE, List(), 0))
  pure def normalizationLabel(code: int): str = List(
    "empty record", "omitted-only record", "primitive values", "signed safe integer limits",
    "signed large bigint decimal", "UTF-16 astral ordering", "prefix and empty names",
    "no Unicode normalization", "numeric-looking name order", "omitted versus literal text",
    "bigints beyond safe numbers", "case-sensitive punctuation order", "own prototype-like names").nth(code)
  pure def discriminator(code: int): List[int] =
    List(List(108, 111, 99, 97, 108), List(114, 101, 109, 111, 116, 101), List(115, 104, 97, 100, 111, 119)).nth(code)
  pure def cohortKey(code: int): KeyInput =
    if (code == 0) baseline
    else if (code == 1) { tracked: true, ...baseline }
    else if (code == 2) { id: List(), ...baseline }
    else if (code == 3) { id: List(55357, 56832), ...baseline }
    else if (code == 4) { namespace: List(233), id: List(38634), tracked: true, ...baseline }
    else if (code == 5) keyCase(KEY_CASE_COUNT - 1)
    else if (code == 6) { useCase: List(83, 104, 97, 100, 111, 119, 76, 97, 121, 101, 114, 115), id: List(48), tracked: true, ...baseline }
    else { useCase: List(66, 101, 104, 97, 118, 105, 111, 114), ...baseline }
  pure def inputFor(code: int): Input =
    if (code < KEY_CASE_COUNT) {
      name: "key", caseId: code, kind: KEY, label: keyLabel(code), key: keyCase(code),
      arguments: List(), discriminator: List()
    } else if (code < KEY_CASE_COUNT + NORMALIZE_CASE_COUNT) {
      val index = code - KEY_CASE_COUNT
      { name: "normalize", caseId: code, kind: NORMALIZE, label: normalizationLabel(index), key: baseline,
        arguments: normalizationCase(index), discriminator: List() }
    } else {
      val index = code - KEY_CASE_COUNT - NORMALIZE_CASE_COUNT
      { name: "cohort", caseId: code, kind: COHORT, label: "key-specific discriminator hash",
        key: cohortKey(index / 3), arguments: List(), discriminator: discriminator(index % 3) }
    }

  action init = all {
    input' = { name: "init", caseId: -1, kind: KEY, label: "initialization", key: baseline,
      arguments: List(), discriminator: List() },
    s' = { key: emptyKey, normalized: List(), hash: 0, below: false, equal: false, above: false }
  }
  action execute(given: Input): bool = all {
    input' = given,
    val key = if (given.kind == NORMALIZE) emptyKey else constructKey(given.key)
    val hash = if (given.kind == COHORT) cohortHash(key.logical, given.discriminator) else 0
    s' = { key: key, normalized: if (given.kind == NORMALIZE) normalizeArguments(given.arguments) else List(),
      hash: hash,
      below: if (given.kind == COHORT) cohortAdmits(hash, thresholdForRelation(hash, BELOW_SAMPLE)) else false,
      equal: if (given.kind == COHORT) cohortAdmits(hash, thresholdForRelation(hash, AT_SAMPLE)) else false,
      above: if (given.kind == COHORT) cohortAdmits(hash, thresholdForRelation(hash, ABOVE_SAMPLE)) else false }
  }
  action step = {
    nondet code = 0.to(CASE_COUNT - 1).oneOf()
    execute(inputFor(code))
  }
  // Deterministic export visits each declared external input once; random
  // exploration above remains free to sample any independent primitive call.
  action exportStep = all {
    input.caseId + 1 < CASE_COUNT,
    execute(inputFor(input.caseId + 1))
  }

  // Checks deliberately inspect syntax and associations rather than calling
  // constructKey/normalizeArguments/cohortAdmits on both sides.
  val keyAcceptanceRespectsTextAndHashTagDomain = input.name != "init" and input.kind != NORMALIZE implies {
    val parts = List(input.key.namespace, input.key.keyType, input.key.id, input.key.useCase)
      .concat(input.key.args.foldl(List(), (components, pair) => components.append(pair.name).append(pair.value)))
    val braceSensitive = if (input.key.tracked)
      List(input.key.namespace, input.key.keyType, input.key.id) else List(input.key.namespace)
    s.key.valid iff (parts.indices().forall(i => validUtf16(parts.nth(i)))
      and braceSensitive.indices().forall(i => braceSensitive.nth(i).indices().forall(j =>
        braceSensitive.nth(i).nth(j) != 123 and braceSensitive.nth(i).nth(j) != 125)))
  }
  val rejectedKeysExposeNoPartialIdentity = not(s.key.valid) implies all {
    s.key.logical.length() == 0, s.key.valueKey.length() == 0, s.key.watermark.length() == 0
  }
  val successfulKeysHaveOneOperationDelimiter = s.key.valid implies all {
    s.key.logical.select(unit => unit == 35).length() == 1,
    s.key.logical.indices().forall(i => s.key.logical.nth(i) < 128),
    s.key.valueKey == s.key.logical.concat(FRAME_SUFFIX),
    s.key.logical.select(unit => unit == 123).length() == (if (input.key.tracked) 1 else 0),
    s.key.logical.select(unit => unit == 125).length() == (if (input.key.tracked) 1 else 0),
    s.key.logical.select(unit => unit == 61).length() == input.key.args.length(),
    s.key.watermark.length() > 0 iff input.key.tracked
  }
  val normalizedNamesAreOrderedAndValuesAssociated = input.kind == NORMALIZE implies all {
    s.normalized.length() == input.arguments.select(arg => arg.kind != OMITTED).length(),
    s.normalized.indices().forall(i => input.arguments.indices().exists(j => all {
      input.arguments.nth(j).kind != OMITTED,
      input.arguments.nth(j).name == s.normalized.nth(i).name,
      s.normalized.nth(i).value == argumentText(input.arguments.nth(j))
    })),
    s.normalized.indices().forall(i => s.normalized.indices().forall(j =>
      i < j implies textBefore(s.normalized.nth(i).name, s.normalized.nth(j).name)))
  }
  val normalizedIntegersRetainExactMagnitude = input.kind == NORMALIZE implies
    input.arguments.indices().forall(i => {
      val original = input.arguments.nth(i)
      original.kind >= INTEGER implies s.normalized.indices().exists(j => {
        val pair = s.normalized.nth(j)
        val negative = pair.value.length() > 0 and pair.value.nth(0) == 45
        val digits = if (negative) pair.value.slice(1, pair.value.length()) else pair.value
        all {
          pair.name == original.name,
          digits.length() > 0,
          digits.indices().forall(k => digits.nth(k) >= 48 and digits.nth(k) <= 57),
          digits.length() == 1 or digits.nth(0) != 48,
          digits.foldl(0, (number, digit) => number * 10 + digit - 48)
            * (if (negative) -1 else 1) == original.integer,
          negative iff original.integer < 0
        }
      })
    })
  val cohortNumeratorsAreUnsignedAndBoundariesStrict = input.kind == COHORT implies all {
    s.hash >= 0, s.hash < 4294967296, not(s.below), not(s.equal), s.above
  }

  val allKeyContractsHold = keyAcceptanceRespectsTextAndHashTagDomain
    and rejectedKeysExposeNoPartialIdentity and successfulKeysHaveOneOperationDelimiter
    and normalizedNamesAreOrderedAndValuesAssociated and normalizedIntegersRetainExactMagnitude
    and cohortNumeratorsAreUnsignedAndBoundariesStrict
  run allCasesTest = init.then(CASE_COUNT.reps(i => execute(inputFor(i)).expect(allKeyContractsHold)))
  run encodingSeparatesReservedDelimitersTest = init
    .then(execute(inputFor(2 * 12 + 4)))
    .expect(s.key.logical == List(117,114,110,58,105,100,58,37,50,48,37,51,65,37,50,70,37,51,70,37,50,51,37,53,66,37,53,68,37,52,48,37,50,52,37,50,54,37,50,66,37,50,67,37,51,66,37,51,68,35,71,101,116))
  run surrogatePairEncodesOneFourByteScalarTest = init
    .then(execute(inputFor(15 * 12 + 4)))
    .expect(s.key.logical == List(117,114,110,58,105,100,58,37,70,48,37,57,70,37,57,56,37,56,48,35,71,101,116))
  run malformedUtf16RejectsInsteadOfReplacementTest = init
    .then(execute(inputFor(17 * 12 + 4))).expect(not(s.key.valid))
  run bracesDependOnEntityTrackingTest = init
    .then(execute(inputFor(4 * 12 + 4))).expect(s.key.valid)
    .then(execute(inputFor(4 * 12 + 5))).expect(not(s.key.valid))
  run normalizedNamesUseUtf16OrderingTest = init
    .then(execute(inputFor(KEY_CASE_COUNT + 5)))
    .expect(s.normalized.foldl(List(), (names, pair) => names.append(pair.name))
      == List(List(55295), List(55357,56832), List(57344), List(65535)))
  run normalizedPrimitivesPreserveFalsyAndOmittedValuesTest = init
    .then(execute(inputFor(KEY_CASE_COUNT + 2)))
    .expect(s.normalized == List(
      { name: List(97), value: List(102,97,108,115,101) },
      { name: List(98), value: List(116,114,117,101) },
      { name: List(99), value: List() },
      { name: List(100), value: List(48) },
      { name: List(122), value: List(110,117,108,108) }))
  run signedBigintsPreserveEveryDecimalDigitTest = init
    .then(execute(inputFor(KEY_CASE_COUNT + 4)))
    .expect(s.normalized.nth(0).value == List(45,57,48,48,55,49,57,57,50,53,52,55,52,48,57,57,49,49,50,51)
      and s.normalized.nth(1).value == List(48)
      and s.normalized.nth(2).value == List(57,48,48,55,49,57,57,50,53,52,55,52,48,57,57,49,49,50,51))
  run orderedKeyArgumentsRetainDuplicatesTest = init
    .then(execute(inputFor(KEY_CASE_COUNT - 4)))
    .expect(s.key.logical == List(117,114,110,58,105,100,58,49,63,122,61,50,38,97,61,49,38,122,61,51,35,71,101,116))
  run trackedArgumentsDoNotChangeWatermarkTest = init
    .then(execute(inputFor(KEY_CASE_COUNT - 3)))
    .expect(s.key.watermark == List(123,117,114,110,58,105,100,58,49,125,35,119,97,116,101,114,109,97,114,107))
    .then(execute(inputFor(KEY_CASE_COUNT - 1)))
    .expect(s.key.watermark == List(123,117,114,110,58,105,100,58,49,125,35,119,97,116,101,114,109,97,114,107))
  run publishedCohortNumeratorsRemainStableTest = init
    .then(execute(inputFor(KEY_CASE_COUNT + NORMALIZE_CASE_COUNT + 6 * 3 + 2)))
    .expect(s.hash == 3203834406)
    .then(execute(inputFor(KEY_CASE_COUNT + NORMALIZE_CASE_COUNT + 7 * 3)))
    .expect(s.hash == 4292886220)
    .then(execute(inputFor(KEY_CASE_COUNT + NORMALIZE_CASE_COUNT + 7 * 3 + 1)))
    .expect(s.hash == 1018911151)
}
