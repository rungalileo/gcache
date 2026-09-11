package dialcache

import "strconv"

// This is the fixed W03 numerator for {urn:id:0}#ShadowLayers:shadow. The
// independent model chooses below/equal/above inputs without hashing expected
// state or using the implementation's cohort function as its oracle.
const shadowLayersSample uint64 = 3203834406

func shadowLayersPolicy(choice int64) obj {
	shadowRamp := any(100)
	if choice >= 9 && choice <= 11 {
		shadowRamp = profileCohortRamp(shadowLayersSample, choice-9)
	} else if choice == 7 {
		shadowRamp = 101
	} else if choice == 5 || choice == 6 || choice == 13 {
		shadowRamp = 0
	}
	localRamp, remoteRamp := 0, 0
	if choice == 0 || choice == 2 || choice == 7 || choice == 8 || choice == 12 {
		localRamp = 100
	}
	if choice == 4 || choice == 5 || choice == 12 || choice == 13 {
		remoteRamp = 100
	}
	fresh, retained := 60, 120
	if choice == 8 || choice == 13 {
		fresh, retained = 120, 180
	}
	return obj{"requestLocal": choice == 0 || choice == 1 || choice == 8 || choice == 12, "coalesce": false,
		"ttlSec": obj{"local": 60, "remote": fresh}, "ramp": obj{"local": localRamp, "remote": remoteRamp},
		"staleOnErrorMaxAgeSec": retained, "shadow": obj{"ramp": shadowRamp}}
}

func shadowLayersProfile() behaviorProfile {
	return behaviorProfile{
		name: "shadow-layers", explicitInputs: true,
		fixture: func(int64) obj {
			return obj{"policy": shadowLayersPolicy(0), "tracked": true, "fallbackTimeoutMs": nil,
				"readTimeoutMs": 120000, "shadowMaxInFlight": 2, "recovery": "allow", "probeSourceScope": true}
		},
		setup: []obj{{"op": "openScope", "id": "0", "instance": "0"},
			{"op": "openScope", "id": "1", "instance": "0"},
			{"op": "openScope", "id": "2", "instance": "1"},
			{"op": "faults", "value": obj{"holdDumps": true, "holdWrites": true}}},
		actions: map[string]behaviorAction{
			"beginCall": chosenAction(brange(0, 14), func(choice int64) obj {
				context := choice / 3
				input := obj{"op": "begin", "key": strconv.FormatInt(choice%3, 10), "useCase": "ShadowLayers"}
				if context < 3 {
					input["scope"] = strconv.FormatInt(context, 10)
				} else if context == 4 {
					input["instance"] = "1"
				} else {
					input["instance"] = "0"
				}
				return input
			}),
			"resolveLoader": sourcePairAction(24),
			"rejectLoader":  rejectSourceAction(24),
			"rejectTimeout": chosenAction(brange(0, 23), func(choice int64) obj {
				return obj{"op": "reject", "loader": choice, "error": "timeout"}
			}),
			"releaseDump": chosenAction(brange(0, 23), func(choice int64) obj {
				return obj{"op": "release", "effect": "dump", "index": choice}
			}),
			"releaseWrite": chosenAction(brange(0, 23), func(choice int64) obj {
				return obj{"op": "release", "effect": "write", "index": choice}
			}),
			"advance": advanceAction(1, 60000, 120000),
			"policy": chosenAction(brange(0, 13), func(choice int64) obj {
				return obj{"op": "policy", "value": shadowLayersPolicy(choice)}
			}),
			"seed": chosenAction(brange(0, 11), func(choice int64) obj {
				value, age := 1, 0
				if choice%4 == 1 {
					value = 2
				} else if choice%4 == 2 {
					age = 59999
				} else if choice%4 == 3 {
					age = 60000
				}
				return obj{"op": "seed", "key": strconv.FormatInt(choice/4, 10), "useCase": "ShadowLayers", "value": value, "ageMs": age, "ttlMs": 180000}
			}),
		},
	}
}
