module dialcache_redis_protocol {
  import cache_rules.* from "./cache-rules"
  // Abstract public Redis decoder classification. Exact bytes live in portable
  // protocol vectors; this model checks validation/classification precedence.
  // Selected rules from W04 and C33. Reply/frame/watermark/encoding fields are external
  // observations; result and observedWatermarkAttached record decoder output.
  // Payload bytes, UTF-8 conversion and numeric host boundaries are specified
  // in PROTOCOL.md and vectors. They are not reimplemented by this classifier.

  // Types and state

  type ReplyType = NilReply | BufferReply | InvalidReply
  type FrameShape = ShortFrame | UnknownVersion | SupportedFrame
  type WatermarkState = MissingWatermark | ValidWatermark | MalformedWatermark
  type PayloadEncoding = Utf8Encoding | BinaryEncoding | UnsupportedEncoding
  type DecodeResult =
    PendingDecode | ValueAbsent | UnclassifiedMiss | WatermarkFenced |
    DecodedHit | PayloadEncodingError | PayloadTypeError

  type State = {
    tracked: bool,
    valueReply: ReplyType,
    watermarkReply: ReplyType,
    frameShape: FrameShape,
    frameTimestamp: int,
    watermarkState: WatermarkState,
    watermarkValue: int,
    encoding: PayloadEncoding,
    result: DecodeResult,
    observedWatermarkAttached: bool
  }

  var s: State

  // Classification transition: ordering mirrors redis-payload.test.ts.
  // raw reply types -> nil/frame shape -> tracked watermark/fence -> encoding.
  pure def classify(st: State): DecodeResult =
    if (st.valueReply == InvalidReply or (st.tracked and st.watermarkReply == InvalidReply))
      PayloadTypeError
    else if (st.valueReply == NilReply)
      ValueAbsent
    else if (st.frameShape == ShortFrame or st.frameShape == UnknownVersion)
      UnclassifiedMiss
    else if (st.tracked and st.watermarkReply == BufferReply and st.watermarkState == MalformedWatermark)
      UnclassifiedMiss
    else if (st.tracked and st.frameTimestamp == 0)
      UnclassifiedMiss
    else if (st.tracked and st.watermarkReply == BufferReply and
      st.watermarkState == ValidWatermark and not(fenceAllows(st.frameTimestamp, st.watermarkValue)))
      WatermarkFenced
    else if (st.encoding == UnsupportedEncoding)
      PayloadEncodingError
    else
      DecodedHit

