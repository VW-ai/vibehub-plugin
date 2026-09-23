import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invokeJudgeProvider } from '../src/local/judge-provider.mjs';
import { ProviderSettings, PROVIDER_MODELS, JUDGE_CAPABILITY } from '../src/local/provider-settings.mjs';
import { TypeSafeJevJudge } from '../src/adapters/providers/typesafe-jev-judge.mjs';
import { JevJudge } from '../src/adapters/providers/jev-judge.mjs';
import { OpenRouterJevJudge } from '../src/adapters/providers/openrouter-jev-judge.mjs';

const selected = provider => ({ provider, model: PROVIDER_MODELS[provider], capability: JUDGE_CAPABILITY });
const input = { event: { type: 'HUMAN_DECISION', timestamp: '2026-09-22T00:00:00.000Z', payload: { text: 'Use explicit credentials.' } },
  stateRefs: [], question: { family: 'durable_cross_ticket_value', text: 'Is this durable?' } };
const syntheticKey = provider => `fixture-secret-${provider}-not-a-real-key`;
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json', ...headers },
});
function answer(provider, probability = 0.9) {
  return provider === 'vercel'
    ? { answers: { relevant: { type: 'boolean', probability } }, usage: { inputTokens: 12, outputTokens: 3 },
      providerMetadata: { gateway: { routing: { finalProvider: 'typesafe-ai' }, cost: 0.0001 } } }
    : { answers: { relevant: { type: 'noul', noul: probability } }, model: PROVIDER_MODELS[provider], provider: 'TypeSafe',
      usage: { input_tokens: 12, output_tokens: 3, cost: 0.0001 } };
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'vh-judge-provider-'));
  const secrets = { values: new Map(), calls: 0, delay: null, failure: null,
    async put(ref, key) { this.values.set(ref, key); }, async remove(ref) { this.values.delete(ref); },
    async status(ref) { return this.values.has(ref) ? 'configured' : 'missing'; },
    async use(ref, operation) {
      this.calls++; if (this.delay) await this.delay;
      if (this.failure) throw this.failure;
      if (!this.values.has(ref)) throw Object.assign(new Error('fixture missing'), { code: 'credential_missing' });
      return operation(this.values.get(ref));
    } };
  const settings = new ProviderSettings({ filePath: join(dir, 'settings.sqlite'), secretStore: secrets });
  t.after(async () => { await settings.close(); await rm(dir, { force: true, recursive: true }); });
  await settings.configure('selected-project', { primary: selected('typesafe'), fallbacks: [selected('vercel'), selected('openrouter')], timeout_ms: 1000, max_attempts: 3 });
  for (const provider of Object.keys(PROVIDER_MODELS)) await settings.replaceCredential('selected-project', provider, syntheticKey(provider));
  const invoke = (provider, extra = {}) => invokeJudgeProvider({ provider_settings: settings,
    settings_project_id: 'selected-project', route: selected(provider), input, beforeSend() {}, ...extra });
  return { settings, secrets, invoke };
}

