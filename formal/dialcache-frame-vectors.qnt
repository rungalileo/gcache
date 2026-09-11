module dialcache_frame_vectors {
  import wire_text.* from "./wire-text"

  // W04/W05: concrete frame bytes, UTF-8 replacement and numeric acceptance.
  // A vector is an explicit primitive request followed by its Quint result.
  // The exporter translates representation only; both ports call their actual
  // codec/duration APIs. Core freshness and payload decompression are separate.
  pure val MAX_SAFE = 2^53 - 1
  pure val MAX_DURATION = 31536000000
  type NumberInput = { numeratorHigh: int, numeratorLow: int, denominator: int, special: str }
  type Request = {
    command: str, id: int, binary: bool, units: List[int], bytes: List[int],
    timestamp: NumberInput, tracked: bool, present: bool,
    watermarkPresent: bool, watermark: List[int]
  }
  type Result = {
    kind: str, payloadType: str, bytes: List[int], scalars: List[int], timestamp: int,
    reason: str, fence: int, duration: int
  }
  pure val EMPTY: Result = {
    kind: "pending", payloadType: "", bytes: List(), scalars: List(), timestamp: 0,
    reason: "", fence: -1, duration: 0
  }
  // Decimal limbs keep exported fields small enough for Quint 0.32's Rust
  // test exporter; the mathematical numerator remains exact inside Quint.
  pure def fraction(value: int, denominator: int): NumberInput = {
    numeratorHigh: value / 1000000, numeratorLow: value % 1000000, denominator: denominator, special: ""
  }
  pure def numerator(value: NumberInput): int = value.numeratorHigh * 1000000 + value.numeratorLow
  pure def integer(value: int): NumberInput = fraction(value, 1)
  pure val DEFAULT: Request = {
    command: "init", id: -1, binary: false, units: List(), bytes: List(),
    timestamp: integer(1), tracked: false, present: true,
    watermarkPresent: false, watermark: List()
  }
  pure def bigEndian(value: int): List[int] = List(7,6,5,4,3,2,1,0).foldl(List(), (bytes, i) => bytes.append((value / (256^i)) % 256))
  pure def timestampOf(bytes: List[int]): int = bytes.slice(1, 9).foldl(0, (value, byte) => value * 256 + byte)
  pure def validTimestamp(number: NumberInput): bool = number.special == ""
    and numerator(number) >= 0 and numerator(number) % number.denominator == 0
    and numerator(number) / number.denominator <= MAX_SAFE
  pure def framed(timestamp: int, encoding: int, payload: List[int]): List[int] =
    List(1).concat(bigEndian(timestamp)).append(encoding).concat(payload)
  pure def watermarkValue(bytes: List[int]): int = {
    val decimal = bytes.foldl(0, (value, byte) => value * 10 + byte - 48)
    if (bytes.length() > 0 and bytes.indices().forall(i => bytes.nth(i) >= 48 and bytes.nth(i) <= 57)
        and decimal <= MAX_SAFE) decimal else -1
  }
  pure def decode(request: Request): Result = {
    val fence = if (request.tracked and request.watermarkPresent) watermarkValue(request.watermark) else -1
    if (not(request.present)) { kind: "miss", reason: "value_absent", fence: fence, ...EMPTY }
    else if (request.bytes.length() < 10 or request.bytes.nth(0) != 1)
      { kind: "miss", reason: "unclassified", fence: fence, ...EMPTY }
    else if (request.tracked and request.watermarkPresent and fence < 0)
      { kind: "miss", reason: "unclassified", ...EMPTY }
    else {
      val timestamp = timestampOf(request.bytes)
      val encoding = request.bytes.nth(9)
      val payload = request.bytes.slice(10, request.bytes.length())
      if (request.tracked and timestamp == 0)
        { kind: "miss", reason: "unclassified", fence: fence, ...EMPTY }
      else if (request.tracked and fence >= 0 and timestamp <= fence)
        { kind: "miss", reason: "watermark_fenced", fence: fence, ...EMPTY }
      else if (encoding != 0 and encoding != 1) { kind: "payload_encoding_error", ...EMPTY }
      else { kind: "hit", timestamp: timestamp, payloadType: if (encoding == 1) "binary" else "string",
        bytes: if (encoding == 1) payload else List(),
        scalars: if (encoding == 0) utf8Scalars(payload) else List(), ...EMPTY }
    }
  }
  pure def evaluate(request: Request): Result =
    if (request.command == "encode") {
      if (not(validTimestamp(request.timestamp))) { kind: "timestamp_error", ...EMPTY }
      else { kind: "frame", bytes: framed(numerator(request.timestamp) / request.timestamp.denominator,
        if (request.binary) 1 else 0, if (request.binary) request.bytes else utf8FromUtf16(request.units)), ...EMPTY }
    } else if (request.command == "decode") decode(request)
    else if (request.command == "duration") {
      val number = request.timestamp
      val ceiled = if (numerator(number) <= 0) 0 else (numerator(number) + number.denominator - 1) / number.denominator
      if (number.special != "" or ceiled <= 0 or ceiled > MAX_DURATION) { kind: "duration_error", ...EMPTY }
      else { kind: "duration", duration: ceiled, ...EMPTY }
    } else EMPTY

  // External payloads partition UTF-8 leads/continuations, truncation, overlong
  // forms, surrogate encoding, scalar ceiling, BOM and binary identity.
  pure val BYTE_INPUTS = List(
    List(), List(0), List(65), List(127), List(128), List(255), List(192,128),
    List(194,128), List(223,191), List(194), List(194,65), List(226,130),
    List(226,130,65), List(224,159,191), List(224,160,128), List(237,159,191),
    List(237,160,128), List(239,187,191,65), List(239,191,191),
    List(240,143,191,191), List(240,144,128,128), List(244,143,191,191),
    List(244,144,128,128), List(245,128,128,128), List(240,144,128),
    List(226,194,162), List(128,128), List(65,0,66), List(240,159,152,128)
  )
  pure val UNIT_INPUTS = List(
    List(), List(65,0,66), List(127,128,2047,2048), List(65279,65),
    List(55296), List(56320), List(55296,65), List(55296,55296,56320),
    List(55357,56832), List(56319,57343), List(65535)
  )
  pure val STAMPS = List(0,1,255,256,4294967296,MAX_SAFE)
  pure val MARKERS = List(List(), List(), List(48), List(49), List(48,48,49), List(50),
    List(45,49), List(49,46,48), List(32,49), List(49,101,51),
    List(57,48,48,55,49,57,57,50,53,52,55,52,48,57,57,50))
  pure val NUMBERS = List(integer(-1), integer(0), fraction(1, 2),
    integer(1), fraction(1999, 1000),
    integer(MAX_DURATION), fraction(MAX_DURATION * 1000 - 1, 1000),
    fraction(MAX_DURATION * 1000 + 1, 1000),
    integer(MAX_DURATION + 1), integer(MAX_SAFE + 1),
    {special: "NaN", ...integer(0)},
    {special: "Infinity", ...integer(0)},
    {special: "-Infinity", ...integer(0)})
  pure val TEXT_WRITES = UNIT_INPUTS.length() * STAMPS.length()
  pure val BINARY_WRITES = BYTE_INPUTS.length() * 2
  pure val TEXT_READS = BYTE_INPUTS.length() * 4
  pure val DECODER_MATRIX = 2 * 5 * MARKERS.length() * 3
  pure val INVALID_WRITES = 6
  pure val CASE_COUNT = TEXT_WRITES + BINARY_WRITES + TEXT_READS + DECODER_MATRIX + INVALID_WRITES + NUMBERS.length()
  pure def requestFor(id: int): Request = {
    val binaryStart = TEXT_WRITES
    val textStart = binaryStart + BINARY_WRITES
    val matrixStart = textStart + TEXT_READS
    val invalidStart = matrixStart + DECODER_MATRIX
    val durationStart = invalidStart + INVALID_WRITES
    if (id < binaryStart) { command: "encode", id: id, units: UNIT_INPUTS.nth(id / STAMPS.length()), timestamp: integer(STAMPS.nth(id % STAMPS.length())), ...DEFAULT }
    else if (id < textStart) { command: "encode", id: id, binary: true, bytes: BYTE_INPUTS.nth((id-binaryStart)/2), timestamp: integer(if ((id-binaryStart)%2==0) 0 else MAX_SAFE), ...DEFAULT }
    else if (id < matrixStart) {
      val index = id - textStart
      val binary = index % 2 == 1
      { command: "decode", id: id, binary: binary, tracked: index % 4 >= 2,
        bytes: framed(256, if (binary) 1 else 0, BYTE_INPUTS.nth(index/4)), ...DEFAULT }
    } else if (id < invalidStart) {
      val index = id - matrixStart
      val encoding = index % 3
      val marker = (index/3) % MARKERS.length()
      val shape = (index/(3*MARKERS.length())) % 5
      { command: "decode", id: id, tracked: index >= DECODER_MATRIX/2,
        present: shape != 0, watermarkPresent: marker != 0, watermark: MARKERS.nth(marker),
        bytes: if (shape==1) List(1,0) else if (shape==2) List(2).concat(bigEndian(1)).append(encoding)
          else framed(if (shape==3) 0 else 1, encoding, List(65)), ...DEFAULT }
    } else if (id < durationStart) {
      val invalids = List(integer(-1), fraction(1, 2), integer(MAX_SAFE+1),
        {special: "NaN", ...integer(0)}, {special: "Infinity", ...integer(0)},
        {special: "-Infinity", ...integer(0)})
      { command: "encode", id: id, timestamp: invalids.nth(id-invalidStart), ...DEFAULT }
    } else { command: "duration", id: id, timestamp: NUMBERS.nth(id-durationStart), ...DEFAULT }
  }

  var input: Request
  var result: Result
  action init = all { input' = DEFAULT, result' = EMPTY }
  action execute(request: Request): bool = all { input' = request, result' = evaluate(request) }
  action step = { nondet id = 0.to(CASE_COUNT-1).oneOf(); execute(requestFor(id)) }

  val encodedFrameKeepsHeaderAndPayload = result.kind != "frame" or
    (result.bytes.nth(0) == 1 and result.bytes.nth(9) == (if (input.binary) 1 else 0)
      and timestampOf(result.bytes) == numerator(input.timestamp) / input.timestamp.denominator
      and (not(input.binary) or result.bytes.slice(10,result.bytes.length()) == input.bytes))
  val decodedTextContainsOnlyScalars = (result.kind != "hit" or all {
    result.payloadType == (if (input.bytes.nth(9) == 1) "binary" else "string"),
    if (result.payloadType == "binary") result.scalars.length() == 0 else result.bytes.length() == 0
  }) and result.scalars.indices().forall(i => {
    val scalar = result.scalars.nth(i)
    scalar >= 0 and scalar <= 1114111 and not(scalar >= 55296 and scalar <= 57343)
  })
  val trackedHitsStrictlyClearValidFence = result.kind != "hit" or not(input.tracked) or
    (result.timestamp > 0 and (not(input.watermarkPresent) or
      watermarkValue(input.watermark) >= 0 and result.timestamp > watermarkValue(input.watermark)))
  val absentValueKeepsItsOwnClassification = input.command != "decode" or input.present or
    (result.kind == "miss" and result.reason == "value_absent")
  val acceptedDurationWithinCeiling = result.kind != "duration" or
    (result.duration > 0 and result.duration <= MAX_DURATION
      and result.duration * input.timestamp.denominator >= numerator(input.timestamp)
      and (result.duration-1)*input.timestamp.denominator < numerator(input.timestamp))
  val writerRejectsInvalidNumericDomain = input.command != "encode" or
    ((result.kind == "frame") == (input.timestamp.special == ""
      and numerator(input.timestamp) >= 0
      and numerator(input.timestamp) <= MAX_SAFE * input.timestamp.denominator
      and numerator(input.timestamp) % input.timestamp.denominator == 0))

  run allFrameVectorsTest = init.then(CASE_COUNT.reps(i => execute(requestFor(i))
    .expect(encodedFrameKeepsHeaderAndPayload and decodedTextContainsOnlyScalars
      and trackedHitsStrictlyClearValidFence and absentValueKeepsItsOwnClassification
      and acceptedDurationWithinCeiling and writerRejectsInvalidNumericDomain)))
  run maximalSubpartConsumesAcceptedPrefixOnceTest = init
    .then(execute({ command: "decode", bytes: framed(1,0,List(226,130,65)), ...DEFAULT }))
    .expect(result.scalars == List(65533,65))
  run malformedSurrogateBytesRemainSeparateErrorsTest = init
    .then(execute({ command: "decode", bytes: framed(1,0,List(237,160,128)), ...DEFAULT }))
    .expect(result.scalars == List(65533,65533,65533))
  run payloadUnpairedSurrogateUsesReplacementTest = init
    .then(execute({ command: "encode", units: List(55296,65), ...DEFAULT }))
    .expect(result.bytes == List(1,0,0,0,0,0,0,0,1,0,239,191,189,65))
  run trackedFencePrecedesEncodingErrorTest = init
    .then(execute({ command: "decode", tracked: true, watermarkPresent: true,
      watermark: List(49), bytes: framed(1,255,List(65)), ...DEFAULT }))
    .expect(result.kind == "miss" and result.reason == "watermark_fenced" and result.fence == 1)
  run untrackedIgnoresMalformedWatermarkTest = init
    .then(execute({ command: "decode", watermarkPresent: true,
      watermark: List(45,49), bytes: framed(0,0,List(65)), ...DEFAULT }))
    .expect(result.kind == "hit" and result.timestamp == 0 and result.scalars == List(65))
  run physicalDurationRoundsUpWithinBoundTest = init
    .then(execute({ command: "duration", timestamp: fraction(1, 2), ...DEFAULT }))
    .expect(result.duration == 1)
    .then(execute({ command: "duration", timestamp: fraction(MAX_DURATION*1000+1, 1000), ...DEFAULT }))
    .expect(result.kind == "duration_error")
}
