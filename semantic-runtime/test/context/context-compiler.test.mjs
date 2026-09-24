import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalContextCompiler, validateContextPackage } from '../../src/index.mjs';
import { queryFixture, publish, canonicalRefs, adoption } from '../support/query-fixture.mjs';
import { records, writeRecords, git } from '../support/exploration-fixture.mjs';

function compilerRequest(f, {
  query = {}, max_tokens = 65536, profile_id = 'codex-large', context_window_tokens = 131072,
  callbacks = true, hard_injection = false, requested_mode = 'soft', reasons = ['task_context_available'],
} = {}) {
  return {
    schema_version: 1,
    query: f.queryRequest({ budget: { max_results: 1, token_budget: 262144 }, ...query }),
    compiler: { policy_id: 'runtime-context-package', policy_version: '1' },
    window_profile: { profile_id, context_window_tokens, reserved_output_tokens: 4096 },
    capabilities: { callbacks, hard_injection, markdown: true, source_links: true },
    budget: { max_tokens }, injection: { requested_mode, reasons },
  };
}

const layer = (result, id) => result.layers.find(entry => entry.id === id);

test('one real Query snapshot compiles fixed layers and keeps other explorations as awareness', async t => {
  const f = await queryFixture(t, { canonical: true });
  f.explorations.setProjectSelection(f.context, { epoch: f.epoch, idempotency_key: 'compiler-project-selection',
    expected_version: null, pin: { at: f.canonical.graph_revision, address: f.canonical.address,
      record_keys: ['decision', 'constraint', 'ticket', 'evidence'] } });
  publish(f, 'compiler-evidence', { typed: { role: 'evidence', summary: 'Compiler test evidence', detail: 'Focused tests passed.' } });
  const related = publish(f, 'related-alternative', { typed: { role: 'decision', summary: 'Try the cloud alternative',
    detail: 'This remains an unadopted branch observation.' } }, f.b);
  const task = canonicalRefs(f, 'ticket').ticket;
  const request = compilerRequest(f, { query: { consumer: { consumer_id: 'compiler-consumer', session_id: 'compiler-session', task },
    scope: { tickets: [task], rooms: [], repositories: [] }, related: [f.querySelection(f.b)] }, requested_mode: 'hard', hard_injection: true });
  const result = await new LocalContextCompiler({ query_engine: f.engine }).compile(f.context, request);

  assert.deepEqual(result.layers.map(entry => entry.id), [
    'governing_context', 'task_contract', 'decisions_and_constraints', 'working_state',
    'evidence', 'unresolved', 'other_exploration_awareness', 'source_pointers',
  ]);
  assert(layer(result, 'governing_context').items.some(item => /source/i.test(item.title)));
  assert(layer(result, 'task_contract').items.some(item => item.title === 'example'));
  assert(layer(result, 'evidence').items.some(item => item.title === 'Compiler test evidence'));
  const awareness = layer(result, 'other_exploration_awareness').items.find(item => item.title === 'Try the cloud alternative');
  assert(awareness); assert.equal(awareness.status, 'candidate');
  assert(layer(result, 'source_pointers').items.some(pointer => JSON.stringify(pointer).includes(related.revision.revision_digest)));
  assert.equal(result.recommendation.executable, false);
  assert.equal(result.recommendation.mode, 'soft');
  assert(result.recommendation.reasons.includes('hard_injection_requires_stable_context'));
  assert(!JSON.stringify(result).includes('work_request'));
  assert.deepEqual(validateContextPackage(result), result); assert(Object.isFrozen(result));
  const tampered = structuredClone(result); tampered.rank_digest = `sha256:${'f'.repeat(64)}`;
  assert.throws(() => validateContextPackage(tampered), { code: 'context_package_identity_mismatch' });
});

test('deterministic budgeting deduplicates meaning, retains every source pointer, and varies by window profile', async t => {
  const f = await queryFixture(t);
  for (const name of ['duplicate-a', 'duplicate-b']) publish(f, name, { typed: { role: 'decision',
    summary: 'Use one deterministic compiler', detail: 'Equivalent content should be materialized once.' } });
  for (let index = 0; index < 5; index++) publish(f, `long-observation-${index}`, { typed: { role: 'observation',
    summary: `Long observation ${index}`, detail: `${index}:` + ' bounded compiler detail'.repeat(220) } });
  const compiler = new LocalContextCompiler({ query_engine: f.engine });
  const largeRequest = compilerRequest(f);
  const first = await compiler.compile(f.context, largeRequest), second = await compiler.compile(f.context, largeRequest);
  assert.equal(first.package_id, second.package_id);
  assert(first.omissions.some(entry => entry.reason === 'semantic_duplicate'));
  const deduplicated = layer(first, 'decisions_and_constraints').items.filter(item => item.title === 'Use one deterministic compiler');
  assert.equal(deduplicated.length, 1); assert.equal(deduplicated[0].pointer_keys.length, 2);
  const referencedPointers = new Set(first.layers.slice(0, -1).flatMap(entry => entry.items.flatMap(item => item.pointer_keys)));
  assert.equal(layer(first, 'source_pointers').items.length, referencedPointers.size);

  const compactRequest = compilerRequest(f, { max_tokens: 28000, profile_id: 'claude-compact', context_window_tokens: 65536 });
  const compact = await compiler.compile(f.context, compactRequest);
  assert(compact.usage.used_tokens <= 28000);
  assert(compact.omissions.some(entry => entry.reason === 'text_budget'));
  assert([...compact.layers].flatMap(entry => entry.items).some(item => item.text_state === 'pointer'));
  assert.equal(layer(compact, 'source_pointers').items.length, layer(first, 'source_pointers').items.length);
  assert.notEqual(compact.package_id, first.package_id);
});

