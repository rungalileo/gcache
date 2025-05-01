# CHANGELOG


## v0.11.3 (2025-05-01)

### Chores

- **deps-dev**: Bump pytest-asyncio from 0.25.3 to 0.26.0
  ([#43](https://github.com/rungalileo/cachegalileo/pull/43),
  [`eef7889`](https://github.com/rungalileo/cachegalileo/commit/eef7889263cc78dd1b9c543c943b309887e5adef))


## v0.11.2 (2025-05-01)

### Chores

- **deps**: Bump pydantic from 2.10.6 to 2.11.4
  ([#41](https://github.com/rungalileo/cachegalileo/pull/41),
  [`046e4b7`](https://github.com/rungalileo/cachegalileo/commit/046e4b7fd16dde7684427fcd6420250d234dc1b0))

- **deps-dev**: Bump pytest from 8.3.4 to 8.3.5
  ([#39](https://github.com/rungalileo/cachegalileo/pull/39),
  [`087f970`](https://github.com/rungalileo/cachegalileo/commit/087f97029160ba98781b2918c5e2dace252fcaba))

- **release**: V0.11.2
  ([`3d6b3a7`](https://github.com/rungalileo/cachegalileo/commit/3d6b3a718f68c7f8654baccba090493e709c1319))


## v0.11.1 (2025-05-01)

### Chores

- **deps**: Bump codecov/codecov-action from 5.4.0 to 5.4.2
  ([#38](https://github.com/rungalileo/cachegalileo/pull/38),
  [`e609550`](https://github.com/rungalileo/cachegalileo/commit/e609550128394c751ad5b63d93e87f5340d77e4d))

- **release**: V0.11.1
  ([`1a0e09a`](https://github.com/rungalileo/cachegalileo/commit/1a0e09a342568b1ff83038d3a3472ef942d1a2e5))


## v0.11.0 (2025-04-24)

### Chores

- **release**: V0.11.0
  ([`ac106d0`](https://github.com/rungalileo/cachegalileo/commit/ac106d0b1e2ff9f823a8d8b6c24522d7829bcbbd))

### Features

- Custom serializers ([#37](https://github.com/rungalileo/cachegalileo/pull/37),
  [`84d05d7`](https://github.com/rungalileo/cachegalileo/commit/84d05d7adaaf93f93af7cfe03280fe3d8bd4daa1))

Adds supports for custom serializer to be used for a use case.

Also for large cache values we will run pickle.loads in separate thread

Motivation for this is potentially large latency for deserializing cache objects like caching user:
  https://rungalileo.grafana.net/d/bd8fc1a7-46bd-42ee-ae53-773c10128608/gcache?orgId=1&from=2025-04-23T02%3A15%3A09.560Z&to=2025-04-23T03%3A21%3A18.612Z&timezone=browser&var-customer=atypical&var-use_case=UserDAO%3A%3Aget_by_email_internal&var-layer=REMOTE&var-key_type=%24__all&refresh=5s


## v0.10.2 (2025-04-21)

### Chores

- Add instrumentation for serialization/deserialization
  ([#36](https://github.com/rungalileo/cachegalileo/pull/36),
  [`000291b`](https://github.com/rungalileo/cachegalileo/commit/000291b8f13f3bd5c27b1e24e3bf99c3adf0e9fe))

Instruments serializing and de-serializing values when caching in Redis layer.

- **release**: V0.10.2
  ([`cf04234`](https://github.com/rungalileo/cachegalileo/commit/cf042346f2acd267e5fbc88494a0dce1e034a328))


## v0.10.1 (2025-04-15)

### Bug Fixes

- Fix type definition for redis py options
  ([#35](https://github.com/rungalileo/cachegalileo/pull/35),
  [`afb0446`](https://github.com/rungalileo/cachegalileo/commit/afb04467d0bdf452b6fe7d19afe989b3e89ef84b))

### Chores

- **release**: V0.10.1
  ([`2ec9828`](https://github.com/rungalileo/cachegalileo/commit/2ec98283af2b1e4d7e109b6dc3064971d0038536))


## v0.10.0 (2025-04-14)

### Chores

- **release**: V0.10.0
  ([`573ff94`](https://github.com/rungalileo/cachegalileo/commit/573ff947681a1493542fbece75be27d27c09a582))

### Features

- Allow to pass in redis py options in config
  ([#34](https://github.com/rungalileo/cachegalileo/pull/34),
  [`4d1fca8`](https://github.com/rungalileo/cachegalileo/commit/4d1fca826ae2657aa74c175e3e328c961afd060e))

Allow to pass a dict of options that get passed directly to redispy client


## v0.9.0 (2025-03-29)

### Chores

- **release**: V0.9.0
  ([`f6aa281`](https://github.com/rungalileo/cachegalileo/commit/f6aa281ab6a4a0189938f2ee276198eb2b97ac02))

### Features

- Remove individual cache keys ([#33](https://github.com/rungalileo/cachegalileo/pull/33),
  [`c8b3b51`](https://github.com/rungalileo/cachegalileo/commit/c8b3b5106b46341981d2441a98bdd5041c455eb4))

Allows to remove individual cache keys.

it's up to the user to make sure they provide correct cache keys.


## v0.8.0 (2025-03-29)

### Chores

- **release**: V0.8.0
  ([`2a84ed4`](https://github.com/rungalileo/cachegalileo/commit/2a84ed4fae7e6eccda800b60f9514b27fff2329e))

### Features

- Use a thread pool in order to create multiple EventLoopThread(s)
  ([#32](https://github.com/rungalileo/cachegalileo/pull/32),
  [`59860a5`](https://github.com/rungalileo/cachegalileo/commit/59860a52c74f5241bbe17a53b3ea0da7842b8a4a))

When we cache non async functions we use a single EventLoopThread to execute it since all of the
  machinery of GCache is async otherwise.

However, this presents issues because if we have multiple requests they will only execute in single
  thread, and since we are executing sync functions they will block each other.

With this change, we will be using a simple wrapper on top of EventLoopThread which manages
  multiples of them and then picks one at random to execute a coroutine.


## v0.7.2 (2025-03-20)

### Bug Fixes

- Preserve function name after its decorated
  ([#30](https://github.com/rungalileo/cachegalileo/pull/30),
  [`4103470`](https://github.com/rungalileo/cachegalileo/commit/4103470cf74c8b03bbbb4942f4c3b4874e1156af))

Preserve function name after its being decorated.

This is important for instrumentation.

### Chores

- **release**: V0.7.2
  ([`4960b10`](https://github.com/rungalileo/cachegalileo/commit/4960b10cb88314ad762407fcd4e09b5379525804))


## v0.7.1 (2025-03-13)

### Bug Fixes

- Pretty print configs when serializing ([#29](https://github.com/rungalileo/cachegalileo/pull/29),
  [`7c0c7bb`](https://github.com/rungalileo/cachegalileo/commit/7c0c7bbca1e513980e3ae14c7424e99651439aab))

Previous iteration was serializing keys as quote escaped json, which doesn't pretty print properly
  when serialized.

With this change, the output JSON will be all entirely JSON, including key representation.

I also test that previous format will still be parsed correctly.

### Chores

- **release**: V0.7.1
  ([`36c12e1`](https://github.com/rungalileo/cachegalileo/commit/36c12e158becfa09aa10aebef3b0b78e7d636846))


## v0.7.0 (2025-03-12)

### Chores

- **release**: V0.7.0
  ([`4dec6af`](https://github.com/rungalileo/cachegalileo/commit/4dec6afc512ada409a6c541a8f6765b06559ca1a))

### Features

- Serialize/deserialize collection of configs
  ([#28](https://github.com/rungalileo/cachegalileo/pull/28),
  [`96c5c0e`](https://github.com/rungalileo/cachegalileo/commit/96c5c0e06040fafc191e64972126b5d5e462fcf7))

Fails open when there's exception in config provider, and also adds utilities to
  serialize/deserialize dicts of key configs.


## v0.6.0 (2025-03-08)

### Chores

- **release**: V0.6.0
  ([`433d440`](https://github.com/rungalileo/cachegalileo/commit/433d440644295d2f8eef8a5fd7247f03c1fc9128))

### Features

- Tolerate missing key configs, and missing parts of key config
  ([#27](https://github.com/rungalileo/cachegalileo/pull/27),
  [`8e3afb0`](https://github.com/rungalileo/cachegalileo/commit/8e3afb04b8b6a4402a5949326aef697f39904ab7))

If key config is not found for use case, then we will just skip caching altogether. Same applies for
  missing ttl/ramp values.


## v0.5.0 (2025-03-06)

### Chores

- **release**: V0.5.0
  ([`7216a72`](https://github.com/rungalileo/cachegalileo/commit/7216a7280194a4d55233d1173172d380f2adeb03))

### Features

- Allow to extract different value from an id arg and include it as args in cache key
  ([#26](https://github.com/rungalileo/cachegalileo/pull/26),
  [`9bf48eb`](https://github.com/rungalileo/cachegalileo/commit/9bf48ebbedc4731e95b1dac646e4f9ec2c42493f))

This change allows to include id_arg name in arg_adapters and have it be included as args.

This is useful in a case where you want to use one value from an id value for cache key id, but a
  different value that is included as part of the args.

Contrived example: we have a class `CarMake` and we have a function to compute number of cars.

We want our cache key id to be based off of `make` because we have other functions that cache by car
  make, maybe something like `get_car_make_counts(make: str)` which gets counts for all releases for
  specific make of the car.

```python @dataclass class CarMake: make: str year: int

.... @gcache.cached( key_type="car_make", id_arg=("car", lambda car: car.make), arg_adapters={
  "car": lambda car: f"{car.make}, {car.year}" }, track_for_invalidation=True ) def
  get_car_count_for_year(car: Car): """Get car count for make/year""" .... ```

So in this case we are caching by both make and year, while keeping key type and its id to just make
  of the car.

When its time to invalidate by car make we can invalidate all caches with that key type. We will
  invalidate caches for both `get_car_count_for_year` and `get_car_make_counts`


## v0.4.2 (2025-03-05)

### Bug Fixes

- Do not initialize event loop thread on __del__
  ([#25](https://github.com/rungalileo/cachegalileo/pull/25),
  [`9f4bef0`](https://github.com/rungalileo/cachegalileo/commit/9f4bef0d707fd124e190cee7a59e76eecbabf180))

This should prevent main process for uvicorn/gunicorn hanging when exiting.

### Chores

- **release**: V0.4.2
  ([`ad20dd1`](https://github.com/rungalileo/cachegalileo/commit/ad20dd1b9149ed45905581ae608d528188c261b1))


## v0.4.1 (2025-03-04)

### Bug Fixes

- Eventloopthread is now run in daemon mode
  ([#24](https://github.com/rungalileo/cachegalileo/pull/24),
  [`04b3b5a`](https://github.com/rungalileo/cachegalileo/commit/04b3b5a3ec45719d89a158a8e3195c872e96b2af))

EventLoopThread now runs in daemon mode which means that when process is shutting down it won't
  prevent it.

### Chores

- **release**: V0.4.1
  ([`9339b30`](https://github.com/rungalileo/cachegalileo/commit/9339b30286b3dd09442088b817ce92b872aa9df3))


## v0.4.0 (2025-03-04)

### Chores

- **release**: V0.4.0
  ([`3a470a6`](https://github.com/rungalileo/cachegalileo/commit/3a470a6fc779a8b7c64a242ad2fe916a91a3d66f))

### Features

- Allow users to explicitly disable cache
  ([#23](https://github.com/rungalileo/cachegalileo/pull/23),
  [`be6dbc4`](https://github.com/rungalileo/cachegalileo/commit/be6dbc4253308ccfa3c9c97efadc43d039cfcffe))

Adds ability to disable cache via context manager


## v0.3.0 (2025-03-04)

### Chores

- **release**: V0.3.0
  ([`edee9cf`](https://github.com/rungalileo/cachegalileo/commit/edee9cfccab6c0537346822943fc3fb10652728a))

### Features

- Tolerate key creation failures ([#22](https://github.com/rungalileo/cachegalileo/pull/22),
  [`24f7c99`](https://github.com/rungalileo/cachegalileo/commit/24f7c99b1d200863192dcc856b4c0a8c11ed8c00))

* feat: Instrument invalidation count and key error count:

* Update behavior to use fallback when we can't create key

* Update label


## v0.2.1 (2025-03-03)

### Bug Fixes

- Fix Redis async client not playing nice with FastAPI
  ([#21](https://github.com/rungalileo/cachegalileo/pull/21),
  [`4acd2d4`](https://github.com/rungalileo/cachegalileo/commit/4acd2d457a924c3c7e2aab777d45648b08aa95b2))

* chore: Fix Redis async client not playing nice with FastAPI

* fixups

* Coerce watermark to float

* fix

* revert

* getridof

* revertline

### Chores

- **deps**: Bump codecov/codecov-action from 5.3.1 to 5.4.0
  ([#20](https://github.com/rungalileo/cachegalileo/pull/20),
  [`6ab3ae3`](https://github.com/rungalileo/cachegalileo/commit/6ab3ae3f98f7fbe7ab59af7c9c78a9330fd9c4bf))

Bumps [codecov/codecov-action](https://github.com/codecov/codecov-action) from 5.3.1 to 5.4.0. -
  [Release notes](https://github.com/codecov/codecov-action/releases) -
  [Changelog](https://github.com/codecov/codecov-action/blob/main/CHANGELOG.md) -
  [Commits](https://github.com/codecov/codecov-action/compare/v5.3.1...v5.4.0)

--- updated-dependencies: - dependency-name: codecov/codecov-action dependency-type:
  direct:production

update-type: version-update:semver-minor ...

Signed-off-by: dependabot[bot] <support@github.com>

Co-authored-by: dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>

- **deps**: Bump python-semantic-release/python-semantic-release
  ([#19](https://github.com/rungalileo/cachegalileo/pull/19),
  [`4bc26ef`](https://github.com/rungalileo/cachegalileo/commit/4bc26efea38b0bf3cb0b2d0548f566f7196b2d9b))

Bumps
  [python-semantic-release/python-semantic-release](https://github.com/python-semantic-release/python-semantic-release)
  from 9.20.0 to 9.21.0. - [Release
  notes](https://github.com/python-semantic-release/python-semantic-release/releases) -
  [Changelog](https://github.com/python-semantic-release/python-semantic-release/blob/master/CHANGELOG.rst)
  -
  [Commits](https://github.com/python-semantic-release/python-semantic-release/compare/v9.20.0...v9.21.0)

--- updated-dependencies: - dependency-name: python-semantic-release/python-semantic-release
  dependency-type: direct:production

update-type: version-update:semver-minor ...

Signed-off-by: dependabot[bot] <support@github.com>

Co-authored-by: dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>

- **release**: V0.2.1
  ([`78aecc9`](https://github.com/rungalileo/cachegalileo/commit/78aecc90aa5c3085b2c8f7a3694d7ea27191a1db))


## v0.2.0 (2025-03-01)

### Chores

- **release**: V0.2.0
  ([`f1a4893`](https://github.com/rungalileo/cachegalileo/commit/f1a4893c12434514528fd45e28c7f392aabf1183))

### Features

- Optional RedisConfig ([#18](https://github.com/rungalileo/cachegalileo/pull/18),
  [`a24300e`](https://github.com/rungalileo/cachegalileo/commit/a24300ec4d877b6c1de7f27b9dcc56e0ff075762))


## v0.1.5 (2025-02-26)

### Bug Fixes

- Tolerate Redis being down ([#17](https://github.com/rungalileo/cachegalileo/pull/17),
  [`21877b1`](https://github.com/rungalileo/cachegalileo/commit/21877b191add8dbed3a73af31bb5a067fb72ac69))

### Chores

- **release**: V0.1.5
  ([`758cbc0`](https://github.com/rungalileo/cachegalileo/commit/758cbc0a7af3f7ccee3b87300c75c14503a95b5d))


## v0.1.4 (2025-02-25)

### Bug Fixes

- Always return false when ramp is 0 and true if its 100
  ([`440e54e`](https://github.com/rungalileo/cachegalileo/commit/440e54eb295efb366094c2290dfa840db2ac1e36))

### Chores

- **release**: V0.1.4
  ([`c216c6c`](https://github.com/rungalileo/cachegalileo/commit/c216c6cb93f1658087a028b54e36589285ab2523))


## v0.1.3 (2025-02-25)

### Bug Fixes

- Increment counter
  ([`029dc54`](https://github.com/rungalileo/cachegalileo/commit/029dc5469d976fcac66d6b11f334ddd9681f3cfb))

### Chores

- **release**: V0.1.3
  ([`0a722d7`](https://github.com/rungalileo/cachegalileo/commit/0a722d78113080c5d0ecdb38874758017a7067a2))


## v0.1.2 (2025-02-25)

### Bug Fixes

- Fix layer label for cache disabled counter
  ([`ad1d9e7`](https://github.com/rungalileo/cachegalileo/commit/ad1d9e779184e3f16acbb45005b8fbf5c514f21a))

### Chores

- **release**: V0.1.2
  ([`21289c0`](https://github.com/rungalileo/cachegalileo/commit/21289c00ad8b2506e806ab433e8ddda1ba205227))


## v0.1.1 (2025-02-25)

### Bug Fixes

- Json serialization for GCacheKeyConfig ([#16](https://github.com/rungalileo/cachegalileo/pull/16),
  [`56ba27d`](https://github.com/rungalileo/cachegalileo/commit/56ba27dbfc91c6083f8efc33efac29ca3d36f1e0))

* fix: Do not write back cache in Redis when its invalidated

* feat: Add flushall

* Add type annotation

* fix: JSON serialization for GCacheKeyConfig

### Chores

- **release**: V0.1.1
  ([`e273d33`](https://github.com/rungalileo/cachegalileo/commit/e273d33482c9d3dab0a1995865e3a6f411613a5f))


## v0.1.0 (2025-02-24)

### Chores

- **release**: V0.1.0
  ([`0bc6951`](https://github.com/rungalileo/cachegalileo/commit/0bc695161b56dac1145f70e3ba326beee29a65a9))

### Features

- Add flushall ([#15](https://github.com/rungalileo/cachegalileo/pull/15),
  [`226e8b4`](https://github.com/rungalileo/cachegalileo/commit/226e8b4a81e674b0112c422c128e43839476914d))

* fix: Do not write back cache in Redis when its invalidated

* feat: Add flushall

* Add type annotation


## v0.0.10 (2025-02-24)

### Bug Fixes

- Do not write back cache in Redis when its invalidated
  ([#14](https://github.com/rungalileo/cachegalileo/pull/14),
  [`17fed9b`](https://github.com/rungalileo/cachegalileo/commit/17fed9b9cecbea0f5d3d823fe36da0387e6a347e))

### Chores

- **release**: V0.0.10
  ([`ae3d5cf`](https://github.com/rungalileo/cachegalileo/commit/ae3d5cf4c3fdd7408f6f844623e2820d331c6c98))


## v0.0.9 (2025-02-24)

### Bug Fixes

- Subtract fallback time from cache get time.
  ([#13](https://github.com/rungalileo/cachegalileo/pull/13),
  [`21b1139`](https://github.com/rungalileo/cachegalileo/commit/21b1139b1b15a52250a583b525e0e89eb7f6cc56))

* fix: Increment cache disabled counter

* fix: Fix early termination when cache is disabled

* fix: subtract fallback time from get time

### Chores

- **release**: V0.0.9
  ([`6fb2e5c`](https://github.com/rungalileo/cachegalileo/commit/6fb2e5c5a5579e2a610a6880d87d74a481a38a1f))


## v0.0.8 (2025-02-24)

### Bug Fixes

- Fix early termination when gcache is disabled.
  ([#12](https://github.com/rungalileo/cachegalileo/pull/12),
  [`a714e66`](https://github.com/rungalileo/cachegalileo/commit/a714e66910b68111923490d012c393bd372fdc49))

* fix: Increment cache disabled counter

* fix: Fix early termination when cache is disabled

### Chores

- **release**: V0.0.8
  ([`46e518a`](https://github.com/rungalileo/cachegalileo/commit/46e518aec336f7a8718f36329aab03881964d3ee))


## v0.0.7 (2025-02-24)

### Bug Fixes

- Increment cache disabled counter ([#11](https://github.com/rungalileo/cachegalileo/pull/11),
  [`d44ce55`](https://github.com/rungalileo/cachegalileo/commit/d44ce556ade70f5c50116347740cfea663f521fc))

### Chores

- **release**: V0.0.7
  ([`c78790f`](https://github.com/rungalileo/cachegalileo/commit/c78790f9129f8ee4bd07a6333a2b228c069c7adf))


## v0.0.6 (2025-02-24)

### Chores

- Add GCacheKey to export ([#10](https://github.com/rungalileo/cachegalileo/pull/10),
  [`645e575`](https://github.com/rungalileo/cachegalileo/commit/645e575d25d97a3ac8a3ba0e1d0064e2f998e66a))

* chore: Cleaning up code

* Some more comments

* More documentation

* todo

* Remove import from readme

* fixups

* chore: Add GCacheKey to export

- **release**: V0.0.6
  ([`ff430af`](https://github.com/rungalileo/cachegalileo/commit/ff430af8ecbd0895c6ac2e90b0fd5d98c5e1cc20))


## v0.0.5 (2025-02-24)

### Chores

- Update README ([#9](https://github.com/rungalileo/cachegalileo/pull/9),
  [`15adb5c`](https://github.com/rungalileo/cachegalileo/commit/15adb5c8ed5bba4b82061cf05f0235b5be811469))

* chore: Cleaning up code

* Some more comments

* More documentation

* todo

* Remove import from readme

* fixups

- **release**: V0.0.5
  ([`0be74e2`](https://github.com/rungalileo/cachegalileo/commit/0be74e204c5981df6ba37b6f699bb52454af623d))


## v0.0.4 (2025-02-24)

### Chores

- Cleaning up code and documentation ([#8](https://github.com/rungalileo/cachegalileo/pull/8),
  [`c86a7c5`](https://github.com/rungalileo/cachegalileo/commit/c86a7c5ad732dc4d030e1b3211d010a3f5915b03))

* chore: Cleaning up code

* Some more comments

* More documentation

* todo

* Remove import from readme

- **release**: V0.0.4
  ([`40447e6`](https://github.com/rungalileo/cachegalileo/commit/40447e6ee0c9f05f61bb7ff874774e4caac77395))


## v0.0.3 (2025-02-22)

### Chores

- Add comment in local cache
  ([`0bbc2ed`](https://github.com/rungalileo/cachegalileo/commit/0bbc2ede275fd735f35e47e4ff7e6a17b76575d2))

- **release**: V0.0.3
  ([`5aa1036`](https://github.com/rungalileo/cachegalileo/commit/5aa103632fb3a9e1a37d0d57979c46d5062e2947))

### Testing

- Change port ([#7](https://github.com/rungalileo/cachegalileo/pull/7),
  [`164ae25`](https://github.com/rungalileo/cachegalileo/commit/164ae25343c346a621dd159cf4d45b4df671f1ba))

* test: Change port

* stash

* test: Fix tests to run on a different port

* chore: Type tests

* fix: Initialize config properly

* chore: Use `project` correctly

* ci: Fix release workflow

* test: Run all tests


## v0.0.2 (2025-02-21)

### Chores

- Rename `gcache` => `cachegalileo`, setup project with `poetry` v2
  ([#6](https://github.com/rungalileo/cachegalileo/pull/6),
  [`4c2de97`](https://github.com/rungalileo/cachegalileo/commit/4c2de976c78a4bde4fd8bfa7b2212d53563b3eba))

* refactor: `gcache` => `cachegalileo`

* chore: Use Poetry v2 config, rename

* chore: Monthly dependabot

* chore: Codeowners to all of platform team

* chore: Update pre-commit hooks

* style: Apply pre-commit hooks

* ci: Use v2

* chore: Remove arg

* chore: Add pytest config

* test: Measure coverage for cachegalileo

- **release**: V0.0.2
  ([`bc037ef`](https://github.com/rungalileo/cachegalileo/commit/bc037ef5fee472b23d8b8d1556472d2c196e2acf))


## v0.0.1 (2025-02-21)

### Chores

- **release**: V0.0.1
  ([`79ddbb0`](https://github.com/rungalileo/cachegalileo/commit/79ddbb0a39b16bf75c896f82bb3e44d09621e9a5))


## v0.0.0 (2025-02-21)

### Chores

- **release**: V0.0.0
  ([`c8ad7ca`](https://github.com/rungalileo/cachegalileo/commit/c8ad7ca84baa8f4a2642b6fee756047d769589b4))
