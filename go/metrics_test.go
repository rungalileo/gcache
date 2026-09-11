package dialcache

import (
	"errors"
	"math/big"
	"os"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/prometheus/client_golang/prometheus"
)

type recordedMetric struct {
	method, name string
	value        float64
	tags         map[string]string
}
type recordingDogStatsD struct{ events []recordedMetric }

func (client *recordingDogStatsD) Increment(name string, value float64, tags map[string]string) error {
	client.events = append(client.events, recordedMetric{"increment", name, value, tags})
	return nil
}
func (client *recordingDogStatsD) Histogram(name string, value float64, tags map[string]string) error {
	client.events = append(client.events, recordedMetric{"histogram", name, value, tags})
	return nil
}
func (client *recordingDogStatsD) Distribution(name string, value float64, tags map[string]string) error {
	client.events = append(client.events, recordedMetric{"distribution", name, value, tags})
	return nil
}
func metricTestEvent(kind string) Event {
	return Event{Kind: kind, Key: "never_export_this_identity", Scope: "process", Seconds: 0.25, Bytes: 123, Outcome: "mismatch", Data: map[string]any{"cacheNamespace": "logical", "useCase": "lookup", "keyType": "item", "layer": "remote", "reason": "expired", "error": "fallback", "inFallback": true, "operation": "dump"}}
}

func TestDatadogMetricNamesUnitsAndLabels(t *testing.T) {
	client := &recordingDogStatsD{}
	adapter, err := NewDatadogMetrics(DatadogMetricsOptions{Client: client, ObservationMetricType: "distribution", Namespace: "app.cache"})
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		kind, suffix, method string
		value                float64
	}{
		{"request", "request.count", "increment", 1}, {"miss", "miss.count", "increment", 1}, {"disabled", "disabled.count", "increment", 1}, {"error", "error.count", "increment", 1}, {"invalidation", "invalidation.count", "increment", 1}, {"coalesced", "coalesced.count", "increment", 1},
		{"shadowValidation", "shadow.count", "increment", 1}, {"shadowAge", "shadow.value_age", "distribution", 0.25}, {"futureOffset", "future_timestamp_offset", "distribution", 0.25}, {"staleRecovery", "stale_recovery.count", "increment", 1}, {"recoveryAge", "stale_recovery.value_age", "distribution", 0.25},
		{"compression", "compression.count", "increment", 1}, {"get", "get.duration", "distribution", 0.25}, {"fallback", "fallback.duration", "distribution", 0.25}, {"serialization", "serialization.duration", "distribution", 0.25}, {"size", "serialization.size", "distribution", 123}, {"storedSize", "stored.size", "distribution", 123}, {"compressionRatio", "compression.ratio", "distribution", 0.25}, {"compressionDuration", "compression.duration", "distribution", 0.25},
	}
	for _, test := range cases {
		if err := adapter.ObserveEvent(metricTestEvent(test.kind)); err != nil {
			t.Fatal(err)
		}
		got := client.events[len(client.events)-1]
		if got.name != "app.cache."+test.suffix || got.method != test.method || got.value != test.value {
			t.Fatalf("%s: %+v", test.kind, got)
		}
		for _, value := range got.tags {
			if strings.Contains(value, "never_export") {
				t.Fatal("key leaked to metric labels")
			}
		}
	}
	if !reflect.DeepEqual(client.events[3].tags, map[string]string{"cache_namespace": "logical", "use_case": "lookup", "key_type": "item", "layer": "remote", "error": "fallback", "in_fallback": "true"}) {
		t.Fatalf("error tags: %+v", client.events[3])
	}
	if !reflect.DeepEqual(client.events[4].tags, map[string]string{"cache_namespace": "logical", "key_type": "item", "layer": "remote"}) {
		t.Fatal("invalidation acquired use_case")
	}
	if !reflect.DeepEqual(client.events[5].tags, map[string]string{"cache_namespace": "logical", "use_case": "lookup", "key_type": "item", "scope": "process"}) {
		t.Fatal("coalescing labels changed")
	}
	if _, ok := client.events[6].tags["layer"]; ok {
		t.Fatal("shadow acquired layer")
	}
	histogram, err := NewDatadogMetrics(DatadogMetricsOptions{Client: client, ObservationMetricType: "histogram"})
	if err != nil {
		t.Fatal(err)
	}
	_ = histogram.ObserveEvent(metricTestEvent("get"))
	if client.events[len(client.events)-1].method != "histogram" {
		t.Fatal("histogram option ignored")
	}
	for _, namespace := range []string{"1bad", "has-dash", "two..dots", strings.Repeat("a", 201)} {
		if _, err := NewDatadogMetrics(DatadogMetricsOptions{Client: client, ObservationMetricType: "distribution", Namespace: namespace}); err == nil {
			t.Fatalf("accepted namespace %q", namespace)
		}
	}
	if _, err := NewDatadogMetrics(DatadogMetricsOptions{Client: client, ObservationMetricType: "distribution", NamespaceSet: true}); err == nil {
		t.Fatal("accepted explicitly empty namespace")
	}
	var absent *recordingDogStatsD
	if _, err := NewDatadogMetrics(DatadogMetricsOptions{Client: absent, ObservationMetricType: "distribution"}); err == nil {
		t.Fatal("accepted nil client")
	}
}

