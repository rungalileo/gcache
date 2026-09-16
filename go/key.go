// Package gcache is a Go client for the Redis cache protocol shared with the Python gcache
// package, so either client honours the other's entries:
//
//	value key      {<urn_prefix>:<key_type>:<id>}[?k1=v1&k2=v2]#<use_case>
//	watermark key  {<urn_prefix>:<key_type>:<id>}#watermark
//
//	read        MGET <value key> <watermark key>
//	stale iff   watermark_ms >= envelope.createdAtMs      (inclusive)
//	write       SETEX <value key> <ttl_sec> <envelope>
//	invalidate  SETEX <watermark key> 14400 <now_ms + future_buffer_ms>
//
// Braces cover urn_prefix:key_type:id only, so a value and its watermark share one Cluster
// hash slot and the MGET is legal. Timestamps are epoch ms. Options.Codec handles the
// payload and the envelope does not record it, so a mismatch decodes to a zero value.
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

// Key identifies one cache entry. KeyType is the invalidation namespace -- watermarks are
// keyed by (key_type, id) only, so every entry sharing both is invalidated together -- and
// must match Python's KeyTypes.<member>.name exactly, or an invalidation silently misses.
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

// No component is escaped, deliberately: Python interpolates these with bare f-strings, so
// escaping here would make Go unable to read entries that exist in production (fixture at
// key_test.go:69). The one gap -- an UNTRACKED key with args colliding with an id containing '?'/'=' -- cannot escalate to forge a watermark key or cross a tenant.

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

// prefix renders `{urn:key_type:id}` (or the unbraced form when untracked). No component
// is escaped, deliberately: Python builds this with bare f-string interpolation (see
// render_prefix), so escaping here would produce keys Python cannot find.
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
		// Byte-ordinal by name, which matches Python: Python compares str by CODE POINT, and
		// UTF-8 byte order equals code-point order, so this agrees even for a non-ASCII name.
		// Stable, matching list.sort: two args sharing a name render in input order in both.
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

// WatermarkKey renders the invalidation watermark key for (key_type, id). Always uses the
// braced form regardless of Key.Tracked, matching Python's invalidate(); the watermark
// carries no use case and no args, since (key_type, id) is the whole invalidation namespace.
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
