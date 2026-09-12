package dialcache

// This driver controls external callbacks and explicit request contexts. No
// model expectation or private cache field enters any execution method.
import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"
)

type obj = map[string]any

func bm(v any) obj {
	if x, ok := v.(map[string]any); ok {
		return x
	}
	return obj{}
}
func bs(v any) string { x, _ := v.(string); return x }
func bn(v any) int64 {
	switch x := v.(type) {
	case float64:
		return int64(x)
	case int:
		return int64(x)
	case int64:
		return x
	case json.Number:
		n, _ := x.Int64()
		return n
	}
	return 0
}
func bf(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case int:
		return float64(x)
	case int64:
		return float64(x)
	case uint64:
		return float64(x)
	case json.Number:
		n, _ := x.Float64()
		return n
	}
	return 0
}
func bb(v any) bool  { x, _ := v.(bool); return x }
func ba(v any) []any { x, _ := v.([]any); return x }
func bdefault(m obj, key string, fallback any) any {
	if v, ok := m[key]; ok {
		return v
	}
	return fallback
}
func bclone(v any) any {
	// Observations contain JSON-shaped values. Copy containers directly rather
	// than serializing their growing event histories at every replay step.
	switch x := v.(type) {
	case nil, string, bool, float64:
		return x
	case int:
		return float64(x)
	case int64:
		return float64(x)
	case uint64:
		return float64(x)
	case json.Number:
		n, err := x.Float64()
		if err != nil {
			panic(err)
		}
		return n
	case map[string]any:
		out := make(obj, len(x))
		for k, v := range x {
			out[k] = bclone(v)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, v := range x {
			out[i] = bclone(v)
		}
		return out
	case []string:
		out := make([]any, len(x))
		for i, v := range x {
			out[i] = v
		}
		return out
	case []int:
		out := make([]any, len(x))
		for i, v := range x {
			out[i] = float64(v)
		}
		return out
	case []int64:
		out := make([]any, len(x))
		for i, v := range x {
			out[i] = float64(v)
		}
		return out
	}
	raw, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	var out any
	if err = json.Unmarshal(raw, &out); err != nil {
		panic(err)
	}
	return out
}
func bequal(a, b any) bool {
	// Compare JSON numbers across the decoder's float and callback's integer
	// representations without cloning both complete event histories.
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	switch x := a.(type) {
	case map[string]any:
		y, ok := b.(map[string]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for k, v := range x {
			other, present := y[k]
			if !present || !bequal(v, other) {
				return false
			}
		}
		return true
	case []any:
		y, ok := b.([]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for i, v := range x {
			if !bequal(v, y[i]) {
				return false
			}
		}
		return true
	case float64, int, int64, uint64, json.Number:
		switch b.(type) {
		case float64, int, int64, uint64, json.Number:
			return bf(a) == bf(b)
		default:
			return false
		}
	default:
		return reflect.DeepEqual(a, b)
	}
}
func bjson(v any) string { raw, _ := json.Marshal(v); return string(raw) }

type behaviorTimer struct {
	clock   *behaviorClock
	at      int64
	id      int
	fn      func()
	stopped bool
}

func (t *behaviorTimer) Stop() bool {
	t.clock.mu.Lock()
	defer t.clock.mu.Unlock()
	if t.stopped {
		return false
	}
	t.stopped = true
	return true
}

// Scheduler time is independent of elapsed observations. Advancing a clock
// without delivering timers does not invent a successful scheduling turn.
type behaviorClock struct {
	mu                       sync.Mutex
	wall, elapsed, scheduler int64
	next                     int
	timers                   []*behaviorTimer
	deferred                 []func()
}

// Only local storage uses Clock.ElapsedMS directly; deadlines and diagnostic
// timing use PreciseClock.ElapsedTime. A controlled failure at this public
// clock boundary exercises the real local-read/local-write panic isolation.
// No model observation supplies a cache value or result to this binding.
type behaviorLocalFaultClock struct {
	*behaviorClock
	driver *behaviorDriver
}

func (c behaviorLocalFaultClock) ElapsedTime() time.Duration {
	return time.Duration(c.behaviorClock.ElapsedMS()) * time.Millisecond
}

func (c behaviorLocalFaultClock) ElapsedMS() int64 {
	if c.driver.fault("localStorage") {
		panic("controlled local storage failure")
	}
	return c.behaviorClock.ElapsedMS()
}

func (c *behaviorClock) WallMS() int64    { c.mu.Lock(); defer c.mu.Unlock(); return c.wall }
func (c *behaviorClock) ElapsedMS() int64 { c.mu.Lock(); defer c.mu.Unlock(); return c.elapsed }
func (c *behaviorClock) AfterFunc(ms int64, fn func()) Timer {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.next++
	t := &behaviorTimer{clock: c, at: c.scheduler + ms, id: c.next, fn: fn}
	c.timers = append(c.timers, t)
	return t
}
func (c *behaviorClock) Defer(fn func()) {
	c.mu.Lock()
	c.deferred = append(c.deferred, fn)
	c.mu.Unlock()
}
func (c *behaviorClock) shift(ms int64, wallOnly bool) {
	c.mu.Lock()
	c.wall += ms
	if !wallOnly {
		c.elapsed += ms
	}
	c.mu.Unlock()
}
func (c *behaviorClock) drain() {
	for {
		synctest.Wait()
		c.mu.Lock()
		pending := c.deferred
		c.deferred = nil
		c.mu.Unlock()
		if len(pending) == 0 {
			return
		}
		for _, fn := range pending {
			go fn()
		}
	}
}
func (c *behaviorClock) advance(ms int64, deliver bool) {
	if !deliver {
		c.shift(ms, false)
		c.drain()
		return
	}
	c.mu.Lock()
	target := c.scheduler + ms
	c.mu.Unlock()
	for {
		c.drain()
		c.mu.Lock()
		var next *behaviorTimer
		for _, t := range c.timers {
			if !t.stopped && t.at <= target && (next == nil || t.at < next.at || t.at == next.at && t.id < next.id) {
				next = t
			}
		}
		at := target
		if next != nil {
			at = next.at
			next.stopped = true
		}
		delta := at - c.scheduler
		c.wall += delta
		c.elapsed += delta
		c.scheduler = at
		c.mu.Unlock()
		if next == nil {
			break
		}
		go next.fn()
	}
	c.drain()
}

type behaviorGate struct {
	done    chan struct{}
	value   any
	err     error
	settled bool
}
type behaviorScope struct {
	instance string
	ctx      context.Context
	gate     *behaviorGate
	done     chan struct{}
}
type behaviorStored struct {
	raw     []byte
	expires int64
}
type behaviorHistory struct {
	event    string
	id       int
	at       int64
	outcome  string
	duration float64
	failed   bool
}
type behaviorDriver struct {
	t                                   *testing.T
	mu                                  sync.Mutex
	fixture                             obj
	observed                            obj
	clock                               *behaviorClock
	instances                           map[string]*Cache[any]
	scopes                              map[string]*behaviorScope
	effects                             map[string]map[int]*behaviorGate
	loaders                             []*behaviorGate
	sourceErrors                        []error
	timeoutErrors                       []error
	faults                              map[string]bool
	runtimePolicy                       any
	values                              map[string]behaviorStored
	reply                               any
	replySet                            bool
	maintenanceError                    error
	history                             []behaviorHistory
	causal                              []behaviorCausalEvent
	sourceByInvocation                  map[int]int
	fallbackFailed                      bool
	discardWrites, discardInvalidations bool
	skipSettle                          bool
	unsettled                           obj
}

func emptyBehaviorObservation(fixture obj) obj {
	o := obj{}
	for _, key := range []string{"loaders", "reads", "writes", "invalidations", "loads", "dumps", "policyCalls", "classifications", "comparisons"} {
		o[key] = int64(0)
	}
	for _, key := range []string{"calls", "maintenance", "sourceScopes", "writeTtls", "shadow", "recovery"} {
		o[key] = []any{}
	}
	if _, ok := fixture["observe"]; ok {
		o["events"] = []any{}
	}
	return o
}
func newBehaviorDriver(t *testing.T, fixture obj) *behaviorDriver {
	d := &behaviorDriver{t: t, fixture: bm(bclone(fixture)), observed: emptyBehaviorObservation(fixture), clock: &behaviorClock{wall: time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC).UnixMilli()}, instances: map[string]*Cache[any]{}, scopes: map[string]*behaviorScope{}, effects: map[string]map[int]*behaviorGate{}, faults: map[string]bool{}, runtimePolicy: obj{}, values: map[string]behaviorStored{}, maintenanceError: errors.New("controlled mutation failure")}
	d.sourceByInvocation = map[int]int{}
	for _, key := range []string{"read", "write", "dump", "load", "policy"} {
		d.effects[key] = map[int]*behaviorGate{}
	}
	d.instance("default")
	return d
}

// newUnsettledBehaviorDriver is a harness control only: the returned driver
// reports the observation it held before the end-of-apply drain that
// implements the causally-ready-v1 settlement contract, so a control test can
// prove the replays depend on it. It still drains after that snapshot, so
// every command starts from a settled driver and the control measures early
// observation alone. Conformance replays must never use it.
func newUnsettledBehaviorDriver(t *testing.T, fixture obj) *behaviorDriver {
	d := newBehaviorDriver(t, fixture)
	d.skipSettle = true
	return d
}
func (d *behaviorDriver) increment(field string) int {
	d.mu.Lock()
	defer d.mu.Unlock()
	n := bn(d.observed[field])
	d.observed[field] = n + 1
	return int(n)
}
func (d *behaviorDriver) append(field string, value any) {
	d.mu.Lock()
	d.observed[field] = append(ba(d.observed[field]), value)
	d.mu.Unlock()
}
func (d *behaviorDriver) fault(field string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.faults[field]
}
func (d *behaviorDriver) record(kind string, fields obj) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, selected := range ba(d.fixture["observe"]) {
		if selected == kind {
			event := obj{"event": kind}
			for k, v := range fields {
				event[k] = v
			}
			d.observed["events"] = append(ba(d.observed["events"]), event)
			break
		}
	}
}
func (d *behaviorDriver) observe(e Event) {
	fields := obj{}
	for k, v := range e.Data {
		if k != "value" {
			fields[k] = v
		}
	}
	switch e.Kind {
	case "get", "fallback", "serialization", "futureOffset", "shadowAge", "recoveryAge":
		fields["seconds"] = e.Seconds
	case "size", "storedSize":
		fields["bytes"] = e.Bytes
	}
	if e.Kind == "error" && bb(fields["inFallback"]) && fields["error"] == "fallback" {
		d.mu.Lock()
		d.fallbackFailed = true
		d.mu.Unlock()
	}
	if e.Kind == "fallback" {
		d.mu.Lock()
		d.history = append(d.history, behaviorHistory{event: "fallbackCompletion", at: d.clock.ElapsedMS(), duration: e.Seconds * 1000, failed: d.fallbackFailed})
		d.fallbackFailed = false
		d.mu.Unlock()
	}
	d.record(e.Kind, fields)
	if bb(d.fixture["observerFailure"]) || d.fault("observer") {
		panic("controlled observer failure")
	}
}
func (d *behaviorDriver) classifier(mode string) RecoveryPredicate {
	return func(error) (bool, error) {
		d.increment("classifications")
		if mode == "error" {
			return false, errors.New("controlled classifier failure")
		}
		return mode == "allow", nil
	}
}
func (d *behaviorDriver) instance(id string) *Cache[any] {
	if c := d.instances[id]; c != nil {
		return c
	}
	options := Options[any]{Clock: d.clock, Codec: behaviorCodec{d: d}, Logger: behaviorLogger{d: d}, DisableCompression: true, LocalCapacity: int(bn(bdefault(d.fixture, "localMaxSize", 10000))), LocalCapacitySet: true, ShadowMaxInFlight: int(bn(bdefault(d.fixture, "shadowMaxInFlight", 1))), Observe: d.observe, RecoveryOutcome: func(e Event) {
		d.append("recovery", e.Outcome)
		if bb(d.fixture["observerFailure"]) || d.fault("observer") {
			panic("controlled observer failure")
		}
	}, PolicyProvider: func(ctx context.Context, id Identity) (any, error) {
		index := d.increment("policyCalls")
		if d.fault("holdPolicies") {
			if err := d.hold("policy", index); err != nil {
				return nil, err
			}
		}
		if d.fault("policy") {
			return nil, errors.New("controlled policy failure")
		}
		d.mu.Lock()
		defer d.mu.Unlock()
		return bclone(d.runtimePolicy), nil
	}}
	if d.fixture["remote"] != false {
		options.Remote = behaviorRemote{d: d}
	}
	if bb(d.fixture["localFaultInjection"]) {
		options.Clock = behaviorLocalFaultClock{behaviorClock: d.clock, driver: d}
	}
	if d.fixture["readTimeoutMs"] != "default" {
		options.RemoteReadTimeoutMS = bn(bdefault(d.fixture, "readTimeoutMs", 50))
	}
	if mode := bs(d.fixture["recovery"]); mode != "" && mode != "default" {
		options.ShouldRecover = d.classifier(mode)
	}
	if d.fixture["shadowHook"] != false {
		options.ShadowOutcome = func(e Event) {
			d.append("shadow", e.Outcome)
			if bb(d.fixture["observerFailure"]) || d.fault("observer") {
				panic("controlled observer failure")
			}
		}
	}
	c := New[any](options)
	d.instances[id] = c
	return c
}
func (d *behaviorDriver) hold(effect string, index int) error {
	gate := &behaviorGate{done: make(chan struct{})}
	d.mu.Lock()
	d.effects[effect][index] = gate
	d.mu.Unlock()
	<-gate.done
	return gate.err
}
func (d *behaviorDriver) observation() obj {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.skipSettle && d.unsettled != nil {
		return bm(bclone(d.unsettled))
	}
	return bm(bclone(d.observed))
}
func (d *behaviorDriver) observedEffectCount(effect string) int {
	keys := map[string]string{"read": "reads", "write": "writes", "dump": "dumps", "load": "loads", "policy": "policyCalls", "loader": "loaders"}
	d.mu.Lock()
	defer d.mu.Unlock()
	return int(bn(d.observed[keys[effect]]))
}
func (d *behaviorDriver) classifyError(err error) string {
	d.mu.Lock()
	defer d.mu.Unlock()
	for i, e := range d.sourceErrors {
		if err == e {
			return fmt.Sprintf("source:%d", i)
		}
	}
	var timeout *FallbackTimeoutError
	if errors.As(err, &timeout) {
		for i, e := range d.timeoutErrors {
			if err == e {
				return fmt.Sprintf("timeout:%d", i)
			}
		}
		d.timeoutErrors = append(d.timeoutErrors, err)
		return fmt.Sprintf("timeout:%d", len(d.timeoutErrors)-1)
	}
	return "unexpected:" + err.Error()
}
func (d *behaviorDriver) identity(key, useCase string) Identity {
	if key == "" {
		key = "1"
	}
	if useCase == "" {
		useCase = "Behavior"
	}
	return Identity{Namespace: "urn", KeyType: "id", ID: key, UseCase: useCase, Tracked: bb(d.fixture["tracked"])}
}
func (d *behaviorDriver) apply(input obj) error {
	switch bs(input["op"]) {
	case "begin":
		d.mu.Lock()
		index := len(ba(d.observed["calls"]))
		d.observed["calls"] = append(ba(d.observed["calls"]), obj{"status": "pending"})
		d.mu.Unlock()
		ctx := context.Background()
		instance := bs(input["instance"])
		if id, ok := input["scope"]; ok {
			s := d.scopes[bs(id)]
			if s == nil {
				return fmt.Errorf("unknown scope %s", id)
			}
			ctx = s.ctx
			if instance == "" {
				instance = s.instance
			}
		}
		if instance == "" {
			instance = "default"
		}
		cache := d.instance(instance)
		policy, err := ParsePolicy(d.fixture["policy"])
		if err != nil {
			return fmt.Errorf("invalid fixture policy: %w", err)
		}
		operation := Operation{Identity: d.identity(bs(input["key"]), bs(input["useCase"])), Policy: policy}
		if d.fixture["fallbackTimeoutMs"] != "default" {
			budget := bdefault(d.fixture, "fallbackTimeoutMs", 10)
			if budget == nil {
				operation.UnboundedFallback = true
			} else {
				n := bn(budget)
				operation.FallbackTimeoutMS = &n
			}
		}
		if mode := bs(input["recovery"]); mode != "" {
			operation.ShouldRecover = d.classifier(mode)
		}
		if comparator := bs(d.fixture["comparator"]); comparator != "" {
			operation.Comparator = func(a, b any) (bool, error) {
				d.increment("comparisons")
				d.clock.shift(bn(d.fixture["comparisonMs"]), false)
				if comparator == "error" {
					return false, errors.New("controlled comparator failure")
				}
				return comparator == "equal", nil
			}
		}
		call := func(callctx context.Context) error {
			budget := int64(60000)
			if operation.FallbackTimeoutMS != nil {
				budget = *operation.FallbackTimeoutMS
			}
			if operation.UnboundedFallback || !cache.IsEnabled(callctx) {
				budget = -1
			}
			callctx = context.WithValue(callctx, behaviorInvocationKey{}, behaviorInvocation{owner: index})
			value, err := cache.GetOrLoad(callctx, operation, func(sourcectx context.Context) (any, error) {
				gate := &behaviorGate{done: make(chan struct{})}
				d.mu.Lock()
				id := len(d.loaders)
				d.loaders = append(d.loaders, gate)
				d.sourceErrors = append(d.sourceErrors, fmt.Errorf("source failure %d", id))
				d.observed["loaders"] = bn(d.observed["loaders"]) + 1
				d.history = append(d.history, behaviorHistory{event: "sourceStart", id: id, at: d.clock.ElapsedMS()})
				d.sourceByInvocation[index] = id
				d.causal = append(d.causal, behaviorCausalEvent{kind: "sourceStart", id: id, owner: index, at: d.clock.ElapsedMS(), budget: budget})
				d.mu.Unlock()
				if bb(d.fixture["probeSourceScope"]) {
					d.append("sourceScopes", cache.IsEnabled(sourcectx))
				}
				d.clock.shift(bn(d.fixture["sourceWorkMs"]), false)
				<-gate.done
				return gate.value, gate.err
			})
			result := obj{"status": "value", "value": value}
			if err != nil {
				result = obj{"status": "error", "error": d.classifyError(err)}
			} else if IsAbsent(value) {
				result["value"] = obj{"absent": true}
			}
			d.mu.Lock()
			ba(d.observed["calls"])[index] = result
			d.mu.Unlock()
			return nil
		}
		execute := func(ec context.Context) error {
			if bb(input["disabled"]) {
				return cache.Disable(ec, call)
			}
			return call(ec)
		}
		go func() {
			if _, saved := input["scope"]; saved || bb(input["outside"]) {
				_ = execute(ctx)
			} else {
				_ = cache.Enable(ctx, execute)
			}
		}()
	case "resolve", "reject":
		index := int(bn(input["loader"]))
		d.mu.Lock()
		if index < 0 || index >= len(d.loaders) || d.loaders[index].settled {
			d.mu.Unlock()
			return fmt.Errorf("no unsettled source %d", index)
		}
		gate := d.loaders[index]
		gate.settled = true
		outcome := "resolve"
		if input["op"] == "reject" {
			outcome = "reject"
			if input["error"] == "timeout" {
				d.sourceErrors[index] = &FallbackTimeoutError{}
			}
			gate.err = d.sourceErrors[index]
		} else {
			gate.value = bdefault(input, "value", Absent)
		}
		d.history = append(d.history, behaviorHistory{event: "sourceSettlement", id: index, at: d.clock.ElapsedMS(), outcome: outcome})
		d.causal = append(d.causal, behaviorCausalEvent{kind: "sourceSettlement", id: index, at: d.clock.ElapsedMS(), outcome: outcome})
		close(gate.done)
		d.mu.Unlock()
	case "advance":
		if bf(input["ms"]) < 0 {
			return errors.New("negative elapsed advance")
		}
		d.clock.advance(bn(input["ms"]), input["deliverTimers"] != false)
	case "shiftWall":
		d.clock.shift(bn(input["ms"]), true)
	case "seed":
		_, key, _, err := d.identity(bs(input["key"]), bs(input["useCase"])).Keys()
		if err != nil {
			return err
		}
		var raw []byte
		if frame, ok := input["frameHex"]; ok {
			raw, err = hex.DecodeString(bs(frame))
		} else {
			payload := []byte("undefined")
			encoding := byte(0)
			if h, ok := input["payloadHex"]; ok {
				payload, err = hex.DecodeString(bs(h))
				encoding = 1
			} else if text, ok := input["payloadText"]; ok {
				payload = []byte(bs(text))
			} else if value, ok := input["value"]; ok {
				payload, err = json.Marshal(value)
			}
			raw = make([]byte, 10+len(payload))
			raw[0] = 1
			binary.BigEndian.PutUint64(raw[1:9], uint64(d.clock.WallMS()-bn(input["ageMs"])))
			raw[9] = encoding
			copy(raw[10:], payload)
		}
		if err != nil {
			return err
		}
		d.mu.Lock()
		d.values[key] = behaviorStored{raw: raw, expires: d.clock.ElapsedMS() + bn(bdefault(input, "ttlMs", 60000))}
		d.mu.Unlock()
	case "invalidate":
		err := d.instance("default").Invalidate(context.Background(), d.identity(bs(input["key"]), ""), bn(input["futureBufferMs"]))
		status := "ok"
		if err != nil {
			if err == d.maintenanceError {
				status = "mutation_error"
			} else if errors.Is(err, MissingRemoteError) {
				status = "missing_remote"
			} else {
				return err
			}
		}
		d.append("maintenance", status)
	case "observeMarker":
		identity := d.identity(bs(input["key"]), "")
		identity.Tracked = true
		_, _, key, err := identity.Keys()
		if err != nil {
			return err
		}
		cutoff, ttl := int64(-1), int64(-2)
		d.mu.Lock()
		if raw := d.rawLocked(key); raw != nil {
			stamp, parseErr := strconv.ParseInt(string(raw), 10, 64)
			if parseErr != nil {
				d.mu.Unlock()
				return parseErr
			}
			cutoff = stamp - time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC).UnixMilli()
			ttl = d.values[key].expires - d.clock.ElapsedMS()
		}
		d.mu.Unlock()
		d.record("marker", obj{"cutoffMs": cutoff, "ttlMs": ttl})
	case "adapterReply":
		d.mu.Lock()
		if d.replySet {
			d.mu.Unlock()
			return errors.New("unconsumed adapter reply")
		}
		d.replySet = true
		d.reply = bclone(input["value"])
		d.mu.Unlock()
	case "policy":
		d.mu.Lock()
		d.runtimePolicy = bclone(input["value"])
		d.mu.Unlock()
	case "faults":
		d.mu.Lock()
		for k, v := range bm(input["value"]) {
			d.faults[k] = bb(v)
		}
		d.mu.Unlock()
	case "release":
		effect := bs(input["effect"])
		index := int(bn(input["index"]))
		d.mu.Lock()
		gate := d.effects[effect][index]
		if gate == nil || gate.settled {
			d.mu.Unlock()
			return fmt.Errorf("no pending %s %d", effect, index)
		}
		gate.settled = true
		if bb(input["fail"]) {
			gate.err = fmt.Errorf("controlled %s failure", effect)
		}
		delete(d.effects[effect], index)
		close(gate.done)
		d.mu.Unlock()
	case "openScope":
		id := bs(input["id"])
		if d.scopes[id] != nil {
			return fmt.Errorf("duplicate scope %s", id)
		}
		ctx := context.Background()
		instance := bs(input["instance"])
		if parent, ok := input["parent"]; ok {
			scope := d.scopes[bs(parent)]
			if scope == nil {
				return fmt.Errorf("unknown parent scope %s", parent)
			}
			ctx = scope.ctx
			if instance == "" {
				instance = scope.instance
			}
		}
		if instance == "" {
			instance = "default"
		}
		scope := &behaviorScope{instance: instance, gate: &behaviorGate{done: make(chan struct{})}, done: make(chan struct{})}
		d.scopes[id] = scope
		cache := d.instance(instance)
		ready := make(chan struct{})
		body := func(sc context.Context) error { scope.ctx = sc; close(ready); <-scope.gate.done; return nil }
		go func() {
			defer close(scope.done)
			if bb(input["disabled"]) {
				_ = cache.Disable(ctx, body)
			} else {
				_ = cache.Enable(ctx, body)
			}
		}()
		<-ready
	case "closeScope":
		scope := d.scopes[bs(input["id"])]
		if scope == nil || scope.gate.settled {
			return errors.New("unknown/already closed scope")
		}
		scope.gate.settled = true
		close(scope.gate.done)
		<-scope.done
	default:
		return fmt.Errorf("unknown behavior input %s", bjson(input))
	}
	// The no-settle harness control records what an unsettled port would
	// report: the observation before the drain. It drains afterwards so the
	// next command finds its gates registered and no failure is a harness error.
	if d.skipSettle {
		d.mu.Lock()
		d.unsettled = bm(bclone(d.observed))
		d.mu.Unlock()
	}
	// Drain ready executor work while unresolved external gates remain held:
	// the causally-ready-v1 settlement step.
	d.clock.drain()
	return d.assertPublicationCausality()
}
func (d *behaviorDriver) close() {
	d.mu.Lock()
	for _, k := range []string{"holdReads", "holdWrites", "holdDumps", "holdLoads", "holdPolicies"} {
		d.faults[k] = false
	}
	d.mu.Unlock()
	for _, scope := range d.scopes {
		if !scope.gate.settled {
			scope.gate.settled = true
			close(scope.gate.done)
		}
	}
	for {
		d.mu.Lock()
		pending := false
		for _, gates := range d.effects {
			for _, g := range gates {
				if !g.settled {
					g.settled = true
					close(g.done)
					pending = true
				}
			}
		}
		for _, g := range d.loaders {
			if !g.settled {
				g.settled = true
				g.value = float64(0)
				close(g.done)
				pending = true
			}
		}
		d.mu.Unlock()
		d.clock.drain()
		if !pending {
			break
		}
	}
}

