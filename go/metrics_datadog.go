package dialcache

import (
	"errors"
	"reflect"
	"regexp"
)

// DogStatsDClient leaves transport, buffering, flushing and ownership with the
// caller. Both observation methods are required, matching the TypeScript adapter.
type DogStatsDClient interface {
	Increment(name string, value float64, tags map[string]string) error
	Histogram(name string, value float64, tags map[string]string) error
	Distribution(name string, value float64, tags map[string]string) error
}
type DatadogMetricsOptions struct {
	Client                DogStatsDClient
	ObservationMetricType string
	Namespace             string
	NamespaceSet          bool // distinguish an explicitly empty namespace from omission
}
type DatadogMetrics struct {
	client       DogStatsDClient
	names        map[string]string
	distribution bool
}

var datadogSuffixes = map[string]string{
	"request": "request.count", "miss": "miss.count", "disabled": "disabled.count", "error": "error.count", "invalidation": "invalidation.count", "coalesced": "coalesced.count",
	"shadowValidation": "shadow.count", "shadowValueAge": "shadow.value_age", "futureTimestampOffset": "future_timestamp_offset",
	"staleRecovery": "stale_recovery.count", "staleRecoveryValueAge": "stale_recovery.value_age", "compression": "compression.count",
	"get": "get.duration", "fallback": "fallback.duration", "serialization": "serialization.duration", "size": "serialization.size", "storedSize": "stored.size",
	"compressionRatio": "compression.ratio", "compressionDuration": "compression.duration",
}
var counterKinds = map[string]bool{"request": true, "miss": true, "disabled": true, "error": true, "invalidation": true, "coalesced": true, "shadowValidation": true, "staleRecovery": true, "compression": true}
var datadogNamespace = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$`)

func NewDatadogMetrics(options DatadogMetricsOptions) (*DatadogMetrics, error) {
	if options.Client == nil || (reflect.ValueOf(options.Client).Kind() == reflect.Pointer && reflect.ValueOf(options.Client).IsNil()) {
		return nil, errors.New("Datadog client is required")
	}
	if options.ObservationMetricType != "histogram" && options.ObservationMetricType != "distribution" {
		return nil, errors.New("Datadog observation type must be histogram or distribution")
	}
	namespace := options.Namespace
	if namespace == "" && !options.NamespaceSet {
		namespace = "dialcache"
	}
	if !datadogNamespace.MatchString(namespace) {
		return nil, errors.New("invalid Datadog namespace")
	}
	names := make(map[string]string, len(datadogSuffixes))
	for kind, suffix := range datadogSuffixes {
		name := namespace + "." + suffix
		if len(name) > 200 {
			return nil, errors.New("Datadog metric name exceeds 200 characters")
		}
		names[kind] = name
	}
	return &DatadogMetrics{client: options.Client, names: names, distribution: options.ObservationMetricType == "distribution"}, nil
}
func (adapter *DatadogMetrics) ObserveEvent(event Event) error {
	kind, known := metricKinds[event.Kind]
	if !known {
		return nil
	}
	labels := metricLabels(event, kind)
	if counterKinds[kind] {
		return adapter.client.Increment(adapter.names[kind], 1, labels)
	}
	value := metricValue(event, kind)
	if adapter.distribution {
		return adapter.client.Distribution(adapter.names[kind], value, labels)
	}
	return adapter.client.Histogram(adapter.names[kind], value, labels)
}
