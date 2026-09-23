import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  WORKING_GRAPH_CONTRACT_VERSION, SEMANTIC_STATES, validateWorkingGraph, validateGraphRevision, validateGraphRevisionAddress,
  validateSemanticRevision, validateSemanticAddress, validateGraphConflict, validateProvenanceClosure,
  createWorkingGraph, graphRevisionAddress, semanticAddress, exactRevisionAddress, canonicalArtifactAddress,
  applyGraphAssertion, resolveGraphConflict, updateGraphSourceAccess, resolveWorkingGraphAddress, validateWorkerGraphInput,
} from '../src/domain/graph/working-graph.mjs';
import { graph, assertion, apply, event, scope, catalog, watermarks } from './fixtures/working-graph/scenario.mjs';
const clone = structuredClone;
function rehashSnapshot(snapshot) {
  const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  delete snapshot.snapshot_digest;
  snapshot.snapshot_digest = `sha256:${createHash('sha256').update(JSON.stringify(canonical(snapshot))).digest('hex')}`;
}

const head = state => state.snapshots.at(-1);
const read = (state, address, options = {}) => resolveWorkingGraphAddress(state, address, { principal_id: 'alice', current_graph: state, ...options });
const logical = (id = 'context-a', entity_kind = 'entity') => semanticAddress({ scope, generation_id: 'live-1', entity_kind, entity_id: id });
function conflictFixture() {
  const first = apply(graph(), assertion());
  const second = apply(first.state, assertion('b', { base_revision: first.revision, status: 'validated', content: { semantic_type: 'constraint', data: { text: 'API v2' } } }));
  const third = apply(second.state, assertion('c', { base_revision: first.revision, execution_id: 'attempt-b', events: [event('web')], content: { semantic_type: 'constraint', data: { text: 'API v3' } } }));
  return { first, second, third };
}
function relation(state, from, to) {
  return apply(state, assertion('relation', { entity_kind: 'relation', entity_id: 'supports-a', content: { relation_type: 'SUPPORTS', from, to, data: {} }, events: [] }));
}
function lifecycle(state, type = 'access.changed', access_state = 'active', extra = () => {}) {
  const e = event('api', 1, raw => { raw.source_event_type = type; raw.acl.revision = 'acl-8'; raw.provenance.source_objects[0].acl.revision = 'repo-acl-4';
    raw.provenance.source_objects[0].acl.allowed_principal_ids = ['alice']; extra(raw); });
  return updateGraphSourceAccess(state, { expected_graph: graphRevisionAddress(state), event: e, access_state });
}

test('versioned strict contracts preserve exact source, identity, generation and freshness contracts', () => {
  assert.equal(WORKING_GRAPH_CONTRACT_VERSION, 1); const state = graph(); assert.equal(validateWorkingGraph(state), true);
  assert.equal(validateGraphRevision(head(state)), true); assert.equal(validateGraphRevisionAddress(graphRevisionAddress(state)), true);
  assert.equal(head(state).watermarks.watermarks.length, 2); assert.equal(head(state).watermarks.status, 'caught-up');
  const r = apply(state, assertion()); const revision = head(r.state).revisions[0];
  assert.equal(validateSemanticRevision(revision), true); assert.equal(validateProvenanceClosure(revision.provenance), true);
  assert.deepEqual(exactRevisionAddress(revision), r.revision); assert.equal(validateSemanticAddress(logical()), true);
  for (const mutate of [x => x.schema_version = 2, x => x.unknown = true, x => x.scope.project_id = 'shared', x => x.generation_id = 'elsewhere']) {
    const s = clone(r.state); mutate(s); assert.throws(() => validateWorkingGraph(s));
  }
  assert.throws(() => createWorkingGraph({ catalog: catalog(), scope: { ...scope, project_id: 'unknown' }, generation_id: 'x', watermarks: watermarks() }), /scope|unmapped/);
});

