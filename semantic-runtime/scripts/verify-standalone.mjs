import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STANDALONE_COPY_PATHS } from './runtime-layout.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(join(tmpdir(), 'semantic-runtime-standalone-'));
const destination = join(temporary, 'component');
try {
  mkdirSync(destination);
  for (const path of STANDALONE_COPY_PATHS) {
    const target = join(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(root, path), target, { recursive: true });
  }
  for (const args of [['ci', '--ignore-scripts', '--no-audit', '--no-fund'], ['run', 'verify']]) {
    const result = spawnSync('npm', args, { cwd: destination, stdio: 'inherit', timeout: 180_000 });
    if (result.status !== 0) throw new Error(`Standalone npm ${args[0]} failed`);
  }
  console.log('Standalone install, dependency boundaries, and tests passed outside the repository.');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
