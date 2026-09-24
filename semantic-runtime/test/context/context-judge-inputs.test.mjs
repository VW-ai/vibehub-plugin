import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalContextStore } from '../../src/application/context/context-store.mjs';
import { ExplorationCanonical } from '../../src/application/explorations/exploration-canonical.mjs';
import { graphHash } from '../../src/application/graph/graph-inputs.mjs';
import { judgeInputHash } from '../../src/domain/shared/contracts.mjs';
import { contextJudgeFixture, CONTEXT_JUDGE_ACTIONS, publish, canonicalRefs, gitCodeRef, contextRequest, rows } from '../support/context-judge-fixture.mjs';
import { records, digest } from '../support/canonical-reader-fixture.mjs';

const question = { family: 'context_relevance', text: 'Does this exact event relate to the selected Context?' };
const prepare = (f, inputs, request = f.request()) => inputs.prepareContext(f.context, request, { family: question.family, question });
const rejected = (fn, code) => assert.throws(fn, error => typeof error.code === 'string' && (!code || error.code === code));
const admit = (f, inputs, p, provider = 'typesafe', stage = 'dispatch') => inputs.admit(f.context, p, { provider, stage });

test('typed Context proof fixes the model projection, profile signal and nonsecret public metadata', async t => {
  const f = await contextJudgeFixture(t, { canonical: true }), inputs = f.inputs(), request = f.request(), before = rows(f);
  const p = prepare(f, inputs, request);
  assert.deepEqual(p.input, { event: { type: f.event.event_type, timestamp: f.event.observed_at,
    payload: { text: f.ingress.readSnapshot(f.context, { event_id: f.event.event_id }).text } },
  stateRefs: [{ id: `target-${graphHash(f.target).slice(7)}`, type: 'context',
    text: 'decision\nUse PostgreSQL as the durable primary store.\n\nPersist durable project records in PostgreSQL.' }], question });
  assert.equal(p.input_hash, judgeInputHash(p.input));
  assert.deepEqual(p.target_map, [{ id: p.input.stateRefs[0].id, ref: f.target }]);
  assert.deepEqual(p.selection.input_profile, { id: 'runtime-context', version: 1 });
  const selected = f.contexts.resolve(f.context, { exploration_id: f.binding.exploration_id, at: request.at, address: f.target, mode: 'current' });
  assert.deepEqual(p.selection.context_targets, [{ ref: f.target, assertion_status: 'candidate', projection_status: 'candidate',
    applicability: selected.local.item.applicability, publication_origin_ref: selected.local.item.publication.operation_origin_ref }]);
  assert.deepEqual(p.selection_ref, { kind: 'signal_ref', digest: graphHash([{ id: 'runtime-context', version: 1 }, request]) });
  assert.notEqual(p.selection_ref.digest, graphHash(request));
  assert.equal(p.selection.shared.origin_base.status, 'current');
  assert.deepEqual(p.selection.shared.origin_base.authority_record_keys, ['authority']);
  assert.equal(p.selection.governance_evaluated, false); assert.equal(p.selection.shared_material_sent, false);
  for (const excluded of [f.root, f.source.registration_id, 'Explicit synthetic create', 'Update selected contract first.'])
    assert.equal(JSON.stringify(p.input).includes(excluded), false);
  for (const excluded of ['Use PostgreSQL', 'Explicit synthetic create', 'Update selected contract first.', f.root])
    assert.equal(JSON.stringify(p.selection).includes(excluded), false);
  assert(Object.isFrozen(p.selection.context_targets[0].applicability));
  assert.equal(admit(f, inputs, p), p);
  rejected(() => admit(f, inputs, structuredClone(p)), 'invalid_judge_proof');
  assert.deepEqual(rows(f), before);
});