test('immutable snapshots and exact addresses reproduce old content after later compatible writes', () => {
  const original = graph(); const saved = clone(original); const a = apply(original, assertion());
  const b = apply(a.state, assertion('web', { entity_id: 'context-web', execution_id: 'attempt-b', events: [event('web')] }));
  const c = apply(b.state, assertion('new', { base_revision: a.revision, status: 'validated', content: { semantic_type: 'constraint', data: { text: 'new text' } } }));
  assert.deepEqual(original, saved); assert.equal(Object.isFrozen(c.state.snapshots[1]), true);
  assert.deepEqual(c.state.snapshots[1], head(a.state));
  assert.equal(read(c.state, a.revision).revision.assertion.content.data.text, 'API remains v1');
  assert.equal(read(c.state, logical()).revision.assertion.content.data.text, 'new text');
  assert.equal(read(c.state, logical(), { graph_revision: a.graph_revision }).revision.assertion.content.data.text, 'API remains v1');
  assert.equal(read(c.state, { ...a.revision, revision_digest: `sha256:${'0'.repeat(64)}` }).status, 'unavailable');
  assert.throws(() => read(c.state, { ...a.revision, scope: { ...scope, tenant_id: 'other' } }), /scope/);
  assert.throws(() => read(c.state, { ...a.revision, generation_id: 'replay-2' }), /generation/);
});

test('transaction CAS mismatch is unapplied and preserves the proposal, separate from semantic conflict', () => {
  const start = graph(); const a = apply(start, assertion()); const proposal = { expected_graph: graphRevisionAddress(start), assertion: assertion('late') };
  const failed = applyGraphAssertion(a.state, proposal); assert.equal(failed.status, 'graph_revision_mismatch');
  assert.deepEqual(failed.state, a.state); assert.deepEqual(failed.proposal, proposal); assert.equal(head(failed.state).conflicts.length, 0);
  const accepted = apply(a.state, assertion('late')); assert.equal(accepted.status, 'applied'); assert.ok(accepted.conflict);
  assert.equal(head(accepted.state).revisions.length, 2);
});

test('semantic base mismatch preserves both assertions and explicit conflict resolution includes every parent', () => {
  const { first, second, third } = conflictFixture(); const e = head(third.state).entities[0];
  assert.equal(e.status, 'contested'); assert.deepEqual(e.head, second.revision); assert.deepEqual(e.competing, [second.revision, third.revision]);
  assert.equal(validateGraphConflict(third.conflict), true); assert.equal(read(third.state, logical()).conflicts.length, 1);
  const resolution = assertion('resolve', { base_revision: second.revision, parents: [second.revision, third.revision], status: 'resolved', events: [], content: { semantic_type: 'constraint', data: { text: 'explicit resolution v2' } } });
  assert.throws(() => apply(third.state, resolution), /explicit conflict/);
  assert.throws(() => resolveGraphConflict(third.state, { expected_graph: third.graph_revision, conflict_digest: third.conflict.conflict_digest, assertion: { ...resolution, parents: [first.revision] } }), /parent/);
  const resolved = resolveGraphConflict(third.state, { expected_graph: third.graph_revision, conflict_digest: third.conflict.conflict_digest, assertion: resolution });
  assert.equal(head(resolved.state).entities[0].status, 'resolved'); assert.equal(read(resolved.state, logical()).conflicts.length, 0);
  assert.equal(head(resolved.state).revisions.length, 4); assert.equal(head(resolved.state).conflicts.length, 1);
  assert.equal(head(resolved.state).revisions.at(-1).provenance.effective_access.sensitivity, 'restricted');
  assert.deepEqual(resolved.state.snapshots[3], head(third.state));
});

test('all derived lifecycle states are revisioned and canonical association does not confer write authority', () => {
  let r = apply(graph(), assertion());
  for (const status of SEMANTIC_STATES.filter(s => !['contested', 'resolved'].includes(s))) {
    r = apply(r.state, assertion(`state-${status}`, { base_revision: r.revision, status, canonical_refs: [canonicalArtifactAddress(event())] }));
    assert.equal(head(r.state).entities[0].status, status); assert.equal(head(r.state).revisions.at(-1).assertion.canonical_refs.length, 1);
  }
  assert.throws(() => apply(r.state, { ...assertion('canonical'), status: 'canonical', base_revision: r.revision }), /lifecycle/);
  assert.throws(() => apply(r.state, { ...assertion('write'), canonical_write: true }), /unknown field/);
  assert.throws(() => apply(r.state, { ...assertion('grant'), canonical_refs: [{ ...canonicalArtifactAddress(event()), write_authority: true }] }), /unknown field/);
});

