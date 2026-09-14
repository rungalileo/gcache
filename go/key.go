// Package gcache is a Go client for the Redis cache protocol used by Galileo's Python
// gcache library (github.com/rungalileo/gcache) and its TypeScript port.
//
// It deliberately speaks the same wire protocol rather than inventing another one, so a
// value written by any of the three languages is readable by the others and an
// invalidation issued by any of them is honoured by all. The protocol is:
//
//	value key      {<urn_prefix>:<key_type>:<id>}[?k1=v1&k2=v2]#<use_case>
//	watermark key  {<urn_prefix>:<key_type>:<id>}#watermark
//
//	read        MGET <value key> <watermark key>
//	stale iff   watermark_ms >= envelope.createdAtMs      (inclusive)
//	write       SETEX <value key> <ttl_sec> <envelope>
//	invalidate  SETEX <watermark key> 14400 <now_ms + future_buffer_ms>
//
// The braces wrap urn_prefix:key_type:id only. Args and #use_case sit outside them, which
// is what keeps a value and its watermark in the same Redis Cluster hash slot so the MGET
// is legal. Timestamps are Unix epoch milliseconds, wall clock.
//
// # Payload encoding
//
// The protocol frames a payload but says nothing about its contents; that is
// Options.Codec, defaulting to encoding/json. The envelope does NOT record which codec
// wrote a value, so readers and writers of a use case must agree out of band -- a
// mismatch does not error, it decodes to a zero value that looks like a hit. For a
// payload shared with another language use subpackage protocodec with a generated type
// (libs/proto/cache), which makes the agreement testable.
package gcache

import (
	"fmt"
	"sort"
	"strings"
)

// watermarkUseCase is reserved by the protocol: a key with this use case and no args would
// collide with the watermark key. Python's gcache raises UseCaseNameIsReserved for it.
const watermarkUseCase = "watermark"

// Arg is one key-discriminating argument. Args are sorted by name before being rendered,
// matching Python's `sorted_args.sort(key=lambda x: x[0])`, so the same logical lookup
// always produces the same key regardless of the order the caller supplied them in.
type Arg struct {
	Name  string
	Value string
}

// Key identifies one cache entry.
//
// KeyType is the invalidation namespace: watermarks are keyed by (key_type, id) and carry
// neither the use case nor the args, so every entry sharing a KeyType and ID is
// invalidated together. It must match the Python side's KeyTypes.<member>.name exactly, or
// an invalidation from one language silently fails to reach the other's entry.
type Key struct {
	KeyType string
	ID      string
	UseCase string
	Args    []Arg

	// Tracked reports whether this entry participates in watermark invalidation. It
	// controls the {...} hash tag, so it changes the key bytes -- a tracked and an
	// untracked entry with otherwise identical fields are different entries.
	Tracked bool
}

// No component is escaped or rejected for carrying the grammar's own delimiters, and that
// is deliberate: Python interpolates these with bare f-strings, so escaping or refusing
// here would make Go unable to read entries that exist in production today. The fixture at
// key_test.go:69 pins ids holding '?', '&' and '=' that were scanned out of a live Redis.
//
// The cost is one ambiguity, and it is narrower than it first looks. It needs an UNTRACKED
// key that ALSO passes args:
//
//	Key{KeyType: "external_id", ID: "a?b=1", UseCase: "Svc::m"}                        // untracked
//	Key{KeyType: "external_id", ID: "a", UseCase: "Svc::m", Args: []Arg{{"b", "1"}}}   // untracked
//
// both render urn:galileo:acme:external_id:a?b=1#Svc::m, so two lookups share one entry.
// For a TRACKED key the closing brace lands between the id and the args, which separates
// them: {...:a?b=1}#Svc::m versus {...:a}?b=1#Svc::m. Verified both ways.
//
// It cannot escalate beyond that. A crafted id cannot forge a watermark key, because the
// use case is appended last and the urn can therefore never END in "#watermark" (and
// Validate rejects that use case outright). It cannot cross a tenant either, since the urn
// prefix carries the customer name, nor shift a project or run boundary, since those are
// fixed-width 36-character UUIDs containing no colon -- a crafted id only ever extends the
// tail.
//
// Closing it properly means unifying encoding across all three clients, which the
// TypeScript port already does differently (it percent-encodes). That belongs in the
// cross-client parity follow-up, not in one language.

// Validate reports why a Key cannot be used, or nil.
func (k Key) Validate() error {
	switch {
	case k.KeyType == "":
		return fmt.Errorf("gcache: Key.KeyType is required")
	case k.ID == "":
		return fmt.Errorf("gcache: Key.ID is required")
	case k.UseCase == "":
		return fmt.Errorf("gcache: Key.UseCase is required")
	case k.UseCase == watermarkUseCase:
		return fmt.Errorf("gcache: Key.UseCase %q is reserved -- it would collide with the watermark key", watermarkUseCase)
	}
	return nil
}

// prefix renders `{urn:key_type:id}` (or the unbraced form when untracked).
//
// Note there is no escaping of any component. That is not an oversight: Python builds this
// with bare f-string interpolation, so any escaping here would produce keys that Python
// cannot find. (The TypeScript port percent-encodes and is, for that reason, already
// incompatible with Python.)
func prefix(urnPrefix string, k Key) string {
	var b strings.Builder
	if k.Tracked {
		b.WriteByte('{')
	}
	if urnPrefix != "" {
		b.WriteString(urnPrefix)
		b.WriteByte(':')
	}
	b.WriteString(k.KeyType)
	b.WriteByte(':')
	b.WriteString(k.ID)
	if k.Tracked {
		b.WriteByte('}')
	}
	return b.String()
}

// ValueKey renders the key the cached value is stored under.
func ValueKey(urnPrefix string, k Key) string {
	var b strings.Builder
	b.WriteString(prefix(urnPrefix, k))

	if len(k.Args) > 0 {
		args := make([]Arg, len(k.Args))
		copy(args, k.Args)
		// Byte-ordinal by name, matching Python's default string sort. (The TypeScript
		// port uses localeCompare, which differs for non-ASCII names.)
		//
		// Stable, because Python's list.sort is: two args sharing a name must render in
		// input order in both languages or the same call builds a different key in each.
		sort.SliceStable(args, func(i, j int) bool { return args[i].Name < args[j].Name })

		for i, a := range args {
			if i == 0 {
				b.WriteByte('?')
			} else {
				b.WriteByte('&')
			}
			b.WriteString(a.Name)
			b.WriteByte('=')
			b.WriteString(a.Value)
		}
	}

	b.WriteByte('#')
	b.WriteString(k.UseCase)
	return b.String()
}

// WatermarkKey renders the invalidation watermark key for (key_type, id).
//
// It always uses the braced form regardless of Key.Tracked, matching Python's invalidate(),
// which builds the braced key unconditionally -- it simply only ever lands on tracked keys.
// The watermark carries no use case and no args: (key_type, id) is the invalidation
// namespace.
func WatermarkKey(urnPrefix, keyType, id string) string {
	var b strings.Builder
	b.WriteByte('{')
	if urnPrefix != "" {
		b.WriteString(urnPrefix)
		b.WriteByte(':')
	}
	b.WriteString(keyType)
	b.WriteByte(':')
	b.WriteString(id)
	b.WriteString("}#watermark")
	return b.String()
}
