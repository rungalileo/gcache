package dialcache

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
	"unicode/utf8"
)

const replaySettlement = "causally-ready-v1"

// Observation definitions a prepare result may name. Every observation the
// driver reports is validated against the named definition before it is sent.
var replayObservationDefinitions = map[string]bool{"behaviorObservation": true, "coreObservation": true, "localClockObservation": true}

func readReplaySchema() (obj, error) {
	raw, err := os.ReadFile("../formal/replay/protocol.schema.json")
	if err != nil {
		return nil, err
	}
	var schema obj
	if err := json.Unmarshal(raw, &schema); err != nil {
		return nil, err
	}
	if err := validateReplaySchema(schema); err != nil {
		return nil, err
	}
	return schema, nil
}

// Start outside a synctest bubble. The watchdog observes real process time;
// request/reply IO never consumes a virtual deadline or releases a cache gate.
type replayCoordinator struct {
	schema   obj
	command  *exec.Cmd
	input    io.WriteCloser
	output   *bufio.Reader
	lock     sync.Mutex
	sequence int64
	realNow  atomic.Int64
	pending  atomic.Int64
	stopped  atomic.Bool
}

func newReplayCoordinator(t *testing.T) *replayCoordinator {
	t.Helper()
	executable, err := exec.LookPath("node")
	if err != nil {
		t.Fatal("shared replay requires Node on PATH: ", err)
	}
	program, err := filepath.Abs("../formal/replay/coordinator.mjs")
	if err != nil {
		t.Fatal(err)
	}
	return startReplayCoordinator(t, exec.Command(executable, program), 30*time.Second, false)
}

