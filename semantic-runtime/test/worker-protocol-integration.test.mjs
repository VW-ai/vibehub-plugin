import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateWorkerAdmission, transitionWorkerJob, graphRevisionAddress,
  updateGraphSourceAccess,
} from '../src/index.mjs';
import { scenario, context, running, result as workerResult } from './fixtures/worker-protocol/scenario.mjs';
import { event } from './fixtures/working-graph/scenario.mjs';

const complete = (state, result) => ({ type: 'complete', expected_revision: state.revision,
  attempt_id: result.attempt_id, fencing_token: result.fencing_token, result });

test('public Worker protocol can consume a pinned conflict without resolving Graph or certifying acceptance', () => {
  const fixture = scenario({ conflict: true });
  const original = structuredClone(fixture.admission.current_graph);
  assert.equal(validateWorkerAdmission(fixture.job, fixture.admission).status, 'allowed');
  assert.equal(fixture.job.inputs.revisions.length, 2);
  const active = running(fixture);
  const output = workerResult(fixture, active);
  const completion = transitionWorkerJob(active, complete(active, output), context(fixture, 1110, 'worker'));
  assert.equal(completion.status, 'applied');
  assert.equal(completion.state.status, 'succeeded');
  assert.equal(completion.effects.find(effect => effect.type === 'result_available').authority, 'proposal_only');
  assert.deepEqual(fixture.admission.current_graph, original);
  assert.equal(original.snapshots.at(-1).conflicts.length, 1);
  assert.equal(original.snapshots.at(-1).resolutions.length, 0);
  const duplicate = transitionWorkerJob(completion.state, complete(active, output), context(fixture, 1200, 'worker'));
  assert.equal(duplicate.status, 'duplicate');
  assert.deepEqual(duplicate.effects, []);
  assert.deepEqual(duplicate.state, completion.state);
});

test('public Worker lease recovery fences an old result while a new attempt may produce one proposal', () => {
  const fixture = scenario();
  let state = running(fixture);
  const oldResult = workerResult(fixture, state);
  const expired = transitionWorkerJob(state, { type: 'expire', expected_revision: state.revision }, context(fixture, 2000));
  assert.equal(expired.status, 'applied');
  assert.equal(expired.state.status, 'queued');
  state = transitionWorkerJob(expired.state, { type: 'claim', expected_revision: expired.state.revision,
    attempt_id: 'attempt-2' }, context(fixture, 2001)).state;
  assert.equal(state.attempts.at(-1).fencing_token, 2);
  state = transitionWorkerJob(state, { type: 'start', expected_revision: state.revision,
    attempt_id: 'attempt-2', fencing_token: 2 }, context(fixture, 2010, 'worker')).state;
  const late = transitionWorkerJob(state, complete(state, oldResult), context(fixture, 2110, 'worker'));
  assert.equal(late.status, 'rejected');
  assert.deepEqual(late.effects, []);
  assert.deepEqual(late.state, state);
  const freshResult = workerResult(fixture, state);
  const completion = transitionWorkerJob(state, complete(state, freshResult), context(fixture, 2110, 'worker'));
  assert.equal(completion.status, 'applied');
  assert.equal(completion.state.status, 'succeeded');
  assert.equal(completion.state.receipts.length, 1);
  assert.equal(completion.effects.filter(effect => effect.type === 'record_usage').length, 1);
  assert.equal(completion.state.receipts[0].usage.consumption.input_tokens, null);
});

test('a real source ACL update invalidates the captured Worker input before its result is admitted', () => {
  const fixture = scenario();
  const state = running(fixture);
  const output = workerResult(fixture, state);
  const originalGraph = fixture.admission.current_graph;
  const revoke = event('api', 1, raw => {
    raw.source_event_type = 'access.changed';
    raw.acl = { revision: 'revoked-envelope', allowed_principal_ids: [] };
    raw.provenance.source_objects[0].acl = { revision: 'revoked-source', allowed_principal_ids: [] };
  });
  const changed = updateGraphSourceAccess(originalGraph, {
    expected_graph: graphRevisionAddress(originalGraph), event: revoke, access_state: 'active',
  });
  assert.equal(changed.status, 'applied');
  fixture.admission.current_graph = changed.state;
  assert.equal(validateWorkerAdmission(fixture.job, fixture.admission).status, 'denied');
  const rejected = transitionWorkerJob(state, complete(state, output), context(fixture, 1110, 'worker'));
  assert.equal(rejected.status, 'rejected');
  assert.deepEqual(rejected.effects, []);
  assert.deepEqual(rejected.state, state);
});
