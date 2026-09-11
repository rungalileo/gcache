package dialcache

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

const MaxSafeInteger = uint64(9007199254740991)
const MaxSupportedDurationMS = int64(31536000000)
const MaxTrackedValueTTLMS = int64(3600000)

// CeilSupportedCacheTTLMS is the adapter-level duration boundary. Fractional
// milliseconds round up, before checking the positive, 365-day limit.
func CeilSupportedCacheTTLMS(value float64) (int64, error) {
	ceiled := math.Ceil(value)
	if math.IsNaN(ceiled) || math.IsInf(ceiled, 0) || ceiled <= 0 || ceiled > float64(MaxSupportedDurationMS) {
		return 0, errors.New("cache TTL must be positive and no greater than 365 days")
	}
	return int64(ceiled), nil
}

func ValidateTimestampMS(value float64) (uint64, error) {
	if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || math.Trunc(value) != value || value > float64(MaxSafeInteger) {
		return 0, errors.New("timestamp must be a nonnegative safe integer")
	}
	return uint64(value), nil
}

// NormalizeArgs omits Absent, converts the supported scalar domain using the
// JavaScript String rules, and orders names lexicographically by UTF-16 units.
// Arbitrary precision integers use big.Int; objects and arrays are rejected.
func NormalizeArgs(args map[string]any) ([][2]string, error) {
	result := make([][2]string, 0, len(args))
	for name, value := range args {
		if IsAbsent(value) {
			continue
		}
		if !utf8.ValidString(name) {
			return nil, errors.New("argument name must contain Unicode scalars")
		}
		var text string
		switch value := value.(type) {
		case nil:
			text = "null"
		case string:
			text = value
		case bool:
			text = strconv.FormatBool(value)
		case big.Int:
			text = value.String()
		case *big.Int:
			if value == nil {
				return nil, errors.New("nil bigint")
			}
			text = value.String()
		default:
			number, ok := scalarNumber(reflect.ValueOf(value))
			if !ok {
				return nil, fmt.Errorf("unsupported argument value %T", value)
			}
			text = numberString(number)
		}
		if !utf8.ValidString(text) {
			return nil, errors.New("argument value must contain Unicode scalars")
		}
		result = append(result, [2]string{name, text})
	}
	sort.Slice(result, func(i, j int) bool { return utf16Less(result[i][0], result[j][0]) })
	return result, nil
}

func utf16Less(left, right string) bool {
	a, b := utf16.Encode([]rune(left)), utf16.Encode([]rune(right))
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return len(a) < len(b)
}

// Identity is an already normalized logical identity. Ordered arguments retain
// caller order; normalization of host-language objects is a separate profile.
type Identity struct {
	Namespace string      `json:"namespace"`
	KeyType   string      `json:"keyType"`
	ID        string      `json:"id"`
	UseCase   string      `json:"useCase"`
	Tracked   bool        `json:"trackForInvalidation"`
	Args      [][2]string `json:"args"`
}

func escape(s string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for _, v := range []byte(s) {
		if v >= 'a' && v <= 'z' || v >= 'A' && v <= 'Z' || v >= '0' && v <= '9' || strings.ContainsRune("~!*'()-._", rune(v)) {
			b.WriteByte(v)
		} else {
			b.WriteByte('%')
			b.WriteByte(hex[v>>4])
			b.WriteByte(hex[v&15])
		}
	}
	return b.String()
}

func (id Identity) Keys() (logical, value, watermark string, err error) {
	parts := []string{id.Namespace}
	if id.Tracked {
		parts = append(parts, id.KeyType, id.ID)
	}
	for _, part := range parts {
		if strings.ContainsAny(part, "{}") {
			return "", "", "", errors.New("identity contains a reserved hash-tag delimiter")
		}
	}
	for _, part := range []string{id.Namespace, id.KeyType, id.ID, id.UseCase} {
		if !utf8.ValidString(part) {
			return "", "", "", errors.New("identity must contain valid Unicode scalars")
		}
	}
	for _, arg := range id.Args {
		if !utf8.ValidString(arg[0]) || !utf8.ValidString(arg[1]) {
			return "", "", "", errors.New("argument must contain valid Unicode scalars")
		}
	}
	entity := escape(id.Namespace) + ":" + escape(id.KeyType) + ":" + escape(id.ID)
	logical = entity
	if id.Tracked {
		logical = "{" + entity + "}"
		watermark = logical + "#watermark"
	}
	for index, arg := range id.Args {
		if index == 0 {
			logical += "?"
		} else {
			logical += "&"
		}
		logical += escape(arg[0]) + "=" + escape(arg[1])
	}
	logical += "#" + escape(id.UseCase)
	return logical, logical + ":dialcache-frame-v1", watermark, nil
}

