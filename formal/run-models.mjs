import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readExecution, root, validateExecution } from './execution.mjs';
import { CommandFailure, printGroup, resolveConcurrency, runPool, seconds, spawnBuffered } from './quint-pool.mjs';
import { normalizeReplayInputs } from './replay-inputs.mjs';
import { bindTrace } from './replay/bindings.mjs';

export function executionPlan(mode, manifest = readExecution(), seed = process.env.QUINT_SEED || manifest.settings.seed) {
  validateExecution(manifest);
  if (!['check', 'generate'].includes(mode)) throw new Error('Expected check or generate');
  const { settings, check, test } = manifest;
  const options = [`--backend=${settings.backend}`, `--n-threads=${settings.threads}`, `--seed=${seed}`];
  const commands = [];
  for (const model of manifest.models) {
    if (mode === 'check') {
      commands.push({ command: 'quint', args: ['typecheck', model.path] });
      commands.push({ command: 'quint', args: ['run', model.path, ...options,
        `--max-samples=${check.maxSamples}`, `--max-steps=${check.maxSteps}`,
        `--out-itf=${check.outputDirectory}/${basename(model.path, '.qnt')}.itf.json`,
        `--verbosity=${settings.verbosity}`, '--invariants', ...model.invariants] });
      if (model.regressions.length) commands.push({ command: 'quint', args: ['test', model.path,
        `--backend=${settings.backend}`, `--max-samples=${test.maxSamples}`] });
    } else if (model.vectorExport) {
      commands.push({ command: 'node', args: [model.vectorExport.generator, '--check'] });
    } else if (model.generate) {
      const generation = model.generate;
      commands.push({ command: 'quint', args: ['run', model.path, '--mbt', ...options,
        `--max-samples=${generation.maxSamples}`, `--max-steps=${generation.maxSteps}`, `--n-traces=${generation.traces}`,
        `--out-itf=${generation.outputDirectory}/trace_{seq}.itf.json`, `--verbosity=${settings.verbosity}`,
        '--invariants', ...model.invariants], outputDirectory: generation.outputDirectory, expectedTraces: generation.traces,
        ...(model.replayRegressions === undefined ? {} : { explicitInputs: true }),
        ...(model.profile === undefined ? {} : { profile: model.profile }) });
      if (model.replayRegressions?.length) {
        const outputDirectory = `.formal-traces/regressions/${model.profile}`;
        commands.push({ command: 'quint', args: ['test', model.path,
          `--backend=${settings.backend}`, '--max-samples=1', `--seed=${seed}`,
          `--match=^(${model.replayRegressions.join('|')})$`,
          `--out-itf=${outputDirectory}/{test}.itf.json`], outputDirectory,
          expectedTraces: model.replayRegressions.length, explicitInputs: true, profile: model.profile,
          expectedFiles: model.replayRegressions.map(name => `${name}.itf.json`) });
      }
    }
  }
  // Every compiling fault in the manifest catalog runs once, after the models
  // it mutates have been checked in their unmodified form.
  if (mode === 'check') commands.push({ command: 'node', args: ['formal/check-model-properties.mjs'] });
  return commands;
}

// Sampled and exported histories both bind to the driver contract at
// generation time, so an out-of-domain choice or unknown action fails here,
// not during a later native replay. Binding reads only the trace; no driver
// executes.
export function bindGeneratedTrace(profile, text, path) {
  bindTrace(profile, JSON.parse(text), path);
}

// Group a plan into chains that run side by side. A model's Quint jobs keep
// their plan order inside one chain (check: typecheck, run, test; generate:
// sampled run, then regression export); jobs for different models and the
// vector exports are independent. The closing challenge run is not a chain: it
// mutates its own copies of several models and starts only after every chain
// has checked those models unmodified.
const isChallengeRun = job => job.command === 'node' && job.args[0] === 'formal/check-model-properties.mjs';
export function executionChains(commands) {
  const chains = [], byModel = new Map();
  for (const job of commands) {
    if (isChallengeRun(job)) continue;
    if (job.command !== 'quint') { chains.push([job]); continue; }
    const model = job.args[1];
    if (!byModel.has(model)) { byModel.set(model, []); chains.push(byModel.get(model)); }
    byModel.get(model).push(job);
  }
  return chains;
}

// Run one planned job with buffered output and validate what it produced.
// A sampled or exported corpus is counted, normalized and bound to its driver
// contract right after its own process exits, inside the model's chain.
async function executeJob(job) {
  if (job.outputDirectory) {
    rmSync(resolve(root, job.outputDirectory), { recursive: true, force: true });
    mkdirSync(resolve(root, job.outputDirectory), { recursive: true });
  }
  const title = `${job.command} ${job.args.slice(0, 2).join(' ')}`;
  const result = await spawnBuffered(job.command, job.args, { cwd: root });
  printGroup(`${title} (${seconds(result.durationMs)})`, result.stdout, result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new CommandFailure(`${title} failed (${result.signal ?? `exit ${result.status}`})`, result);
  if (job.outputDirectory) {
    const files = readdirSync(resolve(root, job.outputDirectory)).filter(name => name.endsWith('.itf.json'));
    if (files.length !== job.expectedTraces) throw new Error(`Expected ${job.expectedTraces} traces in ${job.outputDirectory}; generated ${files.length}`);
    if (job.expectedFiles && JSON.stringify([...files].sort()) !== JSON.stringify([...job.expectedFiles].sort())) throw new Error(`Regression trace inventory differs in ${job.outputDirectory}`);
    if (job.explicitInputs || job.profile) for (const name of files) {
      const path = resolve(root, job.outputDirectory, name);
      let text = readFileSync(path, 'utf8');
      if (job.explicitInputs) {
        text = JSON.stringify(normalizeReplayInputs(JSON.parse(text))) + '\n';
        writeFileSync(path, text);
      }
      if (job.profile) bindGeneratedTrace(job.profile, text, `${job.outputDirectory}/${name}`);
    }
  }
}

async function executePlan(mode, manifest, commands) {
  const concurrency = resolveConcurrency();
  if (mode === 'check') mkdirSync(resolve(root, manifest.check.outputDirectory), { recursive: true });
  const chains = executionChains(commands);
  console.log(`Running ${chains.length} Quint job chains, ${concurrency} at a time, one thread each`);
  await runPool(chains.map(chain => async () => { for (const job of chain) await executeJob(job); }), { concurrency });
  for (const job of commands.filter(isChallengeRun)) {
    // The challenge run prints its own log groups; wrapping it would nest them.
    console.log(`${job.command} ${job.args.join(' ')}`);
    const result = spawnSync(job.command, job.args, { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new CommandFailure(`${job.args.join(' ')} failed (${result.signal ?? `exit ${result.status}`})`, result);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, option, ...extra] = process.argv.slice(2);
  if (extra.length || (option !== undefined && option !== '--dry-run')) throw new Error('Usage: node formal/run-models.mjs check|generate [--dry-run]');
  const manifest = readExecution();
  const commands = executionPlan(mode, manifest);
  if (option === '--dry-run') console.log(JSON.stringify(commands, null, 2));
  else {
    try { await executePlan(mode, manifest, commands); }
    catch (error) {
      if (!(error instanceof CommandFailure)) throw error;
      console.error(error.message);
      // Set the exit code rather than calling process.exit: a piped stdout is
      // asynchronous on macOS and an immediate exit drops the buffered log
      // groups that explain the failure.
      process.exitCode = error.status ?? 1;
    }
  }
}
