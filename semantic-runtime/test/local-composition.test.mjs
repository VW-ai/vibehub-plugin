import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CanonicalSourceReader } from '../src/local/canonical-source-reader.mjs';
import { LocalContextStore } from '../src/local/context-store.mjs';
import { LocalExplorationStore } from '../src/local/exploration-store.mjs';
import { LocalGraphStore } from '../src/local/graph-store.mjs';
import { LocalQueryEngine } from '../src/application/query/query-engine.mjs';
import { ContextReadService } from '../src/application/context/context-read-service.mjs';
import { graphCapabilityFor, graphGetHead } from '../src/local/graph-capability.mjs';
import { graphServiceBundle } from '../src/local/graph-service-bundle.mjs';
import { readerFixture } from './helpers/canonical-reader-fixture.mjs';

const configuration = f => ({
  repository_path: f.folder,
  execution: f.execution,
  registration_id: f.source.registration_id,
  selection: f.selection,
});
const invalid = fn => assert.throws(fn, error => error.code === 'invalid_graph_input');

test('local composition retains one proof-owning bundle per exact Graph and configuration identity', t => {
  const f = readerFixture(t), canonical_reader = configuration(f);
  const graph = new LocalGraphStore({ store: f.store, authority: f.authority });
  const first = graphServiceBundle({ graph, store: f.store, authority: f.authority, canonical_reader });
  assert.strictEqual(graphServiceBundle({ graph, store: f.store, authority: f.authority, canonical_reader }), first);
  assert.ok(first.contextReads instanceof ContextReadService);

  const equivalentConfiguration = structuredClone(canonical_reader);
  const equivalent = graphServiceBundle({ graph, store: f.store, authority: f.authority, canonical_reader: equivalentConfiguration });
  assert.notStrictEqual(equivalent, first);
  assert.notStrictEqual(equivalent.canonical, first.canonical);
  assert.notStrictEqual(equivalent.contextReads, first.contextReads);
  assert.equal(equivalent.canonical.config_digest, first.canonical.config_digest);

  const reopenedGraph = new LocalGraphStore({ store: f.store, authority: f.authority });
  const reopened = graphServiceBundle({ graph: reopenedGraph, store: f.store, authority: f.authority, canonical_reader });
  assert.notStrictEqual(reopened, first);
  assert.notStrictEqual(reopened.canonical, first.canonical);

  const mutableConfiguration = configuration(f);
  const beforeChange = graphServiceBundle({ graph, store: f.store, authority: f.authority, canonical_reader: mutableConfiguration });
  mutableConfiguration.selection.policy_id = 'changed-policy';
  const afterChange = graphServiceBundle({ graph, store: f.store, authority: f.authority, canonical_reader: mutableConfiguration });
  assert.notStrictEqual(afterChange, beforeChange);
  assert.notEqual(afterChange.canonical.config_digest, beforeChange.canonical.config_digest);
});

test('Graph capabilities are opaque and bound to the exact Graph, store and authority', t => {
  const f = readerFixture(t), graph = new LocalGraphStore({ store: f.store, authority: f.authority });
  const capability = graphCapabilityFor(graph, { store: f.store, authority: f.authority });
  const expected = graph.getHead(f.context, { generation_id: f.genesis.receipt.next_graph.generation_id });
  assert.deepEqual(graphGetHead(capability, f.context, { generation_id: expected.graph_revision.generation_id }), expected);

  invalid(() => graphCapabilityFor(graph, { store: {}, authority: f.authority }));
  invalid(() => graphCapabilityFor(graph, { store: f.store, authority: {} }));
  for (const forged of [{}, { ...capability }, new Proxy(capability, {})]) {
    invalid(() => graphGetHead(forged, f.context, { generation_id: expected.graph_revision.generation_id }));
  }
  const canonical_reader = configuration(f);
  graphServiceBundle({ graph, store: f.store, authority: f.authority, canonical_reader });
  invalid(() => graphServiceBundle({ graph, store: {}, authority: f.authority, canonical_reader }));
  invalid(() => graphServiceBundle({ graph, store: f.store, authority: {}, canonical_reader }));
});

test('canonical, exploration and Context services do not import or construct LocalGraphStore', () => {
  for (const path of ['../src/local/canonical-source-reader.mjs', '../src/local/exploration-canonical.mjs',
    '../src/local/context-inputs.mjs', '../src/application/context/context-read-service.mjs']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from\s+['"][^'"]*graph-store\.mjs['"]/);
    assert.doesNotMatch(source, /new\s+LocalGraphStore\b/);
  }
});

test('public local constructors keep their one-options-object contract', () => {
  for (const Constructor of [CanonicalSourceReader, LocalGraphStore, LocalExplorationStore, LocalContextStore, LocalQueryEngine]) {
    assert.equal(Constructor.length, 1, Constructor.name);
  }
});

test('CanonicalSourceReader preserves owner errors separately from malformed inert configuration', t => {
  const f = readerFixture(t), options = { store: f.store, authority: f.authority, ...configuration(f) };
  assert.throws(() => new CanonicalSourceReader({ ...options, store: {} }), { code: 'invalid_canonical_reader_input' });
  assert.throws(() => new CanonicalSourceReader({ ...options, authority: {} }), { code: 'invalid_canonical_reader_input' });
  assert.throws(() => new CanonicalSourceReader({ ...options, execution: { ...f.execution, extra: true } }), { code: 'invalid_graph_input' });
  assert.throws(() => new CanonicalSourceReader({ ...options, selection: { ...f.selection, extra: true } }), { code: 'invalid_graph_input' });
});
