import { successValues } from "../features.mjs";

// Request-scope witnesses over declared inputs, public observations and the
// fallback diagnostics. No private memo or scope state is consulted.
export function scopeWitnesses(histories) {
  const seen = new Set();
  for (const { path, steps } of histories) {
    const closed = new Set();
    const rejected = new Set();
    const published = new Map();
    const bypassed = new Map();
    const sources = new Map();
    const scopes = [];
    let lateOuterSource = false;
    let valueBeforeNestedClose;
    let policyCall = -1;
    let overlay = 0;
    const holder = scope => scope === 1 ? 1 : 0;
    for (const [i, step] of steps.entries()) {
      seen.add(`action:${step.action}`);
      const o = step.expected;
      const previous = steps[i - 1]?.expected;
      if (previous === undefined) continue;
      for (const layer of step.diagnostics.fallbackErrors) seen.add(`failure-layer:${layer}`);
      if (step.action === "rejectLoader") {
        const failures = o.calls.filter((value, j) => value === 3 && previous.calls[j] === 0).length;
        const added = step.diagnostics.fallbackErrors.length - steps[i - 1].diagnostics.fallbackErrors.length;
        if (failures > 1 && added === 1) seen.add("one-error-for-request-followers");
        if (failures === 1 && added === 0) seen.add("pass-through-error-has-no-cache-trail");
      }
      if (step.action === "policy") overlay = step.choice;
      if (step.action === "closeScope") {
        closed.add(step.choice);
        if (step.choice === 2) valueBeforeNestedClose = published.get(0)?.value;
        if (step.choice < 2) { published.delete(step.choice); bypassed.delete(step.choice); }
      }
      if (step.action === "beginCall") {
        const scope = step.choice;
        scopes.push(scope);
        if (o.policyCalls > previous.policyCalls) policyCall = scopes.length - 1;
        else if (o.loaders > previous.loaders) {
          sources.set(o.loaders - 1, { scope, memoizing: false, shared: false });
          if (scope === 3) seen.add("disabled-bypass");
          if (scope < 5 && closed.has(holder(scope))) seen.add("detached-bypass");
        }
      }
      if (step.action === "releasePolicy") {
        const scope = scopes[policyCall];
        const lifetime = holder(scope);
        if (o.loaders > previous.loaders) {
          const active = o.sourceScopes.at(-1);
          const memoizing = active && overlay !== 1;
          if (!active) seen.add("policy-reply-after-close");
          if (memoizing) {
            if (overlay === 0 && rejected.has(lifetime)) seen.add("rejected-flight-retry");
            if (scope === 1 && lateOuterSource) seen.add("replacement-miss-after-late-source");
            for (const source of sources.values()) {
              if (!source.memoizing || closed.has(holder(source.scope))) continue;
              if (holder(source.scope) !== lifetime) seen.add("independent-scope-overlap");
              else if (overlay === 2) seen.add("uncoalesced-scope-overlap");
            }
          }
          if (active && overlay === 1 && published.has(lifetime)) bypassed.set(lifetime, published.get(lifetime).value);
          sources.set(o.loaders - 1, { scope, memoizing, shared: memoizing && overlay === 0 });
        } else if (o.calls[policyCall] !== 0) {
          seen.add("memo-hit");
          seen.add(`memo-value:${o.calls[policyCall]}`);
          if (published.get(lifetime)?.scope !== scope) {
            if (scope === 2) seen.add("nested-memo-hit");
            if (scope === 4) seen.add("reenabled-memo-hit");
          }
          if (lifetime === 0 && valueBeforeNestedClose === o.calls[policyCall]) seen.add("memo-after-nested-close");
          if (bypassed.get(lifetime) === o.calls[policyCall]) seen.add("memo-after-policy-bypass");
        }
        policyCall = -1;
      }
      if (step.action === "resolveLoader" || step.action === "rejectLoader") {
        const loader = step.action === "resolveLoader" ? Math.floor((step.choice - 1) / successValues.length) : step.choice;
        const source = sources.get(loader);
        if (source === undefined) throw new Error(`${path}: missing source ${loader}`);
        const completed = o.calls.filter((value, index) => value !== 0 && previous.calls[index] === 0);
        const lifetime = holder(source.scope);
        if (step.action === "rejectLoader") {
          if (source.shared) rejected.add(lifetime);
          if (completed.length > 1) seen.add("shared-rejection");
        } else if (source.memoizing) {
          if (closed.has(lifetime)) {
            seen.add("source-settles-after-close");
            if (lifetime === 0) lateOuterSource = true;
          } else {
            published.set(lifetime, { value: completed[0], scope: source.scope });
            if (lifetime === 0) valueBeforeNestedClose = undefined;
            bypassed.delete(lifetime);
          }
        }
        sources.delete(loader);
      }
    }
  }
  return seen;
}
