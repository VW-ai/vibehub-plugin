import test from 'node:test';
import assert from 'node:assert/strict';
import { executeContextJudgeNode } from '../src/application/judge/judge-runtime.mjs';
import { graphHash } from '../src/application/graph/graph-inputs.mjs';
import { contextJudgeFixture, judgeTransport, judgeResponse, judgeJSON, publish, rows, adoption, capture,
  contextRequest, canonicalRefs, gitCodeRef, CONTEXT_JUDGE_ACTIONS } from './helpers/context-judge-fixture.mjs';

const evaluate = (f, extra = {}, options) => f.runtime.evaluateContext(f.context, f.request(extra), options);
const refuse = async operation => {
  try { const result = await operation(); assert.equal(result.status, 'refused', result.reason_code); assert.equal(result.decision, null); assert.deepEqual(result.target_refs, []); return result; }
  catch (error) { if (!error.code || !/^[a-z_]+$/.test(error.code)) throw error; }
};

for (const provider of ['typesafe', 'vercel', 'openrouter']) test(`${provider}: typed Context uses fixed minimal text and exact original refs without durable effects`, async t => {
  const f = await contextJudgeFixture(t, { provider, canonical: true }), calls = judgeTransport(t), before = rows(f);
  const result = await evaluate(f);
  assert.equal(result.status, 'decision', result.reason_code); assert.equal(result.branch, 'positive');
  assert.equal(calls.length, 1); assert.equal(calls[0].provider, provider);
  assert.deepEqual(result.target_refs, [f.target]);
  assert.deepEqual(result.selection.input_profile, { id: 'runtime-context', version: 1 });
  const selected = result.selection.context_targets[0];
  assert.deepEqual(selected.ref, f.target); assert.equal(selected.assertion_status, 'candidate'); assert.equal(selected.projection_status, 'candidate');
  assert.equal(selected.publication_origin_ref, f.targetResult.operation_origin_ref);
  assert.equal(selected.applicability.status, 'uncertain'); assert.deepEqual(selected.applicability.uncertain_dimensions, ['tickets', 'code']);
  assert.equal(result.selection.governance_evaluated, false); assert.equal(result.selection.shared_material_sent, false);
  assert.deepEqual(result.selection.shared.origin_base.authority_record_keys, ['authority']);
  const candidates = calls[0].body.state.candidates;
  assert.equal(candidates.length, 1); assert.equal(candidates[0].id, `target-${graphHash(f.target).slice(7)}`);
  assert.equal(candidates[0].text, 'decision\nUse PostgreSQL as the durable primary store.\n\nPersist durable project records in PostgreSQL.');
  for (const canary of [f.root, f.supportSource.registration_id, f.execution.worktree_id, 'Update selected contract first.', 'Explicit synthetic create', `synthetic-context-${provider}-credential`])
    assert(!JSON.stringify(calls[0].body).includes(canary), canary);
  assert(!JSON.stringify(result).includes('Persist durable project records in PostgreSQL.'));
  assert.equal(result.usage.reserved.attempts, 1); assert.deepEqual(rows(f), before);
});

test('negative relevance has no refs and actual validated/resolved current heads are eligible', async t => {
  const f = await contextJudgeFixture(t), calls = judgeTransport(t, ({ provider, body, ordinal }) => judgeResponse(provider, body, { probability: ordinal === 1 ? 0.05 : 0.95 }));
  const negative = await evaluate(f); assert.equal(negative.branch, 'negative'); assert.deepEqual(negative.target_refs, []);
  const validated = publish(f, 'judge-validated', { base: f.target, status: 'validated', events: [f.supportEvent] });
  f.target = validated.revision;
  const valid = await evaluate(f, { invocation_id: 'validated' }); assert.equal(valid.status, 'decision', valid.reason_code);
  assert.equal(valid.selection.context_targets[0].assertion_status, 'validated');
  const stale = publish(f, 'judge-competitor', { base: f.targetResult.revision, events: [f.supportEvent] });
  const current = f.contexts.resolve(f.context, { exploration_id: f.a.exploration_id, at: f.request().at, address: validated.revision, mode: 'current' });
  const resolved = publish(f, 'judge-resolved', { base: validated.revision, parents: current.local.item.projection.competing,
    status: 'resolved', change: 'resolve', operation_kind: 'resolve', conflict_digest: stale.conflict.conflict_digest, events: [f.supportEvent] });
  f.target = resolved.revision;
  const final = await evaluate(f, { invocation_id: 'resolved' }); assert.equal(final.status, 'decision', final.reason_code);
  assert.equal(final.selection.context_targets[0].projection_status, 'resolved'); assert.equal(calls.length, 3);
});