  // Initial state
  action init = s' = {
    tracked: false,
    valueReply: BufferReply,
    watermarkReply: NilReply,
    frameShape: SupportedFrame,
    frameTimestamp: 1,
    watermarkState: MissingWatermark,
    watermarkValue: 0,
    encoding: Utf8Encoding,
    result: PendingDecode,
    observedWatermarkAttached: false
  }

  // Environment transitions
  action toggleTracked = all {
    s.result == PendingDecode,
    s' = { tracked: not(s.tracked), ...s },
  }

  action cycleValueReply = all {
    s.result == PendingDecode,
    s' = {
      valueReply: if (s.valueReply == BufferReply) NilReply
        else if (s.valueReply == NilReply) InvalidReply
        else BufferReply,
      ...s
    },
  }

  action cycleWatermarkReply = all {
    s.result == PendingDecode,
    s' = {
      watermarkReply: if (s.watermarkReply == NilReply) BufferReply
        else if (s.watermarkReply == BufferReply) InvalidReply
        else NilReply,
      ...s
    },
  }

  action cycleFrameShape = all {
    s.result == PendingDecode,
    s' = {
      frameShape: if (s.frameShape == SupportedFrame) ShortFrame
        else if (s.frameShape == ShortFrame) UnknownVersion
        else SupportedFrame,
      ...s
    },
  }

  action setZeroTimestamp = all {
    s.result == PendingDecode,
    s' = { frameTimestamp: if (s.frameTimestamp == 0) 1 else 0, ...s },
  }

  action setFencedTimestamp = all {
    s.result == PendingDecode,
    s' = {
      frameTimestamp: 1,
      watermarkValue: 1,
      watermarkState: ValidWatermark,
      watermarkReply: BufferReply,
      ...s
    },
  }

  action cycleWatermarkState = all {
    s.result == PendingDecode,
    s' = {
      watermarkReply: BufferReply,
      watermarkState: if (s.watermarkState == MissingWatermark) ValidWatermark
        else if (s.watermarkState == ValidWatermark) MalformedWatermark
        else MissingWatermark,
      watermarkValue: 0,
      ...s
    },
  }

  action toggleEncoding = all {
    s.result == PendingDecode,
    s' = {
      encoding: if (s.encoding == Utf8Encoding) BinaryEncoding
        else if (s.encoding == BinaryEncoding) UnsupportedEncoding
        else Utf8Encoding,
      ...s
    },
  }

  action decode = all {
    s.result == PendingDecode,
    val decodedResult = classify(s)
    s' = {
      result: decodedResult,
      observedWatermarkAttached: s.tracked and s.watermarkReply == BufferReply and
        s.watermarkState == ValidWatermark and
        (decodedResult == ValueAbsent or decodedResult == UnclassifiedMiss or
         decodedResult == WatermarkFenced),
      ...s
    },
  }

  // Exploration order
  action step = any {
    toggleTracked,
    cycleValueReply,
    cycleWatermarkReply,
    cycleFrameShape,
    setZeroTimestamp,
    setFencedTimestamp,
    cycleWatermarkState,
    toggleEncoding,
    decode,
  }

  // Invariants: classification precedence is restated independently of classify.
  val nilValueIsValueAbsent =
    s.result == PendingDecode or s.valueReply != NilReply or
      s.result == ValueAbsent or s.result == PayloadTypeError

  val fenceCanPrecedeEncodingError =
    s.result == PendingDecode or
      ((s.result == WatermarkFenced) ==
        (s.tracked and s.valueReply == BufferReply and s.frameShape == SupportedFrame and
         s.frameTimestamp > 0 and s.watermarkReply == BufferReply and
         s.watermarkState == ValidWatermark and s.frameTimestamp <= s.watermarkValue))

  val malformedWatermarkPrecedesEncodingError =
    s.result == PendingDecode or
      not(s.tracked and s.valueReply == BufferReply and s.frameShape == SupportedFrame and
          s.watermarkReply == BufferReply and s.watermarkState == MalformedWatermark) or
      s.result == UnclassifiedMiss

  val trackedZeroTimestampIsNotHit =
    s.result == PendingDecode or not(s.tracked and s.frameTimestamp == 0) or
      s.result != DecodedHit

  val observedWatermarkOnlyOnTrackedReads =
    not(s.observedWatermarkAttached) or s.tracked

  // Nil and unsupported frames still require well-typed native replies. A
  // malformed decimal watermark is different from a non-bulk-string reply.
  val replyTypesAreValidatedFirst =
    s.result == PendingDecode or
      ((s.result == PayloadTypeError) ==
        (s.valueReply == InvalidReply or
         (s.tracked and s.watermarkReply == InvalidReply)))

  // A trustworthy watermark is retained even when the value cannot be read.
  // The independent predicate uses external frame facts, not classify/result,
  // so dropping the fence from a miss is observable to the property.
  val validMissWatermarksArePreserved =
    s.result == PendingDecode or
      (s.observedWatermarkAttached ==
        (s.tracked and s.watermarkReply == BufferReply and
         s.watermarkState == ValidWatermark and
         (s.valueReply == NilReply or
          (s.valueReply == BufferReply and
           (s.frameShape != SupportedFrame or s.frameTimestamp == 0 or
            s.frameTimestamp <= s.watermarkValue)))))

  val untrackedDecodingIgnoresWatermarks =
    s.result == PendingDecode or s.tracked or
      (not(s.observedWatermarkAttached) and
       s.result ==
         (if (s.valueReply == InvalidReply) PayloadTypeError
          else if (s.valueReply == NilReply) ValueAbsent
          else if (s.frameShape != SupportedFrame) UnclassifiedMiss
          else if (s.encoding == UnsupportedEncoding) PayloadEncodingError
          else DecodedHit))

  val unsupportedFramePrecedesEncodingError =
    s.result == PendingDecode or s.valueReply != BufferReply or
      s.frameShape == SupportedFrame or
      (s.tracked and s.watermarkReply == InvalidReply) or
      s.result == UnclassifiedMiss

  val encodingErrorRequiresSupportedFrame =
    s.result != PayloadEncodingError or
      (s.valueReply == BufferReply and s.frameShape == SupportedFrame and s.encoding == UnsupportedEncoding)

  // Deterministic regressions
  run fencedEncodingTest = init.then(toggleTracked).then(setFencedTimestamp)
    .then(toggleEncoding).then(toggleEncoding).then(decode)
    .expect(s.result == WatermarkFenced and fenceCanPrecedeEncodingError)

  run reversedPrecedenceIsDetectedTest = init.then(toggleTracked).then(setFencedTimestamp)
    .then(toggleEncoding).then(toggleEncoding)
    .then(all { s' = { result: PayloadEncodingError, ...s } })
    .expect(not(fenceCanPrecedeEncodingError))

  run malformedWatermarkTest = init.then(toggleTracked)
    .then(cycleWatermarkState).then(cycleWatermarkState)
    .then(toggleEncoding).then(toggleEncoding).then(decode)
    .expect(s.result == UnclassifiedMiss and malformedWatermarkPrecedesEncodingError)

  run absentValuePreservesWatermarkTest = init.then(toggleTracked)
    .then(setFencedTimestamp).then(cycleValueReply).then(decode)
    .expect(s.result == ValueAbsent and s.observedWatermarkAttached and
      validMissWatermarksArePreserved)

  run unsupportedFramePreservesWatermarkTest = init.then(toggleTracked)
    .then(setFencedTimestamp).then(cycleFrameShape).then(cycleFrameShape)
    .then(toggleEncoding).then(toggleEncoding).then(decode)
    .expect(s.result == UnclassifiedMiss and s.observedWatermarkAttached and
      validMissWatermarksArePreserved and unsupportedFramePrecedesEncodingError)

  run zeroTimestampPreservesWatermarkTest = init.then(toggleTracked)
    .then(setFencedTimestamp).then(setZeroTimestamp).then(decode)
    .expect(s.result == UnclassifiedMiss and s.observedWatermarkAttached and
      validMissWatermarksArePreserved)

  run droppedMissWatermarkIsDetectedTest = init.then(toggleTracked)
    .then(setFencedTimestamp).then(cycleValueReply).then(decode)
    .then(all { s' = { observedWatermarkAttached: false, ...s } })
    .expect(not(validMissWatermarksArePreserved))

  run invalidWatermarkReplyPrecedesAbsenceTest = init.then(toggleTracked)
    .then(cycleValueReply).then(cycleWatermarkReply).then(cycleWatermarkReply)
    .then(decode)
    .expect(s.result == PayloadTypeError and replyTypesAreValidatedFirst)

  run untrackedZeroIgnoresInvalidWatermarkReplyTest = init.then(setZeroTimestamp)
    .then(cycleWatermarkReply).then(cycleWatermarkReply).then(decode)
    .expect(s.result == DecodedHit and not(s.observedWatermarkAttached) and
      untrackedDecodingIgnoresWatermarks)

  run malformedWatermarkCannotReplaceAbsenceTest = init.then(toggleTracked)
    .then(cycleValueReply).then(cycleWatermarkState).then(cycleWatermarkState)
    .then(decode)
    .expect(s.result == ValueAbsent and not(s.observedWatermarkAttached) and
      nilValueIsValueAbsent)
}