func TestPrometheusWireSchemaMatchesTypeScriptBinding(t *testing.T) {
	source, err := os.ReadFile("../src/prometheus.ts")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	schemas := PrometheusCollectorSchemas("")
	if len(schemas) != 19 {
		t.Fatalf("collector count: %d", len(schemas))
	}
	for _, schema := range schemas {
		block := regexp.MustCompile("(?s)name: `\\$\\{prefix\\}" + regexp.QuoteMeta(schema.Name) + "`,(.*?)\\n    },").FindStringSubmatch(text)
		if len(block) != 2 {
			t.Fatalf("unknown collector %s", schema.Name)
		}
		help := regexp.MustCompile(`help: "([^"]+)"`).FindStringSubmatch(block[1])
		if len(help) != 2 || help[1] != schema.Help {
			t.Fatalf("%s help drift", schema.Name)
		}
		labels := regexp.MustCompile(`labelNames: \[([^\]]+)\]`).FindStringSubmatch(block[1])
		if len(labels) != 2 {
			t.Fatal("missing label schema")
		}
		expectedLabels := []string{}
		for _, label := range strings.Split(labels[1], ",") {
			expectedLabels = append(expectedLabels, strings.Trim(strings.TrimSpace(label), `"`))
		}
		if !reflect.DeepEqual(expectedLabels, schema.Labels) {
			t.Fatalf("%s label order drift", schema.Name)
		}
		bucketName := regexp.MustCompile(`buckets: (\w+)`).FindStringSubmatch(block[1])
		if len(bucketName) == 2 {
			raw := regexp.MustCompile(`(?s)const ` + bucketName[1] + ` = \[(.*?)\];`).FindStringSubmatch(text)
			if len(raw) != 2 {
				t.Fatal("missing bucket constant")
			}
			expected := []float64{}
			for _, value := range strings.Split(raw[1], ",") {
				value = strings.ReplaceAll(strings.TrimSpace(value), "_", "")
				if value == "" {
					continue
				}
				n, err := strconv.ParseFloat(value, 64)
				if err != nil {
					t.Fatal(err)
				}
				expected = append(expected, n)
			}
			if !reflect.DeepEqual(expected, schema.Buckets) {
				t.Fatalf("%s buckets drift", schema.Name)
			}
		} else if len(schema.Buckets) != 0 {
			t.Fatalf("%s counter became histogram", schema.Name)
		}
	}
}