for (const provider of Object.keys(PROVIDER_MODELS)) {
  test(`${provider}: actual SDK receives explicit selected key/model and one minimized request`, async t => {
    const { invoke } = await fixture(t);
    let calls = 0, proof = false;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      calls++; assert.equal(proof, true); assert.equal(options.redirect, 'error');
      assert.equal(new Headers(options.headers).get('authorization'), `Bearer ${syntheticKey(provider)}`);
      assert.equal(url, { typesafe: 'https://api.typesafe.ai/v1/systemone', vercel: 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model',
        openrouter: 'https://openrouter.ai/api/alpha/decisions' }[provider]);
      const body = JSON.parse(options.body);
      assert.deepEqual(body.state, { event: { type: input.event.type, timestamp: input.event.timestamp, text: input.event.payload.text }, candidates: [] });
      if (provider === 'vercel') {
        assert.equal(new Headers(options.headers).get('ai-model-id'), PROVIDER_MODELS[provider]);
        assert.deepEqual(body.providerOptions.gateway, { only: ['typesafe-ai'] });
      } else assert.equal(body.model, PROVIDER_MODELS[provider]);
      if (provider === 'openrouter') assert.deepEqual(body.provider, { allow_fallbacks: false });
      return json(answer(provider));
    });
    const result = await invoke(provider, { beforeSend() { proof = true; } });
    assert.equal(result.status, 'ok'); assert.equal(result.decision.value.relevant, true);
    assert.equal(result.decision.confidence, 0.9); assert.equal(calls, 1);
    assert.equal(result.telemetry.input_tokens, 12); assert.equal(result.telemetry.total_tokens, 15);
    assert.equal(result.telemetry.cost_usd, provider === 'typesafe' ? null : 0.0001);
    assert.equal(Object.hasOwn(result.decision, 'telemetry'), false);
    assert.ok(!JSON.stringify(result).includes(syntheticKey(provider)));
  });

  test(`${provider}: HTTP classification stays bounded, auth never retries and only429/5xx are transient`, async t => {
    const { invoke } = await fixture(t);
    let status = 401, calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls++; return json({ error: { message: syntheticKey(provider) }, private_body: syntheticKey(provider) }, status,
        { 'retry-after': '60', 'x-private': syntheticKey(provider) });
    });
    for (const [http, code, transient] of [[401, 'credential_rejected', false], [403, 'credential_rejected', false],
      [429, 'rate_limited', true], [503, 'provider_unavailable', true], [400, 'invalid_decision', false],
      [422, 'invalid_decision', false], [404, 'provider_unavailable', false]]) {
      status = http; const before = calls, result = await invoke(provider);
      assert.deepEqual(result, { status: 'error', code, transient, retry_after_ms: transient ? 1000 : null });
      assert.equal(calls - before, 1); assert.ok(!JSON.stringify(result).includes(syntheticKey(provider)));
    }
  });

  test(`${provider}: malformed200 is terminal and cancellation discards late provider output`, async t => {
    const { invoke } = await fixture(t);
    let handler = () => json({ answers: { relevant: { type: 'noul', noul: 4 } }, private: syntheticKey(provider) });
    t.mock.method(globalThis, 'fetch', (...args) => handler(...args));
    assert.deepEqual(await invoke(provider), { status: 'error', code: 'invalid_decision', transient: false, retry_after_ms: null });
    const controller = new AbortController(); let deliver, entered;
    const sent = new Promise(resolve => { entered = resolve; });
    handler = () => { entered(); return new Promise(resolve => { deliver = resolve; }); };
    const pending = invoke(provider, { signal: controller.signal });
    await sent; controller.abort(new Error('synthetic-cancel-private-reason')); deliver(json(answer(provider)));
    assert.deepEqual(await pending, { status: 'error', code: 'cancelled', transient: false, retry_after_ms: null });
  });

  test(`${provider}: SDK preprocessing cannot cross a changed dispatch proof`, async t => {
    const { invoke } = await fixture(t);
    let sends = 0, changed = false, proofCalls = 0;
    const stale = Object.assign(new Error('trusted bounded settings changed'), { code: 'stale_settings' });
    const prototype = { typesafe: TypeSafeJevJudge, vercel: JevJudge, openrouter: OpenRouterJevJudge }[provider].prototype;
    const original = prototype.evaluate;
    t.mock.method(prototype, 'evaluate', async function (...args) {
      await Promise.resolve(); changed = true;
      return original.apply(this, args);
    });
    t.mock.method(globalThis, 'fetch', async () => { sends++; return json(answer(provider)); });
    await assert.rejects(invoke(provider, { beforeSend() { proofCalls++; if (changed) throw stale; } }), error => error === stale);
    assert.equal(proofCalls, 2); assert.equal(sends, 0);
  });
}

