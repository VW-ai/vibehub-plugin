import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CAUSAL_CONTRACT_VERSION, validateSourcePartition, sourcePartitionKey, sourceEventFingerprint,
  createSourceCursor, validateSourceCursor, acceptSourceEvent, completeSourceEvent, projectFreshness,
  validateFreshnessVector, classifyGitRefMovement, validateGraphGenerationPin,
  createReplayManifest, validateReplayManifest, assertReplayEffect, createReplayState, applyReplayEffect,
} from '../src/core/causal-ordering.mjs';
import { normalizeRawEvent } from '../src/core/event-provenance.mjs';
import { compilePolicyArtifact } from '../src/core/policy-artifacts.mjs';

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const clone = value => structuredClone(value);
const pin = char => `sha256:${char.repeat(64)}`;
const scope = { tenant_id: 'acme', project_id: 'product' };
const options = () => ({ catalog: fixture('identity/multi-source.json'), mapping: fixture('event-provenance/mapping.json') });
function event(position = 0, mutate = () => {}, name = String(position)) {
  const raw = fixture('event-provenance/git-observation.json');
  raw.event_id = `event-${name}`; raw.idempotency_key = `retry-${name}`; raw.source_native_event_id = `native-${name}`;
  raw.producer.sequence = position; mutate(raw);
  const result = normalizeRawEvent(raw, options()); assert.equal(result.status, 'normalized'); return result.event;
}
function stream(e = event()) {
  return { partition: e.partition, producer: { producer_id: e.producer.producer_id, epoch: e.producer.epoch } };
}
const cursor = (extra = {}) => createSourceCursor({ ...stream(), start_sequence: 0, ...extra });
const accept = (state, e) => acceptSourceEvent(state, e).state;
const complete = (state, eventId, parents = []) => completeSourceEvent(state, { event_id: eventId, completed_parents: parents });
const freshness = (state, target = 2) => projectFreshness({ scope, requirements: [{ source: stream(), target_sequence: target }], cursors: [state] });
const parent = name => ({ ...scope, event_id: `event-${name}` });
function allPermutations(values) {
  return values.length ? values.flatMap((value, index) => allPermutations(values.filter((_, i) => i !== index)).map(tail => [value, ...tail])) : [[]];
}

test('partition key includes scope, installation, stream, producer and epoch without delimiter collisions', () => {
  assert.equal(CAUSAL_CONTRACT_VERSION, 1); const value = stream(); assert.equal(validateSourcePartition(value), true);
  const keys = new Set([sourcePartitionKey(value)]);
  for (const field of Object.keys(value.partition)) { const altered = clone(value); altered.partition[field] += '-other'; keys.add(sourcePartitionKey(altered)); }
  for (const field of Object.keys(value.producer)) { const altered = clone(value); altered.producer[field] += '-other'; keys.add(sourcePartitionKey(altered)); }
  assert.equal(keys.size, 7);
  assert.throws(() => validateSourcePartition({ ...value, sequence: 0 }), /unknown/);
  assert.throws(() => validateSourcePartition({ ...value, producer: { producer_id: 'same' } }), /missing/);
});

test('arrival fixtures retain contiguous accepted cursor, maximum and compact holes', () => {
  for (const scenario of fixture('causal-ordering/source-arrivals.json').cases) {
    let state = cursor();
    for (const [i, position] of scenario.arrivals.entries()) {
      const previous = clone(state); const original = state; state = accept(state, event(position));
      assert.deepEqual(original, previous);
      assert.equal(state.accepted_through, scenario.accepted[i]); assert.equal(state.maximum_sequence, scenario.maximum[i]);
      assert.equal(state.completed_through, null); assert.equal(validateSourceCursor(state), true);
    }
  }
  let state = accept(cursor(), event(0)); state = accept(state, event(2));
  assert.deepEqual(state.gaps, [{ from: 1, through: 1 }]);
  const late = acceptSourceEvent(state, event(1)); assert.equal(late.status, 'late'); assert.deepEqual(late.state.gaps, []);
  assert.equal(late.state.accepted_through, 2);
});

