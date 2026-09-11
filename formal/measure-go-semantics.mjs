import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const protocolNames = ['TestProtocolKeys', 'TestProtocolFrames', 'TestProtocolDecoders', 'TestProtocolCohorts', 'TestProtocolRemainingVectors'];
const generatedNames = ['TestCoreConformance', 'TestEffectsConformance', 'TestFeatureConformance', 'TestLocalClockConformance', 'TestGeneratedWitnessEvidence', ...protocolNames];
const fixedNames = ['TestBehaviorConformance', ...protocolNames];
const infrastructureTestFile = /(?:replay|driver|protocol|profile|registry|witness_evidence|integration)_test\.go$/;

// The monitor emits this discriminator only after validating its journal.
// Match explicit rule/event schemas; generic monitor errors remain failures of
// the measurement rather than evidence that a production mutation was caught.
export function causalPropertyAssertion(output) {
  const match = /CAUSAL_PROPERTY_FAILURE rule=(C23|C25|C26) event=(\{[^\r\n]*\})/.exec(output);
  if (!match) return false;
  let event;
  try { event = JSON.parse(match[2]); } catch { return false; }
  const nonnegative = value => Number.isFinite(value) && value >= 0;
  const index = value => Number.isSafeInteger(value) && value >= 0;
  if (!event || !index(event.index) || !index(event.atMs)) return false;
  const condition = `${match[1]}:${event.event}:${event.condition}`;
  switch (condition) {
    case 'C23:fallbackCompletion:duration includes lookup or omits source time':
      return nonnegative(event.elapsedMs) && nonnegative(event.durationMs) && Math.abs(event.durationMs - event.elapsedMs) > 1e-7;
    case 'C23:fallbackCompletion:source lost its full source-relative budget':
      return event.failed === true && nonnegative(event.elapsedMs) && event.budgetMs > 0 && event.elapsedMs < event.budgetMs && ['', 'resolve'].includes(event.settlement);
    case 'C25:fallbackCompletion:success must be accepted before its source deadline':
      return event.failed === false && nonnegative(event.elapsedMs) && event.budgetMs > 0 && ['', 'resolve', 'reject'].includes(event.settlement) && (event.elapsedMs >= event.budgetMs || event.settlement !== 'resolve');
    case 'C26:writeDispatch:publication without accepted source success':
      return event.authorized === false;
    case "C26:writeDispatch:write belongs to a different invocation's source":
      return index(event.source) && index(event.owner) && index(event.sourceOwner) && event.owner !== event.sourceOwner;
    case "C26:writeDispatch:write requires that exact source's successful settlement":
      return index(event.source) && index(event.owner) && ['', 'reject'].includes(event.outcome);
    case 'C25:writeDispatch:late raw settlement cannot authorize publication':
      return index(event.source) && index(event.owner) && index(event.startedAtMs) && index(event.settledAtMs) && event.budgetMs > 0 && event.settledAtMs - event.startedAtMs >= event.budgetMs;
    default: return false;
  }
}

