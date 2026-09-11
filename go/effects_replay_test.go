package dialcache

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/synctest"
)

var effectsActions = []string{"init", "beginCall", "resolveLoader", "rejectLoader", "releaseRead", "failRead", "releaseLoad", "failLoad", "releaseDump", "failDump", "releaseWrite", "failWrite", "seedRemote", "tick", "jumpClock", "rollbackWall", "observerFault", "readBudgetPolicy", "adapterReply", "invalidate", "futureFence"}
var effectsFields = strings.Fields("now wall readStarted decodeStarted tracked reply replyAt readBudget baseReadBudget phase activeLoader activeRead deadline refill acceptedAt acceptedWall observerFailed readAborts observedFence writeTimestamp storedTimestamp watermark loaders reads writes invalidations loads dumps policyCalls")
var effectsObservedFields = strings.Fields("loaders reads writes invalidations loads dumps policyCalls")
var effectsEventNames = strings.Fields("request disabled miss error coalesced invalidation get fallback serialization futureOffset size storedSize writeDispatch")

func bhas(values []string, name string) bool {
	for _, v := range values {
		if v == name {
			return true
		}
	}
	return false
}
func parseEffectsTrace(raw []byte, path string) (behaviorTrace, error) {
	decoded, err := behaviorJSON(raw)
	if err != nil {
		return behaviorTrace{}, err
	}
	decoded, err = behaviorITF(decoded)
	if err != nil {
		return behaviorTrace{}, err
	}
	states := ba(bm(decoded)["states"])
	trace := behaviorTrace{path: path}
	if len(states) < 2 {
		return trace, fmt.Errorf("effects trace requires a transition")
	}
	for i, rawState := range states {
		step := bm(rawState)
		input := bm(step["input"])
		if behaviorKeys(input) != "choice,name" {
			return trace, fmt.Errorf("invalid explicit effect input")
		}
		action := bs(input["name"])
		if !bhas(effectsActions, action) || (i == 0) != (action == "init") {
			return trace, fmt.Errorf("unknown/misplaced effects action %s", action)
		}
		chosen := bhas([]string{"init", "adapterReply", "readBudgetPolicy", "observerFault", "resolveLoader", "rejectLoader", "releaseRead", "failRead"}, action)
		n, ok := input["choice"].(float64)
		if !ok || n != math.Trunc(n) || n < -1 || n > 9007199254740991 {
			return trace, fmt.Errorf("invalid effect choice")
		}
		choice := int64(n)
		if chosen {
			if choice < 0 {
				return trace, fmt.Errorf("missing effect choice")
			}
			if action == "init" && choice > 5 || action == "readBudgetPolicy" && choice > 4 || action == "observerFault" && choice > 1 || action == "adapterReply" && (choice < 1 || choice > 16) {
				return trace, fmt.Errorf("unsupported effect choice")
			}
		} else if choice != -1 {
			return trace, fmt.Errorf("unexpected effect choice")
		}
		state := bm(step["s"])
		if len(state) != len(effectsFields)+5 {
			return trace, fmt.Errorf("missing/unexpected effect state fields")
		}
		for _, field := range effectsFields {
			n, ok := state[field].(float64)
			if !ok || n < 0 || n != math.Trunc(n) {
				return trace, fmt.Errorf("invalid effect state %s", field)
			}
		}
		for _, field := range []string{"calls", "sources", "readStates", "readBudgets"} {
			list, ok := state[field].([]any)
			if !ok {
				return trace, fmt.Errorf("missing effect list %s", field)
			}
			for _, raw := range list {
				n, ok := raw.(float64)
				if !ok || n < 0 || n != math.Trunc(n) {
					return trace, fmt.Errorf("invalid effect list %s", field)
				}
				if field == "readBudgets" {
					if !bcontains([]int64{10, 20, 30, 50}, int64(n)) {
						return trace, fmt.Errorf("unsupported read budget")
					}
				} else if field == "calls" && n > 3 || field != "calls" && n > 2 {
					return trace, fmt.Errorf("unsupported effect outcome")
				}
			}
		}
		events, ok := state["events"].([]any)
		if !ok {
			return trace, fmt.Errorf("missing effect diagnostics")
		}
		for _, raw := range events {
			event := bm(raw)
			if behaviorKeys(event) != "amount,detail,event,location" || !bhas(effectsEventNames, bs(event["event"])) {
				return trace, fmt.Errorf("invalid effect diagnostic")
			}
			for _, field := range []string{"location", "detail"} {
				if _, ok := event[field].(string); !ok {
					return trace, fmt.Errorf("invalid effect label")
				}
			}
			n, ok := event["amount"].(float64)
			if !ok || n < 0 || n != math.Trunc(n) {
				return trace, fmt.Errorf("invalid diagnostic amount")
			}
		}
		trace.steps = append(trace.steps, behaviorStep{action: action, choice: choice, state: state})
	}
	return trace, nil
}
func effectsFixture(mode int64) obj {
	policy := obj{"ttlSec": obj{"remote": 60}}
	if mode >= 2 {
		policy["remoteReadTimeoutMs"] = 10
	}
	var read any = 20
	if mode == 0 {
		read = "default"
	}
	events := []any{"readContext", "readAbort"}
	for _, name := range effectsEventNames {
		events = append(events, name)
	}
	return obj{"policy": policy, "tracked": mode != 5, "readTimeoutMs": read, "observe": events}
}
func effectsAdapterReply(choice int64, now int64) any {
	replies := []any{nil, 42, obj{"kind": "watermark_miss", "observedWatermarkMs": now + 20}, obj{"reason": "value_absent"}, obj{"kind": "miss"}, obj{"kind": "miss", "reason": "invented"}, obj{"kind": "miss", "reason": "invented", "observedWatermarkMs": now + 20}, obj{"kind": "miss", "reason": "watermark_fenced"}, obj{"kind": "miss", "reason": "watermark_fenced", "observedWatermarkMs": -1}, obj{"kind": "miss", "reason": "value_absent", "observedWatermarkMs": 1.5}, obj{"kind": "miss", "reason": "value_absent", "observedWatermarkMs": float64(9007199254740992)}, obj{"kind": "miss", "reason": "value_absent", "observedWatermarkMs": now + 20}, obj{"kind": "miss", "reason": "expired", "observedWatermarkMs": 0}, obj{"kind": "miss", "reason": "value_absent", "payload": "1", "createdAtMs": now}, obj{"reason": "watermark_fenced", "observedWatermarkMs": now + 20, "payload": "1", "createdAtMs": now}, obj{"kind": "miss", "reason": "watermark_fenced", "observedWatermarkMs": now + 20}}
	return replies[choice-1]
}
func effectsInputs(step behaviorStep, d *behaviorDriver) []obj {
	choice := step.choice
	switch step.action {
	case "init":
		var policy any = obj{}
		if choice == 3 {
			policy = obj{"remoteReadTimeoutMs": 30}
		} else if choice == 4 {
			policy = nil
		}
		return []obj{{"op": "policy", "value": policy}}
	case "beginCall":
		return []obj{{"op": "begin"}}
	case "resolveLoader":
		return []obj{{"op": "resolve", "loader": choice, "value": 1}}
	case "rejectLoader":
		return []obj{{"op": "reject", "loader": choice}}
	case "seedRemote":
		return []obj{{"op": "seed", "value": 1}}
	case "tick":
		return []obj{{"op": "advance", "ms": 10}}
	case "jumpClock":
		return []obj{{"op": "advance", "ms": 10, "deliverTimers": false}}
	case "rollbackWall":
		return []obj{{"op": "shiftWall", "ms": -1000}}
	case "observerFault":
		return []obj{{"op": "faults", "value": obj{"observer": choice == 1}}}
	case "readBudgetPolicy":
		policy := obj{}
		if choice > 0 {
			policy["remoteReadTimeoutMs"] = []int{0, 10, 20, 30, 50}[choice]
		}
		return []obj{{"op": "policy", "value": policy}}
	case "adapterReply":
		return []obj{{"op": "adapterReply", "value": effectsAdapterReply(choice, d.clock.WallMS())}}
	case "invalidate":
		return []obj{{"op": "invalidate"}}
	case "futureFence":
		return []obj{{"op": "invalidate", "futureBufferMs": 20}}
	default:
		failed := strings.HasPrefix(step.action, "fail")
		effect := strings.TrimPrefix(strings.TrimPrefix(step.action, "release"), "fail")
		effect = strings.ToLower(effect)
		index := int(choice)
		if effect != "read" {
			index = d.observedEffectCount(effect) - 1
		}
		return []obj{{"op": "faults", "value": obj{effect: failed}}, {"op": "release", "effect": effect, "index": index}, {"op": "faults", "value": obj{effect: false}}}
	}
}
func effectsProjection(actual obj) (obj, error) {
	out := obj{}
	for _, field := range effectsObservedFields {
		out[field] = actual[field]
	}
	calls := []any{}
	for _, raw := range ba(actual["calls"]) {
		call := bm(raw)
		code := 0
		switch call["status"] {
		case "value":
			code = 4
			if bf(call["value"]) == 1 {
				code = 1
			}
		case "error":
			code = 4
			if strings.HasPrefix(bs(call["error"]), "source:") {
				code = 2
			} else if strings.HasPrefix(bs(call["error"]), "timeout:") {
				code = 3
			}
		}
		calls = append(calls, code)
	}
	out["calls"] = calls
	out["writeTtls"] = actual["writeTtls"]
	out["events"] = []any{}
	out["readContexts"] = []any{}
	out["readAborts"] = []any{}
	for _, raw := range ba(actual["events"]) {
		e := bm(raw)
		name := bs(e["event"])
		if name == "readContext" {
			out["readContexts"] = append(ba(out["readContexts"]), obj{"index": e["index"], "timeoutMs": e["timeoutMs"], "aborted": e["aborted"]})
			continue
		}
		if name == "readAbort" {
			out["readAborts"] = append(ba(out["readAborts"]), e["index"])
			continue
		}
		event := obj{"event": name, "location": "remote", "detail": "", "amount": e["index"]}
		if name != "writeDispatch" {
			if e["cacheNamespace"] != "urn" || e["keyType"] != "id" || name != "invalidation" && e["useCase"] != "Behavior" {
				return nil, fmt.Errorf("invalid observed diagnostic labels %s", bjson(e))
			}
			if name == "error" && bb(e["inFallback"]) != (e["error"] == "fallback") {
				return nil, fmt.Errorf("invalid fallback attribution")
			}
			event["location"] = bdefault(e, "layer", e["scope"])
			event["detail"] = bdefault(e, "reason", bdefault(e, "error", bdefault(e, "operation", "")))
			event["amount"] = bdefault(e, "seconds", bdefault(e, "bytes", 0))
		}
		out["events"] = append(ba(out["events"]), event)
	}
	return out, nil
}
func effectsExpected(step behaviorStep, aborted []any) obj {
	out := obj{}
	for _, field := range effectsObservedFields {
		out[field] = step.state[field]
	}
	out["calls"] = step.state["calls"]
	out["writeTtls"] = []any{}
	for n := int64(0); n < bn(step.state["writes"]); n++ {
		out["writeTtls"] = append(ba(out["writeTtls"]), 60000)
	}
	events := []any{}
	for _, raw := range ba(step.state["events"]) {
		e := bm(bclone(raw))
		if bhas([]string{"get", "fallback", "serialization", "futureOffset"}, bs(e["event"])) {
			e["amount"] = bf(e["amount"]) / 1000
		}
		events = append(events, e)
	}
	out["events"] = events
	out["readAborts"] = aborted
	contexts := []any{}
	for index, budget := range ba(step.state["readBudgets"]) {
		contexts = append(contexts, obj{"index": index, "timeoutMs": budget, "aborted": false})
	}
	out["readContexts"] = contexts
	return out
}

