import test from 'node:test';
import assert from 'node:assert/strict';
import { validateContextContent1, validateContextOperation1, isContextContent1 } from '../src/core/context-profile.mjs';
import { ContextInputs } from '../src/application/context/context-inputs.mjs';
import { composeLocalServices } from '../src/local/local-runtime-composition.mjs';
import { graphHash } from '../src/local/graph-inputs.mjs';
import { exactRevisionAddress } from '../src/core/working-graph.mjs';
import { readerFixture, records, READER_ACTIONS, SCOPE } from './helpers/canonical-reader-fixture.mjs';
import { assertion, mutation } from './helpers/graph-store-fixture.mjs';

const digest = character => `sha256:${character.repeat(64)}`;
const at = { schema_version: 2, kind: 'graph_commit', scope: SCOPE, generation_id: 'selected-generation', commit_digest: digest('a') };
const address = { schema_version: 1, kind: 'semantic_revision', scope: SCOPE, generation_id: at.generation_id,
  entity_kind: 'entity', entity_id: 'selected-context', revision_digest: digest('b') };
const content = (kind = 'create') => ({ semantic_type: 'context', data: { schema_version: 1, kind: 'runtime_context', role: 'decision',
  summary: 'Use the selected contract.', detail: '', applicability: { project: 'owning', exploration: 'unspecified',
    tickets: { mode: 'unspecified', refs: [] }, code: { mode: 'unspecified', refs: [] } }, change: { kind, reason: 'Explicit synthetic decision.' } } });
const operation = (kind = 'create', extra = {}) => ({ kind: kind === 'resolve' ? 'resolve' : 'assert', ...(kind === 'resolve' ? { conflict_digest: digest('c') } : {}),
  assertion: { schema_version: 1, assertion_id: 'context-assertion', entity_kind: 'entity', entity_id: address.entity_id,
    base_revision: null, parents: [], execution_id: 'synthetic-execution', status: 'candidate', content: content(kind), events: [], canonical_refs: [], ...extra } });
const code = (fn, expected) => assert.throws(fn, error => { if (expected) assert.equal(error.code, expected); assert.match(error.message, /^Context (profile|inputs): [a-z_]+$/); return true; });
const actions = [...READER_ACTIONS, 'context:read', 'context:write'];
function fixture(t) {
  const f = readerFixture(t); f.context = f.issue({ actions }).context;
  const { canonical, contexts: inputs } = composeLocalServices({ store: f.store, authority: f.authority, canonical_reader: {
    repository_path: f.folder, execution: f.execution, registration_id: f.source.registration_id, selection: f.selection } });
  const first = f.reader.refresh(f.context, f.request);
  const entry = first.selection.assertion.content.data.records.find(record => record.key === 'ticket');
  const artifact = first.selection.assertion.canonical_refs[entry.canonical_ref_index];
  const selected = content(); selected.data.applicability.tickets = { mode: 'exact', refs: [{ at: first.graph_revision, address: first.address, record_key: 'ticket' }] };
  selected.data.applicability.code = { mode: 'exact', refs: [{ event_digest: graphHash(artifact.event) }] };
  const a = assertion(f, artifact.event, 'typed', { content: selected, canonical_refs: [artifact] });
  return { ...f, canonical, inputs, first, artifact, selected, a };
}
function view(f, proof, selected = { assertion: f.a }, context = f.context, snapshot = f.store.readSnapshot.bind(f.store)) {
  let error;
  try { return snapshot(context, tx => { try { return f.inputs.assert(tx, context, proof, selected); } catch (caught) { error = caught; throw caught; } }); }
  catch (caught) { throw error ?? caught; }
}

