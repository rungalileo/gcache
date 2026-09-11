// Executed by the Go integration test after bundling against production TS
// imports. Inputs are operations and serialized values, never expected state.
import { readFileSync } from "node:fs";
import { createClient, createCluster } from "redis";
import { createNodeRedisDialCacheClient } from "../src/node-redis.js";
import { JsonSerializer } from "../src/serializer.js";
import { compressPayload, decompressPayload, escapeRawPayload } from "../src/internal/compression.js";
import { isRedisReadMiss } from "../src/redis-client.js";

async function main() {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const client = input.cluster
    ? createCluster({ rootNodes: [{ url: `redis://${input.endpoint}` }], nodeAddressMap: input.mapping,
      useReplicas: true, defaults: { socket: { connectTimeout: 5000, reconnectStrategy: false }, disableOfflineQueue: true } })
    : createClient({ url: `redis://${input.endpoint}`, socket: { connectTimeout: 5000, reconnectStrategy: false }, disableOfflineQueue: true });
  client.on("error", () => undefined);
  await client.connect();
  const adapter = createNodeRedisDialCacheClient(client);
  const codec = new JsonSerializer();
  const results = [];
  try {
    for (const action of input.actions) {
      if (action.op === "write") {
        const serialized = action.binaryHex === undefined
          ? await codec.dump(action.absent ? undefined : action.value)
          : Buffer.from(action.binaryHex, "hex");
        const payload = action.compress
          ? compressPayload(serialized, { thresholdBytes: 1, level: 3 }).payload
          : escapeRawPayload(serialized);
        await adapter.write({ valueKey: action.key, value: payload, createdAtMs: action.stamp, cacheTtlMs: 60000 });
        results.push({ kind: "written" });
      } else if (action.op === "read") {
        const result = await adapter.read({ valueKey: action.key, ...(action.watermark ? { watermarkKey: action.watermark } : {}) });
        if (isRedisReadMiss(result)) { results.push(result); continue; }
        const { payload } = decompressPayload(result.payload);
        const value = action.binary ? undefined : await codec.load(payload);
        results.push({ kind: "hit", stamp: result.createdAtMs,
          ...(action.binary ? { binaryHex: Buffer.from(payload).toString("hex") } : { value: value === undefined ? { absent: true } : value }) });
      } else if (action.op === "invalidate") {
        const realNow = Date.now;
        Date.now = () => action.stamp;
        try { await adapter.invalidate({ watermarkKey: action.watermark, futureBufferMs: action.futureMs }); }
        finally { Date.now = realNow; }
        results.push({ kind: "invalidated" });
      } else { throw new Error(`Unknown interop operation ${action.op}`); }
    }
  } finally { await client.quit(); }
  process.stdout.write(JSON.stringify(results));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
