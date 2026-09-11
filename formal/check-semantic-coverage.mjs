import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkSourceAudit } from './check-source-audit.mjs';
import { checkFeatureCoverage } from './check-feature-coverage.mjs';
import { readExecution, scanDeclarations, scheduledProperties, validateExecution } from './execution.mjs';
import { protocolCorpus, readVectorArtifact } from './vector-artifacts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFileSync(root + path, 'utf8');
const parse = path => JSON.parse(read(path));
const contractIds = [...read('formal/CONTRACTS.md').matchAll(/^\| ([CW]\d{2}) \|/gm)].map(m => m[1]);
const scenarios = new Set(parse('formal/behavioral-scenarios.json').scenarios.map(s => s.name));
const witnesses = parse('formal/coverage-witnesses.json');
const protocol = protocolCorpus();
const invalidation = parse('formal/invalidation-vectors.json').vectors;

export function checkProfiles(registry = parse('formal/profiles.json')) {
  if (registry.schemaVersion !== 1 || registry.specificationVersion !== '0.1.0' || registry.status !== 'experimental') throw new Error('Unsupported specification/profile registry');
  if (registry.behavioralSchemaVersion !== parse('formal/behavioral-scenarios.json').schemaVersion ||
    registry.protocolSchemaVersion !== protocol.schemaVersion || registry.invalidationSchemaVersion !== parse('formal/invalidation-vectors.json').schemaVersion) throw new Error('Profile registry schema versions have drifted');
  const expected = ['admission', 'core', 'effects', 'independent', 'layers', 'local-clock', 'local-failure', 'policy', 'recovery', 'recovery-read', 'runtime-boundaries', 'scope', 'shadow', 'shadow-layers', 'source-budgets'];
  if (!Array.isArray(registry.profiles) || JSON.stringify(registry.profiles.map(p => p.id).sort()) !== JSON.stringify(expected)) throw new Error('Profile inventory changed; review claims');
  read(registry.normativeDefinition);
  if (registry.behavioralAuthority?.kind !== 'quint' || registry.behavioralAuthority.executionManifest !== 'formal/execution.json' || !registry.behavioralAuthority.conflictPolicy) throw new Error('Quint behavioral authority must be explicit');
  for (const profile of registry.profiles) {
    const supportedVersion = ["policy", "shadow"].includes(profile.id) ? 3 : ["effects", "scope", "shadow", "layers", "independent"].includes(profile.id) ? 2 : 1;
    if (profile.version !== supportedVersion) throw new Error(`${profile.id}: unsupported profile version`);
    read(profile.definition); read(profile.model);
    for (const path of profile.witnessSources ?? []) read(path);
    const smoke = parse(profile.smoke);
    if (!Array.isArray(smoke.states) || !smoke.states.length) throw new Error(`${profile.id}: missing smoke evidence`);
    for (const id of profile.historyContracts ?? []) if (!contractIds.includes(id)) throw new Error(`${profile.id}: unknown history contract`);
  }
  for (const implementation of registry.implementations) {
    if (!Array.isArray(implementation.profiles) || implementation.profiles.some(id => !expected.includes(id)) || !implementation.limits) throw new Error('Unsupported implementation claim');
    if (implementation.definition) read(implementation.definition);
  }
  return { specificationVersion: registry.specificationVersion, profiles: expected.length };
}

export function checkQuintCaseAudit(audit = parse('formal/quint-case-audit.json'),
  catalog = parse('formal/semantic-cases.json'), manifest = readExecution()) {
  if (audit.schemaVersion !== 1 || typeof audit.scope !== 'string' || !audit.scope.trim() ||
      !Array.isArray(audit.checks) || !Array.isArray(audit.definitions) ||
      !Array.isArray(audit.limitations) || !audit.limitations.length ||
      audit.limitations.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error('Invalid Quint case applicability audit');
  }
  const cases = new Map(catalog.cases.map(c => [c.id, c]));
  const expected = new Map(manifest.models.flatMap(model => [
    ...model.invariants.map(name => [`${model.path}:${name}`, 'invariant']),
    ...model.regressions.map(name => [`${model.path}:${name}`, 'regression']),
  ]));
  const models = new Set(manifest.models.map(model => model.path));
  const checked = new Set(), defined = new Set(), declarations = new Map();
  for (const [entries, seen, isCheck] of [[audit.checks, checked, true], [audit.definitions, defined, false]]) {
    for (const entry of entries) {
      const c = cases.get(entry.case), key = `${entry.case}/${entry.reference}`;
      if (!c || typeof entry.reference !== 'string' || typeof entry.scope !== 'string' ||
          !entry.scope.trim() || seen.has(key)) throw new Error(`Invalid/duplicate Quint case audit entry: ${key}`);
      seen.add(key);
      if (isCheck) {
        if (!c.models.includes(entry.reference) || expected.get(entry.reference) !== entry.kind) {
          throw new Error(`Quint case audit check is not a cited scheduled ${entry.kind}: ${key}`);
        }
      } else {
        const parts = entry.reference.split(':'), [path, name] = parts;
        if (parts.length !== 2 || !models.has(path)) throw new Error(`Unknown Quint definition model: ${key}`);
        if (!declarations.has(path)) declarations.set(path, scanDeclarations(read(path)));
        const kinds = { transition: 'action', helper: 'def', predicate: 'val' };
        if (!Object.hasOwn(kinds, entry.kind) || declarations.get(path).get(name) !== kinds[entry.kind] ||
            expected.has(entry.reference)) throw new Error(`Quint case definition is not a transition/helper/predicate: ${key}`);
      }
    }
  }
  for (const c of catalog.cases) for (const reference of c.models) {
    if (!checked.has(`${c.id}/${reference}`)) throw new Error(`Missing Quint case applicability scope: ${c.id}/${reference}`);
  }
  return { scopedChecks: checked.size, definitions: defined.size,
    casesWithDefinitions: new Set(audit.definitions.map(entry => entry.case)).size };
}

