from invoke import task, Context

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
