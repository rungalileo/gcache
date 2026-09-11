package dialcache

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"
)

// validateJSON refuses duplicate keys, avoiding encoding/json's last-key-wins
// behavior at the action/expectation trust boundary.
func validateJSON(raw []byte) error {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	var value func() error
	value = func() error {
		token, err := d.Token()
		if err != nil {
			return err
		}
		delim, ok := token.(json.Delim)
		if !ok {
			return nil
		}
		switch delim {
		case '{':
			seen := map[string]bool{}
			for d.More() {
				key, err := d.Token()
				if err != nil {
					return err
				}
				name, ok := key.(string)
				if !ok || seen[name] {
					return fmt.Errorf("invalid/duplicate key %v", key)
				}
				seen[name] = true
				if err := value(); err != nil {
					return err
				}
			}
		case '[':
			for d.More() {
				if err := value(); err != nil {
					return err
				}
			}
		default:
			return errors.New("unexpected closing delimiter")
		}
		_, err = d.Token()
		return err
	}
	if err := value(); err != nil {
		return err
	}
	if _, err := d.Token(); err != io.EOF {
		return errors.New("trailing JSON content")
	}
	return nil
}

type manualClock struct {
	mu            sync.Mutex
	wall, elapsed int64
}

func (c *manualClock) WallMS() int64    { c.mu.Lock(); defer c.mu.Unlock(); return c.wall }
func (c *manualClock) ElapsedMS() int64 { c.mu.Lock(); defer c.mu.Unlock(); return c.elapsed }
func (c *manualClock) tickWall()        { c.mu.Lock(); c.wall++; c.mu.Unlock() }

type integerCodec struct{}

func (integerCodec) Encode(v int64) (Payload, error) {
	return Payload{Bytes: []byte(strconv.FormatInt(v, 10))}, nil
}
func (integerCodec) Decode(payload Payload) (int64, error) {
	return strconv.ParseInt(string(payload.Bytes), 10, 64)
}

type remoteEntry struct {
	raw     []byte
	expires int64
}
type memoryRemote struct {
	mu            sync.Mutex
	clock         Clock
	values        map[string]remoteEntry
	watermarks    map[string]string
	reads, writes int64
	readFailure   bool
	discardWrites bool
}

func (r *memoryRemote) Read(_ context.Context, key, watermarkKey string) (ReadResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.reads++
	if r.readFailure {
		return ReadResult{}, errors.New("controlled read failure")
	}
	entry, found := r.values[key]
	var raw []byte
	if found && r.clock.ElapsedMS() < entry.expires {
		raw = append([]byte{}, entry.raw...)
	}
	var watermark *string
	if value, found := r.watermarks[watermarkKey]; found && watermarkKey != "" {
		watermark = &value
	}
	return DecodeFrame(raw, watermarkKey != "", watermark), nil
}
func (r *memoryRemote) Write(_ context.Context, key string, frame Frame, ttl int64) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.writes++
	if r.discardWrites {
		return nil
	}
	raw, err := EncodeFrame(frame)
	if err != nil {
		return err
	}
	r.values[key] = remoteEntry{raw: raw, expires: r.clock.ElapsedMS() + ttl}
	return nil
}
func (r *memoryRemote) Invalidate(_ context.Context, key string, now, buffer int64) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.writes++
	cutoff := now + buffer
	old, _ := strconv.ParseInt(r.watermarks[key], 10, 64)
	if cutoff < old {
		cutoff = old
	}
	r.watermarks[key] = strconv.FormatInt(cutoff, 10)
	return nil
}
func (r *memoryRemote) failReads(fail bool) { r.mu.Lock(); r.readFailure = fail; r.mu.Unlock() }

type callResult struct {
	value int64
	err   error
}
type coreDriver struct {
	cache        *Cache[int64]
	remote       *memoryRemote
	clock        *manualClock
	mu           sync.Mutex
	source, last int64
	loaders      map[string]int64
	events       chan Event
}

