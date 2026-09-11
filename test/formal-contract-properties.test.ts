import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { assertEffectsHistory, type EffectsContractEvent } from "./formal/effects-contract.js";
import { BehaviorDriver, type Input } from "./formal/behavior-driver.js";

describe("independent effects contract properties", () => {
  it("keeps pre-source delay out of C23 and allows C26 publication after acceptance", () => {
    assertEffectsHistory([
      { event: "sourceStart", id: 0, atMs: 20 },
      { event: "sourceSettlement", id: 0, atMs: 25, outcome: "resolve" },
      { event: "fallbackCompletion", atMs: 25, durationMs: 5, failed: false },
      { event: "writeDispatch", atMs: 100 },
    ]);
  });

  it("rejects a measured duration starting before source invocation", () => {
    expect(() => assertEffectsHistory([
      { event: "sourceStart", id: 0, atMs: 20 },
      { event: "sourceSettlement", id: 0, atMs: 25, outcome: "resolve" },
      { event: "fallbackCompletion", atMs: 25, durationMs: 25, failed: false },
    ])).toThrow(/C23.*excluding cache lookup/);
  });

  it("rejects a deadline charged from earlier cache lookup", () => {
    expect(() => assertEffectsHistory([
      { event: "sourceStart", id: 0, atMs: 8 },
      { event: "fallbackCompletion", atMs: 10, durationMs: 2, failed: true },
    ])).toThrow(/C23.*full budget/);
  });

  it("rejects success accepted exactly at or after the source deadline", () => {
    for (const atMs of [10, 11]) {
      expect(() => assertEffectsHistory([
        { event: "sourceStart", id: 0, atMs: 0 },
        { event: "sourceSettlement", id: 0, atMs, outcome: "resolve" },
        { event: "fallbackCompletion", atMs, durationMs: atMs, failed: false },
      ])).toThrow(/C25.*strictly before/);
    }
  });

  it("keeps an abandoned raw source separate from the replacement source", () => {
    const history: EffectsContractEvent[] = [
      { event: "sourceStart", id: 0, atMs: 0 },
      { event: "fallbackCompletion", atMs: 10, durationMs: 10, failed: true },
      { event: "sourceStart", id: 1, atMs: 10 },
      { event: "sourceSettlement", id: 0, atMs: 11, outcome: "resolve" },
    ];
    assertEffectsHistory(history);
    expect(() => assertEffectsHistory([...history, { event: "writeDispatch", atMs: 11 }])).toThrow(/C26/);
    expect(() => assertEffectsHistory([...history,
      { event: "fallbackCompletion", atMs: 11, durationMs: 1, failed: false },
    ])).toThrow(/C25/);
    assertEffectsHistory([...history,
      { event: "sourceSettlement", id: 1, atMs: 12, outcome: "resolve" },
      { event: "fallbackCompletion", atMs: 12, durationMs: 2, failed: false },
      { event: "writeDispatch", atMs: 12 },
    ]);
  });
});

describe("contract properties on actual implementation histories", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-08T12:00:00Z")); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  const apply = async (driver: BehaviorDriver, input: Input) => {
    await driver.apply(input);
    assertEffectsHistory(driver.contractHistory());
    return driver.snapshot();
  };

  it("C23 gives a delayed source its full budget after cache lookup", async () => {
    const driver = new BehaviorDriver({ policy: { ttlSec: { remote: 60 } }, readTimeoutMs: 30, fallbackTimeoutMs: 10 });
    try {
      await apply(driver, { op: "faults", value: { holdReads: true } });
      await apply(driver, { op: "begin" });
      await apply(driver, { op: "advance", ms: 8 });
      await apply(driver, { op: "release", effect: "read", index: 0 });
      const waiting = await apply(driver, { op: "advance", ms: 9 });
      expect(waiting.calls).toEqual([{ status: "pending" }]);
      const result = await apply(driver, { op: "resolve", loader: 0, value: 42 });
      expect(result.calls).toEqual([{ status: "value", value: 42 }]);
      expect(driver.contractHistory().filter(event => event.event === "fallbackCompletion"))
        .toMatchObject([{ durationMs: 9, failed: false }]);
    } finally { await driver.dispose(); }
  });

  it("C25 rejects a late raw success before timer delivery without publication", async () => {
    const driver = new BehaviorDriver({ policy: { ttlSec: { remote: 60 } }, fallbackTimeoutMs: 10 });
    try {
      await apply(driver, { op: "begin" });
      await apply(driver, { op: "advance", ms: 11, deliverTimers: false });
      const result = await apply(driver, { op: "resolve", loader: 0, value: 42 });
      expect(result.calls).toEqual([{ status: "error", error: "timeout:0" }]);
      expect(result.writes).toBe(0);
      expect(driver.contractHistory().filter(event => event.event === "fallbackCompletion"))
        .toMatchObject([{ durationMs: 11, failed: true }]);
    } finally { await driver.dispose(); }
  });

  it("C26 permits accepted serialization and publication to outlive the source deadline", async () => {
    const driver = new BehaviorDriver({ policy: { ttlSec: { remote: 60 } }, fallbackTimeoutMs: 10 });
    try {
      await apply(driver, { op: "faults", value: { holdDumps: true, holdWrites: true } });
      await apply(driver, { op: "begin" });
      await apply(driver, { op: "resolve", loader: 0, value: 42 });
      await apply(driver, { op: "advance", ms: 20 });
      const writing = await apply(driver, { op: "release", effect: "dump", index: 0 });
      expect(writing.writes).toBe(1);
      expect(writing.calls).toEqual([{ status: "pending" }]);
      await apply(driver, { op: "advance", ms: 20 });
      const result = await apply(driver, { op: "release", effect: "write", index: 0 });
      expect(result.calls).toEqual([{ status: "value", value: 42 }]);
    } finally { await driver.dispose(); }
  });
});
