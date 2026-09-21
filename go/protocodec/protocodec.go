// Package protocodec provides a gcache.Codec for generated protobuf messages, kept
// separate so google.golang.org/protobuf stays out of gcache's core import graph -- a
// caller holding a plain struct should not link a protobuf runtime.
package protocodec

import (
	"fmt"

	"google.golang.org/protobuf/proto"

	"github.com/rungalileo/gcache/go"
)

// Proto returns a Codec that stores M in the binary protobuf wire format. M is the pointer
// type of a generated message, e.g. protocodec.Proto[*cachev1.SessionIdentity]().
//
// Pairs with gcache.EnvelopePROTO, which carries the bytes in a binary envelope with no
// JSON wrapper -- where binary belongs, since the JSON envelope carries text. 69 bytes
// stored for a small message rather than 204, and roughly 20x cheaper to serialize.
//
// Python's counterpart is ProtoSerializer. Binary carries field NUMBERS, so there is no
// spelling for the two clients to disagree about, and unknown fields are skipped by
// proto.Unmarshal itself.
//
// What it gives up is readability: a stored entry is opaque to redis-cli, jq and Redis's
// Lua cjson. Use the JSON envelope with a text codec where that matters.
func Proto[M proto.Message]() gcache.Codec[M] { return protoCodec[M]{} }

type protoCodec[M proto.Message] struct{}

func (protoCodec[M]) Marshal(m M) ([]byte, error) {
	return proto.Marshal(m)
}

func (protoCodec[M]) Unmarshal(b []byte, out *M) error {
	// A generic M cannot be new()'d, so allocate through the descriptor. ProtoReflect on
	// the typed-nil zero value is safe: generated code handles a nil receiver.
	var zero M
	msg, ok := zero.ProtoReflect().New().Interface().(M)
	if !ok {
		// Unreachable for a generated type; beats panicking on the type assertion.
		return fmt.Errorf("protocodec: %T.ProtoReflect().New() did not yield %T", zero, zero)
	}
	if err := proto.Unmarshal(b, msg); err != nil {
		return err
	}
	*out = msg
	return nil
}