func newCoreDriver() *coreDriver {
	d := &coreDriver{clock: &manualClock{wall: 1788868800000}, source: 1, loaders: make(map[string]int64), events: make(chan Event, 64)}
	d.remote = &memoryRemote{clock: d.clock, values: make(map[string]remoteEntry), watermarks: make(map[string]string)}
	d.cache = New(Options[int64]{Clock: d.clock, Remote: d.remote, Codec: integerCodec{}, LocalCapacity: 10000, Observe: func(event Event) {
		if event.Kind == "coalesced" {
			d.events <- event
		}
	}})
	return d
}
func (d *coreDriver) loader(counter string, gate <-chan struct{}, started chan<- struct{}) func(context.Context) (int64, error) {
	return func(context.Context) (int64, error) {
		d.mu.Lock()
		d.loaders[counter]++
		value := d.source
		d.mu.Unlock()
		if started != nil {
			started <- struct{}{}
		}
		if gate != nil {
			<-gate
		}
		return value, nil
	}
}
func coreOperation(useCase string) Operation {
	return Operation{Identity: Identity{Namespace: "urn", KeyType: "user_id", ID: "123", UseCase: useCase}}
}
func (d *coreDriver) enabled(op Operation, counter string) (int64, error) {
	var value int64
	err := d.cache.Enable(context.Background(), func(ctx context.Context) error {
		var err error
		value, err = d.cache.GetOrLoad(ctx, op, d.loader(counter, nil, nil))
		return err
	})
	return value, err
}

// pair keeps the leader's external source unresolved until an actual follower
// observer callback (or an unexpected second loader) establishes overlap. A
// warm-cache first call instead establishes its completion through its result.
// The timeout only detects a deadlocked implementation; it schedules no work.
func (d *coreDriver) pair(op Operation, counter string) (int64, error) {
	watchdog := time.NewTimer(5 * time.Second)
	defer watchdog.Stop()
	gate := make(chan struct{})
	started := make(chan struct{}, 2)
	results := make(chan callResult, 2)
	load := d.loader(counter, gate, started)
	call := func() {
		var value int64
		err := d.cache.Enable(context.Background(), func(ctx context.Context) error {
			var err error
			value, err = d.cache.GetOrLoad(ctx, op, load)
			return err
		})
		results <- callResult{value, err}
	}
	go call()
	var first *callResult
	select {
	case result := <-results:
		first = &result
		go call()
		close(gate)
	case <-started:
		go call()
		select {
		case event := <-d.events:
			if event.Kind != "coalesced" || event.Scope != "process" {
				close(gate)
				return 0, errors.New("unexpected pair observation")
			}
		case <-started: // Lost sharing remains observable in loader counts.
		case <-watchdog.C:
			close(gate)
			return 0, errors.New("follower did not make observable progress")
		}
		close(gate)
	case <-watchdog.C:
		close(gate)
		return 0, errors.New("leader did not make observable progress")
	}
	awaitResult := func(phase string) (callResult, error) {
		select {
		case result := <-results:
			return result, nil
		case <-watchdog.C:
			return callResult{}, fmt.Errorf("coalesced pair did not complete %s after source release", phase)
		}
	}
	if first == nil {
		result, err := awaitResult("first result")
		if err != nil {
			return 0, err
		}
		first = &result
	}
	second, err := awaitResult("second result")
	if err != nil {
		return 0, err
	}
	if first.err != nil {
		return 0, first.err
	}
	if second.err != nil {
		return 0, second.err
	}
	if first.value != second.value {
		return 0, errors.New("pair returned different values")
	}
	return first.value, nil
}

