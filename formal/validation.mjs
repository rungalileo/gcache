import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const replayTests = ['test/formal-conformance.test.ts', 'test/formal-effects.test.ts', 'test/formal-features.test.ts',
  'test/formal-local-clock.test.ts', 'test/formal-behavior.test.ts', 'test/formal-protocol-vectors.test.ts'];
const aggregateTargets = {
  check: ['check-ts', 'check-go', 'docs', 'audit'],
  formal: ['formal-corpus', 'formal-go'],
  mutations: ['mutations-ts', 'mutations-go'],
  integration: ['integration-ts', 'integration-go'],
  ci: ['check', 'package-floor', 'formal', 'integration', 'mutations'],
};
export const targetDescriptions = {
  check: 'TypeScript and Go checks, docs build and reviewed inventories; no Quint generation or Docker',
  'check-ts': 'Typecheck, unit coverage, build and packed-package checks on Node 24',
  'check-go': 'Go vet, formatting check and default tests with race detection',
  docs: 'Build the documentation site',
  audit: 'Check source, behavior, feature, Go and generated-fixture freshness inventories',
  smoke: 'Replay committed Quint-derived fixtures in TypeScript and Go; no full completion claim',
  formal: 'Complete Quint checks and corpus, then prepared TypeScript and Go replay',
  'formal-corpus': 'Check models, generate/recompute artifacts and complete TypeScript replay with witnesses',
  'formal-go': 'Require current TypeScript completion, then complete Go replay with race detection',
  'fixtures-check': 'Recompute every committed model-derived artifact with pinned Quint',
  mutations: 'Require both current completions, then measure TypeScript and Go semantic mutations',
  'mutations-ts': 'Require current TypeScript completion, then measure its semantic mutations',
  'mutations-go': 'Require both current completions, then measure Go semantic mutations',
  integration: 'Run real TypeScript and Go Redis/Valkey/Cluster integration checks',
  'integration-ts': 'Run TypeScript real integration checks',
  'integration-go': 'Run Go real integration and interoperability checks with race detection',
  'package-floor': 'Check zstd and the packed package on exact Node 22.15.0 (NODE22_BIN)',
  ci: 'Run check, package-floor, formal, integration and mutations in dependency order',
};

export function expandTargets(target) {
  if (!Object.hasOwn(targetDescriptions, target)) throw new Error(`Unknown validation target ${target}; run make help`);
  return aggregateTargets[target]?.flatMap(expandTargets) ?? [target];
}

// Local shells may retain a one-file replay, protocol subset or alternate
// witness directory from debugging. None may silently narrow an acceptance run.
export function cleanEnvironment(environment = process.env, overrides = {}) {
  const result = { ...environment };
  for (const key of Object.keys(result)) if (key.startsWith('DIALCACHE_') || key === 'QUINT_SEED') delete result[key];
  return { ...result, ...overrides };
}

function floorExecutable(environment, runnerNode = process.execPath, nodeVersion = process.version) {
  return environment.NODE22_BIN ?? (nodeVersion === 'v22.15.0' ? runnerNode : undefined);
}

export function floorEnvironment(environment, executable) {
  return { ...environment, PATH: `${dirname(executable)}${delimiter}${environment.PATH ?? ''}` };
}

const floorSmoke = `const z = require('node:zlib');
const bytes = z.zstdCompressSync(Buffer.from('dialcache floor smoke'), { params: { [z.constants.ZSTD_c_compressionLevel]: 3 } });
if (z.zstdDecompressSync(bytes, { maxOutputLength: 1024 }).toString('utf8') !== 'dialcache floor smoke') throw new Error('zstd floor round trip failed');
let code;
try { z.zstdDecompressSync(bytes, { maxOutputLength: 4 }); } catch (error) { code = error.code; }
if (code !== 'ERR_BUFFER_TOO_LARGE') throw new Error('zstd output cap not enforced at floor: ' + code);`;