// Test controls can substitute a broken transport without replacing any cache
// implementation. Production replay always uses the shared coordinator above.
func startReplayCoordinator(t *testing.T, command *exec.Cmd, timeout time.Duration, expectProcessFailure bool) *replayCoordinator {
	t.Helper()
	c := &replayCoordinator{command: command}
	schema, err := readReplaySchema()
	if err != nil {
		t.Fatal(err)
	}
	c.schema = schema

	c.input, err = c.command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := c.command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	c.output = bufio.NewReader(output)
	var stderr bytes.Buffer
	c.command.Stderr = &stderr
	if err := c.command.Start(); err != nil {
		t.Fatal(err)
	}
	c.realNow.Store(time.Now().UnixNano())
	go func() {
		ticker := time.NewTicker(10 * time.Millisecond)
		defer ticker.Stop()
		for !c.stopped.Load() {
			now := <-ticker.C
			c.realNow.Store(now.UnixNano())
			if since := c.pending.Load(); since != 0 && now.UnixNano()-since > int64(timeout) {
				_ = c.command.Process.Kill()
				return
			}
		}
	}()
	t.Cleanup(func() {
		// Keep the real-time watchdog armed while closing: a child that ignores
		// EOF must not hang the suite after the last successful RPC.
		c.pending.Store(c.realNow.Load())
		_ = c.input.Close()
		err := c.command.Wait()
		c.stopped.Store(true)
		if err != nil && !expectProcessFailure {
			t.Errorf("shared replay process failed: %v\n%s", err, stderr.String())
		}
	})
	return c
}
func (c *replayCoordinator) call(request obj) (obj, error) {
	c.lock.Lock()
	defer c.lock.Unlock()
	c.sequence++
	request["version"], request["id"] = 1, c.sequence
	raw, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	c.pending.Store(c.realNow.Load())
	defer c.pending.Store(0)
	if _, err = c.input.Write(append(raw, '\n')); err != nil {
		return nil, fmt.Errorf("coordinator write failed: %w", err)
	}
	line, err := readReplayLine(c.output, 64*1024*1024)
	if err != nil {
		return nil, fmt.Errorf("coordinator unavailable or exceeded real-time request limit: %w", err)
	}
	if err := validateBehaviorJSON(line); err != nil {
		return nil, err
	}
	var response struct {
		Version int    `json:"version"`
		ID      int64  `json:"id"`
		OK      bool   `json:"ok"`
		Result  obj    `json:"result"`
		Error   string `json:"error"`
	}
	decoder := json.NewDecoder(bytes.NewReader(line))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&response); err != nil {
		return nil, err
	}
	var envelope obj
	if err := json.Unmarshal(line, &envelope); err != nil {
		return nil, err
	}
	if (response.OK && behaviorKeys(envelope) != "id,ok,result,version") ||
		(!response.OK && behaviorKeys(envelope) != "error,id,ok,version") {
		return nil, fmt.Errorf("malformed coordinator envelope")
	}
	if response.Version != 1 || response.ID != c.sequence {
		return nil, fmt.Errorf("unknown or out-of-sequence coordinator response")
	}
	if !response.OK {
		if response.Error == "" || response.Result != nil {
			return nil, fmt.Errorf("malformed coordinator failure")
		}
		return nil, fmt.Errorf("shared replay: %s", response.Error)
	}
	if response.Error != "" || response.Result == nil {
		return nil, fmt.Errorf("malformed coordinator success")
	}
	return response.Result, nil
}
func (c *replayCoordinator) prepare(profile, path string, raw []byte) (obj, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	request := obj{"op": "prepare", "profile": profile, "path": absolute}
	if raw != nil {
		request["raw"] = string(raw)
	}
	result, err := c.call(request)
	if err != nil {
		return nil, err
	}
	if behaviorKeys(result) != "actions,fixture,observation,session,settlement,setup,steps" || result["settlement"] != replaySettlement || bs(result["session"]) == "" || !replayIndex(result["steps"], 2) {
		return nil, fmt.Errorf("malformed replay preparation")
	}
	if definition := bs(result["observation"]); !replayObservationDefinitions[definition] || bm(c.schema["$defs"])[definition] == nil {
		return nil, fmt.Errorf("malformed replay observation definition %q", definition)
	}
	if _, ok := result["fixture"].(map[string]any); !ok {
		return nil, fmt.Errorf("malformed replay fixture")
	}
	setup, ok := result["setup"].([]any)
	if !ok || !c.replayCommands(setup) {
		return nil, fmt.Errorf("malformed replay setup")
	}
	actions, ok := result["actions"].([]any)
	if !ok || int64(len(actions)) != bn(result["steps"]) {
		return nil, fmt.Errorf("malformed replay actions")
	}
	for index, action := range actions {
		if bs(action) == "" || (index == 0) != (action == "init") {
			return nil, fmt.Errorf("malformed replay action")
		}
	}

	return result, nil
}
func (c *replayCoordinator) replay(d *behaviorDriver, prepared obj, monitors ...func() error) error {
	return c.execute(prepared, d.apply, d.observation, d.clock.WallMS, monitors...)
}
func (c *replayCoordinator) execute(prepared obj, apply func(obj) error, observation func() obj, wallMS func() int64, monitors ...func() error) error {
	session := bs(prepared["session"])
	complete := false
	defer func() {
		if !complete {
			_, _ = c.call(obj{"op": "discard", "session": session})
		}
	}()
	for _, input := range ba(prepared["setup"]) {
		if err := apply(bm(input)); err != nil {
			return err
		}
	}
	for index := int64(0); index < bn(prepared["steps"]); index++ {
		for _, monitor := range monitors {
			if err := monitor(); err != nil {
				return err
			}
		}
		// A malformed record is a driver defect. Attribute it here, before the
		// coordinator sees it, so no round trip or session state is spent on it.
		observed := observation()
		if err := replayObservationError(observed, bs(prepared["observation"]), bm(c.schema["$defs"])); err != nil {
			return err
		}
		result, err := c.call(obj{"op": "observe", "session": session, "index": index, "settlement": replaySettlement, "observed": observed, "environment": obj{"wallMs": wallMS()}})
		if err != nil {
			return err
		}
		if result["complete"] == true {
			if behaviorKeys(result) != "complete,steps" || index+1 != bn(prepared["steps"]) || !replayIndex(result["steps"], 2) || bn(result["steps"]) != index+1 {
				return fmt.Errorf("premature or malformed replay completion")
			}
			complete = true
			return nil
		}
		if behaviorKeys(result) != "complete,index,inputs" || result["complete"] != false || !replayIndex(result["index"], 1) || bn(result["index"]) != index+1 || len(ba(result["inputs"])) == 0 || !c.replayCommands(ba(result["inputs"])) {
			return fmt.Errorf("malformed next replay command")
		}
		for _, input := range ba(result["inputs"]) {
			if err := apply(bm(input)); err != nil {
				return err
			}
		}
	}
	return fmt.Errorf("replay ended without completion")
}