// apply has no expected-state parameter. Its only model-derived input is the
// selected public action; cache publication is tested by later actual calls.
func (d *coreDriver) apply(input obj) error {
	switch input["op"] {
	case "advanceWall":
		d.clock.mu.Lock()
		d.clock.wall += bn(input["ms"])
		d.clock.mu.Unlock()
		return nil
	case "bumpSource":
		d.mu.Lock()
		d.source++
		d.mu.Unlock()
		return nil
	case "invalidate":
		identity := bm(input["identity"])
		return d.cache.Invalidate(context.Background(), Identity{Namespace: "urn", KeyType: bs(identity["keyType"]), ID: bs(identity["id"])}, 0)
	case "call":
		identity := bm(input["identity"])
		policy, err := ParsePolicy(input["policy"])
		if err != nil {
			return err
		}
		op := Operation{Identity: Identity{Namespace: "urn", KeyType: bs(identity["keyType"]), ID: bs(identity["id"]), UseCase: bs(identity["useCase"]), Tracked: bb(identity["tracked"])}, Policy: policy}
		counter := bs(input["counter"])
		d.remote.failReads(bb(input["readFailure"]))
		defer d.remote.failReads(false)
		var value int64
		switch input["mode"] {
		case "outside":
			value, err = d.cache.GetOrLoad(context.Background(), op, d.loader(counter, nil, nil))
		case "single":
			value, err = d.enabled(op, counter)
		case "coalesced-pair":
			value, err = d.pair(op, counter)
		case "request-pair":
			err = d.cache.Enable(context.Background(), func(ctx context.Context) error {
				var err error
				value, err = d.cache.GetOrLoad(ctx, op, d.loader(counter, nil, nil))
				if err != nil {
					return err
				}
				second, err := d.cache.GetOrLoad(ctx, op, d.loader(counter, nil, nil))
				if err != nil {
					return err
				}
				if second != value {
					return errors.New("request pair differs")
				}
				return nil
			})
		default:
			return errors.New("unknown core call mode")
		}
		if err == nil {
			d.mu.Lock()
			d.last = value
			d.mu.Unlock()
		}
		return err
	default:
		return errors.New("unknown core driver command")
	}
}

func (d *coreDriver) observation() map[string]int64 {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.remote.mu.Lock()
	defer d.remote.mu.Unlock()
	out := map[string]int64{"sourceVersion": d.source, "lastResult": d.last, "redisReads": d.remote.reads, "redisWrites": d.remote.writes}
	for _, field := range []string{"outsideLoaderCalls", "requestLoaderCalls", "localLoaderCalls", "coalescedLoaderCalls", "remoteLoaderCalls"} {
		if _, found := out[field]; !found {
			out[field] = d.loaders[field]
		}
	}
	return out
}
func replayCoreWithDriver(coordinator *replayCoordinator, prepared obj, d *coreDriver) error {
	observe := func() obj {
		out := obj{}
		for field, value := range d.observation() {
			out[field] = value
		}
		return out
	}
	return coordinator.execute(prepared, d.apply, observe, d.clock.WallMS)
}

func TestCoreConformance(t *testing.T) {
	coordinator := newReplayCoordinator(t)
	info, err := coordinator.call(obj{"op": "profiles"})
	if err != nil {
		t.Fatal(err)
	}
	coreActions := map[string]bool{"init": true}
	for _, action := range ba(bm(info["profiles"])["core"]) {
		coreActions[bs(action)] = true
	}
	requireRegistry(t)
	paths := []string{"../formal/conformance-smoke.itf.json"}
	file, directory := os.Getenv("DIALCACHE_MBT_TRACE_FILE"), os.Getenv("DIALCACHE_MBT_TRACE_DIR")
	if file != "" && directory != "" {
		t.Fatal("select either a trace file or directory")
	}
	if file != "" {
		paths = []string{file}
	}
	if directory != "" {
		var err error
		paths, err = filepath.Glob(filepath.Join(directory, "*.itf.json"))
		if err != nil {
			t.Fatal(err)
		}
		if len(paths) == 0 {
			t.Fatal("empty trace corpus")
		}
		regressions, err := featureRegressionPaths("core", directory)
		if err != nil {
			t.Fatal(err)
		}
		paths = append(paths, regressions...)
	}
	actions := map[string]bool{}
	for _, path := range paths {
		t.Run(filepath.Base(path), func(t *testing.T) {
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			prepared, err := coordinator.prepare("core", path, raw)
			if err != nil {
				t.Fatal(err)
			}
			for _, action := range ba(prepared["actions"]) {
				actions[bs(action)] = true
			}
			if err := replayCoreWithDriver(coordinator, prepared, newCoreDriver()); err != nil {
				t.Fatal(err)
			}
		})
	}
	if directory != "" {
		for action := range coreActions {
			if !actions[action] {
				t.Errorf("generated corpus missing action %s", action)
			}
		}
	}
	t.Logf("core profile: %d traces; %d/%d actions observed", len(paths), len(actions), len(coreActions))
}

