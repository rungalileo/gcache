import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Conservative, read-only scope detection. Fork PRs need no API token or writable
// permissions: checkout's full git history and event SHAs supply the comparison.
export function affectsQuintArtifacts(path, declaredInputs = new Set()) {
  return declaredInputs.has(path)
    || /^formal\/.*\.(qnt|mjs|mts|sh)$/.test(path)
    || /^formal\/.*\.itf\.json$/.test(path)
    || /^formal\/quint-.*\.json$/.test(path)
    || /^formal\/(execution|profiles|fixture-recipes|generated-fixtures\.lock)\.json$/.test(path)
    || /^test\/fixtures\/.*witness.*\.json$/.test(path)
    || /^\.github\/(actions|scripts|workflows)\//.test(path)
    || /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|\.nvmrc|\.node-version|\.tool-versions|Makefile|go\/go\.(mod|sum))$/.test(path);
}

export function fixtureScope(eventName, event, git = args => execFileSync('git', args, { encoding: 'utf8' }), declaredInputs = new Set()) {
  try {
    const [base, head] = eventName === 'pull_request'
      ? [event.pull_request?.base?.sha, event.pull_request?.head?.sha]
      : eventName === 'push' ? [event.before, event.after] : [];
    const validSha = value => typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value) && !/^0+$/.test(value);
    if (!validSha(base) || !validSha(head)) return { recompute: true, reason: 'No complete comparison range; recompute conservatively.' };
    git(['cat-file', '-e', `${base}^{commit}`]);
    git(['cat-file', '-e', `${head}^{commit}`]);
    // Disable rename collapsing so removing or renaming an input cannot hide it.
    const changed = git(['diff', '--name-only', '-z', '--no-renames', base, head, '--']).split('\0').filter(Boolean);
    const relevant = changed.filter(path => affectsQuintArtifacts(path, declaredInputs));
    return { recompute: relevant.length > 0, reason: relevant.length ? `Artifact inputs changed: ${relevant.join(', ')}` : 'No model, recipe, exporter, artifact or tool input changes.' };
  } catch (error) {
    return { recompute: true, reason: `Comparison unavailable; recompute conservatively (${error.message}).` };
  }
}

function main() {
  let result;
  try {
    const lock = JSON.parse(readFileSync('formal/generated-fixtures.lock.json', 'utf8'));
    if (!lock.inputs || !lock.artifacts) throw new Error('Fixture lock has no declared input/artifact inventory');
    const declaredInputs = new Set([...Object.keys(lock.inputs), ...Object.keys(lock.artifacts)]);
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    result = fixtureScope(process.env.GITHUB_EVENT_NAME, event, undefined, declaredInputs);
  } catch (error) {
    result = { recompute: true, reason: `Scope inputs unavailable; recompute conservatively (${error.message}).` };
  }
  console.log(result.reason);
  // A missing output path fails the step rather than silently skipping generation.
  appendFileSync(process.env.GITHUB_OUTPUT, `recompute=${result.recompute}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
