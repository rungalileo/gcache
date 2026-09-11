import { successValues } from "../features.mjs";

// Private clock/cache predictions classify only schedules subsequently probed
// by real replay. They never enter driver inputs or implementation projection.
export function clockWitnesses(name, histories) {
  const seen = new Set();
  for (const { steps, states } of histories) {
    let rolledLocal;
    let hitBeforeExpiry;
    let rolled = false;
    for (const [i, step] of steps.entries()) {
      if (i === 0) continue;
      const before = states[i - 1];
      const previous = steps[i - 1].expected;
      const o = step.expected;
      if (step.action === "rollbackWall") {
        rolled = true;
        if (name === "policy" && before.localValue > 0) rolledLocal = { key: before.localKey, expires: before.localExpires };
      }
      if (name === "policy" && step.action === "releasePolicy") {
        const key = before.key, overlay = before.overlay, base = overlay < 20 ? overlay % 10 : 0;
        const local = before.providerFailed === false && ![20, 21].includes(overlay) && ![3, 5, 8].includes(base);
        const now = before.now, expires = before.localExpires, value = before.localValue;
        const sameEntry = local && before.localKey === key && value > 0;
        // The probe occurs after the original expiry but before even the shortest
        // permitted TTL could expire if the preceding read had renewed it.
        if (sameEntry && hitBeforeExpiry?.key === key && hitBeforeExpiry.value === value &&
          hitBeforeExpiry.expires === expires && now >= expires && now < hitBeforeExpiry.at + 1000 &&
          (o.reads > previous.reads || o.loaders > previous.loaders)) seen.add("local-hit-preserves-insertion-expiry");
        if (sameEntry && now < expires && o.calls[before.policyCall] > 0 &&
          o.reads === previous.reads && o.loaders === previous.loaders) hitBeforeExpiry = { key, value, expires, at: now };
        if (local && rolledLocal?.key === key && before.localKey === key && before.localExpires === rolledLocal.expires) {
          const result = o.calls[before.policyCall];
          if (before.now < rolledLocal.expires && result > 0 && o.reads === previous.reads && o.loaders === previous.loaders) seen.add("rollback-preserves-live-local");
          if (before.now >= rolledLocal.expires && (o.reads > previous.reads || o.loaders > previous.loaders)) seen.add("rollback-does-not-extend-local-ttl");
        }
        if (rolled && before.readFailed === false && before.remoteValues[key] > 0 &&
          before.now < before.remoteExpires[key] && before.remoteCreated[key] > before.wall &&
          o.reads > previous.reads && o.loads === previous.loads && o.loaders > previous.loaders) seen.add("rollback-rejects-future-remote");
      }
      if (name === "recovery" && step.action === "releaseLoad" && before.phase === 3 && before.loadFailed === false &&
        before.wall < before.candidateCreated && o.recovery.length > previous.recovery.length && o.recovery.at(-1) === "miss") seen.add("rollback-rejects-retained-future");
    }
  }
  return seen;
}

export function policyWitnesses(histories) {
  const seen = clockWitnesses("policy", histories);
  for (const { path, steps } of histories) {
    let policyEpoch = 0;
    let overlay = 0;
    let providerFailed = false;
    let pendingPolicy = -1;
    const keys = [];
    const sources = new Map();
    for (const [i, step] of steps.entries()) {
      seen.add(`action:${step.action}`);
      const o = step.expected;
      const previous = steps[i - 1]?.expected;
      if (previous === undefined) continue;
      if (step.action === "beginCall") {
        keys.push(step.choice);
        pendingPolicy = o.calls.length - 1;
      }
      if (step.action === "policy") {
        if (overlay !== step.choice) policyEpoch++;
        overlay = step.choice;
      }
      if (step.action === "providerFault") providerFailed = step.choice === 1;
      if (step.action === "releasePolicy") {
        const key = keys[pendingPolicy];
        if (!providerFailed) {
          if (overlay === 20 && o.loaders > previous.loaders && o.reads === previous.reads) seen.add("invalid-read-budget-bypasses-caching");
          if (overlay === 21 && o.reads > previous.reads) seen.add("invalid-local-ramp-preserves-remote");
          if (overlay === 22 && o.calls[pendingPolicy] > 0 && o.reads === previous.reads && o.loaders === previous.loaders) seen.add("invalid-remote-ramp-preserves-local");
          if (overlay === 25 && o.loads > previous.loads && o.loaders === previous.loaders) seen.add("invalid-shadow-preserves-serving");
        }
        if (o.loaders > previous.loaders) {
          for (const source of sources.values()) {
            if (source.key !== key) seen.add("cross-key-overlap");
            else if (overlay >= 10 && overlay < 20 && !providerFailed) seen.add("uncoalesced-same-key-overlap");
          }
          sources.set(o.loaders - 1, { key, epoch: policyEpoch, overlay });
        } else if (o.calls[pendingPolicy] === 0) {
          if ([...sources.values()].some(source => source.key === key && source.epoch < policyEpoch)) {
            seen.add("join-after-policy-change");
          }
        } else {
          if (o.loads > previous.loads) { seen.add("remote-hit"); seen.add(`remote-value:${o.calls[pendingPolicy]}`); }
          if (o.reads === previous.reads) { seen.add("local-hit"); seen.add(`local-value:${o.calls[pendingPolicy]}`); }
        }
        pendingPolicy = -1;
      }
      if (step.action === "resolveLoader" || step.action === "rejectLoader") {
        const loader = step.action === "resolveLoader" ? Math.floor((step.choice - 1) / successValues.length) : step.choice;
        const source = sources.get(loader);
        if (source === undefined) throw new Error(`${path}: missing accepted source ${loader}`);
        if ([...sources.keys()].some(pending => pending < loader)) seen.add("reverse-source-settlement");
        if (previous.calls.filter((c, index) => c === 0 && o.calls[index] !== 0).length > 1) seen.add("coalesced-result");
        if (o.writes > previous.writes) {
          if ([23, 24].includes(source.overlay) && o.writeTtls.at(-1) === 1000) seen.add(`invalid-recovery-retention:${source.overlay}`);
          if (source.epoch < policyEpoch) seen.add("publication-after-policy-change");
          if (pendingPolicy >= 0 && o.calls[pendingPolicy] === 0) seen.add("publication-during-policy-fetch");
        }
        sources.delete(loader);
      }
      for (const ttl of o.writeTtls) seen.add(`ttl:${ttl}`);
    }
  }
  return seen;
}
