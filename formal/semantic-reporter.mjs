import { writeFileSync } from 'node:fs';

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
