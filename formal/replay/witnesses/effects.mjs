// Pending-effect witnesses over the parsed effects trace: declared inputs,
// public counters/results/events and the model's private phase, deadline and
// fence predictions that identify which schedule the corpus actually reached.
export function effectsWitnesses(traces) {
  const witnesses = new Set();
  const diagnosticWitnesses = new Set();
  for (const trace of traces) {
    witnesses.add(`fixture:${trace.steps[0].choice}`);
    let budgetChanged = false;
    let delayedWriteWasFenced = false;
    const normalizedFenceSources = new Set();
    const normalizedReplies = new Map();
    let failedRead = false;
    let failedDecode = false;
    let acquiredAt;
    let decodeStarted = 0;
    for (const [index, step] of trace.steps.entries()) {
      const s = step.state;
      const previous = trace.steps[index - 1]?.state;
      if (step.action === "readBudgetPolicy") budgetChanged = true;
      if (!budgetChanged && previous?.readBudgets.length === 0 && s.readBudgets.length === 1) {
        witnesses.add(`initial-budget:${trace.steps[0].choice}`);
      }
      for (const event of s.events) {
        diagnosticWitnesses.add(`event:${event.event}`);
        if (event.event === "error" || event.event === "miss") diagnosticWitnesses.add(`${event.event}:${event.detail}`);
        if (event.event === "serialization" && event.amount > 0) diagnosticWitnesses.add(`duration:${event.detail}`);
      }
      if (step.action === "releaseRead" && previous !== undefined && previous.reply > 0 && previous.readStates[step.choice] === 0 && previous.now < previous.deadline) {
        diagnosticWitnesses.add(`reply:${previous.reply}`);
        if (previous.tracked === 1 && [7, 12, 16].includes(previous.reply) && s.phase === 1) normalizedFenceSources.add(s.activeLoader);
        if (previous.tracked === 0 && previous.reply === 16) diagnosticWitnesses.add("untracked-demotes-fenced-reply");
        if (s.phase === 1) normalizedReplies.set(s.activeLoader, previous.reply);
      }
      if (previous !== undefined && step.action === "resolveLoader" && previous.sources[step.choice] === 0 && previous.refill === 1 && previous.now < previous.deadline) {
        if (normalizedFenceSources.has(step.choice) && previous.observedFence > previous.wall && s.dumps === previous.dumps) diagnosticWitnesses.add("normalized-fence-blocks-publication");
        const reply = normalizedReplies.get(step.choice);
        if (reply !== undefined && s.observedFence === 0 && s.dumps === previous.dumps + 1) {
          diagnosticWitnesses.add(`normalized-reply-allows-refill:${reply}`);
        }
        if (reply !== undefined && s.observedFence > previous.wall && s.dumps === previous.dumps && s.calls.includes(1)) {
          diagnosticWitnesses.add(`normalized-reply-fences-refill:${reply}`);
        }
        if (step.choice === previous.activeLoader && previous.calls.filter(value => value === 0).length > 1) {
          witnesses.add("source-followers-share-accepted-result");
        }
      }
      for (const budget of s.readBudgets) witnesses.add(`read-budget:${budget}`);
      if (step.action === "beginCall" && previous?.phase === 3 && previous.readBudget !== previous.readBudgets[previous.activeRead]) witnesses.add("follower-keeps-read-budget");
      if (s.sources.includes(0) && s.sources.includes(1)) witnesses.add("abandoned-overlap");
      if (step.action === "seedRemote") delayedWriteWasFenced = false;
      if (previous?.phase === 3 && s.phase === 1) {
        failedRead = step.action === "failRead" || s.readAborts > previous.readAborts;
        failedDecode = false;
        if (s.readAborts > previous.readAborts) {
          witnesses.add("read-timeout-starts-source");
          if (step.action !== "tick") witnesses.add("read-late-settlement");
        }
      }
      if ((step.action === "releaseRead" || step.action === "failRead") && previous?.readStates[step.choice] === 1) {
        witnesses.add("abandoned-read-settles");
      }
      if (step.action === "releaseRead" && s.phase === 4) { acquiredAt = s.wall; decodeStarted = s.now; }
      if (step.action === "releaseLoad" && acquiredAt !== undefined) {
        if (s.now - decodeStarted >= 10) witnesses.add("decode-outlives-deadline");
        if (s.watermark >= acquiredAt) witnesses.add("acquired-hit-survives-invalidation");
        if (s.now - decodeStarted >= 10 && s.readAborts === previous?.readAborts && s.loaders === previous.loaders) {
          witnesses.add("successful-read-has-no-late-cancel");
        }
      }
      if (step.action === "failLoad") failedDecode = true;
      if (step.action === "resolveLoader" && previous?.sources[step.choice] === 0 && previous.now < previous.deadline) {
        if (failedRead && s.phase === 0 && s.dumps === previous.dumps) witnesses.add("failed-read-no-refill");
        if (failedDecode && s.dumps > previous.dumps) witnesses.add("failed-decode-refills");
      }
      if (step.action === "releaseDump" && s.phase === 0) witnesses.add("dump-rechecks-fence-after-rollback");
      if (step.action === "failDump") witnesses.add("dump-failure-preserves-value");
      if (step.action === "failWrite") witnesses.add("write-failure-preserves-value");
      if (step.action === "releaseDump" && previous !== undefined && previous.now >= previous.deadline) witnesses.add("serialize-outlives-deadline");
      if (step.action === "rejectLoader" && previous?.sources[step.choice] === 1 &&
        s.events.filter(event => event.event === "error" && event.detail === "fallback").length ===
          previous.events.filter(event => event.event === "error" && event.detail === "fallback").length &&
        s.calls.every((value, index) => value === previous.calls[index])) witnesses.add("late-rejection-does-not-repeat-error");
      if (step.action === "releaseWrite") {
        delayedWriteWasFenced = s.storedTimestamp <= s.watermark;
        if (previous !== undefined && previous.now >= previous.deadline) witnesses.add("publication-after-deadline");
      }
      // Require a later public read/refill to expose the stored stale write.
      if (delayedWriteWasFenced && step.action === "releaseRead" && previous?.phase === 3
        && s.loaders === previous.loaders + 1) witnesses.add("delayed-fenced-write");
      if (previous?.phase === 1 && previous.sources[step.choice] === 0 && previous.now >= previous.deadline
        && (step.action === "resolveLoader" || step.action === "rejectLoader")) {
        witnesses.add("late-settlement");
        witnesses.add(step.action === "resolveLoader" ? "late-resolve" : "late-reject");
      }
    }
  }
  return new Set([...witnesses, ...diagnosticWitnesses]);
}
