//go:build integration

package dialcache

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

type redisEnvironment struct {
	client   redis.UniversalClient
	endpoint string
	cluster  bool
	mapping  map[string]map[string]any
}

func dockerCommand(t *testing.T, args ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "docker", args...)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	raw, err := command.Output()
	if err != nil {
		t.Fatalf("docker %v: %v\nstdout:\n%s\nstderr:\n%s", args, err, raw, stderr.String())
	}
	return strings.TrimSpace(string(raw))
}

func testDockerCommandOutput(t *testing.T) {
	// A cold docker run writes pull progress to stderr and the container ID to
	// stdout. Exercise that boundary without removing any existing Docker image.
	directory := t.TempDir()
	fixture := `#!/bin/sh
case "$1" in
  run)
    printf '%s\n' "Unable to find image 'redis:cold-fixture' locally" "Pulling image layers..." >&2
    printf '%s\n' "fixture-container-id"
    ;;
  port)
    if [ "$2" != "fixture-container-id" ]; then
      printf '%s\n' "container ID was polluted by pull progress" >&2
      exit 1
    fi
    printf '%s\n' "127.0.0.1:16379"
    ;;
  *) exit 2 ;;
esac
`
	if err := os.WriteFile(filepath.Join(directory, "docker"), []byte(fixture), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	id := dockerCommand(t, "run", "-d", "redis:cold-fixture")
	if id != "fixture-container-id" {
		t.Fatalf("cold-pull command returned %q instead of its stdout container ID", id)
	}
	if endpoint := dockerCommand(t, "port", id, "6379/tcp"); endpoint != "127.0.0.1:16379" {
		t.Fatalf("port lookup returned %q", endpoint)
	}
}
func startRedisContainer(t *testing.T, image, network string, cluster bool) (string, string, string) {
	t.Helper()
	args := []string{"run", "-d", "--rm", "-p", "127.0.0.1::6379"}
	if network != "" {
		args = append(args, "--network", network)
	}
	server := "redis-server"
	if strings.Contains(image, "valkey") {
		server = "valkey-server"
	}
	args = append(args, image, server, "--save", "", "--appendonly", "no", "--protected-mode", "no")
	if cluster {
		args = append(args, "--cluster-enabled", "yes", "--cluster-config-file", "/tmp/nodes.conf", "--cluster-node-timeout", "5000")
	}
	id := dockerCommand(t, args...)
	t.Cleanup(func() { _ = exec.Command("docker", "rm", "-f", id).Run() })
	endpoint := dockerCommand(t, "port", id, "6379/tcp")
	ip := ""
	if network != "" {
		ip = dockerCommand(t, "inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", id)
	}
	client := redis.NewClient(&redis.Options{Addr: endpoint, DialTimeout: time.Second, ReadTimeout: time.Second, WriteTimeout: time.Second, MaxRetries: -1})
	defer client.Close()
	deadline := time.Now().Add(15 * time.Second)
	for {
		if client.Ping(context.Background()).Err() == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Redis did not become ready")
		}
		time.Sleep(25 * time.Millisecond)
	}
	return id, endpoint, ip
}
func standaloneEnvironment(t *testing.T, image string) redisEnvironment {
	_, endpoint, _ := startRedisContainer(t, image, "", false)
	client := redis.NewClient(&redis.Options{Addr: endpoint, DialTimeout: 2 * time.Second, ReadTimeout: 2 * time.Second, WriteTimeout: 2 * time.Second, MaxRetries: -1, ContextTimeoutEnabled: true})
	t.Cleanup(func() { _ = client.Close() })
	return redisEnvironment{client: client, endpoint: endpoint}
}

func waitForCluster(ctx context.Context, nodes []string, inspect func(context.Context, string) (string, error)) error {
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		ready := true
		var diagnostics []string
		for _, node := range nodes {
			info, err := inspect(ctx, node)
			diagnostics = append(diagnostics, fmt.Sprintf("node %s: error=%v\n%s", node, err, info))
			fields := make(map[string]string)
			for _, line := range strings.Split(info, "\n") {
				if key, value, ok := strings.Cut(strings.TrimSpace(line), ":"); ok {
					fields[key] = value
				}
			}
			if err != nil || fields["cluster_state"] != "ok" ||
				fields["cluster_slots_assigned"] != "16384" || fields["cluster_slots_ok"] != "16384" ||
				fields["cluster_slots_pfail"] != "0" || fields["cluster_slots_fail"] != "0" ||
				fields["cluster_known_nodes"] != "6" || fields["cluster_size"] != "3" {
				ready = false
			}
		}
		if ready {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("cluster did not become ready: %w\n%s", ctx.Err(), strings.Join(diagnostics, "\n"))
		case <-ticker.C:
		}
	}
}

