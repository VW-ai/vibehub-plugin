import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  normalizeRawEvent, sourceObjectKey, eventObservationKey,
  sourcePartitionKey, createSourceCursor, acceptSourceEvent,
  completeSourceEvent, projectFreshness, validateFreshnessVector,
  compilePolicyArtifact, createReplayManifest, createReplayState, applyReplayEffect,
} from '../src/index.mjs';

const fixture = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const options = {
  catalog: fixture('./fixtures/identity/multi-source.json'),
  mapping: fixture('./fixtures/event-provenance/mapping.json'),
};
function observation(sequence, overrides = {}) {
  const raw = fixture('./fixtures/event-provenance/git-observation.json');
  raw.event_id = `git-observation-${sequence}`;
  raw.idempotency_key = `git-retry-${sequence}`;
  raw.source_native_event_id = `git-native-${sequence}`;
  raw.producer.sequence = sequence;
  Object.assign(raw, overrides);
  return normalizeRawEvent(raw, options).event;
}
function sourceOf(event) {
  return { partition: event.partition,
    producer: { producer_id: event.producer.producer_id, epoch: event.producer.epoch } };
}

test('public contracts keep source receipt, projection and captured-head freshness separate', () => {
  const events = [0, 2, 1].map(sequence => observation(sequence));
  const source = sourceOf(events[0]);
  let cursor = createSourceCursor({ ...source, start_sequence: 0 });
  const scope = { tenant_id: 'acme', project_id: 'product' };
  const freshness = target => projectFreshness({ scope,
    requirements: [{ source, target_sequence: target }], cursors: [cursor] });

  cursor = acceptSourceEvent(cursor, events[0]).state;
  cursor = completeSourceEvent(cursor, { event_id: events[0].event_id, completed_parents: [] });
  cursor = acceptSourceEvent(cursor, events[1]).state;
  cursor = completeSourceEvent(cursor, { event_id: events[1].event_id, completed_parents: [] });
  assert.equal(cursor.maximum_sequence, 2);
  assert.equal(cursor.accepted_through, 0);
  assert.equal(cursor.completed_through, 0);
  assert.deepEqual(freshness(2).watermarks[0].input_gaps, [{ from: 1, through: 1 }]);
  assert.equal(freshness(2).watermarks[0].reason, 'source_input_incomplete');

  const arrival = acceptSourceEvent(cursor, events[2]);
  assert.equal(arrival.status, 'late');
  cursor = arrival.state;
  assert.equal(cursor.accepted_through, 2);
  assert.equal(freshness(2).watermarks[0].reason, 'projection_incomplete');
  cursor = completeSourceEvent(cursor, { event_id: events[2].event_id, completed_parents: [] });
  assert.equal(freshness(2).status, 'caught-up');
  assert.equal(validateFreshnessVector(freshness(2)), true);
  assert.equal(freshness(null).status, 'unknown');
  assert.equal(freshness(3).status, 'known-gap');

  // These are three observations of one immutable commit, not three commits.
  assert.equal(new Set(events.map(event => sourceObjectKey(event.payload.object))).size, 1);
  assert.equal(new Set(events.map(eventObservationKey)).size, 3);
  const retry = observation(0, { observed_at: '2026-09-21T11:00:00.000Z' });
  const duplicate = acceptSourceEvent(cursor, retry);
  assert.equal(duplicate.status, 'duplicate');
  assert.deepEqual(duplicate.state, cursor); // Retain the first receipt's digest.

  const restarted = { ...source, producer: { ...source.producer, epoch: 'startup-2' } };
  assert.notEqual(sourcePartitionKey(source), sourcePartitionKey(restarted));
  const uncertain = projectFreshness({ scope, cursors: [cursor], requirements: [
    { source, target_sequence: 2 }, { source: restarted, target_sequence: 0 },
  ] });
  assert.equal(uncertain.status, 'unknown');
  assert.equal(uncertain.watermarks[1].reason, 'missing_source');
});

test('public replay dispatch pins compiled policy and judge bindings while isolating generation writes', () => {
  const { definition, operations } = fixture('./fixtures/policy-artifacts/ingress.json');
  const policy = compilePolicyArtifact(definition, { operations });
  const input = {
    replay_id: 'synthetic-replay', scope: { tenant_id: 'acme', project_id: 'product' },
    input_graph: { generation_id: 'live', snapshot_digest: `sha256:${'1'.repeat(64)}` },
    output_generation_id: 'replay-1', events: [observation(0)], policy,
    models: [{ model_id: 'test-judge', provider: 'synthetic', model: 'recorded',
      model_revision: 'v1', adapter_id: 'fixture', adapter_version: '1',
      parameters_digest: `sha256:${'2'.repeat(64)}` }],
    model_bindings: { durability: 'test-judge' },
  };
  const manifest = createReplayManifest(input);
  const initial = createReplayState(manifest);
  const effect = {
    kind: 'replay_derived_write', record_id: 'candidate-1', replay_id: manifest.replay_id,
    manifest_digest: manifest.manifest_digest, scope: manifest.scope,
    generation_id: manifest.output_generation_id, data: { derived_status: 'candidate' },
  };
  const state = applyReplayEffect(initial, manifest, effect);
  assert.equal(initial.records.length, 0);
  assert.equal(state.records.length, 1);
  assert.deepEqual(applyReplayEffect(state, manifest, effect), state);
  for (const kind of ['live_derived_write', 'connector_cursor_update', 'worker_enqueue',
    'callback', 'canonical_write']) {
    assert.throws(() => applyReplayEffect(state, manifest, { ...effect, kind }));
  }
  assert.throws(() => applyReplayEffect(state, manifest, { ...effect, generation_id: 'live' }));
  assert.throws(() => applyReplayEffect(state, manifest, {
    ...effect, scope: { ...manifest.scope, project_id: 'shared' },
  }));
  const revisedInput = structuredClone(input);
  revisedInput.models[0].model_revision = 'v2';
  const revised = createReplayManifest(revisedInput);
  assert.notEqual(revised.manifest_digest, manifest.manifest_digest);
  assert.throws(() => applyReplayEffect(state, revised, { ...effect, manifest_digest: revised.manifest_digest }));
  assert.throws(() => createReplayManifest({ ...input, model_bindings: {} }));
  const tampered = structuredClone(input);
  tampered.policy.operations[0].implementation_hash = `sha256:${'3'.repeat(64)}`;
  assert.throws(() => createReplayManifest(tampered));
});
