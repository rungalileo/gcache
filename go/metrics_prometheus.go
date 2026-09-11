package dialcache

import (
	"errors"
	"fmt"
	"reflect"
	"sync"

	"github.com/prometheus/client_golang/prometheus"
)

// PrometheusCollectorSchema fixes the TypeScript adapter wire contract.
type PrometheusCollectorSchema struct {
	Kind, Name, Help string
	Labels           []string
	Buckets          []float64
}

func PrometheusCollectorSchemas(prefix string) []PrometheusCollectorSchema {
	return []PrometheusCollectorSchema{
		{Kind: "disabled", Name: prefix + "dialcache_disabled_counter", Help: "Requests where DialCache skipped a cache layer.", Labels: []string{"cache_namespace", "use_case", "key_type", "layer", "reason"}},
		{Kind: "miss", Name: prefix + "dialcache_miss_counter", Help: "DialCache cache misses.", Labels: []string{"cache_namespace", "use_case", "key_type", "layer", "reason"}},
		{Kind: "request", Name: prefix + "dialcache_request_counter", Help: "Total DialCache cache-layer requests.", Labels: []string{"cache_namespace", "use_case", "key_type", "layer"}},
		{Kind: "error", Name: prefix + "dialcache_error_counter", Help: "Errors during DialCache cache operations or fallback execution.", Labels: []string{"cache_namespace", "use_case", "key_type", "layer", "error", "in_fallback"}},
		{Kind: "invalidation", Name: prefix + "dialcache_invalidation_counter", Help: "DialCache invalidation calls by key type and layer.", Labels: []string{"cache_namespace", "key_type", "layer"}},
		{Kind: "coalesced", Name: prefix + "dialcache_coalesced_counter", Help: "DialCache requests coalesced onto in-flight work by sharing scope.", Labels: []string{"cache_namespace", "use_case", "key_type", "scope"}},
		{Kind: "shadowValidation", Name: prefix + "dialcache_shadow_validation_counter", Help: "Sampled DialCache Redis shadow-validation outcomes.", Labels: []string{"cache_namespace", "use_case", "key_type", "outcome"}},
		{Kind: "shadowValueAge", Name: prefix + "dialcache_shadow_value_age_histogram", Help: "Age in seconds of the validated Redis value at DialCache shadow verdict time.", Labels: []string{"cache_namespace", "use_case", "key_type", "outcome"}, Buckets: []float64{1, 5, 15, 60, 300, 900, 3600, 10800, 43200, 86400, 259200, 604800}},
		{Kind: "futureTimestampOffset", Name: prefix + "dialcache_future_timestamp_offset_histogram", Help: "Positive offset in seconds of Redis frames dated after the observing DialCache process clock.", Labels: []string{"cache_namespace", "use_case", "key_type", "layer"}, Buckets: []float64{0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 5, 15, 60, 300, 900, 3600, 10800, 43200}},
		{Kind: "staleRecovery", Name: prefix + "dialcache_stale_recovery_counter", Help: "DialCache stale-on-error Redis recovery outcomes.", Labels: []string{"cache_namespace", "use_case", "key_type", "outcome"}},
		{Kind: "staleRecoveryValueAge", Name: prefix + "dialcache_stale_recovery_value_age_histogram", Help: "Age in seconds of Redis values served by DialCache stale-on-error recovery.", Labels: []string{"cache_namespace", "use_case", "key_type", "outcome"}, Buckets: []float64{1, 5, 15, 60, 300, 900, 3600, 10800, 43200, 86400, 259200, 604800}},
		{Kind: "compression", Name: prefix + "dialcache_compression_counter", Help: "DialCache Redis payload compression and decompression outcomes.", Labels: []string{"cache_namespace", "use_case", "key_type", "layer", "outcome"}},
		{Kind: "get", Name: prefix + "dialcache_get_timer", Help: "DialCache cache get latency in seconds.", Labels: []string{"cache_namespace", "use_case", "key_type", "layer"}, Buckets: []float64{0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10}},
		{Kind: "fallback", Name: prefix + "dialcache_fallback_timer", Help: "Time DialCache waited for the fallback function in seconds.", Labels: []string{"cache_namespace", "use_case", "key_type", "layer"}, Buckets: []float64{0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10}},
		{Kind: "serialization", Name: prefix + "dialcache_serialization_timer", Help: "DialCache serialization latency in seconds.", Labels: []string{"cache_namespace", "use_case", "key_type", "layer", "operation"}, Buckets: []float64{0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10}},
		{Kind: "size", Name: prefix + "dialcache_size_histogram", Help: "Serialized DialCache value sizes in bytes.", Labels: []string{"cache_namespace", "use_case", "key_type", "layer"}, Buckets: []float64{100, 1000, 10000, 100000, 1000000, 10000000}},
		{Kind: "storedSize", Name: prefix + "dialcache_stored_size_histogram", Help: "Stored DialCache payload sizes in bytes, after compression and escaping.", Labels: []string{"cache_namespace", "use_case", "key_type", "layer"}, Buckets: []float64{100, 1000, 10000, 100000, 1000000, 10000000}},
		{Kind: "compressionRatio", Name: prefix + "dialcache_compression_ratio_histogram", Help: "Compressed-to-original DialCache payload size ratio for compressed writes.", Labels: []string{"cache_namespace", "use_case", "key_type", "layer"}, Buckets: []float64{0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9, 1}},
		{Kind: "compressionDuration", Name: prefix + "dialcache_compression_timer", Help: "DialCache payload compression and decompression latency in seconds.", Labels: []string{"cache_namespace", "use_case", "key_type", "layer", "operation"}, Buckets: []float64{0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10}},
	}
}

