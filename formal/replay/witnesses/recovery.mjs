import { clockWitnesses } from "./policy.mjs";
import { flowLabels } from "./labels.mjs";

function recoveryScopeWitnesses(histories) {
  const seen = new Set();
  for (const { steps, states } of histories) {
    const memo = new Map();
    const probes = new Map();
    let closedDuringDecode = false, probeAfterClosedRecovery = false;
    for (const [i, step] of steps.entries()) {
      if (i === 0 || steps[0].choice < 4) continue;
      const before = states[i - 1], after = states[i];
      const previous = steps[i - 1].expected, o = step.expected;
      if (step.action === "closeScope") {
        memo.delete(step.choice);
        if (before.phase === 3 && before.attached[step.choice]) closedDuringDecode = true;
      }
      if (step.action === "releaseLoad" && o.recovery.length > previous.recovery.length && o.recovery.at(-1) === "served") {
        const group = o.recovery.length;
        for (const scope of [0, 1]) if (before.attached[scope] && !before.closed[scope]) {
          memo.set(scope, { value: after.memo[scope], group });
        }
        if (closedDuringDecode) probeAfterClosedRecovery = true;
        closedDuringDecode = false;
      } else if (step.action === "releaseLoad" || (step.action === "resolveLoader" && o.calls.some((v, j) => v > 0 && previous.calls[j] === 0))) {
        for (const scope of [0, 1]) if (before.attached[scope]) memo.delete(scope);
      }
      if (step.action === "releaseLoad") closedDuringDecode = false;
      if (step.action === "beginCall" || step.action === "joinCall") {
        const scope = step.action === "beginCall" ? Math.floor(step.choice / 4) : step.choice;
        const recovered = memo.get(scope);
        if (recovered !== undefined && o.calls.at(-1) === recovered.value && o.reads === previous.reads && o.loaders === previous.loaders) {
          seen.add("recovered-value-request-hit");
          const groupProbes = probes.get(recovered.group) ?? new Set();
          groupProbes.add(scope); probes.set(recovered.group, groupProbes);
          if (groupProbes.size === 2) seen.add("recovery-memoizes-both-requests");
        }
        if (probeAfterClosedRecovery && o.reads > previous.reads) { seen.add("closed-recovery-does-not-memoize-another-scope"); probeAfterClosedRecovery = false; }
      }
      if (step.action === "joinCall" && step.diagnostics.coalesced.length > steps[i - 1].diagnostics.coalesced.length && step.diagnostics.coalesced.at(-1) === "request_local") seen.add("request-follower-shares-recovery-flight");
    }
  }
  return seen;
}

// Stale-recovery flow witnesses over declared inputs, public results, recovery
// outcomes and fallback diagnostics. Classifier choices come from the init and
// beginCall inputs of the history, never from private model state.
export function recoveryWitnesses(histories) {
  const seen = new Set([...clockWitnesses("recovery", histories), ...recoveryScopeWitnesses(histories), ...flowLabels(histories, true)]);
  for (const { steps } of histories) {
    let invalidatedDuringFlight = false;
    let advancedDuringDecode = false;
    let decoding = false;
    let classifier = -1;
    let operationClassifier = -1;
    let recoveryCause = "";
    let recoveryErrorCount = 0;
    const abandoned = new Set();
    let currentSource = -1;
    for (const [i, step] of steps.entries()) {
      const o = step.expected;
      const previous = steps[i - 1]?.expected;
      if (previous === undefined) continue;
      if (step.action === "beginCall") {
        invalidatedDuringFlight = false; advancedDuringDecode = false; decoding = false;
      }
      if (step.action === "beginCall") { operationClassifier = step.choice % 4; recoveryErrorCount = step.diagnostics.fallbackErrors.length; }
      if (step.action === "beginCall") classifier = step.choice % 4 === 3 ? [3, 0, 1, 2][steps[0].choice % 4] : step.choice % 4;
      if (o.loaders > previous.loaders) {
        if (abandoned.size > 0) seen.add("recovery-abandoned-overlap");
        currentSource = o.loaders - 1; decoding = false;
      }
      const rejected = step.action === "rejectLoader" || step.action === "rejectTimeout";
      if (step.action === "advance" && currentSource >= 0 && !decoding &&
        (o.loads > previous.loads || o.recovery.length > previous.recovery.length || o.calls.some((c, i) => c === 4 && previous.calls[i] === 0))) {
        abandoned.add(currentSource);
        recoveryCause = "deadline";
        if (classifier === 1 && o.calls.includes(4)) {
          if (operationClassifier === 1) seen.add("explicit-denial-overrides-timeout");
          if (operationClassifier === 3 && steps[0].choice % 4 === 2) seen.add("instance-denial-overrides-timeout-default");
        }
      }
      if (rejected && !abandoned.has(step.choice)) {
        const instance = steps[0].choice % 4;
        if (instance === 1 && operationClassifier === 1 && o.calls.some((c, j) => c === 3 && previous.calls[j] === 0)) seen.add("operation-denial-overrides-instance-allow");
        if (instance === 3 && operationClassifier === 3 && o.calls.some((c, j) => c === 3 && previous.calls[j] === 0)) seen.add("instance-classifier-error-preserves-source");
        recoveryCause = step.action === "rejectTimeout" ? "propagated-timeout" : "source-error";
        if (classifier === 3 && step.action === "rejectLoader" && o.calls.includes(3) && o.loads === previous.loads) seen.add("default-denies-ordinary-error");
      }
      if ((rejected || step.action === "resolveLoader") && abandoned.has(step.choice)) {
        seen.add("recovery-late-source-settles"); abandoned.delete(step.choice);
      }
      if (o.loads > previous.loads && step.action !== "beginCall") decoding = true;
      if (o.recovery.length > previous.recovery.length && o.recovery.at(-1) === "served") {
        if (step.diagnostics.fallbackErrors.length === recoveryErrorCount + 1 && step.diagnostics.fallbackErrors.at(-1) === "remote") seen.add("recovery-keeps-source-failure-trail");
        if (steps[0].choice % 4 === 1 && operationClassifier === 3 && recoveryCause === "source-error") seen.add("instance-allow-recovers-ordinary-error");
        if (steps[0].choice % 4 === 2 && operationClassifier === 0) seen.add("operation-allow-overrides-instance-denial");
      }
      if (o.recovery.length > previous.recovery.length && o.recovery.at(-1) === "served" && classifier === 3) {
        seen.add(`default-recovers-${recoveryCause}`);
      }
      if (step.action === "releaseLoad" && o.recovery.at(-1) === "deserialization_error" && o.calls.some((c, i) => c === 4 && previous.calls[i] === 0)) seen.add("recovery-failure-preserves-timeout");
      if (step.action === "invalidate" && o.calls.includes(0)) invalidatedDuringFlight = true;
      if (step.action === "rejectLoader" && o.loads > previous.loads) decoding = true;
      if (step.action === "advance" && decoding) advancedDuringDecode = true;
      if (o.recovery.length > previous.recovery.length) {
        const outcome = o.recovery.at(-1);
        if (outcome === "served" && invalidatedDuringFlight) seen.add("retained-across-invalidation");
        if (outcome === "served" && previous.calls.filter(c => c === 0).length > 1) seen.add("coalesced-recovery");
        if (outcome === "miss" && step.action === "releaseLoad" && advancedDuringDecode) seen.add("expired-during-decode");
      }
    }
  }
  return seen;
}
