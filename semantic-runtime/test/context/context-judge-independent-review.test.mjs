import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { executeContextJudgeNode } from '../../src/application/judge/judge-runtime.mjs';
import { graphHash } from '../../src/application/graph/graph-inputs.mjs';
import { judgeRequest } from '../../src/application/judge/judge-contract.mjs';
import { contextJudgeFixture, judgeTransport, judgeResponse, contextRequest, publish, adoption, rows, SCOPE } from '../support/context-judge-fixture.mjs';

test('independent review: caller mutation cannot relax the frozen Context source policy', async t => {
  const f = await contextJudgeFixture(t), calls = judgeTransport(t), config = structuredClone(f.configuration);
  const source = config.egress_policy.sources.find(item => item.registration_id === f.supportSource.registration_id);
  source.text_policy = 'deny';
  const runtime = f.makeRuntime(config);
  source.text_policy = 'selected-fields';
  const before = rows(f), result = await runtime.evaluateContext(f.context, f.request());
  assert.equal(result.status, 'refused'); assert.equal(result.reason_code, 'judge_source_policy_denied');
  assert.equal(result.decision, null); assert.deepEqual(result.target_refs, []);
  assert.equal(calls.length, 0); assert.equal(f.secrets.calls, 0); assert.deepEqual(rows(f), before);
});

test('independent review: caller mutation cannot replace the compiled Context question or descriptor', async t => {
  const f = await contextJudgeFixture(t), calls = judgeTransport(t), config = structuredClone(f.configuration);
  const runtime = f.makeRuntime(config), original = structuredClone(config.artifact);
  config.artifact.definition.nodes.judge.config.question_text = 'UNAUTHORIZED_QUESTION_REPLACEMENT';
  config.artifact.definition.nodes.judge.operation.id = 'semantic-judge';
  config.artifact.operations.find(item => item.id === 'semantic-context-judge').implementation_hash = `sha256:${'0'.repeat(64)}`;
  const result = await runtime.evaluateContext(f.context, f.request());
  assert.equal(result.status, 'decision', result.reason_code); assert.equal(calls.length, 1);
  assert(!JSON.stringify(calls[0].body).includes('UNAUTHORIZED_QUESTION_REPLACEMENT'));
  assert.equal(result.selection.policy.content_hash, original.content_hash);
  assert.equal(result.selection.policy.executable_hash, original.executable_hash);
});

test('independent review: even zero-target Context dispatch rejects the legacy request-only selection signal', async t => {
  const f = await contextJudgeFixture(t), calls = judgeTransport(t), request = f.request({ target_refs: [] });
  const actual = f.bridgeInputs(request), legacy = { ...actual, selection: { kind: 'signal_ref', digest: graphHash(judgeRequest(request)) } };
  const before = rows(f);
  const wrong = await executeContextJudgeNode({ runtime: f.runtime, context: f.context, request, inputs: legacy });
  assert.equal(wrong.error.code, 'handler_error'); assert.equal(wrong.branch, undefined);
  const valid = await executeContextJudgeNode({ runtime: f.runtime, context: f.context, request, inputs: actual });
  assert.equal(valid.branch, 'negative'); assert.equal(valid.outputs.relevant, false); assert.deepEqual(valid.outputs.targets.refs, []);
  assert.equal(calls.length, 0); assert.equal(f.secrets.calls, 0); assert.deepEqual(rows(f), before);
});

function corruptPublication(f) {
  const original = f.store.getSource(f.context, 'exploration-projection', f.targetResult.operation_origin_ref).value;
  const { identity: _identity, ...body } = original;
  body.publisher_execution_id = 'independent-review-forged-execution';
  const db = new DatabaseSync(f.filePath);
  try {
    assert.equal(db.prepare('UPDATE sources SET value=? WHERE tenant_id=? AND project_id=? AND namespace=? AND id=?').run(
      JSON.stringify({ ...body, identity: graphHash(body) }), SCOPE.tenant_id, SCOPE.project_id,
      'exploration-projection', f.targetResult.operation_origin_ref).changes, 1);
  } finally { db.close(); }
}

