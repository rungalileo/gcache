package protocodec

import (
	"bytes"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/descriptorpb"
)

// descriptorpb is the sample message because it ships with the protobuf runtime (no
// coupling to a Galileo schema) and has real multi-word fields; the well-known types
// mostly lack these.

func strptr(s string) *string { return &s }

func sample() *descriptorpb.FileOptions {
	return &descriptorpb.FileOptions{
		GoPackage:   strptr("example/v1"),
		JavaPackage: strptr("com.example"),
	}
}

func TestMarshalIsTheBinaryWireFormat(t *testing.T) {
	// Byte-for-byte what protobuf itself produces, which is the contract Python's
	// ProtoSerializer.dump must match. Not protojson, and not base64 of either.
	got, err := Proto[*descriptorpb.FileOptions]().Marshal(sample())
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	want, err := proto.Marshal(sample())
	if err != nil {
		t.Fatalf("proto.Marshal: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("Marshal = %x, want %x", got, want)
	}
	// Field NUMBERS, not names. This is why the snake_case-vs-lowerCamelCase hazard is gone
	// rather than merely tested: there is no spelling on the wire to get wrong.
	for _, name := range []string{"go_package", "goPackage", "java_package", "javaPackage"} {
		if bytes.Contains(got, []byte(name)) {
			t.Errorf("binary output contains the field NAME %q: %x", name, got)
		}
	}
	if !bytes.Contains(got, []byte("example/v1")) {
		t.Error("the value itself should still be present, unescaped")
	}
}

func TestMarshalIsSmallerThanProtojson(t *testing.T) {
	// Pins the reason this codec replaced the protojson one. A loose bound on purpose --
	// the point is that a regression to a text encoding cannot pass.
	binary, err := Proto[*descriptorpb.FileOptions]().Marshal(sample())
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	text, err := protojson.MarshalOptions{UseProtoNames: true}.Marshal(sample())
	if err != nil {
		t.Fatalf("protojson.Marshal: %v", err)
	}
	if len(binary)*4 >= len(text)*3 {
		t.Fatalf("binary %d bytes is not meaningfully smaller than protojson %d", len(binary), len(text))
	}
}

func TestUnmarshalAllocatesIntoANilPointer(t *testing.T) {
	// gcache hands Unmarshal a nil *M (Get's `var zero V`), and a generic M cannot be
	// new()'d, so the codec allocates through the descriptor.
	c := Proto[*descriptorpb.FileOptions]()
	raw, err := proto.Marshal(sample())
	if err != nil {
		t.Fatalf("proto.Marshal: %v", err)
	}
	var out *descriptorpb.FileOptions
	if err := c.Unmarshal(raw, &out); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if out == nil {
		t.Fatal("Unmarshal left the destination nil")
	}
	if out.GetGoPackage() != "example/v1" {
		t.Fatalf("go_package = %q, want %q", out.GetGoPackage(), "example/v1")
	}
}

func TestUnmarshalSkipsAFieldItDoesNotKnow(t *testing.T) {
	// Forward compatibility during a rolling deploy that adds a field. Unlike protojson,
	// this needs no option: proto.Unmarshal skips unknown fields itself, so there is no
	// DiscardUnknown equivalent to forget to set.
	raw, err := proto.Marshal(sample())
	if err != nil {
		t.Fatalf("proto.Marshal: %v", err)
	}
	raw = append(raw, 0xf8, 0x3f, 0x01) // field 127, varint, value 1

	var out *descriptorpb.FileOptions
	if err := Proto[*descriptorpb.FileOptions]().Unmarshal(raw, &out); err != nil {
		t.Fatalf("Unmarshal rejected an unknown field: %v", err)
	}
	if out.GetGoPackage() != "example/v1" {
		t.Fatalf("go_package = %q, want %q", out.GetGoPackage(), "example/v1")
	}
}

func TestUnmarshalRejectsMalformedBytes(t *testing.T) {
	// Skipping unknown fields must not slide into tolerating garbage.
	var out *descriptorpb.FileOptions
	if err := Proto[*descriptorpb.FileOptions]().Unmarshal([]byte{0x0a, 0xff}, &out); err == nil {
		t.Fatal("Unmarshal accepted a truncated length-delimited field")
	}
}

func TestUnmarshalRejectsProtojson(t *testing.T) {
	// The migration direction, asserted rather than assumed: a protojson value meeting this
	// codec must FAIL, so the caller turns it into a miss and rewrites. Silently yielding a
	// zero-valued message would be a wrong answer instead.
	text, err := protojson.MarshalOptions{UseProtoNames: true}.Marshal(sample())
	if err != nil {
		t.Fatalf("protojson.Marshal: %v", err)
	}
	var out *descriptorpb.FileOptions
	if err := Proto[*descriptorpb.FileOptions]().Unmarshal(text, &out); err == nil {
		t.Fatalf("Unmarshal accepted protojson %s", text)
	}
}

func TestRoundTripThroughTheCodec(t *testing.T) {
	c := Proto[*descriptorpb.FileOptions]()
	b, err := c.Marshal(sample())
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var out *descriptorpb.FileOptions
	if err := c.Unmarshal(b, &out); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if out.GetGoPackage() != "example/v1" || out.GetJavaPackage() != "com.example" {
		t.Fatalf("round trip lost data: %v", out)
	}
}