// C23/C25/C26 monitor consumes actual callback history, never expected ITF
// phases. Publication/source identity is additionally challenged by traces.
func (d *behaviorDriver) assertEffectsHistory() error {
	d.mu.Lock()
	history := append([]behaviorHistory(nil), d.history...)
	d.mu.Unlock()
	type source struct {
		at      int64
		settled string
	}
	sources := map[int]*source{}
	var active *source
	authorized := false
	previous := int64(-1)
	for index, e := range history {
		fail := func(reason string) error {
			return fmt.Errorf("effects contract event %d %s: %s", index, e.event, reason)
		}
		if e.at < previous {
			return fail("elapsed time moved backward")
		}
		previous = e.at
		switch e.event {
		case "sourceStart":
			if e.id < 0 || sources[e.id] != nil || active != nil {
				return fail("source started before prior fallback completed")
			}
			active = &source{at: e.at}
			sources[e.id] = active
			authorized = false
		case "sourceSettlement":
			s := sources[e.id]
			if s == nil || s.settled != "" || (e.outcome != "resolve" && e.outcome != "reject") {
				return fail("invalid source settlement identity")
			}
			s.settled = e.outcome
		case "fallbackCompletion":
			if active == nil {
				return fail("fallback completion has no source")
			}
			if math.IsNaN(e.duration) || math.IsInf(e.duration, 0) || e.duration < 0 {
				return fail("invalid observed fallback duration")
			}
			elapsed := float64(e.at - active.at)
			if math.Abs(e.duration-elapsed) > 1e-7 {
				return behaviorPropertyFailure("C23", "duration includes lookup or omits source time", obj{"event": e.event, "index": index, "atMs": e.at, "elapsedMs": elapsed, "durationMs": e.duration})
			}
			if !e.failed && (elapsed >= 10 || active.settled != "resolve") {
				return behaviorPropertyFailure("C25", "success must be accepted before its source deadline", obj{"event": e.event, "index": index, "atMs": e.at, "elapsedMs": elapsed, "budgetMs": 10, "settlement": active.settled, "failed": e.failed})
			}
			if e.failed && elapsed < 10 && active.settled != "reject" {
				return behaviorPropertyFailure("C23", "source lost its full source-relative budget", obj{"event": e.event, "index": index, "atMs": e.at, "elapsedMs": elapsed, "budgetMs": 10, "settlement": active.settled, "failed": e.failed})
			}
			active = nil
			authorized = !e.failed
		case "writeDispatch":
			if !authorized {
				return behaviorPropertyFailure("C26", "publication without accepted source success", obj{"event": e.event, "index": index, "atMs": e.at, "authorized": authorized})
			}
		default:
			return fail("unknown monitor event")
		}
	}
	return nil
}
func replayEffects(d *behaviorDriver, trace behaviorTrace) error {
	if err := d.apply(obj{"op": "faults", "value": obj{"holdReads": true, "holdLoads": true, "holdDumps": true, "holdWrites": true}}); err != nil {
		return err
	}
	aborted := []any{}
	for index, step := range trace.steps {
		if index > 0 && bn(step.state["readAborts"]) > bn(trace.steps[index-1].state["readAborts"]) {
			aborted = append(aborted, trace.steps[index-1].state["activeRead"])
		}
		for _, input := range effectsInputs(step, d) {
			if err := d.apply(input); err != nil {
				return fmt.Errorf("%s step %d action %s: %w", trace.path, index, step.action, err)
			}
		}
		if err := d.assertEffectsHistory(); err != nil {
			return fmt.Errorf("%s step %d action %s: %w", trace.path, index, step.action, err)
		}
		actual, err := effectsProjection(d.observation())
		if err != nil {
			return err
		}
		expected := effectsExpected(step, aborted)
		if !bequal(expected, actual) {
			return fmt.Errorf("%s step %d action %s choice %d\nexpected: %s\nactual:   %s\nreplay: DIALCACHE_EFFECTS_TRACE_FILE=%s go test -run TestEffectsConformance", trace.path, index, step.action, step.choice, bjson(expected), bjson(actual), trace.path)
		}
	}
	return nil
}

