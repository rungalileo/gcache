package dialcache

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
)

const MaxDeadlineMS = int64(2147483647)
const DefaultRemoteReadTimeoutMS = int64(50)

// Policy is an operation's captured static policy. Zero TTL means omitted;
// positive TTLs are whole seconds expressed in milliseconds. Pointers preserve
// omitted versus explicit zero/false optional settings across runtime overlays.
type Policy struct {
	RequestLocal         bool
	LocalTTLMS           int64
	RemoteTTLMS          int64
	DisableCoalescing    bool
	LocalRamp            *float64
	RemoteRamp           *float64
	StaleOnErrorMaxAgeMS *int64
	RemoteReadTimeoutMS  *int64
	Shadow               *ShadowPolicy
}
type ShadowPolicy struct {
	Ramp          *float64
	LogMismatches *bool
}
type PolicyDefaults struct{ RemoteReadTimeoutMS int64 }
type ResolvedLayer struct {
	Enabled    bool
	Reason     string
	Configured bool // valid TTL and ramp remain available when ramp excludes the key
	TTLMS      int64
	Ramp       float64
}
type ResolvedShadow struct {
	Enabled            bool // cohort selection only; admission still needs an eligible path and hook
	Ramp               float64
	LogMismatches      bool
	ConfigError        bool
	LoggingConfigError bool // record only if a job is admitted, as in TypeScript
}
type ResolvedPolicy struct {
	RequestLocal            bool
	Coalesce                bool
	Local                   ResolvedLayer
	Remote                  ResolvedLayer
	RemoteReadTimeoutMS     int64
	StaleOnErrorMaxAgeMS    int64
	StaleOnErrorConfigError bool
	Shadow                  ResolvedShadow
}

func policyNumber(value any) (float64, bool) {
	if number, ok := value.(json.Number); ok {
		n, err := number.Float64()
		return n, err == nil
	}
	if value == nil {
		return 0, false
	}
	v := reflect.ValueOf(value)
	switch v.Kind() {
	case reflect.Float32, reflect.Float64:
		return v.Float(), true
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return float64(v.Int()), true
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return float64(v.Uint()), true
	}
	return 0, false
}
func finiteRange(value any, min, max float64, integer bool) (float64, bool) {
	n, ok := policyNumber(value)
	return n, ok && !math.IsNaN(n) && !math.IsInf(n, 0) && n >= min && n <= max && (!integer || math.Trunc(n) == n)
}
func policyTTLMS(value any) (int64, bool) {
	n, ok := finiteRange(value, 1, float64(MaxSupportedDurationMS/1000), true)
	if !ok {
		return 0, false
	}
	return int64(n) * 1000, true
}
func optionalLeaf(config map[string]any, name string) (any, bool) {
	v, present := config[name]
	return v, present && !IsAbsent(v)
}
func policyMap(value any, name string) (map[string]any, error) {
	m, ok := value.(map[string]any)
	if !ok || m == nil {
		return nil, fmt.Errorf("DialCache %s must be an object", name)
	}
	return m, nil
}

