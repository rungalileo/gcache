import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type Entry = { line: number; title: string };
type Snapshot = { path: string; sha256: string; entries: Entry[] };
type Review = { kind: string; scope: string; contracts?: string[]; revisions?: string[] };
type Guide = Snapshot & { review?: Review };
type Audit = {
  schemaVersion: number;
  sources: Array<Omit<Snapshot, "entries"> & { entries: Array<Entry & { contracts: string[] }> }>;
  reviewedGuides: Guide[];
};
const { sourceSnapshot, guideSnapshot, checkSourceAudit } = await import(
  new URL("../formal/check-source-audit.mjs", import.meta.url).href,
) as {
  sourceSnapshot(directory: string): Snapshot[];
  guideSnapshot(directory: string): Snapshot[];
  checkSourceAudit(audit?: unknown, options?: { directory: string }): unknown;
};

describe("reviewed documentation freshness", () => {
  let directory: string;
  let audit: Audit;
  const put = (path: string, text: string) => writeFileSync(join(directory, path), text);
  const guide = (path = "formal/PORTING.md") => audit.reviewedGuides.find(entry => entry.path === path)!;
  const check = (input: unknown = audit) => checkSourceAudit(input, { directory });

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "dialcache-source-audit-"));
    for (const path of ["docs", "test", "formal", "go"]) mkdirSync(join(directory, path));
    put("README.md", "# Example library\n");
    put("docs/usage.md", "# Public usage\n\nReviewed behavior.\n");
    put("test/cache.test.ts", 'it("returns the value", () => {});\n');
    put("formal/CONTRACTS.md", "# Contracts\n\n| C01 | Admission |\n| B01 | Native API |\n");
    put("formal/PORTING.md", "# Porting\n\n## Native driver\n\nReview the real observations.\n");
    put("formal/VALIDATION.md", "# Validation snapshots\n\n## Prior run\n\nAn earlier revision passed two tests.\n");
    put("go/README.md", "# Go port\n\nThe native API uses explicit contexts.\n");
    audit = {
      schemaVersion: 1,
      sources: sourceSnapshot(directory).map(source => ({ ...source,
        entries: source.entries.map(entry => ({ ...entry, contracts: ["C01"] })),
      })),
      reviewedGuides: guideSnapshot(directory).map(source => ({ ...source,
        review: source.path === "formal/VALIDATION.md"
          ? { kind: "historical-evidence", scope: "A preserved prior execution with its original revision and results.", revisions: ["a".repeat(40)] }
          : source.path === "formal/PORTING.md"
            ? { kind: "tooling-guide", scope: "Instructions for collecting native observations and producing reports." }
            : { kind: "contract-guide", scope: "An explanation of the public admission and binding requirements.", contracts: ["C01", "B01"] },
      })),
    };
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("checks guides separately from public behavior mappings and preserves historical results", () => {
    expect(check()).toEqual({ sources: 3, tests: 1, sections: 2, reviewedGuides: 4, guideSections: 6 });
    guide().review = { kind: "coverage-guide", scope: "Describes finite evidence accounting without claiming all histories pass.", contracts: [] };
    put("formal/source-audit.json", JSON.stringify(audit));
    expect(checkSourceAudit(undefined, { directory })).toMatchObject({ reviewedGuides: 4 });
  });

  it("rejects a body-only edit even when the section inventory stays unchanged", () => {
    const path = "formal/PORTING.md";
    const before = readFileSync(join(directory, path), "utf8");
    put(path, before.replace("real observations", "expected model values"));
    expect(guideSnapshot(directory).find(entry => entry.path === path)!.entries).toEqual(guide(path).entries);
    expect(() => check()).toThrow(/formal\/PORTING.md: contents changed/);
    put(path, before);
    expect(check()).toMatchObject({ reviewedGuides: 4 });
  });

  it("rejects a newly added or removed guide", () => {
    put("formal/NEW.md", "# New guide\n");
    expect(() => check()).toThrow(/guide file inventory/);
    rmSync(join(directory, "formal/NEW.md"));
    rmSync(join(directory, "formal/PORTING.md"));
    expect(() => check()).toThrow(/guide file inventory/);
  });

  it("requires the guide collection and rejects duplicate or extra recorded files", () => {
    const { reviewedGuides: _guides, ...missing } = audit;
    expect(() => check(missing)).toThrow(/guide file inventory/);
    for (const path of [guide().path, "formal/UNREVIEWED.md"]) {
      const input = structuredClone(audit);
      input.reviewedGuides.push({ ...structuredClone(guide()), path });
      expect(() => check(input)).toThrow(/guide file inventory/);
    }
  });

  it.each([
    ["added", "# Porting\n\n## Native driver\n\n## New requirement\n"],
    ["removed", "# Porting\n\nThe driver requirement was removed.\n"],
  ])("rejects a %s section even if only the content fingerprint is refreshed", (_, text) => {
    put("formal/PORTING.md", text);
    guide().sha256 = guideSnapshot(directory).find(entry => entry.path === guide().path)!.sha256;
    expect(() => check()).toThrow(/guide section inventory/);
  });

  it("rejects missing or duplicate recorded headings", () => {
    for (const mutate of [(entries: Entry[]) => entries.pop(), (entries: Entry[]) => entries.push(entries[0]!)]) {
      const input = structuredClone(audit);
      mutate(input.reviewedGuides.find(entry => entry.path === guide().path)!.entries);
      expect(() => check(input)).toThrow(/guide section inventory/);
    }
  });

  it("requires an explicit valid review and a nonblank explanation", () => {
    const missing = structuredClone(audit);
    delete missing.reviewedGuides[0]!.review;
    expect(() => check(missing)).toThrow(/review kind/);
    guide().review!.kind = "verified-everything";
    expect(() => check()).toThrow(/review kind/);
    guide().review!.kind = "tooling-guide";
    for (const scope of ["", " \n\t "]) {
      guide().review!.scope = scope;
      expect(() => check()).toThrow(/reviewed guide scope/);
    }
  });

  it("requires valid unique contract IDs without assigning behavior to tooling", () => {
    guide().review = { kind: "contract-guide", scope: "Explains admission requirements." };
    expect(() => check()).toThrow(/guide contract IDs/);
    for (const contracts of [[], ["C99"], ["C01", "C01"]]) {
      guide().review!.contracts = contracts;
      expect(() => check()).toThrow(/guide contract IDs/);
    }
    guide().review = { kind: "tooling-guide", scope: "Explains report preparation without claiming behavioral coverage.", contracts: ["C99"] };
    expect(() => check()).toThrow(/guide contract IDs/);
    delete guide().review!.contracts;
    expect(check()).toMatchObject({ reviewedGuides: 4 });
  });

  it("requires full unique revision identities for historical evidence", () => {
    const review = guide("formal/VALIDATION.md").review!;
    delete review.revisions;
    expect(() => check()).toThrow(/historical revision identity/);
    for (const revisions of [[], ["a".repeat(7)], ["z".repeat(40)], ["a".repeat(40), "A".repeat(40)]]) {
      review.revisions = revisions;
      expect(() => check()).toThrow(/historical revision identity/);
    }
  });

  it("uses the same fenced-code parsing for public and formal guides", () => {
    const text = ["# Porting", "````markdown", "# Hidden", "```", "## Still hidden", "~~~~",
      "## Wrong marker", "```` trailing text", "## Invalid closer", "`````  ", "## After",
      "~~~text", "# Hidden too", "~~~", "### End"].join("\r\n");
    put("formal/PORTING.md", text);
    put("docs/usage.md", text);
    const expected = [{ line: 1, title: "Porting" }, { line: 11, title: "After" }, { line: 15, title: "End" }];
    expect(guideSnapshot(directory).find(entry => entry.path === "formal/PORTING.md")!.entries).toEqual(expected);
    expect(sourceSnapshot(directory).find(entry => entry.path === "docs/usage.md")!.entries).toEqual(expected);
  });

  it("retains the existing public source freshness gate", () => {
    put("docs/usage.md", "# Public usage\n\nA changed public obligation.\n");
    expect(() => check()).toThrow(/docs\/usage.md: contents changed/);
  });
});
