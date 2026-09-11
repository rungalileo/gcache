import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const model = 'formal/dialcache-frame-vectors.qnt';
export const generator = 'formal/generate-frame-vectors.mjs';
export const artifact = 'formal/quint-frame-vectors.json';
export const expectedCases = 589;
export const invariants = ['encodedFrameKeepsHeaderAndPayload', 'decodedTextContainsOnlyScalars',
  'trackedHitsStrictlyClearValidFence', 'absentValueKeepsItsOwnClassification', 'acceptedDurationWithinCeiling', 'writerRejectsInvalidNumericDomain'];
const sources = [model, 'formal/wire-text.qnt', generator, 'formal/cache-rules.qnt'];
const sourceHashes = () => Object.fromEntries(sources.map(path => [path,
  createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')]));
const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value;
};
function integer(raw) {
  const value = object(raw, 'ITF integer');
  if (Object.keys(value).join() !== '#bigint' || typeof value['#bigint'] !== 'string' || !/^(0|-?[1-9]\d*)$/.test(value['#bigint'])) throw new Error('Malformed ITF integer');
  // 2^53 is deliberately supplied as an invalid writer timestamp. It is
  // exactly representable; adjacent unrepresentable integers are rejected.
  const exact = BigInt(value['#bigint']);
  const converted = Number(exact);
  if (!Number.isInteger(converted) || BigInt(converted) !== exact) throw new Error('Inexact native vector integer');
  return converted;
}
function list(raw, maximum, label) {
  if (!Array.isArray(raw)) throw new Error(`Missing ${label}`);
  const values = raw.map(integer);
  if (values.some(n => n < 0 || n > maximum)) throw new Error(`Invalid ${label}`);
  return values;
}
const bytes = raw => Buffer.from(list(raw, 255, 'bytes')).toString('hex');
const units = raw => String.fromCharCode(...list(raw, 65535, 'UTF-16 units'));
const scalars = raw => {
  const values = list(raw, 0x10ffff, 'Unicode scalars');
  if (values.some(n => n >= 0xd800 && n <= 0xdfff)) throw new Error('Surrogate is not a scalar');
  return String.fromCodePoint(...values);
};
function numberInput(raw) {
  const value = object(raw, 'numeric input');
  if (Object.keys(value).sort().join() !== 'denominator,numeratorHigh,numeratorLow,special' || !['', 'NaN', 'Infinity', '-Infinity'].includes(value.special)) throw new Error('Malformed numeric input');
  const denominator = integer(value.denominator);
  const high = integer(value.numeratorHigh), low = integer(value.numeratorLow);
  const exact = BigInt(high) * 1000000n + BigInt(low);
  const numerator = Number(exact);
  if (BigInt(numerator) !== exact) throw new Error('Inexact numeric input');
  if (denominator <= 0) throw new Error('Invalid numeric denominator');
  return { input: numerator / denominator, ...(value.special ? { specialInput: value.special } : {}) };
}

// All expected bytes, Unicode scalars, miss causes, fences and durations below
// come directly from Quint. This converter never runs a decoder, UTF-8 codec,
// timestamp validator, frame constructor or rounding rule to obtain them.
export function vectorsFromTrace(trace) {
  const states = object(trace, 'trace').states;
  if (!Array.isArray(states) || states.length !== expectedCases + 1) throw new Error('Incomplete frame vector history');
  if (object(states[0].input, 'initial input').command !== 'init') throw new Error('Missing frame vector initialization');
  const groups = { frameVectors: [], trackedDecodeVectors: [], untrackedDecodeVectors: [], invalidTimestampVectors: [], durationVectors: [] };
  const seen = new Set();
  for (const state of states.slice(1)) {
    const input = object(state.input, 'explicit primitive input'), result = object(state.result, 'Quint primitive result');
    if (Object.keys(input).sort().join() !== 'binary,bytes,command,id,present,timestamp,tracked,units,watermark,watermarkPresent'
      || Object.keys(result).sort().join() !== 'bytes,duration,fence,kind,payloadType,reason,scalars,timestamp'
      || typeof input.binary !== 'boolean') throw new Error('Malformed complete primitive request/result');
    const id = integer(input.id);
    if (id < 0 || id >= expectedCases || seen.has(id)) throw new Error('Invalid or duplicate frame case');
    seen.add(id);
    const name = `Quint frame ${String(id).padStart(3, '0')} ${input.command}`;
    if (input.command === 'encode') {
      const numeric = numberInput(input.timestamp);
      if (result.kind === 'timestamp_error') groups.invalidTimestampVectors.push({ name, ...numeric });
      else if (result.kind === 'frame') groups.frameVectors.push({ name, createdAtMs: numeric.input,
        payloadType: input.binary ? 'binary' : 'string',
        ...(input.binary ? { payloadHex: bytes(input.bytes) } : { payloadUtf8: units(input.units) }), frameHex: bytes(result.bytes) });
      else throw new Error('Invalid encoded frame observation');
    } else if (input.command === 'decode') {
      if (typeof input.tracked !== 'boolean' || typeof input.present !== 'boolean' || typeof input.watermarkPresent !== 'boolean') throw new Error('Invalid decoder input flags');
      const frameHex = input.present ? bytes(input.bytes) : null;
      let expected;
      if (result.kind === 'hit') {
        if (!['binary', 'string'].includes(result.payloadType)) throw new Error('Invalid modeled payload type');
        const binary = result.payloadType === 'binary';
        expected = { kind: 'hit', createdAtMs: integer(result.timestamp), payloadType: result.payloadType,
          ...(binary ? { payloadHex: bytes(result.bytes) } : { payloadUtf8: scalars(result.scalars) }) };
      } else if (result.kind === 'miss') {
        if (!['value_absent', 'unclassified', 'watermark_fenced'].includes(result.reason)) throw new Error('Unknown modeled miss');
        const fence = integer(result.fence);
        expected = { kind: 'miss', reason: result.reason, ...(fence < 0 ? {} : { observedWatermarkMs: fence }) };
      } else if (result.kind === 'payload_encoding_error') expected = { kind: 'payload_encoding_error' };
      else throw new Error('Invalid decoder observation');
      const watermark = list(input.watermark, 127, 'watermark ASCII');
      groups[input.tracked ? 'trackedDecodeVectors' : 'untrackedDecodeVectors'].push({ name, frameHex,
        watermarkUtf8: input.watermarkPresent ? String.fromCharCode(...watermark) : null, expected });
    } else if (input.command === 'duration') {
      if (!['duration', 'duration_error'].includes(result.kind)) throw new Error('Invalid duration observation');
      groups.durationVectors.push({ name, ...numberInput(input.timestamp), expected: result.kind === 'duration' ? integer(result.duration) : null });
    } else throw new Error('Unknown primitive command');
  }
  if (seen.size !== expectedCases) throw new Error('Missing frame input cases');
  for (const rows of Object.values(groups)) rows.sort((a, b) => a.name.localeCompare(b.name));
  return groups;
}

export function readGeneratedFrameVectors() {
  const value = JSON.parse(readFileSync(resolve(root, artifact), 'utf8'));
  if (value.schemaVersion !== 3 || value.provenance?.model !== model ||
      JSON.stringify(value.provenance.sourceSha256) !== JSON.stringify(sourceHashes())) throw new Error('Stale Quint frame vector artifact');
  return value;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || !['--check', '--write'].includes(process.argv[2])) throw new Error('Use --check or --write');
  const directory = resolve(root, '.formal-traces/vector/frame');
  mkdirSync(directory, { recursive: true });
  const history = resolve(directory, 'allFrameVectorsTest.itf.json');
  const run = spawnSync('quint', ['test', model, '--backend=rust', '--max-samples=1', '--seed=0xd1a1ca',
    '--match=^allFrameVectorsTest$', `--out-itf=${directory}/{test}.itf.json`], { cwd: root, stdio: 'inherit' });
  if (run.error) throw run.error;
  if (run.status !== 0) process.exit(run.status ?? 1);
  const generated = { schemaVersion: 3, provenance: { model, sourceSha256: sourceHashes() },
    ...vectorsFromTrace(JSON.parse(readFileSync(history, 'utf8'))) };
  const encoded = JSON.stringify(generated, null, 2) + '\n';
  if (process.argv[2] === '--write') writeFileSync(resolve(root, artifact), encoded);
  else if (readFileSync(resolve(root, artifact), 'utf8') !== encoded) throw new Error('Quint frame vectors changed; review and regenerate');
  console.log(`Verified ${expectedCases} Quint frame/text/duration primitive cases`);
}