test('actual awaited secure-store retrieval precedes final trusted proof; failed proof escapes only as original internal error', async t => {
  const { secrets, invoke } = await fixture(t);
  let release, calls = 0, proofCalls = 0;
  secrets.delay = new Promise(resolve => { release = resolve; });
  t.mock.method(globalThis, 'fetch', async () => { calls++; return json(answer('typesafe')); });
  const stale = Object.assign(new Error('trusted bounded stale source'), { code: 'stale_source_fence' });
  const pending = invoke('typesafe', { beforeSend() { proofCalls++; throw stale; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(secrets.calls, 1); assert.equal(proofCalls, 0); assert.equal(calls, 0);
  release(); await assert.rejects(pending, error => error === stale);
  assert.equal(proofCalls, 1); assert.equal(calls, 0);
});

test('missing, locked and malformed credentials never fall back to environment or another provider', async t => {
  const { secrets, settings, invoke } = await fixture(t);
  let sends = 0; t.mock.method(globalThis, 'fetch', async () => { sends++; throw new Error('unexpected send'); });
  await settings.removeCredential('selected-project', 'typesafe');
  assert.equal((await invoke('typesafe')).code, 'credential_missing');
  secrets.failure = new Error(syntheticKey('openrouter'));
  assert.equal((await invoke('openrouter')).code, 'credential_unavailable');
  secrets.failure = Object.assign(new Error(syntheticKey('vercel')), { statusCode: 401 });
  assert.equal((await invoke('vercel')).code, 'credential_rejected');
  secrets.failure = null;
  for (const value of [undefined, '', ' ', '\rsynthetic', 42]) {
    for (const key of secrets.values.keys()) secrets.values.set(key, value);
    assert.equal((await invoke('openrouter')).code, 'credential_missing');
  }
  assert.equal(sends, 0);
});

test('unconfigured or mismatched routes and non-capabilities reject before credential lookup', async t => {
  const { invoke, secrets, settings } = await fixture(t);
  await settings.configure('selected-project', { primary: selected('typesafe'), fallbacks: [], timeout_ms: 1000, max_attempts: 1 });
  for (const override of [{ route: selected('vercel') }, { route: { ...selected('typesafe'), model: 'other' } },
    { route: { ...selected('typesafe'), capability: 'text-generation' } }, { provider_settings: {} }, { beforeSend: undefined }]) {
    assert.equal((await invoke('typesafe', override)).code, 'invalid_provider_configuration');
  }
  assert.equal(secrets.calls, 0);
});

test('cancelled waiting credential lookup never dispatches; pre-aborted signal avoids even lookup', async t => {
  const { invoke, secrets } = await fixture(t);
  let sends = 0, proofs = 0, release;
  t.mock.method(globalThis, 'fetch', async () => { sends++; return json(answer('typesafe')); });
  const controller = new AbortController(); controller.abort();
  assert.equal((await invoke('typesafe', { signal: controller.signal })).code, 'cancelled');
  assert.equal(secrets.calls, 0);
  secrets.delay = new Promise(resolve => { release = resolve; });
  const later = new AbortController();
  const pending = invoke('typesafe', { signal: later.signal, beforeSend() { proofs++; } });
  later.abort(); release(); assert.equal((await pending).code, 'cancelled');
  assert.equal(proofs, 0); assert.equal(sends, 0);
});

test('bounded telemetry does not invent totals/cost; Gateway warning text never reaches logger', async t => {
  const { invoke } = await fixture(t);
  const logged = [];
  for (const method of ['warn', 'error', 'debug', 'info', 'log']) t.mock.method(console, method, (...args) => { logged.push(args); });
  t.mock.method(globalThis, 'fetch', async () => json({ ...answer('vercel'),
    usage: { inputTokens: 1.5, outputTokens: 9 },
    warnings: [{ type: 'other', message: syntheticKey('vercel') }],
    providerMetadata: { gateway: { cost: 'not-a-number', routing: { finalProvider: '/private/unknown' }, secret: syntheticKey('vercel') } } }));
  const result = await invoke('vercel');
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.telemetry, { final_provider: null, cost_usd: null, input_tokens: null, output_tokens: 9, total_tokens: null });
  assert.deepEqual(logged, []); assert.ok(!JSON.stringify(result).includes(syntheticKey('vercel')));
});

test('bounded retry headers and network failures never expose raw error/cause', async t => {
  const { invoke } = await fixture(t); let header = '0.125';
  t.mock.method(globalThis, 'fetch', async () => json({}, 429, { 'retry-after': header }));
  assert.equal((await invoke('typesafe')).retry_after_ms, 125);
  header = 'Wed, 01 Jan 2031 00:00:00 GMT'; assert.equal((await invoke('typesafe')).retry_after_ms, null);
  header = syntheticKey('typesafe'); assert.equal((await invoke('typesafe')).retry_after_ms, null);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error(syntheticKey('typesafe')); });
  assert.deepEqual(await invoke('typesafe'), { status: 'error', code: 'provider_unavailable', transient: false, retry_after_ms: null });
});

test('otherwise valid resolved model cannot echo the selected credential', async t => {
  const { invoke } = await fixture(t);
  t.mock.method(globalThis, 'fetch', async () => json({ ...answer('typesafe'), model: syntheticKey('typesafe') }));
  assert.equal((await invoke('typesafe')).code, 'invalid_decision');
});
