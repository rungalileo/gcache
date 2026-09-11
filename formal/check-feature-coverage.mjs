import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => {
  if (typeof path !== 'string' || path.startsWith('/') || path.split('/').includes('..')) throw new Error(`Invalid evidence path: ${path}`);
  return readFileSync(root + path, 'utf8');
};
const parse = path => JSON.parse(read(path));

// This gate checks inventory completeness and exact evidence references. It
// cannot decide whether an assertion proves the prose rule; scope notes retain
// that review judgment, and the referenced suites must execute separately.
export function checkFeatureCoverage(inventory = parse('formal/feature-coverage.json'),
  semantic = parse('formal/semantic-cases.json')) {
  if (inventory.schemaVersion !== 1 || !Array.isArray(inventory.features) ||
      !Array.isArray(inventory.nativeCases) || typeof inventory.scope !== 'string') {
    throw new Error('Invalid feature coverage inventory');
  }
  const contractIds = new Set([...read('formal/CONTRACTS.md').matchAll(/^\| ([CWEBX]\d{2}) \|/gm)].map(match => match[1]));
  const semanticIds = new Set(semantic.cases.map(c => c.id));
  const nativeIds = new Set(), featureIds = new Set(), covered = new Set(), coveredNative = new Set(), contracts = new Set();
  const titles = new Map();
  const substantive = value => typeof value === 'string' && value.trim().length >= 20;
  for (const c of inventory.nativeCases) {
    if (!/^[BX]\d{2}\.[a-z0-9-]+$/.test(c.id) || nativeIds.has(c.id) || !substantive(c.rule) || !substantive(c.adaptation)) {
      throw new Error(`Invalid native case: ${c.id}`);
    }
    nativeIds.add(c.id);
    if (!Array.isArray(c.contracts) || !c.contracts.includes(c.id.split('.')[0]) || c.contracts.some(id => !contractIds.has(id))) {
      throw new Error(`${c.id}: missing or unknown native contract`);
    }
    for (const language of ['typescript', 'go']) {
      const evidence = c[language];
      if (!Array.isArray(evidence)) throw new Error(`${c.id}: missing ${language} evidence`);
      if (!evidence.length) {
        if (!substantive(c.notApplicable?.[language])) throw new Error(`${c.id}: missing ${language} evidence or explicit non-applicability`);
        continue;
      }
      if (c.notApplicable?.[language]) throw new Error(`${c.id}: cannot both claim evidence and exclude ${language}`);
      for (const ref of evidence) {
        const source = read(ref.path);
        if (ref.sha256 !== createHash('sha256').update(source).digest('hex')) throw new Error(`${c.id}: stale native evidence ${ref.path}`);
        if (!substantive(ref.scope)) throw new Error(`${c.id}: evidence scope is missing`);
        if (ref.command) {
          if (language !== 'typescript' || ref.command !== 'corepack pnpm test:package' || ref.path !== 'scripts/test-package.mjs') {
            throw new Error(`${c.id}: unknown native validation command`);
          }
          continue;
        }
        if (language === 'go') {
          if (!/^Test[A-Za-z0-9_]+$/.test(ref.test) || !new RegExp(`^func ${ref.test}\\(t \\*testing\\.T\\)`, 'm').test(source)) {
            throw new Error(`${c.id}: unknown Go test ${ref.path}:${ref.test}`);
          }
        } else {
          if (!titles.has(ref.path)) {
            const ast = ts.createSourceFile(ref.path, source, ts.ScriptTarget.Latest, true);
            const found = new Set();
            function visit(node) {
              if (ts.isCallExpression(node) && /^(it|test)(\.|\(|$)/.test(node.expression.getText(ast))) {
                const title = node.arguments[0], body = node.arguments.at(-1);
                if (title && body && (ts.isArrowFunction(body) || ts.isFunctionExpression(body))) {
                  found.add(ts.isStringLiteralLike(title) ? title.text : title.getText(ast));
                }
              }
              ts.forEachChild(node, visit);
            }
            visit(ast); titles.set(ref.path, found);
          }
          if (!titles.get(ref.path).has(ref.test)) throw new Error(`${c.id}: unknown TypeScript test ${ref.path}:${ref.test}`);
        }
      }
    }
  }
  for (const feature of inventory.features) {
    if (!/^[a-z][a-z-]+$/.test(feature.id) || featureIds.has(feature.id) || !substantive(feature.scope)) {
      throw new Error(`Invalid feature: ${feature.id}`);
    }
    featureIds.add(feature.id);
    for (const key of ['contracts', 'cases', 'nativeCases', 'assumptions']) {
      if (!Array.isArray(feature[key]) || new Set(feature[key]).size !== feature[key].length) throw new Error(`${feature.id}: invalid ${key}`);
    }
    if (!feature.cases.length && !feature.nativeCases.length) throw new Error(`${feature.id}: feature has no named cases`);
    for (const id of feature.contracts) {
      if (!contractIds.has(id)) throw new Error(`${feature.id}: unknown contract ${id}`);
      contracts.add(id);
    }
    for (const id of feature.cases) {
      if (!semanticIds.has(id)) throw new Error(`${feature.id}: unknown behavioral/protocol case ${id}`);
      covered.add(id);
    }
    for (const id of feature.nativeCases) {
      if (!nativeIds.has(id)) throw new Error(`${feature.id}: unknown native case ${id}`);
      coveredNative.add(id);
    }
    for (const id of feature.assumptions) {
      if (!/^E\d{2}$/.test(id) || !contractIds.has(id)) throw new Error(`${feature.id}: unknown external assumption ${id}`);
      contracts.add(id);
    }
  }
  const missingCases = [...semanticIds].filter(id => !covered.has(id));
  const missingNative = [...nativeIds].filter(id => !coveredNative.has(id));
  const missingContracts = [...contractIds].filter(id => !contracts.has(id));
  if (missingCases.length) throw new Error(`Cases missing from feature inventory: ${missingCases.join(', ')}`);
  if (missingNative.length) throw new Error(`Native cases missing from feature inventory: ${missingNative.join(', ')}`);
  if (missingContracts.length) throw new Error(`Contracts missing from feature inventory: ${missingContracts.join(', ')}`);
  return { features: featureIds.size, portableCases: semanticIds.size, nativeCases: nativeIds.size,
    meaning: 'Reviewed feature and named-case accounting; exact evidence references are checked, not equivalence or state-space completeness.' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(checkFeatureCoverage(process.argv.includes('--stdin') ? JSON.parse(readFileSync(0, 'utf8')) : undefined), null, 2));
}
