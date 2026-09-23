import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalExplorationStore } from '../src/application/explorations/exploration-store.mjs';
import { graphHash } from '../src/application/graph/graph-inputs.mjs';
import { judgeInputHash } from '../src/core/contracts.mjs';
import { judgeFixture, question, JUDGE_ACTIONS } from './helpers/judge-fixture.mjs';
import { bind, capture, register, pin, git, rows } from './helpers/exploration-fixture.mjs';

const prepare = (f, inputs = f.inputs(), extra = {}, family = 'context_relevance') =>
  inputs.prepare(f.context, f.request(extra), { family, question: question(family) });
const rejected = (fn, code) => assert.throws(fn, error => typeof error.code === 'string' && (!code || error.code === code));
const admit = (f, inputs, prepared, provider = 'typesafe', stage = 'dispatch') => inputs.admit(f.context, prepared, { stage, provider });

test('Judge input uses exact local candidate and stored snapshot, with private source proofs and no shared Authority text', t => {
  const f = judgeFixture(t, { canonical: true }), inputs = f.inputs(), before = rows(f), prepared = prepare(f, inputs);
  assert.deepEqual(prepared.input, { event: { type: f.event.event_type, timestamp: f.event.observed_at,
    payload: { text: 'Selected synthetic context.' } }, stateRefs: [{ id: `target-${graphHash(f.target).slice(7)}`,
    type: 'context', text: 'Synthetic selected candidate.' }], question: question() });
  assert.equal(prepared.input_hash, judgeInputHash(prepared.input));
  assert.deepEqual(prepared.target_map, [{ id: prepared.input.stateRefs[0].id, ref: f.target }]);
  assert.equal(prepared.selection.shared.origin_base.status, 'current');
  assert.deepEqual(prepared.selection.shared.origin_base.authority_record_keys, ['authority']);
  assert.equal(prepared.selection.shared.current_project.version, null);
  assert.equal(prepared.selection.governance_evaluated, false); assert.equal(prepared.selection.shared_material_sent, false);
  assert.equal(prepared.selection.registrations.length, 2);
  for (const excluded of [f.root, f.execution.worktree_id, f.source.registration_id, 'Update selected contract first.'])
    assert.equal(JSON.stringify(prepared.input).includes(excluded), false);
  assert.equal(JSON.stringify(prepared.selection).includes('Update selected contract first.'), false);
  assert(Object.isFrozen(prepared.input.stateRefs[0]));
  assert.equal(admit(f, inputs, prepared), prepared); assert.equal(admit(f, inputs, prepared, 'typesafe', 'result'), prepared);
  rejected(() => admit(f, inputs, JSON.parse(JSON.stringify(prepared))), 'invalid_judge_proof');
  assert.deepEqual(rows(f), before);
});

test('metadata-only getSelection validates the selected commit, exposes pointer versions, and reads no local revisions', t => {
  const f = judgeFixture(t, { canonical: true }), before = rows(f);
  const selected = f.explorations.getSelection(f.context, { exploration_id: f.binding.exploration_id, at: f.head });
  assert.equal(Object.hasOwn(selected, 'local'), false); assert.equal(selected.shared.current_project.version, null);
  const declared = f.explorations.setProjectSelection(f.context, { epoch: f.epoch, idempotency_key: 'selected-project',
    expected_version: null, pin: pin(f.canonical, ['decision']) });
  const next = f.explorations.getSelection(f.context, { exploration_id: f.binding.exploration_id, at: f.head });
  assert.equal(next.shared.current_project.version, declared.version);
  const resolved = f.explorations.resolve(f.context, { exploration_id: f.binding.exploration_id, at: f.head, address: f.target, shared_keys: [] });
  assert.equal(resolved.shared.current_project.version, declared.version);
  rejected(() => f.explorations.getSelection(f.context, { exploration_id: f.binding.exploration_id,
    at: { ...f.head, commit_digest: `sha256:${'a'.repeat(64)}` } }));
  assert.notDeepEqual(rows(f), before);
});

