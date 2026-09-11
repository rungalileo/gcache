package dialcache

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/big"
	"reflect"
	"sort"
	"strconv"
	"strings"

	"github.com/klauspost/compress/zstd"
)

// Absent is the explicit counterpart of JavaScript undefined. It differs from
// nil (JSON null), including in request/local storage and shadow comparisons.
// The private type prevents callers from creating additional sentinel values.
type absentValue struct{ marker byte }

var Absent = absentValue{1}

func IsAbsent(value any) bool { _, ok := value.(absentValue); return ok }

const JSONUndefinedSentinel = "__dialcache_json_undefined_v1__"

// JSONMember and JSONObject preserve object insertion order when byte-identical
// JSON output matters. Integer-index names are emitted first, as in JavaScript.
// A Go map has no insertion order; its other names are emitted in UTF-16 order.
type JSONMember struct {
	Name  string
	Value any
}
type JSONObject []JSONMember

// JSONCodec implements the default JSON serializer over JSON-compatible Go
// values and Absent. Object members holding Absent are omitted; array elements
// holding Absent and nonfinite numbers become null. Big integers and cycles
// are errors. Strings contain Unicode scalar values; JSON escapes with unpaired
// UTF-16 surrogates are rejected. JSONCodec[any] preserves this supported domain.
type JSONCodec[T any] struct{}

func (JSONCodec[T]) Encode(value T) (Payload, error) {
	if IsAbsent(value) {
		return Payload{Bytes: []byte(JSONUndefinedSentinel)}, nil
	}
	raw, err := appendJSON(nil, reflect.ValueOf(value), make(map[visit]bool))
	return Payload{Bytes: raw}, err
}
func (JSONCodec[T]) Decode(payload Payload) (T, error) {
	var zero T
	raw := replacementUTF8(payload.Bytes)
	if string(raw) == JSONUndefinedSentinel {
		if value, ok := any(Absent).(T); ok {
			return value, nil
		}
		return zero, errors.New("destination type cannot represent Absent")
	}
	// JSON.parse uses IEEE-754 numbers, including infinity when a valid JSON
	// number overflows. Go's default decoder rejects that case, so retain number
	// tokens until the explicit conversion. A BOM still remains a syntax error.
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var parsed any
	if err := decoder.Decode(&parsed); err != nil {
		return zero, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return zero, errors.New("trailing JSON content")
	}
	if err := validateJSONScalarStrings(raw); err != nil {
		return zero, err
	}
	parsed = jsonNumbers(parsed)
	if value, ok := parsed.(T); ok {
		return value, nil
	}
	if parsed == nil {
		switch reflect.TypeFor[T]().Kind() {
		case reflect.Interface, reflect.Pointer, reflect.Map, reflect.Slice:
			return zero, nil
		default:
			return zero, errors.New("destination type cannot represent JSON null")
		}
	}
	// Typed destinations additionally use their Go field/tag and numeric range
	// rules. JSONCodec[any] above retains the supported scalar-string JSON domain.
	var value T
	if err := json.Unmarshal(raw, &value); err != nil {
		return zero, err
	}
	return value, nil
}

// encoding/json silently replaces unpaired UTF-16 escapes. JSON.parse retains
// those code units, which are outside this binding's scalar-string domain.
// Reject them so cache plumbing can fail open instead of returning changed data.
// This scan follows successful JSON syntax validation above.
func validateJSONScalarStrings(raw []byte) error {
	inString := false
	for i := 0; i < len(raw); i++ {
		if raw[i] == '"' {
			inString = !inString
			continue
		}
		if !inString || raw[i] != '\\' {
			continue
		}
		i++ // Skip escaped quotes and backslashes without treating them as syntax.
		if raw[i] != 'u' {
			continue
		}
		unit, _ := strconv.ParseUint(string(raw[i+1:i+5]), 16, 16)
		i += 4
		if unit >= 0xD800 && unit <= 0xDBFF {
			if i+6 >= len(raw) || raw[i+1] != '\\' || raw[i+2] != 'u' {
				return errors.New("JSON string contains an unpaired UTF-16 surrogate")
			}
			low, err := strconv.ParseUint(string(raw[i+3:i+7]), 16, 16)
			if err != nil || low < 0xDC00 || low > 0xDFFF {
				return errors.New("JSON string contains an unpaired UTF-16 surrogate")
			}
			i += 6
		} else if unit >= 0xDC00 && unit <= 0xDFFF {
			return errors.New("JSON string contains an unpaired UTF-16 surrogate")
		}
	}
	return nil
}

