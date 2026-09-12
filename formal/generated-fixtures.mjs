import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { readExecution, root, validateExecution } from './execution.mjs';
import { resolveConcurrency, runPool, spawnBuffered } from './quint-pool.mjs';

const recipePath = 'formal/fixture-recipes.json';
const lockPath = 'formal/generated-fixtures.lock.json';
const generator = 'formal/generated-fixtures.mjs';
const read = path => readFileSync(resolve(root, path), 'utf8');
const json = path => JSON.parse(read(path));
const encode = value => JSON.stringify(value, null, 2) + '\n';
const hash = value => createHash('sha256').update(value).digest('hex');
const integer = value => ({ '#bigint': String(value) });
const identifier = value => typeof value === 'string' && /^[A-Za-z_]\w*$/.test(value);
const fail = message => { throw new Error(message); };

export function validateRecipes(book, execution = readExecution()) {
  const models = new Set(execution.models.filter(model => model.profile).map(model => model.path));
  if (book.schemaVersion !== 1 || !Array.isArray(book.artifacts) || !book.artifacts.length) fail('Invalid fixture recipe inventory');
  const paths = new Set();
  for (const artifact of book.artifacts) {
    if (typeof artifact.path !== 'string' || !/^(formal\/[\w-]+-smoke\.itf|test\/fixtures\/[\w-]+)\.json$/.test(artifact.path) || paths.has(artifact.path)) fail('Invalid/duplicate fixture path');
    paths.add(artifact.path);
    if (Object.keys(artifact).some(key => !['path', 'model', 'format', 'recipes', 'actionBindings'].includes(key))) fail('Unexpected artifact recipe field');
    for (const [name, target] of Object.entries(artifact.actionBindings ?? {})) if (!identifier(name) || !identifier(target)) fail('Invalid public action binding');
    if (!['smoke', 'named-map', 'named-list', 'excerpts'].includes(artifact.format) || !Array.isArray(artifact.recipes) || !artifact.recipes.length) fail('Invalid fixture format');
    if (artifact.format === 'smoke' && artifact.recipes.length !== 1) fail('Smoke must select exactly one history');
    const ids = new Set();
    for (const recipe of artifact.recipes) {
      if (typeof recipe.id !== 'string' || !/^[\w-]+$/.test(recipe.id) || ids.has(recipe.id)) fail('Invalid/duplicate fixture ID');
      ids.add(recipe.id);
      if (!models.has(recipe.model ?? artifact.model)) fail('Fixture model is not a scheduled conformance model');
      if (Boolean(recipe.regression) === Boolean(recipe.actions)) fail('Recipe needs exactly one public run or action sequence');
      if (recipe.regression && !identifier(recipe.regression)) fail('Invalid regression');
      if (recipe.actions) {
        if (!Array.isArray(recipe.actions) || recipe.actions.length < 2) fail('Empty fixture action history');
        recipe.actions.forEach((step, i) => {
          if (!Array.isArray(step) || step.length !== 2 || !identifier(step[0]) || !Number.isSafeInteger(step[1]) || step[1] < -1 || (i === 0 ? step[0] !== 'init' : step[0] === 'init')) fail('Invalid external action/choice');
        });
      }
      if (recipe.startState !== undefined && (!Number.isSafeInteger(recipe.startState) || recipe.startState < 0 || recipe.startState >= recipe.actions.length - 1)) fail('Invalid excerpt bounds');
      const checkMask = mask => {
        if (mask === true) return;
        if (!mask || typeof mask !== 'object' || Array.isArray(mask) || !Object.keys(mask).length) fail('Projection must contain field names only');
        for (const [key, value] of Object.entries(mask)) {
          if (!identifier(key)) fail('Invalid projection field');
          checkMask(value);
        }
      };
      checkMask(book.projections?.[recipe.projection]);
      const allowed = ['id', 'model', 'profile', 'witness', 'title', 'actions', 'regression', 'startState', 'projection', 'integers', 'choices'];
      if (Object.keys(recipe).some(key => !allowed.includes(key))) fail('Unexpected recipe field; expected state is forbidden');
    }
  }
  const expected = [...JSON.parse(read('formal/profiles.json')).profiles.map(p => p.smoke),
    ...readdirSync(resolve(root, 'test/fixtures')).filter(name => /witness.*\.json$/.test(name)).map(name => `test/fixtures/${name}`)].sort();
  if (!isDeepStrictEqual([...paths].sort(), expected)) fail('Fixture recipe inventory omits or adds a committed fixture');
  return book;
}