export function checkSemanticCoverage(catalog = parse('formal/semantic-cases.json')) {
  const profiles = checkProfiles();
  const manifest = readExecution();
  const execution = validateExecution(manifest);
  const scheduled = scheduledProperties(manifest);
  const vectorArtifacts = new Map(manifest.models.filter(model => model.vectorExport)
    .map(model => [model.vectorExport.artifact, { model, value: readVectorArtifact(model) }]));
  const sourceAccounting = checkSourceAudit();
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.cases) || !catalog.cases.length) throw new Error('Invalid semantic case inventory');
  const ids = new Set(), parents = new Set();
  for (const [profile, names] of Object.entries(witnesses)) {
    if (!Array.isArray(names) || !names.length || names.some(n => typeof n !== 'string' || !n) || new Set(names).size !== names.length) throw new Error(`Invalid witness catalog: ${profile}`);
  }
  for (const c of catalog.cases) {
    if (!/^[CW]\d{2}\.[a-z0-9-]+$/.test(c.id) || ids.has(c.id)) throw new Error(`Invalid/duplicate case: ${c.id}`);
    ids.add(c.id);
    if (!Array.isArray(c.contracts) || !c.contracts.includes(c.id.split('.')[0]) || c.contracts.some(id => !contractIds.includes(id))) throw new Error(`${c.id}: unknown/missing contract`);
    c.contracts.forEach(id => parents.add(id));
    if (typeof c.rule !== 'string' || c.rule.length < 10) throw new Error(`${c.id}: missing rule`);
    for (const key of ['scenarios', 'generated', 'models', 'vectors']) if (!Array.isArray(c[key])) throw new Error(`${c.id}: missing evidence list ${key}`);
    for (const name of c.scenarios) if (!scenarios.has(name)) throw new Error(`${c.id}: unknown scenario ${name}`);
    for (const g of c.generated) if (!witnesses[g.profile]?.includes(g.witness)) throw new Error(`${c.id}: unknown required witness ${g.profile}/${g.witness}`);
    for (const model of c.models) {
      if (!scheduled.has(model)) throw new Error(`${c.id}: model property is not scheduled for execution: ${model}`);
    }
    if (c.quintReplays !== undefined) {
      if (!Array.isArray(c.quintReplays) || new Set(c.quintReplays).size !== c.quintReplays.length) throw new Error(`${c.id}: invalid Quint regression replay inventory`);
      for (const reference of c.quintReplays) {
        const parts = typeof reference === 'string' ? reference.split('/') : [];
        const model = manifest.models.find(model => model.profile === parts[0]);
        if (parts.length !== 2 || !model?.replayRegressions?.includes(parts[1]) ||
            !c.models.includes(`${model.path}:${parts[1]}`)) throw new Error(`${c.id}: Quint replay needs a cited scheduled exported regression: ${reference}`);
      }
    }
    if (c.generatedVectors !== undefined) {
      if (!Array.isArray(c.generatedVectors) || !c.generatedVectors.length) throw new Error(`${c.id}: invalid generated vector references`);
      const references = new Set();
      for (const reference of c.generatedVectors) {
        const source = vectorArtifacts.get(reference.artifact);
        const group = reference.group ?? 'vectors';
        const rows = source?.value[group];
        const key = `${reference.artifact}/${group}/${reference.name}`;
        if (!source || !Array.isArray(rows) || !rows.length || references.has(key)
          || (reference.name !== '*' && !rows.some(row => row.name === reference.name))
          || !c.models.some(ref => ref.startsWith(`${source.model.path}:`))) throw new Error(`${c.id}: generated vector needs a cited model and exported case: ${key}`);
        references.add(key);
      }
    }
    for (const vector of c.vectors) {
      const parts = vector.split('/');
      const entries = parts[0] === 'protocol' ? protocol[parts[1]] : parts[0] === 'invalidation' ? invalidation : undefined;
      const name = parts[0] === 'protocol' ? parts.slice(2).join('/') : parts.slice(1).join('/');
      if (!Array.isArray(entries) || !entries.length || (name !== '*' && !entries.some(v => v.name === name))) throw new Error(`${c.id}: unknown vector ${vector}`);
    }
    // A fixed native example cannot replace the agreed portable authority.
    // Native-only details belong in the explicit binding boundary inventory.
    if (!c.models.length) throw new Error(`${c.id}: portable case requires a scheduled Quint check`);
    if (!c.generated.length && !c.quintReplays?.length && !c.generatedVectors?.length) {
      throw new Error(`${c.id}: portable case requires Quint-driven implementation replay`);
    }
  }
  if (contractIds.some(id => !parents.has(id))) throw new Error('Portable contract missing from case inventory');
  // A passing scenario is useful evidence only when its obligation is named.
  // Keep this independent of the per-case reference checks: valid references
  // alone allow an entire scenario (or vector) to disappear from the inventory.
  const namedScenarios = new Set(catalog.cases.flatMap(c => c.scenarios));
  const unassignedScenarios = [...scenarios].filter(name => !namedScenarios.has(name));
  if (unassignedScenarios.length) throw new Error(`Portable scenarios missing from case inventory: ${unassignedScenarios.join('; ')}`);
  const namedVectors = new Set(catalog.cases.flatMap(c => c.vectors));
  for (const [group, entries] of Object.entries(protocol)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!namedVectors.has(`protocol/${group}/*`) && !namedVectors.has(`protocol/${group}/${entry.name}`)) {
        throw new Error(`Protocol vector missing from case inventory: ${group}/${entry.name}`);
      }
    }
  }
  for (const entry of invalidation) {
    if (!namedVectors.has('invalidation/*') && !namedVectors.has(`invalidation/${entry.name}`)) {
      throw new Error(`Invalidation vector missing from case inventory: ${entry.name}`);
    }
  }
  for (const [artifact, { value }] of vectorArtifacts) {
    for (const [group, rows] of Object.entries(value).filter(([, value]) => Array.isArray(value))) {
      for (const row of rows) {
        if (!catalog.cases.some(c => c.generatedVectors?.some(ref => ref.artifact === artifact
          && (ref.group ?? 'vectors') === group && (ref.name === '*' || ref.name === row.name)))) {
          throw new Error(`Quint vector missing from case inventory: ${artifact}/${group}/${row.name}`);
        }
      }
    }
  }
  const applicability = checkQuintCaseAudit(undefined, catalog, manifest);
  const featureCoverage = checkFeatureCoverage(undefined, catalog);
  const mutations = parse('formal/semantic-mutations.json');
  if (mutations.schemaVersion !== 1 || !Array.isArray(mutations.mutations) || !mutations.mutations.length) throw new Error('Invalid mutation catalog');
  const mutationIds = new Set();
  for (const m of mutations.mutations) {
    if (!/^M\d+$/.test(m.id) || mutationIds.has(m.id) || !ids.has(m.case)) throw new Error(`Invalid mutation case/ID: ${m.id}`);
    mutationIds.add(m.id);
    if (!Array.isArray(m.requiredDetections) || m.requiredDetections.some(c => !['ordinary', 'generated', 'portable'].includes(c))) throw new Error(`${m.id}: unknown mutation cohort`);
  }
  const behavioral = catalog.cases.filter(c => !c.vectors.length);
  const portable = c => c.scenarios.length || c.generated.length || c.vectors.length || c.quintReplays?.length || c.generatedVectors?.length;
  const count = cases => ({ total: cases.length, model: cases.filter(c => c.models.length).length,
    portable: cases.filter(portable).length, generated: cases.filter(c => c.generated.length).length,
    quintRegressionReplay: cases.filter(c => c.quintReplays?.length).length,
    quintVectorReplay: cases.filter(c => c.generatedVectors?.length).length,
    quintDriven: cases.filter(c => c.generated.length || c.quintReplays?.length || c.generatedVectors?.length).length,
    modelOnly: cases.filter(c => c.models.length && !portable(c)).map(c => c.id),
    uncovered: cases.filter(c => !c.models.length && !portable(c)).map(c => c.id) });
  return { profiles, execution, sourceAccounting, applicability, featureCoverage, contracts: parents.size, cases: count(catalog.cases), behavioral: count(behavioral),
    protocol: count(catalog.cases.filter(c => c.vectors.length)), mutations: mutations.mutations.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(process.argv.includes('--profiles-stdin')
    ? checkProfiles(JSON.parse(readFileSync(0, 'utf8')))
    : process.argv.includes('--audit-stdin') ? checkQuintCaseAudit(JSON.parse(readFileSync(0, 'utf8')))
    : checkSemanticCoverage(process.argv.includes('--stdin') ? JSON.parse(readFileSync(0, 'utf8')) : undefined), null, 2));
}
