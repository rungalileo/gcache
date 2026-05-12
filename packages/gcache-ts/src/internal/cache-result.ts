import type { DisabledReason } from "../metrics.js";

export type CacheGetResult<T> =
  | { readonly status: "hit"; readonly value: T }
  | { readonly status: "miss"; readonly skipCacheWrite?: boolean }
  | { readonly status: "disabled"; readonly reason: DisabledReason; readonly skipCacheWrite?: boolean };