func replayIndex(value any, minimum int64) bool {
	n, ok := value.(float64)
	return ok && n >= float64(minimum) && n <= 9007199254740991 && n == float64(int64(n))
}

// replayObservationError validates one driver observation against the $defs
// definition the prepare result named. It checks the wire encoding, so Go
// integers, typed slices and nested maps are judged exactly as the coordinator
// decodes them. The diagnostic never carries expected/actual comparison
// markers: a shape defect is infrastructure evidence, not a mutation detection.
func replayObservationError(observed any, definition string, definitions obj) error {
	target, ok := definitions[definition].(map[string]any)
	if !ok || !replayObservationDefinitions[definition] {
		return fmt.Errorf("unknown replay observation definition %q", definition)
	}
	raw, err := json.Marshal(observed)
	if err != nil {
		return fmt.Errorf("driver produced an unencodable %s observation: %w", definition, err)
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return fmt.Errorf("driver produced an unencodable %s observation: %w", definition, err)
	}
	if !matchesReplaySchema(decoded, target, definitions) {
		return fmt.Errorf("driver produced a malformed %s observation: %s", definition, raw)
	}
	return nil
}

func (c *replayCoordinator) replayCommands(inputs []any) bool {
	definitions := bm(c.schema["$defs"])
	for _, input := range inputs {
		if !matchesReplaySchema(input, bm(definitions["command"]), definitions) {
			return false
		}
	}
	return true
}

// Each implementation interprets schema mechanics, not a second copy of the
// profile command fields. The shared schema owns required/optional arguments.
func validateReplaySchema(rule obj) error {
	keywords := map[string]bool{}
	for _, key := range strings.Fields("$schema $id $defs $ref title description oneOf anyOf const enum type properties required additionalProperties items minItems minimum maximum minLength pattern") {
		keywords[key] = true
	}
	for key := range rule {
		if !keywords[key] {
			return fmt.Errorf("unsupported replay schema keyword: %s", key)
		}
	}
	children := []any{}
	for _, key := range []string{"$defs", "properties"} {
		for _, child := range bm(rule[key]) {
			children = append(children, child)
		}
	}
	for _, key := range []string{"oneOf", "anyOf"} {
		children = append(children, ba(rule[key])...)
	}
	for _, key := range []string{"items", "additionalProperties"} {
		if child, ok := rule[key].(map[string]any); ok {
			children = append(children, child)
		}
	}
	for _, child := range children {
		if err := validateReplaySchema(bm(child)); err != nil {
			return err
		}
	}
	return nil
}

func matchesReplaySchema(value any, rule, definitions obj) bool {
	if reference, ok := rule["$ref"].(string); ok {
		name := strings.TrimPrefix(reference, "#/$defs/")
		target, exists := definitions[name]
		return exists && matchesReplaySchema(value, bm(target), definitions)
	}
	if options, ok := rule["oneOf"].([]any); ok {
		matches := 0
		for _, option := range options {
			if matchesReplaySchema(value, bm(option), definitions) {
				matches++
			}
		}
		if matches != 1 {
			return false
		}
	}
	if options, ok := rule["anyOf"].([]any); ok {
		matched := false
		for _, option := range options {
			matched = matched || matchesReplaySchema(value, bm(option), definitions)
		}
		if !matched {
			return false
		}
	}
	if constant, ok := rule["const"]; ok && !reflect.DeepEqual(value, constant) {
		return false
	}
	if options, ok := rule["enum"].([]any); ok {
		matched := false
		for _, option := range options {
			matched = matched || reflect.DeepEqual(value, option)
		}
		if !matched {
			return false
		}
	}
	if expected, ok := rule["type"]; ok {
		types := ba(expected)
		if name, ok := expected.(string); ok {
			types = []any{name}
		}
		matched := false
		for _, name := range types {
			matched = matched || replaySchemaType(value, bs(name))
		}
		if !matched {
			return false
		}
	}
	switch value := value.(type) {
	case float64:
		if minimum, ok := rule["minimum"].(float64); ok && value < minimum {
			return false
		}
		if maximum, ok := rule["maximum"].(float64); ok && value > maximum {
			return false
		}
	case string:
		if minimum, ok := rule["minLength"].(float64); ok && utf8.RuneCountInString(value) < int(minimum) {
			return false
		}
		if pattern, ok := rule["pattern"].(string); ok {
			matched, err := regexp.MatchString(pattern, value)
			if err != nil || !matched {
				return false
			}
		}
	case []any:
		if minimum, ok := rule["minItems"].(float64); ok && len(value) < int(minimum) {
			return false
		}
		if items, ok := rule["items"].(map[string]any); ok {
			for _, item := range value {
				if !matchesReplaySchema(item, items, definitions) {
					return false
				}
			}
		}
	case map[string]any:
		for _, key := range ba(rule["required"]) {
			if _, ok := value[bs(key)]; !ok {
				return false
			}
		}
		properties := bm(rule["properties"])
		for key, item := range value {
			if property, ok := properties[key]; ok {
				if !matchesReplaySchema(item, bm(property), definitions) {
					return false
				}
			} else if rule["additionalProperties"] == false {
				return false
			} else if additional, ok := rule["additionalProperties"].(map[string]any); ok {
				if !matchesReplaySchema(item, additional, definitions) {
					return false
				}
			}
		}
	}
	return true
}