test('relations pin exact endpoints and automatically inherit both endpoint provenance closures', () => {
  const a = apply(graph(), assertion()); const b = apply(a.state, assertion('web', { entity_id: 'web', events: [event('web')], execution_id: 'attempt-b' }));
  const r = relation(b.state, a.revision, b.revision); const rev = read(r.state, r.revision).revision;
  assert.equal(rev.provenance.events.length, 2); assert.equal(rev.provenance.effective_access.sensitivity, 'restricted');
  const changed = apply(r.state, assertion('api-changed', { base_revision: a.revision, content: { semantic_type: 'constraint', data: { text: 'changed' } } }));
  assert.deepEqual(read(changed.state, r.revision).revision.assertion.content.from, a.revision);
  assert.throws(() => relation(b.state, logical(), b.revision), /exact revision/);
  assert.throws(() => relation(b.state, { ...a.revision, revision_digest: `sha256:${'0'.repeat(64)}` }, b.revision), /missing exact/);
  assert.throws(() => relation(b.state, a.revision, { ...b.revision, scope: { ...scope, project_id: 'shared' } }), /scope/);
});

test('canonical relation endpoint is a typed immutable artifact with inherited access, never an unscoped string', () => {
  const a = apply(graph(), assertion()); const external = canonicalArtifactAddress(event('web'));
  const r = relation(a.state, a.revision, external); assert.equal(read(r.state, r.revision).revision.provenance.events.length, 2);
  assert.throws(() => relation(a.state, a.revision, 'ticket-42'), /field/);
  assert.throws(() => canonicalArtifactAddress(event('web', 0, raw => { raw.payload = { kind: 'mutable_pointer', pointer_id: 'latest', digest: null }; })), /immutable/);
});

test('ACL intersection, maximum sensitivity and empty provenance deny all; no explicit event can erase inherited restriction', () => {
  const a = apply(graph(), assertion('private', { events: [event('api', 0, raw => { raw.acl.allowed_principal_ids = ['alice']; })] }));
  const b = apply(a.state, assertion('web', { entity_id: 'web', events: [event('web')], execution_id: 'attempt-b' }));
  const r = relation(b.state, a.revision, b.revision);
  assert.deepEqual(read(r.state, r.revision).revision.provenance.effective_access, { allowed_principal_ids: ['alice'], sensitivity: 'restricted' });
  assert.equal(read(r.state, r.revision, { principal_id: 'bob' }).status, 'denied');
  const empty = apply(graph(), assertion('empty', { events: [] })); assert.equal(read(empty.state, empty.revision).status, 'denied');
  const denied = apply(graph(), assertion('deny-all', { events: [event('api', 0, raw => { raw.provenance.source_objects[0].acl.allowed_principal_ids = []; })] }));
  assert.equal(read(denied.state, denied.revision).status, 'denied');
});

test('source tombstone quarantines descendants and historical reads recheck current authorization', () => {
  const a = apply(graph(), assertion()); const r = relation(a.state, a.revision, canonicalArtifactAddress(event('web')));
  const t = lifecycle(r.state, 'source.deleted', 'tombstoned');
  assert.ok(head(t.state).entities.every(e => e.quarantined && e.status === 'stale'));
  assert.equal(read(t.state, a.revision).status, 'denied');
  assert.equal(read(a.state, a.revision, { current_graph: t.state }).status, 'denied');
  assert.deepEqual(t.state.snapshots[1], head(a.state));
  assert.throws(() => apply(t.state, assertion('old-reopens', { entity_id: 'resurrection' })), /stale source/);
  assert.throws(() => updateGraphSourceAccess(t.state, { expected_graph: t.graph_revision, event: event('api', 2, raw => { raw.source_event_type = 'access.changed'; }), access_state: 'active' }), /tombstone/);
});

