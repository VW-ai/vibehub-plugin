import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkRuntimeLayout, inspectRuntimeLayout } from '../scripts/runtime-layout.mjs';

function copyComponent(t) {
  const root = mkdtempSync(join(tmpdir(), 'semantic-layout-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ['.env.example', '.gitignore', 'AGENTS.md', 'README.md', 'package.json', 'package-lock.json', 'src', 'scripts', 'test', 'research', 'policies', 'docs']) {
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
  assert.equal(current.root_exports.length, 206);
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
  if (existsSync(new URL('../research', import.meta.url))) {
    assert.deepEqual(gatewayExample, {
      path: 'research/examples/ai-gateway/index.ts',
      current_role: 'research',
      intended_destination: 'research/examples/ai-gateway/index.ts',
    });
  } else {
    assert.equal(gatewayExample, undefined);
  }
  assert.equal(current.standalone_copy_paths.includes('index.ts'), false);
  assert.deepEqual(current.production_sccs, []);
  assert.ok(current.production_import_edges.some(edge =>
    edge.from === 'src/local/cli.mjs' && edge.to === 'src/local/service.mjs'));
  assert.ok(current.production_import_edges.some(edge =>
    edge.from === 'src/local/service.mjs' && edge.to === 'src/local/app-setup.mjs'));
  assert.deepEqual(current.production_import_edges.filter(edge =>
    edge.to.startsWith('src/application/query/') && !edge.from.startsWith('src/application/query/')),
  [{ from: 'src/index.mjs', to: 'src/application/query/query-engine.mjs' }]);
  assert.deepEqual(current.production_import_edges.filter(edge =>
    edge.to === 'src/application/context/context-reader.mjs'), [
    { from: 'src/application/context/context-read-service.mjs', to: 'src/application/context/context-reader.mjs' },
    { from: 'src/application/query/query-contract.mjs', to: 'src/application/context/context-reader.mjs' },
    { from: 'src/application/query/query-inputs.mjs', to: 'src/application/context/context-reader.mjs' },
    { from: 'src/local/graph-store.mjs', to: 'src/application/context/context-reader.mjs' },
    { from: 'src/local/judge-inputs.mjs', to: 'src/application/context/context-reader.mjs' },
  ]);
  assert.equal(current.production_import_edges.filter(edge =>
    edge.from === 'src/application/context/context-reader.mjs').length, 8);
  const contextWriteNodes = new Set([
    'src/application/context/context-inputs.mjs',
    'src/application/context/context-store.mjs',
  ]);
  assert.deepEqual(current.production_import_edges.filter(edge =>
    contextWriteNodes.has(edge.from) || contextWriteNodes.has(edge.to)), [
    { from: 'src/application/context/context-inputs.mjs', to: 'src/core/context-profile.mjs' },
    { from: 'src/application/context/context-inputs.mjs', to: 'src/core/contracts.mjs' },
    { from: 'src/application/context/context-inputs.mjs', to: 'src/core/event-provenance.mjs' },
    { from: 'src/application/context/context-inputs.mjs', to: 'src/core/working-graph.mjs' },
    { from: 'src/application/context/context-inputs.mjs', to: 'src/domain/identity/access-authority.mjs' },
    { from: 'src/application/context/context-inputs.mjs', to: 'src/local/exploration-canonical.mjs' },
    { from: 'src/application/context/context-inputs.mjs', to: 'src/local/graph-inputs.mjs' },
    { from: 'src/application/context/context-read-service.mjs', to: 'src/application/context/context-inputs.mjs' },
    { from: 'src/application/context/context-store.mjs', to: 'src/local/graph-inputs.mjs' },
    { from: 'src/application/context/context-store.mjs', to: 'src/local/local-runtime-composition.mjs' },
    { from: 'src/index.mjs', to: 'src/application/context/context-store.mjs' },
    { from: 'src/local/graph-service-bundle.mjs', to: 'src/application/context/context-inputs.mjs' },
    { from: 'src/local/graph-store.mjs', to: 'src/application/context/context-inputs.mjs' },
    { from: 'src/local/judge-inputs.mjs', to: 'src/application/context/context-store.mjs' },
  ]);
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
