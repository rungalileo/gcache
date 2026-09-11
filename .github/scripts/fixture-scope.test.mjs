import assert from 'node:assert/strict';
import { test } from 'node:test';
import { affectsQuintArtifacts, fixtureScope } from './fixture-scope.mjs';

const base = 'a'.repeat(40), head = 'b'.repeat(40);
const pullRequest = { pull_request: { base: { sha: base }, head: { sha: head } } };
const changed = paths => args => args[0] === 'diff' ? paths.join('\0') + '\0' : '';

test('ordinary documentation changes retain only unconditional freshness checks', () => {
  assert.equal(fixtureScope('pull_request', pullRequest, changed(['docs/redis.md', 'formal/PORTING.md'])).recompute, false);
});

test('models, recipes, exporters, artifacts, execution and tool pins require recomputation', () => {
  for (const path of [
    'formal/new-model.qnt', 'formal/fixture-recipes.json', 'formal/generate-frame-vectors.mjs',
    'formal/execution.json', 'formal/execution.mjs', 'formal/profiles.json',
    'formal/generated-fixtures.lock.json', 'formal/quint-frame-vectors.json',
    'formal/conformance-smoke.itf.json', 'test/fixtures/new-witnesses.json',
    'package.json', 'pnpm-lock.yaml', 'go/go.mod', 'go/go.sum',
    '.github/actions/setup-quint/action.yml', '.github/workflows/formal.yaml',
  ]) assert.equal(fixtureScope('pull_request', pullRequest, changed([path])).recompute, true, path);
});

test('new explicitly declared fixture inputs are detected regardless of file extension', () => {
  assert.equal(affectsQuintArtifacts('test/new-model-input.data', new Set(['test/new-model-input.data'])), true);
});

test('fork pull requests use exact event SHAs and preserve both sides of renames', () => {
  const calls = [];
  const git = args => {
    calls.push(args);
    return args[0] === 'diff' ? 'formal/old-model.qnt\0archive/old-model.txt\0' : '';
  };
  assert.equal(fixtureScope('pull_request', pullRequest, git).recompute, true);
  assert.deepEqual(calls.at(-1), ['diff', '--name-only', '-z', '--no-renames', base, head, '--']);
});

test('push comparison covers all commits between before and after', () => {
  assert.equal(fixtureScope('push', { before: base, after: head }, changed(['formal/wire-text.qnt'])).recompute, true);
});

test('missing, zero, malformed and unsupported comparison ranges fail closed', () => {
  for (const [eventName, event] of [
    ['pull_request', {}], ['push', { before: '0'.repeat(40), after: head }],
    ['push', { before: '--help', after: head }], ['workflow_dispatch', {}],
  ]) assert.equal(fixtureScope(eventName, event, () => assert.fail('invalid SHA must not reach git')).recompute, true);
});

test('missing commits or a failed git diff require recomputation', () => {
  for (const failingCommand of ['cat-file', 'diff']) {
    const git = args => { if (args[0] === failingCommand) throw new Error('unavailable'); return ''; };
    assert.equal(fixtureScope('pull_request', pullRequest, git).recompute, true);
  }
});