func jsonNumbers(value any) any {
	switch value := value.(type) {
	case json.Number:
		number, _ := strconv.ParseFloat(string(value), 64)
		return number
	case []any:
		for i, item := range value {
			value[i] = jsonNumbers(item)
		}
		return value
	case map[string]any:
		for key, item := range value {
			value[key] = jsonNumbers(item)
		}
		return value
	default:
		return value
	}
}

type visit struct {
	kind    reflect.Kind
	pointer uintptr
}

func scalarNumber(value reflect.Value) (float64, bool) {
	if !value.IsValid() {
		return 0, false
	}
	if value.Type() == reflect.TypeOf(json.Number("")) {
		n, e := strconv.ParseFloat(value.String(), 64)
		return n, e == nil
	}
	switch value.Kind() {
	case reflect.Float32, reflect.Float64:
		return value.Float(), true
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return float64(value.Int()), true
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return float64(value.Uint()), true
	}
	return 0, false
}
func numberString(value float64) string {
	if math.IsNaN(value) {
		return "NaN"
	}
	if math.IsInf(value, 1) {
		return "Infinity"
	}
	if math.IsInf(value, -1) {
		return "-Infinity"
	}
	if value == 0 {
		return "0"
	}
	// encoding/json uses ECMAScript's exponent thresholds and shortest roundtrip
	// digits, including removal of exponent padding. Handle -0 above.
	encoded, _ := json.Marshal(value)
	return string(encoded)
}
func quoteJSON(dst []byte, value string) []byte {
	dst = append(dst, '"')
	for _, r := range string(replacementUTF8([]byte(value))) {
		switch r {
		case '"', '\\':
			dst = append(dst, '\\', byte(r))
		case '\b':
			dst = append(dst, '\\', 'b')
		case '\f':
			dst = append(dst, '\\', 'f')
		case '\n':
			dst = append(dst, '\\', 'n')
		case '\r':
			dst = append(dst, '\\', 'r')
		case '\t':
			dst = append(dst, '\\', 't')
		default:
			if r < 0x20 {
				dst = append(dst, fmt.Sprintf("\\u%04x", r)...)
			} else {
				dst = append(dst, string(r)...)
			}
		}
	}
	return append(dst, '"')
}
func appendJSON(dst []byte, value reflect.Value, seen map[visit]bool) ([]byte, error) {
	if !value.IsValid() {
		return append(dst, "null"...), nil
	}
	for value.Kind() == reflect.Interface || value.Kind() == reflect.Pointer {
		if value.IsNil() {
			return append(dst, "null"...), nil
		}
		if value.Kind() == reflect.Pointer {
			if _, ok := value.Interface().(*big.Int); ok {
				return nil, errors.New("JSON cannot encode a bigint")
			}
			key := visit{value.Kind(), value.Pointer()}
			if seen[key] {
				return nil, errors.New("cyclic JSON value")
			}
			seen[key] = true
			defer delete(seen, key)
		}
		value = value.Elem()
	}
	if value.CanInterface() {
		if IsAbsent(value.Interface()) {
			return append(dst, "null"...), nil
		}
		if _, ok := value.Interface().(big.Int); ok {
			return nil, errors.New("JSON cannot encode a bigint")
		}
		if object, ok := value.Interface().(JSONObject); ok {
			key := visit{value.Kind(), value.Pointer()}
			if seen[key] {
				return nil, errors.New("cyclic JSON object")
			}
			seen[key] = true
			defer delete(seen, key)
			return appendObject(dst, object, seen)
		}
		if binary, ok := value.Interface().([]byte); ok {
			data := make([]any, len(binary))
			for i, b := range binary {
				data[i] = b
			}
			return appendObject(dst, JSONObject{{"type", "Buffer"}, {"data", data}}, seen)
		}
	}
	if number, ok := scalarNumber(value); ok {
		if math.IsNaN(number) || math.IsInf(number, 0) {
			return append(dst, "null"...), nil
		}
		return append(dst, numberString(number)...), nil
	}
	switch value.Kind() {
	case reflect.String:
		return quoteJSON(dst, value.String()), nil
	case reflect.Bool:
		return strconv.AppendBool(dst, value.Bool()), nil
	case reflect.Slice, reflect.Array:
		if value.Kind() == reflect.Slice && value.IsNil() {
			return append(dst, "null"...), nil
		}
		if value.Kind() == reflect.Slice {
			key := visit{value.Kind(), value.Pointer()}
			if seen[key] {
				return nil, errors.New("cyclic JSON array")
			}
			seen[key] = true
			defer delete(seen, key)
		}
		dst = append(dst, '[')
		for i := 0; i < value.Len(); i++ {
			if i > 0 {
				dst = append(dst, ',')
			}
			var err error
			dst, err = appendJSON(dst, value.Index(i), seen)
			if err != nil {
				return nil, err
			}
		}
		return append(dst, ']'), nil
	case reflect.Map:
		if value.IsNil() {
			return append(dst, "null"...), nil
		}
		if value.Type().Key().Kind() != reflect.String {
			return nil, errors.New("JSON object keys must be strings")
		}
		key := visit{value.Kind(), value.Pointer()}
		if seen[key] {
			return nil, errors.New("cyclic JSON object")
		}
		seen[key] = true
		defer delete(seen, key)
		names := value.MapKeys()
		sort.Slice(names, func(i, j int) bool { return utf16Less(names[i].String(), names[j].String()) })
		object := make(JSONObject, 0, len(names))
		for _, name := range names {
			object = append(object, JSONMember{name.String(), value.MapIndex(name).Interface()})
		}
		return appendObject(dst, object, seen)
	case reflect.Struct:
		// Native structs opt into Go's public JSON field/tag conventions, then the
		// resulting JSON domain uses the same portable number/string encoding.
		raw, err := json.Marshal(value.Interface())
		if err != nil {
			return nil, err
		}
		var object any
		if err = json.Unmarshal(raw, &object); err != nil {
			return nil, err
		}
		return appendJSON(dst, reflect.ValueOf(object), seen)
	default:
		return nil, fmt.Errorf("unsupported JSON value %s", value.Kind())
	}
}
func arrayIndex(name string) (uint64, bool) {
	n, e := strconv.ParseUint(name, 10, 32)
	return n, e == nil && n < 4294967295 && strconv.FormatUint(n, 10) == name
}
func appendObject(dst []byte, object JSONObject, seen map[visit]bool) ([]byte, error) {
	// Repeated properties replace their value without moving their first position.
	unique := make(JSONObject, 0, len(object))
	indices := map[string]int{}
	for _, member := range object {
		if index, ok := indices[member.Name]; ok {
			unique[index] = member
		} else {
			indices[member.Name] = len(unique)
			unique = append(unique, member)
		}
	}
	sort.SliceStable(unique, func(i, j int) bool {
		a, ai := arrayIndex(unique[i].Name)
		b, bi := arrayIndex(unique[j].Name)
		if ai && bi {
			return a < b
		}
		return ai && !bi
	})
	dst = append(dst, '{')
	first := true
	for _, member := range unique {
		if IsAbsent(member.Value) {
			continue
		}
		if !first {
			dst = append(dst, ',')
		}
		first = false
		dst = quoteJSON(dst, member.Name)
		dst = append(dst, ':')
		var err error
		dst, err = appendJSON(dst, reflect.ValueOf(member.Value), seen)
		if err != nil {
			return nil, err
		}
	}
	return append(dst, '}'), nil
}

