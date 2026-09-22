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
  const result = checkBoundaries();
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.production_sccs, []);
  assert.equal(result.baselined_direction_exceptions.length, 15);
  assert.deepEqual(result.baselined_direction_exceptions[0], {
    from: 'src/local/canonical-source-reader-service.mjs',
    to: 'src/local/auth.mjs',
    reason: 'application cannot import app-local: ./auth.mjs',
  });
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
  const { root, put } = repository(t, 'export const broken = ;');
  assert.match(checkBoundaries(root).errors.join('\n'), /cannot check syntax/);
  put('src/application/broken.mjs', 'export const alsoBroken = ;');
  assert.match(checkBoundaries(root).errors.join('\n'), /production import graph cannot be inspected/);
});

test('rejects core-to-adapter dependencies while ignoring prose and comments', t => {
  const { root, put } = repository(t, "import '../adapters/store.mjs';");
  put('src/adapters/store.mjs', 'export const store = {};');
  assert.match(checkBoundaries(root).errors.join('\n'), /domain cannot import/);
  put('src/core/example.mjs', "// import '../../../outside.mjs';\nconst note = \"import 'fake-package'\";");
  assert.equal(checkBoundaries(root).ok, true);
});

test('target domain, application and adapter directions reject app-local and external capability imports', t => {
  const { root, put } = repository(t, 'export const legacy = true;');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', dependencies: { ai: '1.0.0' } }));
  put('node_modules/ai/index.js', 'export const generateText = true;');
  put('src/app/local/service.mjs', 'export const service = true;');
  put('src/application/use-case.mjs', "import '../app/local/service.mjs';");
  put('src/adapters/store.mjs', "import '../app/local/service.mjs';");
  put('src/domain/model.mjs', "import '../application/use-case.mjs'; import 'node:fs'; import 'ai';");
  const errors = checkBoundaries(root).errors.join('\n');
  assert.match(errors, /src\/application\/use-case\.mjs: application cannot import app-local/);
  assert.match(errors, /src\/adapters\/store\.mjs: adapters cannot import app-local/);
  assert.match(errors, /src\/domain\/model\.mjs: domain cannot import application/);
  assert.match(errors, /src\/domain\/model\.mjs: domain cannot import host, provider, or storage module node:fs/);
  assert.match(errors, /src\/domain\/model\.mjs: domain cannot import external package ai/);
});

test('legacy local paths inherit their accepted target roles from the layout baseline', t => {
  const { root, put } = repository(t, "import '../local/service.mjs';");
  put('src/local/service.mjs', 'export const service = true;');
  put('src/application/use-case.mjs', "import '../local/service.mjs';");
  put('src/adapters/store.mjs', "import '../local/service.mjs';");
  put('docs/architecture/runtime-layout-baseline-v1.json', JSON.stringify({
    inventory: [{ path: 'src/local/service.mjs', intended_destination: 'src/app/local/service.mjs' }],
    production_sccs: [],
  }));
  const errors = checkBoundaries(root).errors.join('\n');
  assert.match(errors, /src\/core\/example\.mjs: domain cannot import app-local/);
  assert.match(errors, /src\/application\/use-case\.mjs: application cannot import app-local/);
  assert.match(errors, /src\/adapters\/store\.mjs: adapters cannot import app-local/);
});

test('production cannot import research while loose test, tools, verification and research roots remain scanned', t => {
  const { root, put } = repository(t, 'export const legacy = true;');
  put('research/example.mjs', "import '../src/core/example.mjs'; import 'node:fs';");
  put('verification/check.mjs', "import '../src/core/example.mjs'; import 'node:fs';");
  put('tools/check.mjs', "import '../src/core/example.mjs'; import 'node:fs';");
  put('test/check.mjs', "import '../src/core/example.mjs'; import 'node:fs';");
  put('src/application/use-case.mjs', "import '../../research/example.mjs';");
  const result = checkBoundaries(root);
  assert.match(result.errors.join('\n'), /production code cannot import research/);
  assert.equal(result.files, 6);
  assert.equal(result.errors.some(error => /^(?:research\/example|verification\/check|tools\/check|test\/check)/.test(error)), false);
});

test('a self-contained research package owns its exact dependencies without joining the Runtime manifest', t => {
  const { root, put } = repository(t, 'export const legacy = true;');
  put('research/spike/package.json', JSON.stringify({ dependencies: { experiment: '1.0.0' } }));
  put('research/spike/index.mjs', "import 'experiment';");
  put('research/spike/node_modules/experiment/index.js', 'export const result = true;');
  assert.equal(checkBoundaries(root).ok, true);
});

test('production SCC check accepts the exact baseline and rejects new or enlarged cycles with exact paths', t => {
  const { root, put } = repository(t, 'export const legacy = true;');
  put('src/application/a.mjs', "import './b.mjs';");
  put('src/application/b.mjs', "import './a.mjs';");
  put('docs/architecture/runtime-layout-baseline-v1.json', JSON.stringify({
    inventory: [],
    production_sccs: [['src/application/a.mjs', 'src/application/b.mjs']],
  }));
  let result = checkBoundaries(root);
  assert.equal(result.errors.some(error => error.includes('production dependency cycle')), false);
  assert.deepEqual(result.production_sccs, [['src/application/a.mjs', 'src/application/b.mjs']]);

  put('src/application/b.mjs', "import './c.mjs';");
  put('src/application/c.mjs', "import './a.mjs';");
  result = checkBoundaries(root);
  assert.match(result.errors.join('\n'), /production dependency cycle is not baselined: src\/application\/a\.mjs -> src\/application\/b\.mjs -> src\/application\/c\.mjs/);

  put('src/application/a.js', "import './b.js';");
  put('src/application/b.js', "import './a.js';");
  result = checkBoundaries(root);
  assert.match(result.errors.join('\n'), /production dependency cycle is not baselined: src\/application\/a\.js -> src\/application\/b\.js/);
});

test('core permits inert native type inspection but keeps general utilities and I/O outside its boundary', t => {
  const { root, put } = repository(t, "import { isProxy } from 'node:util/types'; import { createHash } from 'node:crypto';");
  assert.equal(checkBoundaries(root).ok, true);
  for (const module of ['node:util', 'node:fs', 'node:child_process', 'node:sqlite', 'node:http']) {
    put('src/core/example.mjs', `import '${module}';`);
    assert.equal(checkBoundaries(root).ok, false, module);
  }
});

test('rejects symlinks and manifest dependencies on parent workspaces', t => {
  const { root } = repository(t, 'export const x = 1;');
  symlinkSync(join(root, 'package.json'), join(root, 'src/core/linked.mjs'));
  assert.match(checkBoundaries(root).errors.join('\n'), /symlinks/);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { sibling: 'file:../plugin' } }));
  assert.match(checkBoundaries(root).errors.join('\n'), /sibling link/);
});