func replaySchemaType(value any, expected string) bool {
	switch expected {
	case "null":
		return value == nil
	case "object":
		_, ok := value.(map[string]any)
		return ok
	case "array":
		_, ok := value.([]any)
		return ok
	case "string":
		_, ok := value.(string)
		return ok
	case "boolean":
		_, ok := value.(bool)
		return ok
	case "integer", "number":
		n, ok := value.(float64)
		return ok && !math.IsNaN(n) && !math.IsInf(n, 0) && (expected == "number" || math.Trunc(n) == n)
	default:
		return false
	}
}

func readReplayLine(reader *bufio.Reader, limit int) ([]byte, error) {
	line := []byte{}
	for {
		fragment, err := reader.ReadSlice('\n')
		if len(line)+len(fragment) > limit {
			return nil, fmt.Errorf("oversized coordinator response")
		}
		line = append(line, fragment...)
		if err == bufio.ErrBufferFull {
			continue
		}
		return line, err
	}
}

func TestReplayCoordinatorDoesNotAdvanceVirtualTime(t *testing.T) {
	coordinator := newReplayCoordinator(t)
	synctest.Test(t, func(t *testing.T) {
		started := time.Now()
		fired := false
		timer := time.AfterFunc(time.Second, func() { fired = true })
		defer timer.Stop()
		for index := 0; index < 20; index++ {
			if _, err := coordinator.call(obj{"op": "profiles"}); err != nil {
				t.Fatal(err)
			}
			synctest.Wait()
		}
		if fired || !time.Now().Equal(started) {
			t.Fatal("coordinator IPC advanced a virtual deadline")
		}
	})
}

func TestReplayCoordinatorRejectsBrokenResponses(t *testing.T) {
	for name, response := range map[string]string{
		"malformed JSON":   `not-json`,
		"unknown version":  `{"version":2,"id":1,"ok":true,"result":{}}`,
		"wrong sequence":   `{"version":1,"id":2,"ok":true,"result":{}}`,
		"unknown member":   `{"version":1,"id":1,"ok":true,"result":{},"extra":true}`,
		"duplicate member": `{"version":1,"id":1,"ok":true,"result":{},"\u0072esult":{}}`,
		"missing status":   `{"version":1,"id":1,"error":"missing status"}`,
		"mixed success":    `{"version":1,"id":1,"ok":true,"result":{},"error":"hidden"}`,
	} {
		t.Run(name, func(t *testing.T) {
			encoded, _ := json.Marshal(response + "\n")
			program := "process.stdin.once('data', () => { process.stdout.write(" + string(encoded) + "); process.stdin.resume(); });"
			coordinator := startReplayCoordinator(t, exec.Command("node", "-e", program), time.Second, false)
			if _, err := coordinator.call(obj{"op": "profiles"}); err == nil {
				t.Fatal("accepted malformed coordinator response")
			}
		})
	}
}

