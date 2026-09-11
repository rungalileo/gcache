import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { readExecution, validateExecution } from './execution.mjs';
import { prepareApalache } from './apalache.mjs';
import { waitForApalache } from './apalache-readiness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
export function validateSymbolicResult(result, exitCode) {
  if (exitCode !== 0 || result?.stage !== 'verifying' || result.status !== 'ok'
    || !Array.isArray(result.errors) || result.errors.length !== 0) {
    throw new Error('Symbolic verification did not complete successfully; violations, tool failures and incomplete reports cannot count as a pass.');
  }
}

export function symbolicPlan(manifest = readExecution()) {
  const models = manifest.models.filter(model => model.symbolic);
  if (!models.length || manifest.symbolic?.backend !== 'apalache' || manifest.symbolic.version !== '0.56.1') {
    throw new Error('Expected scheduled symbolic models and pinned Apalache 0.56.1.');
  }
  return models.map(model => ({ model: model.path, invariants: model.invariants,
    maxSteps: model.symbolic.maxSteps, timeoutMs: model.symbolic.timeoutMs,
    output: `.formal-traces/symbolic/${basename(model.path, '.qnt')}.json`,
    args: ['verify', model.path, '--backend=apalache', '--apalache-version=0.56.1',
      `--max-steps=${model.symbolic.maxSteps}`, '--invariants', ...model.invariants,
      `--out=.formal-traces/symbolic/${basename(model.path, '.qnt')}.json`] }));
}

// Reserve a fresh loopback port. An explicitly requested occupied port fails;
// it can never silently select an already-running, possibly different solver.
async function freeEndpoint(endpoint) {
  if (endpoint !== undefined && !/^127\.0\.0\.1:[1-9]\d*$/.test(endpoint)) throw new Error('Expected a loopback solver endpoint');
  const listener = createServer();
  await new Promise((accept, reject) => {
    listener.once('error', reject);
    listener.listen(endpoint ? Number(endpoint.split(':')[1]) : 0, '127.0.0.1', accept);
  });
  const selected = `127.0.0.1:${listener.address().port}`;
  await new Promise((accept, reject) => listener.close(error => error ? reject(error) : accept()));
  return selected;
}

// Quint's version flag only pins a download, not an existing server. Own the
// process instead, require its version AND bind-success banner, and fingerprint
// the exact launcher/JAR. A process racing for the freed port cannot pass this.
export async function startSymbolicServer({ launcher, jar, version, output, endpoint }) {
  endpoint = await freeEndpoint(endpoint);
  const port = endpoint.split(':')[1];
  const log = resolve(output, 'apalache-server.log');
  const descriptor = openSync(log, 'w');
  const server = spawn(launcher, ['server', `--port=${port}`], {
    cwd: output, env: { ...process.env, APALACHE_JAR: jar }, stdio: ['ignore', descriptor, descriptor],
  });
  closeSync(descriptor);
  let failure;
  server.once('error', error => { failure = error; });
  const exited = new Promise(accept => server.once('close', accept));
  const assertAlive = () => {
    if (failure || !server.pid || server.exitCode !== null || server.signalCode !== null) {
      throw new Error(`Owned Apalache server exited: ${failure ?? server.exitCode ?? server.signalCode}`);
    }
  };
  const stop = async () => {
    if (server.pid && server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM');
      await Promise.race([exited, delay(3000, undefined, { ref: false })]);
      if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
    }
    await exited;
  };
  try {
    for (const started = Date.now();;) {
      assertAlive();
      const text = readFileSync(log, 'utf8');
      const observed = /^# APALACHE version: (\S+) \| build: (\S+)/m.exec(text);
      if (observed && observed[1] !== version) throw new Error(`Owned Apalache version ${observed[1]} differs from required ${version}`);
      if (observed && text.includes(`The Apalache server is running on port ${port}.`)) {
        // A bind banner does not imply that cold gRPC reflection is ready.
        await waitForApalache(endpoint, assertAlive);
        assertAlive();
        return { endpoint, assertAlive, stop, evidence: { endpoint, pid: server.pid, version: observed[1],
          build: observed[2], readiness: 'grpc-reflection-cmd-executor', launcher, launcherSha256: hash(launcher), jar, jarSha256: hash(jar) } };
      }
      if (Date.now() - started > 20_000) throw new Error('Owned Apalache startup did not attest its version and bound endpoint');
      await delay(50);
    }
  } catch (error) { await stop(); throw error; }
}

