// These are reachability checks over replayed observations, not additional
// implementation state. A large corpus must not pass by missing its hard paths.
// Private predictions identify the schedules we sampled. A witness involving
// stored state is counted only when a later public call probes that prediction.
export function layersWitnesses(histories) {
  const seen = new Set();
  for (const { steps, states: predictions } of histories) {
    const mode = steps[0].choice;
    seen.add(`fixture:${mode}`);
    const calls = [];
    const evicted = new Set();
    const promoted = new Set();
    const preserved = new Set();
    const published = new Set();
    const validated = new Set();
    const invalidated = new Set();
    const fenced = new Map();
    const survivingOther = new Set();
    for (const [i, step] of steps.entries()) {
      seen.add(`action:${step.action}`);
      const previous = steps[i - 1]?.expected;
      if (previous === undefined) continue;
      const o = step.expected;
      const before = predictions[i - 1];
      const after = predictions[i];
      const ordersBefore = before.lru;
      const ordersAfter = after.lru;
      if (step.action === "invalidate") { invalidated.add(step.choice); fenced.set(step.choice, new Set()); }
      if (step.action === "beginCall") {
        const context = Math.floor(step.choice / 4), identity = step.choice % 4;
        const instance = context === 2 || context === 4 ? 1 : 0;
        const key = instance * 4 + identity;
        const policy = before.policy;
        const returned = o.calls.at(-1) > 0;
        const starts = o.loaders > previous.loaders;
        const read = o.reads > previous.reads;
        const remoteHit = o.loads > previous.loads;
        const localHit = context >= 3 && returned && !read && !starts && [0, 1, 3].includes(policy);
        if (!starts && !returned && calls.some((call, j) => previous.calls[j] === 0 && call.identity === identity
          && [0, 1].includes(call.context) && [0, 1].includes(context) && call.context !== context)
          && !calls.some((call, j) => previous.calls[j] === 0 && call.identity === identity && call.context === context)) seen.add("request-misses-share-process-flight");
        if (mode >= 2 && mode <= 3 && context >= 3 && !starts && !returned && [0, 1, 2, 3].includes(policy)) seen.add("zero-capacity-still-shares");
        if (mode >= 2 && mode <= 3 && context >= 3 && policy === 3 && starts
          && calls.some((call, j) => call.identity === identity && previous.calls[j] > 0)) seen.add("zero-capacity-reloads");
        if (mode >= 2 && mode <= 3 && context < 3 && policy === 4 && returned && !starts
          && before.memo.slice(context * 4, context * 4 + 4).filter(v => v > 0).length > 2) seen.add("request-memo-exceeds-local-capacity");
        if (localHit) {
          if (mode === 4) {
            seen.add("absent-remote-preserves-local-reuse");
            if (previous.maintenance.includes("missing_remote")) seen.add("absent-remote-maintenance-preserves-local");
          }
          if (ordersBefore[instance].length === 2 && ordersBefore[instance][0] === identity) { seen.add("lru-read-promotes"); promoted.add(key); }
          if (preserved.has(key)) seen.add("promoted-value-survives-eviction");
          if (survivingOther.has(key)) seen.add("capacity-is-per-instance");
          if (validated.has(key)) seen.add("validated-tracked-hit-warms-local");
          if (mode % 2 === 1 && invalidated.has(Math.floor(identity / 2))) seen.add("invalidation-preserves-local-hit");
        }
        if (context >= 3 && policy === 3 && starts && evicted.has(key)) seen.add("lru-eviction-probed");
        if (remoteHit && mode % 2 === 1) {
          validated.add(key);
          if (published.has(key)) seen.add("tracked-refill-needs-remote-validation");
        }
        const entity = Math.floor(identity / 2);
        const fencedBytes = before.remoteValues[identity] > 0 && before.created[identity] <= before.watermark[entity];
        if (fencedBytes && read && mode % 2 === 0 && remoteHit) seen.add("untracked-ignores-watermark");
        if (fencedBytes && read && mode % 2 === 1 && starts) {
          const variants = fenced.get(entity);
          variants?.add(identity);
          if (variants?.size === 2) seen.add("invalidation-fences-both-operations");
        }
        if (remoteHit) { survivingOther.delete(key); promoted.delete(key); preserved.delete(key); }
        for (const pending of published) if (Math.floor(pending / 4) === instance) published.delete(pending);
        calls.push({ context, identity });
      }
      if (step.action === "resolveLoader") {
        const source = before.sources[Math.floor((step.choice - 1) / 2)];
        const key = source.instance * 4 + source.key;
        if (source.local === true) { survivingOther.delete(key); promoted.delete(key); preserved.delete(key); validated.delete(key); }
        for (const pending of published) if (Math.floor(pending / 4) === source.instance) published.delete(pending);
      }
      if (step.action === "resolveLoader" && mode % 2 === 1 && o.writes > previous.writes) {
        const source = before.sources[Math.floor((step.choice - 1) / 2)];
        const key = source.instance * 4 + source.key;
        if (before.localValues[key] === 0) published.add(key);
      }
      for (const instance of [0, 1]) {
        for (const key of ordersBefore[instance]) if (!ordersAfter[instance].includes(key)) {
          evicted.add(instance * 4 + key); promoted.delete(instance * 4 + key); preserved.delete(instance * 4 + key); validated.delete(instance * 4 + key);
          for (const other of ordersBefore[1 - instance]) survivingOther.add((1 - instance) * 4 + other);
          for (const kept of ordersAfter[instance]) if (promoted.has(instance * 4 + kept)) preserved.add(instance * 4 + kept);
        }
        for (const key of ordersAfter[instance]) evicted.delete(instance * 4 + key);
      }
    }
  }
  return seen;
}
