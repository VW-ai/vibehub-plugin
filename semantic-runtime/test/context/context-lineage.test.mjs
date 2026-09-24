import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, publish, head, read, selectedInput, adoption, boundedFailure, rows, register, capture, CONTEXT_ACTIONS } from '../support/context-fixture.mjs';

test('current and exact local as-of views distinguish immutable assertion state from the selected projection', t => {
  const f = fixture(t), first = publish(f, 'initial'), second = publish(f, 'corrected', { base: first.revision, status: 'validated' });
  const current = read(f, f.a, first);
  assert.equal(current.local.status, 'resolved'); assert.equal(current.local.item.assertion_status, 'candidate');
  assert.equal(current.local.item.historical_role, 'historical'); assert.deepEqual(current.local.item.projection.head, second.revision);
  const historical = read(f, f.a, first, { at: first.receipt.next_graph, mode: 'as_of' });
  assert.equal(historical.local.item.historical_role, 'head'); assert.deepEqual(historical.selection.at, first.receipt.next_graph);
  assert.deepEqual(historical.selection.observed_head, second.receipt.next_graph);
  boundedFailure(() => read(f, f.a, first, { at: first.receipt.next_graph, mode: 'current' }));
  const missing = read(f, f.a, first, { address: { ...first.revision, revision_digest: `sha256:${'0'.repeat(64)}` } });
  assert.equal(missing.local.status, 'not_found'); assert.equal(missing.local.item, null);
});

test('lineage keeps base and supporting-parent roles separate and paginates direct links', t => {
  const f = fixture(t), first = publish(f, 'origin'), revised = publish(f, 'revised', { base: first.revision, parents: [first.revision] });
  const query = { ...selectedInput(f, f.a, revised), cursor: null, limit: 1 }, seen = [];
  let cursor = null, loops = 0;
  do {
    const page = f.contexts.lineage(f.context, { ...query, cursor });
    assert.equal(page.local.root.meaning.summary, 'Synthetic revised'); assert(page.local.links.length <= 1);
    seen.push(...page.local.links); cursor = page.local.next_cursor; assert(++loops < 10);
  } while (cursor);
  for (const role of ['base', 'parent']) {
    const link = seen.find(link => link.role === role); assert(link); assert.equal(link.availability, 'available');
    assert.deepEqual(link.ref, first.revision); assert.equal(link.item.meaning.summary, 'Synthetic origin');
  }
  assert(seen.some(link => link.role === 'publication'));
  const full = f.contexts.lineage(f.context, { ...query, limit: 16 }); assert.deepEqual(seen, full.local.links);
});

test('adopted Context reports actual B transition and exact A source instead of reinterpreting copied change', t => {
  const f = fixture(t), first = publish(f, 'source'), result = f.contexts.adopt(f.context, adoption(f, { source: first, key: 'typed-adoption' }));
  const readB = read(f, f.b, result).local.item;
  assert.equal(readB.meaning.change.kind, 'create'); assert.equal(readB.transition.kind, 'adopt');
  assert.equal(readB.transition.structural_reason, 'explicit_adoption'); assert.equal(readB.transition.reason.status, 'not_recorded');
  assert.equal(readB.transition.reason.text, null); assert.equal(readB.publication.exploration_id, f.b.exploration_id);
  const lineage = f.contexts.lineage(f.context, { ...selectedInput(f, f.b, result), cursor: null, limit: 16 });
  const origin = lineage.local.links.find(link => link.role === 'adoption_source'); assert(origin);
  assert.deepEqual(origin.ref, first.revision); assert.equal(origin.item.publication.operation_origin_ref, first.operation_origin_ref);
  assert.equal(origin.item.publication.exploration_id, f.a.exploration_id);
});

