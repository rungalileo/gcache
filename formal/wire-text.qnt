module wire_text {
  // Portable text boundaries. Inputs/outputs are code-unit, scalar or byte
  // lists so a host's string decoder cannot silently become the model oracle.
  // Keys require valid UTF-16. Payload writers replace unpaired surrogates.
  // Readers replace one maximal ill-formed UTF-8 subpart and preserve the BOM.

  pure val REPLACEMENT = 65533
  pure def highSurrogate(unit: int): bool = unit >= 55296 and unit <= 56319
  pure def lowSurrogate(unit: int): bool = unit >= 56320 and unit <= 57343

  pure def scalarBytes(scalar: int): List[int] =
    if (scalar < 128) List(scalar)
    else if (scalar < 2048) List(192 + scalar / 64, 128 + scalar % 64)
    else if (scalar < 65536) List(224 + scalar / 4096, 128 + (scalar / 64) % 64, 128 + scalar % 64)
    else List(240 + scalar / 262144, 128 + (scalar / 4096) % 64,
      128 + (scalar / 64) % 64, 128 + scalar % 64)

  type Utf16Writer = { pendingHigh: int, bytes: List[int], valid: bool }
  pure def startUnit(state: Utf16Writer, unit: int): Utf16Writer =
    if (highSurrogate(unit)) { pendingHigh: unit, ...state }
    else if (lowSurrogate(unit)) {
      pendingHigh: -1, bytes: state.bytes.concat(scalarBytes(REPLACEMENT)), valid: false
    } else { pendingHigh: -1, bytes: state.bytes.concat(scalarBytes(unit)), ...state }

  pure def writeUnit(state: Utf16Writer, unit: int): Utf16Writer =
    if (state.pendingHigh < 0) startUnit(state, unit)
    else if (lowSurrogate(unit)) {
      pendingHigh: -1,
      bytes: state.bytes.concat(scalarBytes(65536 + (state.pendingHigh - 55296) * 1024 + unit - 56320)),
      ...state
    } else startUnit({ pendingHigh: -1,
      bytes: state.bytes.concat(scalarBytes(REPLACEMENT)), valid: false }, unit)

  pure def writtenUtf16(units: List[int]): Utf16Writer = {
    val folded = units.foldl({ pendingHigh: -1, bytes: List(), valid: true }, writeUnit)
    if (folded.pendingHigh < 0) folded else {
      pendingHigh: -1, bytes: folded.bytes.concat(scalarBytes(REPLACEMENT)), valid: false
    }
  }
  pure def utf8FromUtf16(units: List[int]): List[int] = writtenUtf16(units).bytes
  pure def validUtf16(units: List[int]): bool =
    units.indices().forall(i => units.nth(i) >= 0 and units.nth(i) <= 65535)
      and writtenUtf16(units).valid

  type Utf8Reader = {
    remaining: int, scalar: int, lower: int, upper: int, scalars: List[int]
  }
  pure def idleReader(output: List[int]): Utf8Reader = {
    remaining: 0, scalar: 0, lower: 128, upper: 191, scalars: output
  }
  pure def startByte(output: List[int], byte: int): Utf8Reader =
    if (byte < 128) idleReader(output.append(byte))
    else if (byte >= 194 and byte <= 223) {
      remaining: 1, scalar: byte - 192, lower: 128, upper: 191, scalars: output
    } else if (byte >= 224 and byte <= 239) {
      remaining: 2, scalar: byte - 224,
      lower: if (byte == 224) 160 else 128,
      upper: if (byte == 237) 159 else 191, scalars: output
    } else if (byte >= 240 and byte <= 244) {
      remaining: 3, scalar: byte - 240,
      lower: if (byte == 240) 144 else 128,
      upper: if (byte == 244) 143 else 191, scalars: output
    } else idleReader(output.append(REPLACEMENT))

  pure def readByte(state: Utf8Reader, byte: int): Utf8Reader =
    if (state.remaining == 0) startByte(state.scalars, byte)
    else if (byte < state.lower or byte > state.upper)
      // Consume the accepted prefix once; reconsider this invalid continuation
      // as a new lead. It may itself be ASCII, another lead, or an error.
      startByte(state.scalars.append(REPLACEMENT), byte)
    else {
      val completedScalar = state.scalar * 64 + byte - 128
      if (state.remaining == 1) idleReader(state.scalars.append(completedScalar))
      else { remaining: state.remaining - 1, scalar: completedScalar,
        lower: 128, upper: 191, ...state }
    }

  pure def utf8Scalars(bytes: List[int]): List[int] = {
    val read = bytes.foldl(idleReader(List()), readByte)
    if (read.remaining == 0) read.scalars else read.scalars.append(REPLACEMENT)
  }
}
