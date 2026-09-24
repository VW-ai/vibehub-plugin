import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkRuntimeLayout, inspectRuntimeLayout } from '../scripts/runtime-layout.mjs';

const compareEdges = (left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to);

function copyComponent(t) {
  const root = mkdtempSync(join(tmpdir(), 'semantic-layout-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ['.env.example', '.gitignore', 'AGENTS.md', 'README.md', 'package.json', 'package-lock.json', 'src', 'scripts', 'test', 'verification/live', 'research', 'policies', 'docs']) {
    const source = new URL(`../${path}`, import.meta.url);
    if (existsSync(source)) cpSync(source, join(root, path), { recursive: true });
  }
  return root;
}

function resolveRelocationDestination(manifest, startPath) {
  const byOldPath = new Map(manifest.relocations.map(entry => [entry.old_path, entry.new_path]));
  const visited = new Set();
  let currentPath = startPath;
  while (byOldPath.has(currentPath)) {
    assert.equal(visited.has(currentPath), false, `relocation cycle at ${currentPath}`);
    visited.add(currentPath);
    currentPath = byOldPath.get(currentPath);
  }
  return currentPath;
}

test('checked Runtime layout baseline matches the complete component', () => {
  const result = checkRuntimeLayout();
  assert.equal(result.inventory_checked, existsSync(new URL('../docs/history/runtime-relocations-v1.json', import.meta.url)));
  assert.deepEqual(result.errors, []);
});

test('complete production source layout relocation is recorded as one exact batch', t => {
  const manifestUrl = new URL('../docs/history/runtime-relocations-v1.json', import.meta.url);
  if (!existsSync(manifestUrl)) {
    t.skip('standalone production verification deliberately excludes historical relocation records');
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
  const entries = manifest.relocations.filter(item => item.category === 'production-source-layout');
  assert.equal(entries.length, 52);
  assert.deepEqual([...new Set(entries.map(item => item.migration_commit))], [
    '84b1f1c20c56f5b14534f838c0bb77e81a8bade8',
  ]);
  assert.equal(new Set(entries.map(item => item.old_path)).size, 52);
  assert.equal(new Set(entries.map(item => item.new_path)).size, 52);
  for (const entry of entries) {
    assert.match(entry.old_blob, /^[0-9a-f]{40}$/);
    assert.equal(existsSync(new URL(`../${entry.old_path.slice('semantic-runtime/'.length)}`, import.meta.url)), false);
    const currentPath = resolveRelocationDestination(manifest, entry.new_path);
    assert.equal(existsSync(new URL(`../${currentPath.slice('semantic-runtime/'.length)}`, import.meta.url)), true);
  }
  const current = inspectRuntimeLayout();
  assert.deepEqual(current.inventory.filter(record => record.path.startsWith('src/')
    && record.path !== record.intended_destination
    && record.intended_destination.startsWith('src/')), []);
  assert.deepEqual(current.inventory.filter(record => record.path.startsWith('src/')
    && record.path !== record.intended_destination), []);
});

test('Phase 0 replay is one complete research vertical with explicit split lineage', t => {
  const manifestUrl = new URL('../docs/history/runtime-relocations-v1.json', import.meta.url);
  if (!existsSync(manifestUrl)) {
    t.skip('standalone production verification deliberately excludes research provenance');
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
  const entries = manifest.relocations.filter(item => item.category === 'phase0-replay-research');
  assert.equal(entries.length, 32);
  assert.deepEqual([...new Set(entries.map(item => item.migration_commit))], [
    'aa707aa5b4b8d1c0d41e66628699d727386aaeea',
  ]);
  assert.equal(new Set(entries.map(item => item.old_path)).size, 32);
  assert.equal(new Set(entries.map(item => item.new_path)).size, 32);
  for (const entry of entries) {
    assert.match(entry.old_blob, /^[0-9a-f]{40}$/);
    assert.equal(existsSync(new URL(`../${entry.old_path.slice('semantic-runtime/'.length)}`, import.meta.url)), false);
    assert.equal(existsSync(new URL(`../${entry.new_path.slice('semantic-runtime/'.length)}`, import.meta.url)), true);
  }
  const splitEntry = entries.find(item => item.old_path === 'semantic-runtime/src/core/contracts.mjs');
  assert.equal(splitEntry?.new_path, 'semantic-runtime/src/domain/shared/contracts.mjs');
  assert.equal(existsSync(new URL('../research/phase0-replay/src/contracts.mjs', import.meta.url)), true);
  const current = inspectRuntimeLayout();
  assert.deepEqual(current.inventory.filter(record => record.path.startsWith('research/phase0-replay/')
    && record.path !== record.intended_destination), []);
  assert.deepEqual(['compareRuns', 'loadPhaseZeroPolicyArtifact', 'normalizeEvent', 'normalizeState', 'replay', 'validatePolicy']
    .filter(name => current.root_exports.includes(name)), []);
  assert.equal(current.root_exports.includes('judgeInputHash'), true);
});

test('UX research relocation is complete and recorded', t => {
  if (!existsSync(new URL('../research/ux/project-exploration', import.meta.url))) {
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
  if (!existsSync(new URL('../research/platform/node-postgres', import.meta.url))) {
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
  if (!existsSync(new URL('../research/host-probes', import.meta.url))) {
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

test('production provider adapter relocation is complete and recorded', t => {
  const manifestUrl = new URL('../docs/history/runtime-relocations-v1.json', import.meta.url);
  if (!existsSync(manifestUrl)) {
    t.skip('standalone production verification deliberately excludes historical relocation records');
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
  const entries = manifest.relocations.filter(item => item.category === 'provider-adapter');
  assert.equal(manifest.schema_version, 1);
  assert.equal(entries.length, 4);
  assert.equal(new Set(entries.map(item => item.migration_commit)).size, 1);
  for (const entry of entries) {
    assert.match(entry.old_blob, /^[0-9a-f]{40}$/);
    assert.match(entry.migration_commit, /^[0-9a-f]{40}$/);
    assert.equal(existsSync(new URL(`../${entry.old_path.slice('semantic-runtime/'.length)}`, import.meta.url)), false);
    assert.equal(existsSync(new URL(`../${entry.new_path.slice('semantic-runtime/'.length)}`, import.meta.url)), true);
  }
  assert.ok(entries.every(entry => entry.new_path.startsWith('semantic-runtime/src/adapters/providers/')));
});

test('macOS secret adapter relocation is complete and recorded', t => {
  const manifestUrl = new URL('../docs/history/runtime-relocations-v1.json', import.meta.url);
  if (!existsSync(manifestUrl)) {
    t.skip('standalone production verification deliberately excludes historical relocation records');
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
  const entries = manifest.relocations.filter(item => item.category === 'secret-adapter');
  assert.equal(manifest.schema_version, 1);
  assert.equal(entries.length, 2);
  assert.equal(new Set(entries.map(item => item.migration_commit)).size, 1);
  for (const entry of entries) {
    assert.match(entry.old_blob, /^[0-9a-f]{40}$/);
    assert.match(entry.migration_commit, /^[0-9a-f]{40}$/);
    assert.equal(existsSync(new URL(`../${entry.old_path.slice('semantic-runtime/'.length)}`, import.meta.url)), false);
    assert.equal(existsSync(new URL(`../${entry.new_path.slice('semantic-runtime/'.length)}`, import.meta.url)), true);
  }
  assert.ok(entries.every(entry => entry.new_path.startsWith('semantic-runtime/src/adapters/secrets/')));
});

test('production SQLite adapter relocation is complete and recorded', t => {
  const manifestUrl = new URL('../docs/history/runtime-relocations-v1.json', import.meta.url);
  if (!existsSync(manifestUrl)) {
    t.skip('standalone production verification deliberately excludes historical relocation records');
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
  const entries = manifest.relocations.filter(item => item.category === 'sqlite-adapter');
  assert.equal(manifest.schema_version, 1);
  assert.equal(entries.length, 2);
  assert.equal(new Set(entries.map(item => item.migration_commit)).size, 1);
  for (const entry of entries) {
    assert.match(entry.old_blob, /^[0-9a-f]{40}$/);
    assert.match(entry.migration_commit, /^[0-9a-f]{40}$/);
    assert.equal(existsSync(new URL(`../${entry.old_path.slice('semantic-runtime/'.length)}`, import.meta.url)), false);
    assert.equal(existsSync(new URL(`../${entry.new_path.slice('semantic-runtime/'.length)}`, import.meta.url)), true);
  }
  assert.ok(entries.every(entry => entry.new_path.startsWith('semantic-runtime/src/adapters/sqlite/')));
});

test('Context read application service relocation is complete and recorded', t => {
  const manifestUrl = new URL('../docs/history/runtime-relocations-v1.json', import.meta.url);
  if (!existsSync(manifestUrl)) {
    t.skip('standalone production verification deliberately excludes historical relocation records');
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
  const entries = manifest.relocations.filter(item => item.category === 'context-application-service');
  assert.equal(manifest.schema_version, 1);
  assert.deepEqual(entries, [{
    old_path: 'semantic-runtime/src/local/context-read-service.mjs',
    new_path: 'semantic-runtime/src/application/context/context-read-service.mjs',
    old_blob: '6263eba17a321765a099688ad273a2dc51fda862',
    migration_commit: '8746a0112e78facb6d49ca95a58fddf4c30f23f5',
    category: 'context-application-service',
  }]);
  assert.equal(existsSync(new URL('../src/local/context-read-service.mjs', import.meta.url)), false);
  assert.equal(existsSync(new URL('../src/application/context/context-read-service.mjs', import.meta.url)), true);
});

test('Query application capability relocation is complete and recorded', t => {
  const manifestUrl = new URL('../docs/history/runtime-relocations-v1.json', import.meta.url);
  if (!existsSync(manifestUrl)) {
    t.skip('standalone production verification deliberately excludes historical relocation records');
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
  const entries = manifest.relocations.filter(item => item.category === 'query-application-capability');
  assert.equal(manifest.schema_version, 1);
  assert.deepEqual(entries, [
    {
      old_path: 'semantic-runtime/src/local/query-contract.mjs',
      new_path: 'semantic-runtime/src/application/query/query-contract.mjs',
      old_blob: 'b62d715e0043462f05feb5d0e769e8a3b93456bc',
      migration_commit: 'd9017df27b8407d7db30f772f48e324f7014a73f',
      category: 'query-application-capability',
    },
    {
      old_path: 'semantic-runtime/src/local/query-inputs.mjs',
      new_path: 'semantic-runtime/src/application/query/query-inputs.mjs',
      old_blob: 'fe159875ac1db76cfc7f0edea6a21de44e70caf4',
      migration_commit: 'd9017df27b8407d7db30f772f48e324f7014a73f',
      category: 'query-application-capability',
    },
    {
      old_path: 'semantic-runtime/src/local/query-engine.mjs',
      new_path: 'semantic-runtime/src/application/query/query-engine.mjs',
      old_blob: 'f7f22f70a68439809c385a48a53270ee8125570f',
      migration_commit: 'd9017df27b8407d7db30f772f48e324f7014a73f',
      category: 'query-application-capability',
    },
  ]);
  for (const entry of entries) {
    assert.equal(existsSync(new URL(`../${entry.old_path.slice('semantic-runtime/'.length)}`, import.meta.url)), false);
    assert.equal(existsSync(new URL(`../${entry.new_path.slice('semantic-runtime/'.length)}`, import.meta.url)), true);
  }
});

test('Context reader application relocation is complete and recorded', t => {
  const manifestUrl = new URL('../docs/history/runtime-relocations-v1.json', import.meta.url);
  if (!existsSync(manifestUrl)) {
    t.skip('standalone production verification deliberately excludes historical relocation records');
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
  const entries = manifest.relocations.filter(item => item.category === 'context-application-reader');
  assert.equal(manifest.schema_version, 1);
  assert.deepEqual(entries, [{
    old_path: 'semantic-runtime/src/local/context-reader.mjs',
    new_path: 'semantic-runtime/src/application/context/context-reader.mjs',
    old_blob: '9e90df27380fc32739543889bb372e03cb7c0dd5',
    migration_commit: '5102e1a260f58fe0af7d82d9421e62ccf327a8d3',
    category: 'context-application-reader',
  }]);
  assert.equal(existsSync(new URL('../src/local/context-reader.mjs', import.meta.url)), false);
  assert.equal(existsSync(new URL('../src/application/context/context-reader.mjs', import.meta.url)), true);
});

test('Context write application capability relocation is complete and recorded', t => {
  const manifestUrl = new URL('../docs/history/runtime-relocations-v1.json', import.meta.url);
  if (!existsSync(manifestUrl)) {
    t.skip('standalone production verification deliberately excludes historical relocation records');
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
  const entries = manifest.relocations.filter(item => item.category === 'context-application-write-capability');
  assert.equal(manifest.schema_version, 1);
  assert.deepEqual(entries, [
    {
      old_path: 'semantic-runtime/src/local/context-inputs.mjs',
      new_path: 'semantic-runtime/src/application/context/context-inputs.mjs',
      old_blob: 'ae3755749f0a1213d9e096787a61c1ac6e270b6f',
      migration_commit: '55a16865b8ec66e0bcb018a69fb4f4225569e4f5',
      category: 'context-application-write-capability',
    },
    {
      old_path: 'semantic-runtime/src/local/context-store.mjs',
      new_path: 'semantic-runtime/src/application/context/context-store.mjs',
      old_blob: 'b4e60c49282ba92dd053bb3aa85f8e92bb06bad3',
      migration_commit: '55a16865b8ec66e0bcb018a69fb4f4225569e4f5',
      category: 'context-application-write-capability',
    },
  ]);
  for (const entry of entries) {
    assert.equal(existsSync(new URL(`../${entry.old_path.slice('semantic-runtime/'.length)}`, import.meta.url)), false);
    assert.equal(existsSync(new URL(`../${entry.new_path.slice('semantic-runtime/'.length)}`, import.meta.url)), true);
  }
});

test('Canonical source reader application capability relocation is complete and recorded', t => {
  const manifestUrl = new URL('../docs/history/runtime-relocations-v1.json', import.meta.url);
  if (!existsSync(manifestUrl)) {
    t.skip('standalone production verification deliberately excludes historical relocation records');
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
  const entries = manifest.relocations.filter(item => item.category === 'canonical-source-reader-application-capability');
  assert.equal(manifest.schema_version, 1);
  assert.deepEqual(entries, [
    {
      old_path: 'semantic-runtime/src/local/canonical-source-reader.mjs',
      new_path: 'semantic-runtime/src/application/sources/canonical-source-reader.mjs',
      old_blob: '7c910d4a1595b39a3c98a269905047e49ff66d3c',
      migration_commit: 'be6c9e11a07089d5376853c62da792f88b792461',
      category: 'canonical-source-reader-application-capability',
    },
    {
      old_path: 'semantic-runtime/src/local/canonical-source-reader-service.mjs',
      new_path: 'semantic-runtime/src/application/sources/canonical-source-reader-service.mjs',
      old_blob: 'daa00dc4e0b0c0be6cc273415de5098152767f52',
      migration_commit: 'be6c9e11a07089d5376853c62da792f88b792461',
      category: 'canonical-source-reader-application-capability',
    },
  ]);
  for (const entry of entries) {
    assert.equal(existsSync(new URL(`../${entry.old_path.slice('semantic-runtime/'.length)}`, import.meta.url)), false);
    assert.equal(existsSync(new URL(`../${entry.new_path.slice('semantic-runtime/'.length)}`, import.meta.url)), true);
  }
});

test('Graph application capability relocation is complete and recorded', t => {
  const manifestUrl = new URL('../docs/history/runtime-relocations-v1.json', import.meta.url);
  if (!existsSync(manifestUrl)) {
    t.skip('standalone production verification deliberately excludes historical relocation records');
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
  const entries = manifest.relocations.filter(item => item.category === 'graph-application-capability');
  assert.equal(manifest.schema_version, 1);
  assert.deepEqual(entries, [{
    old_path: 'semantic-runtime/src/local/graph-capability.mjs',
    new_path: 'semantic-runtime/src/application/graph/graph-capability.mjs',
    old_blob: 'afae727cf3ac13539e40e798a468d28d65d7d293',
    migration_commit: '8845a0c43fcea1ea68520c35d93e81e05cf3346c',
    category: 'graph-application-capability',
  }]);
  assert.equal(existsSync(new URL('../src/local/graph-capability.mjs', import.meta.url)), false);
  assert.equal(existsSync(new URL('../src/application/graph/graph-capability.mjs', import.meta.url)), true);
});

test('selected Graph application port relocation is complete and recorded', t => {
  const manifestUrl = new URL('../docs/history/runtime-relocations-v1.json', import.meta.url);
  if (!existsSync(manifestUrl)) {
    t.skip('standalone production verification deliberately excludes historical relocation records');
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
  const entries = manifest.relocations.filter(item => item.category === 'graph-application-selection-port');
  assert.equal(manifest.schema_version, 1);
  assert.deepEqual(entries, [{
    old_path: 'semantic-runtime/src/local/graph-selected.mjs',
    new_path: 'semantic-runtime/src/application/graph/graph-selected.mjs',
    old_blob: '3cd81a840ffee9931ebb2e29703e3091b8b04bef',
    migration_commit: '68b2cf2efe64bdf296ea899917eaf019e1d4af87',
    category: 'graph-application-selection-port',
  }]);
  assert.equal(existsSync(new URL('../src/local/graph-selected.mjs', import.meta.url)), false);
  assert.equal(existsSync(new URL('../src/application/graph/graph-selected.mjs', import.meta.url)), true);
});

test('selected Exploration Git observer adapter relocation is complete and recorded', t => {
  const manifestUrl = new URL('../docs/history/runtime-relocations-v1.json', import.meta.url);
  if (!existsSync(manifestUrl)) {
    t.skip('standalone production verification deliberately excludes historical relocation records');
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
  const entries = manifest.relocations.filter(item => item.category === 'git-exploration-observer-adapter');
  assert.equal(manifest.schema_version, 1);
  assert.deepEqual(entries, [{
    old_path: 'semantic-runtime/src/local/exploration-physical.mjs',
    new_path: 'semantic-runtime/src/adapters/git/exploration-physical.mjs',
    old_blob: 'dc41cf05dfcb3bd8733a5c28bdc3a93567ab75ed',
    migration_commit: '64b238c02201ce631299ad5bc0e2e9b1479017e3',
    category: 'git-exploration-observer-adapter',
  }]);
  assert.equal(existsSync(new URL('../src/local/exploration-physical.mjs', import.meta.url)), false);
  assert.equal(existsSync(new URL('../src/adapters/git/exploration-physical.mjs', import.meta.url)), true);
});

test('Exploration application facade relocation is complete and recorded', t => {
  const manifestUrl = new URL('../docs/history/runtime-relocations-v1.json', import.meta.url);
  if (!existsSync(manifestUrl)) {
    t.skip('standalone production verification deliberately excludes historical relocation records');
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
  const entries = manifest.relocations.filter(item => item.category === 'exploration-application-facade');
  assert.equal(manifest.schema_version, 1);
  assert.deepEqual(entries, [{
    old_path: 'semantic-runtime/src/local/exploration-store.mjs',
    new_path: 'semantic-runtime/src/application/explorations/exploration-store.mjs',
    old_blob: '0c6d944acf7b967adc891f4aa6ba3ecd18e22e9b',
    migration_commit: 'ee0e605a5fbbd7aa13ad628b26721150acb09289',
    category: 'exploration-application-facade',
  }]);
  assert.equal(existsSync(new URL('../src/local/exploration-store.mjs', import.meta.url)), false);
  assert.equal(existsSync(new URL('../src/application/explorations/exploration-store.mjs', import.meta.url)), true);
});

test('Exploration adoption application service relocation is complete and recorded', t => {
  const manifestUrl = new URL('../docs/history/runtime-relocations-v1.json', import.meta.url);
  if (!existsSync(manifestUrl)) {
    t.skip('standalone production verification deliberately excludes historical relocation records');
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
  const entries = manifest.relocations.filter(item => item.category === 'exploration-adoption-application-service');
  assert.equal(manifest.schema_version, 1);
  assert.deepEqual(entries, [{
    old_path: 'semantic-runtime/src/local/exploration-adoption.mjs',
    new_path: 'semantic-runtime/src/application/explorations/exploration-adoption.mjs',
    old_blob: 'd5acf698ee2a294c6c6d3a2d7ef6e3a5a8790e9a',
    migration_commit: '9eb1509117eb441c94e94aaaa4a25a1dd2500099',
    category: 'exploration-adoption-application-service',
  }]);
  assert.equal(existsSync(new URL('../src/local/exploration-adoption.mjs', import.meta.url)), false);
  assert.equal(existsSync(new URL('../src/application/explorations/exploration-adoption.mjs', import.meta.url)), true);
});

test('Gateway example research relocation is complete and recorded', t => {
  const manifestUrl = new URL('../docs/history/runtime-relocations-v1.json', import.meta.url);
  if (!existsSync(manifestUrl)) {
    t.skip('standalone production verification deliberately excludes historical relocation records');
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
  const entries = manifest.relocations.filter(item => item.category === 'gateway-example-research');
  assert.equal(manifest.schema_version, 1);
  assert.deepEqual(entries, [{
    old_path: 'semantic-runtime/index.ts',
    new_path: 'semantic-runtime/research/examples/ai-gateway/index.ts',
    old_blob: '87b091203b62a18940ba4395890d84385271c0df',
    migration_commit: 'add8029a9121714e30dd6b22e661d93e1ea65129',
    category: 'gateway-example-research',
  }]);
  assert.equal(existsSync(new URL('../index.ts', import.meta.url)), false);
  assert.equal(existsSync(new URL('../research/examples/ai-gateway/index.ts', import.meta.url)), true);
});

test('layout inspection captures public surface, command modes, constants and an acyclic production graph', () => {
  const current = inspectRuntimeLayout();
  assert.ok(current.inventory.length > 200);
  const expectedRootFiles = ['.env.example', '.gitignore', 'AGENTS.md', 'package-lock.json', 'package.json', 'README.md']
    .filter(path => existsSync(new URL(`../${path}`, import.meta.url)));
  assert.deepEqual(
    current.inventory.filter(item => !item.path.includes('/')).map(item => item.path),
    expectedRootFiles,
  );
  assert.equal(current.root_exports.length, 200);
  assert.equal(current.npm_commands.find(item => item.name === 'check:jev:query')?.mode, 'explicit-live');
  assert.equal(current.npm_commands.find(item => item.name === 'test:host-probes')?.mode, 'offline');
  assert.equal(current.npm_commands.find(item => item.name === 'probe:codex:live')?.mode, 'explicit-live');
  assert.equal(current.npm_commands.find(item => item.name === 'probe:claude:live')?.mode, 'explicit-live');
  assert.deepEqual(current.npm_commands.find(item => item.name === 'example:gateway'), {
    name: 'example:gateway',
    command: 'node --experimental-strip-types --env-file=.env.local research/examples/ai-gateway/index.ts',
    mode: 'explicit-live',
  });
  const gatewayExample = current.inventory.find(item => item.path === 'research/examples/ai-gateway/index.ts');
  if (existsSync(new URL('../research/examples/ai-gateway', import.meta.url))) {
    assert.deepEqual(gatewayExample, {
      path: 'research/examples/ai-gateway/index.ts',
      current_role: 'research',
      intended_destination: 'research/examples/ai-gateway/index.ts',
    });
  } else {
    assert.equal(gatewayExample, undefined);
  }
  assert.equal(current.standalone_copy_paths.includes('index.ts'), false);
  assert.equal(current.standalone_copy_paths.includes('verification/live'), true);
  assert.equal(current.standalone_copy_paths.includes('verification/reports'), false);
  assert.equal(current.standalone_copy_paths.includes('research'), false);
  assert.equal(current.inventory_roots.includes('verification/live'), true);
  assert.equal(current.inventory_roots.includes('verification/reports'), false);
  const liveVerification = current.inventory.filter(item => item.path.startsWith('verification/live/'));
  if (existsSync(new URL('../verification/live', import.meta.url))) {
    assert.ok(liveVerification.length > 0);
    assert.ok(liveVerification.every(item => item.current_role === 'live-verification'
      && item.intended_destination === item.path));
  }
  assert.deepEqual(current.production_sccs, []);
  assert.ok(current.production_import_edges.some(edge =>
    edge.from === 'src/app/local/cli.mjs' && edge.to === 'src/app/local/service.mjs'));
  assert.ok(current.production_import_edges.some(edge =>
    edge.from === 'src/app/local/service.mjs' && edge.to === 'src/app/local/app-setup.mjs'));
  assert.deepEqual(current.production_import_edges.filter(edge =>
    edge.to.startsWith('src/application/query/') && !edge.from.startsWith('src/application/query/')),
  [{ from: 'src/index.mjs', to: 'src/application/query/query-engine.mjs' }]);
  assert.deepEqual(current.production_import_edges.filter(edge =>
    edge.to === 'src/application/context/context-reader.mjs'), [
    { from: 'src/application/context/context-read-service.mjs', to: 'src/application/context/context-reader.mjs' },
    { from: 'src/application/query/query-contract.mjs', to: 'src/application/context/context-reader.mjs' },
    { from: 'src/application/query/query-inputs.mjs', to: 'src/application/context/context-reader.mjs' },
    { from: 'src/application/graph/graph-store.mjs', to: 'src/application/context/context-reader.mjs' },
    { from: 'src/application/judge/judge-inputs.mjs', to: 'src/application/context/context-reader.mjs' },
  ].sort(compareEdges));
  assert.equal(current.production_import_edges.filter(edge =>
    edge.from === 'src/application/context/context-reader.mjs').length, 8);
  const contextWriteNodes = new Set([
    'src/application/context/context-inputs.mjs',
    'src/application/context/context-store.mjs',
  ]);
  assert.deepEqual(current.production_import_edges.filter(edge =>
    contextWriteNodes.has(edge.from) || contextWriteNodes.has(edge.to)), [
    { from: 'src/application/context/context-inputs.mjs', to: 'src/domain/context/context-profile.mjs' },
    { from: 'src/application/context/context-inputs.mjs', to: 'src/domain/shared/contracts.mjs' },
    { from: 'src/application/context/context-inputs.mjs', to: 'src/domain/sources/event-provenance.mjs' },
    { from: 'src/application/context/context-inputs.mjs', to: 'src/domain/graph/working-graph.mjs' },
    { from: 'src/application/context/context-inputs.mjs', to: 'src/domain/identity/access-authority.mjs' },
    { from: 'src/application/context/context-inputs.mjs', to: 'src/application/explorations/exploration-canonical.mjs' },
    { from: 'src/application/context/context-inputs.mjs', to: 'src/application/graph/graph-inputs.mjs' },
    { from: 'src/application/context/context-read-service.mjs', to: 'src/application/context/context-inputs.mjs' },
    { from: 'src/application/context/context-store.mjs', to: 'src/application/graph/graph-inputs.mjs' },
    { from: 'src/application/context/context-store.mjs', to: 'src/application/support/local-runtime-composition.mjs' },
    { from: 'src/index.mjs', to: 'src/application/context/context-store.mjs' },
    { from: 'src/application/graph/graph-service-bundle.mjs', to: 'src/application/context/context-inputs.mjs' },
    { from: 'src/application/graph/graph-store.mjs', to: 'src/application/context/context-inputs.mjs' },
    { from: 'src/application/judge/judge-inputs.mjs', to: 'src/application/context/context-store.mjs' },
  ].sort(compareEdges));
  assert.deepEqual(current.production_import_edges.filter(edge =>
    edge.from === 'src/application/explorations/exploration-store.mjs'
      || edge.to === 'src/application/explorations/exploration-store.mjs'), [
    { from: 'src/application/explorations/exploration-store.mjs', to: 'src/application/explorations/exploration-inputs.mjs' },
    { from: 'src/application/explorations/exploration-store.mjs', to: 'src/application/graph/graph-inputs.mjs' },
    { from: 'src/application/explorations/exploration-store.mjs', to: 'src/application/support/local-runtime-composition.mjs' },
    { from: 'src/index.mjs', to: 'src/application/explorations/exploration-store.mjs' },
    { from: 'src/application/judge/judge-inputs.mjs', to: 'src/application/explorations/exploration-store.mjs' },
  ].sort(compareEdges));
  assert.deepEqual(current.production_import_edges.filter(edge =>
    edge.from === 'src/application/explorations/exploration-adoption.mjs'
      || edge.to === 'src/application/explorations/exploration-adoption.mjs'), [
    { from: 'src/application/context/context-reader.mjs', to: 'src/application/explorations/exploration-adoption.mjs' },
    { from: 'src/application/explorations/exploration-adoption.mjs', to: 'src/adapters/sqlite/graph-storage.mjs' },
    { from: 'src/application/explorations/exploration-adoption.mjs', to: 'src/domain/sources/causal-ordering.mjs' },
    { from: 'src/application/explorations/exploration-adoption.mjs', to: 'src/domain/shared/contracts.mjs' },
    { from: 'src/application/explorations/exploration-adoption.mjs', to: 'src/domain/sources/event-provenance.mjs' },
    { from: 'src/application/explorations/exploration-adoption.mjs', to: 'src/domain/graph/working-graph.mjs' },
    { from: 'src/application/explorations/exploration-adoption.mjs', to: 'src/application/explorations/exploration-inputs.mjs' },
    { from: 'src/application/explorations/exploration-adoption.mjs', to: 'src/application/graph/graph-inputs.mjs' },
    { from: 'src/application/query/query-inputs.mjs', to: 'src/application/explorations/exploration-adoption.mjs' },
    { from: 'src/application/graph/graph-store.mjs', to: 'src/application/explorations/exploration-adoption.mjs' },
  ].sort(compareEdges));
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
  if (existsSync(new URL('../docs/history/runtime-relocations-v1.json', import.meta.url))) {
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /inventory: added or changed/);
  } else {
    assert.equal(result.inventory_checked, false);
  }

  rmSync(extra);
  writeFileSync(join(root, 'unexpected.md'), '# unclassified root document\n');
  result = checkRuntimeLayout(root);
  if (existsSync(new URL('../docs/history/runtime-relocations-v1.json', import.meta.url))) {
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /inventory: added or changed.*unexpected\.md/);
  } else {
    assert.equal(result.inventory_checked, false);
  }
});
