# AGENTS.md

## Project overview

DialCache is a TypeScript caching library with explicit request-scoped enablement, local and Redis layers, runtime rollout controls, request coalescing, targeted invalidation, and adapter-based observability.

## Structure

```text
README.md              # Landing page and documentation entry point
docs/                  # User guides and API reference
src/
  index.ts              # Public root entry point (barrel)
  dialcache.ts          # Main DialCache API and cached-function wrapper
  errors.ts             # Public core error classes (DialCacheError hierarchy)
  config.ts             # Public configuration and rollout types
  context.ts            # AsyncLocalStorage-based enabled context
  key.ts                # Structured cache keys and Redis hash tags
  metrics.ts            # Backend-neutral metrics adapter contract
  prometheus.ts         # Optional Prometheus adapter
  datadog.ts            # Optional Datadog (DogStatsD) adapter
  redis-client.ts       # Client-independent semantic Redis interface and its public error classes
  node-redis.ts         # node-redis adapter and invalidation dispatch
  valkey-glide.ts       # Valkey GLIDE adapter (standalone and cluster)
  redis-protocol.ts     # Public frame codec and Lua protocol exports
  serializer.ts         # Serializer contract and JSON implementation
  internal/             # Cache layers, runtime config, payload compression, and invalidation Lua script
test/                   # Unit and Redis integration tests
```

## Critical behavior

- Caching is disabled by default and enabled only inside `dialcache.enable(...)`.
- Disabled calls are true pass-through and must not build keys, resolve config, or coalesce work.
- Active same-key work is coalesced before the first active cache layer, using
  request scope for request-local caching and process scope for shared layers,
  unless the use case's resolved `coalesce` policy disables it.
- Cache plumbing fails open; explicit maintenance operations surface mutation failures.
- Tracked Redis values and invalidation watermarks share a Redis Cluster hash tag.
- Tracked reads run on primaries so replica lag cannot hide invalidation.
- Every Redis value write is one native `SET` of a complete version-1 frame
  stamped from the writer process's clock; Redis value writes never create or
  extend watermarks.
- A tracked read atomically reads the value and watermark from the primary and
  serves the frame only when `createdAtMs` is strictly greater than the
  watermark. A missing watermark is the zero baseline.
- Local entries are process-local and are not synchronously invalidated across instances.

## Conventions

- Preserve strict TypeScript settings and public abstraction boundaries.
- Keep the README focused on evaluation and getting started. Document complete
  feature behavior in `docs/` and link it from `docs/index.md`.
- Keep Redis client-specific behavior in adapters; core code depends on `DialCacheRedisClient`.
- Public exports belong in the root or an explicit integration entry point such as `src/node-redis.ts`, `src/prometheus.ts`, or `src/redis-protocol.ts`.
- Use `corepack pnpm` for project commands.

## Validation

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm test:package
corepack pnpm test:integration
```