// A compiler error, test crash, deadlock, timeout, skipped test, missing package
// completion, or failing corpus audit is not an assertion-based detection.
export function evaluateGoTestEvents(lines, exitCode) {
  const events = lines.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  if (!events.length) throw new Error('empty Go test event stream');
  const outputs = new Map(), tests = new Map(), packages = [];
  const append = (name, value) => outputs.set(name, (outputs.get(name) ?? '') + value);
  for (const event of events) {
    if (event.Output) append(event.Test ?? '', event.Output);
    if (event.Test && event.Action === 'run') {
      if (tests.has(event.Test)) throw new Error(`duplicate test execution ${event.Test}`);
      tests.set(event.Test, 'running');
    }
    if (event.Test && ['pass', 'fail', 'skip'].includes(event.Action)) {
      if (!tests.has(event.Test) || tests.get(event.Test) !== 'running') throw new Error(`unexpected completion ${event.Test}`);
      tests.set(event.Test, event.Action);
    }
    if (!event.Test && ['pass', 'fail', 'skip'].includes(event.Action)) packages.push(event.Action);
    if (event.Action === 'build-fail') throw new Error('Go package build failed');
  }
  const allOutput = [...outputs.values()].join('\n');
  if (/panic:|fatal error:|runtime error:|test timed out|all goroutines are asleep|DATA RACE|\[build failed\]/i.test(allOutput)) {
    throw new Error('crash, timeout, race, or build error is not mutation detection');
  }
  if (packages.length !== 1 || packages[0] === 'skip' || [...tests.values()].some(state => state === 'skip' || state === 'running')) {
    throw new Error('incomplete or skipped Go test execution');
  }
  const names = [...tests.keys()];
  const leaves = names.filter(name => !names.some(other => other.startsWith(`${name}/`)));
  if (!leaves.length) throw new Error('no executed assertion tests');
  const failedLeaves = leaves.filter(name => tests.get(name) === 'fail');
  const failures = names.filter(name => tests.get(name) === 'fail');
  const assertionKinds = {};
  for (const name of failures) {
    if (!failedLeaves.some(leaf => leaf === name || leaf.startsWith(`${name}/`))) throw new Error(`non-assertion parent failure ${name}`);
    if (name.startsWith('TestGeneratedWitnessEvidence')) throw new Error(`witness audit failure ${name}`);
  }
  for (const name of failedLeaves) {
    const output = outputs.get(name) ?? '';
    if (!/\b[\w-]+_test\.go:\d+:/.test(output)) throw new Error(`failure has no assertion location: ${name}`);
    if (/^Test(?:Core|Effects|Feature|Behavior|LocalClock)Conformance(?:\/|$)/.test(name)) {
      if (/expected:[\s\S]*actual:/.test(output)) assertionKinds[name] = 'observation-mismatch';
      else if (causalPropertyAssertion(output)) assertionKinds[name] = 'causal-property';
      else throw new Error(`replay failure lacks observation or validated causal property evidence: ${name}`);
    } else {
      assertionKinds[name] = 'native-assertion';
    }
  }
  const failed = failedLeaves.length;
  if (exitCode !== (failed ? 1 : 0) || packages[0] !== (failed ? 'fail' : 'pass')) throw new Error('Go exit code and assertion results disagree');
  return { state: failed ? 'detected' : 'survived', passed: leaves.length - failed, failed,
    failingTests: failedLeaves, assertionKinds, assertionEvidence: Object.fromEntries(failedLeaves.map(name => [name, outputs.get(name)])),
    executedTests: leaves };
}

function fingerprint(directory, paths) {
  const files = [];
  const visit = path => {
    for (const entry of readdirSync(resolve(directory, path), { withFileTypes: true })) {
      if (entry.isDirectory()) visit(`${path}/${entry.name}`);
      else if (entry.isFile()) files.push(`${path}/${entry.name}`);
    }
  };
  for (const path of paths) visit(path);
  files.sort();
  const digest = createHash('sha256');
  for (const path of files) digest.update(path).update('\0').update(readFileSync(resolve(directory, path))).update('\0');
  return { files: files.length, sha256: digest.digest('hex') };
}
function union(generated, fixed) {
  return { state: generated.failed + fixed.failed ? 'detected' : 'survived', passed: generated.passed + fixed.passed,
    failed: generated.failed + fixed.failed, failingTests: [...generated.failingTests, ...fixed.failingTests], components: ['generated', 'fixed'] };
}

