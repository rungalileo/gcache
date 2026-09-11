import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFileSync(root + path, 'utf8');
export const readExecution = () => JSON.parse(read('formal/execution.json'));

// A scoped declaration scanner, not a Quint parser or typechecker. Ignore
// comments and strings, and only inventory declarations directly in the one
// module body. Quint remains responsible for syntax, types, and effects.
export function scanDeclarations(source) {
  const tokens = [];
  for (let i = 0; i < source.length;) {
    if (/\s/.test(source[i])) { i++; continue; }
    if (source.startsWith('//', i)) {
      const end = source.indexOf('\n', i + 2);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) throw new Error('Unterminated Quint comment');
      i = end + 2;
      continue;
    }
    if (source[i] === '"') {
      let closed = false;
      for (i++; i < source.length; i++) {
        if (source[i] === '\\') { i++; continue; }
        if (source[i] === '"') { i++; closed = true; break; }
      }
      if (!closed) throw new Error('Unterminated Quint string');
      tokens.push('""');
      continue;
    }
    const identifier = /^[A-Za-z_][A-Za-z_0-9]*/.exec(source.slice(i));
    if (identifier) { tokens.push(identifier[0]); i += identifier[0].length; }
    else tokens.push(source[i++]);
  }

  const declarations = new Map(), stack = [];
  const kinds = new Set(['val', 'def', 'action', 'run', 'type', 'var', 'const', 'assume']);
  const closes = { '}': '{', ')': '(', ']': '[' };
  let modules = 0;
  if (tokens[0] !== 'module') throw new Error('Expected a Quint module declaration');
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!stack.length && i > 2) throw new Error('Unexpected content outside the Quint module');
    if (!stack.length && token === 'module') {
      if (!/^[A-Za-z_]\w*$/.test(tokens[i + 1] ?? '') || tokens[i + 2] !== '{') {
        throw new Error('Unsupported Quint module declaration');
      }
      modules++;
    }
    if (stack.length === 1 && stack[0] === '{' && kinds.has(token)) {
      const name = tokens[i + 1];
      if (!name || !/^[A-Za-z_]\w*$/.test(name)) throw new Error(`Unsupported Quint ${token} declaration`);
      if (declarations.has(name)) throw new Error(`Duplicate Quint declaration: ${name}`);
      declarations.set(name, token);
    }
    if (['{', '(', '['].includes(token)) stack.push(token);
    else if (Object.hasOwn(closes, token) && stack.pop() !== closes[token]) throw new Error('Unbalanced Quint delimiters');
  }
  if (stack.length || modules !== 1) throw new Error('Expected one balanced Quint module');
  return declarations;
}

