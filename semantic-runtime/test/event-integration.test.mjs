import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  normalizeRawEvent, sourceObjectKey, eventObservationKey, eventIdempotencyKey,
  auditCorrelationId, appendAuditEnvelope,
} from '../src/index.mjs';

const fixture = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const options = () => ({
  catalog: fixture('./fixtures/identity/multi-source.json'),
  mapping: fixture('./fixtures/event-provenance/mapping.json'),
});
const observation = () => fixture('./fixtures/event-provenance/git-observation.json');

test('public event contract preserves four observations of one commit through safe audit correlation', () => {
  const objects = new Set();
  const observations = new Set();
  const retries = new Set();
  let cursor = null;
  for (const [index, channel] of ['local_git', 'fetch', 'push', 'pull_request'].entries()) {
    const raw = observation();
    raw.event_id = `observation:${channel}/1`;
    raw.idempotency_key = `retry:${channel}/1`;
    raw.provenance.delivery = { channel, delivery_id: `delivery:${channel}/1` };
    const result = normalizeRawEvent(raw, options());
    assert.equal(result.status, 'normalized');
    const { event } = result;
    assert.deepEqual(event.effective_access, { allowed_principal_ids: ['alice'], sensitivity: 'sensitive' });
    assert.equal(event.replay.eligible, true);
    assert.equal(eventIdempotencyKey(event), eventIdempotencyKey(raw));
    objects.add(sourceObjectKey(event.payload.object));
    observations.add(eventObservationKey(event));
    retries.add(eventIdempotencyKey(event));
    const record = appendAuditEnvelope(cursor, {
      schema_version: 1, stream_id: 'synthetic_event_audit', sequence: index + 1,
      previous_digest: cursor?.head_digest ?? null, audit_id: `audit_${index}`,
      recorded_at: event.observed_at, subject: 'event', status: 'succeeded',
      reason_code: 'completed', measurements: {},
      correlation: {
        tenant_id: auditCorrelationId('tenant_id', event.partition.tenant_id, event.partition.tenant_id),
        project_id: auditCorrelationId('project_id', event.partition.tenant_id, event.partition.project_id),
        source_id: auditCorrelationId('source_id', event.partition.tenant_id, event.partition.source_installation_id),
        event_id: auditCorrelationId('event_id', event.partition.tenant_id, event.event_id),
      },
    });
    assert.ok(!JSON.stringify(record).includes(event.payload.object.oid));
    assert.ok(!JSON.stringify(record).includes(raw.event_id));
    cursor = record.cursor;
  }
  assert.equal(objects.size, 1);
  assert.equal(observations.size, 4);
  assert.equal(retries.size, 4);
  assert.equal(cursor.sequence, 4);
});

test('public normalization keeps ambiguous scope and mutable payloads out of replay eligibility', () => {
  const ambiguous = observation();
  ambiguous.partition.project_id = null;
  ambiguous.partition.source_installation_id = 'connector';
  ambiguous.identity = {};
  const unresolved = normalizeRawEvent(ambiguous, options());
  assert.equal(unresolved.status, 'ambiguous');
  assert.equal(unresolved.event, null);

  const raw = observation();
  raw.payload = { kind: 'mutable_pointer', pointer_id: 'working-tree:head', digest: raw.payload.digest };
  const result = normalizeRawEvent(raw, options());
  assert.equal(result.status, 'normalized');
  assert.equal(result.event.replay.eligible, false);
  assert.equal(result.event.replay.reason, 'mutable_pointer');
});