test('admission rechecks selected Context through the fixed transaction view without nested public snapshots', async t => {
  const f = await contextJudgeFixture(t), inputs = f.inputs(), p = prepare(f, inputs);
  t.mock.method(LocalContextStore.prototype, 'resolve', () => { throw new Error('Public Context read inside admission'); });
  t.mock.method(f.store, 'readSnapshot', () => { throw new Error('Nested DomainStore snapshot'); });
  assert.equal(admit(f, inputs, p), p); assert.equal(admit(f, inputs, p, 'typesafe', 'result'), p);
  f.ingress.updateSourceAccess(f.context, { registration_id: f.supportSource.registration_id,
    expectedVersion: f.supportSource.version, access: { ...f.supportSource.registration.access, allowed_principal_ids: [] } });
  rejected(() => admit(f, inputs, p, 'typesafe', 'result'));
});

test('actual Ticket and code applicability retain exact pins and require their real source destination policy', async t => {
  const f = await contextJudgeFixture(t, { canonical: true }), ticket = canonicalRefs(f), code = gitCodeRef(f);
  const result = publish(f, 'ticket-and-code-context', { events: [f.supportEvent], canonical_refs: [ticket.artifact, code.artifact],
    typed: { applicability: { project: 'owning', exploration: 'owning', tickets: { mode: 'exact', refs: [ticket.ticket] },
      code: { mode: 'exact', refs: [code.ref] } } } });
  f.target = result.revision;
  const inputs = f.inputs(), p = prepare(f, inputs), applicability = p.selection.context_targets[0].applicability;
  assert.equal(applicability.status, 'specified');
  assert.equal(applicability.tickets.refs[0].selection_status, 'current');
  assert.deepEqual(applicability.tickets.refs[0].ref, ticket.ticket);
  assert.deepEqual(applicability.code.refs[0].ref, code.ref);
  assert.equal(applicability.code.refs[0].path, code.path);
  assert.equal(applicability.code.refs[0].commit_oid, code.object.oid);
  assert.equal(p.selection.registrations.length, 3); admit(f, inputs, p);
  const config = structuredClone(f.configuration);
  config.egress_policy.sources = config.egress_policy.sources.filter(source => source.registration_id !== f.canonicalSource.registration_id);
  rejected(() => prepare(f, f.inputs(config)), 'judge_source_policy_denied');
  config.egress_policy.sources = structuredClone(f.configuration.egress_policy.sources);
  config.egress_policy.sources.find(source => source.registration_id === f.canonicalSource.registration_id).local_only = true;
  const local = f.inputs(config), denied = prepare(f, local);
  rejected(() => admit(f, local, denied), 'judge_provider_denied');
});

test('zero targets still require Context read authority without a fabricated selector', async t => {
  const f = await contextJudgeFixture(t), inputs = f.inputs(), request = f.request({ target_refs: [] });
  t.mock.method(LocalContextStore.prototype, 'resolve', () => { throw new Error('No target may be fabricated'); });
  const p = prepare(f, inputs, request);
  assert.deepEqual(p.selection.context_targets, []); assert.deepEqual(p.input.stateRefs, []);
  assert.equal(admit(f, inputs, p, null), p);
  const limited = f.issue({ actions: CONTEXT_JUDGE_ACTIONS.filter(action => action !== 'context:read') });
  rejected(() => inputs.prepareContext(limited.context, request, { family: question.family, question }), 'context_unauthorized');
  rejected(() => inputs.prepareContext(f.context, request, { family: 'acceptance_relevance',
    question: { ...question, family: 'acceptance_relevance' } }), 'judge_target_invalid');
  assert.deepEqual(p.target_refs, []);
});

