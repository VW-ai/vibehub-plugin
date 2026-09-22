import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderSettings, PROVIDER_MODELS, JUDGE_CAPABILITY, validateProviderConfig } from '../src/local/provider-settings.mjs';

const selected = provider => ({ provider, model: PROVIDER_MODELS[provider], capability: JUDGE_CAPABILITY });
const config = { primary: selected('typesafe'), fallbacks: [selected('vercel')], timeout_ms: 30_000, max_attempts: 2 };
class MemorySecrets {
  values = new Map(); unavailable = false;
  check() { if (this.unavailable) throw new Error('synthetic-sensitive-provider-error'); }
  async put(ref, key) { this.check(); this.values.set(ref, key); }
  async remove(ref) { this.check(); this.values.delete(ref); }
  async status(ref) { this.check(); return this.values.has(ref) ? 'configured' : 'missing'; }
  async use(ref, fn) { this.check(); if (!this.values.has(ref)) throw Object.assign(new Error('missing'), { code: 'credential_missing' }); return fn(this.values.get(ref)); }
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'vh-provider-'));
  const secretStore = new MemorySecrets();
  const options = { filePath: join(dir, 'settings.sqlite'), secretStore };
  const store = new ProviderSettings(options);
  t.after(async () => { try { await store.close(); } catch {} await rm(dir, { recursive: true, force: true }); });
  return { store, options, secretStore };
}

test('explicit existing JEV routes and bounded budgets reject unknown capability or automatic substitution', () => {
  for (const provider of Object.keys(PROVIDER_MODELS)) assert.equal(validateProviderConfig({ ...config, primary: selected(provider), fallbacks: [] }).primary.provider, provider);
  const bad = [
    { ...config, primary: { ...selected('typesafe'), capability: 'text-generation' } },
    { ...config, primary: { ...selected('vercel'), model: 'jev-latest' } },
    { ...config, primary: { ...selected('typesafe'), provider: 'codex' } },
    { ...config, fallbacks: [selected('typesafe')] },
    { ...config, fallbacks: [selected('vercel'), selected('vercel')] },
    { ...config, apiKey: 'synthetic-never-persist' }, { ...config, executor: 'claude' },
    { ...config, timeout_ms: 120001 }, { ...config, timeout_ms: 0 },
    { ...config, max_attempts: 4 }, { ...config, max_attempts: 1.5 },
  ];
  for (const value of bad) assert.throws(() => validateProviderConfig(value), /Provider settings:/);
});

test('settings and credential references survive restart without persisting fake secrets', async t => {
  const { store, options, secretStore } = await fixture(t);
  await store.configure('project-a', config);
  await store.replaceCredential('project-a', 'typesafe', 'fake-secret-original');
  await store.replaceCredential('project-a', 'typesafe', 'fake-secret-replaced');
  assert.equal(secretStore.values.size, 1);
  await store.close();
  const restarted = new ProviderSettings(options);
  t.after(() => restarted.close());
  assert.deepEqual(restarted.getConfig('project-a'), config);
  assert.deepEqual(await restarted.credentialStatus('project-a', 'typesafe'), { state: 'configured' });
  assert.equal(await restarted.useCredential('project-a', 'typesafe', key => key === 'fake-secret-replaced'), true);
  for (const suffix of ['', '-wal']) {
    const bytes = await readFile(options.filePath + suffix).catch(() => Buffer.alloc(0));
    assert.equal(bytes.includes(Buffer.from('fake-secret')), false);
  }
});

test('project and route credentials isolate lookup, replacement and deletion', async t => {
  const { store } = await fixture(t);
  await store.configure('a', config); await store.configure('b', config);
  await store.replaceCredential('a', 'typesafe', 'fake-a');
  await store.replaceCredential('b', 'typesafe', 'fake-b');
  await store.replaceCredential('a', 'vercel', 'fake-v');
  assert.equal(await store.useCredential('b', 'typesafe', key => key === 'fake-b'), true);
  await store.removeCredential('a', 'typesafe');
  assert.deepEqual(await store.credentialStatus('a', 'typesafe'), { state: 'missing' });
  assert.deepEqual(await store.credentialStatus('b', 'typesafe'), { state: 'configured' });
  assert.deepEqual(await store.credentialStatus('a', 'vercel'), { state: 'configured' });
  assert.throws(() => store.resolveRoute('a', 'openrouter'), /route_not_allowed/);
  assert.equal(store.resolveRoute('a', 'vercel').provider, 'vercel');
  assert.equal(store.resolveRoute('a').provider, 'typesafe');
});

test('removed, missing and locked credentials fail safely with no plaintext fallback', async t => {
  const { store, secretStore } = await fixture(t);
  await store.configure('a', config);
  await assert.rejects(store.useCredential('a', 'typesafe', () => {}), /credential_missing/);
  await store.replaceCredential('a', 'typesafe', 'fake-known-key');
  secretStore.values.clear(); // Simulate external Keychain deletion/revocation.
  assert.deepEqual(await store.credentialStatus('a', 'typesafe'), { state: 'missing' });
  await assert.rejects(store.useCredential('a', 'typesafe', () => {}), /credential_missing/);
  secretStore.unavailable = true;
  assert.deepEqual(await store.credentialStatus('a', 'typesafe'), { state: 'error' });
  await assert.rejects(store.replaceCredential('a', 'typesafe', 'fake-new'), error => error.code === 'secure_store_unavailable' && !String(error).includes('synthetic-sensitive'));
  await assert.rejects(store.removeCredential('a', 'typesafe'), /secure_store_unavailable/);
});

test('callback errors and invalid inputs are redacted and credential access must name an allowed route', async t => {
  const { store } = await fixture(t);
  await store.configure('a', config);
  await store.replaceCredential('a', 'typesafe', 'fake-key');
  await assert.rejects(store.useCredential('a', 'typesafe', key => { throw new Error(key); }), error => error.code === 'credential_operation_failed' && !String(error).includes('fake-key') && !error.cause);
  await assert.rejects(store.useCredential('a', 'typesafe', key => { throw Object.assign(new Error(key), { statusCode: 401 }); }), error => error.code === 'credential_rejected' && !error.cause);
  assert.equal(store.resolveRoute('a').provider, 'typesafe'); // Auth failure never selects fallback.
  await assert.rejects(store.useCredential('a', 'openrouter', () => {}), /route_not_allowed/);
  assert.throws(() => store.replaceCredential('a', 'typesafe', 'fake\nkey'), /invalid_credential/);
  assert.throws(() => store.configure('../other', config), /invalid_project/);
});

test('serialized concurrent updates preserve config and both credential references', async t => {
  const { store } = await fixture(t);
  await Promise.all([store.configure('a', config), store.replaceCredential('a', 'typesafe', 'fake-t'), store.replaceCredential('a', 'vercel', 'fake-v')]);
  assert.deepEqual(store.getConfig('a'), config);
  assert.deepEqual(await store.credentialStatus('a', 'typesafe'), { state: 'configured' });
  assert.deepEqual(await store.credentialStatus('a', 'vercel'), { state: 'configured' });
});