func TestReplayCoordinatorTimesOutAndClosesBrokenProcess(t *testing.T) {
	// Both a blocked RPC and a child ignoring EOF must be bounded by real time.
	// The shortened timeout applies only to this deliberately broken process.
	coordinator := startReplayCoordinator(t, exec.Command("node", "-e", "process.stdin.resume(); setInterval(() => {}, 1000);"), 100*time.Millisecond, true)
	if _, err := coordinator.call(obj{"op": "profiles"}); err == nil {
		t.Fatal("accepted a process that never acknowledged the request")
	}
}

func TestReplayCoordinatorRejectsPrematureCompletionAndEmptyCommands(t *testing.T) {
	for name, result := range map[string]string{
		"premature completion": `{"complete":true,"steps":2}`,
		"empty commands":       `{"complete":false,"index":1,"inputs":[]}`,
		"fractional index":     `{"complete":false,"index":1.5,"inputs":[{"op":"begin"}]}`,
		"non-command input":    `{"complete":false,"index":1,"inputs":[null]}`,
		"missing argument":     `{"complete":false,"index":1,"inputs":[{"op":"resolve"}]}`,
		"wrong argument type":  `{"complete":false,"index":1,"inputs":[{"op":"resolve","loader":"0"}]}`,
		"unexpected argument":  `{"complete":false,"index":1,"inputs":[{"op":"begin","expected":0}]}`,
		"unknown operation":    `{"complete":false,"index":1,"inputs":[{"op":"invented"}]}`,
	} {
		t.Run(name, func(t *testing.T) {
			program := "require('readline').createInterface({input:process.stdin}).on('line', line => { const request=JSON.parse(line); process.stdout.write(JSON.stringify({version:1,id:request.id,ok:true,result:" + result + "})+'\\n'); });"
			coordinator := startReplayCoordinator(t, exec.Command("node", "-e", program), time.Second, false)
			applied := 0
			// A well-formed core observation passes the local shape check, so the
			// coordinator's malformed reply is what execution must reject.
			err := coordinator.execute(obj{"session": "1", "setup": []any{}, "steps": float64(2), "observation": "coreObservation"}, func(obj) error { applied++; return nil }, healthyCoreObservation, func() int64 { return 0 })
			if err == nil || applied != 0 {
				t.Fatalf("malformed reply advanced execution: err=%v, commands=%d", err, applied)
			}
		})
	}
}

// healthyCoreObservation is the flat all-zero record $defs/coreObservation accepts.
func healthyCoreObservation() obj {
	observed := obj{}
	for _, field := range strings.Fields("sourceVersion lastResult outsideLoaderCalls requestLoaderCalls localLoaderCalls coalescedLoaderCalls remoteLoaderCalls redisReads redisWrites") {
		observed[field] = int64(0)
	}
	return observed
}

