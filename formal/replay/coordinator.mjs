import { AssertionError } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { profileActions, bindTrace } from "./bindings.mjs";
import { parseJSON, replayLines } from "./validation.mjs";
import { assertSchema, schemaViolation } from "./schema.mjs";

export const protocolVersion = 1;
export const settlement = "causally-ready-v1";

// The coordinator retains predictions. Its wire replies contain only fixtures,
// external commands, and assertion acknowledgements; drivers never see them.
export class ReplayCoordinator {
  #sessions = new Map();
  #nextSession = 0;
  #lastRequest = 0;

  dispatch(request) {
    assertSchema(request, "request");
    if (request.id <= this.#lastRequest) throw new Error("Duplicate or out-of-order replay request");
    this.#lastRequest = request.id;
    const result = this.#dispatch(request);
    assertSchema({ version: protocolVersion, id: request.id, ok: true, result }, "response");
    // Direct callers have the same isolation as callers using JSONL: a driver
    // cannot mutate the shared fixture or registry through a returned reference.
    return structuredClone(result);
  }

  #dispatch(request) {
    if (request.op === "profiles") return { settlement, profiles: profileActions() };
    if (request.op === "prepare") {
      const raw = Object.hasOwn(request, "raw") ? request.raw : readFileSync(request.path, "utf8");
      const binding = bindTrace(request.profile, parseJSON(raw), request.path);
      const { trace } = binding;
      const session = String(++this.#nextSession);
      this.#sessions.set(session, { binding, trace, index: 0 });
      return {
        session, settlement, fixture: binding.fixture, setup: binding.setup,
        actions: trace.steps.map(step => step.action), steps: trace.steps.length,
      };
    }
    if (request.op === "discard") {
      if (!this.#sessions.delete(request.session)) throw new Error("Unknown replay session");
      return { discarded: true };
    }

    const session = this.#sessions.get(request.session);
    if (!session) throw new Error("Unknown replay session");
    const { binding, trace, index } = session;
    try {
      if (request.index !== index) throw new Error("Duplicate or skipped replay observation");
      // A malformed observation is a driver or transport defect, never
      // comparison evidence: report it as a plain infrastructure error.
      const malformed = schemaViolation(request.observed, binding.observation, "observed");
      if (malformed !== undefined) throw new Error(`Malformed replay observation: ${binding.observation} at ${malformed}`);
      try {
        binding.assert(index, request.observed);
      } catch (cause) {
        // Mutation attribution requires actual comparison evidence. Format only
        // an assertion raised while comparing observations; parsing, transport,
        // mapping and lifecycle errors retain their infrastructure diagnostics.
        if (!(cause instanceof AssertionError)) throw cause;
        const expected = JSON.stringify(cause.expected) ?? '{"absent":true}';
        const actual = JSON.stringify(cause.actual) ?? '{"absent":true}';
        throw new Error(`Observation mismatch\nexpected: ${expected}\nactual: ${actual}`, { cause });
      }
      const nextIndex = index + 1;
      if (nextIndex === trace.steps.length) {
        this.#sessions.delete(request.session);
        return { complete: true, steps: trace.steps.length };
      }
      // Only the explicit action descriptor, actual observations, and actual
      // environment reach the mapping. Predictions never choose commands.
      const inputs = binding.commands(nextIndex, request.observed, request.environment);
      for (const input of inputs) assertSchema(input, "command");
      if (inputs.length === 0) throw new Error("Replay action produced no command");
      session.index = nextIndex;
      return { complete: false, index: nextIndex, inputs };
    } catch (cause) {
      this.#sessions.delete(request.session);
      throw new Error(`${trace.path} step ${index} action ${trace.steps[index].action}: ${cause.message}`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const coordinator = new ReplayCoordinator();
  const lines = replayLines(process.stdin);
  for await (const line of lines) {
    let request;
    try {
      request = parseJSON(line);
      const result = coordinator.dispatch(request);
      process.stdout.write(`${JSON.stringify({ version: protocolVersion, id: request.id, ok: true, result })}\n`);
    } catch (error) {
      const id = Number.isSafeInteger(request?.id) && request.id > 0 ? request.id : null;
      process.stdout.write(`${JSON.stringify({ version: protocolVersion, id, ok: false, error: error.message })}\n`);
    }
  }
}