test('an independently readable correction exposes no denied old-base text or actor', t => {
  const f = fixture(t), source = register(f, { partition: 'secret-base', principals: ['owner'] });
  const event = capture(f, source, { key: 'secret-base', principals: ['owner'] });
  const old = publish(f, 'private-canary', { events: [event], typed: { detail: 'NEVER_RETURN_PRIVATE_BASE_CANARY' } });
  f.context = f.issue({ principal: 'reader', actions: CONTEXT_ACTIONS }).context;
  f.publisher = f.graph.registerPublisherRun(f.context, { epoch: f.epoch, run_key: 'fresh-public-correction' });
  const corrected = publish(f, 'fresh', { base: old.revision });
  const response = f.contexts.lineage(f.context, { ...selectedInput(f, f.a, corrected), cursor: null, limit: 16 });
  const base = response.local.links.find(link => link.role === 'base'); assert(base);
  assert.equal(base.availability, 'unavailable'); assert(!Object.hasOwn(base, 'item'));
  assert(!JSON.stringify(response).includes('NEVER_RETURN_PRIVATE_BASE_CANARY'));
});

test('typed heads page counts underlying candidates and can return empty page plus continuation', t => {
  const f = fixture(t), first = publish(f, 'one'), second = publish(f, 'two');
  const query = { exploration_id: f.a.exploration_id, at: head(f), mode: 'as_of', collection: { kind: 'heads' }, limit: 1, cursor: null };
  const initial = f.contexts.page(f.context, query); assert.deepEqual(initial.local.items, []); assert(initial.local.next_cursor);
  const found = [], before = rows(f); let cursor = initial.local.next_cursor, loops = 0;
  do {
    const page = f.contexts.page(f.context, { ...query, cursor }); assert(page.local.items.length <= 1);
    found.push(...page.local.items.map(item => item.ref)); cursor = page.local.next_cursor; assert(++loops < 6);
  } while (cursor);
  assert.deepEqual(found, [first.revision, second.revision]); assert.deepEqual(rows(f), before);
  boundedFailure(() => f.contexts.page(f.context, { ...query, cursor: initial.local.next_cursor, collection: { kind: 'history', entity_kind: 'entity', entity_id: first.revision.entity_id } }));
  boundedFailure(() => f.contexts.page(f.context, { ...query, limit: 17 }));
});

test('current-mode continuation refuses head movement while exact as-of continuation retains original selection', t => {
  const f = fixture(t); publish(f, 'one'); publish(f, 'two');
  const at = head(f), query = { exploration_id: f.a.exploration_id, at, mode: 'current', collection: { kind: 'heads' }, limit: 1, cursor: null };
  const current = f.contexts.page(f.context, query), historical = f.contexts.page(f.context, { ...query, mode: 'as_of' });
  publish(f, 'later');
  boundedFailure(() => f.contexts.page(f.context, { ...query, cursor: current.local.next_cursor }));
  const next = f.contexts.page(f.context, { ...query, mode: 'as_of', cursor: historical.local.next_cursor });
  assert.deepEqual(next.selection.at, at); assert.deepEqual(next.selection.observed_head, head(f));
});

test('historical local selection retains read-time Project Authority overlay without pretending global historical state', t => {
  const f = fixture(t, { canonical: true }), first = publish(f, 'local-constraint', { typed: { role: 'constraint' } });
  const original = read(f, f.a, first); assert.equal(original.shared.current_project.version, null);
  f.explorations.setProjectSelection(f.context, { epoch: f.epoch, idempotency_key: 'declare-project', expected_version: null,
    pin: { at: f.canonical.graph_revision, address: f.canonical.address, record_keys: ['decision'] } });
  const result = read(f, f.a, first, { at: first.receipt.next_graph, mode: 'as_of' });
  assert.equal(result.shared.current_project.version, 1); assert.equal(result.shared.origin_base.status, 'unavailable');
  assert(result.shared.current_project.authority_record_keys.includes('authority'));
  assert(result.shared.current_project.data.records.some(record => record.key === 'authority' && record.record.type === 'authority'));
  assert.equal(result.local.item.meaning.role, 'constraint'); assert(!Object.hasOwn(result.local.item, 'governing'));
  assert.deepEqual(result.selection.at, first.receipt.next_graph);
});