test('ACL tightening and unknown access quarantine before recomputation; old updates cannot reopen state', () => {
  const a = apply(graph(), assertion()); const tightened = lifecycle(a.state);
  assert.equal(read(tightened.state, a.revision).status, 'denied');
  assert.equal(read(a.state, a.revision, { current_graph: tightened.state, principal_id: 'bob' }).status, 'denied');
  assert.throws(() => updateGraphSourceAccess(tightened.state, { expected_graph: tightened.graph_revision, event: event('api', 0, raw => { raw.source_event_type = 'access.changed'; }), access_state: 'active' }), /causal order/);
  const fresh = event('api', 2, raw => { raw.acl.revision = 'acl-8'; raw.provenance.source_objects[0].acl.revision = 'repo-acl-4'; raw.provenance.source_objects[0].acl.allowed_principal_ids = ['alice']; });
  const recomputed = apply(tightened.state, assertion('recomputed', { base_revision: a.revision, events: [fresh], access_revisions: [tightened.access_revision] }));
  assert.equal(read(recomputed.state, logical()).status, 'resolved'); assert.equal(read(recomputed.state, a.revision).status, 'denied');
  const unknown = lifecycle(a.state, 'access.changed', 'unknown'); assert.equal(read(unknown.state, a.revision).status, 'denied');
  assert.throws(() => read(a.state, a.revision, { current_graph: graph() }), /lineage/);
});

test('worker input fences graph revision, exact current inputs, conflicting heads and source authorization', () => {
  const a = apply(graph(), assertion()); const pin = { graph_revision: a.graph_revision, revisions: [a.revision], principal_id: 'alice' };
  assert.deepEqual(validateWorkerGraphInput(a.state, pin), { status: 'valid' });
  const b = apply(a.state, assertion('b', { base_revision: a.revision })); assert.equal(validateWorkerGraphInput(b.state, pin).reason, 'graph_revision_changed');
  assert.equal(validateWorkerGraphInput(b.state, { ...pin, graph_revision: b.graph_revision }).reason, 'input_revision_changed');
  const t = lifecycle(a.state); assert.equal(validateWorkerGraphInput(t.state, { ...pin, graph_revision: t.graph_revision }).status, 'stale');
  assert.equal(validateWorkerGraphInput(a.state, { ...pin, principal_id: 'mallory' }).reason, 'source_access_changed');
  const c = apply(a.state, assertion('c')); assert.equal(validateWorkerGraphInput(c.state, { ...pin, graph_revision: c.graph_revision }).status, 'stale');
});

test('strict validation rejects tampering, accessors, foreign executions, revision pins and inherited identifier names', () => {
  const a = apply(graph(), assertion()); const s = clone(a.state); s.snapshots[1].revisions[0].assertion.content.data.text = 'tampered'; assert.throws(() => validateWorkingGraph(s), /digest/);
  let called = false; const evil = { ...assertion() }; Object.defineProperty(evil, 'events', { enumerable: true, get() { called = true; return []; } });
  assert.throws(() => apply(graph(), evil), /data property/); assert.equal(called, false);
  assert.throws(() => apply(graph(), assertion('foreign', { execution_id: 'notes-attempt' })), /execution scope/);
  assert.throws(() => apply(graph(), assertion('foreign', { events: [event('api', 0, raw => { raw.partition.project_id = 'shared'; })] })));
  const weird = apply(graph(), assertion('constructor', { entity_id: 'constructor' })); assert.equal(read(weird.state, logical('constructor')).status, 'resolved');
  assert.throws(() => apply(graph(), assertion('prototype', { execution_id: 'constructor' })), /execution scope/);
});

test('multiple observers of one immutable object retain independent envelope ACLs and conservatively meet lifecycle restrictions', () => {
  const local = event();
  const connector = event('api', 0, raw => {
    raw.event_id = 'connector-same-commit'; raw.idempotency_key = 'connector-same-commit';
    raw.partition.source_installation_id = 'connector'; raw.partition.partition_id = 'git-connector'; raw.producer.producer_id = 'connector';
    raw.identity = { repository_id: 'api' }; raw.acl = { revision: 'connector-envelope-1', allowed_principal_ids: ['alice'] };
    raw.provenance.source_objects[0].acl = { revision: 'connector-object-1', allowed_principal_ids: ['alice', 'carol'] };
  });
  const a = apply(graph(), assertion('multi-observer', { events: [local, connector] }));
  assert.equal(read(a.state, a.revision).revision.provenance.events.length, 2);
  assert.deepEqual(read(a.state, a.revision).revision.provenance.effective_access.allowed_principal_ids, ['alice']);
  const delivery = apply(a.state, assertion('different-envelope', { entity_id: 'another', events: [event('api', 1, raw => { raw.acl = { revision: 'another-envelope', allowed_principal_ids: ['bob'] }; })] }));
  assert.equal(read(delivery.state, delivery.revision, { principal_id: 'bob' }).status, 'resolved');
  const update = event('api', 2, raw => {
    raw.event_id = 'connector-access'; raw.source_event_type = 'access.changed'; raw.partition.source_installation_id = 'connector';
    raw.partition.partition_id = 'git-connector'; raw.producer.producer_id = 'connector'; raw.identity = { repository_id: 'api' };
    raw.acl = { revision: 'connector-envelope-2', allowed_principal_ids: ['alice'] };
    raw.provenance.source_objects[0].acl = { revision: 'connector-object-2', allowed_principal_ids: ['alice'] };
  });
  const changed = updateGraphSourceAccess(delivery.state, { expected_graph: delivery.graph_revision, event: update, access_state: 'active' });
  assert.equal(read(changed.state, a.revision).status, 'denied');
  assert.equal(read(changed.state, delivery.revision, { principal_id: 'bob' }).status, 'denied');
  assert.throws(() => apply(changed.state, assertion('replay-old', { entity_id: 'replay-old', events: [local] })), /access revisions/);
  const recomputed = apply(changed.state, assertion('explicit-recompute', { base_revision: a.revision, events: [local, connector], access_revisions: [changed.access_revision] }));
  assert.equal(read(recomputed.state, recomputed.revision).status, 'resolved');
  assert.equal(read(recomputed.state, recomputed.revision, { principal_id: 'bob' }).status, 'denied');
});