// Both public replay and witness validation consume this exact inventory.
// Scheduled regressions are part of the corpus, including when their witness
// consequence is absent from every randomly sampled history.
func effectsPaths() ([]string, error) {
	paths := []string{"../formal/effects-smoke.itf.json"}
	if file := os.Getenv("DIALCACHE_EFFECTS_TRACE_FILE"); file != "" {
		paths = []string{file}
	} else if dir := os.Getenv("DIALCACHE_EFFECTS_TRACE_DIR"); dir != "" {
		var err error
		paths, err = filepath.Glob(filepath.Join(dir, "*.itf.json"))
		if err != nil {
			return nil, err
		}
		regressions, err := featureRegressionPaths("effects", dir)
		if err != nil {
			return nil, err
		}
		paths = append(paths, regressions...)
	}
	if len(paths) == 0 {
		return nil, fmt.Errorf("empty effects corpus")
	}
	return paths, nil
}

func TestEffectsPathsRejectMissingScheduledRegressions(t *testing.T) {
	t.Setenv("DIALCACHE_EFFECTS_TRACE_FILE", "")
	t.Setenv("DIALCACHE_EFFECTS_TRACE_DIR", t.TempDir())
	if _, err := effectsPaths(); err == nil || !strings.Contains(err.Error(), "missing Quint regression") {
		t.Fatalf("missing scheduled histories must fail corpus selection: %v", err)
	}
}