test('Context meaning has an inert exact profile and set-like applicability refs normalize without changing caller data', () => {
  const value = content(); value.data.applicability.tickets = { mode: 'exact', refs: [{ at, address, record_key: 'z' }, { at, address, record_key: 'a' }] };
  value.data.applicability.code = { mode: 'exact', refs: [{ event_digest: digest('f') }, { event_digest: digest('d') }] };
  const normalized = validateContextContent1(value);
  assert.deepEqual(normalized.data.applicability.tickets.refs.map(ref => ref.record_key), ['a', 'z']);
  assert.equal(value.data.applicability.tickets.refs[0].record_key, 'z');
  assert(Object.isFrozen(normalized.data.applicability.tickets.refs[0]));
  assert(isContextContent1(value)); assert(!isContextContent1({ semantic_type: 'judge-target', data: { kind: 'judge_target' } }));
  for (const change of [v => { v.data.role = 'authority'; }, v => { v.data.schema_version = 2; }, v => { v.data.actor = 'owner'; },
    v => { v.data.summary = ' '; }, v => { v.data.summary = 'a'.repeat(513); }, v => { v.data.change.reason = 'a'.repeat(2049); },
    v => { v.data.detail = 'a'.repeat(8193); }, v => { delete v.data.applicability.code; },
    v => { v.data.applicability.tickets.mode = 'any'; }, v => { v.data.applicability.tickets.refs.push(v.data.applicability.tickets.refs[0]); },
    v => { v.data.applicability.tickets.refs[0].address.generation_id = 'foreign'; }]) {
    const invalid = structuredClone(value); change(invalid); code(() => validateContextContent1(invalid), 'invalid_context_input');
  }
});

test('Context rejects executable inputs and bounded overflow without invoking user hooks', () => {
  let hooks = 0;
  const getter = content(); Object.defineProperty(getter.data, 'detail', { enumerable: true, get() { hooks++; return 'secret'; } });
  code(() => validateContextContent1(getter));
  const proxy = new Proxy({}, { getPrototypeOf() { hooks++; return Object.prototype; }, get() { hooks++; return 'secret'; } });
  code(() => validateContextContent1(proxy)); assert.equal(isContextContent1(proxy), false);
  assert.equal(isContextContent1({ semantic_type: 'context', data: proxy }), false);
  const nested = content(); nested.data.detail = {}; let current = nested.data.detail;
  for (let i = 0; i < 17; i++) current = current.child = {};
  code(() => validateContextContent1(nested), 'context_capacity');
  const tooMany = content(); tooMany.data.applicability.code = { mode: 'exact', refs: Array.from({ length: 9 }, (_, i) => ({ event_digest: digest(String(i)) })) };
  code(() => validateContextContent1(tooMany), 'context_capacity'); assert.equal(hooks, 0);
});

test('typed transitions retain core base/support semantics and reject mismatched status or operation', () => {
  assert.equal(validateContextOperation1(operation()).assertion.content.data.change.kind, 'create');
  for (const [kind, status] of [['revise', 'validated'], ['supersede', 'superseded'], ['invalidate', 'stale'], ['resolve', 'resolved']]) {
    const op = operation(kind, { status, base_revision: address, parents: kind === 'resolve' ? [address] : [] });
    assert.equal(validateContextOperation1(op).assertion.status, status);
    code(() => validateContextOperation1({ ...op, assertion: { ...op.assertion, base_revision: null } }), 'context_transition_invalid');
  }
  assert.equal(validateContextOperation1(operation('derive', { parents: [address] })).assertion.parents.length, 1);
  code(() => validateContextOperation1(operation('derive')), 'context_transition_invalid');
  code(() => validateContextOperation1(operation('create', { parents: [address] })), 'context_transition_invalid');
  code(() => validateContextOperation1(operation('supersede', { status: 'validated', base_revision: address })), 'context_transition_invalid');
  code(() => validateContextOperation1(operation('revise', { base_revision: { ...address, entity_id: 'other' } })), 'context_transition_invalid');
  code(() => validateContextOperation1(operation('branch', { parents: [address] })), 'context_transition_invalid');
  code(() => validateContextOperation1({ ...operation(), kind: 'source_access' }), 'context_transition_invalid');
});