test('competing assertions accumulate and resolution covers every unresolved conflict', () => {
  const { second, third } = conflictFixture();
  const fourth = apply(third.state, assertion('fourth', { base_revision: second.revision }));
  assert.equal(head(fourth.state).conflicts.length, 2);
  const a = assertion('all-resolved', { base_revision: second.revision, status: 'resolved', parents: head(fourth.state).entities[0].competing, events: [] });
  const resolved = resolveGraphConflict(fourth.state, { expected_graph: fourth.graph_revision, conflict_digest: fourth.conflict.conflict_digest, assertion: a });
  assert.equal(head(resolved.state).resolutions.length, 2); assert.equal(read(resolved.state, logical()).conflicts.length, 0);
});

test('one observation identity cannot be rebound across assertions or lifecycle records', () => {
  const a = apply(graph(), assertion());
  assert.throws(() => apply(a.state, assertion('rebound', { entity_id: 'another', events: [event('api', 0, raw => { raw.payload.digest = `sha256:${'1'.repeat(64)}`; })] })), /identity rebound/);
  assert.throws(() => apply(graph(), assertion('unmapped-source', { events: [event('api', 0, raw => { raw.payload = { kind: 'mutable_pointer', pointer_id: 'host-event', digest: null }; raw.provenance.source_objects = []; })] })), /source object/);
  let called = false; const evil = {}; Object.defineProperty(evil, 'scope', { enumerable: true, get() { called = true; return scope; } });
  assert.throws(() => exactRevisionAddress(evil), /data property/); assert.throws(() => graphRevisionAddress(evil), /data property/); assert.equal(called, false);
});

test('permuting set-like supporting event order yields identical immutable revisions and snapshots', () => {
  const state = graph(); const api = event(), web = event('web');
  const a = apply(state, assertion('same-supports', { events: [api, web] }));
  const b = apply(state, assertion('same-supports', { events: [web, api] }));
  assert.deepEqual(a.revision, b.revision); assert.deepEqual(a.graph_revision, b.graph_revision); assert.deepEqual(a.state, b.state);
  const canonicalA = canonicalArtifactAddress(api), canonicalB = canonicalArtifactAddress(web);
  const c = apply(state, assertion('same-associations', { events: [], canonical_refs: [canonicalA, canonicalB] }));
  const d = apply(state, assertion('same-associations', { events: [], canonical_refs: [canonicalB, canonicalA] }));
  assert.deepEqual(c.state, d.state);
});