export function validationPlan(target, { directory = root, environment = process.env, runnerNode = process.execPath, nodeVersion = process.version } = {}) {
  const node = (label, ...args) => ({ label, command: runnerNode, args });
  const pnpm = (label, ...args) => ({ label, command: 'corepack', args: ['pnpm', ...args] });
  const go = (label, ...args) => ({ label, command: 'go', args: ['-C', 'go', ...args] });
  const reportPath = (language, suffix) => `.formal-traces/${language}-${suffix}.json`;
  const completion = language => ({ ...node(`Validate current ${language} completion`, 'formal/conformance.mjs', 'check', reportPath(language, 'completion'), reportPath(language, 'context')),
    failureHint: 'A current complete replay is required. Run make formal first; missing or stale reports cannot be reused.' });
  const invalidate = (...languages) => ({ label: `Invalidate prior ${languages.join('/')} completion`, remove: languages.map(language => reportPath(language, 'completion')) });
  const replayEnv = {
    DIALCACHE_MBT_TRACE_DIR: resolve(directory, '.formal-traces/conformance'),
    DIALCACHE_EFFECTS_TRACE_DIR: resolve(directory, '.formal-traces/effects'),
    DIALCACHE_FEATURE_TRACE_DIR: resolve(directory, '.formal-traces/features'),
  };
  const witnessDirectory = resolve(directory, '.formal-traces/go-parity-witnesses');
  const tsReplay = full => ({ ...pnpm(full ? 'Replay complete TypeScript corpus' : 'Replay committed TypeScript fixtures',
    'exec', 'vitest', 'run', ...replayTests, '--coverage.enabled=false',
    ...(full ? ['--reporter=default', '--reporter=json', '--outputFile=.formal-traces/ts-replay.json'] : [])),
    ...(full ? { env: { ...replayEnv, DIALCACHE_COVERAGE_EVIDENCE_DIR: witnessDirectory } } : {}) });
  const nativeGo = full => ({ ...go(full ? 'Replay complete Go corpus with race detection' : 'Run Go default tests with race detection',
    'test', '-race', '-count=1', ...(full ? ['-json'] : []), './...'),
    ...(full ? { env: { ...replayEnv, DIALCACHE_WITNESS_EVIDENCE_DIR: witnessDirectory }, stdoutFile: '.formal-traces/go-replay.jsonl' } : {}) });
  const node22 = floorExecutable(environment, runnerNode, nodeVersion) ?? '<NODE22_BIN>';
  const plans = {
    'check-ts': [pnpm('Typecheck TypeScript', 'typecheck'), pnpm('Run TypeScript unit tests with coverage', 'test'),
      pnpm('Build package', 'build'), pnpm('Check packed package on Node 24', 'test:package')],
    'check-go': [go('Go vet', 'vet', './...'), { label: 'Check Go formatting', command: 'gofmt', args: ['-l', 'go'], requireEmptyStdout: true }, nativeGo(false)],
    docs: [pnpm('Build documentation', 'docs:build')],
    audit: ['execution', 'check-source-audit', 'check-semantic-coverage', 'check-feature-coverage', 'check-go-parity']
      .map(name => node(`Check ${name}`, `formal/${name}.mjs`))
      .concat(node('Verify committed fixture fingerprints', 'formal/generated-fixtures.mjs', '--verify'),
        node('Check conditional fixture regeneration scope', '--test', '.github/scripts/fixture-scope.test.mjs')),
    smoke: [tsReplay(false), nativeGo(false)],
    'fixtures-check': [node('Recompute all committed Quint artifacts', 'formal/generate-artifacts.mjs', '--check')],
    'formal-corpus': [invalidate('ts', 'go'), node('Check every scheduled Quint model', 'formal/run-models.mjs', 'check'),
      node('Generate complete corpus and recompute wire artifacts', 'formal/run-models.mjs', 'generate'),
      node('Recompute committed Quint smoke and witness fixtures', 'formal/generated-fixtures.mjs', '--check'),
      node('Prepare TypeScript execution context', 'formal/conformance.mjs', 'prepare', 'typescript', reportPath('ts', 'context')),
      tsReplay(true), { ...node('Adapt TypeScript native assertion report', 'formal/conformance-adapters.mjs', 'typescript', reportPath('ts', 'replay'), reportPath('ts', 'context')), stdoutFile: reportPath('ts', 'completion') },
      completion('ts')],
    'formal-go': [completion('ts'), invalidate('go'), node('Check Go parity inventory', 'formal/check-go-parity.mjs'),
      node('Prepare Go execution context', 'formal/conformance.mjs', 'prepare', 'go', reportPath('go', 'context')), nativeGo(true),
      { ...node('Check complete Go native report', 'formal/check-go-replay.mjs'), stdoutFile: '.formal-traces/go-replay-summary.json' },
      { ...node('Adapt Go native assertion report', 'formal/conformance-adapters.mjs', 'go', '.formal-traces/go-replay.jsonl', reportPath('go', 'context')), stdoutFile: reportPath('go', 'completion') }, completion('go')],
    'mutations-ts': [completion('ts'), node('Measure TypeScript semantic mutations', 'formal/measure-semantics.mjs')],
    'mutations-go': [completion('ts'), completion('go'), node('Measure Go semantic mutations', 'formal/measure-go-semantics.mjs')],
    'integration-ts': [pnpm('Run TypeScript Redis/Valkey/Cluster integrations', 'test:integration')],
    'integration-go': [{ ...go('Run Go Redis/Valkey/Cluster and TypeScript interoperability', 'test', '-race', '-tags', 'integration', '-count=1', '-run', '^TestRedisIntegration$', '-json', './...'), stdoutFile: '.formal-traces/go-integration.jsonl' }],
    'package-floor': [{ label: 'Require a built package for floor checks', requireFile: 'dist/index.js', failureHint: 'Build first with make check-ts, or run make ci with NODE22_BIN set.' },
      { label: 'Check Node 22.15 zstd round trip and output ceiling', command: node22, args: ['--eval', floorSmoke], env: { PATH: floorEnvironment(environment, node22).PATH } },
      { label: 'Check packed package on Node 22.15', command: node22, args: ['scripts/test-package.mjs'], env: { PATH: floorEnvironment(environment, node22).PATH } }],
  };
  return [...(target === 'mutations' ? [completion('ts'), completion('go')] : []), ...expandTargets(target).flatMap(name => plans[name])];
}

