import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  RECONCILIATION_BUNDLE, reconciliationPolicyConfig, createReconciliationInput,
  encodeReconciliationProposal, validateReconciliationResult, validateWorkerResult,
  transitionWorkerJob, workerResultDigest, graphRevisionAddress, updateGraphSourceAccess,
} from '../src/index.mjs';
import { scenario, resultEnvelope } from './fixtures/reconciliation/scenario.mjs';
import { context } from './fixtures/worker-protocol/scenario.mjs';
import { event } from './fixtures/working-graph/scenario.mjs';

const complete = (state, result) => ({ type: 'complete', expected_revision: state.revision,
  attempt_id: result.attempt_id, fencing_token: result.fencing_token, result });

test('public reconciliation binds a conflict proposal to compiled policy, Worker result and exact artifact bytes', () => {
  const fixture = scenario('equivalent');
  const original = structuredClone(fixture.admission.current_graph);
  const input = createReconciliationInput(fixture.job, fixture.admission, fixture.request);
  assert.deepEqual(fixture.admission.policy_artifact.definition.nodes.submit.config,
    reconciliationPolicyConfig(fixture.request));
  assert.deepEqual(input.bundle, RECONCILIATION_BUNDLE.pin);
  assert.equal(input.conflicts.length, 1);
  assert.deepEqual(input.conflicts[0].assertions, input.parents);
  const { state, proposal, envelope } = resultEnvelope(fixture);
  const encoded = encodeReconciliationProposal(proposal, input);
  assert.equal(envelope.artifact_json, encoded.artifact_json);
  assert.equal(envelope.result.artifacts[0].digest, encoded.digest);
  const completion = transitionWorkerJob(state, complete(state, envelope.result), context(fixture, 1110, 'worker'));
  assert.equal(completion.status, 'applied');
  assert.equal(completion.state.status, 'succeeded');
  const accepted = validateReconciliationResult(envelope, fixture.admission);
  assert.equal(accepted.status, 'validated');
  assert.equal(accepted.proposal.status, 'resolved');
  assert.equal(accepted.proposal.authority, 'proposal_only');
  assert.deepEqual(accepted.proposal.parents, input.parents);
  assert.deepEqual(accepted.proposal.citations, input.citations);
  assert.deepEqual(accepted.effects, []);
  assert.deepEqual(fixture.admission.current_graph, original);
  assert.equal(original.snapshots.at(-1).conflicts.length, 1);
  assert.equal(original.snapshots.at(-1).resolutions.length, 0);
});

test('transport-valid reconciliation output cannot discard a competing claim through a rehashed artifact', () => {
  const fixture = scenario('equivalent');
  const { envelope } = resultEnvelope(fixture);
  const altered = JSON.parse(envelope.artifact_json);
  altered.parents.pop();
  assert.throws(() => encodeReconciliationProposal(altered, fixture.input), /parents_mismatch/);
  // A worker can publish and hash arbitrary artifact bytes. Transport validation
  // establishes envelope integrity; the business validator must retain parents.
  const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  const artifact_json = JSON.stringify(canonical(altered));
  const result = structuredClone(envelope.result);
  result.artifacts[0].digest = `sha256:${createHash('sha256').update(artifact_json, 'utf8').digest('hex')}`;
  delete result.result_digest;
  result.result_digest = workerResultDigest(result);
  assert.equal(validateWorkerResult(result, fixture.job), true);
  assert.throws(() => validateReconciliationResult({ ...envelope, result, artifact_json }, fixture.admission), /parents_mismatch/);
});

test('a source revocation after successful Worker completion blocks reconciliation before any Graph effect', () => {
  const fixture = scenario('equivalent');
  const { state, envelope } = resultEnvelope(fixture);
  const completion = transitionWorkerJob(state, complete(state, envelope.result), context(fixture, 1110, 'worker'));
  assert.equal(completion.status, 'applied');
  const previous = fixture.admission.current_graph;
  const revoke = event('api', 1, raw => {
    raw.source_event_type = 'access.changed';
    raw.acl = { revision: 'reconciliation-revoked-envelope', allowed_principal_ids: [] };
    raw.provenance.source_objects[0].acl = { revision: 'reconciliation-revoked-source', allowed_principal_ids: [] };
  });
  const changed = updateGraphSourceAccess(previous, {
    expected_graph: graphRevisionAddress(previous), event: revoke, access_state: 'active',
  });
  assert.equal(changed.status, 'applied');
  const currentAdmission = { ...fixture.admission, current_graph: changed.state };
  const admitted = validateReconciliationResult(envelope, currentAdmission);
  assert.equal(admitted.status, 'stale');
  assert.equal(admitted.proposal, null);
  assert.deepEqual(admitted.effects, []);
  assert.equal(changed.state.snapshots.at(-1).resolutions.length, 0);
});
