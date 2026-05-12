import type { DisabledReason } from "../metrics.js";

export type CacheGetResult<T> =
  | { readonly status: "hit"; readonly value: T }
  | { readonly status: "miss" }
  | { readonly status: "disabled"; readonly reason: DisabledReason };
