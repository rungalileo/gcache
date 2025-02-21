# GCache

GCache is a small library that provides fine grained observability and controls for your read-through caching use cases.

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

To cache a function we use `GCache::cached` decorator.

Example:

```
gcache = GCache(...)

....

    @gcache.cached
          key_type="user_email",
          id_arg="email",
          ignore_args=["db_read"],
          use_case="GetUserByEmail")
    def get_by_email(db_read: Session, email: str) -> User | None:
        ...

....

get_by_email(....) # Does not cache

...

with gcache.enabled():
      ...
      get_by_email(....). # caches
```
