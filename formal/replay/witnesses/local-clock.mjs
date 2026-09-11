// Consequential coverage uses only the declared schedule and returned values /
// source counts. Private model timestamps never steer or credit the replay.
export function localClockWitnesses(traces) {
  const seen = new Set();
  for (const trace of traces) {
    let ticks = 0;
    const constructions = [undefined, undefined];
    const fills = [];
    const expirations = [];
    for (const [index, step] of trace.steps.entries()) {
      seen.add(`action:${step.action}`);
      if (step.action === "constructInstance") constructions[step.choice] = ticks;
      if (step.action === "advanceTicks") ticks += step.choice;
      if (step.action !== "call") continue;
      const instance = Math.floor(step.choice / 2);
      const offered = step.choice % 2 + 1;
      const before = trace.steps[index - 1].expected;
      const value = step.expected.calls.at(-1);
      const previous = fills[instance];
      const sourceDelta = step.expected.loaders - before.loaders;
      if (previous !== undefined && sourceDelta === 0 && value === previous.value
        && offered !== value && Math.floor(ticks / 1000) - Math.floor(previous.ticks / 1000) === 999) previous.hitBefore = true;
      if (sourceDelta === 1 && value === offered) {
        if (previous !== undefined && previous.hitBefore && offered !== previous.value
          && ticks % 1000 === 0 && Math.floor(ticks / 1000) - Math.floor(previous.ticks / 1000) === 1000) {
          if (previous.ticks % 1000 !== 0) seen.add("fractional-insertion-expiry");
          expirations.push({ instance, ticks, inserted: previous.ticks });
        }
        fills[instance] = { ticks, value, hitBefore: false };
      }
    }
    if (expirations.some(left => expirations.some(right => left.instance !== right.instance
      && left.ticks === right.ticks && Math.floor(left.inserted / 1000) === Math.floor(right.inserted / 1000)
      && constructions[left.instance] !== undefined && constructions[right.instance] !== undefined
      && constructions[left.instance] % 1000 !== constructions[right.instance] % 1000))) seen.add("shared-instance-grid");
  }
  return seen;
}