// ParsePolicy accepts the static JSON-shaped TypeScript configuration. Explicit
// null leaves remain invalid; nil/Absent for the whole configuration means none.
func ParsePolicy(config any) (Policy, error) {
	p := Policy{}
	if config == nil || IsAbsent(config) {
		return p, nil
	}
	m, err := policyMap(config, "defaultConfig")
	if err != nil {
		return p, err
	}
	if _, present := m["shadowRamp"]; present {
		return p, errors.New("shadowRamp was replaced by shadow.ramp")
	}
	for _, kind := range []string{"ttlSec", "ramp"} {
		value, present := optionalLeaf(m, kind)
		if !present {
			continue
		}
		layers, err := policyMap(value, kind)
		if err != nil {
			return p, err
		}
		for _, layer := range []string{"local", "remote"} {
			v, present := optionalLeaf(layers, layer)
			if !present {
				continue
			}
			if kind == "ttlSec" {
				ttl, ok := policyTTLMS(v)
				if !ok {
					return p, fmt.Errorf("invalid static ttlSec.%s", layer)
				}
				if layer == "local" {
					p.LocalTTLMS = ttl
				} else {
					p.RemoteTTLMS = ttl
				}
			} else {
				ramp, ok := finiteRange(v, 0, 100, false)
				if !ok {
					return p, fmt.Errorf("invalid static ramp.%s", layer)
				}
				if layer == "local" {
					p.LocalRamp = &ramp
				} else {
					p.RemoteRamp = &ramp
				}
			}
		}
	}
	for _, field := range []string{"requestLocal", "coalesce"} {
		v, present := optionalLeaf(m, field)
		if !present {
			continue
		}
		flag, ok := v.(bool)
		if !ok {
			return p, fmt.Errorf("%s must be boolean", field)
		}
		if field == "requestLocal" {
			p.RequestLocal = flag
		} else {
			p.DisableCoalescing = !flag
		}
	}
	if v, present := optionalLeaf(m, "staleOnErrorMaxAgeSec"); present {
		n, ok := finiteRange(v, 0, float64(MaxSupportedDurationMS/1000), true)
		if !ok {
			return p, errors.New("invalid static staleOnErrorMaxAgeSec")
		}
		ms := int64(n) * 1000
		p.StaleOnErrorMaxAgeMS = &ms
	}
	if v, present := optionalLeaf(m, "remoteReadTimeoutMs"); present {
		n, ok := finiteRange(v, 1, float64(MaxDeadlineMS), true)
		if !ok {
			return p, errors.New("invalid remoteReadTimeoutMs")
		}
		ms := int64(n)
		p.RemoteReadTimeoutMS = &ms
	}
	if v, present := optionalLeaf(m, "shadow"); present {
		shadow, err := policyMap(v, "shadow")
		if err != nil {
			return p, err
		}
		p.Shadow = &ShadowPolicy{}
		if v, present := optionalLeaf(shadow, "ramp"); present {
			ramp, ok := finiteRange(v, 0, 100, false)
			if !ok {
				return p, errors.New("invalid static shadow.ramp")
			}
			p.Shadow.Ramp = &ramp
		}
		if v, present := optionalLeaf(shadow, "logMismatches"); present {
			flag, ok := v.(bool)
			if !ok {
				return p, errors.New("shadow.logMismatches must be boolean")
			}
			p.Shadow.LogMismatches = &flag
		}
	}
	return p, ValidatePolicy(p)
}

func ValidatePolicy(p Policy) error {
	for _, ttl := range []int64{p.LocalTTLMS, p.RemoteTTLMS} {
		if ttl < 0 || ttl > MaxSupportedDurationMS || ttl%1000 != 0 {
			return errors.New("static TTL must be whole seconds within 365 days")
		}
	}
	for _, ramp := range []*float64{p.LocalRamp, p.RemoteRamp} {
		if ramp != nil {
			if _, ok := finiteRange(*ramp, 0, 100, false); !ok {
				return errors.New("static ramp must be between zero and 100")
			}
		}
	}
	if p.StaleOnErrorMaxAgeMS != nil {
		age := *p.StaleOnErrorMaxAgeMS
		if age < 0 || age > MaxSupportedDurationMS || age%1000 != 0 || (age > 0 && (p.RemoteTTLMS == 0 || age <= p.RemoteTTLMS)) {
			return errors.New("static recovery age must exceed a positive remote TTL")
		}
	}
	if p.RemoteReadTimeoutMS != nil && (*p.RemoteReadTimeoutMS <= 0 || *p.RemoteReadTimeoutMS > MaxDeadlineMS) {
		return errors.New("invalid remote read deadline")
	}
	if p.Shadow != nil && p.Shadow.Ramp != nil {
		if _, ok := finiteRange(*p.Shadow.Ramp, 0, 100, false); !ok {
			return errors.New("static shadow ramp must be between zero and 100")
		}
	}
	return nil
}