test('same-generation branch checks the exact actual typed parent revision; copied content is valid independently of a new operation', t => {
  const f = fixture(t), applied = f.graph.mutate(f.context, mutation(f, f.first.graph_revision, f.a));
  const parent = f.graph.resolve(f.context, { at: applied.receipt.next_graph, address: applied.revision }).revision;
  const branch = operation('branch', { entity_id: 'branch-context', parents: [exactRevisionAddress(parent)] });
  assert.equal(validateContextOperation1(branch, { branch_parent: parent }).assertion.content.data.change.kind, 'branch');
  const mismatch = structuredClone(branch); mismatch.assertion.parents[0].generation_id = 'foreign';
  code(() => validateContextOperation1(mismatch, { branch_parent: parent }), 'context_transition_invalid');
  const corrupted = structuredClone(parent); corrupted.assertion.content.data.summary = 'Unrecorded parent';
  code(() => validateContextOperation1(branch, { branch_parent: corrupted }));
  assert.equal(validateContextContent1(content('supersede')).data.change.kind, 'supersede', 'adoption/read preserves source change without reinterpreting B');
});

test('actual configured Ticket and Git artifacts derive exact applicability without exposing canonical text', t => {
  const f = fixture(t), proof = f.inputs.prepare(f.context, f.selected), result = view(f, proof);
  assert.equal(result.status, 'uncertain'); assert.deepEqual(result.uncertain_dimensions, ['exploration']);
  assert.equal(result.tickets.refs[0].ticket_id, 'example');
  assert.deepEqual(result.tickets.refs[0].contract_revision, { revision: 1, identity: records().ticket.contract_revisions[0].identity });
  assert.equal(result.tickets.refs[0].selection_status, 'current');
  assert.equal(result.code.refs[0].commit_oid, f.commit); assert.equal(result.code.refs[0].path, '.vibehub/ticket.yaml');
  assert.equal(result.code.refs[0].event_ref.event_digest, graphHash(f.artifact.event));
  assert(!JSON.stringify(result).includes('Synthetic criterion')); assert(!JSON.stringify(result).includes(f.folder));
  code(() => view(f, { content: proof.content }), 'invalid_context_proof');
  const other = new ContextInputs({ authority: f.authority, canonical: f.canonical });
  f.store.readSnapshot(f.context, tx => code(() => other.assert(tx, f.context, proof, { assertion: f.a }), 'invalid_context_proof'));
});

test('Ticket source support may be inherited from actual parent provenance; canonical code association must remain explicit', t => {
  const f = fixture(t), applied = f.graph.mutate(f.context, mutation(f, f.first.graph_revision, f.a));
  const parent = f.graph.resolve(f.context, { at: applied.receipt.next_graph, address: applied.revision }).revision;
  const inherited = structuredClone(f.selected); inherited.data.applicability.code = { mode: 'any', refs: [] };
  const a = { ...f.a, content: inherited, events: [], canonical_refs: [], parents: [applied.revision] };
  const proof = f.inputs.prepare(f.context, inherited);
  code(() => view(f, proof, { assertion: a }), 'context_source_mismatch');
  assert.equal(view(f, proof, { assertion: a, provenance: parent.provenance }).tickets.refs[0].ticket_id, 'example');
  const codeProof = f.inputs.prepare(f.context, f.selected);
  code(() => view(f, codeProof, { assertion: { ...a, content: f.selected }, provenance: parent.provenance }), 'context_source_mismatch');
});

test('unknown, wrong-kind, foreign and unsupported applicability fail closed against actual selection', t => {
  const f = fixture(t);
  for (const record_key of ['unknown', 'authority']) {
    const invalid = structuredClone(f.selected); invalid.data.applicability.tickets.refs[0].record_key = record_key;
    if (record_key === 'unknown') code(() => f.inputs.prepare(f.context, invalid), 'canonical_selection_mismatch');
    else code(() => view(f, f.inputs.prepare(f.context, invalid), { assertion: { ...f.a, content: invalid } }), 'context_ticket_unavailable');
  }
  const foreign = structuredClone(f.selected); for (const key of ['at', 'address']) foreign.data.applicability.tickets.refs[0][key].scope.project_id = 'foreign';
  code(() => f.inputs.prepare(f.context, foreign), 'context_source_mismatch');
  const invented = structuredClone(f.selected); invented.data.applicability.code.refs[0].event_digest = digest('d');
  code(() => view(f, f.inputs.prepare(f.context, invented), { assertion: { ...f.a, content: invented } }), 'context_source_mismatch');
  code(() => view(f, f.inputs.prepare(f.context, f.selected), { assertion: { ...f.a, events: [], canonical_refs: [] } }), 'context_source_mismatch');
});

