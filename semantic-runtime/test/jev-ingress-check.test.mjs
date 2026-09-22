import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPersistedJev } from '../scripts/check-jev-ingress.mjs';
import { edgeCases } from '../scripts/check-jev-synthetic.mjs';
import { DomainStore } from '../src/index.mjs';

test('persisted JEV smoke reopens approved bytes, deduplicates intake and sends only minimal synthetic input', async t => {
  let calls = 0, activeSnapshot = false, snapshots = 0;
  const readSnapshot = DomainStore.prototype.readSnapshot;
  t.mock.method(DomainStore.prototype, 'readSnapshot', function (...args) {
    activeSnapshot = true; snapshots++;
    try { return readSnapshot.apply(this, args); } finally { activeSnapshot = false; }
  });
  const report = await checkPersistedJev({ async evaluate(input, { signal }) {
    assert.equal(activeSnapshot, false, 'model dispatch must occur after the SQLite view closes');
    const entry = edgeCases[calls++];
    assert.deepEqual(Object.keys(input).sort(), ['event', 'question', 'stateRefs']);
    assert.deepEqual(Object.keys(input.event).sort(), ['payload', 'timestamp', 'type']);
    assert.deepEqual(input.event.payload, { text: entry[2] });
    assert.equal(input.event.type, 'AGENT_MESSAGE');
    assert(signal instanceof AbortSignal);
    return { value: { relevant: entry[4], target_ids: entry[5] ?? [] }, confidence: 0.9,
      latency_ms: 1, provider: 'synthetic', model: 'fixture', reason_code: 'synthetic' };
  } });
  assert.equal(calls, 8); assert.equal(snapshots, 8); assert.equal(report.completed, 8); assert.equal(report.matched, 8);
  assert.deepEqual(report.ingress, { stored: 8, reopened: true, deduplicated: 8, materialized: 8,
    coherent_read_snapshots: 8, pending_intents: 8, semantic_processing_claimed: false });
  for (const field of ['registration_id', 'catalog', 'raw_event_digest', 'credential', 'snapshot_text']) {
    assert.equal(JSON.stringify(report).includes(`"${field}"`), false);
  }
});

test('persisted smoke reports transport failures and semantic misses without raw provider diagnostics', async () => {
  let calls = 0;
  const report = await checkPersistedJev({ async evaluate() {
    const index = calls++, entry = edgeCases[index];
    if (index === 0) throw new Error('CANARY-DO-NOT-PRINT');
    return { value: { relevant: index === 1 ? false : entry[4], target_ids: index === 1 ? [] : entry[5] ?? [] },
      confidence: 0.9, latency_ms: 1, provider: 'synthetic', model: 'fixture', reason_code: 'synthetic' };
  } });
  assert.equal(calls, 8); assert.equal(report.completed, 7); assert.equal(report.matched, 6);
  assert.equal(report.ingress.materialized, 8); assert.equal(report.ingress.pending_intents, 8);
  assert.equal(JSON.stringify(report).includes('CANARY'), false);
});