test('all 24 delivery and completion permutations converge without treating receipt as projection', () => {
  for (const positions of allPermutations([0, 1, 2, 3])) {
    let state = positions.reduce((s, position) => accept(s, event(position)), cursor());
    assert.equal(state.accepted_through, 3); assert.equal(state.completed_through, null);
    for (const position of [...positions].reverse()) state = complete(state, `event-${position}`);
    assert.equal(state.completed_through, 3); assert.equal(freshness(state, 3).status, 'caught-up');
  }
});

test('zero is a valid sequence and empty state does not imply any accepted or completed head', () => {
  const empty = cursor(); assert.equal(empty.accepted_through, null); assert.equal(empty.maximum_sequence, null);
  const accepted = accept(empty, event()); assert.equal(accepted.accepted_through, 0); assert.equal(accepted.completed_through, null);
  assert.equal(freshness(accepted, 0).watermarks[0].reason, 'projection_incomplete');
  assert.equal(freshness(complete(accepted, 'event-0'), 0).status, 'caught-up');
  assert.equal(freshness(empty, 0).status, 'known-gap');
});

test('null sequence never fabricates continuous freshness even after completion', () => {
  let state = accept(cursor(), event(null)); state = complete(state, 'event-null');
  state = complete(accept(state, event(0)), 'event-0');
  assert.equal(state.accepted_through, 0); assert.equal(state.unordered_count, 1);
  assert.equal(freshness(state, 0).status, 'unknown'); assert.equal(freshness(state, 0).watermarks[0].reason, 'unsequenced_observations');
  assert.equal(acceptSourceEvent(cursor(), event(null)).status, 'unordered');
});

test('huge sparse sequence uses bounded ranges and safe integer boundary never advances past maximum', () => {
  let state = accept(cursor(), event(Number.MAX_SAFE_INTEGER));
  assert.deepEqual(state.gaps, [{ from: 0, through: Number.MAX_SAFE_INTEGER - 1 }]);
  state = accept(state, event(0));
  assert.deepEqual(state.gaps, [{ from: 1, through: Number.MAX_SAFE_INTEGER - 1 }]);
  assert.deepEqual(freshness(state, Number.MAX_SAFE_INTEGER).watermarks[0].input_gaps, state.gaps);
  const maxCursor = cursor({ start_sequence: Number.MAX_SAFE_INTEGER });
  const done = complete(accept(maxCursor, event(Number.MAX_SAFE_INTEGER)), `event-${Number.MAX_SAFE_INTEGER}`);
  assert.equal(done.completed_through, Number.MAX_SAFE_INTEGER); assert.deepEqual(done.gaps, []);
  assert.throws(() => cursor({ start_sequence: Number.MAX_SAFE_INTEGER + 1 }), /sequence/);
  assert.throws(() => event(Number.MAX_SAFE_INTEGER + 1), /sequence/);
});

test('epoch origin is explicit and cannot be inferred from late first receipt or changed producer', () => {
  assert.throws(() => createSourceCursor(stream()), /missing/);
  const value = cursor({ start_sequence: 10 }); assert.equal(accept(value, event(12)).accepted_through, null);
  assert.throws(() => accept(value, event(9)), /precedes/);
  for (const mutate of [raw => { raw.producer.epoch = 'next'; }, raw => { raw.producer.producer_id = 'other'; },
    raw => { raw.partition.partition_id = 'other'; }]) {
    assert.throws(() => accept(cursor(), event(0, mutate)), /another source/);
  }
  assert.equal(freshness(value, 0).watermarks[0].reason, 'head_precedes_attested_start');
});

test('timestamps cannot close holes or reorder source continuity', () => {
  const later = event(2, raw => { raw.occurred_at = '2025-01-01T00:00:00.000Z'; });
  const earlier = event(0, raw => { raw.observed_at = '2030-01-01T00:00:00.000Z'; });
  const state = accept(accept(cursor(), later), earlier);
  assert.equal(state.accepted_through, 0); assert.equal(state.maximum_sequence, 2);
});

