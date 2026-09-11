import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type ExportModel = { path: string; vectorExport: { artifact: string; sources: string[]; cases: number; kind: string } };
type Artifact = { provenance: { model: string; sourceSha256: Record<string, string> }; [group: string]: unknown };
const manifest = JSON.parse(readFileSync(new URL("../formal/execution.json", import.meta.url), "utf8")) as { models: ExportModel[] };
const url = new URL("../formal/vector-artifacts.mjs", import.meta.url).href;
const { readVectorArtifact, protocolCorpus } = await import(url) as {
  readVectorArtifact(model: ExportModel, options?: { readSource(path: string): string }): Artifact;
  protocolCorpus(manifest?: unknown, selection?: string): Record<string, unknown>;
};
const model = manifest.models.find(m => m.vectorExport?.kind === "protocol")!;
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const artifact = (): Artifact => JSON.parse(read(model.vectorExport.artifact)) as Artifact;
const check = (value: Artifact) => readVectorArtifact(model, { readSource: path => path === model.vectorExport.artifact ? JSON.stringify(value) : read(path) });


describe("Quint vector artifact authority", () => {
  it("requires complete current source fingerprints, including helper libraries", () => {
    expect(() => check(artifact())).not.toThrow();
    const stale = artifact(); stale.provenance.sourceSha256[model.vectorExport.sources[0]!] = "0".repeat(64);
    expect(() => check(stale)).toThrow(/Stale generated vector source/);
    const incomplete = artifact(); delete incomplete.provenance.sourceSha256[model.vectorExport.sources.at(-1)!];
    expect(() => check(incomplete)).toThrow(/Incomplete vector source fingerprint/);
    const different = artifact(); different.provenance.model = "formal/unrelated.qnt";
    expect(() => check(different)).toThrow(/provenance/);
  });
  it("rejects missing rows and duplicate names even if the artifact still parses", () => {
    const missing = artifact(); (Object.values(missing).find(Array.isArray) as unknown[]).pop();
    expect(() => check(missing)).toThrow(/Incomplete or duplicate generated vector inventory/);
    const duplicate = artifact(); const group = Object.values(duplicate).find(Array.isArray) as Array<{ name: string }>;
    group[1]!.name = group[0]!.name;
    expect(() => check(duplicate)).toThrow(/Incomplete or duplicate generated vector inventory/);
  });
  it("partitions fixed and Quint-generated primitive tests without dropping or double-counting rows", () => {
    const names = (selection: string) => new Set(Object.entries(protocolCorpus(undefined, selection))
      .filter((entry): entry is [string, Array<{ name: string }>] => Array.isArray(entry[1]))
      .flatMap(([group, rows]) => rows.map(row => `${group}/${row.name}`)));
    const all = names("all"), fixed = names("fixed"), generated = names("generated");
    expect(fixed.size).toBe(134);
    expect(generated.size).toBe(manifest.models.filter(m => m.vectorExport?.kind === "protocol").reduce((n, m) => n + m.vectorExport.cases, 0));
    expect([...fixed].some(name => generated.has(name))).toBe(false);
    expect(new Set([...fixed, ...generated])).toEqual(all);
    expect(() => protocolCorpus(undefined, "unreviewed")).toThrow(/Unknown protocol corpus selection/);
  });
});
