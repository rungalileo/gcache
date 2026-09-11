import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const model = 'formal/dialcache-key-protocol.qnt';
export const generator = 'formal/generate-key-vectors.mjs';
export const artifact = 'formal/quint-key-vectors.json';
export const expectedCases = 457;
export const expectedGroups = { keyVectors: 328, invalidKeyVectors: 92, normalizeArgsVectors: 13, rampVectors: 24 };
export const invariants = [
  'keyAcceptanceRespectsTextAndHashTagDomain', 'rejectedKeysExposeNoPartialIdentity', 'successfulKeysHaveOneOperationDelimiter',
  'normalizedNamesAreOrderedAndValuesAssociated', 'normalizedIntegersRetainExactMagnitude',
  'cohortNumeratorsAreUnsignedAndBoundariesStrict',
];
export const regressions = [
  'allCasesTest', 'encodingSeparatesReservedDelimitersTest', 'surrogatePairEncodesOneFourByteScalarTest',
  'malformedUtf16RejectsInsteadOfReplacementTest', 'bracesDependOnEntityTrackingTest',
  'normalizedNamesUseUtf16OrderingTest', 'trackedArgumentsDoNotChangeWatermarkTest',
  'normalizedPrimitivesPreserveFalsyAndOmittedValuesTest', 'signedBigintsPreserveEveryDecimalDigitTest',
  'orderedKeyArgumentsRetainDuplicatesTest',
  'publishedCohortNumeratorsRemainStableTest',
];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceHashes = () => Object.fromEntries([
  model, generator, 'formal/wire-text.qnt', 'formal/cohort-boundaries.qnt',
].map(path => [path, sha256(readFileSync(resolve(root, path)))]));
const object = (value, label) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value;
};
const keys = value => Object.keys(value).sort().join(',');
function decimal(value) {
  const encoded = object(value, 'ITF integer');
  if (keys(encoded) !== '#bigint' || typeof encoded['#bigint'] !== 'string'
    || !/^(0|-?[1-9]\d*)$/.test(encoded['#bigint'])) throw new Error('Invalid ITF integer');
  return encoded['#bigint'];
}
function integer(value) {
  const n = Number(decimal(value));
  if (!Number.isSafeInteger(n)) throw new Error('Unsafe exported integer');
  return n;
}
function units(value) {
  if (!Array.isArray(value)) throw new Error('Missing model UTF-16 units');
  const output = value.map(integer);
  if (output.some(unit => unit < 0 || unit > 65535)) throw new Error('Invalid UTF-16 unit');
  return output;
}
const text = value => String.fromCharCode(...units(value));
function pairs(value) {
  if (!Array.isArray(value)) throw new Error('Missing ordered pairs');
  return value.map(raw => {
    const pair = object(raw, 'ordered pair');
    if (keys(pair) !== 'name,value') throw new Error('Invalid ordered pair');
    return [text(pair.name), text(pair.value)];
  });
}
function keyInput(value) {
  const raw = object(value, 'key input');
  if (keys(raw) !== 'args,id,keyType,namespace,tracked,useCase' || typeof raw.tracked !== 'boolean') throw new Error('Invalid key input');
  return {
    namespace: text(raw.namespace), keyType: text(raw.keyType), id: text(raw.id), useCase: text(raw.useCase),
    trackForInvalidation: raw.tracked, args: pairs(raw.args),
  };
}
function keyUnits(value) {
  return {
    namespace: units(value.namespace), keyType: units(value.keyType), id: units(value.id), useCase: units(value.useCase),
    args: value.args.map(pair => [units(pair.name), units(pair.value)]),
  };
}
function normalizedInput(arguments_) {
  if (!Array.isArray(arguments_)) throw new Error('Missing normalization inputs');
  const input = Object.create(null), bigintArgs = Object.create(null);
  let omitted = false;
  for (const raw of arguments_) {
    const arg = object(raw, 'normalization input');
    if (keys(arg) !== 'integer,kind,magnitude,name,negative,text' || typeof arg.negative !== 'boolean'
      || !Array.isArray(arg.magnitude) || arg.magnitude.length !== 2) throw new Error('Invalid normalization input');
    const name = text(arg.name), kind = integer(arg.kind);
    const [high, low] = arg.magnitude.map(integer);
    if (high < 0 || high > 9223372036 || low < 0 || low >= 1000000000) throw new Error('Invalid numeric magnitude limbs');
    const number = (BigInt(high) * 1000000000n + BigInt(low)) * (arg.negative ? -1n : 1n);
    if (Object.hasOwn(input, name) || Object.hasOwn(bigintArgs, name)) throw new Error('Duplicate record input name');
    if (kind === 0) { input[name] = '__QUINT_OMITTED__'; omitted = true; }
    else if (kind === 1) input[name] = text(arg.text);
    else if (kind === 2) input[name] = null;
    else if (kind === 3 || kind === 4) input[name] = kind === 4;
    else if (kind === 5) {
      if (number < -9007199254740991n || number > 9007199254740991n) throw new Error('Unsafe numeric input');
      input[name] = Number(number);
    } else if (kind === 6) bigintArgs[name] = number.toString();
    else throw new Error('Unknown normalization input kind');
  }
  return { input, ...(omitted ? { undefinedSentinel: '__QUINT_OMITTED__' } : {}),
    ...(Object.keys(bigintArgs).length ? { bigintArgs } : {}) };
}