test('harmless receipt retry preserves the first immutable event pin and completed state', () => {
  const original = event(0); const retry = event(0, raw => {
    raw.observed_at = '2026-09-22T10:00:00.000Z'; raw.provenance.delivery.delivery_id = 'retry-delivery';
    raw.acl.allowed_principal_ids.reverse(); raw.provenance.source_objects[0].acl.allowed_principal_ids.reverse();
  });
  assert.notEqual(original.normalization.raw_event_digest, retry.normalization.raw_event_digest);
  assert.equal(sourceEventFingerprint(original), sourceEventFingerprint(retry));
  const state = complete(accept(cursor(), original), 'event-0'); const result = acceptSourceEvent(state, retry);
  assert.equal(result.status, 'duplicate'); assert.deepEqual(result.state, state);
  assert.equal(result.state.entries[0].first_event_digest, state.entries[0].first_event_digest);
  assert.ok(Object.isFrozen(result.state.entries));
});

test('same logical position refuses changed payload, source identity, type, ACL and causal parents', () => {
  const state = accept(cursor(), event(0));
  for (const mutate of [raw => { raw.payload.digest = pin('b'); }, raw => { raw.source_event_type = 'host.message'; },
    raw => { raw.acl.revision = 'acl-new'; }, raw => { raw.acl.allowed_principal_ids = ['bob']; },
    raw => { raw.provenance.source_objects[0].acl.revision = 'repo-new'; }, raw => { raw.sensitivity = 'restricted'; },
    raw => { raw.source_native_event_id = 'other'; }, raw => { raw.causal_parents = [parent('external')]; },
    raw => { raw.event_id = 'replacement'; }, raw => { raw.idempotency_key = 'replacement'; }]) {
    assert.throws(() => accept(state, event(0, mutate)), /conflicting contents/);
  }
  const changedIdentity = event(0); changedIdentity.identity.workspace_id = 'other';
  assert.throws(() => accept(state, changedIdentity), /conflicting contents/);
  assert.throws(() => accept(state, event(1, raw => { raw.event_id = 'event-0'; })), /conflicting contents/);
  assert.throws(() => accept(state, event(1, raw => { raw.idempotency_key = 'retry-0'; })), /conflicting contents/);
});

test('scoped causal parents require completion attestations and cannot bypass local order', () => {
  const p = parent(0); const child = event(1, raw => { raw.causal_parents = [p]; });
  let state = accept(accept(cursor(), child), event(0));
  assert.throws(() => complete(state, 'event-1'), /exact scoped/);
  assert.throws(() => complete(state, 'event-1', [{ ...p, project_id: 'other' }]), /exact scoped/);
  assert.throws(() => complete(state, 'event-1', [p]), /incomplete/);
  state = complete(state, 'event-0'); state = complete(state, 'event-1', [p]); assert.equal(state.completed_through, 1);
  const external = parent('other-stream'); const cross = event(2, raw => { raw.causal_parents = [external]; });
  state = complete(accept(state, cross), 'event-2', [external]); assert.equal(state.completed_through, 2);
  assert.throws(() => complete(state, 'missing'), /unaccepted/);
  const contradictory = event(0, raw => { raw.causal_parents = [parent(1)]; });
  assert.throws(() => accept(accept(cursor(), contradictory), event(1)), /contradicts producer order/);
});

test('late parent admission does not invalidate an earlier explicit external completion attestation', () => {
  const p = parent(0); const child = event(1, raw => { raw.causal_parents = [p]; });
  const childCompleted = complete(accept(cursor(), child), 'event-1', [p]);
  assert.equal(childCompleted.accepted_through, null); assert.equal(childCompleted.completed_through, null);
  const parentAccepted = accept(childCompleted, event(0));
  assert.equal(parentAccepted.accepted_through, 1); assert.equal(parentAccepted.completed_through, null);
  assert.equal(parentAccepted.entries.find(entry => entry.event_ref.event_id === 'event-1').completed, true);
  assert.equal(freshness(parentAccepted, 1).watermarks[0].reason, 'projection_incomplete');
  const parentCompleted = complete(parentAccepted, 'event-0'); assert.equal(parentCompleted.completed_through, 1);
  assert.equal(freshness(parentCompleted, 1).status, 'caught-up');
});

