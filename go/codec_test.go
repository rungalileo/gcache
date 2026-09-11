package dialcache

import (
	"bytes"
	"math"
	"math/big"
	"strings"
	"testing"
)

func TestJSONCodecNativeSemantics(t *testing.T) {
	codec := JSONCodec[any]{}
	cases := []struct {
		name    string
		value   any
		encoded string
	}{
		{"absent", Absent, JSONUndefinedSentinel}, {"null", nil, "null"}, {"false", false, "false"},
		{"negative zero", math.Copysign(0, -1), "0"}, {"nan", math.NaN(), "null"}, {"infinity", math.Inf(1), "null"},
		{"undefined sentinel string", JSONUndefinedSentinel, `"__dialcache_json_undefined_v1__"`},
		{"array absent", []any{Absent, nil, false, math.NaN()}, `[null,null,false,null]`},
		{"object absent", JSONObject{{"z", 1}, {"missing", Absent}, {"a", nil}}, `{"z":1,"a":null}`},
		{"integer key order", JSONObject{{"x", 1}, {"10", 2}, {"2", 3}, {"01", 4}}, `{"2":3,"10":2,"x":1,"01":4}`},
		{"duplicate property", JSONObject{{"a", 1}, {"b", 2}, {"a", 3}}, `{"a":3,"b":2}`},
		{"native text escaping", "<>&\u2028\u2029\n\u0000", "\"<>&\u2028\u2029\\n\\u0000\""},
		{"native buffer", []byte{0, 1, 255}, `{"type":"Buffer","data":[0,1,255]}`},
		{"numeric boundaries", []any{1e-7, 1e-6, 1e20, 1e21, 9007199254740991.0}, `[1e-7,0.000001,100000000000000000000,1e+21,9007199254740991]`},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			got, err := codec.Encode(test.value)
			if err != nil || got.Binary || string(got.Bytes) != test.encoded {
				t.Fatalf("got %q binary=%v err=%v; want %q", got.Bytes, got.Binary, err, test.encoded)
			}
		})
	}
	for _, binary := range []bool{false, true} {
		absent, err := codec.Decode(Payload{Bytes: []byte(JSONUndefinedSentinel), Binary: binary})
		if err != nil || !IsAbsent(absent) {
			t.Fatal("absence lost", err)
		}
		null, err := codec.Decode(Payload{Bytes: []byte("null"), Binary: binary})
		if err != nil || null != nil {
			t.Fatal("null lost", err)
		}
		repaired, err := codec.Decode(Payload{Bytes: []byte{34, 0xe2, 0x82, 34}, Binary: binary})
		if err != nil || repaired != "�" {
			t.Fatal("replacement UTF8 differs", repaired, err)
		}
	}
	for _, raw := range []string{"", "undefined", "1 2", "\ufeff1", "NaN", "Infinity"} {
		if _, err := codec.Decode(Payload{Bytes: []byte(raw)}); err == nil {
			t.Fatalf("invalid JSON %q accepted", raw)
		}
	}
	for _, value := range []any{big.NewInt(1), big.Int{}, func() {}, make(chan int)} {
		if _, err := codec.Encode(value); err == nil {
			t.Fatalf("unsupported %T accepted", value)
		}
	}
	cycle := map[string]any{}
	cycle["self"] = cycle
	if _, err := codec.Encode(cycle); err == nil {
		t.Fatal("cyclic object accepted")
	}
	array := make([]any, 1)
	array[0] = array
	if _, err := codec.Encode(array); err == nil {
		t.Fatal("cyclic array accepted")
	}
	if _, err := (JSONCodec[int]{}).Decode(Payload{Bytes: []byte(JSONUndefinedSentinel)}); err == nil {
		t.Fatal("unrepresentable absence accepted")
	}
	typed, err := (JSONCodec[map[string]int]{}).Decode(Payload{Bytes: []byte(`{"answer":42}`)})
	if err != nil || typed["answer"] != 42 {
		t.Fatal(typed, err)
	}
	overflow, err := codec.Decode(Payload{Bytes: []byte(`[1e400,-1e400,-0]`)})
	if err != nil {
		t.Fatal(err)
	}
	numbers := overflow.([]any)
	if !math.IsInf(numbers[0].(float64), 1) || !math.IsInf(numbers[1].(float64), -1) || !math.Signbit(numbers[2].(float64)) {
		t.Fatal("native numeric parsing differs", numbers)
	}
	if _, err := (JSONCodec[int]{}).Decode(Payload{Bytes: []byte(`null`)}); err == nil {
		t.Fatal("unrepresentable null became zero")
	}
}
func TestJSONCodecUnicodeScalarDomain(t *testing.T) {
	codec := JSONCodec[any]{}
	valid := []struct {
		raw  string
		want any
	}{
		{`"\ud83d\ude00"`, "😀"},
		{`"before\uD83D\uDE00after"`, "before😀after"},
		{`{"\ud83d\ude00":"scalar"}`, map[string]any{"😀": "scalar"}},
		{`"\\ud800"`, `\ud800`},
		{`"quoted:\"\\udc00"`, "quoted:\"\\udc00"},
	}
	invalid := []string{`"\ud800"`, `"\udfff"`, `"a\ud800b"`, `"\ud800\ud800"`, `"\udc00\ud800"`, `"\ud800\\udc00"`, `{"\ud800":1}`, `"\ud83d\ude00\udfff"`}
	for _, binary := range []bool{false, true} {
		for _, test := range valid {
			got, err := codec.Decode(Payload{Bytes: []byte(test.raw), Binary: binary})
			if err != nil || !SemanticEqual(got, test.want) {
				t.Fatalf("valid scalar JSON %s: got %#v, err %v; want %#v", test.raw, got, err, test.want)
			}
		}
		for _, raw := range invalid {
			got, err := codec.Decode(Payload{Bytes: []byte(raw), Binary: binary})
			if err == nil || got != nil {
				t.Fatalf("unsupported surrogate JSON %s returned changed value %#v with error %v", raw, got, err)
			}
		}
	}
	if _, err := (JSONCodec[string]{}).Decode(Payload{Bytes: []byte(`"\ud800"`)}); err == nil {
		t.Fatal("typed destination silently replaced an unpaired surrogate")
	}
}

