import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';

// Process-level concurrency for the formal scripts that spawn Quint.
//
// Rules shared by run-models.mjs, check-model-properties.mjs and
// generated-fixtures.mjs:
// - Every Quint process keeps the manifest's `--n-threads=1`. Parallelism comes
//   only from running independent processes side by side; each process owns its
//   seed, inputs and output paths, so a result never depends on the worker count.
// - Worker count: QUINT_JOBS when set (a positive integer), otherwise
//   os.availableParallelism(), never below one. QUINT_JOBS=1 is the sequential path.
// - runPool returns results indexed by task, not by finish time, so a report
//   assembled from them is deterministic.
// - A command's stdout and stderr are buffered and printed as one `::group::`
//   block when the command finishes, so GitHub log groups never interleave.
// - Fail fast: after the first failed task no further task starts; tasks already
//   in flight run to completion (they are never killed) and still print their
//   groups; the pool then rethrows the first failure.
export function resolveConcurrency(env = process.env, available = availableParallelism()) {
  const raw = env.QUINT_JOBS;
  if (raw === undefined) return Math.max(1, available);
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`QUINT_JOBS must be a positive integer; got ${JSON.stringify(raw)}`);
  }
  return value;
}

// Nonzero exit or signal from a spawned command. `status` lets a CLI exit with
// the child's own code, as the sequential spawnSync loops did.
export class CommandFailure extends Error {
  constructor(message, { status, signal } = {}) {
    super(message);
    this.name = 'CommandFailure';
    this.status = status;
    this.signal = signal;
  }
}

// Spawn with piped stdout/stderr and collect both. Never rejects: a spawn error
// (for example a missing binary) or a timeout is reported in `error`, and
// `status`/`signal` come from the child's close event.
export function spawnBuffered(command, args, { cwd, env, timeoutMs } = {}) {
  return new Promise(settle => {
    const started = performance.now();
    let stdout = '', stderr = '', error, timer;
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        error ??= Object.assign(new Error(`Timed out after ${timeoutMs} ms`), { code: 'ETIMEDOUT' });
        child.kill('SIGTERM');
      }, timeoutMs);
    }
    child.once('error', cause => { error ??= cause; });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      settle({ status, signal, error, stdout, stderr, durationMs: performance.now() - started });
    });
  });
}

export function formatGroup(title, ...texts) {
  const body = texts.filter(Boolean).join('');
  return `::group::${title}\n${body}${body && !body.endsWith('\n') ? '\n' : ''}::endgroup::`;
}
export const printGroup = (title, ...texts) => console.log(formatGroup(title, ...texts));
export const seconds = durationMs => `${(durationMs / 1000).toFixed(1)} s`;

// Execute async task thunks with at most `concurrency` in flight.
export async function runPool(tasks, { concurrency = resolveConcurrency() } = {}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error(`Invalid pool concurrency: ${concurrency}`);
  const results = new Array(tasks.length);
  let next = 0, failure;
  const worker = async () => {
    while (failure === undefined && next < tasks.length) {
      const index = next++;
      try { results[index] = await tasks[index](); }
      catch (error) { failure ??= { index, error }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  if (failure) throw failure.error;
  return results;
}