for (const state of ['historical', 'stale', 'superseded', 'rejected', 'contested', 'foreign', 'untyped', 'canonical']) {
  test(`${state}: ineligible Context target refuses before credentials or provider send`, async t => {
    const f = await contextJudgeFixture(t, { canonical: state === 'canonical' }), calls = judgeTransport(t);
    if (['historical', 'stale', 'superseded', 'rejected'].includes(state)) {
      const changed = publish(f, `excluded-${state}`, { base: f.target, events: [f.supportEvent], status: state === 'historical' ? 'validated' : state,
        change: state === 'stale' ? 'invalidate' : state === 'superseded' ? 'supersede' : 'revise' });
      if (state !== 'historical') f.target = changed.revision;
    } else if (state === 'contested') {
      publish(f, 'selected-winner', { base: f.target, events: [f.supportEvent] });
      publish(f, 'selected-conflict', { base: f.target, events: [f.supportEvent] });
    } else if (state === 'foreign') f.target = publish(f, 'foreign-owned', {}, f.b).revision;
    else if (state === 'canonical') f.target = f.canonical.address;
    else {
      const request = contextRequest(f, f.a, 'legacy-profile');
      request.operation.assertion.content = { semantic_type: 'judge-target', data: { schema_version: 1, kind: 'judge_target', target_kind: 'context', text: 'Synthetic legacy candidate.' } };
      f.target = f.explorations.mutate(f.context, request).revision;
    }
    const before = rows(f); await refuse(() => evaluate(f));
    assert.equal(calls.length, 0); assert.equal(f.secrets.calls, 0); assert.deepEqual(rows(f), before);
  });
}

test('adopted B Context stays eligible after A source supersession and preserves exact B publication', async t => {
  const f = await contextJudgeFixture(t), calls = judgeTransport(t);
  const adopted = f.contexts.adopt(f.context, adoption(f, { source: f.targetResult, key: 'judge-adoption' }));
  publish(f, 'a-superseded', { base: f.target, status: 'superseded', change: 'supersede', events: [f.supportEvent] });
  f.binding = f.b; f.target = adopted.revision;
  const result = await evaluate(f);
  assert.equal(result.status, 'decision', result.reason_code); assert.deepEqual(result.target_refs, [adopted.revision]);
  assert.equal(result.selection.context_targets[0].publication_origin_ref, adopted.operation_origin_ref); assert.equal(calls.length, 1);
});

test('exact actual Ticket/code provenance remains in selection metadata and support policy applies to canonical source', async t => {
  const f = await contextJudgeFixture(t, { canonical: true }), refs = canonicalRefs(f), code = gitCodeRef(f), calls = judgeTransport(t);
  const typed = { applicability: { project: 'owning', exploration: 'owning', tickets: { mode: 'exact', refs: [refs.ticket] }, code: { mode: 'exact', refs: [code.ref] } } };
  const selected = publish(f, 'applicable-judge', { typed, canonical_refs: [...refs.canonical_refs, code.artifact] }); f.target = selected.revision;
  const result = await evaluate(f); assert.equal(result.status, 'decision', result.reason_code);
  const applicability = result.selection.context_targets[0].applicability;
  assert.equal(applicability.status, 'specified'); assert.equal(applicability.tickets.refs[0].ticket_id, 'example');
  assert.equal(applicability.code.refs[0].commit_oid, code.object.oid);
  assert(!JSON.stringify(calls[0].body).includes('.vibehub/ticket.yaml'));
  const denied = structuredClone(f.configuration); denied.egress_policy.sources = denied.egress_policy.sources.filter(s => s.registration_id !== f.canonicalSource.registration_id);
  await refuse(() => f.makeRuntime(denied).evaluateContext(f.context, f.request({ invocation_id: 'missing-canonical-policy' })));
  assert.equal(calls.length, 1);
});

for (const policy of ['missing', 'deny', 'local-only', 'provider-denied', 'source-denied', 'context-grant']) test(`${policy}: Context selection cannot authorize an unapproved send`, async t => {
  const f = await contextJudgeFixture(t), calls = judgeTransport(t), configuration = structuredClone(f.configuration);
  if (policy === 'missing') configuration.egress_policy.sources = configuration.egress_policy.sources.filter(s => s.registration_id !== f.supportSource.registration_id);
  if (policy === 'deny') configuration.egress_policy.sources[1].text_policy = 'deny';
  if (policy === 'local-only') configuration.egress_policy.sources[1].local_only = true;
  if (policy === 'provider-denied') configuration.egress_policy.sources[1].allowed_providers = ['vercel'];
  if (policy === 'source-denied') f.ingress.updateSourceAccess(f.context, { registration_id: f.supportSource.registration_id, expectedVersion: f.supportSource.version,
    access: { ...f.supportSource.registration.access, allowed_principal_ids: [] } });
  if (policy === 'context-grant') f.context = f.issue({ actions: CONTEXT_JUDGE_ACTIONS.filter(a => a !== 'context:read') }).context;
  f.runtime = f.makeRuntime(configuration); const before = rows(f); await refuse(() => evaluate(f));
  assert.equal(calls.length, 0); assert.deepEqual(rows(f), before);
});

