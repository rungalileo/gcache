import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const replayTests = ['test/formal-conformance.test.ts', 'test/formal-effects.test.ts', 'test/formal-features.test.ts',
  'test/formal-local-clock.test.ts', 'test/formal-behavior.test.ts', 'test/formal-protocol-vectors.test.ts'];
const aggregateTargets = {
  check: ['check-ts', 'check-go', 'docs', 'audit'],
  formal: ['formal-check', 'formal-generate', 'formal-ts', 'formal-go'],
  mutations: ['mutations-ts', 'mutations-go'],
  integration: ['integration-ts', 'integration-go'],
  ci: ['check', 'package-floor', 'formal', 'model-check', 'integration', 'mutations'],
};
export const targetDescriptions = {
  check: 'TypeScript and Go checks, docs build and reviewed inventories; no Quint generation or Docker',
  'check-ts': 'Typecheck, unit coverage, build and packed-package checks on Node 24',
  'check-go': 'Go vet, formatting check and default tests with race detection',
  docs: 'Build the documentation site',
  audit: 'Check source, behavior, feature, Go and generated-fixture freshness inventories',
  smoke: 'Replay committed Quint-derived fixtures in TypeScript and Go; no full completion claim',
  formal: 'Check every scheduled Quint model, generate the complete corpus and shared witness evidence, then complete TypeScript and Go replay',
  'formal-check': 'Typecheck and run every scheduled Quint model, its public regressions and the model mutation challenges',
  'formal-generate': 'Generate/recompute artifacts and evaluate shared witness evidence over the complete corpus',
  'formal-ts': 'Complete prepared TypeScript replay of the generated corpus',
  'formal-go': 'Complete prepared Go replay of the generated corpus with race detection',
  'fixtures-check': 'Recompute every committed model-derived artifact with pinned Quint',
  explore: 'Explore a new recorded seed and replay both ports in an isolated source snapshot',
  'model-check': 'Symbolically verify the scheduled finite rules with pinned Quint/Apalache (Java 21)',
  mutations: 'Measure TypeScript and Go semantic mutations over the generated corpus and shared witness evidence',
  'mutations-ts': 'Measure TypeScript semantic mutations over the generated corpus',
  'mutations-go': 'Measure Go semantic mutations over the generated corpus and shared witness evidence',
  integration: 'Run real TypeScript and Go Redis/Valkey/Cluster integration checks',
  'integration-ts': 'Run TypeScript real integration checks',
  'integration-go': 'Run Go real integration and interoperability checks with race detection',
  'package-floor': 'Check zstd and the packed package on exact Node 22.15.0 (NODE22_BIN)',
  ci: 'Run check, package-floor, formal, model-check, integration and mutations in dependency order',
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
    ...(full ? { env: replayEnv } : {}) });
  // The language-neutral evaluator is the sole producer of the reusable witness
  // evidence; TypeScript replay only checks the same gate inside its suite.
  const witnesses = node('Evaluate shared witness evidence over the complete corpus', 'formal/witnesses.mjs', 'evaluate', '--profile', 'all');
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
    explore: [node('Explore and replay an isolated alternate-seed corpus', 'formal/explore.mjs')],
    'model-check': [node('Symbolically verify the scheduled finite rules', 'formal/check-symbolic-models.mjs')],
    // The model check is evidence about the Quint models (typechecks, bounded
    // runs, regressions and the mutation challenges). Nothing downstream reads
    // its output, so it is a sibling of generation rather than a prefix of it.
    'formal-check': [node('Check every scheduled Quint model', 'formal/run-models.mjs', 'check')],
    // Generation is the single shared producer: the corpus, wire artifacts and
    // witness evidence depend only on the models. Both ports' replays and both
    // mutation measurements read that output and can run in parallel off it.
    'formal-generate': [invalidate('ts', 'go'),
      node('Generate complete corpus and recompute wire artifacts', 'formal/run-models.mjs', 'generate'),
      node('Recompute committed Quint smoke and witness fixtures', 'formal/generated-fixtures.mjs', '--check'), witnesses],
    'formal-ts': [invalidate('ts'), node('Prepare TypeScript execution context', 'formal/conformance.mjs', 'prepare', 'typescript', reportPath('ts', 'context')),
      tsReplay(true), { ...node('Adapt TypeScript native assertion report', 'formal/conformance-adapters.mjs', 'typescript', reportPath('ts', 'replay'), reportPath('ts', 'context')), stdoutFile: reportPath('ts', 'completion') },
      completion('ts')],
    'formal-go': [invalidate('go'), node('Check Go parity inventory', 'formal/check-go-parity.mjs'),
      node('Prepare Go execution context', 'formal/conformance.mjs', 'prepare', 'go', reportPath('go', 'context')), nativeGo(true),
      { ...node('Check complete Go native report', 'formal/check-go-replay.mjs'), stdoutFile: '.formal-traces/go-replay-summary.json' },
      { ...node('Adapt Go native assertion report', 'formal/conformance-adapters.mjs', 'go', '.formal-traces/go-replay.jsonl', reportPath('go', 'context')), stdoutFile: reportPath('go', 'completion') }, completion('go')],
    'mutations-ts': [node('Measure TypeScript semantic mutations', 'formal/measure-semantics.mjs')],
    'mutations-go': [node('Measure Go semantic mutations', 'formal/measure-go-semantics.mjs')],
    'integration-ts': [pnpm('Run TypeScript Redis/Valkey/Cluster integrations', 'test:integration')],
    'integration-go': [{ ...go('Run Go Redis/Valkey/Cluster and TypeScript interoperability', 'test', '-race', '-tags', 'integration', '-count=1', '-run', '^TestRedisIntegration$', '-json', './...'), stdoutFile: '.formal-traces/go-integration.jsonl' }],
    'package-floor': [{ label: 'Require a built package for floor checks', requireFile: 'dist/index.js', failureHint: 'Build first with make check-ts, or run make ci with NODE22_BIN set.' },
      { label: 'Check Node 22.15 zstd round trip and output ceiling', command: node22, args: ['--eval', floorSmoke], env: { PATH: floorEnvironment(environment, node22).PATH } },
      { label: 'Check packed package on Node 22.15', command: node22, args: ['scripts/test-package.mjs'], env: { PATH: floorEnvironment(environment, node22).PATH } }],
  };
  return expandTargets(target).flatMap(name => plans[name]);
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
  if (targets.some(name => ['check-go', 'smoke', 'formal-go', 'mutations-go', 'integration-go', 'explore'].includes(name))) {
    const version = probe('go', ['version'], { directory, environment });
    if (!/^go version go1\.27\.1\s/.test(version)) throw new Error(`Validation requires Go 1.27.1; found ${version}. Put the pinned Go toolchain on PATH.`);
  }
  if (targets.some(name => ['formal-check', 'formal-generate', 'fixtures-check', 'explore', 'model-check'].includes(name))) {
    const requiredQuint = JSON.parse(readFileSync(resolve(directory, 'formal/generated-fixtures.lock.json'), 'utf8')).quintVersion;
    const version = probe('quint', ['--version'], { directory, environment });
    if (version !== requiredQuint) throw new Error(`Expected Quint ${requiredQuint}; found ${version}. Install the pinned Quint CLI before recomputing artifacts.`);
  }
  if (targets.includes('model-check')) {
    const version = probe('java', ['--version'], { directory, environment });
    if (!/^(?:openjdk|java) 21(?:\.|\s)/.test(version)) throw new Error(`Symbolic checking requires Java 21; found ${version.split('\n')[0]}. Put Java 21 on PATH.`);
    // The pinned Apalache distribution is unpacked from a checksummed tarball.
    try { probe('tar', ['--version'], { directory, environment }); }
    catch (error) { throw new Error(`Symbolic checking requires tar to unpack the pinned Apalache archive. ${error.message}`); }
  }
  if (targets.some(name => name.startsWith('integration-'))) probe('docker', ['info', '--format', '{{.ServerVersion}}'], { directory, environment });
  if (targets.includes('package-floor')) {
    const executable = floorExecutable(environment, runnerNode, nodeVersion);
    if (!executable || !isAbsolute(executable)) throw new Error('Node 22.15.0 is required for package-floor. Set NODE22_BIN=/absolute/path/to/node22/bin/node (or run make package-floor under exact Node 22.15.0). No runtime is downloaded automatically.');
    const version = probe(executable, ['--version'], { directory, environment });
    if (version !== 'v22.15.0') throw new Error(`NODE22_BIN must be exact Node 22.15.0; found ${version}.`);
  }
}