test('lifecycle events cannot invent epochs; explicit observer admission preserves old provenance and separate restrictions', () => {
  const a = apply(graph(), assertion());
  const epochEvent = (sequence, type = 'git.commit.created') => event('api', sequence, raw => {
    raw.event_id = `new-epoch-${sequence}`; raw.idempotency_key = `new-epoch-retry-${sequence}`;
    raw.source_native_event_id = `new-epoch-native-${sequence}`; raw.producer.epoch = 'epoch-new'; raw.source_event_type = type;
  });
  const update = epochEvent(1, 'access.changed');
  assert.throws(() => updateGraphSourceAccess(a.state, { expected_graph: a.graph_revision, event: update, access_state: 'active' }), /explicitly admitted/);
  const pinned = applyGraphAssertion(a.state, { expected_graph: a.graph_revision, assertion: assertion('watermark-admission', { entity_id: 'watermark-admission' }),
    watermarks: watermarks([event(), event('web'), epochEvent(0)]) });
  assert.equal(updateGraphSourceAccess(pinned.state, { expected_graph: pinned.graph_revision, event: update, access_state: 'active' }).status, 'applied');
  const registered = apply(a.state, assertion('registered-epoch', { entity_id: 'epoch-source', events: [epochEvent(0)] }));
  assert.equal(read(registered.state, a.revision).status, 'resolved');
  const changed = updateGraphSourceAccess(registered.state, { expected_graph: registered.graph_revision, event: update, access_state: 'active' });
  assert.equal(read(changed.state, a.revision).status, 'denied'); assert.deepEqual(changed.state.snapshots[1], head(a.state));
  const oldEpochChange = lifecycle(changed.state);
  assert.equal(head(oldEpochChange.state).access_updates.length, 2);
  assert.equal(new Set(head(oldEpochChange.state).access_updates.map(u => u.event.producer.epoch)).size, 2);
  const recomputed = apply(oldEpochChange.state, assertion('epochs-recomputed', { base_revision: a.revision,
    access_revisions: [changed.access_revision, oldEpochChange.access_revision] }));
  assert.equal(read(recomputed.state, recomputed.revision).status, 'resolved');
  assert.equal(read(recomputed.state, recomputed.revision, { principal_id: 'bob' }).status, 'denied');
});

test('recomputed snapshot hashes cannot roll back heads or hide implied conflicts and resolutions', () => {
  const a = apply(graph(), assertion()); const b = apply(a.state, assertion('advance', { base_revision: a.revision, status: 'validated' }));
  const rollback = clone(b.state); head(rollback).entities[0].head = a.revision; head(rollback).entities[0].status = 'candidate'; rehashSnapshot(head(rollback));
  assert.throws(() => validateGraphRevision(head(rollback)), /history head/); assert.throws(() => validateWorkingGraph(rollback), /history head/);
  const c = apply(a.state, assertion('competing')); const hidden = clone(c.state);
  head(hidden).conflicts = []; head(hidden).entities[0].competing = []; head(hidden).entities[0].status = 'candidate'; rehashSnapshot(head(hidden));
  assert.throws(() => validateGraphRevision(head(hidden)), /history conflict/); assert.throws(() => validateWorkingGraph(hidden), /history conflict/);
  const resolved = resolveGraphConflict(c.state, { expected_graph: c.graph_revision, conflict_digest: c.conflict.conflict_digest,
    assertion: assertion('resolved-for-forgery', { base_revision: a.revision, parents: [a.revision, c.revision], status: 'resolved' }) });
  const omitted = clone(resolved.state); head(omitted).resolutions = []; head(omitted).entities[0].competing = [a.revision, c.revision]; head(omitted).entities[0].status = 'contested'; rehashSnapshot(head(omitted));
  assert.throws(() => validateWorkingGraph(omitted), /history conflict/);
});

test('genesis, no-op and multi-mutation imported snapshots cannot disguise their history', () => {
  const a = apply(graph(), assertion());
  const genesis = clone(a.state); genesis.snapshots = [head(genesis)]; head(genesis).sequence = 0; head(genesis).previous_snapshot_digest = null; rehashSnapshot(head(genesis));
  assert.throws(() => validateWorkingGraph(genesis), /mutation history|genesis/);
  const noop = clone(a.state), extra = clone(head(noop)); extra.sequence++; extra.previous_snapshot_digest = extra.snapshot_digest; rehashSnapshot(extra); noop.snapshots.push(extra);
  assert.throws(() => validateWorkingGraph(noop), /mutation history/);
  const b = apply(a.state, assertion('second', { entity_id: 'second' })); const batch = clone(b.state); batch.snapshots.splice(1, 1); head(batch).previous_snapshot_digest = batch.snapshots[0].snapshot_digest; rehashSnapshot(head(batch));
  assert.throws(() => validateWorkingGraph(batch), /sequence mismatch/);
});