type behaviorCodec struct{ d *behaviorDriver }

func (c behaviorCodec) Encode(value any) (Payload, error) {
	index := c.d.increment("dumps")
	if c.d.fault("holdDumps") {
		if err := c.d.hold("dump", index); err != nil {
			return Payload{}, err
		}
	}
	if c.d.fault("dump") {
		return Payload{}, errors.New("controlled serialization failure")
	}
	if IsAbsent(value) {
		return Payload{Bytes: []byte("undefined")}, nil
	}
	raw, err := json.Marshal(value)
	return Payload{Bytes: raw}, err
}
func (c behaviorCodec) Decode(payload Payload) (any, error) {
	index := c.d.increment("loads")
	if c.d.fault("holdLoads") {
		if err := c.d.hold("load", index); err != nil {
			return nil, err
		}
	}
	if c.d.fault("load") {
		return nil, errors.New("controlled deserialization failure")
	}
	if string(payload.Bytes) == "undefined" {
		return Absent, nil
	}
	var value any
	err := json.Unmarshal(payload.Bytes, &value)
	return value, err
}

type behaviorRemote struct{ d *behaviorDriver }

type behaviorLogger struct{ d *behaviorDriver }

func (l behaviorLogger) fail() {
	if bb(l.d.fixture["observerFailure"]) || l.d.fault("observer") {
		panic("controlled observer failure")
	}
}
func (l behaviorLogger) Debug(string, any) { l.fail() }
func (l behaviorLogger) Error(string, any) { l.fail() }
func (l behaviorLogger) Warn(message string, details any) {
	if message == "DialCache shadow validation mismatch" {
		l.d.record("mismatchWarning", bm(details))
	}
	l.fail()
}

