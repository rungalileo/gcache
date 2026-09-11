import { explicitInput, privateStates, readTrace, traceStates } from "./trace.mjs";

const successful = value => value !== undefined && value > 0 && value !== 3 && value !== 4;
const baseOverlay = overlay => overlay < 20 ? overlay % 10 : 0;
const independent = overlay => overlay >= 10 && overlay < 20;
const localActive = s => !s.providerFailed && ![20, 21].includes(s.overlay) && ![3, 5, 8].includes(baseOverlay(s.overlay));
const remoteActive = s => !s.providerFailed && ![20, 22].includes(s.overlay) && ![4, 6, 8].includes(baseOverlay(s.overlay));
const remoteTtl = s => baseOverlay(s.overlay) === 2 ? 2000 : baseOverlay(s.overlay) === 9 ? 4000 : 1000;

// These classifiers inspect only Quint schedules already replayed through the
// public APIs of every port. Private cache predictions select a schedule; a
// later public call must expose retained values, skipped work, or independent
// work. They neither drive implementations nor add a behavioral oracle.
export function runtimeWitnesses(profile, paths) {
  const seen = new Set();
  if (!["policy", "scope", "layers"].includes(profile)) return seen;
  for (const path of paths) {
    const raw = readTrace(path);
    const states = traceStates(raw, path);
    // Published smoke fixtures deliberately retain only public observations.
    if (states[0]?.s?.sources === undefined) continue;
    const steps = privateStates(raw, path).map((s, index) => ({ s, input: index === 0 ? undefined : explicitInput(states[index], `${path} step ${index}`) }));
    if (profile === "policy") policyWitnesses(steps, seen);
    if (profile === "scope") scopeWitnesses(steps, seen);
    if (profile === "layers") layersWitnesses(steps, seen);
  }
  return seen;
}

function policyWitnesses(steps, seen) {
  const overlaps = new Set();
  const previousPublication = new Map();
  const lastWriter = new Map();
  const bypassed = new Map();
  const warmed = new Map();
  const failedReadSources = new Set();
  const failedReadValues = new Map();
  for (let i = 1; i < steps.length; i++) {
    const step = steps[i], before = steps[i - 1].s, after = step.s;
    const prior = before.o, current = after.o, action = step.input.name, choice = step.input.choice;
    if (action === "releasePolicy") {
      const key = before.key, call = before.policyCall;
      const value = current.calls[call];
      const starts = current.loaders > prior.loaders;
      const localHit = successful(value) && current.reads === prior.reads && current.loaders === prior.loaders;
      const remoteHit = successful(value) && current.loads > prior.loads && !starts;
      const base = baseOverlay(before.overlay);
      if (starts) {
        const loader = after.sources.length - 1;
        for (const [other, source] of before.sources.entries()) {
          if (source.key !== key || source.result !== 0) continue;
          if (!source.shared && !after.sources[loader].shared) overlaps.add(`${Math.min(other, loader)}:${Math.max(other, loader)}`);
          if (base === 8 && source.localTtl === 0 && source.remoteTtl === 0 && current.reads === prior.reads) seen.add("inactive-layers-independent-sources");
        }
        if (before.readFailed && current.reads > prior.reads && after.sources[loader].localTtl > 0) failedReadSources.add(loader);
        if (before.localKey === key && before.localValue > 0 && before.now < before.localExpires) {
          if (before.providerFailed) bypassed.set(key, { value: before.localValue, expires: before.localExpires, loader, settled: false, reason: "provider-failure" });
          else if (base === 8) bypassed.set(key, { value: before.localValue, expires: before.localExpires, loader, settled: false, reason: "serving-disabled" });
        }
      }
      if (!before.providerFailed) {
        if (base === 5 && current.reads > prior.reads && remoteHit) seen.add("invalid-local-ttl-preserves-remote-hit");
        if (base === 6 && localHit) seen.add("invalid-remote-ttl-preserves-local-hit");
        if (before.overlay === 21 && remoteHit) seen.add("invalid-local-ramp-preserves-remote-hit");
        if (before.overlay === 22 && localHit) seen.add("invalid-remote-ramp-preserves-local-hit");
        if (before.overlay === 0 && localHit) seen.add("sparse-empty-provider-inherits-local-hit");
        if (before.overlay === 0 && remoteHit) seen.add("sparse-empty-provider-inherits-remote-hit");
      }
      if (localHit) {
        if (independent(before.overlay)) seen.add("uncoalesced-local-settled-hit");
        const retained = bypassed.get(key);
        if (retained?.settled === true && retained.value === value && retained.expires === before.localExpires) seen.add(`${retained.reason}-preserves-existing-local`);
        if (failedReadValues.get(key) === value) seen.add("failed-untracked-read-still-warms-local");
        const insertion = warmed.get(key);
        if (insertion?.value === value && insertion.expires === before.localExpires && before.wall >= insertion.freshUntil) {
          seen.add("remote-hit-local-ttl-outlives-remote-freshness");
        }
        if (lastWriter.get(`local:${key}`)?.value === value) seen.add("independent-local-last-completion-probed");
      }
      if (remoteHit) {
        // Remote warming replaces the local entry, even when the decoded value
        // is equal. It cannot count as a probe of an earlier local publication.
        lastWriter.delete(`local:${key}`);
        bypassed.delete(key);
        failedReadValues.delete(key);
        if (independent(before.overlay)) seen.add("uncoalesced-remote-settled-hit");
        if (lastWriter.get(`remote:${key}`)?.value === value) seen.add("independent-remote-last-completion-probed");
        const age = before.wall - before.remoteCreated[key];
        if (age >= 1000 && remoteTtl(before) > 1000) seen.add("increased-fresh-ttl-reuses-retained-frame");
        if (localActive(before) && age > 0) warmed.set(key, {
          value, expires: after.localExpires, freshUntil: before.remoteCreated[key] + remoteTtl(before),
        });
      }
      if (starts && current.reads > prior.reads && !before.readFailed && before.remoteValues[key] > 0 && remoteActive(before)) {
        const age = before.wall - before.remoteCreated[key];
        if (before.now < before.remoteExpires[key] && age === remoteTtl(before)) seen.add("remote-exact-fresh-boundary-miss");
        if (before.now >= before.remoteExpires[key] && age >= 0 && age < remoteTtl(before)) seen.add("increased-fresh-ttl-cannot-resurrect-expired-storage");
      }
    }
    if (action === "resolveLoader") {
      const loader = Math.floor((choice - 1) / 7);
      const source = before.sources[loader], value = after.sources[loader].result;
      for (const kind of ["local", "remote"]) {
        const published = kind === "local" ? source.localTtl > 0 : current.writes > prior.writes && !before.writeFailed;
        if (!published) continue;
        const key = `${kind}:${source.key}`, preceding = previousPublication.get(key);
        lastWriter.delete(key);
        if (!source.shared && preceding !== undefined && preceding.value !== value &&
          overlaps.has(`${Math.min(preceding.loader, loader)}:${Math.max(preceding.loader, loader)}`)) {
          lastWriter.set(key, { loader, value, kind });
        }
        previousPublication.set(key, { loader, value, kind });
      }
      warmed.delete(source.key);
      if (failedReadSources.has(loader) && current.dumps === prior.dumps && current.writes === prior.writes) failedReadValues.set(source.key, value);
      else if (source.localTtl > 0) failedReadValues.delete(source.key);
      // A bypassed result must differ from the retained value; otherwise a later
      // hit would not distinguish preserving the entry from replacing it.
      const bypass = bypassed.get(source.key);
      if (source.localTtl > 0 || bypass?.value === value) bypassed.delete(source.key);
      else if (bypass?.loader === loader && current.dumps === prior.dumps && current.writes === prior.writes) {
        bypassed.set(source.key, { ...bypass, settled: true });
      }
    }
    if (action === "rejectLoader") {
      const key = before.sources[choice].key;
      if (bypassed.get(key)?.loader === choice) bypassed.delete(key);
    }
    if (action === "seed") {
      const key = Math.floor(choice / 2);
      lastWriter.delete(`remote:${key}`);
    }
  }
}