test('history and conflict pages retain actual competing transitions and resolution lineage', t => {
  const f = fixture(t), first = publish(f, 'base'), second = publish(f, 'left', { base: first.revision });
  const competing = publish(f, 'right', { base: first.revision }), at = head(f);
  const collection = { kind: 'conflicts', entity: { entity_kind: 'entity', entity_id: first.revision.entity_id } };
  const query = { exploration_id: f.a.exploration_id, at, mode: 'as_of', cursor: null, limit: 16 };
  const conflictPage = f.contexts.page(f.context, { ...query, collection });
  assert.equal(conflictPage.local.items.length, 1);
  const conflict = conflictPage.local.items[0].conflict;
  assert(conflict.assertions.some(ref => JSON.stringify(ref) === JSON.stringify(second.revision)));
  assert(conflict.assertions.some(ref => JSON.stringify(ref) === JSON.stringify(competing.revision)));
  const conflictLineage = f.contexts.lineage(f.context, { ...selectedInput(f, f.a, competing), cursor: null, limit: 16 });
  assert.equal(conflictLineage.local.root.historical_role, 'competing');
  assert.equal(conflictLineage.local.root.projection.status, 'contested');
  assert.deepEqual(conflictLineage.local.links.find(link => link.role === 'conflict').fact, conflict);
  const resolved = publish(f, 'resolved', { base: second.revision, status: 'resolved', change: 'resolve',
    parents: conflict.assertions, operation_kind: 'resolve', conflict_digest: conflict.conflict_digest });
  assert.deepEqual(f.contexts.page(f.context, { ...query, at: head(f), collection }).local.items, []);
  assert.equal(f.contexts.page(f.context, { ...query, collection }).local.items.length, 1,
    'historical conflict remains a historical fact');
  const lineage = f.contexts.lineage(f.context, { ...selectedInput(f, f.a, resolved), cursor: null, limit: 16 });
  const resolution = lineage.local.links.find(link => link.role === 'resolution');
  assert.equal(resolution.availability, 'available'); assert.deepEqual(resolution.fact.resolution.resolution, resolved.revision);
  const history = f.contexts.page(f.context, { ...query, at: head(f), collection: { kind: 'history', entity_kind: 'entity', entity_id: first.revision.entity_id } });
  assert.deepEqual(history.local.items.map(item => item.ref), [first.revision, second.revision, competing.revision, resolved.revision]);
  assert.equal(history.local.items.at(-1).transition.kind, 'resolve');
  assert.equal(history.local.items.at(-1).transition.reason.status, 'recorded');
});

test('unspecified applicability is explicitly uncertain and continuation pins current Project and source policy', async t => {
  for (const kind of ['project', 'source']) await t.test(kind, t => {
    const f = fixture(t, { canonical: kind === 'project' }), first = publish(f, 'uncertain'), second = publish(f, 'other');
    const item = read(f, f.a, first).local.item;
    assert.equal(item.applicability.status, 'uncertain'); assert.deepEqual(item.applicability.uncertain_dimensions, ['tickets', 'code']);
    assert.equal(item.applicability.project, 'owning'); assert.equal(item.applicability.exploration, 'owning');
    assert.equal(item.transition.reason.text, 'Explicit synthetic create');
    const query = { exploration_id: f.a.exploration_id, at: second.receipt.next_graph, mode: 'as_of', collection: { kind: 'heads' }, cursor: null, limit: 1 };
    const page = f.contexts.page(f.context, query); assert(page.local.next_cursor);
    if (kind === 'project') f.explorations.setProjectSelection(f.context,
      { epoch: f.epoch, idempotency_key: 'cursor-project', expected_version: null,
        pin: { at: f.canonical.graph_revision, address: f.canonical.address, record_keys: ['decision'] } });
    else f.ingress.updateSourceAccess(f.context, { registration_id: f.source.registration_id, expectedVersion: f.source.version,
      access: { ...f.source.registration.access, allowed_principal_ids: [] } });
    const before = rows(f); boundedFailure(() => f.contexts.page(f.context, { ...query, cursor: page.local.next_cursor }));
    assert.deepEqual(rows(f), before);
  });
});