// Scan rather than only tail: a failed subtest can precede many passes.
// Retained lines and printed text stay bounded even for malformed or
// oversized JSONL. Each failure receives its own budget (a header plus the
// last lines buffered for that test), so one noisy failure cannot starve the
// others; failures beyond the cap are counted rather than dropped silently.
const excerptLimits = { failures: 24, bufferLines: 40, tailLines: 20, pendingTests: 64, line: 32 * 1024, output: 12 * 1024 };
const crashMarker = /(?:--- FAIL:|panic:|fatal error:|DATA RACE)/;
async function failureExcerpt(path) {
  const { createReadStream } = await import('node:fs');
  const selected = [], tail = [], pending = new Map();
  let line = '', truncated = false, failures = 0;
  const clip = text => text.length > 2048 ? `${text.slice(0, 2048)} … [line truncated]` : text;
  const consume = raw => {
    let event;
    try { event = JSON.parse(raw); } catch { /* Plain or truncated report line. */ }
    if (typeof event !== 'object' || event === null) event = undefined;
    // Go 1.24+ reports compiler diagnostics as build-output/build-fail events
    // keyed by ImportPath; older releases only had Test/Package.
    const key = event?.Test ?? event?.Package ?? event?.ImportPath ?? 'native process';
    const action = event?.Action;
    const hasOutput = typeof event?.Output === 'string';
    let text;
    if (event === undefined) text = raw;
    else if (hasOutput) text = event.Output.trimEnd();
    // Bare lifecycle events carry no diagnostic text: name the failures, skip the rest.
    else if (action === 'fail' || action === 'build-fail') text = `[${action} ${key}]`;
    else return;
    if (!text.trim()) return;
    tail.push(clip(text));
    if (tail.length > excerptLimits.tailLines) tail.shift();
    if (action === 'output' || action === 'build-output') {
      // Ordinary buffers keep their most recent lines. A race report is long
      // and its head names the conflicting accesses, so the marker anchors the
      // buffer: later lines are counted instead of evicting the head.
      const buffer = /WARNING: DATA RACE/.test(text) ? { lines: [], anchored: true, omitted: 0 }
        : pending.get(key) ?? { lines: [], anchored: false, omitted: 0 };
      if (buffer.lines.length < excerptLimits.bufferLines) buffer.lines.push(clip(text));
      else if (buffer.anchored) buffer.omitted++;
      else { buffer.lines.shift(); buffer.lines.push(clip(text)); }
      pending.delete(key); pending.set(key, buffer);
      if (pending.size > excerptLimits.pendingTests) pending.delete(pending.keys().next().value);
    }
    if (action === 'fail' || action === 'build-fail') {
      failures++;
      if (failures <= excerptLimits.failures) {
        const buffer = pending.get(key);
        selected.push(`Failed: ${key}`, ...(buffer?.lines ?? []));
        if (buffer?.omitted) selected.push(`… ${buffer.omitted} more lines for ${key}`);
      }
      pending.delete(key);
    } else if (action === 'pass' || action === 'skip') pending.delete(key);
    // Crashes may prevent a final Go fail event; plain/truncated lines still
    // expose the diagnostic instead of turning the excerpt into a JSON dump.
    // Output belonging to a test is attributed through its fail event only,
    // so a passing test that merely prints "panic:" is not selected.
    if (event === undefined && crashMarker.test(text) && selected.length < excerptLimits.failures * excerptLimits.bufferLines) selected.push(clip(text));
  };
  for await (const chunk of createReadStream(path, { encoding: 'utf8', highWaterMark: 64 * 1024 })) {
    let start = 0;
    for (let end = chunk.indexOf('\n', start); end !== -1; end = chunk.indexOf('\n', start)) {
      const part = chunk.slice(start, end);
      truncated ||= line.length + part.length > excerptLimits.line;
      line += part.slice(0, Math.max(0, excerptLimits.line - line.length));
      consume(line + (truncated ? ' … [line truncated]' : ''));
      line = ''; truncated = false; start = end + 1;
    }
    const part = chunk.slice(start);
    truncated ||= line.length + part.length > excerptLimits.line;
    line += part.slice(0, Math.max(0, excerptLimits.line - line.length));
  }
  if (line || truncated) consume(line + (truncated ? ' … [line truncated]' : ''));
  if (failures > excerptLimits.failures) selected.push(`… ${failures - excerptLimits.failures} more failed tests`);
  const excerpt = (selected.length ? selected : tail).join('\n');
  return excerpt.length > excerptLimits.output ? `${excerpt.slice(0, excerptLimits.output)}\n… [diagnostics truncated]` : excerpt;
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
    } catch (error) {
      if (step.stdoutFile) {
        const path = resolve(directory, step.stdoutFile);
        try {
          const excerpt = await failureExcerpt(path);
          log(`Failed command report: ${path}\n${excerpt || '(no stdout captured)'}`);
        } catch (diagnosticError) {
          // Diagnostic collection must never replace the original child failure.
          try { log(`Failed command report: ${path} (unable to read: ${diagnosticError.message})`); } catch {}
        }
      }
      throw error;
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
    console.log('\nPrerequisites: frozen pnpm install; Node 24, pinned pnpm; Go 1.27.1 / Docker where required; Quint 0.32.0 for formal-check, formal-generate, fixtures-check, explore and model-check; Java 21 and tar for model-check and ci.');
    console.log('formal-check is the Quint evidence lane (models, regressions, challenges); the port and mutation lanes read only the formal-generate output and do not wait for it.');
    console.log('Full local CI: make ci NODE22_BIN=/absolute/path/to/node22/bin/node (exact 22.15.0).');
  } else {
    try { await runTarget(target); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
