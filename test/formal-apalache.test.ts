import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { prepareApalache } = await import(new URL("../formal/apalache.mjs", import.meta.url).href) as {
  prepareApalache(specification: unknown, options: { output: string; archivePath: string }): Promise<{
    launcher: string; jar: string; quintHome: string; archive: { path: string; sha256: string }; cleanup(): void;
  }>;
};

describe("approved standalone Apalache distribution", () => {
  let directory: string;
  let archivePath: string;
  let output: string;
  let specification: { version: string; archive: { url: string; sha256: string } };
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "dialcache-apalache-"));
    output = join(directory, "output");
    archivePath = join(directory, "fixture.tgz");
    mkdirSync(join(directory, "release/bin"), { recursive: true });
    mkdirSync(join(directory, "release/lib"));
    writeFileSync(join(directory, "release/bin/apalache-mc"), "fixture launcher", { mode: 0o755 });
    writeFileSync(join(directory, "release/lib/apalache.jar"), "approved fixture jar");
    execFileSync("tar", ["-czf", archivePath, "-C", directory, "release"]);
    specification = { version: "0.56.1", archive: {
      url: "https://github.com/apalache-mc/apalache/releases/download/v0.56.1/apalache-0.56.1.tgz",
      sha256: createHash("sha256").update(readFileSync(archivePath)).digest("hex"),
    } };
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("verifies supplied bytes and reconstructs the executable from the archive each time", async () => {
    const first = await prepareApalache(specification, { output, archivePath });
    try {
      expect(first.archive).toMatchObject({ path: archivePath, sha256: specification.archive.sha256 });
      expect(realpathSync(join(first.quintHome, "apalache-dist-0.56.1/apalache/bin/apalache-mc"))).toBe(realpathSync(first.launcher));
      writeFileSync(first.jar, "changed extracted jar");
      const second = await prepareApalache(specification, { output, archivePath });
      try {
        expect(second.jar).not.toBe(first.jar);
        expect(readFileSync(second.jar, "utf8")).toBe("approved fixture jar");
      } finally { second.cleanup(); }
    } finally { first.cleanup(); }
    expect(readdirSync(output)).toEqual([]);
  });

  it("rejects a changed archive before extraction even when the version and path match", async () => {
    const bytes = readFileSync(archivePath);
    writeFileSync(archivePath, Buffer.concat([bytes, Buffer.from("changed release")]));
    await expect(prepareApalache(specification, { output, archivePath })).rejects.toThrow(/checksum mismatch/);
    expect(existsSync(output)).toBe(false);
  });

  it("rejects missing explicit archives and unapproved download coordinates without downloading", async () => {
    await expect(prepareApalache(specification, { output, archivePath: join(directory, "missing.tgz") })).rejects.toThrow(/APALACHE_ARCHIVE does not exist/);
    for (const changed of [
      { ...specification, version: "0.56.0" },
      { ...specification, archive: { ...specification.archive, url: "https://example.com/apalache.tgz" } },
      { ...specification, archive: { ...specification.archive, sha256: "" } },
    ]) await expect(prepareApalache(changed, { output, archivePath })).rejects.toThrow(/versioned Apalache release URL and approved SHA-256/);
    expect(existsSync(output)).toBe(false);
  });
});