function probe(command, args, { directory, environment }) {
  const result = spawnSync(command, args, { cwd: directory, env: environment, encoding: 'utf8', timeout: 15_000 });
  if (result.error || result.status !== 0) throw new Error(`Cannot run ${command} ${args.join(' ')}: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`);
  return result.stdout.trim();
}

export function checkPrerequisites(target, { directory = root, environment = process.env, runnerNode = process.execPath, nodeVersion = process.version } = {}) {
  const targets = expandTargets(target);
  if (targets.some(name => name !== 'package-floor') && !/^v24\./.test(nodeVersion)) throw new Error(`Validation requires Node 24; current runtime is ${nodeVersion}. Put Node 24 on PATH and rerun make ${target}.`);
  if (!existsSync(resolve(directory, 'node_modules/typescript/package.json'))) throw new Error('Project dependencies are missing. Run corepack pnpm install --frozen-lockfile first.');
  const requiredPnpm = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')).packageManager?.replace(/^pnpm@/, '');
  const pnpm = probe('corepack', ['pnpm', '--version'], { directory, environment });
  if (!requiredPnpm || pnpm !== requiredPnpm) throw new Error(`Expected pinned pnpm ${requiredPnpm}; found ${pnpm}. Use corepack pnpm and install the frozen lockfile.`);
  if (targets.some(name => ['check-go', 'smoke', 'formal-go', 'mutations-go', 'integration-go'].includes(name))) {
    const version = probe('go', ['version'], { directory, environment });
    if (!/^go version go1\.27\.1\s/.test(version)) throw new Error(`Validation requires Go 1.27.1; found ${version}. Put the pinned Go toolchain on PATH.`);
  }
  if (targets.some(name => ['formal-corpus', 'fixtures-check'].includes(name))) {
    const requiredQuint = JSON.parse(readFileSync(resolve(directory, 'formal/generated-fixtures.lock.json'), 'utf8')).quintVersion;
    const version = probe('quint', ['--version'], { directory, environment });
    if (version !== requiredQuint) throw new Error(`Expected Quint ${requiredQuint}; found ${version}. Install the pinned Quint CLI before recomputing artifacts.`);
  }
  if (targets.some(name => name.startsWith('integration-'))) probe('docker', ['info', '--format', '{{.ServerVersion}}'], { directory, environment });
  if (targets.includes('package-floor')) {
    const executable = floorExecutable(environment, runnerNode, nodeVersion);
    if (!executable || !isAbsolute(executable)) throw new Error('Node 22.15.0 is required for package-floor. Set NODE22_BIN=/absolute/path/to/node22/bin/node (or run make package-floor under exact Node 22.15.0). No runtime is downloaded automatically.');
    const version = probe(executable, ['--version'], { directory, environment });
    if (version !== 'v22.15.0') throw new Error(`NODE22_BIN must be exact Node 22.15.0; found ${version}.`);
  }
}