function scopeWitnesses(steps, seen) {
  const overlaps = new Set();
  const publications = new Map();
  const lastWriter = new Map();
  for (let i = 1; i < steps.length; i++) {
    const step = steps[i], before = steps[i - 1].s, after = step.s;
    const prior = before.o, current = after.o, action = step.input.name, choice = step.input.choice;
    if (action === "releasePolicy") {
      if (current.loaders > prior.loaders) {
        const loader = after.sources.length - 1, admitted = after.sources[loader];
        for (const [other, source] of before.sources.entries()) if (admitted.slot >= 0 && source.slot === admitted.slot &&
          source.result === 0 && !source.shared && !admitted.shared) overlaps.add(`${other}:${loader}`);
      } else if (successful(current.calls[before.policyCall]) && before.overlay === 2) {
        seen.add("uncoalesced-request-settled-hit");
        const slot = before.scope === 1 ? 1 : 0;
        if (lastWriter.get(slot)?.value === current.calls[before.policyCall]) seen.add("independent-request-last-completion-probed");
      }
    }
    if (action === "resolveLoader") {
      const loader = Math.floor((choice - 1) / 7);
      const source = before.sources[loader], value = after.sources[loader].result;
      if (source.slot < 0 || before.completed[source.slot]) continue;
      const preceding = publications.get(source.slot);
      lastWriter.delete(source.slot);
      if (!source.shared && preceding !== undefined && preceding.value !== value &&
        overlaps.has(`${Math.min(preceding.loader, loader)}:${Math.max(preceding.loader, loader)}`)) {
        lastWriter.set(source.slot, { loader, value, kind: "request" });
      }
      publications.set(source.slot, { loader, value, kind: "request" });
    }
    if (action === "closeScope" && choice < 2) {
      publications.delete(choice);
      lastWriter.delete(choice);
    }
  }
}