type prometheusMetricsCollector struct {
	schemas    []PrometheusCollectorSchema
	counters   map[string]*prometheus.CounterVec
	histograms map[string]*prometheus.HistogramVec
}

func (collector *prometheusMetricsCollector) Describe(ch chan<- *prometheus.Desc) {
	for _, schema := range collector.schemas {
		if counter := collector.counters[schema.Kind]; counter != nil {
			counter.Describe(ch)
		} else {
			collector.histograms[schema.Kind].Describe(ch)
		}
	}
}
func (collector *prometheusMetricsCollector) Collect(ch chan<- prometheus.Metric) {
	for _, schema := range collector.schemas {
		if counter := collector.counters[schema.Kind]; counter != nil {
			counter.Collect(ch)
		} else {
			collector.histograms[schema.Kind].Collect(ch)
		}
	}
}

type PrometheusMetrics struct{ collector *prometheusMetricsCollector }

// PrometheusCollectorBinding makes an existing collector's schema explicit.
// Collector must be an individually registered CounterVec or HistogramVec.
// Schema is the caller's assertion about its construction options, including
// histogram buckets: client_golang does not expose those options for an empty
// HistogramVec. The adapter checks the declared schema and public descriptor
// before reuse, without creating a temporary metric series.
type PrometheusCollectorBinding struct {
	Schema    PrometheusCollectorSchema
	Collector prometheus.Collector
}

var prometheusConstruction sync.Mutex

// NewPrometheusMetrics creates collectors or reuses an earlier DialCache group.
// Use NewPrometheusMetricsWithBindings to reuse externally created collectors.
func NewPrometheusMetrics(registry *prometheus.Registry, prefix string) (*PrometheusMetrics, error) {
	return NewPrometheusMetricsWithBindings(registry, prefix, nil)
}

func collectorDescriptions(collector prometheus.Collector) []string {
	ch := make(chan *prometheus.Desc)
	go func() { collector.Describe(ch); close(ch) }()
	var descriptions []string
	for desc := range ch {
		descriptions = append(descriptions, desc.String())
	}
	return descriptions
}

