import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path, directory = root) => readFileSync(resolve(directory, path), 'utf8');
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// Headings inside fenced examples are not documentation sections. A shorter
// marker or a marker followed by text cannot close the surrounding code fence.
function markdownHeadings(text) {
  const entries = [];
  let fence;
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    if (fence) {
      const close = /^ {0,3}(`+|~+)[ \t]*$/.exec(line)?.[1];
      if (close?.[0] === fence.marker && close.length >= fence.length) fence = undefined;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = { marker: open[1][0], length: open[1].length };
      continue;
    }
    const heading = /^ {0,3}#{1,6}[ \t]+(.*)$/.exec(line);
    if (heading) entries.push({ line: i + 1, title: heading[1] });
  }
  return entries;
}

function snapshot(paths, directory) {
  return paths.sort().map(path => {
    const text = read(path, directory);
    let entries = [];
    if (path.endsWith('.ts')) {
      const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
      function visit(node) {
        if (ts.isCallExpression(node) && /^(it|test)(\.|\(|$)/.test(node.expression.getText(ast))) {
          const title = node.arguments[0];
          const body = node.arguments.at(-1);
          if (title && body && (ts.isArrowFunction(body) || ts.isFunctionExpression(body))) {
            entries.push({ line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
              title: ts.isStringLiteralLike(title) ? title.text : title.getText(ast) });
            return;
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(ast);
      if (entries.length === 0) throw new Error(`No recognized test declarations: ${path}`);
    } else entries = markdownHeadings(text);
    return { path, sha256: createHash('sha256').update(text).digest('hex'), entries };
  });
}

export function sourceSnapshot(directory = root) {
  const paths = ['README.md', ...readdirSync(resolve(directory, 'docs')).filter(p => p.endsWith('.md')).map(p => 'docs/' + p),
    ...readdirSync(resolve(directory, 'test')).filter(p => p.endsWith('.test.ts') && !p.startsWith('formal-')).map(p => 'test/' + p)];
  return snapshot(paths, directory);
}

export function guideSnapshot(directory = root) {
  const paths = [...readdirSync(resolve(directory, 'formal')).filter(p => p.endsWith('.md')).map(p => 'formal/' + p), 'go/README.md'];
  return snapshot(paths, directory);
}

export function checkSourceAudit(audit, { directory = root } = {}) {
  if (audit === undefined) audit = JSON.parse(read('formal/source-audit.json', directory));
  if (audit?.schemaVersion !== 1) throw new Error('Unsupported formal source audit version');
  const actual = sourceSnapshot(directory), guides = guideSnapshot(directory);
  const ids = new Set([...read('formal/CONTRACTS.md', directory).matchAll(/^\| ([CWEBX]\d{2}) \|/gm)].map(m => m[1]));
  const failures = [];
  const sources = Array.isArray(audit.sources) ? audit.sources : [];
  const reviewedGuides = Array.isArray(audit.reviewedGuides) ? audit.reviewedGuides : [];
  if (!equal(actual.map(s => s.path), sources.map(s => s?.path))) failures.push('Source file inventory changed');
  if (!Array.isArray(audit.reviewedGuides) || !equal(guides.map(s => s.path), reviewedGuides.map(s => s?.path))) failures.push('Reviewed guide file inventory changed');
  const validContracts = contracts => Array.isArray(contracts) && new Set(contracts).size === contracts.length && contracts.every(id => ids.has(id));
  const compareSnapshot = (source, saved, label) => {
    if (saved.sha256 !== source.sha256) failures.push(`${source.path}: contents changed; review assertions/prose and refresh its audit`);
    if (!Array.isArray(saved.entries) || !equal(saved.entries.map(entry => ({ line: entry?.line, title: entry?.title })), source.entries)) failures.push(`${source.path}: ${label} inventory changed`);
  };
  for (const source of actual) {
    const saved = sources.find(s => s?.path === source.path);
    if (!saved) continue;
    compareSnapshot(source, saved, 'test/section');
    for (const entry of Array.isArray(saved.entries) ? saved.entries : []) {
      if (!validContracts(entry?.contracts) || entry.contracts.length === 0) failures.push(`${source.path}:${entry?.line}: missing, duplicate or unknown contract disposition`);
    }
  }
  const kinds = new Set(['contract-guide', 'tooling-guide', 'coverage-guide', 'historical-evidence']);
  for (const source of guides) {
    const saved = reviewedGuides.find(s => s?.path === source.path);
    if (!saved) continue;
    compareSnapshot(source, saved, 'guide section');
    const review = saved.review;
    if (!review || !kinds.has(review.kind)) failures.push(`${source.path}: missing or invalid guide review kind`);
    if (typeof review?.scope !== 'string' || !review.scope.trim()) failures.push(`${source.path}: missing reviewed guide scope`);
    if (review?.contracts !== undefined && !validContracts(review.contracts) || review?.kind === 'contract-guide' && (!validContracts(review.contracts) || review.contracts.length === 0)) failures.push(`${source.path}: missing, duplicate or unknown guide contract IDs`);
    const revisions = review?.revisions;
    const validRevisions = Array.isArray(revisions) && revisions.every(revision => typeof revision === 'string' && /^[a-f\d]{40}$/i.test(revision)) && new Set(revisions.map(revision => revision.toLowerCase())).size === revisions.length;
    if (revisions !== undefined && !validRevisions || review?.kind === 'historical-evidence' && (!validRevisions || revisions.length === 0)) failures.push(`${source.path}: missing, duplicate or invalid historical revision identity`);
  }
  if (failures.length) throw new Error(failures.join('\n'));
  return { sources: actual.length, tests: actual.filter(s => s.path.endsWith('.ts')).reduce((n, s) => n + s.entries.length, 0),
    sections: actual.filter(s => s.path.endsWith('.md')).reduce((n, s) => n + s.entries.length, 0),
    reviewedGuides: guides.length, guideSections: guides.reduce((n, s) => n + s.entries.length, 0) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(checkSourceAudit());
