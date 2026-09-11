import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readExecution, root, validateExecution } from './execution.mjs';
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
        ...(model.replayRegressions === undefined ? {} : { explicitInputs: true }) });
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

// Exported regression histories bind to the driver contract at generation
// time, so an out-of-domain choice or unknown action fails here, not during a
// later native replay. Binding reads only the trace; no driver executes.
export function bindExportedTrace(profile, text, path) {
  bindTrace(profile, JSON.parse(text), path);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, option, ...extra] = process.argv.slice(2);
  if (extra.length || (option !== undefined && option !== '--dry-run')) throw new Error('Usage: node formal/run-models.mjs check|generate [--dry-run]');
  const manifest = readExecution();
  const commands = executionPlan(mode, manifest);
  if (option === '--dry-run') console.log(JSON.stringify(commands, null, 2));
  else {
    if (mode === 'check') mkdirSync(resolve(root, manifest.check.outputDirectory), { recursive: true });
    for (const job of commands) {
      if (job.outputDirectory) {
        rmSync(resolve(root, job.outputDirectory), { recursive: true, force: true });
        mkdirSync(resolve(root, job.outputDirectory), { recursive: true });
      }
      console.log(`::group::${job.command} ${job.args.slice(0, 2).join(' ')}`);
      const result = spawnSync(job.command, job.args, { cwd: root, stdio: 'inherit' });
      if (result.error) throw result.error;
      if (result.status !== 0) process.exit(result.status ?? 1);
      console.log('::endgroup::');
      if (job.outputDirectory) {
        const files = readdirSync(resolve(root, job.outputDirectory)).filter(name => name.endsWith('.itf.json'));
        if (files.length !== job.expectedTraces) throw new Error(`Expected ${job.expectedTraces} traces in ${job.outputDirectory}; generated ${files.length}`);
        if (job.expectedFiles && JSON.stringify([...files].sort()) !== JSON.stringify([...job.expectedFiles].sort())) throw new Error(`Regression trace inventory differs in ${job.outputDirectory}`);
        if (job.explicitInputs) for (const name of files) {
          const path = resolve(root, job.outputDirectory, name);
          const normalized = JSON.stringify(normalizeReplayInputs(JSON.parse(readFileSync(path, 'utf8')))) + '\n';
          writeFileSync(path, normalized);
          if (job.profile) bindExportedTrace(job.profile, normalized, `${job.outputDirectory}/${name}`);
        }
      }
    }
  }
}
