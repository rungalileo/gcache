# DialCache documentation

DialCache is a TypeScript library that organizes caching into use cases, with
runtime control and observability for each one. This reference explains the
system from the outside in: first the read path, then the policies that control
it, then individual APIs and integration contracts.

## Start here

1. [Getting started](getting-started.md) — run a small example, choose a scope,
   and connect a reader to runtime policy.
2. [How DialCache works](concepts.md) — follow a call through enablement, cache
   layers, coalescing, and the source loader.
3. [Configuration](configuration.md) — define identities, select layers, and
   change TTLs and stable rollout cohorts.

## Features and behavior

| Topic | What it explains |
| --- | --- |
| [Redis and Valkey](redis.md) | Connect clients, understand native reads and writes, choose serializers and compression, and implement an adapter |
| [Targeted invalidation](invalidation.md) | Refresh tracked entities, size the future buffer, and understand clocks, watermarks, and local-cache boundaries |
| [Stale-on-error](stale-on-error.md) | Retain a Redis snapshot for selected source failures, choose age limits, and understand recovery races |
| [Shadow validation](shadow-validation.md) | Validate cache coherence by comparing sampled Redis values with the source |
| [Coalescing and liveness](coalescing.md) | Share same-key work, configure deadlines, and inspect in-flight state |
| [Observability](observability.md) | Set up Prometheus or Datadog, interpret metrics, and implement custom telemetry |

## Reference and operations

| Topic | What it explains |
| --- | --- |
| [API reference](api.md) | Public methods, operation options, configuration defaults, errors, and import paths |
| [Upgrading](upgrading.md) | Protocol cutovers, longer Redis retention, serializer compatibility, and metric migrations |
| [Maintainer guide](maintainers.md) | Local validation, documentation, benchmarks, and releases |

## Find an answer

| Question | Start here |
| --- | --- |
| Why is my loader still running? | [Enabled scopes](configuration.md#enable-and-disable-scopes), [layer policy](configuration.md#baseline-and-overlay-precedence), and [miss reasons](observability.md#miss-reasons) |
| Why did changing a TTL leave an old value in cache? | [Policy changes and existing entries](configuration.md#changing-policy-on-a-running-service) |
| Why can I still see a value after invalidation? | [In-memory publication](invalidation.md#in-memory-publication) and [recovery races](stale-on-error.md) |
| Why are callers sharing a timeout or result? | [What followers inherit](coalescing.md#what-followers-inherit) |
| What can still wait after the source deadline? | [Application-owned budgets](coalescing.md#application-owned-budgets) |
| Why is shadow validation doing no work? | [Shadow eligibility](shadow-validation.md#eligibility) and [custom metrics hooks](observability.md#custom-adapters) |

The published site follows `main`, which may be ahead of the npm package. For an
installed version, consult its [release notes](https://github.com/lan17/DialCache/releases)
and the README or reference at the matching
[release tag](https://github.com/lan17/DialCache/tags). The package's TypeScript
declarations are the exact type source.

[Project overview](https://github.com/lan17/DialCache#readme)
· [npm package](https://www.npmjs.com/package/dialcache)
· [Source code](https://github.com/lan17/DialCache)
