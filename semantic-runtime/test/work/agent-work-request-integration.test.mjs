import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentWorkRequest, createAgentWorkRequestState, createAgentWorkResult,
  agentWorkReturnParameters, transitionAgentWorkRequest, validateAgentWorkReceipt } from '../../src/index.mjs';
import { fingerprint } from '../../src/domain/shared/contracts.mjs';
import { fixture, register, capture, initialize, assertion, mutation, SCOPE } from '../support/graph-store-fixture.mjs';

const hash = value => `sha256:${fingerprint(value)}`;
function setup(t) {
  const f = fixture(t), source = register(f), event = capture(f, source);
  const genesis = initialize(f);
  const saved = f.graph.mutate(f.context, mutation(f, genesis.receipt.next_graph, assertion(f, event)));
  const current = () => f.graph.getHead(f.context, { generation_id: 'generation-1' }).graph_revision;
  const graphPin = at => ({ ref_id: 'graph-base', scope: SCOPE, kind: 'graph_commit',
    object_id: at.generation_id, revision: at.commit_digest, digest: at.commit_digest });
  const inputPin = { ref_id: 'context-input', scope: SCOPE, kind: 'semantic_revision',
    object_id: saved.revision.entity_id, revision: saved.revision.revision_digest, digest: saved.revision.revision_digest };
  const definition = { type: 'object', properties: { suggestion: { type: 'string', maxLength: 1024 } },
    required: ['suggestion'], additionalProperties: false };
  const parameters = agentWorkReturnParameters(definition);
  const instructions = 'Return a candidate suggestion with the cited source. Do not claim acceptance.';
  const request = createAgentWorkRequest({ request_id: 'graph-followup', scope: SCOPE,
    job_id: 'logical-job', attempt_id: 'attempt-1', fencing_token: 1,
    applicability: { exploration_id: null, execution_workspace_id: null, session_id: 'synthetic-session' },
    inputs: [{ ref: inputPin, excerpt: f.graph.resolve(f.context, { at: current(), address: saved.revision }).revision.assertion.content.data.text }],
    base_versions: [graphPin(current())],
    instruction_bundle: { id: 'candidate-followup', version: '1', digest: hash(instructions), instructions },
    required_tools: [{ name: 'submit_proposal', version: '1', origin: 'runtime', action: 'submit_proposal', parameters_schema: parameters,
      examples: [{ request_id: 'graph-followup', request_digest: hash('example'), submission_id: 'submission-1',
        actions: ['propose_context'], output: { suggestion: 'Synthetic suggestion' }, input_ids: ['context-input'] }] }],
    return_tool: { name: 'submit_proposal', version: '1' },
    output_schema: { id: 'context-suggestion', version: '1', definition, digest: hash(definition) },
    allowed_actions: ['submit_proposal', 'propose_context'], allowed_principal_ids: ['owner'], created_at_ms: 1000, deadline_ms: 5000 });
  // This fixture is the trusted adapter: it derives current pins/access from
  // real Graph reads. The pure contract itself performs no source/host IO.
  const admission = (kind, now_ms) => ({ now_ms, actor: { kind, principal_id: 'owner' },
    authorization: { scope: SCOPE, revision: 'synthetic-authorization', revoked: false, can_manage: true,
      allowed_principal_ids: ['owner'], allowed_actions: request.allowed_actions },
    host: { scope: SCOPE, host_id: 'synthetic-host', principal_id: 'owner', session_id: 'synthetic-session', exploration_id: null,
      execution_workspace_id: null, status: 'active', callback: 'available', tools: [{ name: 'submit_proposal', version: '1', origin: 'runtime',
        action: 'submit_proposal', schema_digest: hash(parameters), binding_id: 'synthetic-binding', callable: true }] },
    trusted_bundles: [{ id: request.instruction_bundle.id, version: request.instruction_bundle.version, digest: request.instruction_bundle.digest }],
    current_bases: [graphPin(current())],
    readable_inputs: f.graph.resolve(f.context, { at: current(), address: saved.revision }).status === 'resolved' ? [inputPin] : [] });
  let state = createAgentWorkRequestState(request);
  for (const [type, kind, now] of [['offer', 'runtime', 1100], ['claim', 'agent', 1200]]) {
    const answer = transitionAgentWorkRequest(state, { type, expected_revision: state.revision }, admission(kind, now));
    assert.equal(answer.status, 'applied'); state = answer.state;
  }
  const result = createAgentWorkResult(request, { submission_id: 'submission-1',
    executor: { host_id: 'synthetic-host', session_id: 'synthetic-session', principal_id: 'owner' }, actions: ['propose_context'],
    output: { suggestion: 'A synthetic candidate, pending review.' }, provenance: { input_ids: ['context-input'], authority: 'proposal_only' } });
  return { f, source, event, saved, current, request, state, result, admission };
}

test('public work request consumes actual pinned Graph context and returns one receipt without modifying Graph or accepting work', t => {
  const x = setup(t), at = x.current();
  const command = { type: 'submit', expected_revision: x.state.revision, result: x.result };
  const completed = transitionAgentWorkRequest(x.state, command, x.admission('agent', 1300));
  assert.equal(completed.status, 'applied'); assert.equal(completed.receipt.authority, 'accepted_submission_only');
  assert.equal(validateAgentWorkReceipt(completed.receipt, x.request), true);
  assert.deepEqual(x.current(), at);
  assert.equal(x.f.graph.resolve(x.f.context, { at, address: x.saved.revision }).entity.status, 'candidate');
  const retry = transitionAgentWorkRequest(completed.state, command, x.admission('agent', 6000));
  assert.equal(retry.status, 'duplicate'); assert.deepEqual(retry.receipt, completed.receipt); assert.deepEqual(retry.effects, []);
});

test('actual Graph advancement and source revocation while disabled fence pending Agent proposals', t => {
  const x = setup(t);
  x.f.graph.mutate(x.f.context, mutation(x.f, x.current(), assertion(x.f, x.event, 'new-base', { base_revision: x.saved.revision })));
  const command = { type: 'submit', expected_revision: x.state.revision, result: x.result };
  const stale = transitionAgentWorkRequest(x.state, command, x.admission('agent', 1300));
  assert.equal(stale.reason, 'stale_base'); assert.equal(stale.receipt, null); assert.deepEqual(stale.effects, []);
  x.f.activation.setEnabled(x.f.context, { enabled: false, expectedVersion: x.f.activation.get(x.f.context).version });
  x.f.ingress.updateSourceAccess(x.f.context, { registration_id: x.source.registration_id, expectedVersion: x.source.version,
    access: { ...x.source.registration.access, allowed_principal_ids: [] } });
  const denied = transitionAgentWorkRequest(x.state, command, x.admission('agent', 1400));
  assert.equal(denied.reason, 'input_denied'); assert.equal(denied.receipt, null); assert.deepEqual(denied.state, x.state); assert.deepEqual(denied.effects, []);
});