// Cohort preserves FNV-1a over UTF-16 code units, including surrogate pairs.
func Cohort(logical, discriminator string) float64 {
	hash := uint32(0x811c9dc5)
	for _, unit := range utf16.Encode([]rune(logical + ":" + discriminator)) {
		hash ^= uint32(unit)
		hash *= 0x01000193
	}
	return float64(hash) / 4294967296 * 100
}

type Frame struct {
	CreatedAtMS uint64
	Binary      bool
	Payload     []byte
}
type ReadResult struct {
	Kind                string
	Reason              string
	ObservedWatermarkMS *uint64
	Frame               Frame
	// RawSet marks an untrusted semantic adapter result, including explicit nil.
	Raw    any
	RawSet bool
}

func RawReadResult(value any) ReadResult { return ReadResult{Raw: value, RawSet: true} }

// NormalizeReadResult is the core trust boundary, above wire decoding. Miss
// reason and refill fence are validated independently. Frame-shaped objects
// ignore stray miss metadata; only kind:"miss" selects the miss branch.
func NormalizeReadResult(result ReadResult, tracked bool) ReadResult {
	if result.RawSet {
		object, ok := result.Raw.(map[string]any)
		if !ok {
			return ReadResult{Kind: "miss", Reason: "unclassified"}
		}
		if object["kind"] == "miss" {
			reason, _ := object["reason"].(string)
			result = ReadResult{Kind: "miss", Reason: reason}
			if number, ok := scalarNumber(reflect.ValueOf(object["observedWatermarkMs"])); ok {
				if stamp, err := ValidateTimestampMS(number); err == nil {
					result.ObservedWatermarkMS = &stamp
				}
			}
		} else {
			number, ok := scalarNumber(reflect.ValueOf(object["createdAtMs"]))
			stamp, err := ValidateTimestampMS(number)
			if !ok || err != nil {
				return ReadResult{Kind: "miss", Reason: "unclassified"}
			}
			frame := Frame{CreatedAtMS: stamp}
			switch payload := object["payload"].(type) {
			case string:
				frame.Payload = []byte(payload)
			case []byte:
				frame.Payload = append([]byte{}, payload...)
				frame.Binary = true
			}
			result = ReadResult{Kind: "hit", Frame: frame}
		}
	}
	if result.Kind == "miss" {
		if !tracked || result.ObservedWatermarkMS != nil && *result.ObservedWatermarkMS > MaxSafeInteger {
			result.ObservedWatermarkMS = nil
		}
		switch result.Reason {
		case "value_absent", "expired", "unclassified":
		case "watermark_fenced":
			if result.ObservedWatermarkMS == nil {
				result.Reason = "unclassified"
			}
		default:
			result.Reason = "unclassified"
		}
		return ReadResult{Kind: "miss", Reason: result.Reason, ObservedWatermarkMS: result.ObservedWatermarkMS}
	}
	if result.Kind == "hit" {
		if result.Frame.CreatedAtMS > MaxSafeInteger {
			return ReadResult{Kind: "miss", Reason: "unclassified"}
		}
		return ReadResult{Kind: "hit", Frame: result.Frame}
	}
	// Wire payload failures remain errors; malformed semantic kinds become misses.
	if result.Kind == "payload_encoding_error" {
		return result
	}
	return ReadResult{Kind: "miss", Reason: "unclassified"}
}

// EncodeFrame accepts only the writer timestamp domain. DecodeFrame retains
// uint64 precision and leaves the additional safe-timestamp check to the core.
func EncodeFrame(frame Frame) ([]byte, error) {
	if frame.CreatedAtMS > MaxSafeInteger {
		return nil, errors.New("unsafe writer timestamp")
	}
	if !frame.Binary {
		frame.Payload = replacementUTF8(frame.Payload)
	}
	out := make([]byte, 10+len(frame.Payload))
	out[0] = 1
	binary.BigEndian.PutUint64(out[1:9], frame.CreatedAtMS)
	if frame.Binary {
		out[9] = 1
	}
	copy(out[10:], frame.Payload)
	return out, nil
}