// SnapshotPolicy detaches every optional leaf from mutable caller-owned memory.
func SnapshotPolicy(p Policy) Policy {
	cloneFloat := func(v *float64) *float64 {
		if v == nil {
			return nil
		}
		copy := *v
		return &copy
	}
	cloneInt := func(v *int64) *int64 {
		if v == nil {
			return nil
		}
		copy := *v
		return &copy
	}
	p.LocalRamp, p.RemoteRamp = cloneFloat(p.LocalRamp), cloneFloat(p.RemoteRamp)
	p.StaleOnErrorMaxAgeMS, p.RemoteReadTimeoutMS = cloneInt(p.StaleOnErrorMaxAgeMS), cloneInt(p.RemoteReadTimeoutMS)
	if p.Shadow != nil {
		copy := *p.Shadow
		copy.Ramp = cloneFloat(copy.Ramp)
		if copy.LogMismatches != nil {
			flag := *copy.LogMismatches
			copy.LogMismatches = &flag
		}
		p.Shadow = &copy
	}
	return p
}

func staticPolicyMap(p Policy) map[string]any {
	ttl, ramp := map[string]any{}, map[string]any{}
	if p.LocalTTLMS > 0 {
		ttl["local"] = p.LocalTTLMS / 1000
	}
	if p.RemoteTTLMS > 0 {
		ttl["remote"] = p.RemoteTTLMS / 1000
	}
	if p.LocalRamp != nil {
		ramp["local"] = *p.LocalRamp
	}
	if p.RemoteRamp != nil {
		ramp["remote"] = *p.RemoteRamp
	}
	m := map[string]any{"ttlSec": ttl, "ramp": ramp, "requestLocal": p.RequestLocal, "coalesce": !p.DisableCoalescing}
	if p.StaleOnErrorMaxAgeMS != nil {
		m["staleOnErrorMaxAgeSec"] = *p.StaleOnErrorMaxAgeMS / 1000
	}
	if p.RemoteReadTimeoutMS != nil {
		m["remoteReadTimeoutMs"] = *p.RemoteReadTimeoutMS
	}
	if p.Shadow != nil {
		shadow := map[string]any{}
		if p.Shadow.Ramp != nil {
			shadow["ramp"] = *p.Shadow.Ramp
		}
		if p.Shadow.LogMismatches != nil {
			shadow["logMismatches"] = *p.Shadow.LogMismatches
		}
		m["shadow"] = shadow
	}
	return m
}

