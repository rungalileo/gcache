package gcache

import (
	"fmt"
	"testing"
)

// The fixtures below reproduce the key SHAPES a production deployment stores -- compound
// ids carrying colons and slashes, args outside the hash tag, long hex digests. Values are
// synthetic; the shapes are the contract. If Go stops reproducing them byte-for-byte, every
// cross-language read becomes a silent miss.
const prodURN = "urn:galileo:acme"

func TestValueKeyMatchesProductionKeys(t *testing.T) {
	tests := []struct {
		name string
		urn  string
		key  Key
		want string
	}{
		{
			name: "untracked, id contains colons and a slash",
			urn:  prodURN,
			key: Key{
				KeyType: "report_response_cache_key",
				ID:      "report:v1:response:/v1/rollup:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
				UseCase: "ReportService::response_cache",
			},
			want: "urn:galileo:acme:report_response_cache_key:report:v1:response:/v1/rollup:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef#ReportService::response_cache",
		},
		{
			name: "tracked with args -- args sit OUTSIDE the hash tag",
			urn:  prodURN,
			key: Key{
				KeyType: "principal_id",
				ID:      "00000000-0000-4000-8000-00000000000a",
				UseCase: "AuthzService::check_results",
				Tracked: true,
				Args: []Arg{
					{"principal", "0123456789abcdef0123456789abcdef"},
					{"resource_entries", "fedcba9876543210fedcba9876543210"},
				},
			},
			want: "{urn:galileo:acme:principal_id:00000000-0000-4000-8000-00000000000a}?principal=0123456789abcdef0123456789abcdef&resource_entries=fedcba9876543210fedcba9876543210#AuthzService::check_results",
		},
		{
			// Supplied out of order: the renderer must sort, or two callers computing the
			// same logical lookup land on different keys.
			name: "args are sorted by name, not by supplied order",
			urn:  prodURN,
			key: Key{
				KeyType: "principal_id",
				ID:      "00000000-0000-4000-8000-00000000000a",
				UseCase: "AuthzService::check_results",
				Tracked: true,
				Args: []Arg{
					{"resource_entries", "fedcba9876543210fedcba9876543210"},
					{"principal", "0123456789abcdef0123456789abcdef"},
				},
			},
			want: "{urn:galileo:acme:principal_id:00000000-0000-4000-8000-00000000000a}?principal=0123456789abcdef0123456789abcdef&resource_entries=fedcba9876543210fedcba9876543210#AuthzService::check_results",
		},
		{
			// Python's urn_prefix defaults to "urn"; an empty prefix must not emit a
			// leading colon.
			name: "empty urn prefix",
			urn:  "",
			key:  Key{KeyType: "session_id", ID: "abc", UseCase: "uc"},
			want: "session_id:abc#uc",
		},
		{
			// The `::` in a use case and any punctuation in an id are stored literally.
			// Percent-encoding here would break Python compatibility outright: render_prefix
			// interpolates with an f-string and escapes nothing. The want value proves it.
			name: "no percent-encoding of any component",
			urn:  "urn:galileo:acme",
			key:  Key{KeyType: "log_records_search_run_id", ID: "a b/c?d&e=f", UseCase: "Svc::method"},
			want: "urn:galileo:acme:log_records_search_run_id:a b/c?d&e=f#Svc::method",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ValueKey(tt.urn, tt.key); got != tt.want {
				t.Errorf("ValueKey mismatch\n got: %q\nwant: %q", got, tt.want)
			}
		})
	}
}

func TestValueKeySortIsStableAcrossDuplicateArgNames(t *testing.T) {
	// Python's list.sort is stable; sort.Slice is not, and pdqsort only preserves input
	// order by accident on short inputs -- at this size (16) it genuinely reorders, so the
	// two languages would build different keys for the same call without SliceStable.
	args := make([]Arg, 0, 16)
	for i := range 16 {
		args = append(args, Arg{Name: fmt.Sprintf("k%02d", i%4), Value: fmt.Sprint(i)})
	}
	key := Key{KeyType: "session_id", ID: "s-1", UseCase: "u", Args: args}

	got := ValueKey("urn", key)

	// Stable means: within each name, values appear in the order the caller passed them.
	want := "urn:session_id:s-1?k00=0&k00=4&k00=8&k00=12&k01=1&k01=5&k01=9&k01=13" +
		"&k02=2&k02=6&k02=10&k02=14&k03=3&k03=7&k03=11&k03=15#u"
	if got != want {
		t.Errorf("ValueKey =\n%s\nwant\n%s", got, want)
	}
}

func TestWatermarkKeyMatchesProductionKey(t *testing.T) {
	got := WatermarkKey(prodURN, "stream_project_id", "00000000-0000-4000-8000-00000000000b")
	want := "{urn:galileo:acme:stream_project_id:00000000-0000-4000-8000-00000000000b}#watermark"
	if got != want {
		t.Errorf("WatermarkKey mismatch\n got: %q\nwant: %q", got, want)
	}
}

func TestWatermarkKeyIsBracedEvenForUntrackedKeys(t *testing.T) {
	// Python's invalidate() always writes the braced form; it just only ever lands on
	// tracked entries. Mirroring that keeps a Go invalidate visible to a Python reader.
	if got := WatermarkKey("urn", "kt", "id"); got != "{urn:kt:id}#watermark" {
		t.Errorf("got %q", got)
	}
}

func TestWatermarkSharesTheHashSlotWithItsValueKey(t *testing.T) {
	// The whole point of the {...} tag: a tracked value key and its watermark must hash to
	// the same Redis Cluster slot, or the MGET of the two is rejected in cluster mode.
	k := Key{KeyType: "session_id", ID: "sid-1", UseCase: "uc", Tracked: true, Args: []Arg{{"a", "1"}}}
	value := ValueKey("urn:galileo:acme", k)
	watermark := WatermarkKey("urn:galileo:acme", k.KeyType, k.ID)

	vTag, ok := hashTag(value)
	if !ok {
		t.Fatalf("value key %q has no hash tag", value)
	}
	wTag, ok := hashTag(watermark)
	if !ok {
		t.Fatalf("watermark key %q has no hash tag", watermark)
	}
	if vTag != wTag {
		t.Errorf("hash tags differ: value %q vs watermark %q", vTag, wTag)
	}
}

// hashTag extracts the {...} span Redis Cluster hashes on.
func hashTag(key string) (string, bool) {
	start := -1
	for i := 0; i < len(key); i++ {
		switch key[i] {
		case '{':
			if start == -1 {
				start = i
			}
		case '}':
			if start != -1 && i > start+1 {
				return key[start+1 : i], true
			}
		}
	}
	return "", false
}

func TestValidateRejectsReservedAndEmptyFields(t *testing.T) {
	tests := map[string]Key{
		"missing key type":  {ID: "i", UseCase: "u"},
		"missing id":        {KeyType: "k", UseCase: "u"},
		"missing use case":  {KeyType: "k", ID: "i"},
		"reserved use case": {KeyType: "k", ID: "i", UseCase: "watermark"},
	}
	for name, k := range tests {
		t.Run(name, func(t *testing.T) {
			if err := k.Validate(); err == nil {
				t.Errorf("Validate() = nil, want an error")
			}
		})
	}
	if err := (Key{KeyType: "k", ID: "i", UseCase: "u"}).Validate(); err != nil {
		t.Errorf("Validate() on a valid key = %v", err)
	}
}