func (r behaviorRemote) Read(ctx context.Context, key, watermark string) (ReadResult, error) {
	d := r.d
	index := d.increment("reads")
	if budget, ok := ReadBudget(ctx); ok {
		d.record("readContext", obj{"index": index, "timeoutMs": budget, "aborted": ctx.Err() != nil})
		context.AfterFunc(ctx, func() { d.record("readAbort", obj{"index": index}) })
	}
	if d.fault("holdReads") {
		if err := d.hold("read", index); err != nil {
			return ReadResult{}, err
		}
	}
	if d.fault("read") {
		return ReadResult{}, errors.New("controlled read failure")
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.replySet {
		d.replySet = false
		return ReadResult{Raw: d.reply, RawSet: true}, nil
	}
	raw := d.rawLocked(key)
	var marker *string
	if watermark != "" {
		if bytes := d.rawLocked(watermark); bytes != nil {
			s := string(bytes)
			marker = &s
		}
	}
	return DecodeFrame(raw, watermark != "", marker), nil
}
func (r behaviorRemote) Write(ctx context.Context, key string, frame Frame, ttl int64) error {
	d := r.d
	index := d.increment("writes")
	d.mu.Lock()
	d.history = append(d.history, behaviorHistory{event: "writeDispatch", at: d.clock.ElapsedMS()})
	owner, source := -1, -1
	if invocation, ok := ctx.Value(behaviorInvocationKey{}).(behaviorInvocation); ok {
		owner = invocation.owner
		if id, found := d.sourceByInvocation[owner]; found {
			source = id
		}
	}
	d.causal = append(d.causal, behaviorCausalEvent{kind: "writeDispatch", id: source, owner: owner, at: d.clock.ElapsedMS()})
	d.mu.Unlock()
	d.record("writeDispatch", obj{"index": index})
	d.append("writeTtls", ttl)
	if d.fault("holdWrites") {
		if err := d.hold("write", index); err != nil {
			return err
		}
	}
	if d.fault("write") {
		return d.maintenanceError
	}
	raw, err := EncodeFrame(frame)
	if err != nil {
		return err
	}
	d.mu.Lock()
	if !d.discardWrites {
		d.values[key] = behaviorStored{raw: raw, expires: d.clock.ElapsedMS() + ttl}
	}
	d.mu.Unlock()
	return nil
}
func (r behaviorRemote) Invalidate(ctx context.Context, key string, now, buffer int64) error {
	d := r.d
	d.increment("invalidations")
	if d.fault("write") {
		return d.maintenanceError
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.discardInvalidations {
		return nil
	}
	cutoff := now + buffer
	prior := d.rawLocked(key)
	old, _ := strconv.ParseInt(string(prior), 10, 64)
	if old > cutoff {
		cutoff = old
	}
	ttl := int64(7200000)
	if cutoff-now+3660000 > ttl {
		ttl = cutoff - now + 3660000
	}
	if item, ok := d.values[key]; ok && item.expires-d.clock.ElapsedMS() > ttl {
		ttl = item.expires - d.clock.ElapsedMS()
	}
	d.values[key] = behaviorStored{raw: []byte(strconv.FormatInt(cutoff, 10)), expires: d.clock.ElapsedMS() + ttl}
	return nil
}
func (d *behaviorDriver) rawLocked(key string) []byte {
	item, ok := d.values[key]
	if !ok {
		return nil
	}
	if item.expires <= d.clock.ElapsedMS() {
		delete(d.values, key)
		return nil
	}
	return append([]byte{}, item.raw...)
}

// Strict ITF decoding is separate from action execution. The ordinary JSON
// decoder never gets a chance to round an unsafe encoded integer silently.
func behaviorJSON(raw []byte) (any, error) {
	if err := validateBehaviorJSON(raw); err != nil {
		return nil, err
	}
	var value any
	err := json.Unmarshal(raw, &value)
	return value, err
}

// The shared JSON grammar check rejects malformed syntax; this second walk
// checks duplicate object names without allocating every private scalar in a
// generated history. Escaped names are decoded before comparing them.
func validateBehaviorJSON(raw []byte) error {
	if !json.Valid(raw) {
		return errors.New("invalid JSON")
	}
	i := 0
	space := func() {
		for i < len(raw) && (raw[i] == ' ' || raw[i] == '\n' || raw[i] == '\r' || raw[i] == '\t') {
			i++
		}
	}
	quoted := func() (string, error) {
		start := i
		i++
		escaped := false
		for raw[i] != '"' {
			if raw[i] == '\\' {
				escaped = true
				i++
			}
			i++
		}
		i++
		if !escaped {
			return string(raw[start+1 : i-1]), nil
		}
		var value string
		if err := json.Unmarshal(raw[start:i], &value); err != nil {
			return "", err
		}
		return value, nil
	}
	var walk func() error
	walk = func() error {
		space()
		switch raw[i] {
		case '{':
			i++
			space()
			if raw[i] == '}' {
				i++
				return nil
			}
			first := ""
			members := 0
			var seen map[string]bool
			for {
				space()
				key, err := quoted()
				if err != nil {
					return err
				}
				if members == 0 {
					first = key
				} else if members == 1 {
					if key == first {
						return fmt.Errorf("duplicate JSON key %q", key)
					}
					seen = map[string]bool{first: true, key: true}
				} else {
					if seen[key] {
						return fmt.Errorf("duplicate JSON key %q", key)
					}
					seen[key] = true
				}
				members++
				space()
				i++
				if err := walk(); err != nil {
					return err
				}
				space()
				if raw[i] == '}' {
					i++
					return nil
				}
				i++
			}
		case '[':
			i++
			space()
			if raw[i] == ']' {
				i++
				return nil
			}
			for {
				if err := walk(); err != nil {
					return err
				}
				space()
				if raw[i] == ']' {
					i++
					return nil
				}
				i++
			}
		case '"':
			_, err := quoted()
			return err
		default:
			for i < len(raw) && raw[i] != ',' && raw[i] != '}' && raw[i] != ']' && raw[i] != ' ' && raw[i] != '\n' && raw[i] != '\r' && raw[i] != '\t' {
				i++
			}
			return nil
		}
	}
	return walk()
}
func behaviorITF(v any) (any, error) {
	switch x := v.(type) {
	case map[string]any:
		if raw, ok := x["#bigint"]; ok {
			if len(x) != 1 {
				return nil, errors.New("malformed ITF integer")
			}
			n, err := strconv.ParseInt(bs(raw), 10, 64)
			if err != nil || n < -int64(MaxSafeInteger) || n > int64(MaxSafeInteger) {
				return nil, errors.New("unsafe ITF integer")
			}
			return float64(n), nil
		}
		out := obj{}
		for k, item := range x {
			v, err := behaviorITF(item)
			if err != nil {
				return nil, err
			}
			out[k] = v
		}
		return out, nil
	case []any:
		out := make([]any, len(x))
		for i, item := range x {
			v, err := behaviorITF(item)
			if err != nil {
				return nil, err
			}
			out[i] = v
		}
		return out, nil
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) || math.Abs(x) > float64(MaxSafeInteger) {
			return nil, errors.New("unsafe JSON number")
		}
	}
	return v, nil
}
func behaviorKeys(m obj) string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return strings.Join(keys, ",")
}
