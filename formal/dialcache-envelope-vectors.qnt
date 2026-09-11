module dialcache_envelope_vectors {
  import wire_text.* from "./wire-text"

  // W06/W07/W08: the envelope owns marker escaping, reader fallback and
  // compression selection. The native codec is an environment boundary:
  // decoded fixture bytes and each encoder's byte count are explicit inputs.
  // Native replay verifies that correspondence using the real codecs, then
  // calls the real wrapper. Exact zstd output bytes are not a portable promise.
  // Reading deliberately has no dependency on the policy for NEW writes.
  type Request = {
    command: str, id: int, label: str, binary: bool,
    bytes: List[int], units: List[int], thresholdBytes: int, maximum: int,
    codecTsBytes: int, codecGoBytes: int,
    decoderSucceeds: bool, decodedBytes: List[int], writeEnabled: bool
  }
  type ReadResult = { binary: bool, bytes: List[int], scalars: List[int], outcome: str }
  type WriteResult = { outcome: str, storedBytes: int, marker: int }
  type Result = {
    escaped: List[int], originalBytes: int, read: ReadResult,
    typescript: WriteResult, go: WriteResult
  }
  pure val NO_READ: ReadResult = {
    binary: true, bytes: List(), scalars: List(), outcome: "pending"
  }
  pure val NO_WRITE: WriteResult = { outcome: "pending", storedBytes: 0, marker: -1 }
  pure val EMPTY: Result = {
    escaped: List(), originalBytes: 0, read: NO_READ,
    typescript: NO_WRITE, go: NO_WRITE
  }
  pure val DEFAULT: Request = {
    command: "init", id: -1, label: "", binary: true,
    bytes: List(), units: List(), thresholdBytes: 1, maximum: 536870912,
    codecTsBytes: 0, codecGoBytes: 0,
    decoderSucceeds: false, decodedBytes: List(), writeEnabled: true
  }

  pure def payloadBytes(request: Request): List[int] =
    if (request.binary) request.bytes else utf8FromUtf16(request.units)
  pure def escapedRaw(binary: bool, bytes: List[int]): List[int] =
    if (binary and bytes.length() > 0 and bytes.nth(0) <= 2)
      List(0).concat(bytes) else bytes

  pure def readEnvelope(request: Request): ReadResult = {
    val raw = payloadBytes(request)
    val unchanged = {
      binary: request.binary,
      bytes: if (request.binary) raw else List(),
      scalars: if (request.binary) List() else utf8Scalars(raw),
      outcome: "passthrough"
    }
    if (not(request.binary) or raw.length() == 0) unchanged
    else if (raw.nth(0) == 0) {
      // Strip exactly one escape only for prefixes the writer can produce.
      // An escaped compressed marker is literal data, never a second decode.
      if (raw.length() > 1 and raw.nth(1) <= 2)
        { bytes: raw.slice(1, raw.length()), ...unchanged }
      else unchanged
    } else if (raw.nth(0) != 1 and raw.nth(0) != 2) unchanged
    else if (not(request.decoderSucceeds)) { outcome: "fallback_raw", ...unchanged }
    else if (request.decodedBytes.length() > request.maximum)
      { outcome: "read_over_limit", ...unchanged }
    else {
      binary: raw.nth(0) == 2,
      bytes: if (raw.nth(0) == 2) request.decodedBytes else List(),
      scalars: if (raw.nth(0) == 1) utf8Scalars(request.decodedBytes) else List(),
      outcome: "decompressed"
    }
  }

  pure def selectWrite(request: Request, codecBytes: int): WriteResult = {
    val raw = payloadBytes(request)
    val escaped = escapedRaw(request.binary, raw)
    val uncompressed = { outcome: "below_threshold", storedBytes: escaped.length(), marker: -1 }
    if (raw.length() < request.thresholdBytes) uncompressed
    else if (raw.length() > request.maximum) { outcome: "write_over_limit", ...uncompressed }
    else if (codecBytes + 1 >= escaped.length()) { outcome: "not_smaller", ...uncompressed }
    else { outcome: "compressed", storedBytes: codecBytes + 1,
      marker: if (request.binary) 2 else 1 }
  }
  pure def evaluate(request: Request): Result = {
    val bytes = payloadBytes(request)
    { escaped: escapedRaw(request.binary, bytes), originalBytes: bytes.length(),
      read: if (request.command == "write") NO_READ else readEnvelope(request),
      typescript: if (request.command == "write") selectWrite(request, request.codecTsBytes) else NO_WRITE,
      go: if (request.command == "write") selectWrite(request, request.codecGoBytes) else NO_WRITE }
  }

  pure def repeated(pattern: List[int], count: int): List[int] =
    0.to(count - 1).fold(List(), (output, ignored) => output.concat(pattern))
  pure val RAW_INPUTS = List(
    List(), List(0), List(1), List(2), List(3), List(255),
    List(0,0), List(0,1), List(0,2), List(0,3), List(0,255),
    List(0,0,1), List(1,255), List(2,255), List(3,0)
  )
  // Fixed raw-block zstd fixtures, not an implementation of the compressor.
  // Their decoder correspondence is independently checked by both bindings.
  pure def rawBlockFixture(bytes: List[int]): List[int] =
    List(40,181,47,253,32,bytes.length(),bytes.length()*8+1,0,0).concat(bytes)
  pure val DECODED_FIXTURES = List(
    List(), List(97,98,99), List(0,1,2), List(255), List(226,130),
    List(226,130,65), List(237,160,128), List(239,187,191,65),
    List(240,159,152,128), List(244,144,128,128)
  )
  pure val DECODER_FIXTURES = DECODED_FIXTURES.length() + 3
  pure def decoderFixture(index: int): Request =
    if (index < DECODED_FIXTURES.length()) {
      bytes: rawBlockFixture(DECODED_FIXTURES.nth(index)),
      decodedBytes: DECODED_FIXTURES.nth(index), decoderSucceeds: true, ...DEFAULT
    } else {
      bytes: List(List(255), List(40,181), List(40,181,47,253)).nth(index-DECODED_FIXTURES.length()),
      ...DEFAULT
    }

  // Recorded level-3 native encoder lengths. These are environment inputs,
  // not expected wrapper outcomes. Every native replay verifies its length.
  pure def writeFixture(index: int): Request = {
    val textLengths = List(17,18,19)
    if (index == 0) { binary: false, units: List(120), codecTsBytes: 10, codecGoBytes: 10, label: "short", ...DEFAULT }
    else if (index <= 3) { binary: false, units: repeated(List(97),textLengths.nth(index-1)),
      codecTsBytes: 17, codecGoBytes: 10, label: "text-size-boundary", ...DEFAULT }
    else if (index <= 7) { bytes: List(1).concat(repeated(List(97),index+12)),
      codecTsBytes: 17, codecGoBytes: if (index == 4) 26 else 18,
      label: "escaped-size-boundary", ...DEFAULT }
    else if (index <= 10) { bytes: List(List(0,2,3).nth(index-8)).concat(repeated(List(97),18)),
      codecTsBytes: 17, codecGoBytes: 18, label: "binary-marker-class", ...DEFAULT }
    else if (index == 11) { binary: false, units: repeated(List(233),32),
      codecTsBytes: 17, codecGoBytes: 18, label: "utf8-byte-threshold", ...DEFAULT }
    else if (index == 12) { binary: false, units: repeated(List(55357,56832),16),
      codecTsBytes: 19, codecGoBytes: 20, label: "supplementary-byte-threshold", ...DEFAULT }
    else { binary: false, units: repeated(List(100,105,97,108,99,97,99,104,101,32),16),
      codecTsBytes: 26, codecGoBytes: 27, label: "compressible", ...DEFAULT }
  }
  pure val WRITE_FIXTURES = 14
  pure val ENVELOPES = RAW_INPUTS.length()
  pure val DECODES = DECODER_FIXTURES * 2 * 2 * 3
  pure val WRITES = WRITE_FIXTURES * 3 * 3
  pure val CASE_COUNT = ENVELOPES + DECODES + WRITES
  pure def atLeastOne(value: int): int = if (value < 1) 1 else value
  pure def requestFor(id: int): Request =
    if (id < ENVELOPES) { command: "envelope", id: id, bytes: RAW_INPUTS.nth(id), ...DEFAULT }
    else if (id < ENVELOPES + DECODES) {
      val index = id - ENVELOPES
      val fixture = decoderFixture(index / 12)
      { command: "decode", id: id, bytes: List(1 + index%2).concat(fixture.bytes),
        maximum: atLeastOne(fixture.decodedBytes.length() + (index/4)%3 - 1),
        writeEnabled: (index/2)%2 == 1, ...fixture }
    } else {
      val index = id - ENVELOPES - DECODES
      val fixture = writeFixture(index / 9)
      val byteCount = payloadBytes(fixture).length()
      { command: "write", id: id,
        thresholdBytes: atLeastOne(byteCount + index%3 - 1),
        maximum: byteCount + (index/3)%3 - 1, ...fixture }
    }

  var input: Request
  var result: Result
  action init = all { input' = DEFAULT, result' = EMPTY }
  action execute(request: Request): bool = all { input' = request, result' = evaluate(request) }
  action step = { nondet id = 0.to(CASE_COUNT-1).oneOf(); execute(requestFor(id)) }

  val rawEscapeIsLossless = input.command == "init" or {
    val raw = payloadBytes(input)
    if (input.binary and raw.length() > 0 and raw.nth(0) <= 2)
      result.escaped.length() == raw.length()+1 and result.escaped.nth(0) == 0
        and result.escaped.slice(1,result.escaped.length()) == raw
    else result.escaped == raw
  }
  val readFailuresPreserveOriginalBinary =
    not(Set("fallback_raw","read_over_limit").contains(result.read.outcome)) or
      (result.read.binary and result.read.bytes == input.bytes)
  val readDoesNotConsultNewWritePolicy = input.command != "decode" or
    result.read == readEnvelope({ writeEnabled: not(input.writeEnabled), ...input })
  val escapeConsumesExactlyOnePrefix = input.command == "init" or input.command == "write" or
    not(input.binary) or input.bytes.length() < 2 or input.bytes.nth(0) != 0 or input.bytes.nth(1) > 2 or
      (result.read.outcome == "passthrough" and result.read.binary
        and result.read.bytes == input.bytes.slice(1,input.bytes.length()))
  val successfulReadRespectsMarkerAndLimit = result.read.outcome != "decompressed" or
    (input.decoderSucceeds and input.decodedBytes.length() <= input.maximum
      and result.read.binary == (input.bytes.nth(0) == 2)
      and (not(result.read.binary) or result.read.bytes == input.decodedBytes))
  def independentlyValidSelection(selected: WriteResult, codecBytes: int): bool = {
    val original = payloadBytes(input).length()
    val rawStored = original + (if (input.binary and original > 0 and input.bytes.nth(0) <= 2) 1 else 0)
    if (original < input.thresholdBytes)
      selected.outcome == "below_threshold" and selected.storedBytes == rawStored
    else if (original > input.maximum)
      selected.outcome == "write_over_limit" and selected.storedBytes == rawStored
    else if (codecBytes+1 < rawStored)
      selected.outcome == "compressed" and selected.storedBytes == codecBytes+1
        and selected.marker == (if (input.binary) 2 else 1)
    else selected.outcome == "not_smaller" and selected.storedBytes == rawStored
  }
  val compressionUsesByteThresholdAndStrictShrink = input.command != "write" or
    (independentlyValidSelection(result.typescript,input.codecTsBytes)
      and independentlyValidSelection(result.go,input.codecGoBytes))

  run allEnvelopeVectorsTest = init.then(CASE_COUNT.reps(i => execute(requestFor(i))
    .expect(rawEscapeIsLossless and readFailuresPreserveOriginalBinary
      and readDoesNotConsultNewWritePolicy and escapeConsumesExactlyOnePrefix
      and successfulReadRespectsMarkerAndLimit and compressionUsesByteThresholdAndStrictShrink)))
  run escapedCompressedMarkerRemainsLiteralTest = init
    .then(execute({ command: "envelope", bytes: List(0,1,255), decoderSucceeds: true, decodedBytes: List(65), ...DEFAULT }))
    .expect(result.read.outcome == "passthrough" and result.read.bytes == List(1,255))
  run unknownLegacyZeroPrefixRemainsUntouchedTest = init
    .then(execute({ command: "envelope", bytes: List(0,3,255), ...DEFAULT }))
    .expect(result.read.bytes == List(0,3,255))
  run corruptCompressionPreservesMarkedBytesTest = init
    .then(execute({ command: "decode", bytes: List(1,255), ...DEFAULT }))
    .expect(result.read.outcome == "fallback_raw" and result.read.bytes == List(1,255))
  run disabledNewWritesStillReadLegacyCompressionTest = init
    .then(execute({ command: "decode", bytes: List(1).concat(rawBlockFixture(List(97,98,99))),
      decoderSucceeds: true, decodedBytes: List(97,98,99), writeEnabled: false, ...DEFAULT }))
    .expect(result.read.outcome == "decompressed" and not(result.read.binary) and result.read.scalars == List(97,98,99))
  run decoderLimitKeepsRawBytesTest = init
    .then(execute({ command: "decode", bytes: List(2).concat(rawBlockFixture(List(97,98,99))),
      decoderSucceeds: true, decodedBytes: List(97,98,99), maximum: 2, ...DEFAULT }))
    .expect(result.read.outcome == "read_over_limit" and result.read.bytes == input.bytes)
  run utf8ThresholdCountsBytesTest = init
    .then(execute({ command: "write", thresholdBytes: 64, ...writeFixture(11) }))
    .expect(result.originalBytes == 64 and result.typescript.outcome == "compressed" and result.go.outcome == "compressed")
  run compressionTieKeepsRawRepresentationTest = init
    .then(execute({ command: "write", ...writeFixture(2) }))
    .expect(result.typescript.outcome == "not_smaller" and result.typescript.storedBytes == 18)
  run shrinkComparedWithEscapedRawBytesTest = init
    .then(execute({ command: "write", ...writeFixture(5) }))
    .expect(result.originalBytes == 18 and result.escaped.length() == 19
      and result.typescript.outcome == "compressed" and result.typescript.storedBytes == 18
      and result.go.outcome == "not_smaller")
  run thresholdPrecedesWriteLimitTest = init
    .then(execute({ command: "write", thresholdBytes: 19, maximum: 17, ...writeFixture(2) }))
    .expect(result.typescript.outcome == "below_threshold" and result.go.outcome == "below_threshold")
  run writeLimitPrecedesCompressionTest = init
    .then(execute({ command: "write", maximum: 17, ...writeFixture(2) }))
    .expect(result.typescript.outcome == "write_over_limit" and result.go.outcome == "write_over_limit")
}
