package dialcache

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/synctest"
)

type behaviorAction struct {
	choices []int64
	input   func(int64, *behaviorDriver) obj
}
type behaviorProfile struct {
	policyErrorIO           bool
	explicitInputs          bool
	markerIO                bool
	compressionIO           bool
	name                    string
	fixture                 func(int64) obj
	setup                   []obj
	initChoices             []int64
	actions                 map[string]behaviorAction
	diagnosticAge           string
	diagnosticConfigErrors  bool
	diagnosticFutureOffsets bool
	readIO                  bool
}
type behaviorStep struct {
	action   string
	choice   int64
	state    obj
	expected obj
}
type behaviorTrace struct {
	path  string
	steps []behaviorStep
}

func brange(start, end int64) []int64 {
	out := []int64{}
	for n := start; n <= end; n++ {
		out = append(out, n)
	}
	return out
}
func bcontains(values []int64, n int64) bool {
	for _, v := range values {
		if v == n {
			return true
		}
	}
	return false
}
func fixedAction(input obj) behaviorAction {
	return behaviorAction{input: func(int64, *behaviorDriver) obj { return bm(bclone(input)) }}
}
func chosenAction(choices []int64, input func(int64) obj) behaviorAction {
	return behaviorAction{choices: choices, input: func(n int64, _ *behaviorDriver) obj { return input(n) }}
}
func releaseAction(effect string) behaviorAction {
	return behaviorAction{input: func(_ int64, d *behaviorDriver) obj {
		return obj{"op": "release", "effect": effect, "index": d.observedEffectCount(effect) - 1}
	}}
}
func faultAction(effect string) behaviorAction {
	return chosenAction([]int64{0, 1}, func(n int64) obj { return obj{"op": "faults", "value": obj{effect: n == 1}} })
}
func advanceAction(choices ...int64) behaviorAction {
	return chosenAction(choices, func(n int64) obj { return obj{"op": "advance", "ms": n} })
}
func sourceValueAction(count int64) behaviorAction {
	return chosenAction(brange(1, count*7), func(choice int64) obj {
		// Each loader has seven outcomes, including absence and all false-like JSON values.
		values := []any{1, 2, Absent, nil, false, 0, ""}
		loader, outcome := (choice-1)/7, (choice-1)%7
		input := obj{"op": "resolve", "loader": loader}
		value := values[outcome]
		if !IsAbsent(value) {
			input["value"] = value
		}
		return input
	})
}
func sourcePairAction(count int64) behaviorAction {
	return chosenAction(brange(1, count*2), func(choice int64) obj {
		loader, value := (choice-1)/2, (choice-1)%2+1
		return obj{"op": "resolve", "loader": loader, "value": value}
	})
}
func rejectSourceAction(count int64) behaviorAction {
	return chosenAction(brange(0, count-1), func(n int64) obj { return obj{"op": "reject", "loader": n} })
}
func behaviorProfiles() map[string]behaviorProfile {
	profiles := map[string]behaviorProfile{}
	profiles["recovery-read"] = recoveryReadProfile()
	profiles["local-failure"] = localFailureProfile()
	profiles["runtime-boundaries"] = runtimeBoundariesProfile()
	profiles["shadow-layers"] = shadowLayersProfile()
	profiles["source-budgets"] = sourceBudgetsProfile()

	// Scopes can be independent, nested, disabled, or closed while policy resolution waits.
	profiles["scope"] = behaviorProfile{
		name:           "scope",
		explicitInputs: true,
		diagnosticAge:  "none",
		fixture: func(int64) obj {
			return obj{
				"policy":            obj{"requestLocal": true},
				"remote":            false,
				"fallbackTimeoutMs": nil,
				"probeSourceScope":  true,
				"observe":           []any{"coalesced", "error"},
			}
		},
		setup: []obj{
			{"op": "openScope", "id": "0"},
			{"op": "faults", "value": obj{"holdPolicies": true}},
		},
		actions: map[string]behaviorAction{
			"openScope": chosenAction(brange(1, 4), func(scope int64) obj {
				input := obj{"op": "openScope", "id": fmt.Sprint(scope)}
				// Scope 1 is independent; 2 and disabled 3 descend from 0; 4 descends from 3.
				if scope != 1 {
					input["parent"] = "0"
				}
				if scope == 4 {
					input["parent"] = "3"
				}
				if scope == 3 {
					input["disabled"] = true
				}
				return input
			}),
			"closeScope": chosenAction(brange(0, 4), func(scope int64) obj {
				return obj{"op": "closeScope", "id": fmt.Sprint(scope)}
			}),
			"beginCall": chosenAction(brange(0, 5), func(scope int64) obj {
				input := obj{"op": "begin"}
				if scope == 5 {
					input["outside"] = true
				} else {
					input["scope"] = fmt.Sprint(scope)
				}
				return input
			}),
			"releasePolicy": releaseAction("policy"),
			"resolveLoader": sourceValueAction(16),
			"rejectLoader":  rejectSourceAction(16),
			"policy": chosenAction(brange(0, 2), func(choice int64) obj {
				policy := obj{}
				if choice == 1 {
					policy["requestLocal"] = false
				}
				if choice == 2 {
					policy["coalesce"] = false
				}
				return obj{"op": "policy", "value": policy}
			}),
		},
	}

	// Overlay positions are Quint choices: 0–9 retain coalescing, 10–19 disable it.
	overlays := []obj{
		{},
		{"ttlSec": obj{"local": 2}},
		{"ttlSec": obj{"remote": 2}},
		{"ramp": obj{"local": 0}},
		{"ramp": obj{"remote": 0}},
		{"ttlSec": obj{"local": -1}},
		{"ttlSec": obj{"remote": -1}},
		{"staleOnErrorMaxAgeSec": 2},
		{"ramp": obj{"local": 0, "remote": 0}},
		{"ttlSec": obj{"remote": 4}, "staleOnErrorMaxAgeSec": 0},
	}
	for i := 0; i < 10; i++ {
		overlay := bm(bclone(overlays[i]))
		overlay["coalesce"] = false
		overlays = append(overlays, overlay)
	}
	// Choices 20–25 exercise additional timeout, ramp, and recovery-age boundaries.
	overlays = append(overlays,
		obj{"remoteReadTimeoutMs": 0},
		obj{"ramp": obj{"local": 101}},
		obj{"ramp": obj{"remote": 101}},
		obj{"staleOnErrorMaxAgeSec": 1},
		obj{"staleOnErrorMaxAgeSec": -1},
		obj{"shadow": obj{"ramp": 101}},
	)
	profiles["policy"] = behaviorProfile{
		name:           "policy",
		explicitInputs: true,
		policyErrorIO:  true,
		fixture: func(int64) obj {
			return obj{
				"policy": obj{
					"ttlSec":                obj{"local": 1, "remote": 1},
					"staleOnErrorMaxAgeSec": 5,
				},
				"localMaxSize":      1,
				"fallbackTimeoutMs": nil,
				"observe":           []any{"error"},
			}
		},
		setup: []obj{{"op": "faults", "value": obj{"holdPolicies": true}}},
		actions: map[string]behaviorAction{
			"beginCall": chosenAction(brange(0, 1), func(key int64) obj {
				return obj{"op": "begin", "key": fmt.Sprint(key)}
			}),
			"releasePolicy": releaseAction("policy"),
			"resolveLoader": sourceValueAction(12),
			"rejectLoader":  rejectSourceAction(12),
			"seed": chosenAction(brange(0, 3), func(choice int64) obj {
				key, value := choice/2, choice%2+1
				return obj{"op": "seed", "key": fmt.Sprint(key), "value": value, "ttlMs": 5000}
			}),
			"policy": chosenAction(brange(0, 25), func(choice int64) obj {
				return obj{"op": "policy", "value": overlays[choice]}
			}),
			"advance":       advanceAction(1, 500, 1000, 2000, 5000),
			"rollbackWall":  fixedAction(obj{"op": "shiftWall", "ms": -1000}),
			"providerFault": faultAction("policy"),
			"readFault":     faultAction("read"),
			"dumpFault":     faultAction("dump"),
			"writeFault":    faultAction("write"),
		},
	}

	layerPolicies := []obj{
		{},
		{"requestLocal": false},
		{"ramp": obj{"local": 0}},
		{"ramp": obj{"remote": 0}},
		{"ramp": obj{"local": 0, "remote": 0}},
		{"requestLocal": false, "ramp": obj{"local": 0, "remote": 0}},
	}
	profiles["layers"] = behaviorProfile{
		name:           "layers",
		explicitInputs: true,
		initChoices:    brange(0, 5),
		fixture: func(choice int64) obj {
			// Pairs select local+remote, remote only, or local only; odd choices track identity.
			capacity := 2
			if choice == 2 || choice == 3 {
				capacity = 0
			}
			return obj{
				"policy": obj{
					"requestLocal": true,
					"ttlSec":       obj{"local": 60, "remote": 60},
				},
				"tracked":           choice%2 == 1,
				"remote":            choice < 4,
				"localMaxSize":      capacity,
				"fallbackTimeoutMs": nil,
			}
		},
		setup: []obj{
			{"op": "openScope", "id": "0", "instance": "0"},
			{"op": "openScope", "id": "1", "instance": "0"},
			{"op": "openScope", "id": "2", "instance": "1"},
		},
		actions: map[string]behaviorAction{
			"beginCall": chosenAction(brange(0, 19), func(choice int64) obj {
				// Each context has two keys and two use cases. Contexts 3–4 have no explicit scope.
				context, identity := choice/4, choice%4
				key, useCase := identity/2, identity%2
				input := obj{"op": "begin", "key": fmt.Sprint(key), "useCase": fmt.Sprintf("Layers%d", useCase)}
				if context < 3 {
					input["scope"] = fmt.Sprint(context)
				} else if context == 4 {
					input["instance"] = "1"
				} else {
					input["instance"] = "0"
				}
				return input
			}),
			"resolveLoader": sourcePairAction(20),
			"rejectLoader":  rejectSourceAction(20),
			"closeScope": chosenAction(brange(0, 2), func(scope int64) obj {
				return obj{"op": "closeScope", "id": fmt.Sprint(scope)}
			}),
			"policy": chosenAction(brange(0, 5), func(choice int64) obj {
				return obj{"op": "policy", "value": layerPolicies[choice]}
			}),
			"seed": chosenAction(brange(0, 7), func(choice int64) obj {
				key, useCase, value := choice/4, choice/2%2, choice%2+1
				return obj{"op": "seed", "key": fmt.Sprint(key), "useCase": fmt.Sprintf("Layers%d", useCase), "value": value}
			}),
			"invalidate": chosenAction(brange(0, 1), func(key int64) obj {
				return obj{"op": "invalidate", "key": fmt.Sprint(key)}
			}),
			"tick": fixedAction(obj{"op": "advance", "ms": 1}),
		},
	}

	profiles["recovery"] = behaviorProfile{
		name:          "recovery",
		diagnosticAge: "recoveryAge",
		initChoices:   brange(0, 7),
		fixture: func(choice int64) obj {
			// Cross the four cache-level recovery modes with request-local caching off/on.
			recovery := []string{"default", "allow", "deny", "error"}[choice%4]
			return obj{
				"policy": obj{
					"ttlSec":                obj{"remote": 1},
					"staleOnErrorMaxAgeSec": 5,
					"requestLocal":          choice >= 4,
				},
				"tracked":           true,
				"fallbackTimeoutMs": 10,
				"recovery":          recovery,
				"observe":           []any{"recoveryAge", "coalesced", "error"},
			}
		},
		setup: []obj{
			{"op": "openScope", "id": "0"},
			{"op": "openScope", "id": "1"},
			{"op": "seed", "value": 1, "ageMs": 1000},
			{"op": "faults", "value": obj{"holdLoads": true}},
		},
		actions: map[string]behaviorAction{
			"beginCall": chosenAction(brange(0, 7), func(choice int64) obj {
				scope, recovery := choice/4, choice%4
				input := obj{"op": "begin", "scope": fmt.Sprint(scope)}
				// Recovery mode 3 inherits the fixture predicate; the others override it per call.
				if recovery != 3 {
					input["recovery"] = []string{"allow", "deny", "error"}[recovery]
				}
				return input
			}),
			"joinCall": chosenAction(brange(0, 1), func(scope int64) obj {
				return obj{"op": "begin", "scope": fmt.Sprint(scope)}
			}),
			"closeScope": chosenAction(brange(0, 1), func(scope int64) obj {
				return obj{"op": "closeScope", "id": fmt.Sprint(scope)}
			}),
			"resolveLoader": chosenAction(brange(0, 7), func(loader int64) obj {
				return obj{"op": "resolve", "loader": loader, "value": 2}
			}),
			"rejectLoader": rejectSourceAction(8),
			"rejectTimeout": chosenAction(brange(0, 7), func(loader int64) obj {
				return obj{"op": "reject", "loader": loader, "error": "timeout"}
			}),
			"releaseLoad": releaseAction("load"),
			"seed": chosenAction(brange(0, 6), func(choice int64) obj {
				value := 1
				if choice == 6 {
					value = 2
				}
				ageMS := []int{0, 999, 1000, 4999, 5000, -1, 1000}[choice]
				return obj{"op": "seed", "value": value, "ageMs": ageMS}
			}),
			"advance":      advanceAction(1, 10, 1000, 4000),
			"rollbackWall": fixedAction(obj{"op": "shiftWall", "ms": -1000}),
			"invalidate":   fixedAction(obj{"op": "invalidate"}),
			"policy": chosenAction([]int64{2000, 5000}, func(ageMS int64) obj {
				return obj{"op": "policy", "value": obj{"staleOnErrorMaxAgeSec": ageMS / 1000}}
			}),
			"readFault": faultAction("read"),
			"loadFault": faultAction("load"),
		},
	}

	// Independent reads keep their own deadlines and recovery attempts when coalescing is off.
	profiles["independent"] = behaviorProfile{
		name:           "independent",
		explicitInputs: true,
		readIO:         true,
		fixture: func(int64) obj {
			return obj{
				"policy": obj{
					"ttlSec":                obj{"remote": 1},
					"staleOnErrorMaxAgeSec": 5,
					"coalesce":              false,
				},
				"tracked":           true,
				"readTimeoutMs":     5,
				"fallbackTimeoutMs": 10,
				"recovery":          "allow",
				"observe":           []any{"readContext", "readAbort"},
			}
		},
		setup: []obj{
			{"op": "seed", "value": 1, "ageMs": 1000},
			{"op": "faults", "value": obj{"holdReads": true, "holdLoads": true}},
		},
		actions: map[string]behaviorAction{
			"beginCall":     fixedAction(obj{"op": "begin"}),
			"resolveLoader": sourcePairAction(6),
			"rejectLoader":  rejectSourceAction(6),
			"advance":       advanceAction(1, 5, 10, 1000),
			"seed": chosenAction(brange(0, 5), func(choice int64) obj {
				value := 1
				if choice == 2 || choice == 4 {
					value = 2
				}
				ageMS := []int{0, 1000, 1000, 4999, 0, 1999}[choice]
				return obj{"op": "seed", "value": value, "ageMs": ageMS}
			}),
			"invalidate": fixedAction(obj{"op": "invalidate"}),
			"policy": chosenAction(brange(0, 3), func(choice int64) obj {
				readTimeoutMS := []int{5, 10}[choice%2]
				staleAgeSec := []int{5, 2}[choice/2]
				return obj{"op": "policy", "value": obj{
					"remoteReadTimeoutMs":   readTimeoutMS,
					"staleOnErrorMaxAgeSec": staleAgeSec,
				}}
			}),
		},
	}
	for _, effect := range []string{"read", "load"} {
		for _, fail := range []bool{false, true} {
			name := "release"
			if fail {
				name = "fail"
			}
			name += strings.ToUpper(effect[:1]) + effect[1:]
			profile := profiles["independent"]
			profile.actions[name] = chosenAction(brange(0, 5), func(index int64) obj {
				return obj{"op": "release", "effect": effect, "index": index, "fail": fail}
			})
			profiles["independent"] = profile
		}
	}

	// Three keys on two instances compete for two shadow slots per instance.
	profiles["admission"] = behaviorProfile{
		name: "admission",
		fixture: func(int64) obj {
			return obj{
				"policy":            obj{"ttlSec": obj{"remote": 60}, "shadow": obj{"ramp": 100}},
				"tracked":           true,
				"shadowMaxInFlight": 2,
				"readTimeoutMs":     1000,
				"probeSourceScope":  true,
			}
		},
		setup: []obj{
			{"op": "seed", "key": "0", "value": 1},
			{"op": "seed", "key": "1", "value": 1},
			{"op": "seed", "key": "2", "value": 1},
			{"op": "faults", "value": obj{"holdReads": true, "holdLoads": true}},
		},
		actions: map[string]behaviorAction{
			"beginCall": chosenAction(brange(0, 5), func(choice int64) obj {
				key, instance := choice%3, choice/3
				return obj{"op": "begin", "key": fmt.Sprint(key), "instance": fmt.Sprint(instance)}
			}),
			"releaseRead": chosenAction(brange(0, 31), func(index int64) obj {
				return obj{"op": "release", "effect": "read", "index": index}
			}),
			"releaseLoad": chosenAction(brange(0, 31), func(index int64) obj {
				return obj{"op": "release", "effect": "load", "index": index}
			}),
			"resolveLoader": sourcePairAction(16),
			"rejectLoader":  rejectSourceAction(16),
			"seed": chosenAction(brange(0, 5), func(choice int64) obj {
				key, value := choice/2, choice%2+1
				return obj{"op": "seed", "key": fmt.Sprint(key), "value": value}
			}),
			"advance": advanceAction(1, 10),
			"policy": chosenAction(brange(0, 3), func(choice int64) obj {
				shadowRamp := []int{100, 0}[choice%2]
				return obj{"op": "policy", "value": obj{
					"shadow":   obj{"ramp": shadowRamp},
					"coalesce": choice < 2,
				}}
			}),
		},
	}

	// Values, raw text, and bytes exercise semantic comparison across equivalent encodings.
	shadowSeed := chosenAction(brange(1, 8), func(choice int64) obj {
		input := obj{"op": "seed"}
		switch choice {
		case 1, 2:
			input["value"] = choice
		case 3:
			input["payloadHex"] = "31"
		case 4:
			input["payloadHex"] = "32"
		case 5:
			input["payloadHex"] = "2031"
		case 6:
			input["payloadText"] = " 1"
		case 7:
			input["payloadText"] = "\"café\""
		case 8:
			input["payloadHex"] = "22636166c3a922"
		}
		return input
	})
	profiles["shadow"] = behaviorProfile{
		name:                    "shadow",
		explicitInputs:          true,
		diagnosticFutureOffsets: true,
		diagnosticAge:           "shadowAge",
		diagnosticConfigErrors:  true,
		initChoices:             brange(0, 12),
		fixture: func(choice int64) obj {
			shadow := obj{"ramp": 100}
			if choice >= 4 && choice < 8 {
				shadow["logMismatches"] = true
			}
			fixture := obj{
				"policy": obj{
					"ttlSec": obj{"remote": 60},
					"ramp":   obj{"remote": 0},
					"shadow": shadow,
				},
				"tracked":    true,
				"shadowHook": choice != 8,
				"observe":    []any{"shadowAge", "mismatchWarning", "coalesced", "error", "futureOffset"},
			}
			// Choices 0–7 cross default/equal/unequal/error comparison with mismatch logging.
			if choice%4 != 0 && choice < 11 {
				comparator := choice%4 - 1
				if choice == 10 {
					comparator = 2
				}
				fixture["comparator"] = []string{"equal", "unequal", "error"}[comparator]
			}
			// Choices 9–10 delay comparison; 11–12 vary source work around the deadline.
			if choice == 9 || choice == 10 {
				fixture["comparisonMs"] = 10
			}
			if choice >= 11 {
				fixture["sourceWorkMs"] = []int{9, 10}[choice-11]
			}
			return fixture
		},
		setup: []obj{{"op": "faults", "value": obj{
			"holdReads":  true,
			"holdLoads":  true,
			"holdDumps":  true,
			"holdWrites": true,
		}}},
		actions: map[string]behaviorAction{
			"beginCall": fixedAction(obj{"op": "begin"}),
			"resolveLoader": {
				choices: brange(1, 2),
				input: func(value int64, d *behaviorDriver) obj {
					return obj{"op": "resolve", "loader": d.observedEffectCount("loader") - 1, "value": value}
				},
			},
			"rejectLoader": {input: func(_ int64, d *behaviorDriver) obj {
				return obj{"op": "reject", "loader": d.observedEffectCount("loader") - 1}
			}},
			"releaseRead":  releaseAction("read"),
			"releaseLoad":  releaseAction("load"),
			"releaseDump":  releaseAction("dump"),
			"releaseWrite": releaseAction("write"),
			"advance":      advanceAction(1, 10),
			"seed":         shadowSeed,
			"reencode":     shadowSeed,
			"seedUnicode":  {choices: []int64{7, 8}, input: shadowSeed.input},
			"invalidate": chosenAction([]int64{0, 20}, func(bufferMS int64) obj {
				return obj{"op": "invalidate", "futureBufferMs": bufferMS}
			}),
			"readFault":    faultAction("read"),
			"loadFault":    faultAction("load"),
			"dumpFault":    faultAction("dump"),
			"writeFault":   faultAction("write"),
			"rollbackWall": fixedAction(obj{"op": "shiftWall", "ms": -1000}),
			"advanceWall": chosenAction([]int64{1, 60000}, func(deltaMS int64) obj {
				return obj{"op": "shiftWall", "ms": deltaMS}
			}),
			"shadowPolicy": chosenAction(brange(0, 2), func(choice int64) obj {
				shadowRamp := []int{100, 0, 101}[choice]
				return obj{"op": "policy", "value": obj{"shadow": obj{"ramp": shadowRamp}}}
			}),
			"logPolicy": chosenAction(brange(0, 2), func(choice int64) obj {
				var logging any = choice == 1
				if choice == 2 {
					logging = "invalid"
				}
				return obj{"op": "policy", "value": obj{"shadow": obj{"logMismatches": logging}}}
			}),
		},
	}
	return profiles
}

