import { readFileSync } from "node:fs";

// Classify schedules only after both drivers have independently replayed their
// public observations. Private Quint state identifies the external boundary;
// each witness also requires its visible consequence, never merely an input.
// The committed smoke traces omit private state and are not coverage evidence.
type State = Record<string, unknown>;
type Observation = {
  calls: number[];
  reads: number;
  loads: number;
  loaders: number;
  classifications: number;
  dumps: number;
  writes: number;
  recovery: string[];
  shadow: string[];
};
type TraceState = { "mbt::actionTaken": string; s: State & { o: Observation } };

function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Object.hasOwn(record, "#bigint")) {
      const integer = Number(record["#bigint"]);
      if (!Number.isSafeInteger(integer)) throw new Error("Unsafe witness ITF integer");
      return integer;
    }
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, decode(item)]));
  }
  return value;
}
function number(state: State, name: string): number {
  const value = state[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Missing witness state integer: ${name}`);
  }
  return value;
}
function settled(before: Observation, after: Observation, value: number): boolean {
  return after.calls.some((result, index) => before.calls[index] === 0 && result === value);
}
function unchangedWork(before: Observation, after: Observation): boolean {
  return after.reads === before.reads && after.loads === before.loads
    && after.dumps === before.dumps && after.writes === before.writes;
}

function recoveryWitnesses(states: TraceState[], seen: Set<string>): void {
  const FRESH_DECODE = 1, SOURCE_RUNNING = 2, RECOVERY_DECODE = 3;
  let acquired: State | undefined;
  let acquisitionObservations: Observation | undefined;
  let failedFreshDecode = false;
  let decodeStartedAge: number | undefined;
  for (let index = 1; index < states.length; index++) {
    const before = states[index - 1]!.s, after = states[index]!.s;
    const previous = before.o, actual = after.o, action = states[index]!["mbt::actionTaken"];
    if (action === "beginCall" && actual.reads === previous.reads + 1) {
      acquired = before;
      acquisitionObservations = actual;
      failedFreshDecode = false;
      decodeStartedAge = undefined;
    }
    if (acquired === undefined || acquisitionObservations === undefined) continue;
    const ageAtRead = number(acquired, "wall") - number(acquired, "created");
    const ageNow = number(before, "wall") - number(before, "candidateCreated");
    const phase = number(before, "phase");
    if (number(after, "phase") === RECOVERY_DECODE && phase !== RECOVERY_DECODE) {
      // advance() delivers the source deadline before completing its clock jump.
      // Recovery decoding starts at that timer boundary, not at the final clock.
      const untilDeadline = action === "advance"
        ? number(before, "deadline") - number(before, "now") : 0;
      decodeStartedAge = ageNow + untilDeadline;
    }
    const initialBytesPresent = number(acquired, "frame") > 0
      && acquired.readFailed === false && number(acquired, "now") < number(acquired, "expires");
    const initialBytesUnfenced = number(acquired, "created") > number(acquired, "watermark");
    const appendedRecovery = actual.recovery.slice(previous.recovery.length);
    const noSharedWrite = actual.dumps === acquisitionObservations.dumps
      && actual.writes === acquisitionObservations.writes;
    const noReread = actual.reads === acquisitionObservations.reads;
    const returnsCandidate = settled(previous, actual, number(before, "candidate"));
    const returnsSourceError = settled(previous, actual, 3);
    const returnsDeadline = settled(previous, actual, 4);

    if (action === "releaseLoad" && phase === FRESH_DECODE) {
      failedFreshDecode = before.loadFailed === true;
      if (!failedFreshDecode && returnsCandidate && actual.loaders === acquisitionObservations.loaders
        && actual.recovery.length === previous.recovery.length && noSharedWrite) {
        if (ageAtRead === 0) seen.add("fresh-zero-age-skips-source");
        if (ageAtRead === 999) seen.add("last-fresh-age-skips-source");
      }
    }
    if (action === "resolveLoader" && phase === SOURCE_RUNNING
      && number(before, "candidate") > 0 && ageAtRead >= 1000
      && settled(previous, actual, 2) && actual.loads === previous.loads
      && actual.recovery.length === previous.recovery.length) {
      seen.add("source-success-skips-stale-decode");
    }
    if (action === "rejectLoader" && phase === SOURCE_RUNNING && returnsSourceError
      && actual.loads === previous.loads && noSharedWrite && noReread) {
      if (number(before, "classifier") === 2 && actual.classifications === previous.classifications + 1
        && number(before, "candidate") > 0 && ageNow >= 0 && ageNow < number(before, "acceptedMaxAge")) {
        seen.add("classifier-error-keeps-error-without-decode");
      }
      if (failedFreshDecode && actual.classifications === previous.classifications
        && appendedRecovery.length === 0) seen.add("failed-fresh-decode-is-not-recovery");
      if (acquired.readFailed === true && actual.classifications === previous.classifications
        && appendedRecovery.length === 0) seen.add("failed-initial-read-skips-recovery");
    }
    if (appendedRecovery.includes("miss") && phase === SOURCE_RUNNING
      && (returnsSourceError || returnsDeadline) && actual.loads === previous.loads
      && noReread && noSharedWrite) {
      // Isolate the rejection rule: a fenced or physically missing value cannot
      // establish that the age check itself prevented recovery, and vice versa.
      if (initialBytesPresent && initialBytesUnfenced) {
        if (ageAtRead === number(acquired, "maxAge")) seen.add("maximum-age-read-preserves-source-error");
        if (ageAtRead < 0) seen.add("future-read-preserves-source-error");
      }
      if (initialBytesPresent && !initialBytesUnfenced
        && ageAtRead >= 0 && ageAtRead < number(acquired, "maxAge")) {
        seen.add("fenced-read-does-not-retain");
      }
      if (number(before, "candidate") > 0 && ageNow >= number(before, "acceptedMaxAge")) {
        seen.add("maximum-age-before-decode-skips-load");
      }
    }
    if (action === "releaseLoad" && phase === RECOVERY_DECODE && noSharedWrite && noReread) {
      if (appendedRecovery.includes("served") && returnsCandidate) {
        if (ageAtRead === 1000) seen.add("first-stale-age-recovers-without-publication");
        if (ageNow === number(before, "acceptedMaxAge") - 1) seen.add("last-recovery-age-serves");
        if (ageNow >= 0 && ageNow < 1000 && ageAtRead >= 1000) seen.add("rollback-below-fresh-age-still-recovers");
        if (number(before, "frame") !== number(before, "candidate")) seen.add("replacement-cannot-change-recovered-value");
        const ages = (after.d as { ages: number[] }).ages;
        if (decodeStartedAge !== undefined && ageNow !== decodeStartedAge && ages.at(-1) === ageNow) {
          seen.add("recovery-age-sampled-at-successful-decode");
        }
      }
      if (appendedRecovery.includes("miss") && ageNow === number(before, "acceptedMaxAge")
        && (returnsSourceError || returnsDeadline)) seen.add("exact-maximum-after-decode-rejects");
    }
  }
}

// Normalize the published text/binary fixture encodings to byte identities.
// Whitespace-distinct JSON remains distinct even when decoded values agree.
function payloadBytes(payload: number): number {
  return ({ 3: 1, 4: 2, 6: 5, 8: 7 } as Record<number, number>)[payload] ?? payload;
}

function shadowWitnesses(states: TraceState[], seen: Set<string>): void {
  const C0_READ = 1, SNAPSHOT_DECODE = 3, CONFIRMATION_READ = 4;
  const FILL_SERIALIZE = 5, FILL_WRITE = 6;
  let c0Future = false, c0Fenced = false, failedReadWhileCallerPending = false;
  let callStart: Observation | undefined;
  for (let index = 1; index < states.length; index++) {
    const before = states[index - 1]!.s, after = states[index]!.s;
    const previous = before.o, actual = after.o, action = states[index]!["mbt::actionTaken"];
    const phase = number(before, "phase");
    const appended = actual.shadow.slice(previous.shadow.length);
    if (action === "beginCall") {
      callStart = actual; c0Future = false; c0Fenced = false; failedReadWhileCallerPending = false;
    }
    if (callStart === undefined) continue;
    const keepsCaller = JSON.stringify(previous.calls) === JSON.stringify(actual.calls);
    const noWrite = actual.writes === callStart.writes;
    if (action === "releaseRead" && phase === C0_READ && before.abandoned === false) {
      c0Future = number(before, "frame") > 0 && number(before, "created") > number(before, "wall")
        && number(before, "created") > number(before, "watermark") && before.readFailed === false;
      c0Fenced = number(before, "frame") > 0 && number(before, "created") <= number(before, "watermark")
        && before.readFailed === false;
      failedReadWhileCallerPending = previous.calls.at(-1) === 0 && appended.includes("redis_error");
    }
    if (action === "resolveLoader" && failedReadWhileCallerPending
      && (settled(previous, actual, 1) || settled(previous, actual, 2))
      && unchangedWork(previous, actual) && appended.length === 0) {
      seen.add("dark-read-error-still-allows-source-result");
    }
    if (appended.includes("filled") && actual.loads === callStart.loads && keepsCaller) {
      if (c0Future) seen.add("future-dark-c0-fills-without-decoding");
      if (c0Fenced) seen.add("fenced-dark-c0-can-fill-after-cutoff");
    }
    if (action === "releaseRead" && phase === CONFIRMATION_READ && keepsCaller && noWrite) {
      const sameBytes = payloadBytes(number(before, "frame")) === payloadBytes(number(before, "c0"));
      if (appended.includes("superseded") && number(before, "frame") > 0 && sameBytes
        && before.readFailed === false && number(before, "created") <= number(before, "watermark")) {
        seen.add("fenced-c1-supersedes-without-repair");
      }
      const visibleC1 = number(before, "frame") > 0
        && number(before, "created") > number(before, "watermark") && before.readFailed === false;
      if (visibleC1 && sameBytes && appended.includes("mismatch")) {
        seen.add("same-c1-bytes-confirm-mismatch");
        if (number(before, "created") > number(before, "wall")) {
          seen.add("future-c1-confirms-payload-without-repair");
        }
      }
      if (visibleC1 && !sameBytes && appended.includes("superseded")) {
        seen.add("different-c1-bytes-supersede");
      }
    }
    if (action === "releaseLoad" && phase === SNAPSHOT_DECODE && noWrite && keepsCaller) {
      if (appended.includes("match") && actual.reads === previous.reads) seen.add("equal-comparison-skips-c1");
      if (appended.includes("deserialization_error") && actual.dumps === previous.dumps) {
        seen.add("present-undecodable-c0-is-not-repaired");
      }
    }
    if (appended.includes("source_error") && noWrite && actual.loads === callStart.loads
      && actual.calls.at(-1) === 3) seen.add("dark-source-error-never-decodes-or-fills");
    if (action === "releaseDump" && phase === FILL_SERIALIZE && appended.includes("fill_error")
      && noWrite && keepsCaller) seen.add("fill-serialization-error-preserves-caller");
    if (action === "releaseWrite" && phase === FILL_WRITE && appended.includes("fill_error")
      && before.writeFailed === true && actual.writes === previous.writes && keepsCaller) {
      seen.add("fill-write-error-preserves-caller");
    }
    if (before.abandoned === true && keepsCaller && appended.length === 0
      && unchangedWork(previous, actual)) {
      if (action === "releaseRead" && phase === C0_READ) seen.add("late-c0-cannot-start-new-shadow-work");
      if (action === "releaseRead" && phase === CONFIRMATION_READ) seen.add("late-c1-cannot-emit-second-verdict");
      if (action === "releaseLoad" && phase === SNAPSHOT_DECODE) seen.add("late-shadow-decode-cannot-start-c1");
      if (action === "releaseDump" && phase === FILL_SERIALIZE) seen.add("late-shadow-dump-cannot-dispatch-write");
      if (action === "releaseWrite" && phase === FILL_WRITE) seen.add("late-shadow-write-cannot-change-caller-or-verdict");
    }
  }
}

export function recoveryShadowWitnesses(profile: string, paths: readonly string[]): Set<string> {
  const seen = new Set<string>();
  if (profile !== "recovery" && profile !== "shadow") return seen;
  for (const path of paths) {
    const trace = decode(JSON.parse(readFileSync(path, "utf8"))) as { states: TraceState[] };
    if (trace.states[0]?.s.phase === undefined) continue;
    if (profile === "recovery") recoveryWitnesses(trace.states, seen);
    else shadowWitnesses(trace.states, seen);
  }
  return seen;
}
