package dialcache

import (
	"reflect"
	"strconv"
	"unicode/utf8"
)

// MetricsAdapter consumes only the bounded public diagnostic events. Event.Key
// is never a metric label; exporting logical identities would add cardinality.
type MetricsAdapter interface{ ObserveEvent(Event) error }

// FailureIsolatedObserver adapts a fallible exporter to Options.Observe. Neither
// a returned error nor a panic may replace a source result or start cache work.
func FailureIsolatedObserver(observer func(Event) error) func(Event) {
	if observer == nil {
		return nil
	}
	return func(event Event) { defer func() { _ = recover() }(); _ = observer(event) }
}

type isolatedLogger struct{ inner Logger }

func (logger isolatedLogger) Debug(message string, details any) {
	defer func() { _ = recover() }()
	logger.inner.Debug(message, details)
}
func (logger isolatedLogger) Warn(message string, details any) {
	defer func() { _ = recover() }()
	logger.inner.Warn(message, details)
}
func (logger isolatedLogger) Error(message string, details any) {
	defer func() { _ = recover() }()
	logger.inner.Error(message, details)
}
func FailureIsolatedLogger(logger Logger) Logger {
	if logger == nil {
		return nil
	}
	return isolatedLogger{logger}
}

const ShadowLogKeyMaxBytes = 2048
const ShadowLogValueMaxBytes = 8192
const ShadowLogTruncationMarker = "...[truncated]"

func clampLogUTF8(value string, maximum int) string {
	value = string(replacementUTF8([]byte(value)))
	if len(value) <= maximum {
		return value
	}
	limit := maximum - len(ShadowLogTruncationMarker)
	for limit > 0 && !utf8.RuneStart(value[limit]) {
		limit--
	}
	return value[:limit] + ShadowLogTruncationMarker
}
func PreviewShadowLogKey(value string) string { return clampLogUTF8(value, ShadowLogKeyMaxBytes) }
func PreviewShadowLogJSON(value any) (preview *string) {
	defer func() {
		if recover() != nil {
			preview = nil
		}
	}()
	if IsAbsent(value) {
		return nil
	}
	encoded, err := appendJSON(nil, reflect.ValueOf(value), make(map[visit]bool))
	if err != nil {
		return nil
	}
	text := clampLogUTF8(string(encoded), ShadowLogValueMaxBytes)
	return &text
}

type ShadowMismatchDetails struct {
	CacheKey        string  `json:"cacheKey"`
	CachedValueJSON *string `json:"cachedValueJson"`
	SourceValueJSON *string `json:"sourceValueJson"`
}

func ShadowMismatchLogDetails(key string, cached, source any) ShadowMismatchDetails {
	return ShadowMismatchDetails{PreviewShadowLogKey(key), PreviewShadowLogJSON(cached), PreviewShadowLogJSON(source)}
}

var metricKinds = map[string]string{
	"shadowAge": "shadowValueAge", "recoveryAge": "staleRecoveryValueAge",
	"request": "request", "miss": "miss", "disabled": "disabled", "error": "error", "invalidation": "invalidation", "coalesced": "coalesced",
	"shadowValidation": "shadowValidation", "shadow": "shadowValidation", "shadowValueAge": "shadowValueAge", "observeShadowValueAge": "shadowValueAge",
	"futureTimestampOffset": "futureTimestampOffset", "observeFutureTimestampOffset": "futureTimestampOffset", "futureOffset": "futureTimestampOffset",
	"staleRecovery": "staleRecovery", "recovery": "staleRecovery", "staleRecoveryValueAge": "staleRecoveryValueAge", "observeStaleRecoveryValueAge": "staleRecoveryValueAge",
	"compression": "compression", "get": "get", "observeGet": "get", "fallback": "fallback", "observeFallback": "fallback",
	"serialization": "serialization", "observeSerialization": "serialization", "size": "size", "observeSize": "size", "storedSize": "storedSize", "observeStoredSize": "storedSize",
	"compressionRatio": "compressionRatio", "observeCompressionRatio": "compressionRatio", "compressionDuration": "compressionDuration", "observeCompression": "compressionDuration",
}

func eventString(event Event, key string) string { value, _ := event.Data[key].(string); return value }
func metricLabels(event Event, kind string) map[string]string {
	labels := map[string]string{"cache_namespace": eventString(event, "cacheNamespace"), "use_case": eventString(event, "useCase"), "key_type": eventString(event, "keyType")}
	layer := eventString(event, "layer")
	if layer == "" {
		layer = event.Scope
	}
	switch kind {
	case "invalidation":
		delete(labels, "use_case")
		labels["layer"] = layer
	case "coalesced":
		scope := eventString(event, "scope")
		if scope == "" {
			scope = event.Scope
		}
		labels["scope"] = scope
	case "shadowValidation", "shadowValueAge", "staleRecovery", "staleRecoveryValueAge":
		outcome := eventString(event, "outcome")
		if outcome == "" {
			outcome = event.Outcome
		}
		labels["outcome"] = outcome
	default:
		labels["layer"] = layer
	}
	switch kind {
	case "miss", "disabled":
		labels["reason"] = eventString(event, "reason")
	case "error":
		labels["error"] = eventString(event, "error")
		inFallback, _ := event.Data["inFallback"].(bool)
		labels["in_fallback"] = strconv.FormatBool(inFallback)
	case "compression":
		outcome := eventString(event, "outcome")
		if outcome == "" {
			outcome = event.Outcome
		}
		labels["outcome"] = outcome
	case "serialization", "compressionDuration":
		labels["operation"] = eventString(event, "operation")
	}
	return labels
}
func metricValue(event Event, kind string) float64 {
	if value, present := event.Data["value"]; present {
		if number, ok := policyNumber(value); ok {
			return number
		}
	}
	if kind == "size" || kind == "storedSize" {
		return float64(event.Bytes)
	}
	return event.Seconds
}
