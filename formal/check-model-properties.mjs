import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readExecution } from './execution.mjs';

// Challenge a verification property itself, separately from implementation
// mutation/replay. A noncompiling model or failed evaluator is never detection.
const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, '.formal-traces/model-properties');
const source = readFileSync(resolve(root, 'formal/dialcache-coalescing-liveness.qnt'), 'utf8');
const before = 'fallbackDeadline: s.now + FALLBACK_TIMEOUT,';
const after = 'fallbackDeadline: FALLBACK_TIMEOUT,';
const invariant = 'fallbackDeadlineStartsWithFallback';
const { settings, check } = readExecution();
// The challenge uses the reviewed default seed, including during exploratory
// QUINT_SEED runs, so its detection requirement stays reproducible.
const options = [`--backend=${settings.backend}`, `--n-threads=${settings.threads}`, `--seed=${settings.seed}`,
  `--max-samples=${check.maxSamples}`, `--max-steps=${check.maxSteps}`, '--invariants', invariant];
mkdirSync(output, { recursive: true });
const report = { schemaVersion: 1, complete: false, contract: 'C23', invariant,
  sourceSha256: createHash('sha256').update(source).digest('hex'), before, after, options };
const save = () => writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
save();
if (source.split(before).length !== 2) throw new Error('Deadline mutation anchor changed; review the model property challenge');
const workspace = mkdtempSync(resolve(tmpdir(), 'dialcache-model-property-'));
function execute(args) {
  const result = spawnSync('quint', args, { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.signal) throw new Error(`Quint execution failed: ${result.error ?? result.signal}`);
  return result;
}
try {
  const version = execute(['--version']);
  if (version.status !== 0) throw new Error('Cannot read Quint version');
  report.quintVersion = version.stdout.trim();
  for (const [label, text] of [['baseline', source], ['deadline-epoch', source.replace(before, after)]]) {
    const path = resolve(workspace, 'dialcache-coalescing-liveness.qnt');
    writeFileSync(path, text);
    const compile = execute(['typecheck', path]);
    writeFileSync(resolve(output, `${label}-typecheck.log`), compile.stdout + compile.stderr);
    if (compile.status !== 0) throw new Error(`${label}: model must typecheck before property measurement`);
    const json = resolve(output, `${label}.json`);
    rmSync(json, { force: true });
    const run = execute(['run', path, ...options, `--out=${json}`]);
    writeFileSync(resolve(output, `${label}.log`), run.stdout + run.stderr);
    const result = JSON.parse(readFileSync(json, 'utf8'));
    if (!Array.isArray(result.errors) || result.errors.length || !Array.isArray(result.trace)) {
      throw new Error(`${label}: evaluator errors or incomplete report are not property evidence`);
    }
    if (label === 'baseline') {
      if (run.status !== 0 || result.status !== 'ok') throw new Error('Unmodified model must satisfy the property');
      report.baseline = 'passed';
    } else {
      if (run.status !== 1 || result.status !== 'violation' || result.trace.length < 2) {
        throw new Error('C23 deadline-epoch fault survived, or evaluator did not return an invariant counterexample');
      }
      report.mutant = 'detected';
      report.counterexampleStates = result.trace.length;
    }
  }
  report.complete = true;
  save();
  console.log('C23: compiling deadline-epoch model mutation violates fallbackDeadlineStartsWithFallback');
} catch (error) {
  report.error = String(error);
  save();
  throw error;
} finally { rmSync(workspace, { recursive: true, force: true }); }