test('conflicts, stale shared bases, unavailable canonical state, and no-callback consumers remain explicit', async t => {
  const f = await queryFixture(t, { canonical: true });
  const base = publish(f, 'compiler-conflict-base');
  publish(f, 'compiler-conflict-left', { base: base.revision, typed: { summary: 'Keep the local worker', detail: 'Local path.' } });
  publish(f, 'compiler-conflict-right', { base: base.revision, typed: { summary: 'Use a cloud worker', detail: 'Cloud path.' } });
  const next = records(); next.decision.summary = 'Updated canonical decision';
  writeRecords(f.folder, next); git(f.folder, 'add', '.'); git(f.folder, 'commit', '-m', 'update compiler canonical fixture');
  f.captureCanonical(f.canonical, 'compiler-canonical-update');
  const result = await new LocalContextCompiler({ query_engine: f.engine }).compile(f.context,
    compilerRequest(f, { callbacks: false, requested_mode: 'hard' }));
  const conflict = layer(result, 'unresolved').items.find(item => item.status === 'contested');
  assert(conflict); assert.equal(conflict.variants.length, 2);
  assert(conflict.variants.every(variant => variant.pointer_keys.length === 1));
  assert(result.pins.shared_bases.some(basePin => basePin.status === 'historical' && basePin.update_available));
  assert.equal(result.capabilities.callbacks, false); assert.equal(result.recommendation.mode, 'soft');

  const unavailable = await queryFixture(t);
  const packageWithoutCanonical = await new LocalContextCompiler({ query_engine: unavailable.engine }).compile(unavailable.context,
    compilerRequest(unavailable, { callbacks: false, requested_mode: 'hard' }));
  assert(packageWithoutCanonical.pins.shared_bases.every(basePin => basePin.status === 'unavailable'));
  assert.equal(packageWithoutCanonical.recommendation.mode, 'soft');
});

test('package pointers survive later Graph changes while exact retrieval rechecks current source permission', async t => {
  const f = await queryFixture(t), compiler = new LocalContextCompiler({ query_engine: f.engine });
  const result = await compiler.compile(f.context, compilerRequest(f));
  const pointer = layer(result, 'source_pointers').items.find(item => item.kind === 'semantic_context' && item.ref);
  assert(pointer);
  publish(f, 'later-graph-change');
  const own = f.querySelection(f.binding, { mode: 'as_of', at: result.pins.scopes[0].selected });
  const exactRequest = f.queryRequest({ request_id: 'compiler-exact-retrieval', own, exact: [{ exploration_id: own.exploration_id, address: pointer.ref }],
    expected_source_fence: f.feed.head(f.context).sequence });
  const exact = await f.engine.query(f.context, exactRequest);
  assert(exact.items.some(item => item.ref.revision_digest === pointer.ref.revision_digest));

  f.ingress.updateSourceAccess(f.context, { registration_id: f.supportSource.registration_id,
    expectedVersion: f.supportSource.version, access: { ...f.supportSource.registration.access, allowed_principal_ids: [] } });
  const denied = f.queryRequest({ request_id: 'compiler-exact-retrieval-denied', own,
    exact: [{ exploration_id: own.exploration_id, address: pointer.ref }], expected_source_fence: f.feed.head(f.context).sequence });
  await assert.rejects(f.engine.query(f.context, denied), error => typeof error.code === 'string');
});

test('selected adoption lineage remains an explicit package inclusion reason without importing a foreign body', async t => {
  const f = await queryFixture(t), source = publish(f, 'compiler-lineage-source', { typed: {
    summary: 'Foreign source wording', detail: 'Only the explicitly selected source may become visible.' } });
  const adopted = f.contexts.adopt(f.context, adoption(f, { source, key: 'compiler-lineage-adoption' }));
  const query = { own: f.querySelection(f.b), lineage: { address: adopted.revision, cursor: null } };
  const result = await new LocalContextCompiler({ query_engine: f.engine }).compile(f.context, compilerRequest(f, { query }));
  assert(result.pins.lineage.links.some(link => link.role === 'adoption_source'));
  const pointer = layer(result, 'source_pointers').items.find(entry => entry.source_reasons.some(reason => reason.kind === 'lineage'));
  assert(pointer);
  const selected = result.layers.slice(0, -1).flatMap(entry => entry.items).find(item => item.pointer_keys.includes(pointer.key));
  assert(selected);
  assert(!JSON.stringify(result.pins.lineage).includes('Foreign source wording'));
});

test('compiler accepts only the actual Query capability', () => {
  assert.throws(() => new LocalContextCompiler({ query_engine: { query() {} } }), { code: 'context_compiler_query_binding_mismatch' });
});
