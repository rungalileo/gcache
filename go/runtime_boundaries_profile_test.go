package dialcache

// The numerator constants are independently published fixture inputs. Neither
// binding asks the production cohort hash to construct its boundary inputs.
func runtimeBoundariesProfile() behaviorProfile {
	return behaviorProfile{
		name: "runtime-boundaries", explicitInputs: true, initChoices: []int64{0, 1, 2, 3, 4, 5, 6, 7, 8, 9},
		fixture: func(fixture int64) obj {
			if fixture == 9 {
				return obj{"policy": obj{"requestLocal": true, "ttlSec": obj{"local": 60, "remote": 60}, "staleOnErrorMaxAgeSec": 120, "shadow": obj{"ramp": 100}}, "remote": true, "fallbackTimeoutMs": nil}
			}
			if fixture >= 6 {
				policy := obj{}
				if fixture == 8 {
					policy = obj{"requestLocal": false, "ramp": obj{"local": 0, "remote": 0}, "staleOnErrorMaxAgeSec": 0, "shadow": obj{"ramp": 0}}
				}
				return obj{"policy": policy, "remote": fixture == 7, "fallbackTimeoutMs": nil}
			}
			layer := fixture % 3
			policy := obj{}
			if fixture < 3 {
				policy["coalesce"] = false
			}
			if layer == 0 {
				policy["requestLocal"] = true
			} else if layer == 1 {
				policy["ttlSec"] = obj{"local": 60}
			} else {
				policy["ttlSec"] = obj{"remote": 60}
			}
			return obj{"policy": policy, "remote": layer == 2, "fallbackTimeoutMs": nil}
		},
		setup: []obj{{"op": "openScope", "id": "0"}, {"op": "faults", "value": obj{"holdPolicies": true}}},
		actions: map[string]behaviorAction{
			"beginCall":     fixedAction(obj{"op": "begin", "scope": "0"}),
			"releasePolicy": releaseAction("policy"),
			"closeScope":    fixedAction(obj{"op": "closeScope", "id": "0"}),
			"policy": chosenAction(brange(0, 21), func(choice int64) obj {
				if choice == 21 {
					return obj{"op": "policy", "value": obj{"requestLocal": false, "ramp": obj{"local": 0, "remote": 0}, "staleOnErrorMaxAgeSec": 0, "shadow": obj{"ramp": 0}}}
				}
				if choice == 12 {
					return obj{"op": "policy", "value": nil}
				}
				if choice == 13 {
					return obj{"op": "policy", "value": obj{"requestLocal": false}}
				}
				if choice == 18 || choice == 19 {
					layer := "local"
					if choice == 19 {
						layer = "remote"
					}
					return obj{"op": "policy", "value": obj{"ttlSec": obj{layer: 60}}}
				}
				if choice == 20 {
					return obj{"op": "policy", "value": obj{"ttlSec": obj{"local": 60}, "ramp": obj{"local": 100}}}
				}
				if choice >= 14 {
					var value any = "invalid"
					if choice >= 16 {
						value = nil
					}
					field := "coalesce"
					if choice%2 == 1 {
						field = "requestLocal"
					}
					return obj{"op": "policy", "value": obj{field: value}}
				}
				policy := obj{}
				if choice%3 != 0 {
					policy["coalesce"] = choice%3 == 2
				}
				if relation := choice / 3; relation != 3 {
					policy["ramp"] = obj{
						"local": profileCohortRamp(4292886220, relation), "remote": profileCohortRamp(1018911151, relation),
					}
				}
				return obj{"op": "policy", "value": policy}
			}),
			"resolveLoader": chosenAction(brange(0, 63), func(choice int64) obj {
				values := []any{1, 2, Absent, "undefined", nil, false, 0, ""}
				input := obj{"op": "resolve", "loader": choice / 8}
				if value := values[choice%8]; !IsAbsent(value) {
					input["value"] = value
				}
				return input
			}),
		},
	}
}
