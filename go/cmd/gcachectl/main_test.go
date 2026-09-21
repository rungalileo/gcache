package main

import "testing"

func TestIsFalseyFailsClosedOnAnUnrecognisedValue(t *testing.T) {
	// The point of this helper is the DEFAULT branch. GALILEO_REDIS_USE_ELASTICACHE_IAM
	// gates a refusal, so anything unrecognised must read as "requested" and refuse --
	// a typo like "ture" must not silently disable the check and connect unauthenticated.
	for _, off := range []string{"", "0", "f", "false", "FALSE", "n", "no", "off", "  false  "} {
		if !isFalsey(off) {
			t.Errorf("isFalsey(%q) = false, want true", off)
		}
	}
	for _, on := range []string{"1", "t", "true", "TRUE", "y", "yes", "on", "ture", "maybe", "0x0"} {
		if isFalsey(on) {
			t.Errorf("isFalsey(%q) = true, want false (must fail closed)", on)
		}
	}
}