func TestReplayTransportValidatesObservationsLocally(t *testing.T) {
	schema, err := readReplaySchema()
	if err != nil {
		t.Fatal(err)
	}
	definitions := bm(schema["$defs"])
	behavior := emptyBehaviorObservation(obj{"observe": []any{}})
	local := emptyBehaviorObservation(obj{})
	for definition, observed := range map[string]obj{"behaviorObservation": behavior, "coreObservation": healthyCoreObservation(), "localClockObservation": local} {
		if err := replayObservationError(observed, definition, definitions); err != nil {
			t.Fatalf("well-formed %s rejected: %v", definition, err)
		}
	}
	with := func(base obj, field string, value any) obj {
		changed := bm(bclone(base))
		changed[field] = value
		return changed
	}
	without := func(base obj, field string) obj {
		changed := bm(bclone(base))
		delete(changed, field)
		return changed
	}
	for name, control := range map[string]struct {
		definition string
		observed   any
	}{
		"string counter":         {"behaviorObservation", with(behavior, "loaders", "1")},
		"pending call value":     {"behaviorObservation", with(behavior, "calls", []any{obj{"status": "value"}})},
		"invented event":         {"behaviorObservation", with(behavior, "events", []any{obj{"event": "invented"}})},
		"unknown field":          {"behaviorObservation", with(behavior, "extra", int64(1))},
		"missing list":           {"behaviorObservation", without(behavior, "maintenance")},
		"negative counter":       {"coreObservation", with(healthyCoreObservation(), "redisReads", int64(-1))},
		"missing counter":        {"coreObservation", without(healthyCoreObservation(), "redisWrites")},
		"fractional counter":     {"coreObservation", with(healthyCoreObservation(), "redisReads", 0.5)},
		"structured local call":  {"localClockObservation", with(local, "calls", []any{obj{"status": "pending"}})},
		"events on local clock":  {"localClockObservation", with(local, "events", []any{})},
		"non-object observation": {"behaviorObservation", []any{}},
		"nil observation":        {"coreObservation", nil},
	} {
		t.Run(name, func(t *testing.T) {
			err := replayObservationError(control.observed, control.definition, definitions)
			if err == nil {
				t.Fatalf("malformed %s accepted: %s", control.definition, bjson(control.observed))
			}
			if !strings.HasPrefix(err.Error(), "driver produced a malformed "+control.definition+" observation: ") {
				t.Fatalf("shape defect lacks the driver attribution: %v", err)
			}
			if matched, _ := regexp.MatchString(`expected:[\s\S]*actual:`, err.Error()); matched {
				t.Fatalf("shape defect acquired comparison markers: %v", err)
			}
		})
	}
	for _, definition := range []string{"", "invented", "observedEvent", "command"} {
		if err := replayObservationError(behavior, definition, definitions); err == nil || !strings.Contains(err.Error(), "unknown replay observation definition") {
			t.Fatalf("definition %q accepted: %v", definition, err)
		}
	}

	t.Run("rejected before any request reaches the coordinator", func(t *testing.T) {
		// The stand-in exits nonzero if an observe request ever arrives, which
		// the transport's cleanup reports as a process failure.
		program := "require('readline').createInterface({input:process.stdin}).on('line', line => { const request=JSON.parse(line); if (request.op === 'observe') process.exit(3); process.stdout.write(JSON.stringify({version:1,id:request.id,ok:true,result:{complete:true,steps:2}})+'\\n'); });"
		coordinator := startReplayCoordinator(t, exec.Command("node", "-e", program), time.Second, false)
		applied := 0
		prepared := obj{"session": "1", "setup": []any{obj{"op": "bumpSource"}}, "steps": float64(2), "observation": "coreObservation"}
		err := coordinator.execute(prepared, func(obj) error { applied++; return nil }, func() obj { return with(healthyCoreObservation(), "redisReads", "many") }, func() int64 { return 0 })
		if err == nil || !strings.Contains(err.Error(), "driver produced a malformed coreObservation observation") {
			t.Fatalf("malformed observation was not attributed to the driver: %v", err)
		}
		if applied != 1 {
			t.Fatalf("setup must run before the first observation: applied=%d", applied)
		}
	})
	t.Run("prepare rejects an unknown observation definition", func(t *testing.T) {
		program := "require('readline').createInterface({input:process.stdin}).on('line', line => { const request=JSON.parse(line); process.stdout.write(JSON.stringify({version:1,id:request.id,ok:true,result:{session:'1',settlement:'causally-ready-v1',observation:'observedEvent',fixture:{},setup:[],actions:['init','outsideCall'],steps:2}})+'\\n'); });"
		coordinator := startReplayCoordinator(t, exec.Command("node", "-e", program), time.Second, false)
		if _, err := coordinator.prepare("core", "control.itf.json", nil); err == nil || !strings.Contains(err.Error(), "malformed replay observation definition") {
			t.Fatalf("unknown observation definition accepted: %v", err)
		}
	})
}

func TestReplayCoordinatorBoundsFramesBeforeBuffering(t *testing.T) {
	reader := bufio.NewReaderSize(strings.NewReader("12345678901234567890123456789012345\n"), 16)
	if _, err := readReplayLine(reader, 32); err == nil || !strings.Contains(err.Error(), "oversized") {
		t.Fatalf("oversized frame accepted: %v", err)
	}
	reader = bufio.NewReaderSize(strings.NewReader("{\"value\":1}"), 16)
	if _, err := readReplayLine(reader, 32); err != io.EOF {
		t.Fatalf("unterminated frame accepted: %v", err)
	}
}

