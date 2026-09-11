import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFileSync(root + path, 'utf8');

// Ordinary test runs need no Quint installation, but they must reject a stale
// generated artifact. Generation separately reruns Quint and compares bytes.
export function readVectorArtifact(model, { readSource = read } = {}) {
  const spec = model.vectorExport;
  const value = JSON.parse(readSource(spec.artifact));
  if (value.provenance?.model !== model.path || value.schemaVersion !== (spec.kind === 'protocol' ? 3 : 2)) throw new Error('Invalid generated vector provenance/schema');
  const hashes = value.provenance.sourceSha256;
  if (!hashes || JSON.stringify(Object.keys(hashes).sort()) !== JSON.stringify([...spec.sources].sort())) throw new Error('Incomplete vector source fingerprint');
  for (const path of spec.sources) {
    if (hashes[path] !== createHash('sha256').update(readSource(path)).digest('hex')) throw new Error(`Stale generated vector source: ${path}`);
  }
  const rows = spec.kind === 'invalidation' ? value.vectors : Object.values(value).filter(Array.isArray).flat();
  if (!Array.isArray(rows) || rows.length !== spec.cases || rows.some(row => typeof row.name !== 'string' || !row.name)
    || new Set(rows.map(row => row.name)).size !== rows.length) throw new Error('Incomplete or duplicate generated vector inventory');
  return value;
}

export function protocolCorpus(manifest = JSON.parse(read('formal/execution.json')), selection = 'all') {
  if (!['all', 'generated', 'fixed'].includes(selection)) throw new Error('Unknown protocol corpus selection');
  const corpus = JSON.parse(read('formal/protocol-vectors.json'));
  if (selection === 'generated') for (const group of Object.keys(corpus)) if (Array.isArray(corpus[group])) corpus[group] = [];
  for (const model of manifest.models.filter(model => model.vectorExport?.kind === 'protocol')) {
    const artifact = readVectorArtifact(model);
    if (selection === 'fixed') continue;
    for (const [group, rows] of Object.entries(artifact).filter(([, value]) => Array.isArray(value))) {
      if (!Array.isArray(corpus[group])) throw new Error(`Review new protocol vector group: ${group}`);
      corpus[group].push(...rows);
    }
  }
  for (const rows of Object.values(corpus).filter(Array.isArray)) {
    if (new Set(rows.map(row => row.name)).size !== rows.length) throw new Error('Duplicate protocol vector name');
  }
  return corpus;
}
