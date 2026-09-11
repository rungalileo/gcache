import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { readExecution, root, validateExecution } from './execution.mjs';
import { protocolCorpus } from './vector-artifacts.mjs';

export const readJSON = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
export const digest = value => createHash('sha256').update(value).digest('hex');
export const fingerprint = value => digest(JSON.stringify(value));
const fail = message => { throw new Error(message); };
const safePath = path => {
  if (typeof path !== 'string' || path.includes('\\') || path.startsWith('/') || path.split('/').some(p => !p || p === '.' || p === '..')) fail('Expected a repository-relative source path');
  if (!realpathSync(resolve(root, path)).startsWith(realpathSync(root) + sep)) fail('Source path leaves repository');
  return path;
};
const filesBelow = path => readdirSync(resolve(root, path), { withFileTypes: true }).flatMap(entry => entry.isDirectory()
  ? filesBelow(`${path}/${entry.name}`) : [`${path}/${entry.name}`]);

// IDs contain domain names and original case names, never native test names.
// Adding a language requires a driver/report adapter, not a change to this inventory.
export function conformanceInventory(execution = readExecution(), scenarios = readJSON('formal/behavioral-scenarios.json'), protocol = protocolCorpus(execution)) {
  const cases = [];
  for (const model of execution.models.filter(model => model.profile)) {
    const profile = model.profile;
    for (let i = 0; i < model.generate.traces; i++) cases.push({ id: `sampled/${profile}/${i}`, category: 'sampled', profile,
      path: `${model.generate.outputDirectory}/trace_${i}.itf.json` });
    for (const regression of model.replayRegressions ?? []) cases.push({ id: `regression/${profile}/${regression}`, category: 'regression', profile,
      path: `.formal-traces/regressions/${profile}/${regression}.itf.json` });
  }
  for (const scenario of scenarios.scenarios) cases.push({ id: `scenario/${encodeURIComponent(scenario.feature)}/${encodeURIComponent(scenario.name)}`,
    category: 'scenario', feature: scenario.feature, name: scenario.name });
  for (const [group, vectors] of Object.entries(protocol)) if (Array.isArray(vectors)) for (const vector of vectors) cases.push({
    id: `protocol/${group}/${encodeURIComponent(vector.name)}`, category: 'protocol', group, name: vector.name });
  for (const model of execution.models.filter(m => m.profile && m.profile !== 'core')) cases.push({ id: `witness/${model.profile}`, category: 'witness', profile: model.profile });
  if (!cases.length || new Set(cases.map(c => c.id)).size !== cases.length) fail('Empty or duplicate conformance inventory');
  return cases;
}

