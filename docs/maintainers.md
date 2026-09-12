# Maintainer guide

[Documentation](index.md) · [Upgrading](upgrading.md)

This page covers repository validation, documentation maintenance, diagnostic
benchmarks, and the existing release process.

## Validation

Use Node.js 24 and the repository's pinned pnpm through Corepack. Go checks
use the CI-pinned Go toolchain; full formal checks also require the pinned
Quint executable. Run `make help` for targets and prerequisites:

```bash
corepack pnpm install --frozen-lockfile
make check
make integration
```

`make check` runs strict TypeScript checks and coverage, bundles/declarations,
packed ESM/CJS consumer checks, Go vet/formatting/race tests, documentation
builds, and evidence inventories. Both implementations replay the committed
Quint smoke fixtures and protocol cases. Integration tests require a
Docker-compatible runtime for Redis, Valkey, and Redis Cluster and exercise
both language bindings.

`make formal` checks the scheduled Quint models, generates the complete corpus,
and requires full TypeScript and Go replay with matching evidence fingerprints.
`make model-check` runs the separate finite symbolic checks; it needs Java 21,
`tar` and a checksummed Apalache release and is the only lane that does.
`make mutations` challenges the tests with the catalogued implementation
faults over that generated corpus; it does not depend on either replay report.
`make ci NODE22_BIN=/path/to/node22/bin/node` runs the complete pipeline,
including integrations, mutations and the exact Node 22.15.0 package floor.
See the repository's
[formal guide](https://github.com/lan17/DialCache/blob/main/formal/README.md#generating-and-replaying-behavior)
for setup, reports and single-history reproduction.

Pull requests run fast native/smoke checks and real integrations. Changes to
model or generator inputs also trigger fresh Quint artifact recomputation.
Complete exploration and mutation measurement run through the manual and
weekly full-validation workflow, using the same Make targets as local runs.
Run full validation for changes to behavior, models or replay tooling before
merge, and before release or accepting another port. A scheduled result applies
to its recorded revision; it does not validate a later PR head. A smoke pass
does not establish full conformance.

CI uses Node.js 24 for development and integration, then validates the packed
package and zstd at the exact 22.x consumer floor, Node.js 22.15.0. The published
engine range is `>=22.15.0 <23.0.0 || >=23.8.0`.

Match validation to the changed contract. Public API and adapter changes need
packed-consumer coverage; Redis behavior needs real standalone/Cluster tests.
Pay particular attention to complete-frame writes, atomic tracked reads,
conditional refills, logical-age recovery, snapshot ownership, bounded telemetry,
and mixed-version transitions. Documentation-only changes need source checks,
example validation, and working links.

## Maintaining the reference

The README is the landing page. Keep evaluation, a runnable example, and links
there; put complete contracts in the feature guides. `docs/index.md` provides
the reading order, and `docs/api.md` collects public methods/options and routes
to behavior details.

When behavior changes, update the relevant guide and its API table in the same
PR. Check defaults and bounds against source, and include any rollout or
compatibility implications in `docs/upgrading.md`. Keep examples explicit about
application-provided dependencies.

The npm tarball contains `README.md` but not `docs/`. README links to the hosted
reference therefore use absolute URLs. Reference pages use relative Markdown
links so they work in a checkout, on GitHub, and in the documentation site.
Before publishing, check file/anchor targets and parse TypeScript examples.
`test:package` extracts the first TypeScript block from both the README and
getting-started guide, typechecks it against the installed tarball, and executes
it with the documented Node command. CI also runs this check at Node.js 22.15.0.
Keep those blocks self-contained; when their demonstrated output changes,
update the expectation in `scripts/test-package.mjs`.

### Run the documentation site

VitePress renders the Markdown in `docs/` with grouped navigation, page outlines,
syntax highlighting, and local search. Search runs in the browser using an index
built with the site; it needs no external service or credentials.

```bash
corepack pnpm docs:dev
```

To check the production output, run:

```bash
corepack pnpm docs:build
corepack pnpm docs:preview
```

Open the `/DialCache/` URL printed by the server. The build writes to
`docs/.vitepress/dist/` and fails on broken internal page links. Generated output
and the local build cache are ignored by Git. When adding a page, include it in
`docs/index.md` and the sidebar in `docs/.vitepress/config.mts`.

The dependency overrides keep stable VitePress on patched Vite 6.4.x. The config
uses a Safari 14.1 target for builds and dependency optimization to remain
compatible with the repository's patched esbuild. Revisit this scoped override
and the targets when upgrading VitePress.

### Publish to GitHub Pages

The site is hosted at [lan17.github.io/DialCache](https://lan17.github.io/DialCache/).
In the repository's **Settings → Pages**, select **GitHub Actions** as the build
source. Keep `base: "/DialCache/"` in the VitePress config so links and assets work
under the project URL.

The `Documentation` workflow builds every pull request. A push to `main` builds
and publishes the site through the `github-pages` environment; the workflow can
also be run manually from `main` to republish. Pull requests and manual runs from
other branches cannot upload a Pages artifact or deploy. The deployment job uses
GitHub's short-lived token and OIDC; no deployment secret is needed.

The published reference follows `main` independently of npm releases. Use the
Markdown at a release tag when reading about an older installed version.

## Cache-path benchmark

From a repository checkout, run the semantic microbenchmark after installing
dependencies:

```bash
corepack pnpm benchmark:request-local
```

The command builds `dist` before reporting ten scenarios: sequential
request-local hits, sequential process-local hits, enabled bounded fallbacks,
request-local coalescing fan-out, process coalescing fan-out,
remote-read-deadline coalescing fan-out, tracked Redis hits with shadow
omitted, tracked Redis hits deterministically outside a partial shadow ramp, a
ramped-down warm-hit confirmation, and a ramped-down semantic-miss fill. Both
shadow scenarios prove that the caller completes before detached Redis work.
The benchmark is a maintainer tool and is not included in the published
package. It asserts fallback counts, Redis behavior, coalescing state, timer
cleanup, returned values, exactly-once SoT reuse, and conditional
confirmation/fill without applying a timing threshold. Override its work sizes
with `DIALCACHE_BENCH_ITERATIONS` and `DIALCACHE_BENCH_FANOUT`.

## Redis write benchmark

With an otherwise idle Redis reachable at `REDIS_URL` (default
`redis://127.0.0.1:6379`, e.g. `docker run --rm -p 6379:6379 redis:6.2`),
measure the local build's write path. The benchmark resets global command
statistics between cases, so use a disposable or dedicated instance:

```bash
corepack pnpm benchmark:redis-write
```

The command builds `dist`, then runs sequential native writes at 100 B, 10
KiB, 100 KiB, and 1 MiB payloads. It reports `SET`, script, and `TIME` calls
per operation, server-side `SET` cost from `INFO commandstats`, and
client-side p50/p95 latency. Semantic assertions require exactly one `SET`,
zero scripts, and zero `TIME` calls per write. Because operations are
sequential, the benchmark validates command shape and single-operation
latency; it does not measure saturated concurrent throughput or maximum write
capacity. Like the cache-path benchmark it is a maintainer tool, is not part
of the published package, and applies no timing threshold — absolute numbers
depend on the machine, engine, and load, so compare runs only within one
environment. Scale iteration counts with `DIALCACHE_BENCH_WRITE_SCALE`.

## Stale-on-error benchmark

With Redis reachable at `REDIS_URL`, exercise the native-read design and a
representative compressible payload:

```bash
corepack pnpm benchmark:stale-on-error
```

The benchmark warms isolated keys, verifies that physical retention uses `M`,
and reports fresh end-to-end hits, native reads of a retained frame,
end-to-end stale recovery, and same-key coalesced recovery. It asserts exactly
one adapter read per stale-recovery flight. A separate high-cardinality
scenario holds delayed source calls open with distinct incompressible raw
payloads, then reports process memory before retention, while every candidate
is retained, and after recovery. Run the built script with `node --expose-gc
scripts/benchmark-stale-on-error.mjs` for less noisy memory snapshots. It
snapshots `INFO commandstats` and network byte counters around each scenario
without resetting shared server statistics, and reports command, server-CPU,
network, and client-throughput signals per operation. Semantic assertions
cover compression, exact source/recovery/read counts, and returned values;
timing and memory remain informational with no pass/fail threshold. Override
work sizes with `DIALCACHE_BENCH_STALE_ITERATIONS`,
`DIALCACHE_BENCH_STALE_FANOUT`, `DIALCACHE_BENCH_STALE_PAYLOAD_BYTES`,
`DIALCACHE_BENCH_STALE_MEMORY_KEYS`,
`DIALCACHE_BENCH_STALE_MEMORY_PAYLOAD_BYTES`, and
`DIALCACHE_BENCH_STALE_MEMORY_SOURCE_DELAY_MS`.

## Releasing

Publishing starts by manually running the `Release` workflow from current
`main`.

After the package checks pass, Semantic Release selects the next version from
Conventional Commits since the highest stable `vX.Y.Z` tag:

- while the package is pre-1.0, breaking changes bump minor and retain their
  `BREAKING CHANGE:` footers for full release notes;
- `feat` bumps minor; and
- every other normal PR-title type bumps patch.

Patch types are `fix`, `perf`, `docs`, `style`, `refactor`, `test`, `build`,
`chore`, `ci`, and `revert`. The highest required bump wins.

Major bumps resume when the project cuts 1.0.0. `release.config.mjs` implements
this policy; change it and this guide together so the documented release table
cannot drift from automation.

The workflow opens a `release: <version>` pull request whose only change is the
matching `package.json` version. `release` is a reserved Conventional Commit
type configured not to request another release, so the version-control commit
does not cause an extra bump.

GitHub marks workflow runs for a pull request opened with `GITHUB_TOKEN` as
approval-required. Approve those runs, review the pull request, and squash-merge
it normally through the protected branch.

The merge triggers the publish job. Before any release side effect, it verifies:

- current `main`;
- the release commit subject;
- the one-file diff;
- the package version;
- the absent tag; and
- Semantic Release's independently calculated version and commit.

It then reruns the package checks and asks Semantic Release to:

1. create the matching Git tag;
2. publish the public npm package with provenance; and
3. publish the GitHub release.

The repository must enable **Allow GitHub Actions to create and approve pull
requests** under Actions workflow permissions.

The workflow uses that capability only to create the version pull request. It
never approves or merges one, and no ruleset bypass actor or persistent release
credential is required.
