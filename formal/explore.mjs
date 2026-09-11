import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cleanEnvironment, executeSteps, validationPlan } from './validation.mjs';
import { nativeBinding } from './conformance-bindings.mjs';
import { parseTypeScriptReport } from './conformance-adapters.mjs';
import { checkGoReplay } from './check-go-replay.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const inside = (directory, path) => path.startsWith(directory + sep);
const reportPaths = { typescript: '.formal-traces/ts-replay.json', go: '.formal-traces/go-replay.jsonl' };
const contextPaths = { typescript: '.formal-traces/ts-context.json', go: '.formal-traces/go-context.json' };

export function explorationSeed(value = `0x${randomBytes(8).toString('hex')}`) {
  if (typeof value !== 'string' || !/^(0x[\da-fA-F]{1,16}|\d{1,20})$/.test(value)
    || BigInt(value) > 0xffffffffffffffffn) throw new Error('Exploration seed must be an unsigned 64-bit integer.');
  return `0x${BigInt(value).toString(16)}`;
}

// Share model generation and native execution with acceptance. Exploration has
// its own report: a seed's missing witness must not prevent the other port from
// executing the histories. No acceptance completion/adaptation step runs here.
export function explorationPlan(directory, seed, options = {}) {
  const normalized = explorationSeed(seed);
  return validationPlan('formal', { ...options, directory }).flatMap(step => {
    const script = step.args?.[0];
    if (step.remove || ['formal/conformance-adapters.mjs', 'formal/check-go-replay.mjs'].includes(script)
      || script === 'formal/conformance.mjs' && step.args[1] === 'check') return [];
    if (script === 'formal/conformance.mjs' && step.args[1] === 'prepare') {
      return [{ label: `Prepare exploratory ${step.args[2]} context`, explorationContext: step.args[2] }];
    }
    if (script === 'formal/run-models.mjs') return [{ ...step, env: { ...step.env, QUINT_SEED: normalized } }];
    if (step.env?.DIALCACHE_MBT_TRACE_DIR) return [{ ...step, nativeReport: step.command === 'go' ? 'go' : 'typescript' }];
    return [step];
  });
}

