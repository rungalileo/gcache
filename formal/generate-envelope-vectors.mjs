import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const model = 'formal/dialcache-envelope-vectors.qnt';
export const generator = 'formal/generate-envelope-vectors.mjs';
export const artifact = 'formal/quint-envelope-vectors.json';
export const expectedCases = 297;
export const invariants = ['rawEscapeIsLossless', 'readFailuresPreserveOriginalBinary',
  'readDoesNotConsultNewWritePolicy', 'escapeConsumesExactlyOnePrefix',
  'successfulReadRespectsMarkerAndLimit', 'compressionUsesByteThresholdAndStrictShrink'];
const sources = [model, 'formal/wire-text.qnt', generator];
const sourceHashes = () => Object.fromEntries(sources.map(path => [path,
  createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')]));
const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value;
};
function integer(raw) {
  const value = object(raw, 'ITF integer');
  if (Object.keys(value).join() !== '#bigint' || typeof value['#bigint'] !== 'string' || !/^(0|-?[1-9]\d*)$/.test(value['#bigint'])) throw new Error('Malformed ITF integer');
  const exact = BigInt(value['#bigint']), native = Number(exact);
  if (!Number.isSafeInteger(native) || BigInt(native) !== exact) throw new Error('Inexact envelope integer');
  return native;
}
function list(raw, maximum, label) {
  if (!Array.isArray(raw)) throw new Error(`Missing ${label}`);
  const values = raw.map(integer);
  if (values.some(n => n < 0 || n > maximum)) throw new Error(`Invalid ${label}`);
  return values;
}
const hex = raw => Buffer.from(list(raw, 255, 'bytes')).toString('hex');
const units = raw => String.fromCharCode(...list(raw, 65535, 'UTF-16 units'));
const scalars = raw => {
  const values = list(raw, 0x10ffff, 'Unicode scalars');
  if (values.some(n => n >= 0xd800 && n <= 0xdfff)) throw new Error('Surrogate is not a scalar');
  return String.fromCodePoint(...values);
};
function selection(raw) {
  const value = object(raw, 'write selection');
  if (Object.keys(value).sort().join() !== 'marker,outcome,storedBytes' ||
      !['below_threshold', 'write_over_limit', 'not_smaller', 'compressed'].includes(value.outcome)) throw new Error('Unfinished/invalid write selection');
  const storedBytes = integer(value.storedBytes), marker = integer(value.marker);
  if (storedBytes < 0 || ![-1, 1, 2].includes(marker)) throw new Error('Invalid selected byte count/marker');
  return { outcome: value.outcome, storedBytes, marker };
}

// Translate representation only. In particular this does not apply a marker
// rule, compression threshold, size comparison, decoder, or UTF-8 repair to
// produce expected observations. Both native codec lengths are external input.
export function vectorsFromTrace(trace) {
  const states = object(trace, 'trace').states;
  if (!Array.isArray(states) || states.length !== expectedCases + 1) throw new Error('Incomplete envelope vector history');
  if (object(states[0].input, 'initial input').command !== 'init') throw new Error('Missing envelope initialization');
  const groups = { envelopeVectors: [], compressedDecodeVectors: [], compressionWriteVectors: [] };
  const seen = new Set();
  for (const state of states.slice(1)) {
    const input = object(state.input, 'explicit envelope input'), result = object(state.result, 'Quint envelope result');
    if (Object.keys(input).sort().join() !== 'binary,bytes,codecGoBytes,codecTsBytes,command,decodedBytes,decoderSucceeds,id,label,maximum,thresholdBytes,units,writeEnabled'
      || Object.keys(result).sort().join() !== 'escaped,go,originalBytes,read,typescript'
      || typeof input.binary !== 'boolean' || typeof input.decoderSucceeds !== 'boolean'
      || typeof input.writeEnabled !== 'boolean' || typeof input.label !== 'string') throw new Error('Malformed complete envelope request/result');
    const id = integer(input.id);
    if (id < 0 || id >= expectedCases || seen.has(id)) throw new Error('Invalid or duplicate envelope case');
    seen.add(id);
    const name = `Quint envelope ${String(id).padStart(3, '0')} ${input.command}${input.label ? ` ${input.label}` : ''}`;
    if (input.command === 'write') {
      const originalBytes = integer(result.originalBytes);
      const rawStoredBytes = list(result.escaped, 255, 'escaped bytes').length;
      const codecBytes = { typescript: integer(input.codecTsBytes), go: integer(input.codecGoBytes) };
      const thresholdBytes = integer(input.thresholdBytes), maxDecompressedBytes = integer(input.maximum);
      if (originalBytes < 0 || codecBytes.typescript < 0 || codecBytes.go < 0 || thresholdBytes < 1 || maxDecompressedBytes < 0) throw new Error('Invalid write byte domain');
      groups.compressionWriteVectors.push({ name, payloadType: input.binary ? 'binary' : 'string',
        ...(input.binary ? { payloadHex: hex(input.bytes) } : { payloadUtf8: units(input.units) }),
        thresholdBytes, maxDecompressedBytes, originalBytes, rawStoredBytes,
        escapedHex: hex(result.escaped), codecBytes,
        expectedByBinding: { typescript: selection(result.typescript), go: selection(result.go) } });
    } else if (input.command === 'envelope' || input.command === 'decode') {
      const read = object(result.read, 'read observation');
      if (Object.keys(read).sort().join() !== 'binary,bytes,outcome,scalars' || typeof read.binary !== 'boolean' ||
          !['passthrough', 'decompressed', 'fallback_raw', 'read_over_limit'].includes(read.outcome)) throw new Error('Unfinished/invalid read observation');
      if (input.command === 'envelope') {
        if (!input.binary || !read.binary) throw new Error('Invalid raw binary envelope result');
        groups.envelopeVectors.push({ name, inputHex: hex(input.bytes), escapedHex: hex(result.escaped),
          decodedHex: hex(read.bytes), outcome: read.outcome });
      } else {
        const maximum = integer(input.maximum);
        if (!input.binary || maximum < 1) throw new Error('Invalid decoder fixture domain');
        groups.compressedDecodeVectors.push({ name, inputHex: hex(input.bytes), maxDecompressedBytes: maximum,
          // This records the model policy input. DecompressPayload itself has
          // no write-policy argument; cache-level disabled-write binding is
          // separately replayed by recovery-read's real compressed fixtures.
          newWritesEnabled: input.writeEnabled,
          codecFixture: { succeeds: input.decoderSucceeds, decodedHex: hex(input.decodedBytes) },
          outcome: read.outcome, payloadType: read.binary ? 'binary' : 'string',
          ...(read.binary ? { payloadHex: hex(read.bytes) } : { payloadUtf8: scalars(read.scalars) }) });
      }
    } else throw new Error('Unknown envelope primitive command');
  }
  if (seen.size !== expectedCases) throw new Error('Missing envelope input cases');
  for (const rows of Object.values(groups)) rows.sort((a, b) => a.name.localeCompare(b.name));
  return groups;
}

export function validateGeneratedEnvelopeVectors(value) {
  if (value.schemaVersion !== 3 || value.provenance?.model !== model ||
      JSON.stringify(value.provenance.sourceSha256) !== JSON.stringify(sourceHashes())) throw new Error('Stale Quint envelope vector artifact');
  const groups = ['envelopeVectors', 'compressedDecodeVectors', 'compressionWriteVectors'];
  if (groups.some((group, index) => !Array.isArray(value[group]) || value[group].length !== [15,156,126][index])) throw new Error('Incomplete envelope vector inventory');
  const rows = groups.flatMap(group => value[group]);
  if (rows.length !== expectedCases || new Set(rows.map(row => row.name)).size !== expectedCases ||
      rows.some((row,index) => typeof row.name !== 'string' || !row.name.startsWith(`Quint envelope ${String(index).padStart(3,'0')} `))) throw new Error('Incomplete envelope vector inventory');
  return value;
}
export function readGeneratedEnvelopeVectors() {
  return validateGeneratedEnvelopeVectors(JSON.parse(readFileSync(resolve(root, artifact), 'utf8')));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || !['--check', '--write'].includes(process.argv[2])) throw new Error('Use --check or --write');
  const directory = resolve(root, '.formal-traces/vector/envelope');
  mkdirSync(directory, { recursive: true });
  const history = resolve(directory, 'allEnvelopeVectorsTest.itf.json');
  const run = spawnSync('quint', ['test', model, '--backend=rust', '--max-samples=1', '--seed=0xd1a1ca',
    '--match=^allEnvelopeVectorsTest$', `--out-itf=${directory}/{test}.itf.json`], { cwd: root, stdio: 'inherit' });
  if (run.error) throw run.error;
  if (run.status !== 0) process.exit(run.status ?? 1);
  const generated = { schemaVersion: 3, provenance: { model, sourceSha256: sourceHashes() },
    ...vectorsFromTrace(JSON.parse(readFileSync(history, 'utf8'))) };
  const encoded = JSON.stringify(generated, null, 2) + '\n';
  if (process.argv[2] === '--write') writeFileSync(resolve(root, artifact), encoded);
  else if (readFileSync(resolve(root, artifact), 'utf8') !== encoded) throw new Error('Quint envelope vectors changed; review and regenerate');
  console.log(`Verified ${expectedCases} Quint envelope/compression primitive cases`);
}
