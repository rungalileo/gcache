import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkGoReplay, loadGoReplayInventory } from './check-go-replay.mjs';
import { root } from './execution.mjs';
import { readJSON, digest, fingerprint, validateContext, checkCompletion } from './conformance.mjs';

import { nativeBinding } from './conformance-bindings.mjs';
export { nativeBinding } from './conformance-bindings.mjs';

export function parseTypeScriptReport(text, inventory, workspace = root) {
  const report = JSON.parse(text);
  if (report.success !== true || report.numFailedTests !== 0 || report.numPendingTests !== 0 || report.numTodoTests !== 0 ||
      report.numFailedTestSuites !== 0 || report.numPendingTestSuites !== 0 || !Array.isArray(report.testResults) || !report.testResults.length) throw new Error('Incomplete TypeScript run');
  const expected = new Map(inventory.map(entry => [JSON.stringify(nativeBinding(entry, 'typescript', workspace)), entry.id]));
  const seen = new Set(), results = [], files = new Set();
  let assertions = 0, finishedAt = report.startTime;
  for (const suite of report.testResults) {
    if (suite.status !== 'passed' || !Array.isArray(suite.assertionResults) || !suite.assertionResults.length || suite.message ||
        !Number.isFinite(suite.startTime) || !Number.isFinite(suite.endTime) || suite.startTime < report.startTime || suite.endTime < suite.startTime) throw new Error('Incomplete TypeScript suite');
    const file = basename(suite.name);
    if (files.has(file)) throw new Error('Duplicate TypeScript suite');
    files.add(file); finishedAt = Math.max(finishedAt, suite.endTime);
    for (const assertion of suite.assertionResults) {
      assertions++;
      if (assertion.status !== 'passed' || assertion.failureMessages?.length || typeof assertion.title !== 'string' ||
          !Array.isArray(assertion.ancestorTitles) || assertion.fullName !== [...assertion.ancestorTitles, assertion.title].join(' ')) throw new Error('Failed, skipped or malformed TypeScript assertion');
      const key = JSON.stringify([file, assertion.fullName]);
      if (seen.has(key)) throw new Error('Duplicate TypeScript assertion');
      seen.add(key);
      if (expected.has(key)) results.push({ id: expected.get(key), status: 'passed' });
      else if (assertion.title.startsWith('replays ') && assertion.ancestorTitles.some(t => /conformance/.test(t))) throw new Error('Unexpected TypeScript replay history');
    }
  }
  if (assertions !== report.numTotalTests || assertions !== report.numPassedTests || results.length !== expected.size) throw new Error('Missing TypeScript conformance assertions or inconsistent totals');
  return { startedAt: report.startTime, finishedAt, results };
}

export function parseGoReport(text, inventory) {
  const native = loadGoReplayInventory();
  checkGoReplay(text, native);
  const bindings = inventory.map(entry => nativeBinding(entry, 'go'));
  if (new Set(bindings).size !== bindings.length || JSON.stringify([...bindings].sort()) !== JSON.stringify(native.required.map(r => r.name).sort())) throw new Error('Go bindings differ from the shared conformance inventory');
  const events = text.trim().split('\n').map(line => JSON.parse(line));
  const startedAt = Date.parse(events[0].Time), finishedAt = Date.parse(events.at(-1).Time);
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) throw new Error('Go report is missing execution timestamps');
  const passed = new Set(events.filter(event => event.Action === 'pass' && event.Test).map(event => event.Test));
  return { startedAt, finishedAt, results: inventory.map((entry, i) => {
    if (!passed.has(bindings[i])) throw new Error('Go conformance assertion did not pass');
    return { id: entry.id, status: 'passed' };
  }) };
}

export function adaptReport(language, text, context) {
  validateContext(context);
  if (context.language !== language) throw new Error('Wrong port context');
  const parsed = language === 'typescript' ? parseTypeScriptReport(text, context.inventory) : language === 'go'
    ? parseGoReport(text, context.inventory) : (() => { throw new Error('Unsupported native report adapter'); })();
  const report = { schemaVersion: 1, language, runId: context.runId, contextSha256: fingerprint(context),
    ...parsed, status: 'passed', nativeReportSha256: digest(text) };
  checkCompletion(report, context);
  return report;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [language, nativePath, contextPath, ...extra] = process.argv.slice(2);
  if (extra.length || !language || !nativePath || !contextPath) throw new Error('Usage: node formal/conformance-adapters.mjs <typescript|go> <native-report> <context.json>');
  console.log(JSON.stringify(adaptReport(language, readFileSync(resolve(root, nativePath), 'utf8'), readJSON(contextPath)), null, 2));
}
