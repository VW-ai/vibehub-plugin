import test from 'node:test';
import assert from 'node:assert/strict';
import { executeJudgeNode } from '../src/local/judge-runtime.mjs';
import { graphHash } from '../src/local/graph-inputs.mjs';
import { runtimeFixture, judgeTransport, judgeResponse, judgeJSON, judgeRoute } from './helpers/judge-runtime-fixture.mjs';
import { JUDGE_ACTIONS } from './helpers/judge-fixture.mjs';
import { bind, rows, git } from './helpers/exploration-fixture.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const evaluate = (f, extra = {}, options) => f.runtime.evaluate(f.context, f.request(extra), options);
const revokeSource = f => f.ingress.updateSourceAccess(f.context, { registration_id: f.supportSource.registration_id,
  expectedVersion: f.supportSource.version, access: { ...f.supportSource.registration.access, allowed_principal_ids: [] } });

for (const family of ['acceptance_relevance', 'context_relevance', 'durable_cross_ticket_value', 'independently_schedulable_work']) {
  test(`${family}: actual selected ingress and local candidates produce bounded decision with exact refs`, async t => {
    const f = await runtimeFixture(t, { family, canonical: true }), calls = judgeTransport(t), before = rows(f);
    const result = await evaluate(f);
    assert.equal(result.status, 'decision', result.reason_code); assert.equal(result.branch, 'positive');
    assert.equal(calls.length, 1); assert.equal(calls[0].provider, 'typesafe');
    assert.equal(result.selection.governance_evaluated, false); assert.equal(result.selection.shared_material_sent, false);
    assert.deepEqual(result.selection.shared.origin_base.authority_record_keys, ['authority']);
    const relational = ['acceptance_relevance', 'context_relevance'].includes(family);
    assert.deepEqual(result.target_refs, relational ? [f.target] : []);
    assert.deepEqual(result.decision.value.target_ids, relational ? [`target-${graphHash(f.target).slice(7)}`] : []);
    assert.equal(calls[0].body.state.event.text, 'Selected synthetic context.');
    assert.equal(calls[0].body.state.candidates.length, relational ? 1 : 0);
    assert.equal(result.usage.reserved.attempts, 1); assert.equal(result.usage.observed.tokens, 15);
    assert.equal(result.usage.observed.cost_microunits, null);
    for (const excluded of [f.root, f.source.registration_id, f.execution.worktree_id, 'Update selected contract first.', 'synthetic-fixture-typesafe-credential'])
      assert.equal(JSON.stringify(calls[0].body).includes(excluded), false);
    assert.equal(JSON.stringify(result).includes('Synthetic selected candidate.'), false);
    assert.deepEqual(rows(f), before, 'Judge itself publishes no Graph change, ingress ACK or durable attempt');
  });
}

for (const provider of ['typesafe', 'vercel', 'openrouter']) test(`${provider}: actual configured route works through public runtime`, async t => {
  const f = await runtimeFixture(t, { provider }), calls = judgeTransport(t);
  const result = await evaluate(f);
  assert.equal(result.status, 'decision', result.reason_code); assert.equal(calls.length, 1);
  assert.equal(result.attempts[0].provider, provider); assert.equal(calls[0].provider, provider);
});

test('relational empty selection is deterministic and does not look up credentials or send', async t => {
  const f = await runtimeFixture(t), calls = judgeTransport(t);
  await f.providerSettings.removeCredential(f.configuration.settings_project_id, 'typesafe');
  const result = await evaluate(f, { target_refs: [] });
  assert.equal(result.status, 'decision', result.reason_code); assert.equal(result.branch, 'negative');
  assert.equal(result.reason_code, 'no_visible_targets'); assert.deepEqual(result.attempts, []);
  assert.equal(result.usage.reserved.attempts, 0); assert.equal(f.secrets.calls, 0); assert.equal(calls.length, 0);
});

