import { createServer, type ServerHttp2Session, type ServerHttp2Stream } from "node:http2";
import { afterEach, describe, expect, it } from "vitest";

const { waitForApalache } = await import(new URL("../formal/apalache-readiness.mjs", import.meta.url).href) as {
  waitForApalache(endpoint: string, assertAlive: () => void, timeoutMs?: number): Promise<void>;
};
const field = (number: number, value: Buffer) => Buffer.concat([Buffer.from([number * 8 + 2, value.length]), value]);
const frame = (value: Buffer) => {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(value.length, 1);
  return Buffer.concat([header, value]);
};
const descriptor = frame(field(4, field(1, field(1, Buffer.from("cmdExecutor.proto")))));
const request = frame(field(4, Buffer.from("shai.cmdExecutor.CmdExecutor")));
const resources: Array<() => Promise<void>> = [];

function reply(stream: ServerHttp2Stream, bytes: Buffer, status = "0") {
  stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
  stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": status }));
  stream.end(bytes);
}

async function server(handle: (stream: ServerHttp2Stream, bytes: Buffer, attempt: number) => void) {
  const service = createServer();
  const sessions = new Set<ServerHttp2Session>();
  let attempts = 0;
  service.on("session", session => {
    sessions.add(session);
    session.on("error", () => {});
    session.on("close", () => sessions.delete(session));
  });
  service.on("stream", (stream, headers) => {
    expect(headers[":path"]).toBe("/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo");
    expect(headers[":method"]).toBe("POST");
    expect(headers["content-type"]).toBe("application/grpc");
    const chunks: Buffer[] = [];
    stream.on("error", () => {});
    stream.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on("end", () => handle(stream, Buffer.concat(chunks), ++attempts));
  });
  await new Promise<void>(resolve => service.listen(0, "127.0.0.1", resolve));
  resources.push(async () => {
    for (const session of sessions) session.destroy();
    await new Promise<void>(resolve => service.close(() => resolve()));
  });
  return { endpoint: `127.0.0.1:${(service.address() as { port: number }).port}`, attempts: () => attempts };
}

afterEach(async () => {
  for (const cleanup of resources.splice(0)) await cleanup();
});

describe("owned Apalache reflection readiness", () => {
  it("waits through an unavailable reflection service and sends the exact Quint symbol request", async () => {
    const service = await server((stream, bytes, attempt) => {
      expect(bytes).toEqual(request);
      reply(stream, descriptor, attempt === 1 ? "14" : "0");
    });
    await waitForApalache(service.endpoint, () => {}, 1000);
    expect(service.attempts()).toBe(2);
  });

  it.each([
    ["reflection error", frame(field(7, Buffer.from([8, 5])))],
    ["missing descriptors", frame(field(4, Buffer.alloc(0)))],
    ["empty descriptor", frame(field(4, field(1, Buffer.alloc(0))))],
    ["malformed descriptor", frame(field(4, field(1, Buffer.from([10, 4, 120]))))],
    ["truncated frame", descriptor.subarray(0, -1)],
  ])("rejects %s instead of treating HTTP success as solver readiness", async (_name, bytes) => {
    const service = await server(stream => reply(stream, bytes as Buffer));
    await expect(waitForApalache(service.endpoint, () => {}, 80)).rejects.toThrow(/reflection was not ready/);
  });

  it("bounds an oversized response and closes the connection", async () => {
    let closed!: () => void;
    const connectionClosed = new Promise<void>(resolve => { closed = resolve; });
    const service = await server(stream => {
      stream.on("close", closed);
      reply(stream, Buffer.alloc(512 * 1024));
    });
    await expect(waitForApalache(service.endpoint, () => {}, 80)).rejects.toThrow(/reflection was not ready/);
    await connectionClosed;
  });

  it("times out a server that accepts the request but never sends a response", async () => {
    let closed = false;
    const service = await server(stream => stream.on("close", () => { closed = true; }));
    await expect(waitForApalache(service.endpoint, () => {}, 80)).rejects.toThrow(/reflection request timed out/);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(closed).toBe(true);
  });

  it("preserves an owned-process exit instead of retrying it as delayed readiness", async () => {
    const service = await server(stream => reply(stream, descriptor, "14"));
    let aliveChecks = 0;
    await expect(waitForApalache(service.endpoint, () => {
      if (++aliveChecks === 2) throw new Error("owned solver exited with code 7");
    }, 1000)).rejects.toThrow("owned solver exited with code 7");
    expect(service.attempts()).toBe(1);
  });
});
