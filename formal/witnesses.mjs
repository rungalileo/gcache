import { existsSync, readdirSync, rmSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readExecution, root } from './execution.mjs';
import { witnessEvidence, writeWitnessEvidence } from './replay/witnesses/evidence.mjs';
import { checkWitnesses, readWitnessRegistry, witnessProfiles } from './replay/witnesses/index.mjs';

// Language-neutral witness completion. Any port runs this over the generated
// corpus instead of TypeScript's test suite: it evaluates the shared
// classifiers, requires every registered witness and declared action, and
// writes the evidence consumed by Go (and any other port) under
// .formal-traces/go-parity-witnesses. Failing profiles write nothing and
// remove stale evidence so a later consumer cannot reuse an older pass.
const tracesPrefix = '.formal-traces/';
const usage = 'Usage: node formal/witnesses.mjs evaluate [--profile <name|all>] [--traces <dir>] [--out <dir>]';

export function parseArguments(args) {
  const [command, ...rest] = args;
  if (command !== 'evaluate') throw new Error(usage);
  const options = { profile: 'all', traces: '.formal-traces', out: '.formal-traces/go-parity-witnesses' };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]?.replace(/^--/, ''), value = rest[index + 1];
    if (!Object.hasOwn(options, key) || value === undefined || !rest[index].startsWith('--')) throw new Error(usage);
    options[key] = value;
  }
  return options;
}

// Sampled histories come from the profile's generate.outputDirectory; exported
// public-action regressions from .formal-traces/regressions/<profile>. Both
// are relocated under --traces so an alternate corpus can be evaluated.
export function witnessCorpusPaths(profile, tracesRoot, execution = readExecution(), directory = root) {
  const model = execution.models.find(candidate => candidate.profile === profile);
  if (model === undefined) throw new Error(`${profile}: no scheduled model in formal/execution.json`);
  const output = model.generate?.outputDirectory;
  if (typeof output !== 'string' || !output.startsWith(tracesPrefix)) throw new Error(`${profile}: unsupported generate.outputDirectory`);
  const base = resolve(directory, tracesRoot);
  const sampled = resolve(base, output.slice(tracesPrefix.length));
  if (!existsSync(sampled)) throw new Error(`${profile}: missing sampled histories in ${sampled}; run node formal/run-models.mjs generate first`);
  const paths = readdirSync(sampled).filter(name => name.endsWith('.itf.json')).sort().map(name => resolve(sampled, name));
  for (const regression of model.replayRegressions ?? []) paths.push(resolve(base, 'regressions', profile, `${regression}.itf.json`));
  const missing = paths.filter(path => !existsSync(path));
  if (missing.length) throw new Error(`${profile}: missing histories ${missing.map(path => relative(directory, path)).join(', ')}`);
  return paths;
}

export function selectedProfiles(selection, execution = readExecution()) {
  const scheduled = execution.models.map(model => model.profile).filter(profile => witnessProfiles.includes(profile));
  if (selection === 'all') return scheduled;
  if (!scheduled.includes(selection)) throw new Error(`Unknown witness profile ${selection}; expected one of ${scheduled.join(', ')} or all`);
  return [selection];
}

export function evaluateProfiles(options, { directory = root, log = message => console.log(message) } = {}) {
  const execution = readExecution();
  const registry = readWitnessRegistry(resolve(directory, 'formal/coverage-witnesses.json'));
  const outputDirectory = resolve(directory, options.out);
  const failures = [];
  for (const profile of selectedProfiles(options.profile, execution)) {
    const paths = witnessCorpusPaths(profile, options.traces, execution, directory);
    const result = checkWitnesses(profile, paths, registry);
    if (result.missing.length) {
      rmSync(resolve(outputDirectory, `${profile}.json`), { force: true });
      failures.push(`witness/${profile}: ${result.traces} histories reached ${result.seen.size} labels; missing ${result.missing.join(', ')}`);
      continue;
    }
    const written = writeWitnessEvidence(outputDirectory, witnessEvidence(profile, result.seen, result.required, paths, directory));
    log(`witness/${profile}: ${result.traces} histories, ${result.seen.size} labels, ${result.required.length} required -> ${relative(directory, written)}`);
  }
  if (failures.length) throw new Error(`Incomplete witness coverage:\n${failures.join('\n')}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { evaluateProfiles(parseArguments(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