test('completed cache rechecks current proof, isolates actors and needs no credential for an existing authorized result', async t => {
  const f = await runtimeFixture(t), calls = judgeTransport(t), request = f.request();
  const first = await f.runtime.evaluate(f.context, request);
  assert.equal(first.status, 'decision', first.reason_code);
  await f.providerSettings.removeCredential(f.configuration.settings_project_id, 'typesafe');
  const hit = await f.runtime.evaluate(f.context, request);
  assert.equal(hit.cache, 'hit'); assert.equal(hit.result_digest, first.result_digest);
  assert.equal(calls.length, 1); assert.equal(f.secrets.calls, 1);
  await f.providerSettings.replaceCredential(f.configuration.settings_project_id, 'typesafe', 'synthetic-new-fixture-key');
  const reader = f.issue({ principal: 'reader', actions: JUDGE_ACTIONS });
  const secondActor = await f.runtime.evaluate(reader.context, request);
  assert.equal(secondActor.cache, 'miss'); assert.equal(secondActor.status, 'decision', secondActor.reason_code); assert.equal(calls.length, 2);
  revokeSource(f);
  const denied = await f.runtime.evaluate(f.context, request);
  assert.equal(denied.status, 'refused'); assert.equal(denied.decision, null); assert.equal(calls.length, 2);
});

test('cache settings changes and opaque grant revocation refuse stale reuse without another send', async t => {
  const f = await runtimeFixture(t), calls = judgeTransport(t);
  assert.equal((await evaluate(f)).status, 'decision');
  const settings = f.providerSettings.getConfig(f.configuration.settings_project_id);
  await f.providerSettings.configure(f.configuration.settings_project_id, { ...settings, timeout_ms: settings.timeout_ms - 1 });
  const changed = await evaluate(f);
  assert.equal(changed.status, 'refused'); assert.equal(changed.reason_code, 'judge_cache_stale'); assert.equal(calls.length, 1);
  const fresh = f.request({ invocation_id: 'fresh-after-config' });
  assert.equal((await f.runtime.evaluate(f.context, fresh)).status, 'decision');
  f.authority.revoke(f.issued.credential_id);
  const revoked = await f.runtime.evaluate(f.context, fresh);
  assert.equal(revoked.status, 'refused'); assert.equal(calls.length, 2);
});

test('same invocation in flight is deduplicated, changed reuse conflicts, completion remains cacheable', async t => {
  const f = await runtimeFixture(t), sent = deferred(), release = deferred();
  const calls = judgeTransport(t, async ({ provider, body }) => { sent.resolve(); await release.promise; return judgeResponse(provider, body); });
  const pending = evaluate(f); await sent.promise;
  assert.equal((await evaluate(f)).reason_code, 'invocation_in_progress');
  assert.equal((await evaluate(f, { target_refs: [] })).reason_code, 'judge_invocation_conflict');
  release.resolve(); assert.equal((await pending).status, 'decision');
  assert.equal((await evaluate(f)).cache, 'hit');
  assert.equal((await evaluate(f, { target_refs: [] })).reason_code, 'judge_invocation_conflict'); assert.equal(calls.length, 1);
});

test('bounded in-flight admission allows eight keys and refuses the ninth without a send', async t => {
  const f = await runtimeFixture(t, { timeout_ms: 15000 }), release = deferred();
  const calls = judgeTransport(t, async ({ provider, body }) => { await release.promise; return judgeResponse(provider, body); });
  const pending = Array.from({ length: 8 }, (_, i) => evaluate(f, { invocation_id: `parallel-${i}` }));
  const denied = await evaluate(f, { invocation_id: 'parallel-overflow' });
  assert.equal(denied.reason_code, 'judge_concurrency_limit');
  release.resolve(); const results = await Promise.all(pending);
  assert(results.every(result => result.status === 'decision'), results.map(r => r.reason_code).join(',')); assert.equal(calls.length, 8);
});

test('only configured transient fallback can send another route; reservations and unknown billing survive failed attempt', async t => {
  const f = await runtimeFixture(t, { fallbacks: ['vercel'], max_attempts: 2 });
  const calls = judgeTransport(t, ({ provider, body }) => provider === 'typesafe'
    ? judgeJSON({ error: 'synthetic overloaded' }, 429, { 'retry-after': '0' }) : judgeResponse(provider, body));
  const result = await evaluate(f);
  assert.equal(result.status, 'decision', result.reason_code);
  assert.deepEqual(calls.map(c => c.provider), ['typesafe', 'vercel']);
  assert.equal(result.usage.reserved.attempts, 2); assert.equal(result.usage.reserved.tokens, 512);
  assert.equal(result.usage.observed.tokens, null); assert.equal(result.usage.observed.cost_microunits, null);
  assert.deepEqual(result.attempts.map(a => a.status), ['rate_limited', 'completed']);
});

