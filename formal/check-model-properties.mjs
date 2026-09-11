import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readExecution } from './execution.mjs';
import { modelPropertyChallenges } from './model-property-challenges.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export function validatePropertyResult(result, exitCode, expectation) {
  if (!['baseline', 'mutant'].includes(expectation)) throw new Error('Unknown model measurement expectation');
  if (!result || !Array.isArray(result.errors) || result.errors.length ||
      !Array.isArray(result.trace) || result.trace.length === 0) {
    throw new Error('Evaluator errors or incomplete traces are not property evidence');
  }
  if (expectation === 'baseline' && (exitCode !== 0 || result.status !== 'ok')) {
    throw new Error('Unmodified model must satisfy the property');
  }
  // An invariant can fail in the initial state; one state is a real witness.
  if (expectation === 'mutant' && (exitCode !== 1 || result.status !== 'violation')) {
    throw new Error('Compiling model fault survived or did not produce an invariant violation');
  }
}

export function measureModelProperties() {
  const output = resolve(root, '.formal-traces/model-properties');
  const { settings, check } = readExecution();
  const options = [`--backend=${settings.backend}`, `--n-threads=${settings.threads}`, `--seed=${settings.seed}`,
    `--max-samples=${check.maxSamples}`, `--max-steps=${check.maxSteps}`];
  const files = readdirSync(resolve(root, 'formal')).filter(name => name.endsWith('.qnt')).sort();
  const sources = new Map(files.map(name => [`formal/${name}`, readFileSync(resolve(root, 'formal', name), 'utf8')]));
  mkdirSync(output, { recursive: true });
  const report = { schemaVersion: 2, complete: false, mode: 'bounded-simulation', options,
    sources: Object.fromEntries([...sources].map(([path, source]) => [path, createHash('sha256').update(source).digest('hex')])),
    catalogSha256: createHash('sha256').update(readFileSync(new URL('./model-property-challenges.mjs', import.meta.url))).digest('hex'),
    challenges: [] };
  const save = () => writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  save();
  const workspace = mkdtempSync(resolve(tmpdir(), 'dialcache-model-properties-'));
  function execute(args) {
    const result = spawnSync('quint', args, { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    if (result.error || result.signal) throw new Error(`Quint execution failed: ${result.error ?? result.signal}`);
    return result;
  }
  try {
    const version = execute(['--version']);
    if (version.status !== 0) throw new Error('Cannot read Quint version');
    report.quintVersion = version.stdout.trim();
    for (const challenge of modelPropertyChallenges) {
      const source = sources.get(challenge.source);
      if (source === undefined || source.split(challenge.before).length !== 2) {
        throw new Error(`${challenge.id}: mutation anchor must match exactly once`);
      }
      const entry = { ...challenge, baseline: 'pending', mutant: 'pending' };
      report.challenges.push(entry);
      save();
      for (const label of ['baseline', 'mutant']) {
        // Restore imported modules before each run; no mutation can leak into
        // another baseline. The report fingerprints every Quint dependency.
        mkdirSync(resolve(workspace, 'formal'), { recursive: true });
        for (const [path, text] of sources) writeFileSync(resolve(workspace, path), text);
        if (label === 'mutant') writeFileSync(resolve(workspace, challenge.source), source.replace(challenge.before, challenge.after));
        const model = resolve(workspace, challenge.model);
        const prefix = resolve(output, `${challenge.id}-${label}`);
        const compile = execute(['typecheck', model]);
        writeFileSync(`${prefix}-typecheck.log`, compile.stdout + compile.stderr);
        if (compile.status !== 0) throw new Error(`${challenge.id}/${label}: model must typecheck before measurement`);
        rmSync(`${prefix}.json`, { force: true });
        const run = execute(['run', model, ...options, '--invariants', challenge.invariant, `--out=${prefix}.json`]);
        writeFileSync(`${prefix}.log`, run.stdout + run.stderr);
        const result = JSON.parse(readFileSync(`${prefix}.json`, 'utf8'));
        validatePropertyResult(result, run.status, label);
        entry[label] = label === 'baseline' ? 'passed' : 'detected';
        if (label === 'mutant') entry.counterexampleStates = result.trace.length;
        save();
      }
      console.log(`${challenge.id}: compiling fault violates ${challenge.invariant}`);
    }
    report.complete = true;
    save();
    return report;
  } catch (error) {
    report.error = String(error);
    save();
    throw error;
  } finally { rmSync(workspace, { recursive: true, force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) measureModelProperties();