func testClusterReadiness(t *testing.T) {
	const healthy = "cluster_state:ok\r\ncluster_slots_assigned:16384\r\ncluster_slots_ok:16384\r\ncluster_slots_pfail:0\r\ncluster_slots_fail:0\r\ncluster_known_nodes:6\r\ncluster_size:3\r\n"
	nodes := []string{"node0", "node1", "node2", "node3", "node4", "node5"}
	counts := make(map[string]int)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	err := waitForCluster(ctx, nodes, func(_ context.Context, node string) (string, error) {
		counts[node]++
		if counts[node] == 1 && node != nodes[0] {
			return strings.Replace(healthy, "cluster_state:ok", "cluster_state:fail", 1), nil
		}
		if counts[node] == 2 && node == nodes[5] {
			return strings.Replace(healthy, "cluster_slots_ok:16384", "cluster_slots_ok:16383", 1), nil
		}
		return healthy, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, node := range nodes {
		if counts[node] != 3 {
			t.Fatalf("startup accepted an incomplete cluster: %s inspected %d times, want 3", node, counts[node])
		}
	}

	failedContext, stop := context.WithCancel(context.Background())
	defer stop()
	err = waitForCluster(failedContext, nodes, func(_ context.Context, node string) (string, error) {
		if node == nodes[5] {
			stop()
		}
		return "", fmt.Errorf("probe unavailable for %s", node)
	})
	if err == nil || !strings.Contains(err.Error(), "context canceled") {
		t.Fatalf("startup did not terminate with its context: %v", err)
	}
	for _, node := range nodes {
		if !strings.Contains(err.Error(), "probe unavailable for "+node) {
			t.Fatalf("startup diagnostic omitted %s: %v", node, err)
		}
	}
}

func clusterEnvironment(t *testing.T) redisEnvironment {
	network := dockerCommand(t, "network", "create", fmt.Sprintf("dialcache-go-%d", time.Now().UnixNano()))
	t.Cleanup(func() { _ = exec.Command("docker", "network", "rm", network).Run() })
	var ids, internal, external []string
	mapping := make(map[string]map[string]any)
	routes := make(map[string]string)
	for i := 0; i < 6; i++ {
		id, endpoint, ip := startRedisContainer(t, "redis:7-alpine", network, true)
		ids = append(ids, id)
		internal = append(internal, ip+":6379")
		external = append(external, endpoint)
		host, port, _ := net.SplitHostPort(endpoint)
		number, _ := strconv.Atoi(port)
		mapping[ip+":6379"] = map[string]any{"host": host, "port": number}
		routes[ip+":6379"] = endpoint
	}
	args := append([]string{"exec", ids[0], "redis-cli", "--cluster", "create"}, internal...)
	args = append(args, "--cluster-replicas", "1", "--cluster-yes")
	dockerCommand(t, args...)
	// Cluster creation and PING can succeed while other nodes still reject key
	// commands with CLUSTERDOWN. Wait for every primary and replica's slot view.
	probes := make(map[string]*redis.Client)
	for _, endpoint := range external {
		probe := redis.NewClient(&redis.Options{Addr: endpoint, MaxRetries: -1, DialTimeout: 2 * time.Second, ReadTimeout: 2 * time.Second, WriteTimeout: 2 * time.Second, ContextTimeoutEnabled: true})
		defer probe.Close()
		probes[endpoint] = probe
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := waitForCluster(ctx, external, func(ctx context.Context, node string) (string, error) {
		return probes[node].ClusterInfo(ctx).Result()
	}); err != nil {
		t.Fatal(err)
	}
	client := redis.NewClusterClient(&redis.ClusterOptions{Addrs: external, ReadOnly: true, RouteRandomly: true, MaxRetries: -1, DialTimeout: 2 * time.Second, ReadTimeout: 2 * time.Second, WriteTimeout: 2 * time.Second, ContextTimeoutEnabled: true, Dialer: func(ctx context.Context, network, address string) (net.Conn, error) {
		if mapped, ok := routes[address]; ok {
			address = mapped
		}
		return (&net.Dialer{Timeout: 2 * time.Second}).DialContext(ctx, network, address)
	}})
	t.Cleanup(func() { _ = client.Close() })
	if err := client.Ping(context.Background()).Err(); err != nil {
		t.Fatal(err)
	}
	return redisEnvironment{client: client, endpoint: external[0], cluster: true, mapping: mapping}
}
func primaryCommands(t *testing.T, environment redisEnvironment, key string) redis.Cmdable {
	t.Helper()
	if cluster, ok := environment.client.(*redis.ClusterClient); ok {
		client, err := cluster.MasterForKey(context.Background(), key)
		if err != nil {
			t.Fatal(err)
		}
		return client
	}
	return environment.client
}

func TestRedisIntegration(t *testing.T) {
	t.Run("docker-command-output", testDockerCommandOutput)
	t.Run("cluster-readiness", testClusterReadiness)
	for _, kind := range []string{"redis6.2", "valkey8", "cluster"} {
		t.Run(kind, func(t *testing.T) {
			var environment redisEnvironment
			switch kind {
			case "redis6.2":
				environment = standaloneEnvironment(t, "redis:6.2-alpine")
			case "valkey8":
				environment = standaloneEnvironment(t, "valkey/valkey:8-alpine")
			case "cluster":
				environment = clusterEnvironment(t)
			}
			t.Run("invalidation-vectors", func(t *testing.T) { testInvalidationVectors(t, environment) })
			t.Run("mixed-typescript-go", func(t *testing.T) { testMixedLanguage(t, environment) })
			t.Run("complete-frame-and-primary-read", func(t *testing.T) { testPrimaryRead(t, environment) })
		})
	}
}

type invalidationState struct {
	Kind   string
	Value  string
	Values []string
	TTLMS  int64 `json:"ttlMs"`
}

func testInvalidationVectors(t *testing.T, environment redisEnvironment) {
	raw, err := os.ReadFile("../formal/invalidation-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var corpus struct {
		Provenance struct {
			Model        string
			SourceSHA256 map[string]string `json:"sourceSha256"`
		}
		SchemaVersion int
		Vectors       []struct {
			Name, FutureBufferMS, InvalidatedAtMS string
			Existing                              invalidationState
			Expected                              struct {
				Error bool
				State invalidationState
			}
		}
	}
	if err = json.Unmarshal(raw, &corpus); err != nil || corpus.SchemaVersion != 2 || len(corpus.Vectors) != 49 {
		t.Fatal("unsupported invalidation corpus", err)
	}
	// The historical 49 vectors remain a separate corpus. New predictions are
	// emitted by Quint; ordinary Redis runs reject stale model/generator inputs.
	generated := corpus
	generated.Vectors = nil
	raw, err = os.ReadFile("../formal/quint-invalidation-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, &generated); err != nil || generated.SchemaVersion != 2 || len(generated.Vectors) != 288 {
		t.Fatal("unsupported Quint invalidation corpus", err)
	}
	const model = "formal/dialcache-invalidation-transition.qnt"
	const generator = "formal/generate-invalidation-vectors.mjs"
	if generated.Provenance.Model != model || len(generated.Provenance.SourceSHA256) != 2 {
		t.Fatal("invalid Quint invalidation provenance")
	}
	for _, path := range []string{model, generator} {
		source, err := os.ReadFile(filepath.Join("..", path))
		if err != nil {
			t.Fatal(err)
		}
		if fmt.Sprintf("%x", sha256.Sum256(source)) != generated.Provenance.SourceSHA256[path] {
			t.Fatalf("stale Quint invalidation vectors for %s; regenerate and review", path)
		}
	}
	for i, vector := range generated.Vectors {
		if !strings.HasPrefix(vector.Name, fmt.Sprintf("Quint %03d: ", i)) {
			t.Fatal("incomplete or reordered Quint invalidation combinations")
		}
	}
	corpus.Vectors = append(corpus.Vectors, generated.Vectors...)
	const setup = `redis.replicate_commands()
local now=redis.call("TIME")
redis.call("DEL",KEYS[1])
if ARGV[1]=="string" then redis.call("SET",KEYS[1],ARGV[2]) end
if ARGV[1]=="list" then for _,value in ipairs(cjson.decode(ARGV[2])) do redis.call("RPUSH",KEYS[1],value) end end
if tonumber(ARGV[3])>0 then redis.call("PEXPIRE",KEYS[1],ARGV[3]) end
return tonumber(now[1])*1000+math.floor(tonumber(now[2])/1000)`
	const observe = `local kind=redis.call("TYPE",KEYS[1]).ok
local content={}
if kind=="string" then content=redis.call("GET",KEYS[1]) end
if kind=="list" then content=redis.call("LRANGE",KEYS[1],0,-1) end
if kind=="none" then kind="absent" end
local ttl=redis.call("PTTL",KEYS[1]);local now=redis.call("TIME")
return {kind,content,ttl,tonumber(now[1])*1000+math.floor(tonumber(now[2])/1000)}`
	adapter := NewRedisAdapter(environment.client)
	for _, vector := range corpus.Vectors {
		t.Run(vector.Name, func(t *testing.T) {
			key := "{go-invalidation}:" + vector.Name
			commands := primaryCommands(t, environment, key)
			content := vector.Existing.Value
			if vector.Existing.Kind == "list" {
				encoded, _ := json.Marshal(vector.Existing.Values)
				content = string(encoded)
			}
			start, err := commands.Eval(context.Background(), setup, []string{key}, vector.Existing.Kind, content, vector.Existing.TTLMS).Int64()
			if err != nil {
				t.Fatal(err)
			}
			err = adapter.InvalidateDecimal(context.Background(), key, vector.FutureBufferMS, vector.InvalidatedAtMS)
			if (err != nil) != vector.Expected.Error {
				t.Fatalf("error=%v expected rejection=%v", err, vector.Expected.Error)
			}
			got, err := commands.Eval(context.Background(), observe, []string{key}).Slice()
			if err != nil {
				t.Fatal(err)
			}
			want := vector.Expected.State
			if got[0] != want.Kind {
				t.Fatalf("kind %v want %v", got[0], want.Kind)
			}
			switch want.Kind {
			case "string":
				if got[1] != want.Value {
					t.Fatalf("content %v want %v", got[1], want.Value)
				}
			case "list":
				list := got[1].([]any)
				wantList := make([]any, len(want.Values))
				for i, v := range want.Values {
					wantList[i] = v
				}
				if !reflect.DeepEqual(list, wantList) {
					t.Fatalf("list %v want %v", list, wantList)
				}
			}
			ttl, elapsed := got[2].(int64), got[3].(int64)-start
			if elapsed < 0 {
				t.Fatal("server time moved backwards")
			}
			if want.TTLMS < 0 {
				if ttl != want.TTLMS {
					t.Fatalf("TTL %d want %d", ttl, want.TTLMS)
				}
			} else {
				minimum := want.TTLMS - elapsed
				if minimum < 0 {
					minimum = 0
				}
				if ttl < minimum || ttl > want.TTLMS {
					t.Fatalf("TTL %d outside [%d,%d], measured elapsed=%d", ttl, minimum, want.TTLMS, elapsed)
				}
			}
		})
	}
}

func runTypeScript(t *testing.T, environment redisEnvironment, actions []map[string]any) []map[string]any {
	t.Helper()
	root, err := filepath.Abs("..")
	if err != nil {
		t.Fatal(err)
	}
	if override := os.Getenv("DIALCACHE_TS_ROOT"); override != "" {
		root = override
	}
	bundle := filepath.Join(t.TempDir(), "interop.cjs")
	// tsup is a declared dev dependency and owns the esbuild version. Bundling
	// imports the current production TS source, never a duplicate fixture codec.
	build := `const {createRequire}=require('node:module');const {buildSync}=createRequire(require.resolve('tsup'))('esbuild');buildSync({entryPoints:[process.argv[1]],outfile:process.argv[2],bundle:true,platform:'node',format:'cjs'});`
	command := exec.Command("node", "-e", build, filepath.Join(root, "go/redis_interop.ts"), bundle)
	command.Dir = root
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("bundle TS interop: %v\n%s", err, output)
	}
	request, _ := json.Marshal(map[string]any{"endpoint": environment.endpoint, "cluster": environment.cluster, "mapping": environment.mapping, "actions": actions})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	command = exec.CommandContext(ctx, "node", bundle)
	command.Stdin = bytes.NewReader(request)
	command.Dir = root
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("TypeScript interop: %v\n%s", err, output)
	}
	var results []map[string]any
	if err = json.Unmarshal(output, &results); err != nil {
		t.Fatalf("TS results %s: %v", output, err)
	}
	return results
}
func testMixedLanguage(t *testing.T, environment redisEnvironment) {
	adapter := NewRedisAdapter(environment.client)
	codec := JSONCodec[any]{}
	stamp := uint64(1700000000000)
	values := []any{Absent, nil, false, float64(0), "", map[string]any{"id": "cross-language", "nested": []any{1.0, nil, false}}, strings.Repeat("DialCache é", 1000)}
	var reads, writes []map[string]any
	for i, value := range values {
		key := fmt.Sprintf("{go-ts-interop}:json:%d", i)
		payload, err := codec.Encode(value)
		if err != nil {
			t.Fatal(err)
		}
		compressed, err := CompressPayload(payload, CompressionConfig{1, 3})
		if err != nil {
			t.Fatal(err)
		}
		if err = adapter.Write(context.Background(), key, Frame{CreatedAtMS: stamp, Payload: compressed.Payload.Bytes, Binary: compressed.Payload.Binary}, 60000); err != nil {
			t.Fatal(err)
		}
		reads = append(reads, map[string]any{"op": "read", "key": key, "watermark": "{go-ts-interop}:watermark"})
		action := map[string]any{"op": "write", "key": key + ":ts", "stamp": stamp, "value": value, "compress": true}
		if IsAbsent(value) {
			delete(action, "value")
			action["absent"] = true
		}
		writes = append(writes, action)
	}
	binary := []byte{0, 1, 2, 255, 0xe2, 0x82}
	binaryLarge := bytes.Repeat(binary, 500)
	for i, value := range [][]byte{binary, binaryLarge} {
		key := fmt.Sprintf("{go-ts-interop}:binary:%d", i)
		compressed, err := CompressPayload(Payload{Bytes: value, Binary: true}, CompressionConfig{64, 3})
		if err != nil {
			t.Fatal(err)
		}
		if err = adapter.Write(context.Background(), key, Frame{CreatedAtMS: stamp, Payload: compressed.Payload.Bytes, Binary: compressed.Payload.Binary}, 60000); err != nil {
			t.Fatal(err)
		}
		reads = append(reads, map[string]any{"op": "read", "key": key, "watermark": "{go-ts-interop}:watermark", "binary": true})
		writes = append(writes, map[string]any{"op": "write", "key": key + ":ts", "stamp": stamp, "binaryHex": hex.EncodeToString(value), "compress": i == 1})
	}
	results := runTypeScript(t, environment, append(reads, writes...))
	for i, value := range values {
		got := results[i]
		if got["kind"] != "hit" || got["stamp"] != float64(stamp) {
			t.Fatalf("TS read %v", got)
		}
		if IsAbsent(value) {
			if !reflect.DeepEqual(got["value"], map[string]any{"absent": true}) {
				t.Fatal("TS absence lost")
			}
		} else if !SemanticEqual(got["value"], value) {
			t.Fatalf("TS changed value: %#v want %#v", got["value"], value)
		}
	}
	for i, value := range [][]byte{binary, binaryLarge} {
		if results[len(values)+i]["binaryHex"] != hex.EncodeToString(value) {
			t.Fatal("TS binary corrupted")
		}
	}
	for i, action := range writes {
		got, err := adapter.Read(context.Background(), action["key"].(string), "{go-ts-interop}:watermark")
		if err != nil || got.Kind != "hit" || got.Frame.CreatedAtMS != stamp {
			t.Fatal("Go read", got, err)
		}
		payload := DecompressPayload(Payload{Bytes: got.Frame.Payload, Binary: got.Frame.Binary}).Payload
		if i < len(values) {
			value, err := codec.Decode(payload)
			if err != nil || !SemanticEqual(value, values[i]) {
				t.Fatal("Go changed TS value", value, err)
			}
		} else {
			expected := binary
			if i == len(values)+1 {
				expected = binaryLarge
			}
			if !payload.Binary || !bytes.Equal(payload.Bytes, expected) {
				t.Fatal("Go binary corrupted")
			}
		}
	}
	watermark := "{go-ts-interop}:watermark"
	runTypeScript(t, environment, []map[string]any{{"op": "invalidate", "watermark": watermark, "stamp": stamp, "futureMs": 100}})
	got, err := adapter.Read(context.Background(), reads[0]["key"].(string), watermark)
	if err != nil || got.Kind != "miss" || got.Reason != "watermark_fenced" || got.ObservedWatermarkMS == nil || *got.ObservedWatermarkMS != stamp+100 {
		t.Fatal("TS invalidation did not fence Go frame", got, err)
	}
	key := reads[0]["key"].(string)
	if err = adapter.Write(context.Background(), key, Frame{CreatedAtMS: stamp + 101, Payload: []byte("1")}, 60000); err != nil {
		t.Fatal(err)
	}
	results = runTypeScript(t, environment, []map[string]any{{"op": "read", "key": key, "watermark": watermark}})
	if results[0]["kind"] != "hit" || results[0]["value"] != float64(1) {
		t.Fatal("newer Go frame not served by TS", results)
	}
	if err = adapter.Invalidate(context.Background(), watermark, int64(stamp), 200); err != nil {
		t.Fatal(err)
	}
	results = runTypeScript(t, environment, []map[string]any{{"op": "read", "key": key, "watermark": watermark}})
	if results[0]["kind"] != "miss" || results[0]["reason"] != "watermark_fenced" {
		t.Fatal("Go invalidation did not fence TS", results)
	}
}

type redisRouteHook struct{ reads *atomic.Int64 }

func (h redisRouteHook) DialHook(next redis.DialHook) redis.DialHook { return next }
func (h redisRouteHook) ProcessHook(next redis.ProcessHook) redis.ProcessHook {
	return func(ctx context.Context, cmd redis.Cmder) error {
		if cmd.Name() == "mget" {
			h.reads.Add(1)
		}
		return next(ctx, cmd)
	}
}
func (h redisRouteHook) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return next
}

