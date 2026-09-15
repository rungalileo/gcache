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


# Unified verbs across both implementations. A NAMING CONVENTION, not a build system: each
# language keeps its native tooling and these shell out to it. Two ports of one library share
# no build graph, which is the only thing Bazel or Nx exists to exploit. The Go commands are
# bare `go`/`gofmt` on purpose -- there is no venv for `poetry run` to enter.


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
    ctx.run("cd go && go test -count=1 ./... -coverprofile=coverage.out", **COMMON_PARAMS)


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
    # The exit status too: gofmt -l prints nothing and exits 2 on a file it cannot parse, so
    # checking stdout alone passed on exactly the file most in need of checking.
    ctx.run(
        'cd go && out=$(gofmt -l . 2>&1) || { printf "%s\n" "$out"; exit 1; }; test -z "$out" || { echo "unformatted:"; printf "%s\n" "$out"; exit 1; }',
        **COMMON_PARAMS,
    )
    ctx.run("cd go && go vet ./...", **COMMON_PARAMS)


@task
def test_conformance(ctx: Context) -> None:
    """
    Run both cross-language conformance suites.

    The only thing asserting that the Python and Go clients agree on the wire. Parity used to
    be hand-mirrored literals in separate repositories, where nothing could run both sides;
    five cross-language claims went silently false in one afternoon.

    Changing a vector must fail BOTH. If only one fails, the other is not reading the file.

    Parameters
    ----------
    ctx : Context
        Invoke context.
    """
    ctx.run("poetry run pytest tests/test_conformance.py tests/test_cross_language.py -vvv", **COMMON_PARAMS)
    ctx.run("cd go && go test -count=1 -run TestConformance ./...", **COMMON_PARAMS)


@task(pre=[test, test_go])
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