for (const status of [401, 403, 400]) test(`HTTP${status} is terminal even with an allowed configured fallback`, async t => {
  const f = await runtimeFixture(t, { fallbacks: ['openrouter'], max_attempts: 3 });
  const calls = judgeTransport(t, () => judgeJSON({ error: { message: 'synthetic secret body' } }, status));
  const result = await evaluate(f);
  assert.equal(result.status, 'deferred'); assert.equal(result.reason_code, status === 400 ? 'invalid_decision' : 'credential_rejected');
  assert.equal(result.decision, null); assert.equal(calls.length, 1); assert.equal(result.usage.reserved.attempts, 1);
  assert.equal(JSON.stringify(result).includes('synthetic secret body'), false);
});

test('transient failures exhaust finite attempts and missing primary credential never searches fallbacks', async t => {
  const f = await runtimeFixture(t, { max_attempts: 2, fallbacks: ['vercel'] });
  const calls = judgeTransport(t, () => judgeJSON({ error: 'synthetic unavailable' }, 503, { 'retry-after': '0' }));
  const failed = await evaluate(f);
  assert.equal(failed.status, 'deferred'); assert.equal(failed.reason_code, 'provider_unavailable');
  assert.equal(calls.length, 2); assert.equal(failed.attempts.length, 2);
  await f.providerSettings.removeCredential(f.configuration.settings_project_id, 'typesafe');
  const missing = await evaluate(f, { invocation_id: 'missing-primary' });
  assert.equal(missing.reason_code, 'credential_missing'); assert.equal(calls.length, 2);
});

for (const policy of ['local_only', 'provider-denied', 'missing']) test(`${policy}: source policy refusal sends zero model requests`, async t => {
  const f = await runtimeFixture(t), calls = judgeTransport(t);
  const config = structuredClone(f.configuration);
  if (policy === 'local_only') config.egress_policy.sources[1].local_only = true;
  if (policy === 'provider-denied') config.egress_policy.sources[1].allowed_providers = ['vercel'];
  if (policy === 'missing') config.egress_policy.sources.pop();
  f.runtime = f.makeRuntime(config);
  const denied = await evaluate(f);
  assert.equal(denied.status, 'refused'); assert.equal(denied.decision, null); assert.equal(calls.length, 0); assert.equal(f.secrets.calls, 0);
});

for (const timing of ['credential', 'response']) for (const change of ['source', 'binding', 'settings', 'activation'])
  test(`${timing}: ${change} changes fence provider dispatch/result and never cache late output`, async t => {
    const f = await runtimeFixture(t);
    const mutate = async () => {
      if (change === 'source') revokeSource(f);
      if (change === 'binding') bind(f, { key: 'binding-changed', exploration_id: f.binding.exploration_id });
      if (change === 'settings') {
        const config = f.providerSettings.getConfig(f.configuration.settings_project_id);
        await f.providerSettings.configure(f.configuration.settings_project_id, { ...config, timeout_ms: config.timeout_ms - 1 });
      }
      if (change === 'activation') f.activation.setEnabled(f.context, { enabled: false, expectedVersion: f.activation.get(f.context).version });
    };
    if (timing === 'credential') f.secrets.beforeUse = mutate;
    const calls = judgeTransport(t, async ({ provider, body }) => { if (timing === 'response') await mutate(); return judgeResponse(provider, body); });
    const request = f.request(), result = await f.runtime.evaluate(f.context, request);
    assert.equal(result.status, 'refused', result.reason_code); assert.equal(result.decision, null);
    assert.equal(calls.length, timing === 'credential' ? 0 : 1); assert.equal(result.cache, 'miss');
    const retry = await f.runtime.evaluate(f.context, request);
    assert.equal(retry.status, 'refused'); assert.equal(retry.cache, 'miss');
    assert.equal(calls.length, timing === 'credential' ? 0 : change === 'settings' ? 2 : 1);
  });

