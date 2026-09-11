import { spawnSync } from 'node:child_process';
import { readExecution, root, validateExecution } from './execution.mjs';

const mode = process.argv[2];
if (process.argv.length !== 3 || !['--write', '--check'].includes(mode)) throw new Error('Usage: node formal/generate-artifacts.mjs --write|--check');
const execution = readExecution(); validateExecution(execution);
for (const generator of [...execution.models.filter(m => m.vectorExport).map(m => m.vectorExport.generator), 'formal/generated-fixtures.mjs']) {
  const result = spawnSync(process.execPath, [generator, mode], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