function layersWitnesses(steps, seen) {
  const sourcePublications = new Map();
  const probed = new Map();
  const localOwners = new Map();
  const remoteOwners = new Map();
  const memoOwners = new Map();
  const trackedLocalOnly = new Map();
  // A preservation witness must start with an acquired memo. Clear ownership
  // on every later publication, even if the replacement has the same value.
  const memoBeforeInvalidation = new Map();
  for (let i = 1; i < steps.length; i++) {
    const step = steps[i], before = steps[i - 1].s, after = step.s;
    const prior = before.o, current = after.o, action = step.input.name, choice = step.input.choice;
    if (action === "invalidate" && current.invalidations === prior.invalidations + 1) {
      const entity = choice;
      before.memo.forEach((value, slot) => {
        if (Math.floor((slot % 4) / 2) !== entity) return;
        if (successful(value)) memoBeforeInvalidation.set(slot, value);
        else memoBeforeInvalidation.delete(slot);
      });
    }
    if (action === "seed") remoteOwners.delete(Math.floor(choice / 2));
    if (action === "closeScope") {
      const context = choice;
      for (let key = 0; key < 4; key++) {
        memoOwners.delete(context * 4 + key);
        memoBeforeInvalidation.delete(context * 4 + key);
      }
    }
    for (let key = 0; key < after.localValues.length; key++) if (after.localValues[key] === 0) localOwners.delete(key);
    if (action === "resolveLoader") {
      const loader = Math.floor((choice - 1) / 2);
      const source = before.sources[loader], value = after.sources[loader].result;
      const request = new Set();
      before.owners.forEach((owner, call) => {
        const slot = before.memoSlots[call];
        if (owner === loader && slot >= 0 && !before.closed[Math.floor(slot / 4)]) request.add(slot);
      });
      sourcePublications.set(loader, { value, request, local: source.local, remote: current.writes > prior.writes });
      for (const slot of request) {
        memoOwners.set(slot, loader);
        memoBeforeInvalidation.delete(slot);
      }
      if (source.local) localOwners.set(source.instance * 4 + source.key, loader);
      if (current.writes > prior.writes) remoteOwners.set(source.key, loader);
      if (before.tracked && source.local && !source.remote) trackedLocalOnly.set(source.instance * 4 + source.key, value);
      else if (source.local) trackedLocalOnly.delete(source.instance * 4 + source.key);
    }
    if (action !== "beginCall") continue;
    const context = Math.floor(choice / 4), key = choice % 4;
    const instance = context === 2 || context === 4 ? 1 : 0, identity = instance * 4 + key;
    const value = current.calls.at(-1), starts = current.loaders > prior.loaders;
    const read = current.reads > prior.reads, remoteHit = current.loads > prior.loads;
    const slot = context < 3 && !before.closed[context] && ![1, 5].includes(before.policy) ? context * 4 + key : -1;
    const memoHit = successful(value) && slot >= 0 && before.memo[slot] === value && !read && !starts;
    const localHit = successful(value) && !memoHit && !read && !starts;
    if (memoHit) {
      seen.add("request-hit-stops-lower-traversal");
      if (before.tracked && memoBeforeInvalidation.get(slot) === value) {
        seen.add("invalidation-preserves-request-hit");
      }
    }
    if (localHit) {
      seen.add("local-hit-stops-remote-and-source");
      if (trackedLocalOnly.get(identity) === value) seen.add(before.remoteAvailable ? "tracked-remote-disabled-local-hit" : "tracked-local-only-hit");
    }
    if (starts && before.sources.some(source => source.key === key && source.instance !== instance && source.result === 0)) {
      seen.add("different-instances-own-distinct-flights");
    }
    if (!successful(value)) continue;
    if (!memoHit && slot >= 0) memoBeforeInvalidation.delete(slot);
    // Keep each layer's writer identity across probes. Equal values from a
    // replacement write cannot be mistaken for the earlier source publication.
    if (remoteHit) {
      const owner = remoteOwners.get(key);
      if (after.localValues[identity] === value && [0, 1].includes(before.policy)) {
        if (owner === undefined) localOwners.delete(identity); else localOwners.set(identity, owner);
        trackedLocalOnly.delete(identity);
      }
      if (slot >= 0) { if (owner === undefined) memoOwners.delete(slot); else memoOwners.set(slot, owner); }
    } else if (localHit && slot >= 0) {
      const owner = localOwners.get(identity);
      if (owner === undefined) memoOwners.delete(slot); else memoOwners.set(slot, owner);
    }
    for (const [loader, publication] of sourcePublications) {
      const source = before.sources[loader];
      if (source.key !== key || publication.value !== value) continue;
      const observations = probed.get(loader) ?? new Set();
      if (memoHit && publication.request.has(slot) && memoOwners.get(slot) === loader) observations.add("request");
      if (localHit && source.instance === instance && publication.local && localOwners.get(identity) === loader) observations.add("local");
      if (remoteHit && publication.remote && remoteOwners.get(key) === loader) observations.add("remote");
      probed.set(loader, observations);
      if (!before.tracked && observations.size === 3) seen.add("source-publication-probed-in-all-three-layers");
    }
  }
}
