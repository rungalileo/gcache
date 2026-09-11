export function record(value, context) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context}: expected a record`);
  }
  return value;
}
export function itfInteger(value, context) {
  // This profile uses nonnegative safe integers. Reject precision loss rather
  // than silently rounding ITF's unbounded integers into JavaScript numbers.
  const text = record(value, context)["#bigint"];
  if (Object.keys(record(value, context)).join() !== "#bigint"
      || typeof text !== "string" || !/^(0|[1-9][0-9]*)$/.test(text)
    || !Number.isSafeInteger(Number(text))) {
    throw new Error(`${context}: expected a nonnegative safe ITF integer`);
  }
  return Number(text);
}
export function itfSignedInteger(value, context) {
  const encoded = record(value, context);
  const text = encoded["#bigint"];
  if (Object.keys(encoded).join() !== "#bigint" || typeof text !== "string"
    || !/^(0|-?[1-9][0-9]*)$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new Error(`${context}: expected a signed safe ITF integer`);
  }
  return Number(text);
}

// The Quint input record is authoritative. Optional simulator annotations must
// agree with it, including the Some/None distinction for external choices.
export function assertInputMetadata(state, action, choice, hasChoice, context) {
  if (Object.hasOwn(state, "mbt::actionTaken") && state["mbt::actionTaken"] !== action) {
    throw new Error(`${context}: conflicting action metadata`);
  }
  if (!Object.hasOwn(state, "mbt::nondetPicks")) return;
  const picks = record(state["mbt::nondetPicks"], context);
  if (!hasChoice && Object.keys(picks).length === 0) return;
  if (Object.keys(picks).join() !== "choice") throw new Error(`${context}: unsupported choice metadata`);
  const pick = record(picks.choice, context);
  if (Object.keys(pick).sort().join() !== "tag,value") throw new Error(`${context}: malformed choice metadata`);
  if (hasChoice) {
    if (pick.tag !== "Some" || itfSignedInteger(pick.value, context) !== choice) {
      throw new Error(`${context}: conflicting choice metadata`);
    }
  } else {
    const none = record(pick.value, context);
    if (pick.tag !== "None" || Object.keys(none).join() !== "#tup"
        || !Array.isArray(none["#tup"]) || none["#tup"].length !== 0) {
      throw new Error(`${context}: unexpected choice metadata`);
    }
  }
}