export async function checkSymbolicModels({ directory = root } = {}) {
  const output = resolve(directory, '.formal-traces/symbolic');
  mkdirSync(output, { recursive: true });
  const report = { schemaVersion: 1, kind: 'bounded-symbolic-verification', complete: false,
    sources: {}, checks: [] };
  const save = () => writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  // Invalidate a previous pass before even reading or validating the manifest.
  save();
  let server, installation;
  try {
    const manifest = JSON.parse(readFileSync(resolve(directory, 'formal/execution.json'), 'utf8'));
    validateExecution(manifest);
    const plan = symbolicPlan(manifest);
    report.backend = manifest.symbolic;
    const sources = ['formal/execution.json', 'formal/execution.mjs', 'formal/generated-fixtures.lock.json',
      'formal/check-symbolic-models.mjs', 'formal/apalache.mjs', 'formal/apalache-readiness.mjs', ...manifest.libraries, ...manifest.models.map(model => model.path)];
    report.sources = Object.fromEntries(sources.map(path => [path, hash(resolve(directory, path))]));
    save();
    const version = spawnSync('quint', ['--version'], { cwd: directory, encoding: 'utf8', timeout: 15_000 });
    const pinned = JSON.parse(readFileSync(resolve(directory, 'formal/generated-fixtures.lock.json'), 'utf8')).quintVersion;
    if (version.error || version.status !== 0 || version.stdout.trim() !== pinned) throw new Error(`Symbolic checking requires Quint ${pinned}.`);
    report.quintVersion = version.stdout.trim();
    installation = await prepareApalache(manifest.symbolic, { output });
    report.archive = installation.archive;
    report.quintHome = installation.quintHome;
    server = await startSymbolicServer({ ...installation,
      version: manifest.symbolic.version, output });
    report.solver = server.evidence;
    save();
    for (const job of plan) {
      console.log(`Symbolically check ${job.model} through ${job.maxSteps} steps (${job.invariants.length} properties)`);
      rmSync(resolve(directory, job.output), { force: true });
      const args = [...job.args, `--server-endpoint=${server.endpoint}`];
      const run = spawnSync('quint', args, { cwd: directory, encoding: 'utf8', timeout: job.timeoutMs, maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, QUINT_HOME: installation.quintHome, APALACHE_JAR: installation.jar } });
      const log = resolve(output, `${basename(job.model, '.qnt')}.log`);
      writeFileSync(log, (run.stdout ?? '') + (run.stderr ?? ''));
      await delay(0); // Observe an owned-server exit that happened during spawnSync.
      server.assertAlive();
      if (run.error || run.signal || !existsSync(resolve(directory, job.output))) {
        throw new Error(`${job.model}: symbolic checker failed (${run.error?.message ?? run.signal ?? `exit ${run.status} without a result`}). See ${log}`);
      }
      validateSymbolicResult(JSON.parse(readFileSync(resolve(directory, job.output), 'utf8')), run.status);
      report.checks.push({ ...job, args, status: 'passed', reportSha256: hash(resolve(directory, job.output)) });
      save();
    }
    // A concurrent edit cannot inherit an earlier model-check result.
    for (const [path, before] of Object.entries(report.sources)) if (hash(resolve(directory, path)) !== before) throw new Error(`Symbolic inputs changed during verification: ${path}`);
    for (const path of ['launcher', 'jar']) if (hash(report.solver[path]) !== report.solver[`${path}Sha256`]) throw new Error(`Owned Apalache ${path} changed during verification`);
    report.complete = true;
    save();
    return report;
  } catch (error) { report.error = String(error); save(); throw error; }
  finally { try { if (server) await server.stop(); } finally { installation?.cleanup(); } }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await checkSymbolicModels();
