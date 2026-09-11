import { readFileSync } from "node:fs";
import { itfInteger, itfSignedInteger, record } from "./itf.js";

interface PublicState {
  calls: number[];
  reads: number;
  loaders: number;
  loads: number;
  dumps: number;
  writes: number;
  events: Array<{ event: string; location: string; detail: string; amount: number }>;
}
interface Rule {
  name: string;
  regression: string;
  commands: string[];
  consequence: (state: PublicState) => boolean;
}
const cmd = (name: string, choice = -1) => `${name}:${choice}`;
const init = cmd("init", 2), begin = cmd("beginCall"), read = cmd("releaseRead", 0);
const resolve = cmd("resolveLoader", 0), reject = cmd("rejectLoader", 0);
const load = cmd("releaseLoad"), dump = cmd("releaseDump"), write = cmd("releaseWrite");
const fault = cmd("observerFault", 1);
const same = (actual: unknown, expected: unknown) => JSON.stringify(actual) === JSON.stringify(expected);
const hit = (s: PublicState) => same(s.calls, [1]) && s.reads === 1 && s.loads === 1 && s.loaders === 0 && s.writes === 0;
const publishedAndRead = (s: PublicState) => same(s.calls, [1, 1]) && s.reads === 2 && s.loads === 1 && s.loaders === 1 && s.dumps === 1 && s.writes === 1;

// Inputs identify a deliberately narrow distinguishing schedule. Credit then
// depends only on observations asserted by both drivers: no phase, private
// timestamp, stored value, or model authorization predicate enters these rules.
export const effectsAuthorityRules: readonly Rule[] = [
  { name: "observer-failure-hit", regression: "observerFailuresCannotPreventCacheHitTest",
    commands: [init, fault, cmd("seedRemote"), begin, read, load], consequence: hit },
  { name: "observer-failure-publication", regression: "observerFailuresCannotPreventPublicationTest",
    commands: [init, fault, begin, read, resolve, dump, write, begin, cmd("releaseRead", 1), load], consequence: publishedAndRead },
  { name: "observer-failure-source-error", regression: "observerFailuresCannotReplaceSourceErrorTest",
    commands: [init, fault, begin, cmd("failRead", 0), reject],
    consequence: s => same(s.calls, [2]) && s.reads === 1 && s.loaders === 1 && s.loads === 0 && s.writes === 0 },
  { name: "write-stamp-after-serialization", regression: "writeStampAfterSerializationClearsInterveningFenceTest",
    commands: [init, begin, read, resolve, cmd("invalidate"), cmd("tick"), dump, write, begin, cmd("releaseRead", 1), load],
    consequence: publishedAndRead },
  { name: "future-offset-observing-layer-positive-seconds", regression: "futureFrameReportsPositiveObservingOffsetTest",
    commands: [init, cmd("seedRemote"), cmd("rollbackWall"), begin, read, reject],
    consequence: s => same(s.calls, [2]) && s.loads === 0 && s.loaders === 1 && same(
      s.events.filter(e => e.event === "futureOffset"), [{ event: "futureOffset", location: "remote", detail: "", amount: 1 }]) },
  { name: "shared-failure-preserves-leader-and-follower-trail", regression: "coalescedFailureKeepsOneLeaderAndFollowerTrailTest",
    commands: [init, begin, begin, cmd("failRead", 0), reject],
    consequence: s => same(s.calls, [2, 2]) && s.reads === 1 && s.loaders === 1 && s.loads === 0 && s.writes === 0 && same(
      s.events.filter(e => ["request", "coalesced", "error"].includes(e.event)), [
        { event: "request", location: "remote", detail: "", amount: 0 },
        { event: "coalesced", location: "process", detail: "", amount: 0 },
        { event: "error", location: "remote", detail: "cache_read", amount: 0 },
        { event: "error", location: "remote", detail: "fallback", amount: 0 },
      ]) },
];

export function effectsAuthorityWitnesses(paths: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const path of paths) {
    const raw = record(JSON.parse(readFileSync(path, "utf8")), path);
    if (!Array.isArray(raw.states)) throw new Error("Missing effects witness states");
    const commands: string[] = [];
    const states = raw.states.map(rawState => {
      const state = record(rawState, path), input = record(state.input, path), s = record(state.s, path);
      if (typeof input.name !== "string") throw new Error("Missing effects witness input");
      commands.push(cmd(input.name, itfSignedInteger(input.choice, path)));
      if (!Array.isArray(s.calls) || !Array.isArray(s.events)) throw new Error("Missing effects public observations");
      return {
        ...Object.fromEntries(["reads", "loaders", "loads", "dumps", "writes"].map(key => [key, itfInteger(s[key], path)])),
        calls: s.calls.map(value => itfInteger(value, path)),
        events: s.events.map(raw => {
          const event = record(raw, path);
          if (typeof event.event !== "string" || typeof event.location !== "string" || typeof event.detail !== "string") throw new Error("Invalid effects public diagnostic");
          const ms = itfInteger(event.amount, path);
          return { event: event.event, location: event.location, detail: event.detail,
            amount: ["get", "fallback", "serialization", "futureOffset"].includes(event.event) ? ms / 1000 : ms };
        }),
      } as PublicState;
    });
    for (const rule of effectsAuthorityRules) {
      if (commands.length >= rule.commands.length && rule.commands.every((value, index) => commands[index] === value)
        && rule.consequence(states[rule.commands.length - 1]!)) found.add(rule.name);
    }
  }
  return found;
}
