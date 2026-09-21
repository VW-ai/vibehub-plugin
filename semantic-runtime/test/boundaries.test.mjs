import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkBoundaries } from '../scripts/check-boundaries.mjs';

function repository(t, source) {
  const root = mkdtempSync(join(tmpdir(), 'semantic-boundary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  const put = (path, content) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  put('src/core/example.mjs', source);
  return { root, put };
}

test('actual component imports and dependency ownership pass', () => {
  assert.deepEqual(checkBoundaries().errors, []);
});

test('rejects sibling imports, reexports, computed imports and undeclared packages', t => {
  for (const source of [
    "import '../../../skills/vibehub-core/scripts/vh.mjs';",
    "export * from '../../../scripts/helper.mjs';",
    "const target = './x.mjs'; import(target);",
    "import 'undeclared-package';",
    "import fs from 'node:fs';",
    "const mod = require('parent-dependency');",
  ]) {
    const { root } = repository(t, source);
    assert.equal(checkBoundaries(root).ok, false, source);
  }
});

test('rejects core-to-adapter dependencies while ignoring prose and comments', t => {
  const { root, put } = repository(t, "import '../adapters/store.mjs';");
  put('src/adapters/store.mjs', 'export const store = {};');
  assert.match(checkBoundaries(root).errors.join('\n'), /core cannot import/);
  put('src/core/example.mjs', "// import '../../../outside.mjs';\nconst note = \"import 'fake-package'\";");
  assert.equal(checkBoundaries(root).ok, true);
});

test('rejects symlinks and manifest dependencies on parent workspaces', t => {
  const { root } = repository(t, 'export const x = 1;');
  symlinkSync(join(root, 'package.json'), join(root, 'src/core/linked.mjs'));
  assert.match(checkBoundaries(root).errors.join('\n'), /symlinks/);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { sibling: 'file:../plugin' } }));
  assert.match(checkBoundaries(root).errors.join('\n'), /sibling link/);
});