test('opaque current Context grants are mandatory and writes exclude non-human/service actors', t => {
  const f = fixture(t), proof = f.inputs.prepare(f.context, f.selected);
  assert.deepEqual(f.inputs.grant(f.context, { write: true }), { scope: SCOPE, actor: 'owner', actor_kind: 'service' });
  code(() => f.inputs.grant({ actions }), 'context_unauthorized');
  code(() => f.inputs.grant(f.issue({ actions: READER_ACTIONS }).context), 'context_unauthorized');
  const readOnly = f.issue({ actions: [...READER_ACTIONS, 'context:read'] }).context;
  code(() => f.inputs.grant(readOnly, { write: true }), 'context_unauthorized');
  const worker = f.issue({ actions, kind: 'worker' }).context;
  assert.equal(f.inputs.grant(worker).actor_kind, 'worker');
  code(() => f.inputs.grant(worker, { write: true }), 'context_unauthorized');
  code(() => view(f, proof, { assertion: f.a }, readOnly), 'invalid_context_proof');
  const fresh = f.issue({ actions }); const ownProof = f.inputs.prepare(fresh.context, f.selected);
  f.authority.revoke(fresh.issued.credential_id); code(() => f.inputs.assert({}, fresh.context, ownProof, { assertion: f.a }), 'context_unauthorized');
});

test('historical exact Tickets remain historical while head races and current source revocation invalidate prepared material', t => {
  const f = fixture(t), proof = f.inputs.prepare(f.context, f.selected), next = records(); next.decision.summary = 'Updated selected canonical decision.';
  const second = f.reader.refresh(f.context, { ...f.request, idempotency_key: 'second-selection', expected_graph: f.first.graph_revision,
    previous_selection: f.first.selection, commit_oid: f.commitRecords(next), observation: { ...f.request.observation, sequence_start: f.selection.records.length } });
  assert(second.graph_revision); code(() => view(f, proof), 'canonical_graph_changed');
  const historical = f.inputs.prepare(f.context, f.selected); assert.equal(view(f, historical).tickets.refs[0].selection_status, 'historical');
  f.ingress.updateSourceAccess(f.context, { registration_id: f.source.registration_id, expectedVersion: f.source.version,
    access: { ...f.source.registration.access, allowed_principal_ids: [] } });
  code(() => view(f, historical), 'stale_invalidation_fence');
  const revoked = f.inputs.prepare(f.context, f.selected); code(() => view(f, revoked), 'context_ticket_unavailable');
});

test('fixed proof assertion performs no nested public snapshot and unspecified applicability never becomes any', t => {
  const f = fixture(t), proof = f.inputs.prepare(f.context, f.selected), snapshot = f.store.readSnapshot.bind(f.store);
  f.store.readSnapshot = () => { throw new Error('Nested snapshot forbidden'); };
  try { assert.equal(view(f, proof, { assertion: f.a }, f.context, snapshot).tickets.refs.length, 1); }
  finally { f.store.readSnapshot = snapshot; }
  const unknown = content(), unknownProof = f.inputs.prepare(f.context, unknown);
  const result = view(f, unknownProof, { assertion: { ...f.a, content: unknown } });
  assert.deepEqual(result.uncertain_dimensions, ['exploration', 'tickets', 'code']);
  assert.deepEqual(result.tickets, { mode: 'unspecified', refs: [] });
});