func parseBehaviorTrace(raw []byte, path string, p behaviorProfile) (behaviorTrace, error) {
	// Validate every JSON member for ambiguity, but allocate only the public
	// action/choice and observations. Large private model matrices never enter
	// this driver, its executor, or its implementation projection.
	if err := validateBehaviorJSON(raw); err != nil {
		return behaviorTrace{}, err
	}
	var envelope struct {
		States []struct {
			Action string          `json:"mbt::actionTaken"`
			Picks  json.RawMessage `json:"mbt::nondetPicks"`
			Input  json.RawMessage `json:"input"`
			State  struct {
				O            json.RawMessage `json:"o"`
				PolicyErrors json.RawMessage `json:"policyErrors"`
				D            json.RawMessage `json:"d"`
				IO           json.RawMessage `json:"io"`
				Markers      json.RawMessage `json:"markers"`
				Compression  json.RawMessage `json:"compression"`
			} `json:"s"`
		} `json:"states"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return behaviorTrace{}, err
	}
	states := make([]obj, 0, len(envelope.States))
	for _, wire := range envelope.States {
		var rawPicks any
		if !p.explicitInputs {
			if err := json.Unmarshal(wire.Picks, &rawPicks); err != nil {
				return behaviorTrace{}, err
			}
		}
		picks, err := behaviorITF(rawPicks)
		if err != nil {
			return behaviorTrace{}, err
		}
		state := obj{}
		for name, bytes := range map[string]json.RawMessage{"o": wire.State.O, "d": wire.State.D, "io": wire.State.IO, "markers": wire.State.Markers, "compression": wire.State.Compression, "policyErrors": wire.State.PolicyErrors} {
			if len(bytes) == 0 {
				continue
			}
			var value any
			if err := json.Unmarshal(bytes, &value); err != nil {
				return behaviorTrace{}, err
			}
			value, err = behaviorITF(value)
			if err != nil {
				return behaviorTrace{}, err
			}
			state[name] = value
		}
		entry := obj{"mbt::actionTaken": wire.Action, "mbt::nondetPicks": picks, "s": state}
		if p.explicitInputs {
			var rawInput any
			if err := json.Unmarshal(wire.Input, &rawInput); err != nil {
				return behaviorTrace{}, err
			}
			input, err := behaviorITF(rawInput)
			if err != nil {
				return behaviorTrace{}, err
			}
			entry["input"] = input
		}
		states = append(states, entry)
	}
	trace := behaviorTrace{path: path}
	if len(states) < 2 {
		return trace, fmt.Errorf("%s: trace requires initialization and transition", path)
	}
	for index, rawState := range states {
		s := bm(rawState)
		action := bs(s["mbt::actionTaken"])
		if p.explicitInputs {
			input := bm(s["input"])
			if behaviorKeys(input) != "choice,name" {
				return trace, fmt.Errorf("invalid explicit input")
			}
			action = bs(input["name"])
		}
		descriptor, known := p.actions[action]
		if index == 0 {
			known = action == "init"
			descriptor.choices = p.initChoices
		} else if action == "init" {
			known = false
		}
		if !known {
			return trace, fmt.Errorf("%s step %d unknown/misplaced action %s", path, index, action)
		}
		picks := bm(s["mbt::nondetPicks"])
		if !p.explicitInputs && behaviorKeys(picks) != "choice" {
			return trace, fmt.Errorf("%s unsupported choice fields", path)
		}
		pick := bm(picks["choice"])
		var choice int64
		if p.explicitInputs {
			n, ok := bm(s["input"])["choice"].(float64)
			if !ok || float64(int64(n)) != n || descriptor.choices == nil && n != -1 || descriptor.choices != nil && !bcontains(descriptor.choices, int64(n)) {
				return trace, fmt.Errorf("%s step %d unsupported explicit choice", path, index)
			}
			choice = int64(n)
		} else if descriptor.choices != nil {
			n, ok := pick["value"].(float64)
			if pick["tag"] != "Some" || !ok || float64(int64(n)) != n || !bcontains(descriptor.choices, int64(n)) {
				return trace, fmt.Errorf("%s step %d missing/unsupported choice", path, index)
			}
			choice = int64(n)
		} else if pick["tag"] != "None" || bjson(pick["value"]) != "{\"#tup\":[]}" {
			return trace, fmt.Errorf("%s step %d unexpected choice", path, index)
		}
		state := bm(s["s"])
		expected := bm(state["o"])
		shape := emptyBehaviorObservation(obj{})
		if behaviorKeys(expected) != behaviorKeys(shape) {
			return trace, fmt.Errorf("%s step %d missing/unexpected observation fields", path, index)
		}
		for field, initial := range shape {
			v := expected[field]
			switch initial.(type) {
			case int64:
				n, ok := v.(float64)
				if !ok || n < 0 || float64(int64(n)) != n {
					return trace, fmt.Errorf("invalid observed counter %s", field)
				}
			default:
				items, ok := v.([]any)
				if !ok {
					return trace, fmt.Errorf("invalid observation list %s", field)
				}
				for _, item := range items {
					if field == "calls" || field == "writeTtls" {
						n, ok := item.(float64)
						if !ok || n < 0 || float64(int64(n)) != n || field == "calls" && n > 9 && n != 11 {
							return trace, fmt.Errorf("invalid outcome %s", field)
						}
					} else if field == "sourceScopes" {
						if _, ok := item.(bool); !ok {
							return trace, fmt.Errorf("invalid source scope")
						}
					} else if _, ok := item.(string); !ok {
						return trace, fmt.Errorf("invalid observed string %s", field)
					}
				}
			}
		}
		diagnosticFields := "ages,coalesced,fallbackErrors,warnings"
		if p.diagnosticConfigErrors {
			diagnosticFields = "ages,coalesced,configErrors,fallbackErrors,warnings"
		}
		if p.diagnosticFutureOffsets {
			diagnosticFields = strings.Replace(diagnosticFields, "fallbackErrors,warnings", "fallbackErrors,futureOffsets,warnings", 1)
		}
		if p.diagnosticAge != "" && behaviorKeys(bm(state["d"])) != diagnosticFields {
			return trace, fmt.Errorf("missing diagnostic observations")
		}
		if p.diagnosticAge != "" {
			d := bm(state["d"])
			if p.diagnosticFutureOffsets {
				offsets, ok := d["futureOffsets"].([]any)
				if !ok {
					return trace, fmt.Errorf("missing future offsets")
				}
				for _, raw := range offsets {
					offset := bm(raw)
					n, valid := offset["offsetMs"].(float64)
					if behaviorKeys(offset) != "layer,offsetMs" || offset["layer"] != "remote_shadow" || !valid || n <= 0 || n > 9007199254740991 || math.Trunc(n) != n {
						return trace, fmt.Errorf("invalid future offset")
					}
				}
			}
			if p.diagnosticConfigErrors {
				if n, ok := d["configErrors"].(float64); !ok || n < 0 || n != float64(int64(n)) {
					return trace, fmt.Errorf("invalid config diagnostic count")
				}
			}
			if n, ok := d["warnings"].(float64); !ok || n < 0 || n != float64(int64(n)) {
				return trace, fmt.Errorf("invalid warning count")
			}
			if _, ok := d["ages"].([]any); !ok {
				return trace, fmt.Errorf("missing age list")
			}
			for _, age := range ba(d["ages"]) {
				if n, ok := age.(float64); !ok || n < 0 || n != float64(int64(n)) {
					return trace, fmt.Errorf("invalid diagnostic age")
				}
			}
			for field, allowed := range map[string][]string{"coalesced": {"process", "request_local"}, "fallbackErrors": {"noop", "local", "remote", "request_local"}} {
				values, ok := d[field].([]any)
				if !ok {
					return trace, fmt.Errorf("missing diagnostic labels")
				}
				for _, raw := range values {
					label, ok := raw.(string)
					if !ok || !bhas(allowed, label) {
						return trace, fmt.Errorf("invalid diagnostic label")
					}
				}
			}
		}
		if p.readIO && behaviorKeys(bm(state["io"])) != "aborted,budgets,sourceErrors" {
			return trace, fmt.Errorf("missing read observations")
		}
		if p.readIO {
			io := bm(state["io"])
			for _, field := range []string{"budgets", "aborted", "sourceErrors"} {
				values, ok := io[field].([]any)
				if !ok {
					return trace, fmt.Errorf("missing read observation list")
				}
				for _, raw := range values {
					n, ok := raw.(float64)
					if !ok || n < 0 || n != float64(int64(n)) || field == "budgets" && n <= 0 {
						return trace, fmt.Errorf("invalid read observation")
					}
				}
			}
			if len(ba(expected["calls"])) != len(ba(io["sourceErrors"])) {
				return trace, fmt.Errorf("missing source error identities")
			}
			seen := map[int64]bool{}
			for _, raw := range ba(io["aborted"]) {
				index := bn(raw)
				if index >= int64(len(ba(io["budgets"]))) || seen[index] {
					return trace, fmt.Errorf("invalid/duplicate read abort")
				}
				seen[index] = true
			}
		}
		if p.compressionIO {
			values, ok := state["compression"].([]any)
			if !ok {
				return trace, fmt.Errorf("missing compression observations")
			}
			for _, value := range values {
				if value != "decompressed" && value != "fallback_raw" {
					return trace, fmt.Errorf("invalid compression outcome")
				}
			}
		}
		if p.markerIO {
			markers, ok := state["markers"].([]any)
			if !ok {
				return trace, fmt.Errorf("missing marker observations")
			}
			for _, raw := range markers {
				marker := bm(raw)
				if behaviorKeys(marker) != "cutoffMs,ttlMs" {
					return trace, fmt.Errorf("invalid marker observation")
				}
				for _, field := range []string{"cutoffMs", "ttlMs"} {
					n, ok := marker[field].(float64)
					if !ok || float64(int64(n)) != n {
						return trace, fmt.Errorf("invalid marker number")
					}
				}
			}
		}
		if p.policyErrorIO {
			errors, ok := state["policyErrors"].([]any)
			if !ok {
				return trace, fmt.Errorf("missing policy errors")
			}
			for _, raw := range errors {
				item := bm(raw)
				if behaviorKeys(item) != "errorType,layer" || item["layer"] != "noop" || item["errorType"] != "config_resolution" {
					return trace, fmt.Errorf("invalid policy error")
				}
			}
		}
		trace.steps = append(trace.steps, behaviorStep{action: action, choice: choice, state: state, expected: expected})
	}
	return trace, nil
}
func featureValueCode(value any) int64 {
	if value == nil {
		return 6
	}
	switch x := value.(type) {
	case float64:
		if x == 1 || x == 2 {
			return int64(x)
		}
		if x == 0 {
			return 8
		}
	case bool:
		if !x {
			return 7
		}
	case string:
		if x == "" {
			return 9
		}
		if x == "undefined" {
			return 11
		}
	case map[string]any:
		if x["absent"] == true {
			return 5
		}
	}
	return 10
}
func featureObservation(p behaviorProfile, actual obj) (obj, error) {
	if p.policyErrorIO {
		events, ok := actual["events"].([]any)
		if !ok {
			return nil, fmt.Errorf("missing actual policy diagnostics")
		}
		errors := []any{}
		for _, raw := range events {
			event := bm(raw)
			if event["event"] != "error" || event["layer"] != "noop" || event["error"] != "config_resolution" {
				continue
			}
			if event["cacheNamespace"] != "urn" || event["useCase"] != "Behavior" || event["keyType"] != "id" || event["inFallback"] != false {
				return nil, fmt.Errorf("invalid actual policy diagnostic labels")
			}
			errors = append(errors, obj{"layer": "noop", "errorType": "config_resolution"})
		}
		base := bm(bclone(actual))
		delete(base, "events")
		p.policyErrorIO = false
		result, err := featureObservation(p, base)
		if err != nil {
			return nil, err
		}
		result["policyErrors"] = errors
		return result, nil
	}
	markers := []any{}
	compression := []any{}
	if p.markerIO || p.compressionIO {
		actual = bm(bclone(actual))
		events := []any{}
		for _, raw := range ba(actual["events"]) {
			event := bm(raw)
			if p.compressionIO && event["event"] == "compression" {
				if event["cacheNamespace"] != "urn" || event["useCase"] != "Behavior" || event["keyType"] != "id" || event["layer"] != "remote" {
					return nil, fmt.Errorf("invalid actual compression labels")
				}
				if event["outcome"] != "decompressed" && event["outcome"] != "fallback_raw" {
					return nil, fmt.Errorf("invalid actual compression outcome")
				}
				compression = append(compression, event["outcome"])
				continue
			}
			if !p.markerIO || event["event"] != "marker" {
				events = append(events, raw)
				continue
			}
			if _, ok := event["cutoffMs"]; !ok {
				return nil, fmt.Errorf("invalid actual marker observation")
			}
			if _, ok := event["ttlMs"]; !ok {
				return nil, fmt.Errorf("invalid actual marker observation")
			}
			markers = append(markers, obj{"cutoffMs": event["cutoffMs"], "ttlMs": event["ttlMs"]})
		}
		actual["events"] = events
		if !p.readIO && p.diagnosticAge == "" {
			delete(actual, "events")
		}
	}
	out := make(obj, len(actual))
	for k, v := range actual {
		out[k] = v
	}
	calls := []any{}
	for _, raw := range ba(actual["calls"]) {
		call := bm(raw)
		code := int64(0)
		switch call["status"] {
		case "value":
			code = featureValueCode(call["value"])
		case "error":
			code = 10
			if strings.HasPrefix(bs(call["error"]), "source:") {
				code = 3
			} else if strings.HasPrefix(bs(call["error"]), "timeout:") {
				code = 4
			}
		}
		calls = append(calls, code)
	}
	out["calls"] = calls
	result := obj{"o": out}
	if p.compressionIO {
		result["compression"] = compression
	}
	if p.markerIO {
		result["markers"] = markers
	}
	if p.readIO {
		delete(out, "events")
		io := obj{"budgets": []any{}, "aborted": []any{}, "sourceErrors": []any{}}
		for _, raw := range ba(actual["calls"]) {
			call := bm(raw)
			source := int64(0)
			if call["status"] == "error" && strings.HasPrefix(bs(call["error"]), "source:") {
				if _, err := fmt.Sscanf(bs(call["error"]), "source:%d", &source); err != nil {
					return nil, err
				}
				source++
			}
			io["sourceErrors"] = append(ba(io["sourceErrors"]), source)
		}
		for _, raw := range ba(actual["events"]) {
			event := bm(raw)
			switch event["event"] {
			case "readContext":
				if bn(event["index"]) != int64(len(ba(io["budgets"]))) || event["aborted"] != false {
					return nil, fmt.Errorf("invalid actual read context")
				}
				io["budgets"] = append(ba(io["budgets"]), event["timeoutMs"])
			case "readAbort":
				io["aborted"] = append(ba(io["aborted"]), event["index"])
			default:
				return nil, fmt.Errorf("unexpected read event")
			}
		}
		result["io"] = io
	} else if p.diagnosticAge != "" {
		delete(out, "events")
		diag := obj{"warnings": int64(0), "ages": []any{}, "coalesced": []any{}, "fallbackErrors": []any{}}
		if p.diagnosticFutureOffsets {
			diag["futureOffsets"] = []any{}
		}
		if p.diagnosticConfigErrors {
			diag["configErrors"] = int64(0)
		}
		outcomes := []any{}
		outcomeField := "recovery"
		if p.diagnosticAge == "shadowAge" {
			outcomeField = "shadow"
		}
		for _, outcome := range ba(actual[outcomeField]) {
			if outcome == "served" || p.diagnosticAge == "shadowAge" && (outcome == "match" || outcome == "mismatch") {
				outcomes = append(outcomes, outcome)
			}
		}
		for _, raw := range ba(actual["events"]) {
			event := bm(raw)
			kind := bs(event["event"])
			if p.diagnosticConfigErrors && kind == "error" && event["error"] == "config_resolution" {
				if event["cacheNamespace"] != "urn" || event["useCase"] != "Behavior" || event["keyType"] != "id" || event["layer"] != "remote" || event["inFallback"] != false {
					return nil, fmt.Errorf("invalid config diagnostic labels")
				}
				diag["configErrors"] = bn(diag["configErrors"]) + 1
				continue
			}
			if kind == "error" && event["error"] != "fallback" {
				continue
			}
			if event["cacheNamespace"] != "urn" || event["useCase"] != "Behavior" || event["keyType"] != "id" {
				return nil, fmt.Errorf("invalid diagnostic labels %s", bjson(event))
			}
			switch kind {
			case "futureOffset":
				seconds, ok := event["seconds"].(float64)
				offsetMs := seconds * 1000
				if !p.diagnosticFutureOffsets || event["layer"] != "remote_shadow" || !ok || offsetMs <= 0 || offsetMs > 9007199254740991 || math.Trunc(offsetMs) != offsetMs {
					return nil, fmt.Errorf("invalid actual future offset")
				}
				diag["futureOffsets"] = append(ba(diag["futureOffsets"]), obj{"layer": "remote_shadow", "offsetMs": offsetMs})
			case "coalesced":
				diag["coalesced"] = append(ba(diag["coalesced"]), event["scope"])
			case "error":
				if event["inFallback"] != true {
					return nil, fmt.Errorf("invalid source error attribution")
				}
				diag["fallbackErrors"] = append(ba(diag["fallbackErrors"]), event["layer"])
			case "mismatchWarning":
				if event["outcome"] != "mismatch" {
					return nil, fmt.Errorf("invalid mismatch warning")
				}
				diag["warnings"] = bn(diag["warnings"]) + 1
			default:
				if kind != p.diagnosticAge {
					return nil, fmt.Errorf("unexpected diagnostic %s", kind)
				}
				index := len(ba(diag["ages"]))
				if index >= len(outcomes) || event["outcome"] != outcomes[index] {
					return nil, fmt.Errorf("diagnostic age has incorrect outcome attribution")
				}
				if _, ok := event["seconds"].(float64); !ok {
					return nil, fmt.Errorf("missing actual diagnostic age")
				}
				diag["ages"] = append(ba(diag["ages"]), event["seconds"])
			}
		}
		result["d"] = diag
	}
	return result, nil
}
func featureExpected(p behaviorProfile, step behaviorStep) obj {
	out := obj{"o": step.expected}
	if p.policyErrorIO {
		out["policyErrors"] = step.state["policyErrors"]
	}
	if p.compressionIO {
		out["compression"] = step.state["compression"]
	}
	if p.markerIO {
		out["markers"] = step.state["markers"]
	}
	if p.diagnosticAge != "" {
		diag := bm(bclone(step.state["d"]))
		ages := []any{}
		for _, age := range ba(diag["ages"]) {
			ages = append(ages, bf(age)/1000)
		}
		diag["ages"] = ages
		out["d"] = diag
	}
	if p.readIO {
		out["io"] = step.state["io"]
	}
	return out
}
func replayFeature(d *behaviorDriver, p behaviorProfile, trace behaviorTrace) error {
	for _, input := range p.setup {
		if err := d.apply(input); err != nil {
			return err
		}
	}
	for index, step := range trace.steps {
		if step.action != "init" {
			if err := d.apply(p.actions[step.action].input(step.choice, d)); err != nil {
				return fmt.Errorf("%s step %d action %s choice %d: %w", trace.path, index, step.action, step.choice, err)
			}
		}
		actual, err := featureObservation(p, d.observation())
		if err != nil {
			return err
		}
		expected := featureExpected(p, step)
		if !bequal(expected, actual) {
			return fmt.Errorf("%s step %d action %s choice %d\nexpected: %s\nactual:   %s\nreplay: DIALCACHE_FEATURE_TRACE_FILE=%s go test -run TestFeatureConformance", trace.path, index, step.action, step.choice, bjson(expected), bjson(actual), trace.path)
		}
	}
	return nil
}
func featurePaths(p string) ([]string, error) {
	if file := os.Getenv("DIALCACHE_FEATURE_TRACE_FILE"); file != "" {
		if filepath.Base(filepath.Dir(file)) == p || strings.Contains(filepath.Base(file), p+"-smoke") {
			return []string{file}, nil
		}
		return nil, nil
	}
	if dir := os.Getenv("DIALCACHE_FEATURE_TRACE_DIR"); dir != "" {
		paths, err := filepath.Glob(filepath.Join(dir, p, "*.itf.json"))
		if err != nil {
			return nil, err
		}
		if len(paths) == 0 {
			return nil, fmt.Errorf("empty feature corpus %s", p)
		}
		regressions, err := featureRegressionPaths(p, dir)
		if err != nil {
			return nil, err
		}
		paths = append(paths, regressions...)
		return paths, nil
	}
	return []string{filepath.Join("..", "formal", p+"-smoke.itf.json")}, nil
}

func featureRegressionPaths(profile, directory string) ([]string, error) {
	raw, err := os.ReadFile("../formal/execution.json")
	if err != nil {
		return nil, err
	}
	var manifest struct {
		Models []struct {
			Profile     string   `json:"profile"`
			Regressions []string `json:"replayRegressions"`
		} `json:"models"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return nil, err
	}
	paths := []string{}
	for _, model := range manifest.Models {
		if model.Profile != profile {
			continue
		}
		for _, name := range model.Regressions {
			path := filepath.Join(directory, "..", "regressions", profile, name+".itf.json")
			if _, err := os.Stat(path); err != nil {
				return nil, fmt.Errorf("missing Quint regression %s: %w", name, err)
			}
			paths = append(paths, path)
		}
	}
	return paths, nil
}
func TestFeatureConformance(t *testing.T) {
	requireRegistry(t)
	profiles := behaviorProfiles()
	selected := os.Getenv("DIALCACHE_FEATURE_PROFILE")
	if selected != "" {
		if _, ok := profiles[selected]; !ok {
			t.Fatalf("unknown selected feature profile: %s", selected)
		}
	}
	count := 0
	executedProfiles := map[string]bool{}
	for _, name := range []string{"scope", "policy", "layers", "recovery", "independent", "shadow", "admission", "recovery-read", "local-failure", "runtime-boundaries", "shadow-layers", "source-budgets"} {
		if selected != "" && selected != name {
			continue
		}
		p := profiles[name]
		paths, err := featurePaths(name)
		if err != nil {
			t.Fatal(err)
		}
		if len(paths) > 0 {
			requireBehaviorProfile(t, name)
		}
		actions := map[string]bool{}
		for _, path := range paths {
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			trace, err := parseBehaviorTrace(raw, path, p)
			if err != nil {
				t.Fatal(err)
			}
			for _, step := range trace.steps {
				actions[step.action] = true
			}
			t.Run(name+"/"+filepath.Base(path), func(t *testing.T) {
				count++
				executedProfiles[name] = true
				synctest.Test(t, func(t *testing.T) {
					d := newBehaviorDriver(t, p.fixture(trace.steps[0].choice))
					defer d.close()
					if err := replayFeature(d, p, trace); err != nil {
						t.Error(err)
					}
				})
			})
		}
		if os.Getenv("DIALCACHE_FEATURE_TRACE_DIR") != "" && os.Getenv("DIALCACHE_FEATURE_TRACE_FILE") == "" {
			for action := range p.actions {
				if !actions[action] {
					t.Errorf("%s corpus omits action %s", name, action)
				}
			}
		}
	}
	if count == 0 {
		t.Fatal("no feature traces selected")
	}
	t.Logf("specification=0.1.0 featureProfiles=%d replayed=%d", len(executedProfiles), count)
}
func TestFeatureParserRejectsMissingAndUnsafeInputs(t *testing.T) {
	p := behaviorProfiles()["scope"]
	raw, err := os.ReadFile("../formal/scope-smoke.itf.json")
	if err != nil {
		t.Fatal(err)
	}
	for _, mutation := range []string{"choice", "observation", "diagnostics", "unsafe"} {
		t.Run(mutation, func(t *testing.T) {
			decoded, _ := behaviorJSON(raw)
			states := ba(bm(decoded)["states"])
			state := bm(states[1])
			switch mutation {
			case "choice":
				state["input"] = obj{}
			case "observation":
				delete(bm(bm(state["s"])["o"]), "calls")
			case "diagnostics":
				delete(bm(state["s"]), "d")
			case "unsafe":
				bm(bm(state["s"])["o"])["loaders"] = obj{"#bigint": "9007199254740993"}
			}
			if _, err := parseBehaviorTrace([]byte(bjson(decoded)), "negative", p); err == nil {
				t.Fatal("corrupt trace accepted")
			}
		})
	}
}