// NewPrometheusMetricsWithBindings validates every supplied binding before
// atomically registering the remaining collectors. Previously observed values
// remain on the same collector objects. As with registry configuration itself,
// callers must not concurrently unregister/reconfigure the supplied collectors
// during construction; concurrent observations remain safe.
func NewPrometheusMetricsWithBindings(registry *prometheus.Registry, prefix string, bindings []PrometheusCollectorBinding) (adapter *PrometheusMetrics, err error) {
	prometheusConstruction.Lock()
	defer prometheusConstruction.Unlock()
	defer func() {
		if failure := recover(); failure != nil {
			adapter = nil
			err = fmt.Errorf("invalid Prometheus collector: %v", failure)
		}
	}()
	if registry == nil {
		return nil, errors.New("Prometheus registry is required")
	}
	collector := &prometheusMetricsCollector{schemas: PrometheusCollectorSchemas(prefix), counters: make(map[string]*prometheus.CounterVec), histograms: make(map[string]*prometheus.HistogramVec)}
	for _, schema := range collector.schemas {
		if counterKinds[schema.Kind] {
			collector.counters[schema.Kind] = prometheus.NewCounterVec(prometheus.CounterOpts{Name: schema.Name, Help: schema.Help}, schema.Labels)
		} else {
			collector.histograms[schema.Kind] = prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: schema.Name, Help: schema.Help, Buckets: schema.Buckets}, schema.Labels)
		}
	}
	available := make(map[string]bool)
	for _, descriptor := range collectorDescriptions(registry) {
		available[descriptor] = true
	}
	bound := make(map[string]bool)
	for _, binding := range bindings {
		var expected *PrometheusCollectorSchema
		for i := range collector.schemas {
			if collector.schemas[i].Name == binding.Schema.Name {
				expected = &collector.schemas[i]
				break
			}
		}
		if expected == nil || bound[expected.Kind] || !reflect.DeepEqual(*expected, binding.Schema) {
			return nil, errors.New("unknown, duplicate, or incompatible Prometheus collector binding")
		}
		var prototype prometheus.Collector
		if counterKinds[expected.Kind] {
			value, ok := binding.Collector.(*prometheus.CounterVec)
			if !ok || value == nil {
				return nil, errors.New("Prometheus counter binding requires CounterVec")
			}
			prototype = collector.counters[expected.Kind]
			collector.counters[expected.Kind] = value
		} else {
			value, ok := binding.Collector.(*prometheus.HistogramVec)
			if !ok || value == nil {
				return nil, errors.New("Prometheus histogram binding requires HistogramVec")
			}
			prototype = collector.histograms[expected.Kind]
			collector.histograms[expected.Kind] = value
		}
		actual, wanted := collectorDescriptions(binding.Collector), collectorDescriptions(prototype)
		if len(actual) != 1 || !reflect.DeepEqual(actual, wanted) || !available[actual[0]] {
			return nil, errors.New("Prometheus binding descriptor differs or is not registered")
		}
		// This descriptor is already registered, so Register returns its owner
		// without adding a collector. Check identity as well as schema: an
		// unregistered lookalike must not receive observations invisibly.
		registration := registry.Register(binding.Collector)
		var existing prometheus.AlreadyRegisteredError
		if registration == nil {
			registry.Unregister(binding.Collector)
			return nil, errors.New("Prometheus registry changed during binding validation")
		}
		if !errors.As(registration, &existing) || existing.ExistingCollector != binding.Collector {
			return nil, errors.New("Prometheus binding is not the registered individual collector")
		}
		bound[expected.Kind] = true
	}
	missing := &prometheusMetricsCollector{counters: make(map[string]*prometheus.CounterVec), histograms: make(map[string]*prometheus.HistogramVec)}
	for _, schema := range collector.schemas {
		if !bound[schema.Kind] {
			missing.schemas = append(missing.schemas, schema)
			missing.counters[schema.Kind] = collector.counters[schema.Kind]
			missing.histograms[schema.Kind] = collector.histograms[schema.Kind]
		}
	}
	if len(missing.schemas) == 0 {
		return &PrometheusMetrics{collector: collector}, nil
	}
	if err := registry.Register(missing); err != nil {
		var existing prometheus.AlreadyRegisteredError
		if !errors.As(err, &existing) {
			return nil, err
		}
		previous, ok := existing.ExistingCollector.(*prometheusMetricsCollector)
		if !ok || !reflect.DeepEqual(previous.schemas, missing.schemas) {
			return nil, errors.New("Prometheus collectors already exist with an incompatible or externally owned schema; use a unique prefix or registry")
		}
		for _, schema := range previous.schemas {
			collector.counters[schema.Kind] = previous.counters[schema.Kind]
			collector.histograms[schema.Kind] = previous.histograms[schema.Kind]
		}
	}
	return &PrometheusMetrics{collector: collector}, nil
}

func (adapter *PrometheusMetrics) ObserveEvent(event Event) error {
	kind, known := metricKinds[event.Kind]
	if !known {
		return nil
	}
	labels := prometheus.Labels(metricLabels(event, kind))
	if counter := adapter.collector.counters[kind]; counter != nil {
		metric, err := counter.GetMetricWith(labels)
		if err != nil {
			return err
		}
		metric.Inc()
		return nil
	}
	metric, err := adapter.collector.histograms[kind].GetMetricWith(labels)
	if err != nil {
		return err
	}
	metric.Observe(metricValue(event, kind))
	return nil
}