const positiveInteger = (value, label) => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid positive bound: ${label}`);
};
const names = (values, label, allowEmpty = false) => {
  if (!Array.isArray(values) || (!allowEmpty && !values.length) ||
      values.some(name => typeof name !== 'string' || !/^[A-Za-z_]\w*$/.test(name)) ||
      new Set(values).size !== values.length) throw new Error(`Invalid ${label} inventory`);
};
const sameMembers = (left, right) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());

export function validateExecution(manifest = readExecution(), {
  readSource = read,
  files = readdirSync(root + 'formal').filter(name => name.endsWith('.qnt')).map(name => 'formal/' + name),
  profiles = JSON.parse(read('formal/profiles.json')).profiles,
} = {}) {
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.models) || !manifest.models.length ||
      !Array.isArray(manifest.libraries)) throw new Error('Unsupported model execution manifest');
  if (!Array.isArray(profiles) || !profiles.length || profiles.some(profile =>
    typeof profile.id !== 'string' || !/^[a-z][a-z-]*$/.test(profile.id)) ||
    new Set(profiles.map(profile => profile.id)).size !== profiles.length) throw new Error('Invalid execution profile IDs');
  const { settings, check, test } = manifest;
  if (!settings || settings.backend !== 'rust' || settings.threads !== 1 || settings.verbosity !== 1 ||
      typeof settings.seed !== 'string' || !/^(0x[\da-f]+|\d+)$/i.test(settings.seed)) throw new Error('Unsupported Quint execution settings');
  positiveInteger(check?.maxSamples, 'check.maxSamples');
  positiveInteger(check?.maxSteps, 'check.maxSteps');
  positiveInteger(test?.maxSamples, 'test.maxSamples');
  if (check.outputDirectory !== '.formal-traces/verification') throw new Error('Unsupported verification output directory');

  const paths = [...manifest.models.map(model => model.path), ...manifest.libraries];
  if (paths.some(path => typeof path !== 'string' || !/^formal\/[\w-]+\.qnt$/.test(path)) ||
      new Set(paths).size !== paths.length || !sameMembers(paths, files)) throw new Error('Model/library file inventory changed; review the execution schedule');
  const profileIds = [], outputDirectories = new Set([check.outputDirectory]);
  let invariants = 0, regressions = 0, generatedTraces = 0, challenges = 0;
  let exportedRegressionTraces = 0, generatedVectors = 0, vectorModels = 0;
  const vectorPaths = new Set();
  for (const model of manifest.models) {
    const declarations = scanDeclarations(readSource(model.path));
    if (declarations.get('init') !== 'action' || declarations.get('step') !== 'action') throw new Error(`${model.path}: scheduled model needs init and step actions`);
    names(model.invariants, `${model.path} invariants`);
    if (model.symbolic !== undefined) {
      if (manifest.symbolic?.backend !== 'apalache' || manifest.symbolic.version !== '0.56.1') throw new Error('Unsupported symbolic backend or version');
      if (manifest.symbolic.archive?.url !== 'https://github.com/apalache-mc/apalache/releases/download/v0.56.1/apalache-0.56.1.tgz'
        || !/^[a-f0-9]{64}$/.test(manifest.symbolic.archive.sha256)) throw new Error('Symbolic checking requires a versioned release archive and approved SHA-256');
      positiveInteger(model.symbolic.maxSteps, `${model.path} symbolic.maxSteps`);
      positiveInteger(model.symbolic.timeoutMs, `${model.path} symbolic.timeoutMs`);
    }
    for (const name of model.invariants) {
      if (declarations.get(name) !== 'val') throw new Error(`${model.path}: scheduled invariant is not a declared val: ${name}`);
    }
    names(model.regressions, `${model.path} regressions`, true);
    const declaredRuns = [...declarations].filter(([, kind]) => kind === 'run').map(([name]) => name);
    if (model.regressions.some(name => !name.endsWith('Test')) || !sameMembers(model.regressions, declaredRuns)) {
      throw new Error(`${model.path}: regression schedule must exactly name every run and retain the Test suffix`);
    }
    invariants += model.invariants.length;
    regressions += model.regressions.length;
    if (model.propertyChallenge !== undefined) {
      if (model.path !== 'formal/dialcache-flight-deadlines.qnt' || model.propertyChallenge !== 'formal/check-model-properties.mjs') throw new Error('Unsupported model property challenge');
      challenges++;
    }
    if (model.profile !== undefined || model.generate !== undefined) {
      const profile = profiles.find(profile => profile.id === model.profile);
      if (!profile || profile.model !== model.path || !model.generate) throw new Error(`${model.path}: generation profile differs from claim registry`);
      profileIds.push(model.profile);
      const generation = model.generate;
      for (const key of ['maxSamples', 'maxSteps', 'traces']) positiveInteger(generation[key], `${model.profile}.${key}`);
      if (generation.traces > generation.maxSamples) throw new Error(`${model.profile}: trace count exceeds sample bound`);
      // These are owned output directories: never permit traversal, a parent
      // directory, or reuse between profiles before recursive cleanup.
      const expectedDirectory = model.profile === 'core' ? '.formal-traces/conformance'
        : model.profile === 'effects' ? '.formal-traces/effects' : `.formal-traces/features/${model.profile}`;
      if (generation.outputDirectory !== expectedDirectory || outputDirectories.has(generation.outputDirectory)) throw new Error(`${model.profile}: unsafe or duplicate generation output directory`);
      outputDirectories.add(generation.outputDirectory);
      generatedTraces += generation.traces;
    }
    if (model.replayRegressions !== undefined) {
      names(model.replayRegressions, `${model.path} replay regressions`);
      exportedRegressionTraces += model.replayRegressions.length;
      if (!model.profile || declarations.get('input') !== 'var' ||
          model.replayRegressions.some(name => !model.regressions.includes(name))) throw new Error(`${model.path}: replay regressions need declared input and scheduled tests`);
    }
    if (model.vectorExport !== undefined) {
      const vector = model.vectorExport;
      if (model.profile !== undefined || !['protocol', 'invalidation'].includes(vector.kind)
        || !/^formal\/generate-[\w-]+-vectors\.mjs$/.test(vector.generator)
        || !/^formal\/quint-[\w-]+-vectors\.json$/.test(vector.artifact)
        || !Array.isArray(vector.sources) || new Set(vector.sources).size !== vector.sources.length
        || !vector.sources.includes(model.path) || !vector.sources.includes(vector.generator)
        || vector.sources.some(path => path !== model.path && path !== vector.generator && !manifest.libraries.includes(path))) {
        throw new Error(`${model.path}: invalid vector export boundary`);
      }
      positiveInteger(vector.cases, `${model.path} vector cases`);
      if (vectorPaths.has(vector.generator) || vectorPaths.has(vector.artifact)) throw new Error('Duplicate vector generator or artifact');
      vectorPaths.add(vector.generator); vectorPaths.add(vector.artifact);
      generatedVectors += vector.cases;
      vectorModels++;
      for (const path of vector.sources) read(path);
    }
  }
  for (const path of manifest.libraries) {
    const declarations = scanDeclarations(readSource(path));
    if ([...declarations.values()].some(kind => ['action', 'run', 'var'].includes(kind))) throw new Error(`${path}: a stateful model cannot be classified as a pure helper library`);
  }
  if (!sameMembers(profileIds, profiles.map(profile => profile.id))) throw new Error('Generated profile inventory differs from claim registry');
  if (challenges !== 1) throw new Error('Source deadline model property challenge is missing');
  return { models: manifest.models.length, libraries: manifest.libraries.length, profiles: profileIds.length, invariants, regressions, generatedTraces, exportedRegressionTraces, vectorModels, generatedVectors };
}

// Call after validateExecution: coverage links must name checks that run, not
// merely declarations that happen to exist in a model or a comment.
export function scheduledProperties(manifest) {
  return new Set(manifest.models.flatMap(model => [...model.invariants, ...model.regressions].map(name => `${model.path}:${name}`)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(validateExecution(process.argv.includes('--stdin')
    ? JSON.parse(readFileSync(0, 'utf8')) : undefined), null, 2));
}