// SemanticEqual is strict deep equality for the portable value domain: numbers
// are one IEEE-754 type, NaN equals NaN, signed zeros differ, object key order is
// irrelevant, and Absent differs from null. Byte payloads remain typed bytes.
func SemanticEqual(left, right any) bool {
	return semanticEqual(reflect.ValueOf(left), reflect.ValueOf(right), make(map[[2]visit]bool))
}
func semanticEqual(a, b reflect.Value, seen map[[2]visit]bool) bool {
	for a.IsValid() && a.Kind() == reflect.Interface {
		a = a.Elem()
	}
	for b.IsValid() && b.Kind() == reflect.Interface {
		b = b.Elem()
	}
	if !a.IsValid() || !b.IsValid() {
		return !a.IsValid() && !b.IsValid()
	}
	if IsAbsent(a.Interface()) || IsAbsent(b.Interface()) {
		return IsAbsent(a.Interface()) && IsAbsent(b.Interface())
	}
	_, aObject := a.Interface().(JSONObject)
	_, bObject := b.Interface().(JSONObject)
	if aObject || bObject {
		if a.Kind() != reflect.Map && !aObject || b.Kind() != reflect.Map && !bObject {
			return false
		}
		key := [2]visit{{a.Kind(), a.Pointer()}, {b.Kind(), b.Pointer()}}
		if seen[key] {
			return true
		}
		seen[key] = true
		asMap := func(value reflect.Value) reflect.Value {
			if object, ok := value.Interface().(JSONObject); ok {
				values := make(map[string]any, len(object))
				for _, member := range object {
					values[member.Name] = member.Value
				}
				return reflect.ValueOf(values)
			}
			return value
		}
		return semanticEqual(asMap(a), asMap(b), seen)
	}
	an, aok := scalarNumber(a)
	bn, bok := scalarNumber(b)
	if aok || bok {
		return aok && bok && (math.IsNaN(an) && math.IsNaN(bn) || an == bn && (an != 0 || math.Signbit(an) == math.Signbit(bn)))
	}
	if a.Kind() != b.Kind() {
		return false
	}
	switch a.Kind() {
	case reflect.Pointer:
		if a.IsNil() || b.IsNil() {
			return a.IsNil() && b.IsNil()
		}
		key := [2]visit{{a.Kind(), a.Pointer()}, {b.Kind(), b.Pointer()}}
		if seen[key] {
			return true
		}
		seen[key] = true
		return semanticEqual(a.Elem(), b.Elem(), seen)
	case reflect.Slice, reflect.Array:
		if (a.Type().Elem().Kind() == reflect.Uint8) != (b.Type().Elem().Kind() == reflect.Uint8) {
			return false
		}
		if a.Len() != b.Len() {
			return false
		}
		if a.Kind() == reflect.Slice {
			if a.IsNil() != b.IsNil() {
				return false
			}
			key := [2]visit{{a.Kind(), a.Pointer()}, {b.Kind(), b.Pointer()}}
			if seen[key] {
				return true
			}
			seen[key] = true
		}
		for i := 0; i < a.Len(); i++ {
			if !semanticEqual(a.Index(i), b.Index(i), seen) {
				return false
			}
		}
		return true
	case reflect.Map:
		if a.Type().Key() != b.Type().Key() || a.Len() != b.Len() || a.IsNil() != b.IsNil() {
			return false
		}
		key := [2]visit{{a.Kind(), a.Pointer()}, {b.Kind(), b.Pointer()}}
		if seen[key] {
			return true
		}
		seen[key] = true
		for _, k := range a.MapKeys() {
			bv := b.MapIndex(k)
			if !bv.IsValid() || !semanticEqual(a.MapIndex(k), bv, seen) {
				return false
			}
		}
		return true
	default:
		return reflect.DeepEqual(a.Interface(), b.Interface())
	}
}

