package dialcache

func sourceBudgetsProfile() behaviorProfile {
	return behaviorProfile{
		name: "source-budgets", explicitInputs: true, initChoices: []int64{0, 1, 2},
		fixture: func(mode int64) obj {
			var budget any = 10
			if mode == 0 {
				budget = "default"
			} else if mode == 1 {
				budget = nil
			}
			return obj{"policy": obj{"ttlSec": obj{"local": 1}}, "tracked": true, "remote": false, "fallbackTimeoutMs": budget}
		},
		setup: []obj{{"op": "faults", "value": obj{"holdPolicies": true}}},
		actions: map[string]behaviorAction{
			"beginCall": chosenAction([]int64{0, 1, 2, 3}, func(n int64) obj {
				input := obj{"op": "begin"}
				if n == 1 || n == 3 {
					input["outside"] = true
				}
				if n >= 2 {
					input["key"] = "{invalid}"
				}
				return input
			}),
			"releasePolicy": chosenAction(brange(0, 7), func(n int64) obj { return obj{"op": "release", "effect": "policy", "index": n} }),
			"resolveLoader": sourcePairAction(8), "rejectLoader": rejectSourceAction(8),
			"advance": advanceAction(1, 3, 6, 9, 10, 100, 59999, 60001),
		},
	}
}
