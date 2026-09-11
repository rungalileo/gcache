package dialcache

import "fmt"

func localFailureProfile() behaviorProfile {
	return behaviorProfile{
		name: "local-failure", explicitInputs: true,
		fixture: func(int64) obj {
			return obj{
				"policy":            obj{"requestLocal": true, "ttlSec": obj{"local": 60, "remote": 60}},
				"fallbackTimeoutMs": nil, "localFaultInjection": true,
			}
		},
		setup: []obj{{"op": "openScope", "id": "0"}, {"op": "openScope", "id": "1"}},
		actions: map[string]behaviorAction{
			"beginCall": chosenAction([]int64{0, 1, 2}, func(n int64) obj {
				input := obj{"op": "begin"}
				if n < 2 {
					input["scope"] = fmt.Sprint(n)
				}
				return input
			}),
			"resolveLoader": {choices: []int64{1, 2}, input: func(n int64, d *behaviorDriver) obj {
				return obj{"op": "resolve", "loader": d.observedEffectCount("loader") - 1, "value": n}
			}},
			"rejectLoader": {input: func(_ int64, d *behaviorDriver) obj {
				return obj{"op": "reject", "loader": d.observedEffectCount("loader") - 1}
			}},
			"localFault": chosenAction([]int64{0, 1}, func(n int64) obj { return obj{"op": "faults", "value": obj{"localStorage": n == 1}} }),
			"policy":     chosenAction([]int64{0, 1}, func(n int64) obj { return obj{"op": "policy", "value": obj{"ramp": obj{"remote": n * 100}}} }),
			"seed":       chosenAction([]int64{1, 2}, func(n int64) obj { return obj{"op": "seed", "value": n} }),
		},
	}
}
