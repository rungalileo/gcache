package protocodec

import (
	"encoding/json"
	"maps"
	"slices"
	"testing"

	"google.golang.org/protobuf/types/descriptorpb"
)

// descriptorpb is the sample message because it ships with the protobuf runtime (no
// coupling to a Galileo schema) and has real multi-word fields. The well-known types
// mostly do not, and Timestamp/Struct/Value have bespoke JSON forms that would hide the
// field naming being asserted here.

func TestMarshalUsesSnakeCaseFieldNames(t *testing.T) {
	// The cross-language contract in one assertion. protojson's default is
	// lowerCamelCase, so without UseProtoNames Go would write {"sessionId":...} where
	// Python writes {"session_id":...}. Both readers accept either, so the cost is not a
	// failed read -- it is two wire forms for one key, which makes the conformance
	// fixture's exact keys unpinnable and breaks every reader that is not a protojson
	// implementation (cjson in a Redis Lua script, jq, a dashboard query).
	//
	// Assert the decoded KEY SET, not raw bytes: protojson appends a random extra space
	// after each comma, decided per binary build (internal/detrand). A byte assertion
	// would pass or fail by build, and only for messages with 2+ fields -- solid on a
	// one-field message, flaky on the real payload.
	c := ProtoJSON[*descriptorpb.FileOptions]()
	got, err := c.Marshal(&descriptorpb.FileOptions{
		GoPackage:   strptr("example/v1"),
		JavaPackage: strptr("com.example"),
	})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(got, &decoded); err != nil {
		t.Fatalf("Marshal produced invalid JSON %s: %v", got, err)
	}
	keys := slices.Sorted(maps.Keys(decoded))
	if want := []string{"go_package", "java_package"}; !slices.Equal(keys, want) {
		t.Fatalf("Marshal produced keys %v, want %v (from %s)", keys, want, got)
	}
}

func TestUnmarshalAllocatesIntoANilPointer(t *testing.T) {
	// gcache hands Unmarshal a nil *M (Get's `var zero V`), and a generic M cannot be
	// new()'d, so the codec allocates through the descriptor.
	c := ProtoJSON[*descriptorpb.FileOptions]()
	var out *descriptorpb.FileOptions
	if err := c.Unmarshal([]byte(`{"go_package":"example/v1"}`), &out); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if out == nil {
		t.Fatal("Unmarshal left the destination nil")
	}
	if out.GetGoPackage() != "example/v1" {
		t.Fatalf("go_package = %q, want %q", out.GetGoPackage(), "example/v1")
	}
}

func TestUnmarshalIgnoresAFieldItDoesNotKnow(t *testing.T) {
	// Forward compatibility. The default ERRORS on an unknown field, which would make
	// every old pod reject every new entry for a whole rollout -- a symptom that only
	// shows up under a two-version deploy, so assert the non-default explicitly.
	c := ProtoJSON[*descriptorpb.FileOptions]()
	var out *descriptorpb.FileOptions
	err := c.Unmarshal([]byte(`{"go_package":"example/v1","field_from_a_newer_writer":7}`), &out)
	if err != nil {
		t.Fatalf("Unmarshal rejected an unknown field: %v", err)
	}
	if out.GetGoPackage() != "example/v1" {
		t.Fatalf("go_package = %q, want %q", out.GetGoPackage(), "example/v1")
	}
}

func TestUnmarshalRejectsMalformedJSON(t *testing.T) {
	// Tolerating unknown fields must not slide into tolerating garbage.
	c := ProtoJSON[*descriptorpb.FileOptions]()
	var out *descriptorpb.FileOptions
	if err := c.Unmarshal([]byte(`{"go_package":`), &out); err == nil {
		t.Fatal("Unmarshal accepted truncated JSON")
	}
}

func TestRoundTripThroughTheCodec(t *testing.T) {
	c := ProtoJSON[*descriptorpb.FileOptions]()
	in := &descriptorpb.FileOptions{GoPackage: strptr("example/v1"), JavaPackage: strptr("com.example")}
	b, err := c.Marshal(in)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var out *descriptorpb.FileOptions
	if err := c.Unmarshal(b, &out); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if out.GetGoPackage() != in.GetGoPackage() || out.GetJavaPackage() != in.GetJavaPackage() {
		t.Fatalf("round trip lost data: %v -> %v", in, out)
	}
}

func strptr(s string) *string { return &s }

func TestUnmarshalAcceptsTheLowerCamelCaseSpellingToo(t *testing.T) {
	// The snake_case contract binds WRITERS. A Python caller that forgets
	// preserving_proto_field_name=True emits the lowerCamelCase spelling, and this reader
	// must still understand it. Verified against both runtimes: Go's protojson and
	// Python's json_format each accept either spelling, and a mixture of the two.
	//
	// Worth pinning rather than trusting the claim, because the failure would be silent.
	// UnmarshalOptions.DiscardUnknown drops an unrecognised field, so a spelling this
	// reader did not accept would yield a zero-valued message that Cache.Get reports as a
	// hit -- not a decode error.
	c := ProtoJSON[*descriptorpb.FileOptions]()

	for _, body := range []string{
		`{"goPackage":"example/v1","javaPackage":"com.example"}`,
		`{"goPackage":"example/v1","java_package":"com.example"}`,
	} {
		var out *descriptorpb.FileOptions
		if err := c.Unmarshal([]byte(body), &out); err != nil {
			t.Fatalf("Unmarshal(%s): %v", body, err)
		}
		if out.GetGoPackage() != "example/v1" {
			t.Errorf("%s: go_package = %q, want \"example/v1\"", body, out.GetGoPackage())
		}
		if out.GetJavaPackage() != "com.example" {
			t.Errorf("%s: java_package = %q, want \"com.example\"", body, out.GetJavaPackage())
		}
	}
}