for (const boundary of ['credential', 'completed-response']) test(`independent review: changed actual publication at ${boundary} cannot return or cache a Context decision`, async t => {
  const f = await contextJudgeFixture(t), request = f.request();
  let changedRows, providerCompleted = false;
  const tamper = () => { corruptPublication(f); changedRows = rows(f); };
  if (boundary === 'credential') f.secrets.beforeUse = async () => { tamper(); };
  const calls = judgeTransport(t, ({ provider, body }) => {
    assert.equal(boundary, 'completed-response');
    tamper(); providerCompleted = true;
    return judgeResponse(provider, body);
  });
  const result = await f.runtime.evaluateContext(f.context, request);
  assert.equal(result.status, 'refused', result.reason_code); assert.equal(result.decision, null); assert.deepEqual(result.target_refs, []);
  assert.equal(calls.length, boundary === 'credential' ? 0 : 1);
  assert.equal(providerCompleted, boundary === 'completed-response');
  assert.deepEqual(rows(f), changedRows);
  f.secrets.beforeUse = null;
  const retry = await f.runtime.evaluateContext(f.context, request);
  assert.equal(retry.status, 'refused'); assert.equal(retry.decision, null); assert.equal(retry.cache, 'miss');
  assert.equal(calls.length, boundary === 'credential' ? 0 : 1); assert.deepEqual(rows(f), changedRows);
});

for (const hops of [1, 2]) test(`independent review: ${hops} broader adoption hops cannot make an invalid typed source transition eligible for Judge dispatch`, async t => {
  const f = await contextJudgeFixture(t), calls = judgeTransport(t);
  const malformed = f.explorations.mutate(f.context, contextRequest(f, f.a, 'independent-false-creation',
    { base: f.target, change: 'create' }));
  assert.throws(() => f.contexts.resolve(f.context, { exploration_id: f.a.exploration_id, at: f.request().at,
    address: malformed.revision, mode: 'current' }), { code: 'context_transition_invalid' });
  let adopted = f.explorations.adopt(f.context, adoption(f, { source: malformed, key: 'independent-broad-adoption' }));
  f.binding = f.b;
  if (hops === 2) {
    adopted = f.explorations.adopt(f.context, adoption(f, { source: adopted, a: f.b, b: f.a, key: 'independent-broad-re-adoption' }));
    f.binding = f.a;
  }
  f.target = adopted.revision;
  const before = rows(f), result = await f.runtime.evaluateContext(f.context, f.request());
  assert.equal(result.status, 'refused', result.reason_code); assert.equal(result.decision, null); assert.deepEqual(result.target_refs, []);
  assert.equal(calls.length, 0); assert.equal(f.secrets.calls, 0); assert.deepEqual(rows(f), before);
});

test('independent review: exact adopted revise history remains eligible after both source instances are superseded', async t => {
  const f = await contextJudgeFixture(t), calls = judgeTransport(t);
  const revised = publish(f, 'independent-real-revision', { base: f.target, status: 'validated', events: [f.supportEvent] });
  const adoptedB = f.contexts.adopt(f.context, adoption(f, { source: revised, key: 'independent-valid-b' }));
  const adoptedA = f.contexts.adopt(f.context, adoption(f, { source: adoptedB, a: f.b, b: f.a, key: 'independent-valid-a' }));
  publish(f, 'independent-source-a-superseded', { base: revised.revision, status: 'superseded', change: 'supersede', events: [f.supportEvent] });
  publish(f, 'independent-source-b-superseded', { base: adoptedB.revision, status: 'superseded', change: 'supersede', events: [f.supportEvent] }, f.b);
  f.target = adoptedA.revision;
  const before = rows(f), result = await f.runtime.evaluateContext(f.context, f.request());
  assert.equal(result.status, 'decision', result.reason_code); assert.deepEqual(result.target_refs, [adoptedA.revision]);
  assert.equal(result.selection.context_targets[0].publication_origin_ref, adoptedA.operation_origin_ref);
  assert.equal(calls.length, 1); assert.deepEqual(rows(f), before);
});
