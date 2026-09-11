// C23/C25/C26, independently checked on actual effects-profile histories.
// This bounded monitor assumes one serving identity, coalescing enabled, no
// recovery or shadow, and a fixed positive source budget. Old raw sources can
// settle after timeout while a replacement source is active. It consumes no
// model state or expected observations and does not claim full refinement.
export type EffectsContractEvent =
  | { event: "sourceStart"; id: number; atMs: number }
  | { event: "sourceSettlement"; id: number; atMs: number; outcome: "resolve" | "reject" }
  | { event: "fallbackCompletion"; atMs: number; durationMs: number; failed: boolean }
  | { event: "writeDispatch"; atMs: number };

export const effectsContractIds = ["C23", "C25", "C26"] as const;

export function assertEffectsHistory(history: readonly EffectsContractEvent[], timeoutMs = 10): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Effects contract requires a positive finite source budget");
  type Source = { atMs: number; settlement?: "resolve" | "reject" };
  const sources = new Map<number, Source>();
  let active: Source | undefined;
  let publicationAuthorized = false;
  let previousTime = -Infinity;
  for (const [index, event] of history.entries()) {
    const fail: (contract: string, message: string) => never = (contract, message) => { throw new Error(`${contract} history event ${index}: ${message}`); };
    if (!Number.isFinite(event.atMs) || event.atMs < previousTime) fail("C23", "observed monotonic time must not move backwards");
    previousTime = event.atMs;
    switch (event.event) {
      case "sourceStart": {
        if (!Number.isSafeInteger(event.id) || event.id < 0 || sources.has(event.id)) fail("C23", "source identity must be new");
        if (active !== undefined) fail("C23", "bounded effects profile cannot start another source before fallback completion");
        active = { atMs: event.atMs };
        sources.set(event.id, active);
        publicationAuthorized = false;
        break;
      }
      case "sourceSettlement": {
        const source = sources.get(event.id);
        if (source === undefined || source.settlement !== undefined) fail("C25", "raw source settlement must identify one started, unsettled source");
        source.settlement = event.outcome;
        // A completed source was abandoned on timeout. Its late settlement
        // must not grant publication authority to itself or the current source.
        break;
      }
      case "fallbackCompletion": {
        if (active === undefined) fail("C23", "fallback completion has no active source start");
        const elapsed = event.atMs - active.atMs;
        if (!Number.isFinite(event.durationMs) || Math.abs(event.durationMs - elapsed) > 1e-7) {
          fail("C23", "fallback duration must begin at the observed source invocation, excluding cache lookup");
        }
        if (!event.failed && (elapsed >= timeoutMs || active.settlement !== "resolve")) {
          fail("C25", "source success must be accepted strictly before its source deadline");
        }
        if (event.failed && elapsed < timeoutMs && active.settlement !== "reject") {
          fail("C23", "source cannot time out before receiving its full budget");
        }
        active = undefined;
        publicationAuthorized = !event.failed;
        break;
      }
      case "writeDispatch":
        if (!publicationAuthorized) fail("C26", "publication requires an accepted source success; late raw settlement is insufficient");
        // An accepted source can publish after its former source deadline.
        // Serializer/write completion is application-owned, so no age guard.
        break;
    }
  }
}
