import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkRuntimeLayout, inspectRuntimeLayout } from '../scripts/runtime-layout.mjs';

function copyComponent(t) {
  const root = mkdtempSync(join(tmpdir(), 'semantic-layout-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ['.env.example', '.gitignore', 'AGENTS.md', 'README.md', 'package.json', 'package-lock.json', 'index.ts', 'src', 'scripts', 'test', 'research', 'policies', 'docs']) {
    const source = new URL(`../${path}`, import.meta.url);
    if (existsSync(source)) cpSync(source, join(root, path), { recursive: true });
  }
  return root;
}

test('checked Runtime layout baseline matches the complete component', () => {
  const result = checkRuntimeLayout();
  assert.equal(result.inventory_checked, existsSync(new URL('../research', import.meta.url)));
  assert.deepEqual(result.errors, []);
});

test('UX research relocation is complete and recorded', t => {
  if (!existsSync(new URL('../research', import.meta.url))) {
    t.skip('standalone production verification deliberately excludes research');
    return;
  }
  const manifest = JSON.parse(readFileSync(new URL('../docs/history/runtime-relocations-v1.json', import.meta.url), 'utf8'));
  const entries = manifest.relocations.filter(item => item.category === 'ux-research');
  assert.equal(manifest.schema_version, 1);
  assert.equal(entries.length, 7);
  assert.equal(new Set(entries.map(item => item.migration_commit)).size, 1);
  for (const entry of entries) {
    assert.match(entry.old_blob, /^[0-9a-f]{40}$/);
    assert.match(entry.migration_commit, /^[0-9a-f]{40}$/);
    assert.equal(existsSync(new URL(`../${entry.old_path.slice('semantic-runtime/'.length)}`, import.meta.url)), false);
    assert.equal(existsSync(new URL(`../${entry.new_path.slice('semantic-runtime/'.length)}`, import.meta.url)), true);
  }
  assert.ok(entries.every(entry => entry.new_path.startsWith('semantic-runtime/research/ux/project-exploration/')));
});

test('PostgreSQL research relocation is complete and recorded', t => {
  if (!existsSync(new URL('../research', import.meta.url))) {
    t.skip('standalone production verification deliberately excludes research');
    return;
  }
  const manifest = JSON.parse(readFileSync(new URL('../docs/history/runtime-relocations-v1.json', import.meta.url), 'utf8'));
  const entries = manifest.relocations.filter(item => item.category === 'platform-research');
  assert.equal(manifest.schema_version, 1);
  assert.equal(entries.length, 16);
  assert.equal(new Set(entries.map(item => item.migration_commit)).size, 1);
  for (const entry of entries) {
    assert.match(entry.old_blob, /^[0-9a-f]{40}$/);
    assert.match(entry.migration_commit, /^[0-9a-f]{40}$/);
    assert.equal(existsSync(new URL(`../${entry.old_path.slice('semantic-runtime/'.length)}`, import.meta.url)), false);
    assert.equal(existsSync(new URL(`../${entry.new_path.slice('semantic-runtime/'.length)}`, import.meta.url)), true);
  }
  assert.ok(entries.every(entry => entry.new_path.startsWith('semantic-runtime/research/platform/node-postgres/')));
});

test('host probe research relocation is complete and recorded', t => {
  if (!existsSync(new URL('../research', import.meta.url))) {
    t.skip('standalone production verification deliberately excludes research');
    return;
  }
  const manifest = JSON.parse(readFileSync(new URL('../docs/history/runtime-relocations-v1.json', import.meta.url), 'utf8'));
  const entries = manifest.relocations.filter(item => item.category === 'host-research');
  assert.equal(manifest.schema_version, 1);
  assert.equal(entries.length, 9);
  assert.equal(new Set(entries.map(item => item.migration_commit)).size, 1);
  for (const entry of entries) {
    assert.match(entry.old_blob, /^[0-9a-f]{40}$/);
    assert.match(entry.migration_commit, /^[0-9a-f]{40}$/);
    assert.equal(existsSync(new URL(`../${entry.old_path.slice('semantic-runtime/'.length)}`, import.meta.url)), false);
    assert.equal(existsSync(new URL(`../${entry.new_path.slice('semantic-runtime/'.length)}`, import.meta.url)), true);
  }
  assert.ok(entries.every(entry => entry.new_path.startsWith('semantic-runtime/research/host-probes/')));
  assert.deepEqual(new Set(entries.map(entry => entry.new_path.split('/')[3])), new Set(['claude', 'codex']));
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
  assert.equal(current.npm_commands.find(item => item.name === 'test:host-probes')?.mode, 'offline');
  assert.equal(current.npm_commands.find(item => item.name === 'probe:codex:live')?.mode, 'explicit-live');
  assert.equal(current.npm_commands.find(item => item.name === 'probe:claude:live')?.mode, 'explicit-live');
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
  if (existsSync(new URL('../research', import.meta.url))) {
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /inventory: added or changed/);
  } else {
    assert.equal(result.inventory_checked, false);
  }

  rmSync(extra);
  writeFileSync(join(root, 'unexpected.md'), '# unclassified root document\n');
  result = checkRuntimeLayout(root);
  if (existsSync(new URL('../research', import.meta.url))) {
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /inventory: added or changed.*unexpected\.md/);
  } else {
    assert.equal(result.inventory_checked, false);
  }
});