test('adjacent validation refuses future source admission and stale supporting inputs despite self-consistent snapshot hashes', () => {
  const a = apply(graph(), assertion());
  const b = apply(a.state, assertion('web-source', { entity_id: 'web-source', events: [event('web')], execution_id: 'attempt-b' }));
  const update = event('web', 1, raw => { raw.source_event_type = 'access.changed'; });
  const valid = updateGraphSourceAccess(b.state, { expected_graph: b.graph_revision, event: update, access_state: 'active' });
  // Copy future web registration into a lifecycle step that has no admitting assertion.
  const forged = clone(a.state), later = clone(head(a.state)); later.sequence++; later.previous_snapshot_digest = later.snapshot_digest;
  later.sources = clone(head(b.state).sources); later.access_updates = clone(head(valid.state).access_updates); rehashSnapshot(later); forged.snapshots.push(later);
  assert.equal(validateGraphRevision(later), true); assert.throws(() => validateWorkingGraph(forged), /source object|source epoch|transition/);
  // The stored relation was valid before revocation, but must not be admitted after it.
  const r = relation(a.state, a.revision, canonicalArtifactAddress(event('web'))); const oldOrder = lifecycle(r.state); const revokedFirst = lifecycle(a.state);
  const reordered = clone(revokedFirst.state), after = clone(head(oldOrder.state)); after.previous_snapshot_digest = head(reordered).snapshot_digest; rehashSnapshot(after); reordered.snapshots.push(after);
  assert.equal(validateGraphRevision(after), true); assert.throws(() => validateWorkingGraph(reordered), /access revisions|stale supporting/);
});

test('historical watermark-only epoch admission survives later requirements while ACL restrictions and ordering remain active', () => {
  const a = apply(graph(), assertion());
  const epochEvent = (sequence, type = 'git.commit.created', epoch = 'epoch-watermark-only') => event('api', sequence, raw => {
    raw.event_id = `${epoch}-${sequence}-${type}`; raw.idempotency_key = `${epoch}-${sequence}-${type}`; raw.source_native_event_id = `${epoch}-${sequence}-${type}`;
    raw.producer.epoch = epoch; raw.source_event_type = type; raw.provenance.source_objects[0].acl.allowed_principal_ids = ['alice'];
  });
  const pinned = applyGraphAssertion(a.state, { expected_graph: a.graph_revision,
    assertion: assertion('watermark-only-registration', { entity_id: 'registration' }), watermarks: watermarks([event(), event('web'), epochEvent(0)]) });
  const changed = updateGraphSourceAccess(pinned.state, { expected_graph: pinned.graph_revision, event: epochEvent(1, 'access.changed'), access_state: 'active' });
  const dropped = applyGraphAssertion(changed.state, { expected_graph: changed.graph_revision,
    assertion: assertion('unrelated-web-drops-epoch', { entity_id: 'web', events: [event('web')], execution_id: 'attempt-b' }), watermarks: watermarks() });
  assert.equal(validateWorkingGraph(dropped.state), true); assert.equal(validateGraphRevision(head(dropped.state)), true);
  assert.deepEqual(head(dropped.state).access_updates, head(changed.state).access_updates);
  assert.deepEqual(dropped.state.snapshots[2], head(pinned.state));
  assert.equal(read(dropped.state, a.revision).status, 'denied');
  const recomputed = apply(dropped.state, assertion('historically-authorized-recompute', { base_revision: a.revision, access_revisions: [changed.access_revision] }));
  assert.equal(read(recomputed.state, recomputed.revision).status, 'resolved'); assert.equal(read(recomputed.state, recomputed.revision, { principal_id: 'bob' }).status, 'denied');
  assert.throws(() => updateGraphSourceAccess(dropped.state, { expected_graph: dropped.graph_revision, event: epochEvent(0, 'access.changed'), access_state: 'active' }), /causal order/);
  assert.throws(() => updateGraphSourceAccess(dropped.state, { expected_graph: dropped.graph_revision, event: epochEvent(1, 'access.changed', 'epoch-unadmitted'), access_state: 'active' }), /explicitly admitted/);
  assert.equal(updateGraphSourceAccess(dropped.state, { expected_graph: dropped.graph_revision, event: epochEvent(2, 'access.changed'), access_state: 'active' }).status, 'applied');
});
