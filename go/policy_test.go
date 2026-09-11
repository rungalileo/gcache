package dialcache

import (
	"math"
	"testing"
)

func policyTestPtr[T any](value T) *T { return &value }
func policyTestIdentity() Identity {
	return Identity{Namespace: "policy", KeyType: "item", ID: "one", UseCase: "lookup"}
}

func TestPolicySparseResolutionAndSnapshots(t *testing.T) {
	base, err := ParsePolicy(map[string]any{
		"requestLocal": true, "coalesce": false,
		"ttlSec":                map[string]any{"local": 1.0, "remote": 2.0},
		"staleOnErrorMaxAgeSec": 5.0, "remoteReadTimeoutMs": 30.0,
		"shadow": map[string]any{"ramp": 100.0, "logMismatches": true},
	})
	if err != nil {
		t.Fatal(err)
	}
	resolved, err := ResolvePolicy(base, map[string]any{
		"ttlSec": map[string]any{"remote": 4.0},
		"ramp":   map[string]any{"local": 0.0},
		"shadow": map[string]any{"logMismatches": false},
	}, policyTestIdentity(), PolicyDefaults{RemoteReadTimeoutMS: 20})
	if err != nil {
		t.Fatal(err)
	}
	if !resolved.RequestLocal || resolved.Coalesce || resolved.Local.Enabled || resolved.Local.Reason != "ramped_down" || !resolved.Local.Configured || resolved.Local.TTLMS != 1000 || !resolved.Remote.Enabled || resolved.Remote.TTLMS != 4000 || resolved.StaleOnErrorMaxAgeMS != 5000 || resolved.RemoteReadTimeoutMS != 30 || !resolved.Shadow.Enabled || resolved.Shadow.LogMismatches {
		t.Fatalf("wrong sparse policy: %+v", resolved)
	}
	copy := SnapshotPolicy(base)
	*base.RemoteReadTimeoutMS = 99
	*base.Shadow.Ramp = 0
	if *copy.RemoteReadTimeoutMS != 30 || *copy.Shadow.Ramp != 100 {
		t.Fatal("static snapshot retained mutable leaves")
	}
	inherit, err := ResolvePolicy(copy, nil, policyTestIdentity(), PolicyDefaults{})
	if err != nil || !inherit.Local.Enabled || inherit.RemoteReadTimeoutMS != 30 {
		t.Fatalf("null provider failed inheritance: %+v %v", inherit, err)
	}
}

func TestPolicyStaticValidation(t *testing.T) {
	for _, config := range []any{
		true, []any{}, map[string]any{"shadowRamp": 1}, map[string]any{"ttlSec": nil},
		map[string]any{"requestLocal": nil}, map[string]any{"coalesce": "false"},
		map[string]any{"ttlSec": map[string]any{"local": 0}},
		map[string]any{"ttlSec": map[string]any{"local": 1.5}},
		map[string]any{"ttlSec": map[string]any{"remote": 31536001}},
		map[string]any{"ramp": map[string]any{"remote": math.NaN()}},
		map[string]any{"remoteReadTimeoutMs": 0}, map[string]any{"remoteReadTimeoutMs": 2147483648},
		map[string]any{"staleOnErrorMaxAgeSec": 2},
		map[string]any{"ttlSec": map[string]any{"remote": 2}, "staleOnErrorMaxAgeSec": 2},
		map[string]any{"shadow": map[string]any{"logMismatches": 1}},
	} {
		if _, err := ParsePolicy(config); err == nil {
			t.Fatalf("accepted invalid static config: %#v", config)
		}
	}
	if _, err := ParsePolicy(map[string]any{"ttlSec": map[string]any{"remote": 31536000}, "remoteReadTimeoutMs": 2147483647}); err != nil {
		t.Fatal(err)
	}
	if err := ValidatePolicy(Policy{LocalTTLMS: 1500}); err == nil {
		t.Fatal("accepted fractional second TTL")
	}
}

func TestRuntimePolicyFailureScopes(t *testing.T) {
	base := Policy{RequestLocal: true, LocalTTLMS: 1000, RemoteTTLMS: 2000}
	for _, overlay := range []any{false, []any{}, map[string]any{"ttlSec": nil}, map[string]any{"shadow": nil}, map[string]any{"requestLocal": nil}, map[string]any{"coalesce": 1}, map[string]any{"remoteReadTimeoutMs": 0}} {
		if _, err := ResolvePolicy(base, overlay, policyTestIdentity(), PolicyDefaults{}); err == nil {
			t.Fatalf("accepted invalid invocation policy: %#v", overlay)
		}
	}
	for _, test := range []struct {
		overlay       map[string]any
		local, remote string
		recoveryError bool
	}{
		{map[string]any{"ttlSec": map[string]any{"local": nil}}, "invalid_ttl", "", false},
		{map[string]any{"ramp": map[string]any{"remote": true}}, "", "invalid_ramp", false},
		{map[string]any{"staleOnErrorMaxAgeSec": nil}, "", "", true},
		{map[string]any{"staleOnErrorMaxAgeSec": 1}, "", "", true},
		{map[string]any{"staleOnErrorMaxAgeSec": 0}, "", "", false},
		{map[string]any{"ttlSec": map[string]any{"remote": -1}, "staleOnErrorMaxAgeSec": -1}, "", "invalid_ttl", false},
	} {
		r, err := ResolvePolicy(base, test.overlay, policyTestIdentity(), PolicyDefaults{})
		if err != nil || !r.RequestLocal || !r.Coalesce || r.Local.Reason != test.local || r.Remote.Reason != test.remote || r.StaleOnErrorConfigError != test.recoveryError {
			t.Fatalf("wrong failure scope: %#v => %+v %v", test.overlay, r, err)
		}
	}
	missing, err := ResolvePolicy(Policy{}, map[string]any{"staleOnErrorMaxAgeSec": 3}, policyTestIdentity(), PolicyDefaults{})
	if err != nil || !missing.StaleOnErrorConfigError || missing.Remote.Reason != "policy_disabled" {
		t.Fatalf("missing remote TTL: %+v %v", missing, err)
	}
}

func TestRecoveryRetentionAndShadowDiagnosticsRemainIndependent(t *testing.T) {
	base := Policy{RemoteTTLMS: 1000, RemoteRamp: policyTestPtr(0.0), StaleOnErrorMaxAgeMS: policyTestPtr(int64(86400000))}
	r, err := ResolvePolicy(base, map[string]any{"shadow": map[string]any{"ramp": 100, "logMismatches": "invalid"}}, policyTestIdentity(), PolicyDefaults{})
	if err != nil || r.Remote.Enabled || !r.Remote.Configured || r.StaleOnErrorMaxAgeMS != 86400000 || !r.Shadow.Enabled || r.Shadow.ConfigError || !r.Shadow.LoggingConfigError || r.Shadow.LogMismatches {
		t.Fatalf("wrong independent options: %+v %v", r, err)
	}
	r, err = ResolvePolicy(base, map[string]any{"shadow": map[string]any{"ramp": nil}}, policyTestIdentity(), PolicyDefaults{})
	if err != nil || !r.Shadow.ConfigError || r.Shadow.Enabled || !r.Remote.Configured {
		t.Fatalf("invalid shadow replaced serving policy: %+v %v", r, err)
	}
}