// Source locations come from Quint's parser. Restrict only the original oneOf
// input domain; every original guard, assignment and called helper stays intact.
// This is a schedule selector, never an implementation of expected behavior.
export function constrainAction(source, declaration, sourceMap, choice) {
  if (declaration?.kind !== 'def' || declaration.qualifier !== 'action' || declaration.expr?.kind === 'lambda') fail('Recipe must select a parameterless public action');
  const span = node => {
    const location = sourceMap.map[String(node.id)];
    if (!location || !Number.isSafeInteger(location[1]?.index) || !Number.isSafeInteger(location[2]?.index)) fail('Missing Quint source span');
    return [location[1].index, location[2].index + 1];
  };
  const picks = [];
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.qualifier === 'nondet') picks.push(node);
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value);
  };
  visit(declaration.expr);
  const [start, end] = span(declaration.expr);
  let body = source.slice(start, end);
  if (choice === -1) {
    if (picks.length) fail('Missing external nondeterministic choice');
  } else {
    if (picks.length !== 1 || picks[0].name !== 'choice' || picks[0].expr?.opcode !== 'oneOf' || picks[0].expr.args?.length !== 1) fail('Unsupported/ambiguous nondeterministic input');
    const [a, b] = span(picks[0].expr.args[0]);
    if (a < start || b > end || a >= b) fail('Quint choice span outside action');
    body = body.slice(0, a - start) + `(${source.slice(a, b)}).intersect(Set(${choice}))` + body.slice(b - start);
  }
  return `{ ${body} }`;
}

export function project(value, mask) {
  if (mask === true) return structuredClone(value);
  const result = {};
  for (const [key, child] of Object.entries(mask)) {
    if (!value || !Object.hasOwn(value, key)) fail(`Quint output is missing projected field ${key}`);
    result[key] = project(value[key], child);
  }
  return result;
}
export function stateDelta(before, after) {
  const patch = {};
  for (const key of Object.keys(before)) if (!Object.hasOwn(after, key)) fail('Delta format cannot remove a state field');
  for (const [key, value] of Object.entries(after)) if (!isDeepStrictEqual(before[key], value)) {
    patch[key] = value && before[key] && typeof value === 'object' && typeof before[key] === 'object' && !Array.isArray(value) && !Array.isArray(before[key])
      ? stateDelta(before[key], value) : value;
  }
  return patch;
}
const nativeIntegers = value => {
  if (Array.isArray(value)) return value.map(nativeIntegers);
  if (!value || typeof value !== 'object') return value;
  if (Object.keys(value).join() === '#bigint') {
    const n = Number(value['#bigint']);
    if (!Number.isSafeInteger(n) || String(n) !== value['#bigint']) fail('Lossy native fixture integer');
    return n;
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, nativeIntegers(child)]));
};
const metadata = (action, choice) => ({ 'mbt::actionTaken': action, 'mbt::nondetPicks': {
  choice: choice === -1 ? { tag: 'None', value: { '#tup': [] } } : { tag: 'Some', value: integer(choice) },
} });