const MaxDecompressedBytes = 512 * 1024 * 1024
const DefaultCompressionThresholdBytes = 4096
const DefaultZstdLevel = 3

type CompressionConfig struct {
	ThresholdBytes int
	Level          int
}
type CompressionWriteResult struct {
	Payload                    Payload
	Outcome                    string
	OriginalBytes, StoredBytes int
}
type CompressionReadResult struct {
	Payload Payload
	Outcome string
}

func ResolveCompressionConfig(config *CompressionConfig) (CompressionConfig, error) {
	result := CompressionConfig{DefaultCompressionThresholdBytes, DefaultZstdLevel}
	if config != nil {
		result = *config
		if result.ThresholdBytes == 0 {
			result.ThresholdBytes = DefaultCompressionThresholdBytes
		}
		if result.Level == 0 {
			result.Level = DefaultZstdLevel
		}
	}
	if result.ThresholdBytes < 1 || uint64(result.ThresholdBytes) > MaxSafeInteger || result.Level < 1 || result.Level > 22 {
		return result, errors.New("invalid compression threshold or level")
	}
	return result, nil
}
func EscapeRawPayload(payload Payload) Payload {
	if payload.Binary && len(payload.Bytes) > 0 && payload.Bytes[0] <= 2 {
		return Payload{Binary: true, Bytes: append([]byte{0}, payload.Bytes...)}
	}
	return payload
}
func CompressPayload(payload Payload, config CompressionConfig, limit ...int) (CompressionWriteResult, error) {
	maximum := MaxDecompressedBytes
	if len(limit) > 0 {
		maximum = limit[0]
	}
	resolved, err := ResolveCompressionConfig(&config)
	if err != nil {
		return CompressionWriteResult{}, err
	}
	if !payload.Binary {
		payload.Bytes = replacementUTF8(payload.Bytes)
	}
	raw := EscapeRawPayload(payload)
	result := CompressionWriteResult{raw, "below_threshold", len(payload.Bytes), len(raw.Bytes)}
	if len(payload.Bytes) < resolved.ThresholdBytes {
		return result, nil
	}
	if len(payload.Bytes) > maximum {
		result.Outcome = "write_over_limit"
		return result, nil
	}
	writer, err := zstd.NewWriter(nil, zstd.WithEncoderConcurrency(1), zstd.WithEncoderLevel(zstd.EncoderLevelFromZstd(resolved.Level)), zstd.WithEncoderCRC(false))
	if err != nil {
		return result, err
	}
	defer writer.Close()
	compressed := writer.EncodeAll(payload.Bytes, nil)
	result.Outcome = "not_smaller"
	if len(compressed)+1 >= len(raw.Bytes) {
		return result, nil
	}
	marker := byte(1)
	if payload.Binary {
		marker = 2
	}
	result.Payload = Payload{Binary: true, Bytes: append([]byte{marker}, compressed...)}
	result.Outcome = "compressed"
	result.StoredBytes = len(result.Payload.Bytes)
	return result, nil
}
func DecompressPayload(payload Payload, limit ...int) CompressionReadResult {
	result := CompressionReadResult{payload, "passthrough"}
	if !payload.Binary || len(payload.Bytes) == 0 {
		return result
	}
	marker := payload.Bytes[0]
	if marker == 0 {
		if len(payload.Bytes) > 1 && payload.Bytes[1] <= 2 {
			result.Payload.Bytes = append([]byte{}, payload.Bytes[1:]...)
		}
		return result
	}
	if marker != 1 && marker != 2 {
		return result
	}
	maximum := MaxDecompressedBytes
	if len(limit) > 0 {
		maximum = limit[0]
	}
	if maximum < 0 {
		result.Outcome = "read_over_limit"
		return result
	}
	body, err := firstZstdFrame(payload.Bytes[1:])
	if err != nil {
		result.Outcome = "fallback_raw"
		return result
	}
	reader, err := zstd.NewReader(bytes.NewReader(body), zstd.WithDecoderConcurrency(1), zstd.WithDecoderMaxMemory(MaxDecompressedBytes))
	if err != nil {
		result.Outcome = "fallback_raw"
		return result
	}
	defer reader.Close()
	decoded, err := io.ReadAll(io.LimitReader(reader, int64(maximum)+1))
	if len(decoded) > maximum {
		result.Outcome = "read_over_limit"
		return result
	}
	if err != nil {
		result.Outcome = "fallback_raw"
		if errors.Is(err, zstd.ErrDecoderSizeExceeded) || strings.Contains(err.Error(), "window size exceeded") {
			result.Outcome = "read_over_limit"
		}
		return result
	}
	if marker == 1 {
		decoded = replacementUTF8(decoded)
	}
	return CompressionReadResult{Payload{Bytes: decoded, Binary: marker == 2}, "decompressed"}
}

