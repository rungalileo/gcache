import type { ResolvedLayerConfig } from "./runtime-config.js";
import type { DisabledReason } from "../metrics.js";

export type CacheGetResult<T> =
  | { readonly status: "hit"; readonly value: T }
  | { readonly status: "miss"; readonly config: ResolvedLayerConfig; readonly skipCacheWrite?: boolean }
  | { readonly status: "disabled"; readonly reason: DisabledReason; readonly skipCacheWrite?: boolean };