func TestEffectsConformance(t *testing.T) {
	requireRegistry(t)
	requireBehaviorProfile(t, "effects")
	paths, err := effectsPaths()
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, path := range paths {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		trace, err := parseEffectsTrace(raw, path)
		if err != nil {
			t.Fatal(err)
		}
		for _, step := range trace.steps {
			seen[step.action] = true
		}
		t.Run(filepath.Base(path), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				d := newBehaviorDriver(t, effectsFixture(trace.steps[0].choice))
				defer d.close()
				if err := replayEffects(d, trace); err != nil {
					t.Error(err)
				}
			})
		})
	}
	if os.Getenv("DIALCACHE_EFFECTS_TRACE_DIR") != "" && os.Getenv("DIALCACHE_EFFECTS_TRACE_FILE") == "" {
		for _, action := range effectsActions {
			if !seen[action] {
				t.Errorf("effects corpus omitted action %s", action)
			}
		}
	}
	t.Logf("specification=0.1.0 effectsProfile=2 traces=%d", len(paths))
}
func TestEffectsParserRejectsMissingDiagnostics(t *testing.T) {
	raw, err := os.ReadFile("../formal/effects-smoke.itf.json")
	if err != nil {
		t.Fatal(err)
	}
	decoded, _ := behaviorJSON(raw)
	state := bm(ba(bm(decoded)["states"])[0])
	delete(bm(state["s"]), "events")
	if _, err := parseEffectsTrace([]byte(bjson(decoded)), "negative"); err == nil {
		t.Fatal("missing diagnostic expectations accepted")
	}
}