test('known causal cycles fail, including unordered events; forged cursor summaries and capacity fail', () => {
  const first = event(null, raw => { raw.causal_parents = [parent('second')]; }, 'first');
  const second = event(null, raw => { raw.causal_parents = [parent('first')]; }, 'second');
  assert.throws(() => accept(accept(cursor(), first), second), /causal cycle/);
  const forged = clone(accept(cursor(), event(0))); forged.accepted_through = 10;
  assert.throws(() => validateSourceCursor(forged), /summary mismatch/);
  const oversized = clone(accept(cursor(), event(0))); oversized.entries = Array(4097).fill(oversized.entries[0]);
  assert.throws(() => validateSourceCursor(oversized), /bounded/);
  assert.throws(() => validateSourceCursor({ ...cursor(), callback() {} }), /JSON/);
});

test('full-capacity reverse causal chains validate and complete without depending on the JavaScript call stack', () => {
  const state = clone(cursor());
  state.entries = Array.from({ length: 4096 }, (_, sequence) => ({ event_ref: parent(`chain-${sequence}`), sequence,
    fingerprint: pin('a'), first_event_digest: pin('b'), idempotency_key: `chain-retry-${sequence}`,
    causal_parents: sequence ? [parent(`chain-${sequence - 1}`)] : [], completed: false })).reverse();
  Object.assign(state, { maximum_sequence: 4095, accepted_through: 4095, completed_through: null, gaps: [], unordered_count: 0 });
  assert.equal(validateSourceCursor(state), true);
  assert.equal(complete(state, 'event-chain-0').completed_through, 0);
  assert.throws(() => accept(state, event(4096)), /capacity exceeded/);
  assert.equal(state.completed_through, null);
});

test('Project freshness requires explicit source set and captured heads, with independently completed projections', () => {
  let state = accept(accept(cursor(), event(0)), event(2));
  assert.equal(freshness(state).watermarks[0].reason, 'source_input_incomplete');
  state = accept(state, event(1)); assert.equal(freshness(state).watermarks[0].reason, 'projection_incomplete');
  state = complete(state, 'event-2'); assert.equal(state.completed_through, null);
  state = complete(complete(state, 'event-0'), 'event-1'); assert.equal(freshness(state).status, 'caught-up');
  assert.equal(freshness(state, null).status, 'unknown'); assert.equal(freshness(state, 3).status, 'known-gap');
  const missing = stream(); missing.producer.epoch = 'another-epoch';
  const vector = projectFreshness({ scope, requirements: [{ source: stream(), target_sequence: 2 }, { source: missing, target_sequence: 0 }], cursors: [state] });
  assert.equal(vector.status, 'unknown'); assert.deepEqual(vector.watermarks.map(item => item.status), ['caught-up', 'unknown']);
  assert.equal(vector.watermarks[1].reason, 'missing_source'); assert.equal(validateFreshnessVector(vector), true);
  assert.equal(projectFreshness({ scope, requirements: [], cursors: [] }).status, 'unknown');
});

test('freshness rejects cross-scope, duplicate source and forged status/ranges', () => {
  const state = accept(cursor(), event(0)); const requirement = { source: stream(), target_sequence: 2 };
  assert.throws(() => projectFreshness({ scope: { ...scope, project_id: 'other' }, requirements: [requirement], cursors: [state] }), /crosses/);
  assert.throws(() => projectFreshness({ scope, requirements: [requirement, requirement], cursors: [state] }), /duplicate/);
  assert.throws(() => projectFreshness({ scope, requirements: [requirement], cursors: [state, state] }), /duplicate/);
  for (const mutate of [v => { v.status = 'caught-up'; }, v => { v.watermarks[0].status = 'caught-up'; },
    v => { v.watermarks[0].input_gaps = []; }, v => { v.watermarks[0].projection_gaps[0].from = 2; },
    v => { v.watermarks[0].completed_through = 2; }]) {
    const vector = clone(freshness(state)); mutate(vector); assert.throws(() => validateFreshnessVector(vector), TypeError);
  }
});

