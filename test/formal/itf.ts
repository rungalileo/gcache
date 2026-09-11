export function record(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context}: expected a record`);
  }
  return value as Record<string, unknown>;
}

export function itfInteger(value: unknown, context: string): number {
  // This profile uses nonnegative safe integers. Reject precision loss rather
  // than silently rounding ITF's unbounded integers into JavaScript numbers.
  const text = record(value, context)["#bigint"];
  if (typeof text !== "string" || !/^(0|[1-9][0-9]*)$/.test(text)
    || !Number.isSafeInteger(Number(text))) {
    throw new Error(`${context}: expected a nonnegative safe ITF integer`);
  }
  return Number(text);
}

export function itfSignedInteger(value: unknown, context: string): number {
  const encoded = record(value, context);
  const text = encoded["#bigint"];
  if (Object.keys(encoded).join() !== "#bigint" || typeof text !== "string"
    || !/^(0|-?[1-9][0-9]*)$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new Error(`${context}: expected a signed safe ITF integer`);
  }
  return Number(text);
}
