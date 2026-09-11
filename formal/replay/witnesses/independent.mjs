// Independent-call witnesses: public results, read IO and recovery outcomes,
// plus private call/read/load predictions that identify the schedule probed.
export function independentWitnesses(histories) {
  const seen = new Set();
  for (const { steps, states } of histories) {
    const recovered = new Map();
    for (const [i, step] of steps.entries()) {
      seen.add(`action:${step.action}`);
      if (i === 0) continue;
      const before = states[i - 1], previous = steps[i - 1].expected, o = step.expected;
      if (step.action === "beginCall" && states[i].reads.filter(r => r.active === true).length > 1) seen.add("independent-read-overlap");
      if (new Set(step.io.sourceErrors.filter(id => id > 0)).size >= 2) seen.add("independent-source-error-identities");
      if (step.io.budgets.includes(5) && step.io.budgets.includes(10)) seen.add("independent-read-budgets");
      if (step.io.aborted.length > steps[i - 1].io.aborted.length && o.calls.includes(0) &&
        states[i].reads.some(r => r.active === true)) seen.add("one-read-times-out-before-another");
      if ((step.action === "releaseRead" || step.action === "failRead") && before.reads[step.choice].active === false &&
        previous.calls.includes(0) && JSON.stringify(o) === JSON.stringify(previous)) seen.add("late-read-does-not-affect-other-call");
      if (step.action === "releaseLoad" || step.action === "failLoad") {
        const load = before.loads[step.choice], caller = load.caller, call = before.calls[caller];
        if (load.recovery === true && step.action === "failLoad" && o.calls[caller] === 3 && step.io.sourceErrors[caller] === call.source + 1) {
          seen.add("failed-recovery-keeps-source-error");
        }
        if (load.recovery === true && o.calls[caller] === load.value) {
          recovered.set(caller, o.calls[caller]);
          if (new Set(recovered.values()).size === 2) seen.add("distinct-retained-recovery-values");
          if (before.watermark >= call.created) seen.add("acquired-recovery-survives-invalidation");
        }
        if (load.recovery === false && step.action === "releaseLoad" && before.watermark >= call.acquiredAt) seen.add("acquired-fresh-decode-survives-invalidation");
        if (load.recovery === true && o.recovery.at(-1) === "miss" && before.calls.some(c => c.maxAge !== call.maxAge && c.phase !== 5)) seen.add("independent-recovery-age-boundary");
      }
      if (step.action === "resolveLoader" || step.action === "rejectLoader") {
        const source = before.sources[step.action === "rejectLoader" ? step.choice : Math.floor((step.choice - 1) / 2)];
        if (source.active === false && previous.calls.includes(0) && JSON.stringify(o) === JSON.stringify(previous)) seen.add("late-source-does-not-affect-other-call");
        if (o.writes > previous.writes && before.calls.some(c => c.phase === 2 && c.canWrite === false)) seen.add("refill-authority-is-per-call");
      }
      for (const outcome of o.recovery) seen.add(`recovery:${outcome}`);
      if (o.calls.includes(4)) seen.add("source-deadline");
    }
  }
  return seen;
}