func TestPrometheusReuseAndConflictIsolation(t *testing.T) {
	registry := prometheus.NewRegistry()
	first, err := NewPrometheusMetrics(registry, "test_")
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewPrometheusMetrics(registry, "test_")
	if err != nil {
		t.Fatal(err)
	}
	_ = first.ObserveEvent(metricTestEvent("request"))
	_ = second.ObserveEvent(metricTestEvent("request"))
	_ = first.ObserveEvent(metricTestEvent("get"))
	families, err := registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	var sawCounter, sawHistogram bool
	for _, family := range families {
		switch family.GetName() {
		case "test_dialcache_request_counter":
			sawCounter = true
			if family.Metric[0].Counter.GetValue() != 2 {
				t.Fatal("compatible adapter did not reuse counter")
			}
		case "test_dialcache_get_timer":
			sawHistogram = true
			hist := family.Metric[0].Histogram
			if hist.GetSampleCount() != 1 || hist.GetSampleSum() != 0.25 || len(hist.Bucket) != 12 {
				t.Fatalf("wrong histogram: %v", hist)
			}
		}
	}
	if !sawCounter || !sawHistogram {
		t.Fatal("metrics not exported")
	}
	conflict := prometheus.NewRegistry()
	conflict.MustRegister(prometheus.NewGauge(prometheus.GaugeOpts{Name: "dialcache_request_counter", Help: "incompatible"}))
	if _, err := NewPrometheusMetrics(conflict, ""); err == nil {
		t.Fatal("accepted conflicting collector")
	}
	families, err = conflict.Gather()
	if err != nil {
		t.Fatal(err)
	}
	if len(families) != 1 {
		t.Fatal("failed adapter partially registered collectors")
	}
}

func TestPrometheusExplicitBindingsPreserveExistingObservations(t *testing.T) {
	registry := prometheus.NewRegistry()
	var request, get PrometheusCollectorSchema
	for _, schema := range PrometheusCollectorSchemas("bound_") {
		if schema.Kind == "request" {
			request = schema
		}
		if schema.Kind == "get" {
			get = schema
		}
	}
	counter := prometheus.NewCounterVec(prometheus.CounterOpts{Name: request.Name, Help: request.Help}, request.Labels)
	histogram := prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: get.Name, Help: get.Help, Buckets: get.Buckets}, get.Labels)
	registry.MustRegister(counter, histogram)
	labels := prometheus.Labels(metricLabels(metricTestEvent("request"), "request"))
	counter.With(labels).Add(7)
	// The empty histogram must be reusable without first creating a probe series.
	bindings := []PrometheusCollectorBinding{{request, counter}, {get, histogram}}
	first, err := NewPrometheusMetricsWithBindings(registry, "bound_", bindings)
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewPrometheusMetricsWithBindings(registry, "bound_", bindings)
	if err != nil {
		t.Fatal(err)
	}
	if got := collectorDescriptions(registry); len(got) != 19 {
		t.Fatalf("binding changed registry membership: %d", len(got))
	}
	families, err := registry.Gather()
	if err != nil || len(families) != 1 || families[0].Metric[0].Counter.GetValue() != 7 {
		t.Fatalf("constructor altered observed series: %v %v", families, err)
	}
	_ = first.ObserveEvent(metricTestEvent("request"))
	_ = second.ObserveEvent(metricTestEvent("request"))
	_ = first.ObserveEvent(metricTestEvent("get"))
	_ = second.ObserveEvent(metricTestEvent("get"))
	families, err = registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, family := range families {
		if family.GetName() == request.Name && family.Metric[0].Counter.GetValue() != 9 {
			t.Fatal("binding did not retain caller's counter object")
		}
		if family.GetName() == get.Name {
			value := family.Metric[0].Histogram
			if value.GetSampleCount() != 2 || value.GetSampleSum() != 0.5 || len(value.Bucket) != len(get.Buckets) {
				t.Fatalf("binding changed histogram observations: %v", value)
			}
		}
	}
}

