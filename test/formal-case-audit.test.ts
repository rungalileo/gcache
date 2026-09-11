import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const checker = fileURLToPath(new URL("../formal/check-semantic-coverage.mjs", import.meta.url));
type Entry = { case: string; reference: string; kind: string; scope: string };
type Audit = { checks: Entry[]; definitions: Entry[] };
const freshAudit = (): Audit => JSON.parse(readFileSync(
  new URL("../formal/quint-case-audit.json", import.meta.url), "utf8",
)) as Audit;
const check = (audit: Audit): string => execFileSync(process.execPath, [checker, "--audit-stdin"], {
  input: JSON.stringify(audit), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
});

describe("Quint case applicability metadata", () => {
  it("validates checked scopes separately from transition definitions without Quint", () => {
    const result = JSON.parse(check(freshAudit())) as { scopedChecks: number; definitions: number };
    expect(result.scopedChecks).toBeGreaterThan(0);
    expect(result.definitions).toBeGreaterThan(0);
  });

  it("rejects a cited check without its reviewed scope", () => {
    const audit = freshAudit();
    audit.checks[0]!.scope = " ";
    expect(() => check(audit)).toThrow(/Invalid\/duplicate Quint case audit entry/);
    audit.checks.shift();
    expect(() => check(audit)).toThrow(/Missing Quint case applicability scope/);
  });

  it("rejects attaching a scheduled property to a case that does not cite it", () => {
    const audit = freshAudit();
    audit.checks[0]!.case = "C01.no-deadline";
    expect(() => check(audit)).toThrow(/not a cited scheduled/);
  });

  it("rejects claiming a transition helper as an independently scheduled check", () => {
    const audit = freshAudit();
    audit.checks[0]!.reference = "formal/dialcache-core.qnt:localWriteEligible";
    expect(() => check(audit)).toThrow(/not a cited scheduled/);
  });

  it("rejects mislabeled or missing transition definitions", () => {
    const audit = freshAudit();
    audit.definitions[0]!.kind = "invariant";
    expect(() => check(audit)).toThrow(/not a transition\/helper\/predicate/);
    audit.definitions[0]!.kind = "transition";
    audit.definitions[0]!.reference = "formal/dialcache-core.qnt:missingAction";
    expect(() => check(audit)).toThrow(/not a transition\/helper\/predicate/);
  });
});
