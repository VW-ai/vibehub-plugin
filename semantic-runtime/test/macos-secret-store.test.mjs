import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { MacOSSecretStore } from '../src/adapters/secrets/macos-secret-store.mjs';

test('macOS secret store rejects non-app references and malformed secret before invoking a helper', async () => {
  const store = new MacOSSecretStore();
  await assert.rejects(store.status('some-user-entry'), /invalid_credential_reference/);
  const ref = `vhcred_${'0'.repeat(64)}`;
  await assert.rejects(store.put(ref, 'bad\nsecret'), /invalid_credential/);
});

// Opt-in because this exercises the OS Keychain, not an in-memory test double.
// The random account belongs to this app namespace and is deleted in finally.
test('temporary app-owned macOS Keychain credential lifecycle, including fresh instance lookup',
  { skip: process.platform !== 'darwin' || process.env.VIBEHUB_TEST_KEYCHAIN !== '1' }, async () => {
    const ref = `vhcred_${createHash('sha256').update(randomUUID()).digest('hex')}`;
    const store = new MacOSSecretStore();
    try {
      assert.equal(await store.status(ref), 'missing');
      await store.put(ref, 'synthetic-vibehub-first');
      assert.equal(await store.status(ref), 'configured');
      assert.equal(await store.use(ref, key => key === 'synthetic-vibehub-first'), true);
      await store.put(ref, 'synthetic-vibehub-replaced');
      const restarted = new MacOSSecretStore();
      assert.equal(await restarted.use(ref, key => key === 'synthetic-vibehub-replaced'), true);
      await restarted.remove(ref);
      assert.equal(await restarted.status(ref), 'missing');
      await assert.rejects(restarted.use(ref, () => {}), /credential_missing/);
    } finally { await store.remove(ref); }
  });