test('all four families retain the exact existing minimal envelope and nonrelational targets are rejected', t => {
  const f = judgeFixture(t), acceptance = f.addTarget({ kind: 'acceptance' });
  for (const [family, refs] of [['context_relevance', [f.target]], ['acceptance_relevance', [acceptance]],
    ['durable_cross_ticket_value', []], ['independently_schedulable_work', []]]) {
    const inputs = f.inputs(), p = prepare(f, inputs, { target_refs: refs }, family);
    assert.equal(p.input.question.family, family); assert.equal(p.target_refs.length, refs.length); admit(f, inputs, p);
  }
  rejected(() => prepare(f, f.inputs(), {}, 'durable_cross_ticket_value'), 'judge_target_invalid');
  rejected(() => prepare(f, f.inputs(), { target_refs: [acceptance] }), 'judge_target_invalid');
});

test('zero-target local admission still checks selected pins and source policy without external local-only denial', t => {
  const f = judgeFixture(t); f.configuration.egress_policy.sources.forEach(s => { s.local_only = true; });
  const inputs = f.inputs(), p = prepare(f, inputs, { target_refs: [] });
  admit(f, inputs, p, null); rejected(() => admit(f, inputs, p), 'judge_provider_denied');
  f.configuration.egress_policy.sources = [];
  rejected(() => prepare(f, f.inputs(), { target_refs: [] }), 'judge_source_policy_denied');
});

test('nonrelational selection needs no fabricated target read and prepared capabilities are actor-bound', t => {
  const f = judgeFixture(t), inputs = f.inputs(), original = LocalExplorationStore.prototype.resolve;
  LocalExplorationStore.prototype.resolve = () => { throw new Error('No local target is selected'); };
  let p;
  try { p = prepare(f, inputs, { target_refs: [] }, 'durable_cross_ticket_value'); }
  finally { LocalExplorationStore.prototype.resolve = original; }
  admit(f, inputs, p);
  const reader = f.issue({ principal: 'reader', actions: JUDGE_ACTIONS });
  rejected(() => inputs.admit(reader.context, p, { stage: 'result', provider: 'typesafe' }), 'judge_unauthorized');
  const limited = f.issue({ actions: JUDGE_ACTIONS.filter(action => action !== 'model:dispatch') });
  rejected(() => inputs.prepare(limited.context, f.request(), { family: 'context_relevance', question: question() }), 'judge_unauthorized');
});

test('other explorations, superseded candidate revisions and malformed typed targets refuse before dispatch', t => {
  const f = judgeFixture(t), old = f.target;
  f.addTarget({ name: 'successor', entity_id: old.entity_id, base_revision: old, parents: [old] });
  rejected(() => prepare(f), 'judge_target_invalid');
  const malformed = f.addTarget({ name: 'bad-target', data: { schema_version: 1, kind: 'judge_target', target_kind: 'context', text: 'Target', extra: 'PRIVATE-CANARY' } });
  rejected(() => prepare(f, f.inputs(), { target_refs: [malformed] }));
  const prior = f.binding, other = bind(f, { key: 'other-exploration' });
  rejected(() => prepare(f, f.inputs(), { ...f.request(), exploration_id: other.exploration_id, execution_workspace_id: other.execution_workspace_id,
    expected_binding_version: other.binding_version, at: other.graph_revision, target_refs: [old] }), 'judge_target_invalid');
  assert.notEqual(prior.exploration_id, other.exploration_id);
});

test('egress covers every inherited real source and conservatively maps normal sensitivity to INTERNAL', t => {
  const f = judgeFixture(t), config = structuredClone(f.configuration);
  config.egress_policy.sources = config.egress_policy.sources.filter(s => s.registration_id !== f.supportSource.registration_id);
  rejected(() => prepare(f, f.inputs(config)), 'judge_source_policy_denied');
  config.egress_policy.sources = structuredClone(f.configuration.egress_policy.sources);
  config.egress_policy.max_sensitivity = 'PUBLIC';
  const low = f.inputs(config), p = prepare(f, low); rejected(() => admit(f, low, p), 'judge_sensitivity_denied');
  config.egress_policy.max_sensitivity = 'INTERNAL'; config.egress_policy.sources[1].allowed_providers = ['vercel'];
  const restricted = f.inputs(config), permitted = prepare(f, restricted);
  rejected(() => admit(f, restricted, permitted), 'judge_provider_denied'); admit(f, restricted, permitted, 'vercel');
});