func TestCoreParserAndObservationBoundary(t *testing.T) {
	coordinator := newReplayCoordinator(t)
	raw, err := os.ReadFile("../formal/conformance-smoke.itf.json")
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := coordinator.prepare("core", "../formal/conformance-smoke.itf.json", raw)
	if err != nil {
		t.Fatal(err)
	}
	broken := newCoreDriver()
	broken.remote.discardWrites = true
	if err := replayCoreWithDriver(coordinator, prepared, broken); err == nil {
		t.Fatal("acknowledged but lost publication did not diverge on a later public read")
	}
	decoded, err := behaviorJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	initial := bm(ba(bm(decoded)["states"])[0])
	bm(initial["s"])["redisReads"] = obj{"#bigint": "1"}
	prepared, err = coordinator.prepare("core", "corrupt-observation", []byte(bjson(decoded)))
	if err != nil {
		t.Fatal(err)
	}
	if err := replayCoreWithDriver(coordinator, prepared, newCoreDriver()); err == nil {
		t.Fatal("corrupted expectation did not fail independently observed replay")
	}
	var original struct {
		States []json.RawMessage `json:"states"`
	}
	if err := json.Unmarshal(raw, &original); err != nil {
		t.Fatal(err)
	}
	t.Run("explicit inputs without MBT metadata", func(t *testing.T) {
		var trace struct {
			States []map[string]json.RawMessage `json:"states"`
		}
		if err := json.Unmarshal(raw, &trace); err != nil {
			t.Fatal(err)
		}
		for _, state := range trace.States {
			delete(state, "mbt::actionTaken")
			delete(state, "mbt::nondetPicks")
		}
		explicit, err := json.Marshal(trace)
		if err != nil {
			t.Fatal(err)
		}
		prepared, err := coordinator.prepare("core", "explicit-core", explicit)
		if err != nil {
			t.Fatal(err)
		}
		if err := replayCoreWithDriver(coordinator, prepared, newCoreDriver()); err != nil {
			t.Fatal(err)
		}
	})
	initOnly, err := json.Marshal(map[string]any{"states": original.States[:1]})
	if err != nil {
		t.Fatal(err)
	}
	for name, malformed := range map[string][]byte{
		"empty":               []byte(`{"states":[]}`),
		"missing input":       bytes.Replace(raw, []byte(`"input": {`), []byte(`"missingInput": {`), 1),
		"explicit arguments":  bytes.Replace(raw, []byte(`"#bigint": "-1"`), []byte(`"#bigint": "0"`), 1),
		"init only":           initOnly,
		"unknown action":      bytes.Replace(raw, []byte(`"mbt::actionTaken": "outsideCall"`), []byte(`"mbt::actionTaken": "inventedAction"`), 1),
		"missing init":        bytes.Replace(raw, []byte(`"mbt::actionTaken": "init"`), []byte(`"mbt::actionTaken": "localCall"`), 1),
		"arguments":           bytes.Replace(raw, []byte(`"mbt::nondetPicks": {}`), []byte(`"mbt::nondetPicks": {"choice":1}`), 1),
		"unsafe integer":      bytes.Replace(raw, []byte(`"#bigint": "1"`), []byte(`"#bigint": "9007199254740992"`), 1),
		"missing observation": bytes.Replace(raw, []byte(`"sourceVersion"`), []byte(`"missingField"`), 1),
		"duplicate action":    bytes.Replace(raw, []byte(`"mbt::actionTaken": "init"`), []byte(`"mbt::actionTaken": "init", "mbt::actionTaken": "init"`), 1),
	} {
		t.Run(name, func(t *testing.T) {
			if bytes.Equal(raw, malformed) {
				t.Fatal("negative control did not change its target field")
			}
			if _, err := coordinator.prepare("core", "malformed-core", malformed); err == nil {
				t.Fatal("malformed trace accepted")
			}
		})
	}
}
