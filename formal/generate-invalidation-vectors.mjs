import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const model = 'formal/dialcache-invalidation-transition.qnt';
export const generator = 'formal/generate-invalidation-vectors.mjs';
export const artifact = 'formal/quint-invalidation-vectors.json';
export const expectedCases = 288;
export const invariants = [
  'rejectedInputPreservesEntireRedisState', 'argumentValidationIsExact',
  'successfulCutoffIsExactMaximum', 'successfulRetentionMeetsBothFloors',
  'stringsKeepExistingRetention', 'unrelatedTypesReceiveFiniteRepair',
  'outputIsCanonicalDecimalString', 'finiteRetentionIsExact',
];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceHashes = () => Object.fromEntries([model, generator].map(path => [path, sha256(readFileSync(resolve(root, path)))]));
const object = (value, label) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value;
};
const keys = value => Object.keys(value).sort().join(',');
function integer(value) {
  const encoded = object(value, 'ITF integer');
  if (keys(encoded) !== '#bigint' || typeof encoded['#bigint'] !== 'string' || !/^(0|-?[1-9]\d*)$/.test(encoded['#bigint'])) throw new Error('Invalid ITF integer');
  const n = Number(encoded['#bigint']);
  if (!Number.isSafeInteger(n)) throw new Error('Unsafe exported observation');
  return n;
}
function text(value) {
  if (!Array.isArray(value)) throw new Error('Missing model text');
  const scalars = value.map(integer);
  if (scalars.some(n => n < 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff))) throw new Error('Invalid model text scalar');
  return String.fromCodePoint(...scalars);
}
function redisState(raw) {
  const value = object(raw, 'Redis state');
  if (keys(value) !== 'kind,ttlMs,value,values' || !Array.isArray(value.values)) throw new Error('Incomplete modeled Redis state');
  const kind = integer(value.kind), ttlMs = integer(value.ttlMs);
  if (kind === 0) {
    if (ttlMs !== -2 || text(value.value) !== '' || value.values.length !== 0) throw new Error('Invalid modeled absence');
    return { kind: 'absent', ttlMs };
  }
  if (ttlMs !== -1 && ttlMs <= 0) throw new Error('Invalid modeled retention');
  if (kind === 1) {
    if (value.values.length !== 0) throw new Error('Unexpected list contents on string');
    return { kind: 'string', value: text(value.value), ttlMs };
  }
  if (kind !== 2 || text(value.value) !== '' || value.values.length === 0) throw new Error('Invalid modeled list');
  return { kind: 'list', values: value.values.map(text), ttlMs };
}