export function snapshotSources(directory, destination, paths) {
  const sourceRoot = realpathSync(directory);
  mkdirSync(destination, { recursive: true });
  const targetRoot = realpathSync(destination), fingerprints = {};
  for (const path of [...new Set(paths)].sort()) {
    if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\')
      || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Invalid exploration source path: ${path}`);
    if (['.git', 'node_modules', '.formal-traces'].some(name => path === name || path.startsWith(name + '/'))) {
      throw new Error(`Generated/runtime inputs cannot enter the source snapshot: ${path}`);
    }
    let source = sourceRoot, missing = false;
    for (const part of path.split('/')) {
      source = resolve(source, part);
      let info;
      try { info = lstatSync(source); } catch (error) { if (error.code === 'ENOENT') { missing = true; break; } throw error; }
      // Reject even internal links: copying a link's target would change the
      // declared source inventory, and a dangling link is not a tracked deletion.
      if (info.isSymbolicLink()) throw new Error(`Symbolic link in exploration source: ${path}`);
    }
    if (missing) continue;
    if (!lstatSync(source).isFile()) throw new Error(`Exploration source is not a regular file: ${path}`);
    const target = resolve(targetRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    if (!inside(targetRoot, realpathSync(dirname(target))) && dirname(target) !== targetRoot) throw new Error('Exploration target leaves its snapshot.');
    copyFileSync(source, target, constants.COPYFILE_EXCL);
    fingerprints[path] = hash(readFileSync(target));
  }
  return fingerprints;
}

function verifyHashes(directory, groups) {
  for (const files of groups) for (const [path, expected] of Object.entries(files)) {
    const absolute = resolve(directory, path);
    if (!inside(realpathSync(directory), realpathSync(absolute)) || !lstatSync(absolute).isFile()
      || hash(readFileSync(absolute)) !== expected) throw new Error(`Exploration input changed: ${path}`);
  }
}

async function prepareExplorationContext(language, directory) {
  // Import from the snapshot so its own manifest, corpus and source inventory
  // define the context. A missing TS witness file is recorded as absent; it must
  // not prevent Go from executing that profile's histories.
  const { prepareContext, defaultSources } = await import(pathToFileURL(resolve(directory, 'formal/conformance.mjs')).href);
  const sources = defaultSources(language).filter(path => !path.startsWith('.formal-traces/go-parity-witnesses/') || existsSync(resolve(directory, path)));
  const context = { ...prepareContext(language, sources), kind: 'exploration' };
  writeFileSync(resolve(directory, contextPaths[language]), JSON.stringify(context, null, 2) + '\n');
  return context;
}

// Validate the original native report before assigning failure categories. The
// all-passed copy exists only in memory to reuse strict inventory/lifecycle
// validators; original statuses remain authoritative and are always retained.
export function nativeExplorationResult(language, text, context, directory, packageName) {
  if (context.kind !== 'exploration' || context.language !== language) throw new Error('Wrong exploratory native context.');
  const inventory = context.inventory, failed = [], otherFailures = [];
  let startedAt, finishedAt;
  if (language === 'typescript') {
    const original = JSON.parse(text), sanitized = structuredClone(original);
    if (!Array.isArray(original.testResults) || !original.testResults.length) throw new Error('Missing TypeScript native suites.');
    let passed = 0, failures = 0;
    const suites = new Set(), failedSuites = new Set();
    const cases = new Map(inventory.map(entry => [JSON.stringify(nativeBinding(entry, language, directory)), entry]));
    for (const [index, suite] of original.testResults.entries()) {
      if (!Array.isArray(suite.assertionResults) || !suite.assertionResults.length || !['passed', 'failed'].includes(suite.status)) throw new Error('Incomplete TypeScript suite.');
      let suiteFailures = 0;
      for (const [assertionIndex, assertion] of suite.assertionResults.entries()) {
        if (!['passed', 'failed'].includes(assertion.status)) throw new Error('Skipped or unfinished TypeScript assertion.');
        const key = JSON.stringify([suite.name.split(/[\\/]/).at(-1), assertion.fullName]);
        if (!Array.isArray(assertion.ancestorTitles)) throw new Error('Missing TypeScript suite hierarchy.');
        const parents = Array.from({ length: assertion.ancestorTitles.length + 1 }, (_, depth) =>
          JSON.stringify([suite.name, ...assertion.ancestorTitles.slice(0, depth)]));
        for (const parent of parents) suites.add(parent);
        if (assertion.status === 'failed') {
          if (!Array.isArray(assertion.failureMessages) || !assertion.failureMessages.length) throw new Error('Failed TypeScript assertion lacks evidence.');
          failures++; suiteFailures++;
          for (const parent of parents) failedSuites.add(parent);
          const entry = cases.get(key);
          if (entry) failed.push(entry); else otherFailures.push(assertion.fullName);
        } else {
          if (assertion.failureMessages?.length) throw new Error('Passed assertion contains errors.');
          passed++;
        }
        sanitized.testResults[index].assertionResults[assertionIndex] = { ...assertion, status: 'passed', failureMessages: [] };
      }
      if ((suite.status === 'failed') !== (suiteFailures > 0) || suite.message && !suiteFailures) throw new Error('TypeScript collection/runtime failure.');
      sanitized.testResults[index].status = 'passed';
      sanitized.testResults[index].message = '';
    }
    if (original.numPassedTests !== passed || original.numFailedTests !== failures || original.numTotalTests !== passed + failures
      || original.numTotalTestSuites !== suites.size || original.numFailedTestSuites !== failedSuites.size
      || original.numPassedTestSuites !== suites.size - failedSuites.size || original.success !== (failures === 0)) throw new Error('Inconsistent TypeScript native totals.');
    Object.assign(sanitized, { success: true, numFailedTests: 0, numFailedTestSuites: 0, numPassedTests: passed + failures });
    ({ startedAt, finishedAt } = parseTypeScriptReport(JSON.stringify(sanitized), inventory, directory));
  } else if (language === 'go') {
    const events = text.trim().split('\n').map(line => JSON.parse(line));
    const cases = new Map(inventory.map(entry => [nativeBinding(entry, language), entry]));
    const failedTests = events.filter(event => event.Action === 'fail' && event.Test).map(event => event.Test);
    for (const name of failedTests) {
      if (failedTests.some(other => other.startsWith(name + '/'))) continue; // Ancestor failure propagates a leaf's failure.
      const entry = cases.get(name);
      if (entry) failed.push(entry); else otherFailures.push(name);
    }
    if (events.some(event => event.Action === 'fail' && !event.Test) && !failedTests.length) throw new Error('Go package failed without a completed failing test.');
    if ((events.at(-1).Action === 'fail') !== (failedTests.length > 0)) throw new Error('Go package status disagrees with completed tests.');
    const profiles = Object.fromEntries(inventory.filter(entry => entry.category === 'sampled').map(entry => [entry.profile, 0]));
    for (const entry of inventory.filter(entry => entry.category === 'sampled')) profiles[entry.profile]++;
    const native = { packageName, profiles, witnessProfiles: inventory.filter(entry => entry.category === 'witness').map(entry => entry.profile),
      required: inventory.map(entry => ({ name: nativeBinding(entry, language), category: entry.category })) };
    checkGoReplay(events.map(event => JSON.stringify(event.Action === 'fail' ? { ...event, Action: 'pass' } : event)).join('\n'), native);
    startedAt = Date.parse(events[0].Time); finishedAt = Date.parse(events.at(-1).Time);
  } else throw new Error('Unsupported exploratory port.');
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || startedAt < context.createdAt
    || finishedAt < startedAt || finishedAt > Date.now() + 60_000) throw new Error('Stale or invalid native report timestamps.');
  const witnessFailures = failed.filter(entry => entry.category === 'witness').map(entry => entry.id);
  const caseFailures = failed.filter(entry => entry.category !== 'witness').map(entry => entry.id);
  // A witness leaf can fail because reachability is missing OR its evidence is
  // invalid/unreadable. Preserve the raw error; neither alone is a native
  // behavioral counterexample, and neither should prevent the other replay.
  return { language, status: otherFailures.length ? 'infrastructure-failure' : caseFailures.length ? 'native-failure'
    : witnessFailures.length ? 'witness-check-failure' : 'passed', startedAt, finishedAt,
    cases: inventory.length, contextSha256: hash(JSON.stringify(context)), nativeReportSha256: hash(text), witnessFailures, caseFailures, otherFailures };
}

export async function runExplorationSteps(plan, { directory, environment = process.env, execute = executeSteps, onResult = () => {} } = {}) {
  const results = [];
  for (const step of plan) {
    if (step.explorationContext) { await prepareExplorationContext(step.explorationContext, directory); continue; }
    if (!step.nativeReport) { await execute([step], { directory, environment }); continue; }
    const language = step.nativeReport, path = resolve(directory, reportPaths[language]);
    const contextPath = resolve(directory, contextPaths[language]);
    const contextText = readFileSync(contextPath, 'utf8'), context = JSON.parse(contextText);
    rmSync(path, { force: true }); // A crashed command cannot inherit an earlier report.
    let commandError;
    try { await execute([step], { directory, environment }); } catch (error) { commandError = String(error); }
    if (readFileSync(contextPath, 'utf8') !== contextText) throw new Error('Prepared exploration context changed during native execution.');
    const packageName = /^module\s+(\S+)\s*$/m.exec(readFileSync(resolve(directory, 'go/go.mod'), 'utf8'))?.[1];
    let result;
    try { result = nativeExplorationResult(language, readFileSync(path, 'utf8'), context, directory, packageName); }
    catch (cause) { throw new Error(`Invalid or missing ${language} native assertion report${commandError ? ` after ${commandError}` : ''}: ${cause}`, { cause }); }
    if (Boolean(commandError) !== (result.status !== 'passed')) throw new Error(`Native ${language} command status disagrees with its assertion report.`);
    verifyHashes(directory, [context.specification, context.implementation, context.corpus]);
    results.push({ ...result, ...(commandError ? { commandError } : {}) }); onResult(results);
    if (result.status === 'infrastructure-failure') throw new Error(`Exploratory ${language} infrastructure checks failed.`);
  }
  return results;
}

function savedExploration(path) {
  const reportPath = realpathSync(path), text = readFileSync(reportPath, 'utf8');
  const report = JSON.parse(text);
  if (report.schemaVersion !== 1 || report.kind !== 'exploration' || report.acceptance !== false
    || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(report.baseRevision ?? '')
    || !Number.isFinite(Date.parse(report.finishedAt))
    || !['passed', 'native-failure', 'witness-check-failure', 'infrastructure-failure'].includes(report.status)
    || !report.sources || Array.isArray(report.sources) || !Object.keys(report.sources).length
    || Object.values(report.sources).some(value => typeof value !== 'string' || !/^[a-f\d]{64}$/.test(value))) {
    throw new Error('Expected a finished exploratory report with a source inventory and base revision.');
  }
  const seed = explorationSeed(report.seed);
  if (seed !== report.seed) throw new Error('Saved exploration seed is missing or not canonical.');
  const workspace = resolve(dirname(reportPath), 'workspace');
  verifyHashes(workspace, [report.sources]);
  return { reportPath, reportSha256: hash(text), seed, baseRevision: report.baseRevision,
    workspace, sources: report.sources };
}

function linkDependencies(directory, workspace, sources, replay) {
  if (replay) for (const path of ['package.json', 'pnpm-lock.yaml']) {
    if (!Object.hasOwn(sources, path) || hash(readFileSync(resolve(directory, path))) !== sources[path]) {
      throw new Error(`Saved ${path} differs from the current dependency runtime; replay requires matching package and lockfile bytes.`);
    }
  }
  symlinkSync(resolve(directory, 'node_modules'), resolve(workspace, 'node_modules'), 'dir');
}

export async function explore(seed, options = {}) {
  return executeExploration(explorationSeed(seed), options);
}

export async function replayExploration(path, options = {}) {
  const origin = savedExploration(path);
  return executeExploration(origin.seed, { ...options, origin });
}

async function executeExploration(seed, { directory = root, environment = process.env, run, origin } = {}) {
  const selectedSeed = explorationSeed(seed);
  const parent = resolve(directory, '.formal-traces/exploration');
  mkdirSync(parent, { recursive: true });
  const output = mkdtempSync(resolve(parent, `${selectedSeed}-`)), workspace = resolve(output, 'workspace');
  const report = { schemaVersion: 1, kind: 'exploration', acceptance: false, seed: selectedSeed,
    status: 'running', startedAt: new Date().toISOString(), sources: {}, native: [],
    ...(origin ? { replayOrigin: { path: origin.reportPath, reportSha256: origin.reportSha256,
      baseRevision: origin.baseRevision, sourcesSha256: hash(JSON.stringify(origin.sources)) } } : {}) };
  const save = () => writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  save();
  let dependencyLink = false;
  try {
    if (origin) {
      // No Git discovery: a saved workspace has its own declared bytes and may
      // no longer belong to the original checkout. Copying also rejects links.
      report.baseRevision = origin.baseRevision;
      report.sources = snapshotSources(origin.workspace, workspace, Object.keys(origin.sources));
      if (Object.keys(report.sources).length !== Object.keys(origin.sources).length) throw new Error('Saved exploration source was deleted while copying.');
      verifyHashes(workspace, [origin.sources]);
      if (hash(readFileSync(origin.reportPath)) !== origin.reportSha256) throw new Error('Saved exploration report changed while copying.');
    } else {
      const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      report.baseRevision = git(['rev-parse', 'HEAD']).trim();
      const paths = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
      report.sources = snapshotSources(directory, workspace, paths);
    }
    save();
    linkDependencies(directory, workspace, report.sources, Boolean(origin)); dependencyLink = true;
    console.log(`Exploratory seed ${selectedSeed}; sources and native evidence: ${output}`);
    const quotedReport = `'${resolve(output, 'report.json').replaceAll("'", "'\\''")}'`;
    console.log(`Reproduce saved source bytes: node formal/explore.mjs --replay ${quotedReport}`);
    // Load the copied runner, plan and prerequisite checks. A newer checkout's
    // behavior must not silently replace the implementation being reproduced.
    const snapshot = run ? { explorationPlan, runExplorationSteps: run }
      : await import(pathToFileURL(resolve(workspace, 'formal/explore.mjs')).href);
    if (!run) {
      const validation = await import(pathToFileURL(resolve(workspace, 'formal/validation.mjs')).href);
      validation.checkPrerequisites('explore', { directory: workspace, environment: cleanEnvironment(environment) });
    }
    report.native = await snapshot.runExplorationSteps(snapshot.explorationPlan(workspace, selectedSeed, { environment }), {
      directory: workspace, environment: cleanEnvironment(environment), onResult: results => { report.native = results; save(); },
    });
    verifyHashes(workspace, [report.sources]);
    report.sourcesUnchanged = true;
    if (report.native.map(result => result.language).sort().join() !== 'go,typescript'
      || report.native.some(result => !['passed', 'native-failure', 'witness-check-failure'].includes(result.status))) {
      throw new Error('Exploration did not finish both native ports.');
    }
    report.status = report.native.some(result => result.status === 'native-failure') ? 'native-failure'
      : report.native.some(result => result.status === 'witness-check-failure') ? 'witness-check-failure' : 'passed';
    if (report.status !== 'passed') throw new Error(`Exploration finished with ${report.status}; inspect both native reports.`);
  } catch (error) {
    if (report.status === 'running') report.status = 'infrastructure-failure';
    report.error = String(error); throw error;
  } finally {
    // Unlink only the known runtime link. Initialization errors also receive a
    // finished report and cannot leave a permanently "running" artifact.
    let cleanupError;
    try { if (dependencyLink) unlinkSync(resolve(workspace, 'node_modules')); }
    catch (error) { cleanupError = error; report.status = 'infrastructure-failure'; report.cleanupError = String(error); }
    report.finishedAt = new Date().toISOString(); save();
    if (cleanupError) throw cleanupError;
  }
  return output;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || !['--seed', '--replay'].includes(args[0]))) {
    throw new Error('Usage: node formal/explore.mjs [--seed <uint64> | --replay <saved-report.json>]');
  }
  if (args[0] === '--replay') await replayExploration(args[1]);
  else await explore(args[1]);
}