// ResolvePolicy merges sparse leaves once. A malformed container, boolean or
// read deadline is an invocation-wide error; TTL/ramp errors disable only that
// layer, while an invalid recovery option preserves valid remote serving.
func ResolvePolicy(base Policy, overlay any, identity Identity, defaults PolicyDefaults) (ResolvedPolicy, error) {
	resolved := ResolvedPolicy{Coalesce: true, RemoteReadTimeoutMS: defaults.RemoteReadTimeoutMS}
	if resolved.RemoteReadTimeoutMS == 0 {
		resolved.RemoteReadTimeoutMS = DefaultRemoteReadTimeoutMS
	}
	if resolved.RemoteReadTimeoutMS <= 0 || resolved.RemoteReadTimeoutMS > MaxDeadlineMS {
		return resolved, errors.New("invalid instance read deadline")
	}
	if err := ValidatePolicy(base); err != nil {
		return resolved, err
	}
	merged := staticPolicyMap(base)
	if overlay != nil && !IsAbsent(overlay) {
		m, err := policyMap(overlay, "runtime config")
		if err != nil {
			return resolved, err
		}
		if _, present := m["shadowRamp"]; present {
			return resolved, errors.New("shadowRamp was replaced by shadow.ramp")
		}
		for _, name := range []string{"ttlSec", "ramp", "shadow"} {
			v, present := optionalLeaf(m, name)
			if !present {
				continue
			}
			incoming, err := policyMap(v, name)
			if err != nil {
				return resolved, err
			}
			output, _ := merged[name].(map[string]any)
			if output == nil {
				output = map[string]any{}
			}
			leaves := []string{"local", "remote"}
			if name == "shadow" {
				leaves = []string{"ramp", "logMismatches"}
			}
			for _, leaf := range leaves {
				if v, present := optionalLeaf(incoming, leaf); present {
					output[leaf] = v
				}
			}
			merged[name] = output
		}
		for _, name := range []string{"requestLocal", "coalesce", "staleOnErrorMaxAgeSec", "remoteReadTimeoutMs"} {
			if v, present := optionalLeaf(m, name); present {
				merged[name] = v
			}
		}
	}
	var ok bool
	resolved.RequestLocal, ok = merged["requestLocal"].(bool)
	if !ok {
		return resolved, errors.New("runtime requestLocal must be boolean")
	}
	resolved.Coalesce, ok = merged["coalesce"].(bool)
	if !ok {
		return resolved, errors.New("runtime coalesce must be boolean")
	}
	if v, present := optionalLeaf(merged, "remoteReadTimeoutMs"); present {
		n, ok := finiteRange(v, 1, float64(MaxDeadlineMS), true)
		if !ok {
			return resolved, errors.New("invalid runtime remoteReadTimeoutMs")
		}
		resolved.RemoteReadTimeoutMS = int64(n)
	}
	logical, _, _, err := identity.Keys()
	if err != nil {
		return resolved, err
	}
	ttls, ramps := merged["ttlSec"].(map[string]any), merged["ramp"].(map[string]any)
	resolveLayer := func(layer string) ResolvedLayer {
		result := ResolvedLayer{Reason: "policy_disabled"}
		v, present := optionalLeaf(ttls, layer)
		if !present {
			return result
		}
		ttl, valid := policyTTLMS(v)
		if !valid {
			result.Reason = "invalid_ttl"
			return result
		}
		ramp := float64(100)
		if v, present := optionalLeaf(ramps, layer); present {
			ramp, valid = finiteRange(v, 0, 100, false)
			if !valid {
				result.Reason = "invalid_ramp"
				return result
			}
		}
		result.Configured, result.TTLMS, result.Ramp = true, ttl, ramp
		result.Enabled = ramp >= 100 || (ramp > 0 && Cohort(logical, layer) < ramp)
		if result.Enabled {
			result.Reason = ""
		} else {
			result.Reason = "ramped_down"
		}
		return result
	}
	resolved.Local, resolved.Remote = resolveLayer("local"), resolveLayer("remote")
	if age, present := optionalLeaf(merged, "staleOnErrorMaxAgeSec"); present {
		n, numeric := policyNumber(age)
		if !resolved.Remote.Configured {
			resolved.StaleOnErrorConfigError = resolved.Remote.Reason == "policy_disabled" && !(numeric && n == 0)
		} else if !(numeric && n == 0) {
			ms, valid := policyTTLMS(age)
			if !valid || ms <= resolved.Remote.TTLMS {
				resolved.StaleOnErrorConfigError = true
			} else {
				resolved.StaleOnErrorMaxAgeMS = ms
			}
		}
	}
	if shadow, present := merged["shadow"].(map[string]any); present {
		if v, present := optionalLeaf(shadow, "ramp"); present {
			ramp, valid := finiteRange(v, 0, 100, false)
			if !valid {
				resolved.Shadow.ConfigError = true
			} else {
				resolved.Shadow.Ramp = ramp
				resolved.Shadow.Enabled = ramp >= 100 || (ramp > 0 && Cohort(logical, "shadow") < ramp)
			}
		}
		if v, present := optionalLeaf(shadow, "logMismatches"); present {
			flag, valid := v.(bool)
			resolved.Shadow.LogMismatches = flag
			resolved.Shadow.LoggingConfigError = !valid
		}
	}
	return resolved, nil
}
