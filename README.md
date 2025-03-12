# GCache

GCache is a lightweight library that provides fine-grained observability and runtime controls for read-through caching.

  * Dashboard: https://rungalileo.grafana.net/d/bd8fc1a7-46bd-42ee-ae53-773c10128608/gcache
  * Runtime controls: TODO

## Enforcing cache key structure

### Key types

Each cache key is required to reference key type on top of actual id. for example, key type could be `user_email` while id is `lev@galileo.ai`. Other arguments are treated differently.

This opens up a door for easier cache invalidation since any caches that share the same key type and id can be invalidate using one operation.

Another benefit is instrumentation since we can track all caches sharing same key type in a dashboard.

### Use cases

Each unique caching use case is required to have a unique name. By default the name is the module path + function name, but its encouraged to provide custom use case names.

Benefit here is instrumentation and runtime control based on use case.

It makes it possible to tune or ramp specific use cases individually.

### Code level cache control

Caching is disabled by default for all use cases, and to actually start caching we need to enable cache via a context variable.

This makes it possible to turn caching on/off entirely for specific blocks of code.

The biggest use case for this is to turn off caching in write endpoints, while turning it on in read endpoints. In a write endpoint we want to avoid `write -> read stale` scenario.

## Usage

`GCache` class is meant to be instantiated once and be used as a singleton throughout the rest of code base.

To cache a function we use `GCache::cached` decorator.  Same decorator works for both sync and async functions.

Example:

```python
gcache = GCache(...)

....

    @gcache.cached
          key_type="user_email",
          id_arg="email",
          # Ignore db_read since its irrelevant to making cache key.
          ignore_args=["db_read"],
          use_case="GetUserByEmail",
       )
    def get_by_email(db_read: Session, email: str) -> User | None:
        ...

....

get_by_email(....) # Does not cache

...

with gcache.enabled():
      ...
      get_by_email(....). # caches
```

### Arg transformers

Some function arguments may not be suitable to include in cache key directly for various reasons.  In such cases
you can provide lambdas when using `cached`.

Example:

We cache a function which takes in objects, and we also turn off local caching entirely.

```python
@gcache.cached(
    key_type="user_id",
    id_arg=("user", lambda user: user.system_user_id),
    arg_adapters={
        "project_type": lambda project_type: project_type.name,
        "pagination": lambda pagination: f"{pagination.starting_token}-{pagination.limit}"
    },
    ignore_args=["db_read"],
)
def get_latest_runs(
       self, db_read: Session, user: User, project_type: ProjectType, pagination: PaginationRequestMixin
   ) -> GetUserLatestRuns:
    ...
```