async function execute(args) {
  const run = await spawnBuffered('quint', args, { cwd: root });
  if (run.error) throw run.error;
  if (run.status !== 0) fail(`Quint ${args[0]} failed:\n${run.stdout}\n${run.stderr}`);
}
async function exportModel(model, requests, directory, settings) {
  const source = read(model), name = /^module\s+(\w+)\s*\{/.exec(source)?.[1];
  if (!name) fail('Unsupported Quint module');
  const parsedPath = resolve(directory, 'parsed.json'), mapPath = resolve(directory, 'source-map.json');
  await execute(['parse', model, `--out=${parsedPath}`, `--source-map=${mapPath}`]);
  const parsed = JSON.parse(readFileSync(parsedPath, 'utf8')), sourceMap = JSON.parse(readFileSync(mapPath, 'utf8'));
  if (parsed.errors.length) fail('Quint parse errors');
  const declarations = new Map(parsed.modules.find(module => module.name === name).declarations.map(d => [d.name, d]));
  const publicActions = new Set(['init']);
  const referencedActions = node => {
    if (!node || typeof node !== 'object') return;
    if (node.kind === 'name' && declarations.get(node.name)?.qualifier === 'action') publicActions.add(node.name);
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(referencedActions); else if (value && typeof value === 'object') referencedActions(value);
  };
  referencedActions(declarations.get('step')?.expr);
  // Copy source/imports to an ignored directory; all computed state stays in Quint.
  for (const file of readdirSync(resolve(root, 'formal')).filter(file => file.endsWith('.qnt'))) copyFileSync(resolve(root, 'formal', file), resolve(directory, file));
  const input = resolve(directory, basename(model));
  const named = requests.filter(r => r.recipe.regression);
  for (const request of named) {
    const regression = request.recipe.regression;
    if (declarations.get(regression)?.qualifier !== 'run') fail(`Missing named Quint run ${regression}`);
    const scheduled = readExecution().models.find(m => m.path === model)?.replayRegressions ?? [];
    if (!scheduled.includes(regression)) fail(`Fixture run is not a scheduled public-action replay: ${regression}`);
    request.run = regression;
  }
  if (named.length) await execute(['test', input, `--backend=${settings.backend}`, '--max-samples=1', `--seed=${settings.seed}`,
    `--match=^(${[...new Set(named.map(r => r.run))].join('|')})$`, `--out-itf=${directory}/{test}.itf.json`]);
  for (const [i, request] of requests.entries()) {
    if (request.recipe.regression) continue;
    const additions = [], clones = new Map();
    const calls = request.recipe.actions.map(([action, choice]) => {
      const selectedAction = request.artifact.actionBindings?.[action] ?? action;
      if (!publicActions.has(selectedAction)) fail(`Action is not exposed by the model's step: ${selectedAction}`);
      const key = `${action}/${choice}`;
      if (!clones.has(key)) {
        const alias = `fixtureAction${clones.size}`;
        additions.push(`action ${alias} = ${constrainAction(source, declarations.get(request.artifact.actionBindings?.[action] ?? action), sourceMap, choice)}`);
        clones.set(key, alias);
      }
      return clones.get(key);
    });
    // A scheduler counter avoids deeply nested .then trees for long saved
    // histories. It controls only which public action runs, never cache state.
    additions.push('var fixtureCursor: int');
    additions.push(`action fixtureInit = all { ${calls[0]}, fixtureCursor\' = 0 }`);
    additions.push(`action fixtureStep = any { ${calls.slice(1).map((call, j) =>
      `all { fixtureCursor == ${j}, ${call}, fixtureCursor\' = ${j + 1} }`).join(',')} }`);
    request.run = `fixtureHistory${i}`;
    const end = source.lastIndexOf('}');
    writeFileSync(input, source.slice(0, end) + '\n' + additions.join('\n') + '\n' + source.slice(end));
    await execute(['run', input, `--backend=${settings.backend}`, '--n-threads=1', '--max-samples=1',
      `--seed=${settings.seed}`, '--init=fixtureInit', '--step=fixtureStep', `--max-steps=${calls.length - 1}`,
      '--n-traces=1', `--out-itf=${directory}/${request.run}.itf.json`]);
  }
  for (const request of requests) {
    const trace = JSON.parse(readFileSync(resolve(directory, `${request.run}.itf.json`), 'utf8'));
    if (!Array.isArray(trace.states) || trace.states.length < 2 || request.recipe.actions && trace.states.length !== request.recipe.actions.length) fail('Quint emitted incomplete fixture history');
    request.states = trace.states.map((state, index) => {
      const selected = request.recipe.actions?.[index];
      const input = state.input ?? (selected ? { name: selected[0], choice: integer(selected[1]) } : undefined);
      if (!input || selected && (input.name !== selected[0] || input.choice['#bigint'] !== String(selected[1]))) fail('Quint recorded a different external input');
      const envelope = model === 'formal/dialcache-conformance.qnt'
        ? { 'mbt::actionTaken': input.name, 'mbt::nondetPicks': {} }
        : metadata(input.name, Number(input.choice['#bigint']));
      return { input, ...envelope, s: project(state.s, request.projection) };
    });
  }
}

function inputs(book) {
  const execution = readExecution();
  return Object.fromEntries([...new Set([recipePath, generator, 'formal/execution.mjs', 'formal/execution.json', 'formal/profiles.json',
    ...execution.libraries, ...book.artifacts.flatMap(a => a.recipes.map(r => r.model ?? a.model))])].sort().map(path => [path, hash(read(path))]));
}
export function verifyFixtures(book = validateRecipes(json(recipePath))) {
  const lock = json(lockPath);
  if (lock.schemaVersion !== 1 || lock.quintVersion !== '0.32.0' || !isDeepStrictEqual(lock.inputs, inputs(book))) fail('Generated fixture inputs changed; regenerate and review');
  const expected = Object.fromEntries(book.artifacts.map(a => [a.path, hash(read(a.path))]));
  if (!isDeepStrictEqual(lock.artifacts, expected)) fail('Generated fixture content changed; regenerate and review');
  return { artifacts: book.artifacts.length, histories: book.artifacts.reduce((n, a) => n + a.recipes.length, 0) };
}
export async function generateFixtures(mode, { concurrency = resolveConcurrency() } = {}) {
  const execution = readExecution(); validateExecution(execution);
  const book = validateRecipes(json(recipePath), execution);
  if (mode === '--verify') return verifyFixtures(book);
  if (!['--check', '--write'].includes(mode)) fail('Use --write, --check or --verify');
  const version = spawnSync('quint', ['--version'], { encoding: 'utf8' });
  if (version.status !== 0 || version.stdout.trim() !== '0.32.0') fail('Fixture export requires Quint 0.32.0');
  const groups = new Map();
  for (const artifact of book.artifacts) for (const recipe of artifact.recipes) {
    const model = recipe.model ?? artifact.model;
    if (!groups.has(model)) groups.set(model, []);
    groups.get(model).push({ artifact, recipe, projection: book.projections[recipe.projection] });
  }
  // Each model exports into its own build directory, so models run side by
  // side; the artifacts below are assembled in recipe order from the results.
  await runPool([...groups].map(([model, requests]) => async () => {
    const directory = resolve(root, '.formal-traces/fixture-build', basename(model, '.qnt'));
    rmSync(directory, { recursive: true, force: true }); mkdirSync(directory, { recursive: true });
    await exportModel(model, requests, directory, execution.settings);
    console.log(`Quint fixtures: ${basename(model)} (${requests.length} histories)`);
  }), { concurrency });
  const requests = [...groups.values()].flat(), outputs = new Map();
  for (const artifact of book.artifacts) {
    const entries = artifact.recipes.map(recipe => {
      const request = requests.find(r => r.artifact === artifact && r.recipe === recipe);
      const source = { model: recipe.model ?? artifact.model, recipe: `${recipePath}#${artifact.path}/${recipe.id}` };
      const states = request.states;
      if (artifact.format === 'smoke') return { '#meta': { format: 'ITF', source: source.model, recipe: source.recipe }, vars: ['input', 's', 'mbt::actionTaken', 'mbt::nondetPicks'], states };
      if (artifact.format === 'named-list') return { regression: recipe.regression, trace: { source, states } };
      if (artifact.format === 'named-map') return { source, states };
      const excerpt = states.slice(recipe.startState ?? 0), projected = excerpt.map(s => recipe.integers === 'native' ? nativeIntegers(s.s) : s.s);
      return { ...(recipe.title ? { title: recipe.title } : {}), witness: recipe.witness, profile: recipe.profile,
        provenance: source, initialState: projected[0], steps: excerpt.slice(1).map((s, i) => ({ action: s.input.name,
          ...(recipe.choices ? { choice: s['mbt::nondetPicks'].choice } : {}), statePatch: stateDelta(projected[i], projected[i + 1]) })) };
    });
    const output = artifact.format === 'smoke' ? entries[0] : artifact.format === 'named-map'
      ? Object.fromEntries(artifact.recipes.map((r, i) => [r.id, entries[i]])) : entries;
    outputs.set(artifact.path, encode(output));
  }
  const lock = { schemaVersion: 1, quintVersion: '0.32.0', inputs: inputs(book), artifacts: Object.fromEntries([...outputs].map(([path, text]) => [path, hash(text)])) };
  outputs.set(lockPath, encode(lock));
  for (const [path, output] of outputs) {
    if (mode === '--write') writeFileSync(resolve(root, path), output);
    else if (read(path) !== output) fail(`${path}: fresh Quint output differs; run --write and review`);
  }
  return verifyFixtures(book);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) fail('Usage: node formal/generated-fixtures.mjs --write|--check|--verify');
  console.log(await generateFixtures(process.argv[2]));
}