test('inherited supports remain part of destination policy even when their parent is not a selected target', t => {
  const f = judgeFixture(t), parent = f.target;
  const inherited = f.addTarget({ name: 'derived-target', events: [f.event], parents: [parent] });
  const inputs = f.inputs(), p = prepare(f, inputs, { target_refs: [inherited] });
  assert.equal(p.selection.registrations.length, 2); admit(f, inputs, p);
  const config = structuredClone(f.configuration);
  config.egress_policy.sources.find(source => source.registration_id === f.supportSource.registration_id).local_only = true;
  const local = f.inputs(config), denied = prepare(f, local, { target_refs: [inherited] });
  rejected(() => admit(f, local, denied), 'judge_provider_denied');
});

test('the event union is bounded across individually valid target revisions without truncating provenance', t => {
  const f = judgeFixture(t), refs = [];
  for (let sequence = 1; sequence <= 32; sequence++) {
    const event = capture(f, f.supportSource, { sequence, key: `union-${sequence}`, objectId: `union-object-${sequence}` });
    refs.push(f.addTarget({ name: `union-target-${sequence}`, events: [event] }));
  }
  rejected(() => prepare(f, f.inputs(), { target_refs: refs }), 'judge_input_capacity');
});

test('source revocation, activation disable and opaque grant revocation fence already prepared output', t => {
  for (const change of ['source', 'activation', 'grant']) {
    const f = judgeFixture(t), inputs = f.inputs(), p = prepare(f, inputs);
    if (change === 'source') f.ingress.updateSourceAccess(f.context, { registration_id: f.supportSource.registration_id,
      expectedVersion: f.supportSource.version, access: { ...f.supportSource.registration.access, allowed_principal_ids: [] } });
    if (change === 'activation') f.activation.setEnabled(f.context, { enabled: false, expectedVersion: f.activation.get(f.context).version });
    if (change === 'grant') f.authority.revoke(f.issued.credential_id);
    rejected(() => admit(f, inputs, p, 'typesafe', 'result'));
  }
});

test('head, binding, catalog and current Project selection changes invalidate a prepared proof', t => {
  for (const change of ['head', 'binding', 'catalog', 'selection']) {
    const f = judgeFixture(t, { canonical: true }), inputs = f.inputs(), p = prepare(f, inputs);
    if (change === 'head') f.addTarget({ name: 'new-head' });
    if (change === 'binding') bind(f, { key: 'rebound', exploration_id: f.binding.exploration_id });
    if (change === 'catalog') { git(f.folder, 'branch', 'new-observed-ref'); f.refresh(); }
    if (change === 'selection') f.explorations.setProjectSelection(f.context, { epoch: f.epoch, idempotency_key: 'new-project-pointer',
      expected_version: null, pin: pin(f.canonical) });
    rejected(() => admit(f, inputs, p));
  }
});

test('selected materialization does not nest public reads in activation and refuses a source change just before admission', t => {
  const f = judgeFixture(t), inputs = f.inputs(), p = prepare(f, inputs);
  const original = f.store.transaction.bind(f.store); let changed = false;
  f.store.transaction = (context, operation) => {
    if (!changed) {
      changed = true;
      f.ingress.updateSourceAccess(f.context, { registration_id: f.source.registration_id, expectedVersion: f.source.version,
        access: { ...f.source.registration.access, allowed_principal_ids: [] } });
    }
    return original(context, operation);
  };
  rejected(() => admit(f, inputs, p));
});

test('bounded event and target text reject overflow and caller accessors never execute', t => {
  const f = judgeFixture(t), inputs = f.inputs(); let invoked = 0;
  const request = f.request(); Object.defineProperty(request, 'event_id', { enumerable: true, get() { invoked++; return f.event.event_id; } });
  rejected(() => inputs.prepare(f.context, request, { family: 'context_relevance', question: question() })); assert.equal(invoked, 0);
  const oversized = f.addTarget({ text: 'x'.repeat(4097) }); rejected(() => prepare(f, inputs, { target_refs: [oversized] }), 'judge_input_capacity');
  const source = register(f, { partition: 'oversized-event' }), event = capture(f, source, { text: 'x'.repeat(16385) });
  const config = structuredClone(f.configuration); config.egress_policy.sources.push({ registration_id: source.registration_id,
    local_only: false, allowed_providers: ['typesafe'], text_policy: 'selected-fields' });
  rejected(() => prepare(f, f.inputs(config), { event_id: event.event_id, target_refs: [] }), 'judge_input_capacity');
});