// Node's synchronous decoder consumes one zstd frame and ignores its trailer,
// including a second valid frame. Restrict the Go stream decoder to the same
// first-frame boundary. Truncated bodies use the nonthrowing raw fallback.
func firstZstdFrame(body []byte) ([]byte, error) {
	var header zstd.Header
	if err := header.Decode(body); err != nil {
		return nil, err
	}
	end := header.HeaderSize
	if header.Skippable {
		if uint64(header.SkippableSize) > uint64(len(body)-end) {
			return nil, io.ErrUnexpectedEOF
		}
		return body[:end+int(header.SkippableSize)], nil
	}
	for {
		if len(body)-end < 3 {
			return nil, io.ErrUnexpectedEOF
		}
		block := uint32(body[end]) | uint32(body[end+1])<<8 | uint32(body[end+2])<<16
		last, kind, size := block&1 != 0, (block>>1)&3, int(block>>3)
		end += 3
		if kind == 3 {
			return nil, errors.New("reserved zstd block type")
		}
		if kind == 1 {
			size = 1
		}
		if len(body)-end < size {
			return nil, io.ErrUnexpectedEOF
		}
		end += size
		if last {
			break
		}
	}
	if header.HasCheckSum {
		if len(body)-end < 4 {
			return nil, io.ErrUnexpectedEOF
		}
		end += 4
	}
	return body[:end], nil
}