test('Ticket support may be inherited while code applicability must remain explicit on the selected assertion', async t => {
  const f = await contextJudgeFixture(t, { canonical: true }), ticket = canonicalRefs(f), code = gitCodeRef(f);
  const parent = publish(f, 'inherited-support-parent', { events: [f.supportEvent], canonical_refs: [ticket.artifact, code.artifact] });
  const applicability = { project: 'owning', exploration: 'owning', tickets: { mode: 'exact', refs: [ticket.ticket] },
    code: { mode: 'exact', refs: [code.ref] } };
  const child = publish(f, 'inherited-ticket-child', { parents: [parent.revision], events: [f.event],
    canonical_refs: [code.artifact], typed: { applicability } });
  f.target = child.revision;
  const revision = f.graph.resolve(f.context, { at: child.receipt.next_graph, address: child.revision }).revision;
  assert.deepEqual(revision.assertion.canonical_refs, [code.artifact]);
  assert(revision.provenance.events.some(event => graphHash(event) === graphHash(ticket.artifact.event)));
  const inputs = f.inputs(), p = prepare(f, inputs), actual = p.selection.context_targets[0].applicability;
  assert.deepEqual(actual.tickets.refs.map(item => item.ref), [ticket.ticket]);
  assert.deepEqual(actual.code.refs.map(item => item.ref), [code.ref]);
  assert.equal(p.selection.registrations.length, 3); admit(f, inputs, p);
  const config = structuredClone(f.configuration);
  config.egress_policy.sources = config.egress_policy.sources.filter(source => source.registration_id !== f.canonicalSource.registration_id);
  rejected(() => prepare(f, f.inputs(config)), 'judge_source_policy_denied');
  // The broader Graph route can store this typed claim, but inherited code
  // alone must not make it a valid selected Context for the Judge bridge.
  const invalid = f.explorations.mutate(f.context, contextRequest(f, f.a, 'inherited-code-only', {
    parents: [parent.revision], events: [f.event], canonical_refs: [], typed: { applicability } }));
  rejected(() => prepare(f, inputs, f.request({ target_refs: [invalid.revision] })), 'context_source_mismatch');
});

test('nine Ticket record keys share one pin across targets without sharing each target support obligations', async t => {
  const template = records(), values = { authority: template.authority }, keys = [];
  for (let index = 0; index < 9; index++) {
    const key = `ticket-${index}`, ticket = structuredClone(template.ticket); keys.push(key); ticket.ticket_id = key;
    for (const acceptance of ticket.acceptance) acceptance.identity = digest({ ticket_id: key,
      acceptance_id: acceptance.acceptance_id, revision: acceptance.revision, criterion: acceptance.criterion,
      authority: acceptance.authority, derived_from: [] });
    const contract = ticket.contract_revisions[0];
    contract.acceptance_revisions = ticket.acceptance.map(({ acceptance_id, revision, identity }) => ({ acceptance_id, revision, identity }));
    contract.identity = digest({ ticket_id: key, revision: contract.revision, acceptance_revisions: contract.acceptance_revisions });
    values[key] = ticket;
  }
  const f = await contextJudgeFixture(t, { canonical: true, values }), byTarget = new Map(), targets = [];
  for (const [index, selectedKeys] of [keys.slice(0, 5), keys.slice(4)].entries()) {
    const selected = selectedKeys.map(key => canonicalRefs(f, key));
    const result = publish(f, `shared-pin-target-${index}`, { events: [f.supportEvent],
      canonical_refs: selected.map(item => item.artifact), typed: { applicability: {
        project: 'owning', exploration: 'owning', tickets: { mode: 'exact', refs: selected.map(item => item.ticket) },
        code: { mode: 'unspecified', refs: [] } } } });
    targets.push(result.revision); byTarget.set(result.revision.entity_id, selectedKeys);
  }
  let unionReads = 0;
  const original = ExplorationCanonical.prototype.prepare;
  t.mock.method(ExplorationCanonical.prototype, 'prepare', function (context, pin, options) {
    if (pin?.record_keys.length === 9) unionReads++;
    return original.call(this, context, pin, options);
  });
  const inputs = f.inputs(), request = f.request({ target_refs: targets }), p = prepare(f, inputs, request);
  assert.equal(unionReads, 1, 'one actual canonical preparation for the common nine-key pin within this invocation');
  assert.equal(p.selection.context_targets.length, 2);
  for (const target of p.selection.context_targets) assert.deepEqual(
    target.applicability.tickets.refs.map(item => item.ref.record_key), byTarget.get(target.ref.entity_id));
  assert.equal(p.selection.registrations.length, 3); admit(f, inputs, p);
  prepare(f, inputs, request);
  assert.equal(unionReads, 2, 'a new preparation obtains fresh canonical proof rather than reusing invocation authority');
});