func TestSemanticEqualPortableDomain(t *testing.T) {
	tests := []struct {
		a, b  any
		equal bool
	}{
		{Absent, nil, false}, {Absent, Absent, true}, {nil, nil, true}, {false, 0, false}, {1, float64(1), true},
		{math.NaN(), math.NaN(), true}, {0, math.Copysign(0, -1), false},
		{map[string]any{"a": 1, "b": []any{nil, Absent}}, map[string]any{"b": []any{nil, Absent}, "a": float64(1)}, true},
		{map[string]any{"a": Absent}, map[string]any{}, false},
		{[]byte{1, 2}, []byte{1, 2}, true}, {[]byte{1, 2}, []any{1, 2}, false},
		{JSONObject{{"b", 2}, {"a", 1}}, map[string]any{"a": 1, "b": 2}, true},
		{[]any{JSONObject{{"b", 2}, {"a", 1}}}, []any{map[string]any{"a": 1, "b": 2}}, true},
	}
	for i, test := range tests {
		if got := SemanticEqual(test.a, test.b); got != test.equal {
			t.Fatalf("case %d got %v", i, got)
		}
	}
}
func TestCompressionLimitsAndIndependentLoads(t *testing.T) {
	raw := Payload{Bytes: []byte(strings.Repeat("x", 4096))}
	compressed, err := CompressPayload(raw, CompressionConfig{1, 3})
	if err != nil || compressed.Outcome != "compressed" {
		t.Fatal(compressed, err)
	}
	tooLarge := DecompressPayload(compressed.Payload, 4095)
	if tooLarge.Outcome != "read_over_limit" || !bytes.Equal(tooLarge.Payload.Bytes, compressed.Payload.Bytes) {
		t.Fatal(tooLarge)
	}
	refused, err := CompressPayload(raw, CompressionConfig{1, 3}, 4095)
	if err != nil || refused.Outcome != "write_over_limit" || !bytes.Equal(refused.Payload.Bytes, raw.Bytes) {
		t.Fatal(refused, err)
	}
	first := DecompressPayload(compressed.Payload)
	first.Payload.Bytes[0] = 'y'
	second := DecompressPayload(compressed.Payload)
	if !bytes.Equal(second.Payload.Bytes, raw.Bytes) {
		t.Fatal("retained compressed input mutated")
	}
	escaped := EscapeRawPayload(Payload{Bytes: []byte{1, 2, 3}, Binary: true})
	first = DecompressPayload(escaped)
	first.Payload.Bytes[0] = 9
	if !bytes.Equal(DecompressPayload(escaped).Payload.Bytes, []byte{1, 2, 3}) {
		t.Fatal("retained escaped input mutated")
	}
	if _, err := ResolveCompressionConfig(&CompressionConfig{-1, 3}); err == nil {
		t.Fatal("invalid threshold")
	}
	if _, err := ResolveCompressionConfig(&CompressionConfig{1, 23}); err == nil {
		t.Fatal("invalid level")
	}
}

func TestZstdFirstFrameAndMalformedBodies(t *testing.T) {
	payload, err := CompressPayload(Payload{Bytes: []byte(strings.Repeat("first", 100))}, CompressionConfig{1, 3})
	if err != nil || payload.Outcome != "compressed" {
		t.Fatal(payload, err)
	}
	for _, trailer := range [][]byte{[]byte("CRC!"), payload.Payload.Bytes[1:]} {
		marked := append(append([]byte{}, payload.Payload.Bytes...), trailer...)
		result := DecompressPayload(Payload{Bytes: marked, Binary: true})
		if result.Outcome != "decompressed" || string(result.Payload.Bytes) != strings.Repeat("first", 100) {
			t.Fatal("trailer changed first frame", result)
		}
	}
	for _, marked := range [][]byte{{1}, {2}, payload.Payload.Bytes[:len(payload.Payload.Bytes)/2]} {
		got := DecompressPayload(Payload{Bytes: marked, Binary: true})
		if got.Outcome != "fallback_raw" || !bytes.Equal(got.Payload.Bytes, marked) {
			t.Fatal("malformed stream not retained", got)
		}
	}
}
