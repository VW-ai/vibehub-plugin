import test from 'node:test';
import assert from 'node:assert/strict';
import { contextJudgeFixture, judgeTransport, judgeResponse, publish, rows, CONTEXT_JUDGE_ACTIONS } from './helpers/context-judge-fixture.mjs';
import { bindRequest, git, pin } from './helpers/exploration-fixture.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const waitForSend = (sent, pending) => Promise.race([sent.promise, pending.then(result => {
  throw new Error(`Expected actual send, got ${result.status}/${result.reason_code}`);
})]);
const evaluate = (f, extra = {}, options) => f.runtime.evaluateContext(f.context, f.request(extra), options);

for (const timing of ['credential', 'response']) for (const change of ['grant', 'source', 'activation', 'binding', 'catalog', 'project', 'head', 'settings']) {
  test(`typed ${timing} boundary: changed ${change} cannot escape as a decision`, async t => {
    const f = await contextJudgeFixture(t, { canonical: change === 'project' }), request = f.request(); let afterChange;
    const mutate = async () => {
      if (change === 'grant') f.authority.revoke(f.issued.credential_id);
      if (change === 'source') f.ingress.updateSourceAccess(f.context, { registration_id: f.supportSource.registration_id, expectedVersion: f.supportSource.version,
        access: { ...f.supportSource.registration.access, allowed_principal_ids: [] } });
      if (change === 'activation') { const s = f.activation.get(f.context); f.activation.setEnabled(f.context, { enabled: false, expectedVersion: s.version }); }
      if (change === 'binding') f.explorations.bind(f.context, bindRequest(f, { key: 'context-judge-race-binding' }));
      if (change === 'catalog') { git(f.folder, 'branch', 'context-judge-race-ref'); f.refresh(); }
      if (change === 'project') f.explorations.setProjectSelection(f.context, { epoch: f.epoch, idempotency_key: 'context-judge-race-project', expected_version: null, pin: pin(f.canonical) });
      if (change === 'head') publish(f, 'context-judge-race-head');
      if (change === 'settings') { const c = f.providerSettings.getConfig(f.configuration.settings_project_id);
        await f.providerSettings.configure(f.configuration.settings_project_id, { ...c, timeout_ms: c.timeout_ms - 1 }); }
      afterChange = rows(f);
    };
    if (timing === 'credential') f.secrets.beforeUse = mutate;
    const calls = judgeTransport(t, async ({ provider, body }) => { if (timing === 'response') await mutate(); return judgeResponse(provider, body); });
    const result = await f.runtime.evaluateContext(f.context, request);
    assert.equal(result.status, 'refused', result.reason_code); assert.equal(result.decision, null); assert.deepEqual(result.target_refs, []);
    assert.equal(result.cache, 'miss'); assert.equal(calls.length, timing === 'credential' ? 0 : 1);
    if (timing === 'response') assert.equal(result.attempts[0].status, 'completed');
    assert.deepEqual(rows(f), afterChange);
  });
}

for (const direction of ['typed-first', 'legacy-first']) test(`${direction}: one completed invocation namespace conflicts across input profiles even with zero targets`, async t => {
  const f = await contextJudgeFixture(t, { legacy: true }), calls = judgeTransport(t);
  const typed = f.request({ target_refs: [] }), legacy = { ...typed, node_id: 'legacy' };
  const first = direction === 'typed-first' ? await f.runtime.evaluateContext(f.context, typed) : await f.runtime.evaluate(f.context, legacy);
  assert.equal(first.reason_code, 'no_visible_targets');
  const other = direction === 'typed-first' ? await f.runtime.evaluate(f.context, legacy) : await f.runtime.evaluateContext(f.context, typed);
  assert.equal(other.reason_code, 'judge_invocation_conflict'); assert.equal(other.decision, null); assert.equal(calls.length, 0);
});

