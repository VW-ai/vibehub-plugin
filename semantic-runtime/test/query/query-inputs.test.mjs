import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryInputs } from '../../src/application/query/query-inputs.mjs';
import { LocalContextStore } from '../../src/application/context/context-store.mjs';
import { fixture, CONTEXT_ACTIONS, publish, head, rows, adoption, canonicalRefs, gitCodeRef, bind } from '../support/context-fixture.mjs';
import { pin } from '../support/exploration-fixture.mjs';

const actions = [...CONTEXT_ACTIONS, 'query:read'];
const rejected = (fn, code) => assert.throws(fn, error => typeof error.code === 'string' && (!code || error.code === code));
function setup(t, options = {}) {
  const f = fixture(t, options); Object.assign(f, f.issue({ actions }));
  if (options.canonical) f.a = bind(f, { key: 'query-canonical-origin', shared_base: pin(f.canonical, []) });
  f.inputs = new QueryInputs({ store: f.store, authority: f.authority, canonical_reader: f.config });
  f.selection = (binding = f.a, extra = {}) => {
    const at = head(f, binding), selected = f.explorations.getSelection(f.context, { exploration_id: binding.exploration_id, at });
    return { exploration_id: binding.exploration_id, at, mode: 'current', expected_shared_base: selected.shared.origin_base.pin, heads_cursor: null, ...extra };
  };
  f.request = (extra = {}) => ({ schema_version: 1, request_id: 'input-window', consumer: { consumer_id: 'input-test', session_id: null, task: null },
    own: f.selection(), related: [], expected_project_selection_version: null, expected_source_fence: f.feed.head(f.context).sequence,
    exact: [], lineage: null, text: { value: '', match: 'all_terms' }, scope: { tickets: [], rooms: [], repositories: [] }, seen_refs: [],
    freshness: { minimum_watermarks: [], max_commit_lag: null, allow_unknown_coverage: true },
    budget: { max_results: 16, token_budget: 262144 }, judge: null, ...extra });
  return f;
}

test('QueryInputs selects exact typed facts and publication sequences without mutation or nested public reads', t => {
  const f = setup(t), first = publish(f, 'query-first'), second = publish(f, 'query-second', { parents: [first.revision] });
  const request = f.request({ exact: [{ exploration_id: f.a.exploration_id, address: first.revision }], lineage: { address: second.revision, cursor: null } });
  const before = rows(f), p = f.inputs.prepare(f.context, request);
  assert.equal(p.candidates.length, 2); assert.equal(p.coverage.kind, 'selected_window');
  const selected = p.candidates.find(c => c.ref.entity_id === first.revision.entity_id);
  assert.deepEqual(selected.ref, first.revision); assert.equal(selected.publication.origin_ref, first.operation_origin_ref);
  assert(selected.source_reasons.some(r => r.kind === 'exact')); assert(selected.source_reasons.some(r => r.kind === 'lineage'));
  assert(selected.publication.sequence < selected.selected_sequence);
  assert(p.lineage.links.every(link => !Object.hasOwn(link, 'item')));
  t.mock.method(LocalContextStore.prototype, 'resolve', () => { throw Error('Nested public Context call'); });
  assert.equal(f.inputs.assertCurrent(f.context, p), p);
  assert(Object.isFrozen(p.candidates[0].item.meaning)); rejected(() => f.inputs.assertCurrent(f.context, structuredClone(p)), 'invalid_query_proof');
  assert.deepEqual(rows(f), before);
});