test('unknown freshness still rejects impossible known cursor summaries independently of the captured target', () => {
  for (const start of [0, 10, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]) {
    for (const target of [null, ...(start > 0 ? [start - 1] : [])]) {
      const view = state => projectFreshness({ scope, requirements: [{ source: stream(), target_sequence: target }], cursors: [state] });
      const empty = cursor({ start_sequence: start });
      const withoutPrefix = clone(view(empty)); withoutPrefix.watermarks[0].maximum_sequence = start;
      assert.throws(() => validateFreshnessVector(withoutPrefix), /contradicts contiguous accepted prefix/);
      const firstAccepted = accept(empty, event(start)); assert.equal(validateFreshnessVector(view(firstAccepted)), true);
      if (start < Number.MAX_SAFE_INTEGER) {
        const skippedNext = clone(view(firstAccepted)); skippedNext.watermarks[0].maximum_sequence = start + 1;
        assert.throws(() => validateFreshnessVector(skippedNext), /contradicts contiguous accepted prefix/);
        // A missing epoch start followed by a known observation is a valid sparse source.
        assert.equal(validateFreshnessVector(view(accept(empty, event(start + 1)))), true);
      }
      if (start < Number.MAX_SAFE_INTEGER - 1) {
        assert.equal(validateFreshnessVector(view(accept(firstAccepted, event(start + 2)))), true);
      }
    }
  }
});

test('freshness cross-validates accepted holes, projection holes and unobserved tail without enumerating positions', () => {
  const withHoles = accept(accept(cursor(), event(0)), event(2));
  for (const mutate of [
    v => { v.watermarks[0].projection_gaps = [{ from: 0, through: 0 }]; },
    v => { v.watermarks[0].input_gaps = [{ from: 1, through: 2 }]; },
    v => { v.watermarks[0].input_gaps = [{ from: 1, through: 1 }]; v.watermarks[0].target_sequence = 4; },
  ]) {
    const vector = clone(freshness(withHoles)); mutate(vector); assert.throws(() => validateFreshnessVector(vector), TypeError);
  }
  const absent = clone(freshness(cursor(), Number.MAX_SAFE_INTEGER));
  absent.watermarks[0].input_gaps[0].through = 10;
  assert.throws(() => validateFreshnessVector(absent), /unobserved/);
});

const git = char => ({ kind: 'git_commit', tenant_id: 'acme', repository_id: 'api', object_format: 'sha1', oid: char.repeat(40) });
const node = (char, parents = [], parents_complete = true) => ({ commit: git(char), parents: parents.map(git), parents_complete });
const graph = [node('a'), node('b', ['a']), node('c', ['b']), node('d', ['a']), node('e', ['c', 'd'])];
const movement = (before, after, commits = graph, reported_operation = 'update') => classifyGitRefMovement({
  ref: { tenant_id: 'acme', repository_id: 'api', object_format: 'sha1', name: 'refs/heads/main' },
  before: before === null ? null : git(before), after: after === null ? null : git(after), commits, reported_operation,
});

test('Git ref create/advance/rewind/delete and merge ancestry use immutable DAG identity', () => {
  assert.equal(movement(null, 'a').movement, 'create'); assert.equal(movement('a', null).movement, 'delete');
  assert.equal(movement('b', 'b').movement, 'unchanged'); assert.equal(movement('a', 'c').movement, 'advance');
  assert.equal(movement('c', 'a').movement, 'rewind'); assert.equal(movement('d', 'e').before_is_ancestor, 'yes');
  assert.equal(movement('c', 'd').movement, 'diverge'); assert.throws(() => movement(null, null), /empty/);
});

test('force-push and rebase are reported operations, not synthesized commit ancestry or source rewrite', () => {
  const before = clone(graph);
  const forced = movement('c', 'd', graph, 'force_push'); assert.equal(forced.reported_operation, 'force_push'); assert.equal(forced.movement, 'diverge');
  const rebased = movement('c', 'd', graph, 'rebase'); assert.equal(rebased.reported_operation, 'rebase'); assert.equal(rebased.movement, 'diverge');
  assert.equal(movement('a', 'b', graph, 'force_push').movement, 'advance'); assert.deepEqual(graph, before);
});

test('missing or shallow Git ancestry stays unknown; discovered ancestry still proves reachability', () => {
  assert.equal(movement('c', 'd', []).movement, 'unknown');
  assert.equal(movement('c', 'd', [node('c', [], false), node('d')]).movement, 'unknown');
  assert.equal(movement('a', 'b', [node('b', ['a'], false)]).movement, 'advance');
  const completeRoots = movement('a', 'd', [node('a'), node('d')]); assert.equal(completeRoots.movement, 'diverge');
});