test('typed handler pins profile and normalized request, tightens deadlines and preserves reserved usage', async t => {
  const f = await contextJudgeFixture(t), calls = judgeTransport(t), request = f.request(), inputs = f.bridgeInputs(request);
  const valid = await executeContextJudgeNode({ runtime: f.runtime, context: f.context, request, inputs });
  assert.equal(valid.branch, 'positive'); assert.deepEqual(valid.outputs.targets.refs, [f.target]); assert.equal(valid.usage.tokens, 256);
  const mismatch = await executeContextJudgeNode({ runtime: f.runtime, context: f.context, request: { ...request, invocation_id: 'wrong-pins' }, inputs });
  assert.equal(mismatch.error.code, 'handler_error'); assert.equal(calls.length, 1);
  const lateRequest = f.request({ invocation_id: 'tight-deadline' });
  const expired = await executeContextJudgeNode({ runtime: f.runtime, context: f.context, request: lateRequest, inputs: f.bridgeInputs(lateRequest), deadline_ms: performance.now() - 1 });
  assert.equal(expired.error.code, 'handler_error'); assert.equal(calls.length, 1);
});

test('zero targets needs no credentials; UTF-8 text and eight-target boundaries refuse without truncation', async t => {
  const f = await contextJudgeFixture(t), calls = judgeTransport(t);
  const empty = await evaluate(f, { invocation_id: 'empty', target_refs: [] }); assert.equal(empty.reason_code, 'no_visible_targets'); assert.equal(f.secrets.calls, 0);
  const oversized = publish(f, 'wide-typed-text', { typed: { detail: '界'.repeat(1400) } });
  await refuse(() => evaluate(f, { invocation_id: 'wide', target_refs: [oversized.revision] }));
  const many = [];
  for (let i = 0; i < 9; i++) many.push(publish(f, `count-target-${i}`).revision);
  await refuse(() => evaluate(f, { invocation_id: 'nine-targets', target_refs: many }));
  assert.equal(calls.length, 0);
  assert.equal((await evaluate(f, { invocation_id: 'eight-targets', target_refs: many.slice(0, 8) })).status, 'decision'); assert.equal(calls.length, 1);
});

test('configured transient fallback retains one shared attempt reservation while terminal errors do not reroute', async t => {
  const f = await contextJudgeFixture(t, { fallbacks: ['vercel'], max_attempts: 2 });
  const calls = judgeTransport(t, ({ provider, body }) => provider === 'typesafe' ? judgeJSON({}, 429, { 'retry-after': '0' }) : judgeResponse(provider, body));
  const result = await evaluate(f); assert.equal(result.status, 'decision', result.reason_code);
  assert.deepEqual(calls.map(c => c.provider), ['typesafe', 'vercel']); assert.equal(result.usage.reserved.attempts, 2); assert.equal(result.usage.reserved.tokens, 512);
});

test('actual support closure admits 32 events and refuses 33 across multiple eligible Context targets', async t => {
  // This case measures closure capacity. Keep scheduler load in the complete
  // suite separate from the dedicated short-deadline tests.
  const f = await contextJudgeFixture(t, { timeout_ms: 30000 }), calls = judgeTransport(t), events = [f.supportEvent];
  for (let sequence = 1; sequence < 32; sequence++) events.push(capture(f, f.supportSource,
    { sequence, key: `closure-support-${sequence}`, objectId: 'typed-context-support', text: `Synthetic support ${sequence}.` }));
  const first = publish(f, 'closure-first', { events: events.slice(0, 15) });
  const control = publish(f, 'closure-control', { events: events.slice(15, 31) });
  const overflow = publish(f, 'closure-overflow', { events: events.slice(15, 32) });
  const before = rows(f), valid = await evaluate(f, { invocation_id: 'closure-32', target_refs: [first.revision, control.revision] });
  assert.equal(valid.status, 'decision', valid.reason_code); assert.equal(calls.length, 1);
  const credentialCalls = f.secrets.calls;
  await refuse(() => evaluate(f, { invocation_id: 'closure-33', target_refs: [first.revision, overflow.revision] }));
  assert.equal(calls.length, 1); assert.equal(f.secrets.calls, credentialCalls); assert.deepEqual(rows(f), before);
});