func parseWatermark(raw *string) (*uint64, bool) {
	if raw == nil {
		return nil, true
	}
	if *raw == "" {
		return nil, false
	}
	for _, char := range *raw {
		if char < '0' || char > '9' {
			return nil, false
		}
	}
	// Leading zeroes are accepted even if they exceed the machine integer width.
	s := strings.TrimLeft(*raw, "0")
	if s == "" {
		s = "0"
	}
	value, err := strconv.ParseUint(s, 10, 64)
	if err != nil || value > MaxSafeInteger {
		return nil, false
	}
	return &value, true
}

// DecodeFrame implements the protocol's classification precedence. A nil raw
// value is absent; a present zero-length value is an unclassified miss.
func DecodeFrame(raw []byte, tracked bool, watermark *string) ReadResult {
	var fence *uint64
	validMarker := true
	if tracked {
		fence, validMarker = parseWatermark(watermark)
	}
	miss := func(reason string) ReadResult {
		return ReadResult{Kind: "miss", Reason: reason, ObservedWatermarkMS: fence}
	}
	if raw == nil {
		return miss("value_absent")
	}
	if len(raw) < 10 || raw[0] != 1 {
		return miss("unclassified")
	}
	stamp := binary.BigEndian.Uint64(raw[1:9])
	if tracked && (!validMarker || stamp == 0) {
		return miss("unclassified")
	}
	if tracked && fence != nil && stamp <= *fence {
		return miss("watermark_fenced")
	}
	if raw[9] > 1 {
		return ReadResult{Kind: "payload_encoding_error"}
	}
	payload := append([]byte{}, raw[10:]...)
	if raw[9] == 0 {
		payload = replacementUTF8(payload)
	}
	return ReadResult{Kind: "hit", Frame: Frame{CreatedAtMS: stamp, Binary: raw[9] == 1, Payload: payload}}
}

// replacementUTF8 emits one replacement for each maximal ill-formed subpart.
// A valid incomplete prefix (E2 82) is one subpart; forbidden continuation bytes
// (ED A0 80, an encoded surrogate) are not swallowed into that prefix.
func replacementUTF8(raw []byte) []byte {
	out := make([]byte, 0, len(raw))
	for len(raw) > 0 {
		r, size := utf8.DecodeRune(raw)
		if r != utf8.RuneError || size != 1 {
			out = append(out, raw[:size]...)
			raw = raw[size:]
			continue
		}
		wanted := 1
		if raw[0] >= 0xc2 && raw[0] <= 0xdf {
			wanted = 2
		}
		if raw[0] >= 0xe0 && raw[0] <= 0xef {
			wanted = 3
		}
		if raw[0] >= 0xf0 && raw[0] <= 0xf4 {
			wanted = 4
		}
		consumed := 1
		for consumed < wanted && consumed < len(raw) {
			b := raw[consumed]
			if b < 0x80 || b > 0xbf {
				break
			}
			if consumed == 1 && (raw[0] == 0xe0 && b < 0xa0 || raw[0] == 0xed && b > 0x9f || raw[0] == 0xf0 && b < 0x90 || raw[0] == 0xf4 && b > 0x8f) {
				break
			}
			consumed++
		}
		out = utf8.AppendRune(out, utf8.RuneError)
		raw = raw[consumed:]
	}
	return out
}

// UnmarshalJSON rejects isolated UTF-16 escapes before encoding/json replaces
// them. The Go API uses Unicode scalar strings; this is its fixture boundary.
func (id *Identity) UnmarshalJSON(raw []byte) error {
	for i := 0; i+5 < len(raw); i++ {
		if raw[i] != '\\' {
			continue
		}
		if raw[i+1] == '\\' {
			i++
			continue
		}
		if raw[i+1] != 'u' {
			continue
		}
		v, err := strconv.ParseUint(string(raw[i+2:i+6]), 16, 16)
		if err != nil {
			return err
		}
		if v >= 0xd800 && v <= 0xdbff {
			if i+11 >= len(raw) || string(raw[i+6:i+8]) != "\\u" {
				return errors.New("isolated high surrogate in identity")
			}
			low, err := strconv.ParseUint(string(raw[i+8:i+12]), 16, 16)
			if err != nil || low < 0xdc00 || low > 0xdfff {
				return errors.New("isolated high surrogate in identity")
			}
			i += 11
		} else if v >= 0xdc00 && v <= 0xdfff {
			return errors.New("isolated low surrogate in identity")
		} else {
			i += 5
		}
	}
	type plain Identity
	return json.Unmarshal(raw, (*plain)(id))
}

func (r ReadResult) Error() error {
	if r.Kind == "hit" || r.Kind == "miss" {
		return nil
	}
	return fmt.Errorf("remote result: %s", r.Kind)
}
