from invoke import Context, task

COMMON_PARAMS = dict(echo=True, pty=True)


@task
def install(ctx: Context) -> None:
    """
    Install package and dependencies.

    Parameters
    ----------
    ctx : Context
        Invoke context.
    """
    ctx.run("poetry install --with dev,test --no-root", **COMMON_PARAMS)


@task
def update(ctx: Context) -> None:
    """
    Update package and dependencies.

    Parameters
    ----------
    ctx : Context
        Invoke context.
    """
    ctx.run("poetry update", **COMMON_PARAMS)


@task
def type_check(ctx: Context) -> None:
    """
    Runs mypy type check on the runners package.

    Parameters
    ----------
    ctx : Context
        Invoke context.
    """
    ctx.run("poetry run mypy --package gcache --namespace-packages", **COMMON_PARAMS)
    ctx.run("poetry run mypy --package tests --namespace-packages", **COMMON_PARAMS)


@task
def setup_pre_commit(ctx: Context) -> None:
    """
    Sets up pre-commit hooks to run before git commit and git push.

    Parameters
    ----------
    ctx : Context
        Invoke context.
    """
    ctx.run("poetry run pre-commit install --hook-type pre-push", **COMMON_PARAMS)


@task
def test(ctx: Context) -> None:
    ctx.run("poetry run pytest -vvv --cov=gcache --cov-report=xml", **COMMON_PARAMS)


# ---------------------------------------------------------------------------
# Unified verbs across the three implementations.
#
# Each language keeps its native tooling -- poetry/pytest, pnpm/tsc, go build/test -- because
# that is what contributors and IDEs expect. These tasks are a NAMING CONVENTION, not a build
# system: they shell out to the real tools so nobody has to remember three vocabularies.
#
# Deliberately not a build system. Three independent ports of one library share no build
# graph, which is the only thing Bazel or Nx exists to exploit; the Go client arrived here
# carrying five BUILD.bazel files and they were dropped for exactly that reason.
# ---------------------------------------------------------------------------


@task
def test_go(ctx: Context) -> None:
    """
    Run the Go test suite.

    Needs a Redis on localhost:6379 for go/redislive, which is deliberately not skippable --
    see the package comment there. CI supplies one as a service container.

    Parameters
    ----------
    ctx : Context
        Invoke context.
    """
    ctx.run("cd go && go test ./... -coverprofile=coverage.out", **COMMON_PARAMS)


@task
def vet_go(ctx: Context) -> None:
    """
    Run gofmt and go vet over the Go client.

    gofmt is checked rather than applied: a task that silently rewrites files is the wrong
    shape for something CI also runs.

    Parameters
    ----------
    ctx : Context
        Invoke context.
    """
    ctx.run('cd go && test -z "$(gofmt -l .)" || (gofmt -l . && exit 1)', **COMMON_PARAMS)
    ctx.run("cd go && go vet ./...", **COMMON_PARAMS)


@task
def test_ts(ctx: Context) -> None:
    """
    Run the TypeScript test suite.

    Parameters
    ----------
    ctx : Context
        Invoke context.
    """
    ctx.run("pnpm ts:gcache:test", **COMMON_PARAMS)


@task
def typecheck_ts(ctx: Context) -> None:
    """
    Type-check the TypeScript package.

    Parameters
    ----------
    ctx : Context
        Invoke context.
    """
    ctx.run("pnpm ts:gcache:typecheck", **COMMON_PARAMS)


@task
def test_conformance(ctx: Context) -> None:
    """
    Run the cross-language conformance suites, all three of them.

    This is the gate that the other suites cannot be: it is the only thing asserting that the
    Python, TypeScript and Go clients agree on the wire. Parity used to be hand-mirrored
    literals in suites that ran in separate CI workflows -- and, before the Go client moved
    here, in separate repositories, where nothing could run both sides. Five cross-language
    claims went silently false in one afternoon under that arrangement.

    Changing a vector in src/gcache/conformance/envelope_vectors.json must fail ALL THREE. If
    only two fail, the third is not really reading the file.

    Parameters
    ----------
    ctx : Context
        Invoke context.
    """
    ctx.run("poetry run pytest tests/test_conformance.py tests/test_cross_language.py -vvv", **COMMON_PARAMS)
    ctx.run("pnpm ts:gcache:test", **COMMON_PARAMS)
    ctx.run("cd go && go test -run TestConformance ./...", **COMMON_PARAMS)


@task(pre=[test, test_ts, test_go])
def test_all(ctx: Context) -> None:
    """
    Run every language's suite.

    A convenience, not a substitute: CI reports one job per language on purpose, because an
    aggregate green hides which implementation regressed.

    Parameters
    ----------
    ctx : Context
        Invoke context.
    """
