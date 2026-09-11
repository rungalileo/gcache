import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

// Pin the release bytes independently of Quint's installation or download cache.
// Cached and explicitly supplied archives receive the same verification on every run.
export async function verifyArchive(path, expected) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  const actual = digest.digest('hex');
  if (actual !== expected) throw new Error(`Apalache archive checksum mismatch: ${path}. Expected ${expected}, found ${actual}. Replace it with the approved release archive.`);
  return actual;
}

export async function prepareApalache(specification, { output, archivePath = process.env.APALACHE_ARCHIVE } = {}) {
  const { version, archive } = specification;
  if (version !== '0.56.1' || archive?.url !== `https://github.com/apalache-mc/apalache/releases/download/v${version}/apalache-${version}.tgz`
    || !/^[a-f0-9]{64}$/.test(archive.sha256)) throw new Error('Expected a versioned Apalache release URL and approved SHA-256.');
  const supplied = archivePath !== undefined;
  archivePath = resolve(archivePath ?? resolve(homedir(), '.cache/dialcache/apalache', version, 'archive.tgz'));
  if (!existsSync(archivePath)) {
    if (supplied) throw new Error(`APALACHE_ARCHIVE does not exist: ${archivePath}`);
    mkdirSync(dirname(archivePath), { recursive: true });
    const staging = mkdtempSync(resolve(dirname(archivePath), 'download-'));
    try {
      console.log(`Download Apalache ${version} from ${archive.url}`);
      const response = await fetch(archive.url, { signal: AbortSignal.timeout(180_000) });
      if (!response.ok || !response.body) throw new Error(`Apalache download failed: HTTP ${response.status}`);
      const downloaded = resolve(staging, 'archive.tgz');
      await pipeline(response.body, createWriteStream(downloaded));
      await verifyArchive(downloaded, archive.sha256);
      renameSync(downloaded, archivePath);
    } finally { rmSync(staging, { recursive: true, force: true }); }
  }
  await verifyArchive(archivePath, archive.sha256);
  mkdirSync(output, { recursive: true });
  const installation = mkdtempSync(resolve(output, 'apalache-'));
  const cleanup = () => rmSync(installation, { recursive: true, force: true });
  try {
    // Always extract verified bytes afresh; a changed cached executable cannot run.
    const distribution = resolve(installation, 'distribution');
    mkdirSync(distribution);
    const result = spawnSync('tar', ['-xzf', archivePath, '--strip-components=1', '-C', distribution], { encoding: 'utf8', timeout: 60_000 });
    if (result.error || result.status !== 0) throw new Error(`Cannot extract verified Apalache archive: ${result.error?.message ?? result.stderr}`);
    const launcher = resolve(distribution, 'bin/apalache-mc');
    const jar = resolve(distribution, 'lib/apalache.jar');
    if (!existsSync(launcher) || !existsSync(jar)) throw new Error('Verified Apalache archive is missing its launcher or JAR.');
    // Quint 0.32 tries its own downloader if a gRPC connection fails. Its
    // documented QUINT_HOME override isolates that fallback and points it only
    // at these approved bytes; no user cache or alternate download is involved.
    const quintHome = resolve(installation, 'quint-home');
    const fallback = resolve(quintHome, `apalache-dist-${version}`);
    mkdirSync(fallback, { recursive: true });
    symlinkSync(distribution, resolve(fallback, 'apalache'), 'dir');
    return { launcher, jar, quintHome, archive: { path: archivePath, url: archive.url, sha256: archive.sha256 }, cleanup };
  } catch (error) { cleanup(); throw error; }
}