function specificationInputs() {
  return filesBelow('formal').filter(path => /\.(qnt|mjs|mts|json)$/.test(path)).sort();
}
export function defaultSources(language) {
  const shared = [...filesBelow('src'), ...filesBelow('test')].filter(path => /\.(ts|json)$/.test(path));
  if (language === 'typescript') return [...shared, 'package.json', 'pnpm-lock.yaml', 'vitest.config.ts', 'tsconfig.json'];
  // Go also reads shared fixtures, TypeScript metric schemas and witness
  // definitions. Bind those bytes and the evaluated witness files it consumes,
  // so edits after a native assertion cannot escape the completion check.
  if (language === 'go') return [...shared,
    ...filesBelow('go').filter(path => /\.(go|ts)$/.test(path) || /\/go\.(mod|sum)$/.test(path)),
    ...readExecution().models.filter(model => model.profile && model.profile !== 'core')
      .map(model => `.formal-traces/go-parity-witnesses/${model.profile}.json`)];
  fail('New languages must supply an explicit JSON list of implementation and harness source paths');
}
function hashes(paths) {
  return Object.fromEntries([...new Set(paths)].sort().map(path => [safePath(path), digest(readFileSync(resolve(root, path)))]));
}
function corpusInputs(inventory) {
  const paths = inventory.filter(c => c.path).map(c => c.path), directories = new Map();
  for (const path of paths) {
    const split = path.lastIndexOf('/'), directory = path.slice(0, split);
    if (!directories.has(directory)) directories.set(directory, []);
    directories.get(directory).push(path.slice(split + 1));
  }
  for (const [directory, expected] of directories) {
    const actual = readdirSync(resolve(root, directory)).filter(name => name.endsWith('.itf.json')).sort();
    if (!isDeepStrictEqual(actual, expected.sort())) fail(`Missing or extra histories in ${directory}`);
  }
  return hashes(paths);
}
export function prepareContext(language, sourcePaths) {
  if (typeof language !== 'string' || !/^[a-z][a-z0-9-]*$/.test(language)) fail('Invalid port name');
  validateExecution();
  const inventory = conformanceInventory();
  const sources = sourcePaths ?? defaultSources(language);
  if (!Array.isArray(sources) || !sources.length || new Set(sources).size !== sources.length) fail('Empty/duplicate implementation source inventory');
  const specification = hashes(specificationInputs());
  const implementation = hashes(sources);
  const corpus = corpusInputs(inventory);
  return { schemaVersion: 1, language, runId: randomUUID(), createdAt: Date.now(),
    specificationVersion: readJSON('formal/profiles.json').specificationVersion,
    specification, implementation, corpus, inventory };
}
export function validateContext(context, { current = true } = {}) {
  if (context?.schemaVersion !== 1 || !/^[a-z][a-z0-9-]*$/.test(context.language ?? '') ||
      !/^[\da-f-]{36}$/.test(context.runId ?? '') || !Number.isSafeInteger(context.createdAt) || context.createdAt <= 0) fail('Invalid conformance context');
  for (const group of ['specification', 'implementation', 'corpus']) {
    if (!context[group] || typeof context[group] !== 'object' || Array.isArray(context[group]) || !Object.keys(context[group]).length ||
      Object.entries(context[group]).some(([path, hash]) => !path || typeof hash !== 'string' || !/^[a-f\d]{64}$/.test(hash))) fail(`Invalid ${group} fingerprint inventory`);
  }
  if (!Array.isArray(context.inventory) || !context.inventory.length || new Set(context.inventory.map(c => c.id)).size !== context.inventory.length) fail('Invalid context case inventory');
  if (current) {
    validateExecution();
    if (context.specificationVersion !== readJSON('formal/profiles.json').specificationVersion || !isDeepStrictEqual(context.inventory, conformanceInventory())) fail('Specification or case inventory changed during run');
    if (!isDeepStrictEqual(context.specification, hashes(specificationInputs()))) fail('Specification inputs changed during run');
    if (!isDeepStrictEqual(context.implementation, hashes(Object.keys(context.implementation)))) fail('Implementation inputs changed during run');
    // Default bindings must include new files too; custom port inventories are
    // an explicit, reviewable declaration of the complete execution inputs.
    if (['typescript', 'go'].includes(context.language) && !isDeepStrictEqual(Object.keys(context.implementation).sort(), defaultSources(context.language).sort())) fail('Implementation source inventory changed during run');
    if (!isDeepStrictEqual(context.corpus, corpusInputs(context.inventory))) fail('Shared corpus changed during run');
  }
  return context;
}

export function checkCompletion(report, context, options) {
  validateContext(context, options);
  if (report?.schemaVersion !== 1 || report.language !== context.language || report.runId !== context.runId || report.contextSha256 !== fingerprint(context)) fail('Completion report does not match prepared context');
  if (report.status !== 'passed' || !Number.isFinite(report.startedAt) || !Number.isFinite(report.finishedAt) ||
      report.startedAt < context.createdAt || report.finishedAt < report.startedAt || report.finishedAt > Date.now() + 60_000) fail('Incomplete or stale conformance execution');
  if (typeof report.nativeReportSha256 !== 'string' || !/^[a-f\d]{64}$/.test(report.nativeReportSha256)) fail('Missing native assertion report fingerprint');
  if (!Array.isArray(report.results) || report.results.length !== context.inventory.length) fail('Missing or extra conformance results');
  const expected = new Set(context.inventory.map(c => c.id)), seen = new Set();
  for (const result of report.results) {
    if (!result || result.status !== 'passed' || !expected.has(result.id) || seen.has(result.id)) fail(`Failed, skipped, duplicate or unknown conformance case: ${result?.id}`);
    seen.add(result.id);
  }
  const counts = {};
  for (const c of context.inventory) counts[c.category] = (counts[c.category] ?? 0) + 1;
  return { language: report.language, status: 'passed', cases: seen.size, counts,
    specificationSha256: fingerprint(context.specification), corpusSha256: fingerprint(context.corpus),
    implementationSha256: fingerprint(context.implementation), nativeReportSha256: report.nativeReportSha256 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, a, b, c, ...extra] = process.argv.slice(2);
  if (extra.length) fail('Too many arguments');
  if (command === 'prepare' && a && b) {
    const context = prepareContext(a, c ? readJSON(c) : undefined);
    writeFileSync(resolve(root, b), JSON.stringify(context, null, 2) + '\n');
    console.log(`Prepared ${a}: ${context.inventory.length} required cases, ${Object.keys(context.corpus).length} histories`);
  } else if (command === 'check' && a && b && !c) console.log(JSON.stringify(checkCompletion(readJSON(a), readJSON(b)), null, 2));
  else if (command === 'inventory' && !a) console.log(JSON.stringify(conformanceInventory(), null, 2));
  else fail('Usage: node formal/conformance.mjs prepare <language> <context.json> [sources.json] | check <report.json> <context.json> | inventory');
}