test('canonical Ticket and immutable Room/repository scope are proved alongside mandatory Authority', t => {
  const f = setup(t, { canonical: true }), ticket = canonicalRefs(f), room = canonicalRefs(f, 'room'), code = gitCodeRef(f);
  const target = publish(f, 'scoped-query', { canonical_refs: [ticket.artifact, code.artifact], typed: { applicability: {
    project: 'owning', exploration: 'owning', tickets: { mode: 'exact', refs: [ticket.ticket] }, code: { mode: 'exact', refs: [code.ref] } } } });
  const p = f.inputs.prepare(f.context, f.request({ consumer: { consumer_id: 'input-test', session_id: null, task: ticket.ticket },
    scope: { tickets: [], rooms: [room.ticket], repositories: [code.object.repository_id] } }));
  const candidate = p.candidates.find(c => c.ref.entity_id === target.revision.entity_id);
  assert.equal(candidate.scope_match.status, 'matched'); assert.equal(candidate.scope_match.verified_dimensions, 3);
  assert.equal(p.filters.task.ticket_id, 'example'); assert.deepEqual(p.filters.rooms[0].anchors, ['src']);
  assert.equal(p.filters.rooms[0].git.commit_oid, code.object.oid);
  assert.equal(p.shared.mandatory_authority_keys.length, 1);
  assert.equal(p.shared.documents.find(d => d.key === p.shared.mandatory_authority_keys[0]).record.type, 'authority');
  f.inputs.assertCurrent(f.context, p);
});

test('declared any code applicability permits a requested Room without claiming exact proof', t => {
  const f = setup(t, { canonical: true }), room = canonicalRefs(f, 'room');
  const target = publish(f, 'room-any', { typed: { applicability: { project: 'owning', exploration: 'owning',
    tickets: { mode: 'unspecified', refs: [] }, code: { mode: 'any', refs: [] } } } });
  const p = f.inputs.prepare(f.context, f.request({ scope: { tickets: [], rooms: [room.ticket], repositories: [] } }));
  const candidate = p.candidates.find(c => c.ref.entity_id === target.revision.entity_id);
  const roomDimension = candidate.scope_match.dimensions.find(d => d.dimension === 'rooms');
  assert.equal(roomDimension.status, 'any'); assert.equal(candidate.scope_match.verified_dimensions, 0);
});

test('unselected foreign lineage bodies are stripped while explicit related Context stays a notice', t => {
  const f = setup(t), source = publish(f, 'foreign-lineage', { typed: { summary: 'Foreign selected secret marker.' } });
  const adopted = f.contexts.adopt(f.context, adoption(f, { source, key: 'query-adopt' }));
  const request = f.request({ own: f.selection(f.b), lineage: { address: adopted.revision, cursor: null } });
  const p = f.inputs.prepare(f.context, request);
  assert(p.candidates.every(c => c.exploration_id === f.b.exploration_id));
  const sourceLink = p.lineage.links.find(link => link.role === 'adoption_source');
  assert(sourceLink); assert.equal(Object.hasOwn(sourceLink, 'item'), false); assert.equal(JSON.stringify(sourceLink).includes('Foreign selected secret marker.'), false);
  const related = f.inputs.prepare(f.context, { ...request, related: [f.selection(f.a)] });
  const notice = related.candidates.find(c => c.ref.entity_id === source.revision.entity_id && c.layer === 'notice');
  assert(notice); assert.equal(notice.exploration_id, f.a.exploration_id);
  assert.notEqual(notice.key, related.candidates.find(c => c.layer === 'own').key);
});

test('original opaque grant and current source/head pins govern retained Query material', t => {
  const f = setup(t), target = publish(f, 'current-source'), p = f.inputs.prepare(f.context, f.request());
  const replacement = f.issue({ actions }).context;
  rejected(() => f.inputs.assertCurrent(replacement, p), 'query_unauthorized');
  publish(f, 'next-head'); rejected(() => f.inputs.assertCurrent(f.context, p), 'query_selection_changed');
  const selected = f.inputs.prepare(f.context, f.request({ own: f.selection(f.a, { at: target.receipt.next_graph, mode: 'as_of' }) }));
  assert.equal(selected.candidates.find(c => c.ref.entity_id === target.revision.entity_id).item.assertion_status, 'candidate');
  f.ingress.updateSourceAccess(f.context, { registration_id: f.source.registration_id, expectedVersion: f.source.version,
    access: { ...f.source.registration.access, allowed_principal_ids: [] } });
  rejected(() => f.inputs.assertCurrent(f.context, selected));
});
