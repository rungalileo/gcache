// Package protocodec provides a gcache.Codec for generated protobuf messages, kept
// separate so google.golang.org/protobuf stays out of gcache's core import graph -- a
// caller holding a plain struct should not link a protobuf runtime.
package protocodec

import (
	"fmt"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	"github.com/rungalileo/gcache/go"
)

// The cross-language contract. Neither is protojson's default, so they live here rather
// than at each call site. Python's counterparts
// are preserving_proto_field_name=True and ignore_unknown_fields=True.
var (
	// snake_case, so the two languages write ONE wire form -- not about a reader failing
	// (protojson accepts either spelling), but about readers that are not protojson at all
	// (cjson in a Redis Lua script, jq, a dashboard query) needing one fixed key.
	marshalOptions = protojson.MarshalOptions{UseProtoNames: true}

	// Tolerate a field a newer writer added. Default is to error, which during a
	// rolling deploy that adds a field makes each pod generation reject the other's
	// entries for the whole rollout.
	unmarshalOptions = protojson.UnmarshalOptions{DiscardUnknown: true}
)

// ProtoJSON returns a Codec that stores M as protojson. M is the pointer type of a
// generated message, e.g. protocodec.ProtoJSON[*cachev1.SessionIdentity]().
func ProtoJSON[M proto.Message]() gcache.Codec[M] { return protoJSONCodec[M]{} }

type protoJSONCodec[M proto.Message] struct{}

func (protoJSONCodec[M]) Marshal(m M) ([]byte, error) {
	return marshalOptions.Marshal(m)
}

func (protoJSONCodec[M]) Unmarshal(b []byte, out *M) error {
	// A generic M cannot be new()'d, so allocate through the descriptor. ProtoReflect on
	// the typed-nil zero value is safe: generated code handles a nil receiver.
	var zero M
	msg, ok := zero.ProtoReflect().New().Interface().(M)
	if !ok {
		// Unreachable for a generated type; beats panicking on the type assertion.
		return fmt.Errorf("protocodec: %T.ProtoReflect().New() did not yield %T", zero, zero)
	}
	if err := unmarshalOptions.Unmarshal(b, msg); err != nil {
		return err
	}
	*out = msg
	return nil
}
