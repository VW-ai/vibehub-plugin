import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkRuntimeLayout, inspectRuntimeLayout } from '../scripts/runtime-layout.mjs';

function copyComponent(t) {
  const root = mkdtempSync(join(tmpdir(), 'semantic-layout-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ['.env.example', '.gitignore', 'AGENTS.md', 'README.md', 'package.json', 'package-lock.json', 'index.ts', 'src', 'scripts', 'test', 'prototype', 'spikes', 'policies', 'docs']) {
    const source = new URL(`../${path}`, import.meta.url);
    if (existsSync(source)) cpSync(source, join(root, path), { recursive: true });
  }
  return root;
}

test('checked Runtime layout baseline matches the complete component', () => {
  const result = checkRuntimeLayout();
  assert.equal(result.inventory_checked, existsSync(new URL('../prototype', import.meta.url)));
  assert.deepEqual(result.errors, []);
});

test('layout inspection captures public surface, command modes, constants and an acyclic production graph', () => {
  const current = inspectRuntimeLayout();
  assert.ok(current.inventory.length > 200);
  const expectedRootFiles = ['.env.example', '.gitignore', 'AGENTS.md', 'index.ts', 'package-lock.json', 'package.json', 'README.md']
    .filter(path => existsSync(new URL(`../${path}`, import.meta.url)));
  assert.deepEqual(
    current.inventory.filter(item => !item.path.includes('/')).map(item => item.path),
    expectedRootFiles,
  );
  assert.equal(current.root_exports.length, 206);
  assert.equal(current.npm_commands.find(item => item.name === 'check:jev:query')?.mode, 'explicit-live');
  assert.deepEqual(current.production_sccs, []);
  assert.ok(current.production_import_edges.some(edge =>
    edge.from === 'src/local/cli.mjs' && edge.to === 'src/local/service.mjs'));
  assert.ok(current.production_import_edges.some(edge =>
    edge.from === 'src/local/service.mjs' && edge.to === 'src/local/app-setup.mjs'));
  assert.equal(current.contract_constants.find(item => item.name === 'DOMAIN_SCHEMA_VERSION')?.value, 2);
});

test('layout check gives focused additions and removals without external capabilities', t => {
  const root = copyComponent(t);
  const index = join(root, 'src/index.mjs');
  writeFileSync(index, `${readFileSync(index, 'utf8')}\nexport const accidentalLayoutExport = true;\n`);
  let result = checkRuntimeLayout(root);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /root_exports: added or changed.*accidentalLayoutExport/);

  writeFileSync(index, readFileSync(new URL('../src/index.mjs', import.meta.url), 'utf8'));
  const extra = join(root, 'src/core/unclassified.mjs');
  mkdirSync(dirname(extra), { recursive: true });
  writeFileSync(extra, 'export const value = 1;\n');
  result = checkRuntimeLayout(root);
  if (existsSync(new URL('../prototype', import.meta.url))) {
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /inventory: added or changed/);
  } else {
    assert.equal(result.inventory_checked, false);
  }

  rmSync(extra);
  writeFileSync(join(root, 'unexpected.md'), '# unclassified root document\n');
  result = checkRuntimeLayout(root);
  if (existsSync(new URL('../prototype', import.meta.url))) {
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /inventory: added or changed.*unexpected\.md/);
  } else {
    assert.equal(result.inventory_checked, false);
  }
});