test('low confidence is uncertain without fallback or successful-cache insertion', async t => {
  const f = await runtimeFixture(t, { impact: 'high', fallbacks: ['vercel'] });
  const calls = judgeTransport(t, ({ provider, body }) => judgeResponse(provider, body, { probability: 0.6 }));
  const first = await evaluate(f), second = await evaluate(f);
  for (const result of [first, second]) { assert.equal(result.status, 'deferred'); assert.equal(result.branch, 'uncertain');
    assert.equal(result.recommendation, 'ESCALATE'); assert.equal(result.reason_code, 'low_confidence'); assert.equal(result.cache, 'miss'); }
  assert.equal(calls.length, 2); assert(calls.every(c => c.provider === 'typesafe'));
});

test('reported usage over reservation defers without output/fallback', async t => {
  const f = await runtimeFixture(t, { max_tokens: 20, fallbacks: ['vercel'] });
  const calls = judgeTransport(t, ({ provider, body }) => judgeResponse(provider, body, { tokens: 21 }));
  const result = await evaluate(f);
  assert.equal(result.status, 'deferred'); assert.equal(result.reason_code, 'judge_token_budget');
  assert.equal(result.decision, null); assert.equal(calls.length, 1);
});

test('confident negative follows negative branch and returns no candidate references', async t => {
  const f = await runtimeFixture(t), calls = judgeTransport(t, ({ provider, body }) => judgeResponse(provider, body, { probability: 0.1 }));
  const result = await evaluate(f);
  assert.equal(result.status, 'decision'); assert.equal(result.branch, 'negative'); assert.equal(result.decision.confidence, 0.9);
  assert.deepEqual(result.target_refs, []); assert.deepEqual(result.decision.value, { relevant: false, target_ids: [] }); assert.equal(calls.length, 1);
});

test('another stored exploration on the same theme never becomes selected model context', async t => {
  const f = await runtimeFixture(t), a = { binding: f.binding, head: f.head, target: f.target };
  f.binding = bind(f, { key: 'isolated-b' }); f.head = f.binding.graph_revision;
  const b = f.addTarget({ name: 'same-theme-b', text: 'EXCLUDED-OTHER-EXPLORATION-CANARY' });
  f.binding = bind(f, { key: 'return-a', exploration_id: a.binding.exploration_id });
  f.head = a.head; f.target = a.target;
  const calls = judgeTransport(t), result = await evaluate(f);
  assert.equal(result.status, 'decision', result.reason_code); assert.deepEqual(result.target_refs, [a.target]);
  assert.notEqual(a.target.generation_id, b.generation_id); assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(calls[0].body).includes('EXCLUDED-OTHER-EXPLORATION-CANARY'), false);
  assert.equal(JSON.stringify(result).includes('EXCLUDED-OTHER-EXPLORATION-CANARY'), false);
});

test('cancellation and deadline discard late response, abort transport and never create cache', async t => {
  for (const mode of ['cancel', 'deadline']) {
    const f = await runtimeFixture(t, { timeout_ms: mode === 'deadline' ? 1000 : 5000 });
    const sent = deferred(), release = deferred();
    const calls = judgeTransport(t, async ({ provider, body }) => { sent.resolve(); await release.promise; return judgeResponse(provider, body); });
    const controller = new AbortController(), request = f.request();
    const pending = f.runtime.evaluate(f.context, request, { signal: controller.signal });
    assert.equal(await Promise.race([sent.promise.then(() => true), pending.then(() => false)]), true,
      'fixture must reach actual SDK transport before exercising pending-send cancellation');
    if (mode === 'cancel') controller.abort();
    const stopped = await pending;
    assert.equal(stopped.status, mode === 'cancel' ? 'cancelled' : 'deferred');
    assert.equal(stopped.reason_code, mode === 'cancel' ? 'cancelled' : 'judge_deadline');
    assert.equal(stopped.decision, null); assert.equal(calls[0].signal.aborted, true);
    assert.equal(stopped.attempts.length, 1); assert.equal(stopped.attempts[0].provider, 'typesafe');
    assert.deepEqual(stopped.usage.observed, { tokens: null, cost_microunits: null });
    release.resolve(); await new Promise(resolve => setImmediate(resolve));
    const next = await f.runtime.evaluate(f.context, request);
    assert.equal(next.status, 'decision', next.reason_code); assert.equal(next.cache, 'miss'); assert.equal(calls.length, 2);
  }
});