func TestPrometheusBindingsRejectIncompatibleOrUnregisteredCollectors(t *testing.T) {
	var histogramSchema PrometheusCollectorSchema
	for _, schema := range PrometheusCollectorSchemas("") {
		if schema.Kind == "get" {
			histogramSchema = schema
		}
	}
	for _, fault := range []string{"buckets", "descriptor", "unregistered", "lookalike", "type", "duplicate"} {
		t.Run(fault, func(t *testing.T) {
			registry := prometheus.NewRegistry()
			schema := histogramSchema
			makeHistogram := func(help string) *prometheus.HistogramVec {
				return prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: schema.Name, Help: help, Buckets: schema.Buckets}, schema.Labels)
			}
			collector := makeHistogram(schema.Help)
			if fault == "descriptor" {
				collector = makeHistogram("different help")
			}
			if fault != "unregistered" {
				registry.MustRegister(collector)
			}
			before := collectorDescriptions(registry)
			if fault == "buckets" {
				schema.Buckets = []float64{1, 2}
			}
			if fault == "lookalike" {
				collector = makeHistogram(schema.Help)
			}
			binding := PrometheusCollectorBinding{schema, collector}
			if fault == "type" {
				binding.Collector = prometheus.NewCounterVec(prometheus.CounterOpts{Name: schema.Name, Help: schema.Help}, schema.Labels)
			}
			bindings := []PrometheusCollectorBinding{binding}
			if fault == "duplicate" {
				bindings = append(bindings, binding)
			}
			if _, err := NewPrometheusMetricsWithBindings(registry, "", bindings); err == nil {
				t.Fatalf("accepted %s binding", fault)
			}
			if !reflect.DeepEqual(before, collectorDescriptions(registry)) {
				t.Fatal("failed constructor changed registry descriptors")
			}
			families, err := registry.Gather()
			if err != nil || len(families) != 0 {
				t.Fatalf("failed constructor created an observed series: %v %v", families, err)
			}
		})
	}
}

type panickingLogger struct{}

func (panickingLogger) Debug(string, any) { panic("debug") }
func (panickingLogger) Warn(string, any)  { panic("warn") }
func (panickingLogger) Error(string, any) { panic("error") }
func TestObserverIsolationAndBoundedNativeJSONLogs(t *testing.T) {
	FailureIsolatedObserver(func(Event) error { panic("exporter") })(Event{})
	FailureIsolatedObserver(func(Event) error { return errors.New("exporter") })(Event{})
	logger := FailureIsolatedLogger(panickingLogger{})
	logger.Debug("", nil)
	logger.Warn("", nil)
	logger.Error("", nil)
	key := PreviewShadowLogKey(strings.Repeat("🙂", 1000))
	if len(key) > ShadowLogKeyMaxBytes || !utf8.ValidString(key) || !strings.HasSuffix(key, ShadowLogTruncationMarker) {
		t.Fatalf("invalid key preview: bytes=%d", len(key))
	}
	value := PreviewShadowLogJSON(strings.Repeat("🙂", 3000))
	if value == nil || len(*value) > ShadowLogValueMaxBytes || !utf8.ValidString(*value) || !strings.HasSuffix(*value, ShadowLogTruncationMarker) {
		t.Fatal("invalid value preview")
	}
	if PreviewShadowLogJSON(Absent) != nil || PreviewShadowLogJSON(big.NewInt(1)) != nil {
		t.Fatal("unsupported values should have null previews")
	}
	cycle := map[string]any{}
	cycle["self"] = cycle
	if PreviewShadowLogJSON(cycle) != nil {
		t.Fatal("cyclic object should have null preview")
	}
	plain := PreviewShadowLogJSON("<tag>")
	if plain == nil || *plain != `"<tag>"` {
		t.Fatalf("native JSON was HTML escaped: %v", plain)
	}
	null := PreviewShadowLogJSON(nil)
	if null == nil || *null != "null" {
		t.Fatal("null confused with absent")
	}
}