test('Git graph rejects tenant/repository/format aliasing, partial OIDs, duplicate parents and cycles', () => {
  for (const field of ['tenant_id', 'repository_id', 'object_format']) {
    const altered = clone(graph); altered[0].commit[field] = field === 'object_format' ? 'sha256' : 'other';
    assert.throws(() => movement('a', 'b', altered), /repository|OID/);
  }
  assert.throws(() => movement('a', 'b', [node('a', ['b']), node('b', ['a'])]), /cycle/);
  assert.throws(() => movement('a', 'b', [node('a'), node('a')]), /duplicate/);
  assert.throws(() => movement('a', 'b', [node('b', ['a', 'a'])]), /parent/);
  const altered = clone(graph); altered[0].commit.oid = 'a'.repeat(12); assert.throws(() => movement('a', 'b', altered), /OID/);
});

test('full-capacity reverse Git ancestry validates iteratively and retains cycle rejection', () => {
  const commit = i => ({ ...git('a'), oid: i.toString(16).padStart(40, '0') });
  const commits = Array.from({ length: 4096 }, (_, i) => ({ commit: commit(i), parents: i ? [commit(i - 1)] : [], parents_complete: true })).reverse();
  const input = { ref: { tenant_id: 'acme', repository_id: 'api', object_format: 'sha1', name: 'refs/heads/main' },
    before: commit(0), after: commit(4095), commits, reported_operation: 'update' };
  assert.equal(classifyGitRefMovement(input).movement, 'advance');
  input.commits.at(-1).parents = [commit(4095)];
  assert.throws(() => classifyGitRefMovement(input), /Git ancestry cycle/);
});

function replayInput() {
  const fixturePolicy = fixture('policy-artifacts/ingress.json');
  return { replay_id: 'replay-1', scope, input_graph: { generation_id: 'live-5', snapshot_digest: pin('a') },
    output_generation_id: 'replay-1-output', events: [event(0), event(1)],
    policy: compilePolicyArtifact(fixturePolicy.definition, { operations: fixturePolicy.operations }),
    models: [{ model_id: 'offline-fixture', provider: 'recorded', model: 'fixture', model_revision: '1',
      adapter_id: 'recorded-judge', adapter_version: '1', parameters_digest: pin('b') }],
    model_bindings: { durability: 'offline-fixture' } };
}
function effect(manifest, extra = {}) {
  return { kind: 'replay_derived_write', record_id: 'candidate-1', replay_id: manifest.replay_id, manifest_digest: manifest.manifest_digest,
    scope: manifest.scope, generation_id: manifest.output_generation_id, data: { candidate_id: 'synthetic', source_event_id: 'event-0' }, ...extra };
}

test('replay manifest pins exact normalized inputs, payload digests, compiled policy, operation descriptors, model routing and generations', () => {
  const input = replayInput(); const before = clone(input); const manifest = createReplayManifest(input);
  assert.equal(validateReplayManifest(manifest), true); assert.deepEqual(input, before); assert.ok(Object.isFrozen(manifest.inputs[0].event));
  assert.equal(manifest.inputs[0].payload_digest, input.events[0].payload.digest);
  assert.equal(manifest.policy.content_hash, input.policy.content_hash); assert.equal(manifest.policy.executable_hash, input.policy.executable_hash);
  assert.deepEqual(manifest.policy.operations, input.policy.operations); assert.deepEqual(manifest.model_bindings, input.model_bindings);
  assert.equal(validateGraphGenerationPin(input.input_graph), true);
  const changed = replayInput(); changed.events[0] = event(0, raw => { raw.observed_at = '2026-09-22T10:00:00.000Z'; });
  assert.notEqual(createReplayManifest(changed).manifest_digest, manifest.manifest_digest);
  assert.equal(sourceEventFingerprint(changed.events[0]), sourceEventFingerprint(input.events[0]));
});

