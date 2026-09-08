# DialCache documentation

DialCache wraps application reads with explicit enablement, layered storage, and
runtime policy. These guides explain its model and feature behavior; the API
reference collects exact options and contracts.

<a id="start-here"></a>

## Learn the model

1. [Getting started](getting-started.md): run a reader inside an enabled scope.
2. [How DialCache works](concepts.md): follow a read through layers and shared work.
3. [Keys and identity](keys.md): define a cached result and its invalidation group.
4. [Configuration and rollout](configuration.md): combine defaults and overrides,
   choose key cohorts, and understand changes to a running service.

<a id="features-and-behavior"></a>

## Feature guides

| Feature | What it explains |
| --- | --- |
| [Targeted invalidation](invalidation.md) | Entity watermarks, in-flight races, and reuse boundaries |
| [Stale-on-error](stale-on-error.md) | Fresh and recovery ages, eligible errors, and retained snapshots |
| [Shadow validation](shadow-validation.md) | Cache coherence through sampling, confirmation, and optional fills |
| [Coalescing and liveness](coalescing.md) | Shared work, caller deadlines, and in-flight state |

<a id="reference-and-operations"></a>

## Reference and integrations

| Reference | What it covers |
| --- | --- |
| [API](api.md) | Methods, options, defaults, validation, errors, and exports |
| [Redis and Valkey](redis.md) | Client setup, serialization, compression, adapter contracts, and wire protocol |
| [Observability](observability.md) | Prometheus and Datadog setup, metric semantics, and custom adapters |
| [Upgrading](upgrading.md) | Protocol cutovers, retention, serializers, and metric migrations |
| [Maintainer guide](maintainers.md) | Validation, documentation, benchmarks, and releases |

## Find an answer

| Question | Start here |
| --- | --- |
| Why is my loader still running? | [Enabled scopes](concepts.md#enable-and-disable-scopes), [layer policy](configuration.md#baseline-and-overlay-precedence), and [miss reasons](observability.md#miss-reasons) |
| Why did changing a TTL leave an old value in cache? | [Policy changes and existing entries](configuration.md#changing-policy-on-a-running-service) |
| Why can I still see a value after invalidation? | [Reuse boundaries](invalidation.md#reuse-boundaries) |
| Why are callers sharing a timeout or result? | [What followers inherit](coalescing.md#what-followers-inherit) |
| What can still wait after the source deadline? | [Application-owned budgets](coalescing.md#application-owned-budgets) |
| Why is shadow validation doing no work? | [Shadow eligibility](shadow-validation.md#eligibility) |

The published site follows `main`, which may be ahead of the npm package. For an
installed version, consult its [release notes](https://github.com/lan17/DialCache/releases)
and the README or reference at the matching
[release tag](https://github.com/lan17/DialCache/tags). The package's TypeScript
declarations are the exact type source.

[Project overview](https://github.com/lan17/DialCache#readme)
· [npm package](https://www.npmjs.com/package/dialcache)
· [Source code](https://github.com/lan17/DialCache)