func testPrimaryRead(t *testing.T, environment redisEnvironment) {
	key, watermark := "{primary-go}:value", "{primary-go}:watermark"
	var primaryReads, replicaReads atomic.Int64
	if cluster, ok := environment.client.(*redis.ClusterClient); ok {
		if err := cluster.ForEachMaster(context.Background(), func(ctx context.Context, client *redis.Client) error {
			client.AddHook(redisRouteHook{&primaryReads})
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		if err := cluster.ForEachSlave(context.Background(), func(ctx context.Context, client *redis.Client) error {
			client.AddHook(redisRouteHook{&replicaReads})
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}

	adapter := NewRedisAdapter(environment.client)
	if err := adapter.Invalidate(context.Background(), watermark, 2000, 0); err != nil {
		t.Fatal(err)
	}
	before, err := primaryCommands(t, environment, key).PTTL(context.Background(), watermark).Result()
	if err != nil {
		t.Fatal(err)
	}
	frame := Frame{CreatedAtMS: 2000, Payload: []byte{0, 1, 255}, Binary: true}
	if err := adapter.Write(context.Background(), key, frame, 10000); err != nil {
		t.Fatal(err)
	}
	encoded, _ := EncodeFrame(frame)
	raw, err := primaryCommands(t, environment, key).Get(context.Background(), key).Bytes()
	if err != nil || !bytes.Equal(raw, encoded) {
		t.Fatal("stored frame differs", err)
	}
	got, err := adapter.Read(context.Background(), key, watermark)
	if err != nil || got.Kind != "miss" || got.Reason != "watermark_fenced" {
		t.Fatal("tracked read missed primary fence", got, err)
	}
	if environment.cluster && (primaryReads.Load() != 1 || replicaReads.Load() != 0) {
		t.Fatalf("tracked MGET routing: primary=%d replica=%d", primaryReads.Load(), replicaReads.Load())
	}
	after, err := primaryCommands(t, environment, key).PTTL(context.Background(), watermark).Result()
	if err != nil || after > before {
		t.Fatal("value write extended watermark", before, after, err)
	}
	// SCRIPT FLUSH forces the adapter's EVALSHA recovery through the real server.
	commands := primaryCommands(t, environment, key)
	if err := commands.ScriptFlush(context.Background()).Err(); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Invalidate(context.Background(), watermark, 3000, 0); err != nil {
		t.Fatal("NOSCRIPT recovery failed", err)
	}
}
