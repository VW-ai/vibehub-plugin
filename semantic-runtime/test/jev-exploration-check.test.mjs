import test from 'node:test';
import assert from 'node:assert/strict';
import { checkExplorationJev } from '../scripts/check-jev-exploration.mjs';
import { edgeCases } from '../scripts/check-jev-synthetic.mjs';
import { DomainStore, LocalExplorationStore } from '../src/index.mjs';

const decision = entry => ({ value: { relevant: entry[4], target_ids: entry[5] }, confidence: 0.9,
  latency_ms: 1, provider: 'synthetic', model: 'fixture', reason_code: 'synthetic' });

test('exploration JEV smoke sends exact isolated target state outside SQLite views and rejects an in-flight stale workspace result', async t => {
  let calls = 0, activeViews = 0, modelPending = false, switchedWhilePending = false;
  const bound = [], stateRevisions = new Map(), judgments = [];
  for (const method of ['readSnapshot', 'transaction']) {
    const original = DomainStore.prototype[method];
    t.mock.method(DomainStore.prototype, method, function (...args) {
      activeViews++; try { return original.apply(this, args); } finally { activeViews--; }
    });
  }
  const bind = LocalExplorationStore.prototype.bind;
  t.mock.method(LocalExplorationStore.prototype, 'bind', function (context, input) {
    if (input.idempotency_key === 'jev-rebind-during-model') switchedWhilePending = modelPending;
    const result = bind.call(this, context, input); bound.push(result); return result;
  });
  const resolve = LocalExplorationStore.prototype.resolve;
  t.mock.method(LocalExplorationStore.prototype, 'resolve', function (...args) {
    const result = resolve.apply(this, args), revision = result.local?.revision;
    if (revision?.entity_id.startsWith('jev-state-')) stateRevisions.set(revision.revision_digest, revision);
    if (revision?.entity_id.startsWith('jev-judgment-')) judgments.push(revision);
    return result;
  });
  const mutate = LocalExplorationStore.prototype.mutate;
  let staleRequest;
  t.mock.method(LocalExplorationStore.prototype, 'mutate', function (context, input) {
    assert.equal(input.expected_source_fence, 0);
    if (input.idempotency_key === 'jev-stale-result') staleRequest = input;
    return mutate.call(this, context, input);
  });
  const report = await checkExplorationJev({ async evaluate(input, { signal }) {
    assert.equal(activeViews, 0, 'dispatch occurs after every database view closes');
    const index = calls++, selected = edgeCases[index === 4 ? 0 : index];
    assert(signal instanceof AbortSignal);
    assert.deepEqual(Object.keys(input).sort(), ['event', 'question', 'stateRefs']);
    assert.deepEqual(Object.keys(input.event).sort(), ['payload', 'timestamp', 'type']);
    assert.deepEqual(input.event.payload, { text: selected[2] });
    assert.equal(input.event.type, 'AGENT_MESSAGE');
    assert.deepEqual(input.stateRefs, selected[3]);
    for (const target of input.stateRefs) assert.deepEqual(Object.keys(target).sort(), ['id', 'text']);
    const serialized = JSON.stringify(input);
    for (const branch of bound) for (const name of ['exploration_id', 'generation_id', 'execution_workspace_id']) {
      assert(!serialized.includes(branch[name]));
    }
    assert(!serialized.includes('expected')); assert(!serialized.includes('registration_id'));
    assert(!serialized.includes('/private/')); assert(!serialized.includes('/Users/'));
    const branch = bound[index === 4 ? 0 : index % 2];
    for (const target of input.stateRefs) {
      assert([...stateRevisions.values()].some(revision => revision.generation_id === branch.generation_id
        && revision.assertion.content.data.id === target.id && revision.assertion.content.data.text === target.text),
      'every minimized target was actually resolved from the selected exploration');
    }
    modelPending = true; await new Promise(resolve => setTimeout(resolve, 1)); modelPending = false;
    return decision(selected);
  } });
  assert.equal(calls, 5); assert.equal(switchedWhilePending, true); assert.equal(bound.length, 3);
  assert.equal(report.total, 4); assert.equal(report.completed, 4); assert.equal(report.matched, 4);
  assert.equal(report.model_calls, 5);
  assert.deepEqual(report.rows.map(row => row.exploration), ['A', 'B', 'A', 'B']);
  assert.equal(report.routing.state_materializations, 9); assert.equal(report.routing.candidate_judgments, 4);
  assert.equal(report.routing.provenance_sources_verified, 13); assert.equal(report.routing.minimized_inputs_verified, 5);
  assert.equal(report.routing.cross_exploration_input, false); assert.equal(report.routing.source_fence_pinned, true);
  assert.equal(report.ingress.selected_admitted_events, 13);
  assert.equal(report.stale_result.status, 'rejected'); assert.equal(report.stale_result.model_completed, true);
  assert.equal(report.stale_result.receipt_absent, true); assert.equal(report.stale_result.unchanged_graphs, true);
  assert.equal(report.stale_result.rejected_store_row_delta, 0);
  assert(staleRequest); assert.equal(staleRequest.execution_workspace_id, bound[0].execution_workspace_id);
  assert.notEqual(staleRequest.execution_workspace_id, bound[2].execution_workspace_id);
  assert.equal(judgments.length, 4);
  for (const [index, revision] of judgments.entries()) {
    assert.equal(revision.generation_id, bound[index % 2].generation_id);
    assert.equal(revision.assertion.parents.length, edgeCases[index][3].length);
    assert.equal(revision.provenance.events.length, 1 + edgeCases[index][3].length);
    for (const parent of revision.assertion.parents) {
      assert.equal(parent.generation_id, revision.generation_id);
      assert(stateRevisions.has(parent.revision_digest), 'published source parents are the exact selected target revisions');
    }
  }
  const serializedReport = JSON.stringify(report);
  assert(!serializedReport.includes('registration_id')); assert(!serializedReport.includes('credential'));
  for (const branch of bound) assert(!serializedReport.includes(branch.generation_id));
});

test('exploration smoke keeps transport failures and semantic labels local and never prints raw provider errors', async () => {
  let calls = 0;
  const report = await checkExplorationJev({ async evaluate() {
    const index = calls++;
    if (index === 0 || index === 4) throw new Error('PRIVATE-PROVIDER-CANARY');
    return decision(edgeCases[index]);
  } });
  assert.equal(calls, 5); assert.equal(report.completed, 3); assert.equal(report.matched, 3);
  assert.equal(report.rows[0].status, 'model_failed');
  assert.equal(report.stale_result.status, 'model_failed'); assert.equal(report.stale_result.model_completed, false);
  assert.equal(report.routing.candidate_judgments, 3);
  assert(!JSON.stringify(report).includes('PRIVATE-PROVIDER-CANARY'));
});