// This converter translates representation only. It never parses decimal
// arguments, chooses a cutoff/TTL, repairs storage, or computes an expected
// outcome. Every expected field below comes from the Quint after-state.
export function vectorsFromTrace(trace) {
  const states = object(trace, 'trace').states;
  if (!Array.isArray(states) || states.length !== expectedCases + 1) throw new Error('Incomplete Quint vector history');
  if (object(states[0].input, 'initial input').name !== 'init') throw new Error('Missing vector initialization');
  const byCase = new Map();
  for (const state of states.slice(1)) {
    const input = object(state.input, 'explicit vector input'), output = object(state.s, 'vector observation');
    if (keys(input) !== 'caseId,existing,futureBuffer,invalidatedAt,label,name,priorLabel' || input.name !== 'invalidate'
      || typeof input.label !== 'string' || typeof input.priorLabel !== 'string') throw new Error('Invalid explicit vector input');
    const id = integer(input.caseId), outcome = integer(output.outcome);
    if (id < 0 || id >= expectedCases || byCase.has(id) || ![1, 2].includes(outcome)) throw new Error('Invalid or duplicate modeled vector');
    byCase.set(id, {
      name: `Quint ${String(id).padStart(3, '0')}: ${input.label} / ${input.priorLabel}`,
      existing: redisState(input.existing), futureBufferMs: text(input.futureBuffer), invalidatedAtMs: text(input.invalidatedAt),
      expected: { ...(outcome === 2 ? { error: true } : {}), state: redisState(output.after) },
    });
  }
  const remaining = object(states.at(-1).s.remaining, 'remaining case inventory');
  if (keys(remaining) !== '#set' || !Array.isArray(remaining['#set']) || remaining['#set'].length !== 0 || byCase.size !== expectedCases) throw new Error('Quint did not export every declared input combination');
  return Array.from({ length: expectedCases }, (_, index) => byCase.get(index));
}
function validateState(value) {
  object(value, 'committed Redis state');
  if (value.kind === 'absent') {
    if (keys(value) !== 'kind,ttlMs' || value.ttlMs !== -2) throw new Error('Invalid committed absence');
  } else if (value.kind === 'string') {
    if (keys(value) !== 'kind,ttlMs,value' || typeof value.value !== 'string') throw new Error('Invalid committed string');
  } else if (value.kind === 'list') {
    if (keys(value) !== 'kind,ttlMs,values' || !Array.isArray(value.values) || !value.values.length || value.values.some(v => typeof v !== 'string')) throw new Error('Invalid committed list');
  } else throw new Error('Unknown committed Redis state');
  if (!Number.isSafeInteger(value.ttlMs) || (value.kind !== 'absent' && value.ttlMs !== -1 && value.ttlMs <= 0)) throw new Error('Invalid committed retention');
}
export function validateGeneratedInvalidationVectors(raw) {
  const value = object(raw, 'invalidation corpus');
  const provenance = object(value.provenance, 'vector provenance');
  if (value.schemaVersion !== 2 || provenance.model !== model
    || JSON.stringify(provenance.sourceSha256) !== JSON.stringify(sourceHashes())) throw new Error('Stale Quint invalidation vectors: run generator --write and review the model-derived artifact');
  if (!Array.isArray(value.vectors) || value.vectors.length !== expectedCases) throw new Error('Incomplete committed Quint invalidation vectors');
  for (const [index, vector] of value.vectors.entries()) {
    if (typeof vector.name !== 'string' || !vector.name.startsWith(`Quint ${String(index).padStart(3, '0')}: `)
      || typeof vector.futureBufferMs !== 'string' || typeof vector.invalidatedAtMs !== 'string') throw new Error('Invalid committed vector input');
    validateState(vector.existing); validateState(vector.expected.state);
    if (vector.expected.error !== undefined && vector.expected.error !== true) throw new Error('Invalid committed vector outcome');
  }
  return value;
}

export function readGeneratedInvalidationVectors() {
  return validateGeneratedInvalidationVectors(JSON.parse(readFileSync(resolve(root, artifact), 'utf8')));
}

export function generateInvalidationVectors(mode) {
  if (!['--check', '--write'].includes(mode)) throw new Error('Usage: node formal/generate-invalidation-vectors.mjs --check|--write');
  const output = resolve(root, '.formal-traces/vector/invalidation/trace.itf.json');
  mkdirSync(dirname(output), { recursive: true });
  const result = spawnSync('quint', ['run', model, '--backend=rust', '--n-threads=1', '--seed=0xd1a1ca',
    '--max-samples=1', `--max-steps=${expectedCases}`, '--n-traces=1', `--out-itf=${output}`, '--verbosity=1', '--invariants', ...invariants], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Quint invalidation export failed: ${result.status}`);
  const vectors = vectorsFromTrace(JSON.parse(readFileSync(output, 'utf8')));
  const corpus = { schemaVersion: 2, provenance: { model, sourceSha256: sourceHashes() }, vectors };
  const serialized = JSON.stringify(corpus, null, 2) + '\n';
  if (mode === '--write') writeFileSync(resolve(root, artifact), serialized);
  else if (readFileSync(resolve(root, artifact), 'utf8') !== serialized) throw new Error('Committed invalidation predictions differ from fresh Quint output');
  console.log(`Quint invalidation vectors: ${vectors.length} complete input combinations ${mode === '--check' ? 'verified' : 'written'}`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Expected exactly --check or --write');
  generateInvalidationVectors(process.argv[2]);
}
