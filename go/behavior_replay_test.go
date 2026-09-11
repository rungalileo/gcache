package dialcache

import (
	"fmt"
	"os"
	"strings"
	"testing"
	"testing/synctest"
)

func loadBehaviorScenarios() ([]any, error) {
	raw, err := os.ReadFile("../formal/behavioral-scenarios.json")
	if err != nil {
		return nil, err
	}
	decoded, err := behaviorJSON(raw)
	if err != nil {
		return nil, err
	}
	corpus := bm(decoded)
	if bn(corpus["schemaVersion"]) != 2 {
		return nil, fmt.Errorf("unsupported behavioral schema")
	}
	scenarios := ba(corpus["scenarios"])
	if len(scenarios) == 0 {
		return nil, fmt.Errorf("empty behavioral corpus")
	}
	seen := map[string]bool{}
	for _, raw := range scenarios {
		s := bm(raw)
		name := bs(s["name"])
		if name == "" || seen[name] || len(ba(s["steps"])) == 0 {
			return nil, fmt.Errorf("invalid/duplicate/empty scenario %q", name)
		}
		seen[name] = true
		shape := emptyBehaviorObservation(obj{"observe": []any{}})
		for _, rawStep := range ba(s["steps"]) {
			step := bm(rawStep)
			if _, ok := step["input"].(map[string]any); !ok {
				return nil, fmt.Errorf("missing input in %s", name)
			}
			patch, ok := step["expect"].(map[string]any)
			if !ok {
				return nil, fmt.Errorf("missing expected patch in %s", name)
			}
			for key := range patch {
				if _, known := shape[key]; !known {
					return nil, fmt.Errorf("unknown expected field %s", key)
				}
			}
		}
	}
	return scenarios, nil
}
func replayBehavior(d *behaviorDriver, scenario obj) error {
	expected := emptyBehaviorObservation(bm(scenario["fixture"]))
	for index, raw := range ba(scenario["steps"]) {
		step := bm(raw)
		for key, value := range bm(step["expect"]) {
			expected[key] = value
		}
		input := bm(step["input"])
		if err := d.apply(input); err != nil {
			return fmt.Errorf("%s step %d input %s: %w", scenario["name"], index, bjson(input), err)
		}
		actual := d.observation()
		if !bequal(expected, actual) {
			return fmt.Errorf("%s step %d input %s\nexpected: %s\nactual:   %s", scenario["name"], index, bjson(input), bjson(expected), bjson(actual))
		}
	}
	return nil
}
func TestBehaviorConformance(t *testing.T) {
	scenarios, err := loadBehaviorScenarios()
	if err != nil {
		t.Fatal(err)
	}
	requireRegistry(t)
	filter := os.Getenv("DIALCACHE_BEHAVIOR_SCENARIO")
	matched := 0
	for _, raw := range scenarios {
		scenario := bm(raw)
		name := bs(scenario["name"])
		if filter != "" && !strings.Contains(name, filter) {
			continue
		}
		t.Run(bs(scenario["feature"])+"/"+name, func(t *testing.T) {
			matched++
			synctest.Test(t, func(t *testing.T) {
				d := newBehaviorDriver(t, bm(scenario["fixture"]))
				defer d.close()
				if err := replayBehavior(d, scenario); err != nil {
					t.Error(err)
				}
			})
		})
	}
	if matched == 0 {
		t.Fatal("no behavioral scenario matched")
	}
	t.Logf("specification=0.1.0 behavioralSchema=2 scenarios=%d", matched)
}

func TestBehaviorJSONRejectsAmbiguousInputs(t *testing.T) {
	for _, raw := range []string{`{"action":1,"action":2}`, `{"action":1,"\u0061ction":2}`, `[{"s":{"calls":[],"calls":[]}}]`, `{"value":NaN}`, `{"value":1} trailing`} {
		if err := validateBehaviorJSON([]byte(raw)); err == nil {
			t.Fatalf("ambiguous/malformed JSON accepted: %s", raw)
		}
	}
	for _, raw := range []string{`{"value":"escaped \\\" delimiter } ]","nested":[null,false,1,-2.5e3,{"empty":{}}]}`, `{"a":1,"\u0062":2}`, `[{},[],true,false,null,"",1]`} {
		if err := validateBehaviorJSON([]byte(raw)); err != nil {
			t.Fatalf("valid JSON rejected: %s: %v", raw, err)
		}
	}
}

func TestBehaviorProjectionDistinguishesJSONValues(t *testing.T) {
	if !bequal(obj{"n": int64(1), "a": []any{false, nil, ""}}, obj{"n": float64(1), "a": []any{false, nil, ""}}) {
		t.Fatal("equivalent JSON numbers differed")
	}
	for _, pair := range [][2]any{{false, 0}, {nil, false}, {"1", 1}, {[]any{}, nil}, {obj{"x": nil}, obj{}}} {
		if bequal(pair[0], pair[1]) {
			t.Fatalf("distinct observations compared equal: %v", pair)
		}
	}
}
func TestBehaviorDriverRejectsCorruptExpectations(t *testing.T) {
	scenarios, err := loadBehaviorScenarios()
	if err != nil {
		t.Fatal(err)
	}
	var original obj
	for _, raw := range scenarios {
		if bm(raw)["name"] == "adapter legacy null preserves only trustworthy miss metadata" {
			original = bm(raw)
		}
	}
	if original == nil {
		t.Fatal("missing diagnostic regression")
	}
	scenario := bm(bclone(original))
	steps := ba(scenario["steps"])
	events := ba(bm(bm(steps[1])["expect"])["events"])
	bm(events[0])["reason"] = "expired"
	synctest.Test(t, func(t *testing.T) {
		d := newBehaviorDriver(t, bm(scenario["fixture"]))
		defer d.close()
		if err := replayBehavior(d, scenario); err == nil || !strings.Contains(err.Error(), "step 1") {
			t.Fatalf("corrupted expected event must fail replay: %v", err)
		}
	})
}
func TestBehaviorDriverObservesLostWrites(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		d := newBehaviorDriver(t, obj{"policy": obj{"ttlSec": obj{"remote": 60}}, "fallbackTimeoutMs": nil})
		defer d.close()
		d.discardWrites = true
		for _, input := range []obj{{"op": "begin"}, {"op": "resolve", "loader": 0, "value": 1}, {"op": "begin"}} {
			if err := d.apply(input); err != nil {
				t.Fatal(err)
			}
		}
		actual := d.observation()
		if bn(actual["writes"]) != 1 || bn(actual["loaders"]) != 2 || bm(ba(actual["calls"])[1])["status"] != "pending" {
			t.Fatalf("acknowledged writes must be probed through a later real call: %s", bjson(actual))
		}
	})
}