test('replay pins detect event/hash/policy/operation/model/generation tampering', () => {
  const manifest = createReplayManifest(replayInput());
  for (const mutate of [m => { m.inputs[0].event.observed_at = '2026-09-22T10:00:00.000Z'; },
    m => { m.inputs[0].payload_digest = pin('c'); }, m => { m.inputs[0].event_digest = pin('c'); },
    m => { m.policy.content_hash = pin('c'); }, m => { m.policy.executable_hash = pin('c'); },
    m => { m.policy.operations[0].implementation_hash = pin('c'); }, m => { m.models[0].model_revision = '2'; },
    m => { m.input_graph.snapshot_digest = pin('c'); }, m => { m.output_generation_id = 'other'; },
    m => { m.manifest_digest = pin('c'); }, m => { m.model_bindings.durability = 'missing'; }]) {
    const changed = clone(manifest); mutate(changed); assert.throws(() => validateReplayManifest(changed));
  }
});

test('replay requires immutable authorized inputs, exact one-to-one observations, Project scope and complete model routing', () => {
  for (const mutate of [i => { i.output_generation_id = i.input_graph.generation_id; },
    i => { i.events.push(i.events[0]); }, i => { i.events.push(event(0, raw => { raw.event_id = 'alias'; raw.idempotency_key = 'alias'; })); },
    i => { i.scope = { ...scope, project_id: 'another' }; }, i => { i.models = []; },
    i => { i.model_bindings = {}; }, i => { i.model_bindings.scope = 'offline-fixture'; },
    i => { i.events[0] = event(0, raw => { raw.payload = { kind: 'mutable_pointer', pointer_id: 'head', digest: pin('a') }; }); },
    i => { i.events[0] = event(0, raw => { raw.payload = { kind: 'snapshot', snapshot_id: 'ungranted', digest: pin('a') }; }); }]) {
    const input = replayInput(); mutate(input); assert.throws(() => createReplayManifest(input));
  }
});

test('reference replay dispatcher writes only the isolated generation and keeps source graph/cursors/jobs/callback/canonical handles untouched', () => {
  const manifest = createReplayManifest(replayInput()); const empty = createReplayState(manifest);
  const live = { graph: [], cursors: [accept(cursor(), event())], jobs: [], callbacks: [], canonical: [] }; const before = clone(live);
  const candidate = effect(manifest); const audit = effect(manifest, { kind: 'replay_audit_append', record_id: 'audit-1', data: { action: 'INGEST' } });
  const state = applyReplayEffect(applyReplayEffect(empty, manifest, candidate), manifest, audit);
  assert.equal(state.records.length, 2); assert.equal(empty.records.length, 0); assert.deepEqual(live, before);
  assert.deepEqual(applyReplayEffect(state, manifest, candidate), state); assert.equal(assertReplayEffect(manifest, candidate), true);
  assert.throws(() => applyReplayEffect(state, manifest, effect(manifest, { data: { changed: true } })), /identity conflict/);
  assert.throws(() => applyReplayEffect(empty, manifest, { ...candidate, dispatch() { live.canonical.push('wrong'); } }), /JSON/);
  for (const kind of ['live_graph_write', 'connector_cursor_advance', 'job_submit', 'callback_emit', 'canonical_write', 'model_call', 'unknown']) {
    assert.throws(() => applyReplayEffect(empty, manifest, effect(manifest, { kind })), /forbidden/);
  }
  assert.deepEqual(live, before);
});

test('replay admission fences tenant, Project, run, manifest, generation and imported state', () => {
  const manifest = createReplayManifest(replayInput()); const empty = createReplayState(manifest);
  for (const extra of [{ scope: { ...scope, tenant_id: 'other' } }, { scope: { ...scope, project_id: 'other' } },
    { generation_id: manifest.input_graph.generation_id }, { generation_id: 'other-replay' }, { replay_id: 'other' }, { manifest_digest: pin('f') }]) {
    assert.throws(() => applyReplayEffect(empty, manifest, effect(manifest, extra)), /crosses replay generation/);
  }
  for (const field of ['generation_id', 'replay_id', 'manifest_digest']) {
    const changed = clone(empty); changed[field] = field === 'manifest_digest' ? pin('f') : 'other';
    assert.throws(() => applyReplayEffect(changed, manifest, effect(manifest)), /state crosses/);
  }
  const forged = clone(empty); forged.records = [effect(manifest, { kind: 'canonical_write' })];
  assert.throws(() => applyReplayEffect(forged, manifest, effect(manifest)), /forbidden/);
});
