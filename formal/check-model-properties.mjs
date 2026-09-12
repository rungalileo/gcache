import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readExecution, validateExecution } from './execution.mjs';
import { printGroup, resolveConcurrency, runPool, seconds, spawnBuffered } from './quint-pool.mjs';

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

// Select a subset of the catalog by id for local iteration. The complete
// catalog remains the only accepted evidence: a filtered report is never final.
export function selectChallenges(manifest, only) {
  if (only === undefined) return manifest.challenges;
  const ids = new Set(only.split(',').filter(Boolean));
  const selected = manifest.challenges.filter(challenge => ids.has(challenge.id));
  const missing = [...ids].filter(id => !selected.some(challenge => challenge.id === id));
  if (missing.length) throw new Error(`Unknown model property challenges: ${missing.join(', ')}`);
  return selected;
}

export async function measureModelProperties({ only, concurrency = resolveConcurrency() } = {}) {
  const output = resolve(root, '.formal-traces/model-properties');
  const manifest = readExecution();
  // A complete measurement validates the whole manifest first; a filtered run
  // is a local iteration aid and may precede catalog coverage.
  if (only === undefined) validateExecution(manifest);
  const challenges = selectChallenges(manifest, only);
  const { settings, check } = manifest;
  const options = [`--backend=${settings.backend}`, `--n-threads=${settings.threads}`, `--seed=${settings.seed}`,
    `--max-samples=${check.maxSamples}`, `--max-steps=${check.maxSteps}`];
  const files = readdirSync(resolve(root, 'formal')).filter(name => name.endsWith('.qnt')).sort();
  const sources = new Map(files.map(name => [`formal/${name}`, readFileSync(resolve(root, 'formal', name), 'utf8')]));
  mkdirSync(output, { recursive: true });
  const report = { schemaVersion: 3, complete: false, partial: only !== undefined, mode: 'bounded-simulation', options,
    sources: Object.fromEntries([...sources].map(([path, source]) => [path, createHash('sha256').update(source).digest('hex')])),
    catalogSha256: createHash('sha256').update(readFileSync(resolve(root, 'formal/execution.json'))).digest('hex'),
    catalog: manifest.challenges.length, challenges: [] };
  const save = () => writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  save();
  async function execute(args) {
    // Bounds a hung evaluator, not a slow runner: a single bounded run took up
    // to 35 s on the slow hosted runner of run 34666226055 before this pool
    // shared its cores with three siblings.
    const result = await spawnBuffered('quint', args, { cwd: root, timeoutMs: 180_000 });
    if (result.error || result.signal) throw new Error(`Quint execution failed: ${result.error ?? result.signal}`);
    return result;
  }
  // Each challenge measures in its own copy of every Quint source, so challenges
  // run side by side and no mutation can leak into another baseline. The report
  // fingerprints every Quint dependency. Both runs of a challenge share the copy
  // and restore the unmodified sources first.
  async function measure(challenge, entry) {
    const source = sources.get(challenge.source);
    const workspace = mkdtempSync(resolve(tmpdir(), 'dialcache-model-properties-'));
    const lines = [];
    let detail = '';
    try {
      for (const label of ['baseline', 'mutant']) {
        mkdirSync(resolve(workspace, 'formal'), { recursive: true });
        for (const [path, text] of sources) writeFileSync(resolve(workspace, path), text);
        if (label === 'mutant') writeFileSync(resolve(workspace, challenge.source), source.replace(challenge.before, challenge.after));
        const model = resolve(workspace, challenge.model);
        const prefix = resolve(output, `${challenge.id}-${label}`);
        const compile = await execute(['typecheck', model]);
        detail = compile.stdout + compile.stderr;
        writeFileSync(`${prefix}-typecheck.log`, detail);
        if (compile.status !== 0) throw new Error(`${challenge.id}/${label}: model must typecheck before measurement`);
        rmSync(`${prefix}.json`, { force: true });
        const run = await execute(['run', model, ...options, '--invariants', challenge.invariant, `--out=${prefix}.json`]);
        detail = run.stdout + run.stderr;
        writeFileSync(`${prefix}.log`, detail);
        const result = JSON.parse(readFileSync(`${prefix}.json`, 'utf8'));
        validatePropertyResult(result, run.status, label);
        entry[label] = label === 'baseline' ? 'passed' : 'detected';
        if (label === 'mutant') entry.counterexampleStates = result.trace.length;
        save();
        lines.push(`${label}: typecheck ${seconds(compile.durationMs)}; run ${result.status} after ${result.trace.length} states, ${seconds(run.durationMs)}\n`);
      }
      printGroup(`${challenge.id}: compiling fault violates ${challenge.invariant}`, ...lines);
    } catch (error) {
      printGroup(`${challenge.id}: measurement failed`, ...lines, detail, `${error}\n`);
      throw error;
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  }
  try {
    const version = await execute(['--version']);
    if (version.status !== 0) throw new Error('Cannot read Quint version');
    report.quintVersion = version.stdout.trim();
    for (const challenge of challenges) {
      const source = sources.get(challenge.source);
      if (source === undefined || source.split(challenge.before).length !== 2) {
        throw new Error(`${challenge.id}: mutation anchor must match exactly once`);
      }
    }
    // Entries hold catalog order from the start; completions fill them in place,
    // so the saved report never depends on which challenge finished first.
    for (const challenge of challenges) report.challenges.push({ ...challenge, baseline: 'pending', mutant: 'pending' });
    save();
    await runPool(challenges.map((challenge, index) => () => measure(challenge, report.challenges[index])), { concurrency });
    report.complete = only === undefined;
    save();
    return report;
  } catch (error) {
    report.error = String(error);
    save();
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [option, ...extra] = process.argv.slice(2);
  if (extra.length || (option !== undefined && !option.startsWith('--only='))) throw new Error('Usage: node formal/check-model-properties.mjs [--only=id,id]');
  await measureModelProperties({ only: option?.slice('--only='.length) });
}
