import { describe, expect, it } from "vitest";
import { assertPublicationCausality, type CausalEvent } from "./formal/causal-contract.js";

describe("external source/publication causal contract", () => {
  const overlap: CausalEvent[] = [
    { event: "sourceStart", id: 0, owner: 10, atMs: 0, budgetMs: 10 },
    { event: "sourceStart", id: 1, owner: 20, atMs: 10, budgetMs: 10 },
    { event: "sourceSettlement", id: 0, atMs: 15, outcome: "resolve" },
    { event: "sourceSettlement", id: 1, atMs: 16, outcome: "resolve" },
  ];
  it("rejects an abandoned source's write even after another source succeeds", () => {
    expect(() => assertPublicationCausality([...overlap, { event: "writeDispatch", owner: 10, source: 0, atMs: 17 }])).toThrow(/late raw settlement/);
  });
  it("rejects associating a write with another invocation's accepted source", () => {
    expect(() => assertPublicationCausality([...overlap, { event: "writeDispatch", owner: 10, source: 1, atMs: 17 }])).toThrow(/different invocation/);
  });
  it("accepts later publication from the actual source accepted before its deadline", () => {
    expect(() => assertPublicationCausality([...overlap, { event: "writeDispatch", owner: 20, source: 1, atMs: 30 }])).not.toThrow();
  });
  it("permits pending prefixes and explicit unbounded sources", () => {
    expect(() => assertPublicationCausality(overlap.slice(0, 2))).not.toThrow();
    expect(() => assertPublicationCausality([
      { event: "sourceStart", id: 0, owner: 0, atMs: 0, budgetMs: null },
      { event: "sourceSettlement", id: 0, atMs: 100_000, outcome: "resolve" },
      { event: "writeDispatch", owner: 0, source: 0, atMs: 100_000 },
    ])).not.toThrow();
  });
});
