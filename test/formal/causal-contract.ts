// A necessary publication condition checked from actual external callbacks.
// Opaque invocation tokens belong to the driver, not DialCache's private state.
// This is not a proof of payload provenance, fencing, or every publication rule.
export type CausalEvent =
  | { event: "sourceStart"; id: number; owner: number; atMs: number; budgetMs: number | null }
  | { event: "sourceSettlement"; id: number; atMs: number; outcome: "resolve" | "reject" }
  | { event: "writeDispatch"; owner: number | undefined; source: number | undefined; atMs: number };

export function assertPublicationCausality(history: readonly CausalEvent[]): void {
  type Source = { owner: number; started: number; budget: number | null; settled?: number; outcome?: "resolve" | "reject" };
  const sources = new Map<number, Source>();
  const owners = new Set<number>();
  let previousTime = -Infinity;
  const identity = (value: number | undefined): value is number => value !== undefined && Number.isSafeInteger(value) && value >= 0;
  for (const [index, event] of history.entries()) {
    const fail: (reason: string) => never = (reason) => { throw new Error(`C25/C26 causal event ${index}: ${reason}`); };
    if (!Number.isFinite(event.atMs) || event.atMs < previousTime) fail("elapsed observations must be monotonic");
    previousTime = event.atMs;
    if (event.event === "sourceStart") {
      if (!identity(event.id) || !identity(event.owner) || sources.has(event.id) || owners.has(event.owner)) fail("source and invocation ownership must be unique");
      if (event.budgetMs !== null && (!Number.isSafeInteger(event.budgetMs) || event.budgetMs <= 0)) fail("source budget must be positive or explicitly unbounded");
      sources.set(event.id, { owner: event.owner, started: event.atMs, budget: event.budgetMs });
      owners.add(event.owner);
    } else if (event.event === "sourceSettlement") {
      const source = sources.get(event.id);
      if (source === undefined || source.settled !== undefined) fail("settlement must identify one actual pending source");
      source.settled = event.atMs;
      source.outcome = event.outcome;
    } else {
      if (!identity(event.owner) || !identity(event.source)) fail("write has no observed source ownership");
      const source = sources.get(event.source);
      if (source === undefined || source.owner !== event.owner) fail("write belongs to a different invocation's source");
      if (source.outcome !== "resolve" || source.settled === undefined) fail("write requires that exact source's successful settlement");
      if (source.budget !== null && source.settled - source.started >= source.budget) fail("late raw settlement cannot authorize publication");
      // Publication itself may complete after the source's former deadline.
    }
  }
}
