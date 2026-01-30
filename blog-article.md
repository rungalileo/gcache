# Production-Grade Caching for Fast-Moving Teams

> How gcache lets you retrofit caching onto existing code without the usual risks

---

## Outline

### 1. The Problem: You Shipped Fast, Now You're Slow

- Reality of product engineering: features first, optimization later
- Common symptoms: N+1 queries, repeated API calls, slow endpoints
- The "right" fix (refactoring I/O patterns) is a multi-sprint project nobody will prioritize
- You need to add caching to existing code, not rewrite it

### 2. What Makes gcache Different (Teaser)

> gcache is a Python caching library built for teams that ship fast. It's different:

- **Caching is off by default** - you explicitly enable it where it's safe
- **Gradual rollout with runtime kill switch** - no redeploy to dial back
- **Structured cache keys** - invalidate all caches for a user with one call
- **Built-in Prometheus metrics** - know if caching is actually helping

The rest of this article explains why these matter and how they work.

### 3. Why "Just Add Caching" Is Scary

- **Stale data bugs**: Cache a read before a write, serve stale data, subtle corruption
- **No visibility**: Is caching even working? What's the hit rate? Why is it slow?
- **All-or-nothing deployment**: Ship caching, pray it works, can't easily roll back
- **Configuration requires redeploy**: Found a bug? Redeploy to disable. At 3am. On a Friday.

**Invalidation hell** deserves its own callout:

> Your user updates their profile. Now you need to invalidate their cached data. But where is it cached? `user_123`? `user:123:profile`? `getUserPosts_123`? That function another engineer added last sprint - what key pattern did they use?
>
> You grep the codebase, find 6 different caching calls for user data, manually invalidate each one, and pray you didn't miss any.
>
> You did. There's a stale data bug in production for 2 hours before someone notices.

This is especially painful for fast-moving teams because caching gets added incrementally by different engineers over months. The mess compounds.

### 4. gcache's Approach: Caching With Guardrails

Core philosophy: make caching safe to add incrementally to production systems.

#### 4.1 Explicit Enable (Safety by Default)

- Caching is OFF until you explicitly enable it
- Prevents accidental caching in write paths
- You consciously decide where caching is safe

```python
# Caching off - function always executes
result = get_user(user_id)

# Caching on - explicitly enabled
with gcache.enable():
    result = get_user(user_id)
```

#### 4.2 Gradual Rollout (Ramping)

- Start at 10%, watch metrics, dial up to 100%
- Controlled via runtime config - no redeploy needed
- If something breaks, dial back to 0% instantly

```python
# Start cautious
ramp={CacheLayer.LOCAL: 10, CacheLayer.REMOTE: 25}

# Gain confidence, increase
ramp={CacheLayer.LOCAL: 100, CacheLayer.REMOTE: 100}

# Oh no, roll back NOW
ramp={CacheLayer.LOCAL: 0, CacheLayer.REMOTE: 0}
```

#### 4.3 Structured Keys & Targeted Invalidation

gcache enforces a consistent key structure (URN format):

```
urn:prefix:user_id:123?page=1#GetUserPosts
```

Every cache key follows this pattern:
- `key_type` (e.g., `user_id`) - what entity is this cache about?
- `id` (e.g., `123`) - which specific entity?
- `args` - other function arguments that affect the result
- `use_case` (e.g., `GetUserPosts`) - which caching scenario?

This structure enables one-call invalidation:

```python
# User updates their profile - invalidate ALL their cached data
await gcache.ainvalidate(key_type="user_id", id="12345")
# Invalidates: GetUser, GetUserPosts, GetUserSettings, etc.
# No more hunting down individual cache keys
```

Bonus: keys are human-readable when debugging Redis directly.

#### 4.4 Built-in Observability

- Prometheus metrics out of the box
- Cache hit rate, miss rate, disabled reasons, errors, latencies
- Know if caching is actually helping

#### 4.5 Fail-Open

- Cache errors never break your app
- Redis dies? App keeps working, just slower
- Errors are logged and metriced, not thrown

### 5. Before/After: [Real Example]

> [TODO: Lev to provide real before/after story]

- The situation before gcache
- How gcache was added
- The results (perf improvement, time to implement, operational experience)

### 6. How It Works: Quick Start

#### 6.1 Basic Setup

```python
from gcache import GCache, GCacheConfig

gcache = GCache(GCacheConfig())
```

#### 6.2 Decorate Your Functions

```python
@gcache.cached(
    key_type="user_id",
    id_arg="user_id",
    use_case="GetUser"
)
async def get_user(user_id: str) -> dict:
    return await db.fetch_user(user_id)
```

#### 6.3 Enable Where Safe

```python
@app.get("/users/{user_id}")
async def get_user_endpoint(user_id: str):
    with gcache.enable():
        return await get_user(user_id)
```

### 7. Key Design Decisions

Brief explanations of why gcache works the way it does:

- **Why disabled by default?** - Prevents stale data bugs in write paths
- **Why URN keys?** - Human-readable in Redis, enables targeted invalidation
- **Why two layers (local + Redis)?** - Local for speed, Redis for consistency across instances
- **Why ramping?** - Gradual rollout is how you ship safely in production

### 8. When to Use gcache (and When Not To)

**Good fit:**
- Existing codebase with performance issues
- Team that ships fast and needs to add caching incrementally
- Production systems where you need runtime control and observability

**Not the right tool:**
- Greenfield projects where you can design optimal I/O upfront
- Simple scripts or CLIs where caching complexity isn't worth it
- Cases where you need distributed cache invalidation across services (gcache is per-service)

### 9. Getting Started

- Link to GitHub repo
- Installation: `pip install gcache`
- Link to full documentation

---

## Notes for Writing

- Keep it practical, not academic
- Code examples should be copy-pasteable
- Speak to engineers who've felt this pain
- The before/after story is the emotional hook - make it concrete
- Don't oversell - be honest about tradeoffs

## Open Questions

- [ ] What's the real before/after story?
- [ ] Any specific metrics to share? (X% faster, Y hours saved, etc.)
- [ ] Should we include the Redis setup or keep it simple?
- [ ] Target length? (1500 words? 2500?)