// This exporter only changes representation. Escaping, ordering, scalar
// conversion, strict validation and integer hash results all come from Quint.
// The final sample division is the public number representation of that hash.
export function vectorsFromTrace(trace) {
  const states = object(trace, 'trace').states;
  if (!Array.isArray(states) || states.length !== expectedCases + 1) throw new Error('Incomplete Quint key history');
  if (object(states[0].input, 'initial input').name !== 'init') throw new Error('Missing key initialization');
  const groups = { keyVectors: [], invalidKeyVectors: [], normalizeArgsVectors: [], rampVectors: [] };
  for (const [index, state] of states.slice(1).entries()) {
    const input = object(state.input, 'explicit key input'), output = object(state.s, 'key observation');
    if (keys(input) !== 'arguments,caseId,discriminator,key,kind,label,name' || integer(input.caseId) !== index
      || typeof input.label !== 'string') throw new Error('Invalid or reordered explicit key input');
    if (keys(output) !== 'above,below,equal,hash,key,normalized'
      || [output.below, output.equal, output.above].some(value => typeof value !== 'boolean')) throw new Error('Incomplete key observation');
    const key = object(output.key, 'key output');
    if (keys(key) !== 'logical,valid,valueKey,watermark' || typeof key.valid !== 'boolean') throw new Error('Invalid key output');
    const kind = integer(input.kind), name = `Quint key ${String(index).padStart(3, '0')}: ${input.label}`;
    if (kind === 0 && input.name === 'key' && index < 420) {
      if (key.valid) groups.keyVectors.push({ name, input: keyInput(input.key),
        logicalKey: text(key.logical), valueKey: text(key.valueKey),
        watermarkKey: key.watermark.length ? text(key.watermark) : null });
      else groups.invalidKeyVectors.push({ name, input: keyInput(input.key), inputUtf16: keyUnits(input.key) });
    } else if (kind === 1 && input.name === 'normalize' && index >= 420 && index < 433) {
      groups.normalizeArgsVectors.push({ name, ...normalizedInput(input.arguments), expected: pairs(output.normalized) });
    } else if (kind === 2 && input.name === 'cohort' && index >= 433) {
      const hashNumerator = integer(output.hash), layer = text(input.discriminator);
      if (!key.valid || hashNumerator < 0 || hashNumerator >= 4294967296 || !['local', 'remote', 'shadow'].includes(layer)) throw new Error('Invalid cohort output');
      groups.rampVectors.push({ name, input: keyInput(input.key), layer,
        sample: (hashNumerator / 4294967296) * 100, hashNumerator });
    } else throw new Error('Unexpected key-vector action');
  }
  for (const [group, count] of Object.entries(expectedGroups)) {
    if (groups[group].length !== count) throw new Error(`Incomplete modeled ${group}: ${groups[group].length}/${count}`);
  }
  return groups;
}

export function validateGeneratedKeyVectors(raw) {
  const corpus = object(raw, 'key corpus'), provenance = object(corpus.provenance, 'key provenance');
  if (corpus.schemaVersion !== 3 || provenance.model !== model
    || JSON.stringify(provenance.sourceSha256) !== JSON.stringify(sourceHashes())) throw new Error('Stale Quint key vectors: run generator --write and review the model-derived artifact');
  const names = new Set();
  for (const [group, count] of Object.entries(expectedGroups)) {
    if (!Array.isArray(corpus[group]) || corpus[group].length !== count) throw new Error(`Incomplete committed ${group}`);
    for (const vector of corpus[group]) {
      if (typeof vector.name !== 'string' || !/^Quint key \d{3}: .+/.test(vector.name) || names.has(vector.name)) throw new Error('Invalid or duplicate generated key name');
      names.add(vector.name);
      object(vector.input, 'committed vector input');
    }
  }
  return corpus;
}
export function readGeneratedKeyVectors() {
  return validateGeneratedKeyVectors(JSON.parse(readFileSync(resolve(root, artifact), 'utf8')));
}

export function generateKeyVectors(mode) {
  if (!['--check', '--write'].includes(mode)) throw new Error('Usage: node formal/generate-key-vectors.mjs --check|--write');
  const output = resolve(root, '.formal-traces/vector/keys/trace.itf.json');
  mkdirSync(dirname(output), { recursive: true });
  const result = spawnSync('quint', ['run', model, '--backend=rust', '--step=exportStep', '--n-threads=1',
    '--seed=0xd1a1ca', '--max-samples=1', `--max-steps=${expectedCases}`, '--n-traces=1',
    `--out-itf=${output}`, '--verbosity=1', '--invariants', ...invariants], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Quint key export failed: ${result.status}`);
  const groups = vectorsFromTrace(JSON.parse(readFileSync(output, 'utf8')));
  const corpus = { schemaVersion: 3, provenance: { model, sourceSha256: sourceHashes() }, ...groups };
  const serialized = JSON.stringify(corpus, null, 2) + '\n';
  if (mode === '--write') writeFileSync(resolve(root, artifact), serialized);
  else if (readFileSync(resolve(root, artifact), 'utf8') !== serialized) throw new Error('Committed key predictions differ from fresh Quint output');
  console.log(`Quint key vectors: ${expectedCases} computed inputs ${mode === '--check' ? 'verified' : 'written'}`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Expected exactly --check or --write');
  generateKeyVectors(process.argv[2]);
}