for (const direction of ['typed-first', 'legacy-first']) test(`${direction}: shared in-flight identity prevents a second cross-profile dispatch`, async t => {
  const f = await contextJudgeFixture(t, { legacy: true }), sent = deferred(), release = deferred();
  // The legacy target is a real existing exploration assertion, separate from typed Context.
  const request = (await import('./helpers/context-fixture.mjs')).contextRequest(f, f.a, 'mixed-legacy');
  request.operation.assertion.content = { semantic_type: 'judge-target', data: { schema_version: 1, kind: 'judge_target', target_kind: 'context', text: 'Synthetic mixed legacy target.' } };
  const legacyTarget = f.explorations.mutate(f.context, request).revision;
  const typed = f.request(), legacy = { ...typed, node_id: 'legacy', target_refs: [legacyTarget] };
  const calls = judgeTransport(t, async ({ provider, body }) => { sent.resolve(); await release.promise; return judgeResponse(provider, body); });
  const pending = direction === 'typed-first' ? f.runtime.evaluateContext(f.context, typed) : f.runtime.evaluate(f.context, legacy);
  await waitForSend(sent, pending);
  const other = direction === 'typed-first' ? await f.runtime.evaluate(f.context, legacy) : await f.runtime.evaluateContext(f.context, typed);
  assert.equal(other.reason_code, 'judge_invocation_conflict'); assert.equal(calls.length, 1);
  release.resolve(); assert.equal((await pending).status, 'decision'); assert.equal(calls.length, 1);
});

test('typed cache is actor-scoped, reauthorizes source state and is not durable across runtime restart', async t => {
  const f = await contextJudgeFixture(t), calls = judgeTransport(t), request = f.request();
  const first = await f.runtime.evaluateContext(f.context, request); assert.equal(first.status, 'decision', first.reason_code);
  const hit = await f.runtime.evaluateContext(f.context, request); assert.equal(hit.cache, 'hit'); assert.equal(hit.result_digest, first.result_digest);
  const reader = f.issue({ principal: 'reader', actions: CONTEXT_JUDGE_ACTIONS }).context;
  assert.equal((await f.runtime.evaluateContext(reader, request)).cache, 'miss');
  assert.equal((await f.makeRuntime().evaluateContext(f.context, request)).cache, 'miss'); assert.equal(calls.length, 3);
  f.ingress.updateSourceAccess(f.context, { registration_id: f.supportSource.registration_id, expectedVersion: f.supportSource.version,
    access: { ...f.supportSource.registration.access, allowed_principal_ids: [] } });
  const denied = await f.runtime.evaluateContext(f.context, request); assert.equal(denied.status, 'refused'); assert.equal(denied.decision, null); assert.equal(calls.length, 3);
});

test('zero-target typed cache retains the bounded 128-entry LRU and eviction permits new local admission', async t => {
  const f = await contextJudgeFixture(t), calls = judgeTransport(t), request = f.request({ target_refs: [] });
  for (let i = 0; i < 129; i++) assert.equal((await f.runtime.evaluateContext(f.context, { ...request, invocation_id: `typed-cache-${i}` })).status, 'decision');
  assert.equal((await f.runtime.evaluateContext(f.context, { ...request, invocation_id: 'typed-cache-128' })).cache, 'hit');
  assert.equal((await f.runtime.evaluateContext(f.context, { ...request, invocation_id: 'typed-cache-0' })).cache, 'miss');
  assert.equal(calls.length, 0); assert.equal(f.secrets.calls, 0);
});

test('eight typed in-flight invocations share the existing ceiling and ninth refuses', async t => {
  const f = await contextJudgeFixture(t, { timeout_ms: 15000 }), release = deferred();
  const calls = judgeTransport(t, async ({ provider, body }) => { await release.promise; return judgeResponse(provider, body); });
  const pending = Array.from({ length: 8 }, (_, i) => evaluate(f, { invocation_id: `typed-flight-${i}` }));
  assert.equal((await evaluate(f, { invocation_id: 'typed-flight-9' })).reason_code, 'judge_concurrency_limit');
  release.resolve(); assert((await Promise.all(pending)).every(result => result.status === 'decision')); assert.equal(calls.length, 8);
});

for (const stop of ['cancel', 'deadline']) test(`typed ${stop} discards provider completion and never creates cached success`, async t => {
  const f = await contextJudgeFixture(t, { timeout_ms: stop === 'deadline' ? 2000 : 5000 }), sent = deferred(), release = deferred();
  const calls = judgeTransport(t, async ({ provider, body }) => { sent.resolve(); await release.promise; return judgeResponse(provider, body); });
  const controller = new AbortController(), request = f.request(), before = rows(f);
  const pending = f.runtime.evaluateContext(f.context, request, { signal: controller.signal }); await waitForSend(sent, pending);
  if (stop === 'cancel') controller.abort();
  const result = await pending; assert.equal(result.status, stop === 'cancel' ? 'cancelled' : 'deferred'); assert.equal(result.decision, null);
  release.resolve(); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls.length, 1); assert.deepEqual(rows(f), before);
  const fresh = await f.runtime.evaluateContext(f.context, request); assert.equal(fresh.cache, 'miss'); assert.equal(calls.length, 2);
});
