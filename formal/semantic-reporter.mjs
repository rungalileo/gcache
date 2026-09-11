import { writeFileSync } from 'node:fs';

// A successful process alone is insufficient: an unmatched selector or an
// entirely skipped cohort can exit successfully without executing assertions.
export function evaluateSemanticTestReport(data, execution, exitCode, label = 'cohort') {
  const assertions = data.testResults.flatMap(file => file.assertionResults);
  const failed = assertions.filter(test => test.status === 'failed');
  const passed = assertions.filter(test => test.status === 'passed').length;
  const timedOut = failed.some(test => test.failureMessages.some(message => /(?:Test|Hook) timed out in/.test(message)));
  if (execution.reason !== (failed.length ? 'failed' : 'passed') || execution.collectionErrors.length || execution.unhandledErrors.length || passed + failed.length === 0 ||
      timedOut ||
      (exitCode !== 0 && failed.length === 0) || (exitCode === 0 && failed.length > 0)) {
    throw new Error(`${label}: infrastructure/import error, not evidence of detection (exit=${exitCode}, passed=${passed}, failed=${failed.length})`);
  }
  return { state: failed.length ? 'detected' : 'survived', passed, failed: failed.length,
    failingTests: failed.map(test => test.fullName) };
}

// Vitest's JSON reporter omits unhandled and suite-collection errors. Preserve
// these separately so an infrastructure failure cannot count as a detection.
export default class SemanticReporter {
  onTestRunEnd(modules, unhandledErrors, reason) {
    const collectionErrors = modules.flatMap(module => [module, ...module.children.allSuites()])
      .flatMap(suite => suite.errors()).map(error => error.message);
    writeFileSync(process.env.DIALCACHE_SEMANTIC_RUN_META, JSON.stringify({ reason,
      unhandledErrors: unhandledErrors.map(error => error.message), collectionErrors }) + '\n');
  }
}
