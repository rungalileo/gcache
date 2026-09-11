package dialcache

import (
	"encoding/binary"
	"encoding/hex"
	"fmt"
)

// This profile supplies only external bytes, clock observations and effect IDs.
// Expected model state never selects a value, policy, storage result or schedule.
func recoveryReadProfile() behaviorProfile {
	seedAges := []int64{0, 999, 1000, 4999, 5000, 3600001, 7200000, 0, 1000, 1000, 0, 0, 4999, 0, 0, 1000, 0, 0, 1000}
	return behaviorProfile{
		name: "recovery-read", explicitInputs: true, markerIO: true, compressionIO: true, readIO: true,
		initChoices: []int64{0, 1, 2},
		fixture: func(mode int64) obj {
			policy := obj{"requestLocal": true, "ttlSec": obj{"local": 1, "remote": 1}, "staleOnErrorMaxAgeSec": 5}
			if mode == 2 {
				policy["shadow"] = obj{"ramp": 100}
			}
			return obj{
				"policy":  policy,
				"tracked": mode != 0, "recovery": "allow", "fallbackTimeoutMs": nil,
				"readTimeoutMs": 30000000, "observe": []any{"readContext", "readAbort", "marker", "compression"},
			}
		},
		setup: []obj{{"op": "openScope", "id": "0"}, {"op": "openScope", "id": "1"},
			{"op": "faults", "value": obj{"holdReads": true, "holdLoads": true}}},
		actions: map[string]behaviorAction{
			"beginCall": chosenAction([]int64{0, 1, 2}, func(n int64) obj {
				input := obj{"op": "begin"}
				if n < 2 {
					input["scope"] = fmt.Sprint(n)
				}
				return input
			}),
			"releaseRead": releaseAction("read"), "releaseLoad": releaseAction("load"),
			"rejectLoader": {input: func(_ int64, d *behaviorDriver) obj {
				return obj{"op": "reject", "loader": d.observedEffectCount("loader") - 1}
			}},
			"resolveLoader": {input: func(_ int64, d *behaviorDriver) obj {
				return obj{"op": "resolve", "loader": d.observedEffectCount("loader") - 1, "value": 2}
			}},
			"seed": {choices: brange(0, 18), input: func(n int64, d *behaviorDriver) obj {
				ttl := int64(60000)
				if n == 11 || n == 15 {
					ttl = 1000
				}
				input := obj{"op": "seed", "ageMs": seedAges[n], "ttlMs": ttl}
				switch n {
				case 18:
					// Omitted value stores the portable absent-value payload.
				case 8, 12, 13:
					input["payloadHex"] = "0128b52ffd200109000031"
				case 9, 14:
					input["payloadHex"] = "016e6f742061207a737464206672616d65"
				case 16:
					input["frameHex"] = "0100200000000000010031"
				case 17:
					raw := []byte{2, 0, 0, 0, 0, 0, 0, 0, 0, 0, '1'}
					binary.BigEndian.PutUint64(raw[1:9], uint64(d.clock.WallMS()))
					input["frameHex"] = hex.EncodeToString(raw)
				case 10:
					raw := []byte{1, 0, 0, 0, 0, 0, 0, 0, 0, 255, '1'}
					binary.BigEndian.PutUint64(raw[1:9], uint64(d.clock.WallMS()))
					input["frameHex"] = hex.EncodeToString(raw)
				default:
					input["value"] = 1
					if n == 7 {
						input["value"] = 2
					}
				}
				return input
			}},
			"advance": advanceAction(1, 999, 1000, 4000, 60000, 3600000),
			"policy": chosenAction([]int64{0, 1, 2}, func(n int64) obj {
				fresh, maximum := 1, 5
				if n == 1 {
					maximum = 7200
				}
				if n == 2 {
					fresh, maximum = 7200, 14400
				}
				return obj{"op": "policy", "value": obj{"ttlSec": obj{"remote": fresh}, "staleOnErrorMaxAgeSec": maximum}}
			}),
			"closeScope":    chosenAction([]int64{0, 1}, func(n int64) obj { return obj{"op": "closeScope", "id": fmt.Sprint(n)} }),
			"invalidate":    fixedAction(obj{"op": "invalidate"}),
			"observeMarker": fixedAction(obj{"op": "observeMarker"}),
			"writeFault":    faultAction("write"),
		},
	}
}