test('typed bridge checks exact admitted event and request pins, returns only typed candidate refs', async t => {
  const f = await runtimeFixture(t), calls = judgeTransport(t), request = f.request(), inputs = f.bridgeInputs(request);
  const first = await executeJudgeNode({ runtime: f.runtime, context: f.context, request, inputs });
  assert.equal(first.branch, 'positive'); assert.deepEqual(first.outputs.targets, { kind: 'candidates_ref', refs: [f.target] });
  assert.equal(first.outputs.decision.kind, 'signal_ref');
  assert.deepEqual(first.usage, { tokens: 256, cost_microunits: 10000 });
  const bad = await executeJudgeNode({ runtime: f.runtime, context: f.context, request: f.request({ invocation_id: 'bad-bridge' }),
    inputs: { ...inputs, selection: { kind: 'signal_ref', digest: `sha256:${'a'.repeat(64)}` } } });
  assert.deepEqual(bad.error, { code: 'handler_error', retryable: false }); assert.equal(calls.length, 1);
  const lateRequest = f.request({ invocation_id: 'bridge-late' });
  const late = await executeJudgeNode({ runtime: f.runtime, context: f.context, request: lateRequest,
    inputs: f.bridgeInputs(lateRequest), deadline_ms: performance.now() - 1 });
  assert.deepEqual(late.error, { code: 'handler_error', retryable: false }); assert.equal(calls.length, 1);
});

test('new invocation must use exact current head and catalog; no automatic branch reroute', async t => {
  const f = await runtimeFixture(t), calls = judgeTransport(t), request = f.request();
  git(f.folder, 'branch', 'observed-later'); f.refresh();
  const stale = await f.runtime.evaluate(f.context, request);
  assert.equal(stale.status, 'refused'); assert.equal(calls.length, 0);
  const other = bind(f, { key: 'other-exploration' });
  await assert.rejects(evaluate(f, { invocation_id: 'cross-branch', exploration_id: other.exploration_id,
    execution_workspace_id: other.execution_workspace_id, expected_binding_version: other.binding_version, at: other.graph_revision }),
  error => error.code === 'invalid_judge_input');
  assert.equal(calls.length, 0);
});

test('unsafe observed microcurrency conversion refuses rather than treating huge cost as unknown', async t => {
  const f = await runtimeFixture(t, { provider: 'openrouter' });
  const calls = judgeTransport(t, ({ provider, body }) => judgeResponse(provider, body, { cost: Number.MAX_SAFE_INTEGER / 2 }));
  const result = await evaluate(f);
  assert.equal(result.status, 'deferred'); assert.equal(result.reason_code, 'judge_cost_budget');
  assert.equal(result.decision, null); assert.equal(calls.length, 1);
});

test('caller request/accessor and proxy signal are rejected without executing traps or dispatching', async t => {
  const f = await runtimeFixture(t), calls = judgeTransport(t); let traps = 0;
  const r = f.request(); Object.defineProperty(r, 'event_id', { enumerable: true, get() { traps++; return f.event.event_id; } });
  await assert.rejects(f.runtime.evaluate(f.context, r), error => error.code === 'invalid_judge_input');
  const signal = new Proxy(new AbortController().signal, { get() { traps++; throw new Error('unexpected trap'); },
    getPrototypeOf() { traps++; throw new Error('unexpected trap'); } });
  assert.throws(() => f.runtime.evaluate(f.context, f.request(), { signal }));
  assert.equal(traps, 0); assert.equal(calls.length, 0); assert.equal(f.secrets.calls, 0);
});

test('completed cache has a real finite LRU ceiling and eviction permits a fresh evaluation', async t => {
  const f = await runtimeFixture(t, { timeout_ms: 15000 }), calls = judgeTransport(t), request = f.request();
  for (let i = 0; i < 128; i++) {
    const result = await f.runtime.evaluate(f.context, { ...request, invocation_id: `cache-${i}` });
    assert.equal(result.status, 'decision', result.reason_code);
  }
  assert.equal((await f.runtime.evaluate(f.context, { ...request, invocation_id: 'cache-0' })).cache, 'hit');
  assert.equal((await f.runtime.evaluate(f.context, { ...request, invocation_id: 'cache-128' })).cache, 'miss');
  assert.equal((await f.runtime.evaluate(f.context, { ...request, invocation_id: 'cache-0' })).cache, 'hit');
  assert.equal((await f.runtime.evaluate(f.context, { ...request, invocation_id: 'cache-1' })).cache, 'miss');
  assert.equal(calls.length, 130);
});