export function measureGoSemantics() {
  const output = resolve(root, '.formal-traces/go-semantic');
  const started = Date.now();
  mkdirSync(output, { recursive: true });
  // Invalidate old completion before loading catalog, dependencies, or evidence.
  const report = { schemaVersion: 1, complete: false, startedAt: new Date(started).toISOString(), baselines: {}, mutations: [] };
  const save = () => { report.elapsedSeconds = Math.round((Date.now() - started) / 1000); writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n'); };
  save(); rmSync(resolve(output, 'report.md'), { force: true });
  const workspace = mkdtempSync(resolve(tmpdir(), 'dialcache-go-semantic-'));
  const go = process.env.GO_BIN ?? 'go';
  const timeout = 180_000;
  try {
    // Copies preserve repo-relative witness definition paths while mutations
    // remain completely outside the shared checkout. No git resets or writes
    // touch the user's implementation or trace corpus.
    for (const path of ['formal', 'go', 'test', 'src']) cpSync(resolve(root, path), resolve(workspace, path), { recursive: true });
    const moduleDirectory = resolve(workspace, 'go');
    const catalogPath = resolve(workspace, 'formal/go-mutations.json');
    const catalog = json(catalogPath);
    const typescript = json(resolve(workspace, 'formal/semantic-mutations.json'));
    if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.mutations) || catalog.mutations.length < 13) throw new Error('expected versioned Go fault catalog with all 13 TypeScript counterparts');
    const originals = new Map(), ids = new Set();
    for (const mutation of catalog.mutations) {
      if (!/^M\d+$/.test(mutation.id) || ids.has(mutation.id)) throw new Error('invalid/duplicate mutation ID');
      ids.add(mutation.id);
      const counterpart = typescript.mutations.find(item => item.id === mutation.typescriptMutation);
      if (!counterpart || counterpart.case !== mutation.case) throw new Error(`invalid TypeScript counterpart ${mutation.id}`);
      if (!Array.isArray(mutation.edits) || !mutation.edits.length || !mutation.requiredDetections?.every(name => ['ordinary', 'generated', 'fixed', 'portable'].includes(name))) throw new Error(`invalid mutation ${mutation.id}`);
      for (const edit of mutation.edits) {
        if (!/^go\/[\w-]+\.go$/.test(edit.path) || edit.path.endsWith('_test.go') || !edit.before || edit.before === edit.after) throw new Error(`invalid production edit ${mutation.id}`);
        const original = readFileSync(resolve(workspace, edit.path), 'utf8');
        if (original.split(edit.before).length !== 2) throw new Error(`${mutation.id}: anchor must occur exactly once; review source drift in ${edit.path}`);
        originals.set(edit.path, original);
      }
    }
    for (const counterpart of typescript.mutations) if (!catalog.mutations.some(m => m.typescriptMutation === counterpart.id)) throw new Error(`missing TypeScript counterpart ${counterpart.id}`);
    const ordinaryFiles = readdirSync(moduleDirectory).filter(file => file.endsWith('_test.go') && !infrastructureTestFile.test(file)).sort();
    const ordinary = ordinaryFiles.flatMap(file => [...readFileSync(resolve(moduleDirectory, file), 'utf8').matchAll(/^func (Test\w+)\(t \*testing\.T\)/gm)].map(match => match[1]));
    if (!ordinary.length || new Set(ordinary).size !== ordinary.length) throw new Error('invalid ordinary Go test selection');
    const cohorts = { ordinary, generated: generatedNames, fixed: fixedNames };
    const env = { ...process.env };
    const witnessDirectory = resolve(process.env.DIALCACHE_WITNESS_EVIDENCE_DIR ?? resolve(root, '.formal-traces/go-parity-witnesses'));
    for (const name of Object.keys(env)) if (name.startsWith('DIALCACHE_')) delete env[name];
    Object.assign(env, {
      DIALCACHE_MBT_TRACE_DIR: resolve(root, '.formal-traces/conformance'),
      DIALCACHE_EFFECTS_TRACE_DIR: resolve(root, '.formal-traces/effects'),
      DIALCACHE_FEATURE_TRACE_DIR: resolve(root, '.formal-traces/features'),
      DIALCACHE_WITNESS_EVIDENCE_DIR: witnessDirectory,
    });
    report.revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    report.go = spawnSync(go, ['version'], { cwd: moduleDirectory, encoding: 'utf8' }).stdout?.trim();
    report.node = process.version;
    report.catalogSha256 = hash(readFileSync(catalogPath));
    report.inputs = fingerprint(workspace, ['formal', 'go', 'test', 'src']);
    report.corpus = fingerprint(root, ['.formal-traces/conformance', '.formal-traces/effects', '.formal-traces/features', '.formal-traces/regressions']);
    report.witnesses = fingerprint(witnessDirectory, ['.']);
    report.sourceSha256 = Object.fromEntries([...originals].map(([path, text]) => [path, hash(text)]));
    report.selections = cohorts;
    report.ordinaryFiles = ordinaryFiles;
    const compile = label => {
      const result = spawnSync(go, ['test', '-run', '^$', '-count=1', '.'], { cwd: moduleDirectory, env, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
      writeFileSync(resolve(output, `${label}-compile.log`), (result.stdout ?? '') + (result.stderr ?? ''));
      if (result.error || result.signal || result.status !== 0) throw new Error(`${label}: noncompiling mutant/baseline, not detection; see compile log`);
    };
    const run = (label, cohort, baseline) => {
      const result = spawnSync(go, ['test', '-json', '-count=1', '-timeout=150s', '-run', `^(${cohorts[cohort].join('|')})$`, '.'], {
        cwd: moduleDirectory, env: { ...env, DIALCACHE_PROTOCOL_CORPUS: cohort === 'generated' ? 'generated' : 'fixed' }, encoding: 'utf8', timeout, maxBuffer: 128 * 1024 * 1024,
      });
      writeFileSync(resolve(output, `${label}-${cohort}.jsonl`), result.stdout ?? '');
      writeFileSync(resolve(output, `${label}-${cohort}.stderr.log`), result.stderr ?? '');
      if (result.error || result.signal) throw new Error(`${label}/${cohort}: runner infrastructure failed: ${result.error ?? result.signal}`);
      const parsed = evaluateGoTestEvents(result.stdout, result.status);
      if (baseline && parsed.failed) throw new Error(`${cohort}: unmodified baseline must pass; see baseline event log`);
      const currentTop = new Set(parsed.executedTests.map(name => name.split('/')[0]));
      if (cohorts[cohort].some(name => !currentTop.has(name))) throw new Error(`${label}/${cohort}: missing selected test`);
      if (!baseline && parsed.state === 'survived' && JSON.stringify([...parsed.executedTests].sort()) !== JSON.stringify([...report.baselines[cohort].executedTests].sort())) throw new Error(`${label}/${cohort}: incomplete surviving run`);
      writeFileSync(resolve(output, `${label}-${cohort}.json`), JSON.stringify(parsed, null, 2) + '\n');
      return parsed;
    };
    compile('baseline');
    for (const cohort of Object.keys(cohorts)) {
      report.baselines[cohort] = run('baseline', cohort, true);
      console.log(`baseline ${cohort}: ${report.baselines[cohort].passed} passing leaf tests`); save();
    }
    report.baselines.portable = union(report.baselines.generated, report.baselines.fixed);
    for (const mutation of catalog.mutations) {
      const editedPaths = new Set();
      try {
        for (const edit of mutation.edits) {
          const path = resolve(workspace, edit.path), current = readFileSync(path, 'utf8');
          if (current.split(edit.before).length !== 2) throw new Error(`${mutation.id}: overlapping edits`);
          writeFileSync(path, current.replace(edit.before, edit.after)); editedPaths.add(edit.path);
        }
        compile(mutation.id);
        const result = { id: mutation.id, case: mutation.case, description: mutation.description, cohorts: {} };
        for (const cohort of Object.keys(cohorts)) result.cohorts[cohort] = run(mutation.id, cohort, false);
        result.cohorts.portable = union(result.cohorts.generated, result.cohorts.fixed);
        report.mutations.push(result);
        console.log(`${mutation.id}: ${Object.entries(result.cohorts).map(([name, value]) => `${name}=${value.state}(${value.failed})`).join(', ')}`); save();
      } finally { for (const path of editedPaths) writeFileSync(resolve(workspace, path), originals.get(path)); }
    }
    const regressions = catalog.mutations.flatMap(m => m.requiredDetections.filter(cohort => report.mutations.find(result => result.id === m.id).cohorts[cohort].state !== 'detected').map(cohort => `${m.id}/${cohort}`));
    report.detection = Object.fromEntries(['ordinary', 'generated', 'fixed', 'portable'].map(cohort => [cohort, {
      detected: report.mutations.filter(m => m.cohorts[cohort].state === 'detected').length, total: report.mutations.length,
      survivors: report.mutations.filter(m => m.cohorts[cohort].state === 'survived').map(m => m.id),
    }]));
    report.requiredDetectionRegressions = regressions;
    if (regressions.length) throw new Error(`missing required detections: ${regressions.join(', ')}`);
    report.complete = true; save();
    const lines = ['# Go semantic mutation measurement', '', `Completed in ${report.elapsedSeconds}s. Counts measure this named fault catalog and exact corpus, not universal equivalence.`, '',
      '| Mutation | Contract case | Ordinary | Quint generated | Fixed supplement | Full portable |', '| --- | --- | --- | --- | --- | --- |',
      ...report.mutations.map(m => `| ${m.id} | ${m.case} | ${m.cohorts.ordinary.state} | ${m.cohorts.generated.state} | ${m.cohorts.fixed.state} | ${m.cohorts.portable.state} |`), '',
      'Full JSON records snapshot/corpus/witness fingerprints, selected tests, actual passing/failing leaf counts, and assertion diagnostics. Compilation errors, crashes, timeouts, missing witnesses, and skipped executions cannot count as detections.', ''];
    writeFileSync(resolve(output, 'report.md'), lines.join('\n'));
    return report;
  } catch (error) { report.error = String(error); save(); throw error; }
  finally { rmSync(workspace, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { measureGoSemantics(); } catch (error) { console.error(error); process.exitCode = 1; }
}
