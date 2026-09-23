import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { FAMILIES } from '../../../src/domain/shared/contracts.mjs';
import { normalizeEvent, normalizeState, visibleState } from '../src/contracts.mjs';
import { HeuristicJudge } from '../adapters/heuristic-judge.mjs';
import { replay } from '../src/replay.mjs';
import { PacedJudge, verifyBenchmarkReport } from '../benchmark-peel-jev.mjs';
import { codexTurnIdentity, resolveProvenanceEntry } from '../verify-peel-provenance.mjs';
import { fixture } from './support.mjs';

const base = new URL('../fixtures/peel/', import.meta.url);
const events = readFileSync(new URL('events.jsonl', base), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const state = JSON.parse(readFileSync(new URL('state.json', base), 'utf8'));
const labels = JSON.parse(readFileSync(new URL('labels.json', base), 'utf8'));
const curation = JSON.parse(readFileSync(new URL('curation.json', base), 'utf8'));
const provenance = JSON.parse(readFileSync(new URL('provenance.json', base), 'utf8'));
const scope = { tenant_id: 'benchmark', project_id: 'peel' };

test('Peel corpus is bounded, chronological, sanitized, and traceable', () => {
  assert.equal(events.length, 20);
  assert.equal(new Set(events.map(event => event.event_id)).size, 20);
  assert.deepEqual(events.map(event => event.event_id),
    [...events].sort((left, right) => left.timestamp.localeCompare(right.timestamp)).map(event => event.event_id));

  const curated = new Map(curation.events.map(item => [item.event_id, item]));
  const eventSources = new Map(provenance.events.map(item => [item.event_id, item]));
  assert.equal(curation.source_kind, 'selected-sanitized-real-trajectory');
  assert.equal(curation.dataset_id, provenance.dataset_id);
  assert.equal(curated.size, 20);
  assert.equal(eventSources.size, 20);
  for (const event of events) {
    assert.equal(event.source.provider, 'codex-project-curated');
    assert.match(event.source.ref, /^trace:\/\/peel\//);
    assert.equal(event.source.session_id, undefined);
    assert.equal(event.source.worktree_id, undefined);
    assert.ok(event.payload.text.length <= 240, `${event.event_id} is not a bounded excerpt`);
    assert.ok(curated.get(event.event_id)?.selection_reason);
    assert.ok(curated.get(event.event_id)?.label_basis);

    const source = eventSources.get(event.event_id);
    assert.ok(source, `${event.event_id} needs a provenance entry`);
    assert.equal(source.source_ref, event.source.ref);
    assert.match(source.source_identity,
      /^(?:sha256:[a-f0-9]{64}|git:[a-f0-9]{40}(?::[a-f0-9]{40})?)$/);
    assert.match(source.source_locator,
      /^(?:peel-codex-turn:\/\/sha256:[a-f0-9]{64}|peel-git:\/\/[a-f0-9]{40}\/|peel-record:\/\/|peel-pr:\/\/)/);
    assert.ok(Number.isFinite(Date.parse(source.source_available_at)),
      `${event.event_id} needs an authentic source timestamp`);
    assert.ok(Date.parse(event.timestamp) >= Date.parse(source.source_available_at),
      `${event.event_id} predates its authentic source`);

    if (event.type === 'EVIDENCE_CREATED') {
      const ledger = curated.get(event.event_id);
      assert.match(ledger.source_outcome_ref, /^peel-outcome:\/\//,
        `${event.event_id} needs an immutable source Outcome reference`);
      assert.ok(Number.isFinite(Date.parse(ledger.source_not_before)),
        `${event.event_id} needs a valid authentic-source timestamp`);
      assert.ok(Date.parse(event.timestamp) >= Date.parse(ledger.source_not_before),
        `${event.event_id} predates its authentic source Outcome`);
    }
  }

  const checked = JSON.stringify({ events, state, curation, provenance });
  for (const forbidden of [
    /\/Users\//, /\/var\/folders\//, /\b01[a-f0-9]{30,}\b/i,
    /AI_GATEWAY_API_KEY/, /\bBearer\s+[A-Za-z0-9._-]+/i, /\bsk-[A-Za-z0-9_-]{8,}/,
  ]) assert.doesNotMatch(checked, forbidden);

  const phases = new Set(curation.events.map(item => item.trace_phase));
  for (const phase of ['setup', 'product-decision', 'implementation', 'pr-review', 'unfinished-work-recovery']) {
    assert.ok(phases.has(phase), `missing trace phase ${phase}`);
  }
});

test('Peel labels cover every family and only target point-in-time visible state', () => {
  const normalizedEvents = events.map(normalizeEvent);
  const byId = new Map(normalizedEvents.map(event => [event.event_id, event]));
  const normalizedState = normalizeState(state);
  assert.equal(labels.length, events.length * FAMILIES.length);
  assert.equal(new Set(labels.map(label => `${label.event_id}:${label.family}`)).size, labels.length);

  const stateSources = new Map(provenance.state.map(item => [item.state_id, item]));
  assert.equal(stateSources.size, state.length);
  for (const item of state) {
    const source = stateSources.get(item.id);
    assert.ok(source, `${item.id} needs a provenance entry`);
    assert.equal(source.source_ref, item.source_ref);
    assert.equal(source.source_available_at, item.available_at,
      `${item.id} available_at must be bound to source history`);
    assert.match(source.source_identity,
      /^(?:sha256:[a-f0-9]{64}|git:[a-f0-9]{40}(?::[a-f0-9]{40})?)$/);
    assert.match(source.source_locator,
      /^(?:peel-codex-turn:\/\/sha256:[a-f0-9]{64}|peel-git:\/\/[a-f0-9]{40}\/|peel-record:\/\/|peel-pr:\/\/)/);
  }

  for (const item of state.filter(candidate => candidate.type === 'acceptance')) {
    assert.match(item.source_ref, /^peel-ticket:\/\/[^/]+\/acceptance\/[^/]+$/,
      `${item.id} needs a real source Ticket acceptance reference`);
    assert.equal(item.id, `acceptance-${item.source_ref.split('/').at(-1)}`,
      `${item.id} must preserve the source acceptance ID`);
  }

  for (const family of FAMILIES) {
    const familyLabels = labels.filter(label => label.family === family);
    assert.equal(familyLabels.length, events.length);
    assert.ok(familyLabels.some(label => label.relevant), `${family} needs positive examples`);
    assert.ok(familyLabels.some(label => !label.relevant), `${family} needs negative examples`);
  }

  for (const label of labels) {
    const event = byId.get(label.event_id);
    assert.ok(event, `unknown labeled event ${label.event_id}`);
    const visible = new Set(visibleState(event, label.family, normalizedState).map(item => item.id));
    assert.ok(label.target_ids.every(id => visible.has(id)), `${label.event_id}:${label.family} leaks future or foreign state`);
  }

  const hardCases = new Set(curation.events.flatMap(item => item.hard_cases));
  for (const required of [
    'durable-vs-transient', 'evidence-vs-activity', 'context-supersession',
    'schedulable-work', 'human-review-boundary', 'semantic-git-durability-mismatch',
  ]) assert.ok(hardCases.has(required), `missing hard case ${required}`);
});

test('Peel corpus replays as real data without exposing labels to the judge', async t => {
  const { store } = fixture(t);
  const seen = [];
  const baseline = new HeuristicJudge();
  const judge = {
    descriptor: baseline.descriptor,
    evaluate(input, options) {
      seen.push(input);
      assert.equal(input.labels, undefined);
      assert.equal(input.curation, undefined);
      assert.deepEqual(input.event.provenance, { repo: 'fixture/peel' });
      const serialized = JSON.stringify(input);
      for (const field of ['source_identity', 'source_locator', 'source_available_at']) {
        assert.equal(serialized.includes(`"${field}"`), false);
      }
      for (const source of [...provenance.events, ...provenance.state]) {
        assert.equal(serialized.includes(source.source_locator), false);
      }
      return baseline.evaluate(input, options);
    },
  };
  const policy = JSON.parse(readFileSync(new URL('../policies/phase0.json', import.meta.url), 'utf8'));
  const report = await replay({ events, state, labels, scope, policy, judge, store, datasetKind: 'real' });
  assert.equal(report.events, 20);
  assert.equal(report.decisions, 80);
  assert.equal(report.judge_errors, 0);
  assert.equal(report.dataset_kind, 'real');
  assert.equal(report.productization_gate, 'not_evaluated');
  assert.equal(seen.length, 80);
});

test('Peel private turn locators have an executable privacy-preserving resolver contract', () => {
  const raw = {
    thread_id: 'private-thread-id', turn_id: 'private-turn-id',
    phase: 'turn_completed', source_available_at: '2026-08-29T00:53:15.000Z',
  };
  const identity = codexTurnIdentity(raw.thread_id, raw.turn_id, raw.phase);
  assert.deepEqual(resolveProvenanceEntry({
    source_ref: 'trace://fixture/private-turn',
    source_identity: identity,
    source_locator: `peel-codex-turn://${identity}`,
    source_available_at: raw.source_available_at,
  }, { codexTurns: [raw] }), {
    kind: 'codex_turn', identity, source_available_at: raw.source_available_at,
  });
});

test('Peel live benchmark cannot report a provider-wide defer as success', () => {
  const complete = {
    run_id: 'fixture-run', events: 20, decisions: 80, judge_errors: 0,
    productization_gate: 'not_evaluated',
  };
  assert.equal(verifyBenchmarkReport(complete), complete);
  assert.throws(() => verifyBenchmarkReport({ ...complete, judge_errors: 80 }), /80 judge errors/);
  assert.throws(() => verifyBenchmarkReport({ ...complete, productization_gate: 'passed' }), /must not advance/);
});

test('Peel live benchmark spaces provider requests without changing judge results', async () => {
  let time = 1000;
  const waits = [];
  const delegate = {
    descriptor: { provider: 'fixture', model: 'fixture', kind: 'fixture' },
    async evaluate(input) { return input; },
  };
  const judge = new PacedJudge(delegate, {
    minIntervalMs: 2500,
    now: () => time,
    sleep: async ms => { waits.push(ms); time += ms; },
  });
  assert.equal(await judge.evaluate('first'), 'first');
  time += 400;
  assert.equal(await judge.evaluate('second'), 'second');
  assert.deepEqual(waits, [2100]);
  assert.equal(judge.descriptor.request_spacing_ms, 2500);
});