// No shell pipeline: each child exit status is checked before the next step.
// Native JSON reports go directly to files, avoiding enormous CI log streams.
export async function executeSteps(steps, { directory = root, environment = process.env, log = message => console.log(message) } = {}) {
  const baseEnvironment = cleanEnvironment(environment);
  for (const step of steps) {
    log(`→ ${step.label}`);
    if (step.remove) {
      for (const path of step.remove) rmSync(resolve(directory, path), { force: true });
      continue;
    }
    if (step.requireFile) {
      if (!existsSync(resolve(directory, step.requireFile))) throw new Error(`${step.label}: ${step.requireFile} is missing. ${step.failureHint ?? ''}`);
      continue;
    }
    let output;
    if (step.stdoutFile) {
      const path = resolve(directory, step.stdoutFile);
      mkdirSync(dirname(path), { recursive: true });
      output = openSync(path, 'w');
    }
    try {
      await new Promise((resolveRun, reject) => {
        const child = spawn(step.command, step.args, { cwd: directory, env: cleanEnvironment(baseEnvironment, step.env),
          stdio: ['inherit', output ?? (step.requireEmptyStdout ? 'pipe' : 'inherit'), 'inherit'] });
        let unexpectedOutput = '';
        if (step.requireEmptyStdout) child.stdout.on('data', data => { unexpectedOutput += data; });
        child.once('error', error => reject(new Error(`${step.label}: ${error.message}. ${step.failureHint ?? ''}`)));
        child.once('close', (code, signal) => {
          if (code !== 0) reject(new Error(`${step.label} failed (${signal ?? `exit ${code}`}). ${step.failureHint ?? ''}`));
          else if (unexpectedOutput.trim()) reject(new Error(`${step.label} found files requiring formatting:\n${unexpectedOutput.trim()}`));
          else resolveRun();
        });
      });
    } finally {
      if (output !== undefined) closeSync(output);
    }
  }
}

export async function runTarget(target, { directory = root, environment = process.env } = {}) {
  const isolated = cleanEnvironment(environment, { PATH: `${dirname(process.execPath)}${delimiter}${environment.PATH ?? ''}` });
  checkPrerequisites(target, { directory, environment: isolated });
  await executeSteps(validationPlan(target, { directory, environment: isolated }), { directory, environment: isolated });
  console.log(`✓ ${target} completed`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [target = 'help', ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('Use node formal/validation.mjs <target>; run make help for targets.');
  if (target === 'help') {
    console.log(Object.entries(targetDescriptions).map(([name, description]) => `make ${name.padEnd(17)} ${description}`).join('\n'));
    console.log('\nPrerequisites: frozen pnpm install; Node 24, pinned pnpm; Go 1.27.1 / Quint 0.32.0 / Docker where required.');
    console.log('Full local CI: make ci NODE22_BIN=/absolute/path/to/node22/bin/node (exact 22.15.0).');
  } else {
    try { await runTarget(target); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