func TestReplayCoordinatorMutationEvidence(t *testing.T) {
	// Exercise the real native replay, test2json stream, coordinator subprocess,
	// and unchanged mutation evaluator. Reusing this test binary avoids a second
	// compilation and keeps the TypeScript-only checks independent of Go.
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	original, err := os.ReadFile("../formal/conformance-smoke.itf.json")
	if err != nil {
		t.Fatal(err)
	}
	evaluator, err := filepath.Abs("../formal/measure-go-semantics.mjs")
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"baseline", "observation", "malformed", "missing-file", "unknown-action"} {
		t.Run(mode, func(t *testing.T) {
			var trace obj
			if err := json.Unmarshal(original, &trace); err != nil {
				t.Fatal(err)
			}
			trace["states"] = ba(trace["states"])[:2]
			second := bm(ba(trace["states"])[1])
			if mode == "observation" {
				bm(second["s"])["redisReads"] = obj{"#bigint": "999"}
			}
			if mode == "unknown-action" {
				bm(second["input"])["name"] = "unsupportedAction"
			}
			raw, err := json.Marshal(trace)
			if err != nil {
				t.Fatal(err)
			}
			if mode == "malformed" {
				raw = []byte("{")
			}
			path := filepath.Join(t.TempDir(), "control.itf.json")
			if mode != "missing-file" {
				if err := os.WriteFile(path, raw, 0o644); err != nil {
					t.Fatal(err)
				}
			}
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, "go", "tool", "test2json", "-t", "-p", "github.com/lan17/DialCache/go", executable,
				"-test.v=test2json", "-test.run=^TestCoreConformance$", "-test.count=1")
			for _, value := range os.Environ() {
				if !strings.HasPrefix(value, "DIALCACHE_") {
					command.Env = append(command.Env, value)
				}
			}
			command.Env = append(command.Env, "DIALCACHE_MBT_TRACE_FILE="+path)
			var stderr bytes.Buffer
			command.Stderr = &stderr
			events, runError := command.Output()
			exitCode := 0
			if runError != nil {
				exit, ok := runError.(*exec.ExitError)
				if !ok || exit.ExitCode() != 1 {
					t.Fatalf("native control could not finish: %v\n%s", runError, stderr.String())
				}
				exitCode = 1
			}
			program := `import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
const {evaluateGoTestEvents} = await import(pathToFileURL(process.argv[2]).href);
try { console.log(JSON.stringify({valid:true, result:evaluateGoTestEvents(readFileSync(0,"utf8"), Number(process.argv[3]))})); }
catch(error) { console.log(JSON.stringify({valid:false, error:error.message})); }`
			// Keep argv[1] distinct from the imported path so its CLI main guard
			// cannot start a mutation campaign while evaluating these events.
			check := exec.CommandContext(ctx, "node", "--input-type=module", "-e", program, "mutation-evidence-control", evaluator, fmt.Sprint(exitCode))
			check.Stdin = bytes.NewReader(events)
			output, err := check.CombinedOutput()
			if err != nil {
				t.Fatalf("mutation evaluator could not finish: %v\n%s", err, output)
			}
			var result obj
			if err := json.Unmarshal(output, &result); err != nil {
				t.Fatalf("invalid evaluator output: %v\n%s", err, output)
			}
			switch mode {
			case "baseline":
				if result["valid"] != true || bm(result["result"])["state"] != "survived" {
					t.Fatalf("baseline was not accepted: %s\n%s", output, events)
				}
			case "observation":
				measurement := bm(result["result"])
				kind := bm(measurement["assertionKinds"])["TestCoreConformance/control.itf.json"]
				if result["valid"] != true || measurement["state"] != "detected" || kind != "observation-mismatch" {
					t.Fatalf("real replay mismatch was not credited: %s\n%s", output, events)
				}
			default:
				if result["valid"] != false || !strings.Contains(bs(result["error"]), "replay failure lacks observation") {
					t.Fatalf("infrastructure failure was credited: %s\n%s", output, events)
				}
				if matched, _ := regexp.Match(`expected:[\s\S]*actual:`, events); matched {
					t.Fatalf("infrastructure failure acquired comparison markers: %s", events)
				}
			}
		})
	}
}
