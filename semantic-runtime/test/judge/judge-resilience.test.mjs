import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CachedJudge } from '../../src/adapters/providers/cached-judge.mjs';
import { ResilientJudge } from '../../src/adapters/providers/resilient-judge.mjs';

const input = {
  event: { type: 'USER_INTENT', timestamp: '2026-09-20T00:00:00.000Z', payload: { text: 'Keep this decision.' } },
  stateRefs: [],
  question: { family: 'durable_cross_ticket_value', text: 'Is this durable?' },
};
const decision = {
  value: { relevant: true, target_ids: [] }, confidence: 0.9, latency_ms: 4,
  provider: 'fixture', model: 'fixture-v1', reason_code: 'fixture_positive',
  telemetry: { final_provider: 'fixture-route', cost_usd: 0.01, input_tokens: 10, output_tokens: 2, total_tokens: 12 },
};

function fixtureJudge(evaluate) {
  return { descriptor: { provider: 'fixture', model: 'fixture-v1', prompt_version: 'v1' }, evaluate };
}

test('ResilientJudge spaces requests and retries a 429 using bounded Retry-After', async () => {
  let now = 1000;
  const waits = [];
  let calls = 0;
  const delegate = fixtureJudge(async () => {
    calls++;
    if (calls === 1) {
      const error = new Error('secret provider body');
      error.statusCode = 429;
      error.responseHeaders = { 'retry-after': '3' };
      throw error;
    }
    return decision;
  });
  const judge = new ResilientJudge(delegate, {
    minIntervalMs: 2500, maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5000,
    now: () => now,
    sleep: async ms => { waits.push(ms); now += ms; },
  });
  assert.equal((await judge.evaluate(input)).confidence, 0.9);
  assert.deepEqual(waits, [3000]);
  assert.equal(calls, 2);
  assert.deepEqual(judge.snapshot(), {
    requests: 2, retries: 1, rate_limited: 1, transient_failures: 0, wait_ms: 3000,
  });
  now += 100;
  await judge.evaluate(input);
  assert.equal(waits.at(-1), 2400);
});

test('ResilientJudge does not retry permanent errors and never exposes their message', async () => {
  let calls = 0;
  const judge = new ResilientJudge(fixtureJudge(async () => {
    calls++;
    const error = new Error('secret credential in provider body');
    error.statusCode = 401;
    throw error;
  }), { minIntervalMs: 0 });
  await assert.rejects(() => judge.evaluate(input), error => {
    assert.equal(error.message, 'Judge provider request failed');
    assert.equal(error.message.includes('secret'), false);
    return true;
  });
  assert.equal(calls, 1);
});

test('ResilientJudge bounds retry exhaustion and honors abort during backoff', async () => {
  const unavailable = fixtureJudge(async () => {
    const error = new Error('hidden');
    error.statusCode = 503;
    throw error;
  });
  const exhausted = new ResilientJudge(unavailable, {
    minIntervalMs: 0, maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {},
  });
  await assert.rejects(() => exhausted.evaluate(input), /transient retry budget exhausted/);
  assert.equal(exhausted.snapshot().retries, 1);

  const controller = new AbortController();
  const aborted = new ResilientJudge(unavailable, {
    minIntervalMs: 0, maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1,
    sleep: async () => { controller.abort(); },
  });
  await assert.rejects(() => aborted.evaluate(input, { signal: controller.signal }), /aborted/);
});

test('CachedJudge checkpoints only validated successes and reuses them after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'semantic-judge-cache-'));
  const path = join(directory, 'cache.jsonl');
  try {
    let calls = 0;
    const first = new CachedJudge(fixtureJudge(async () => { calls++; return decision; }), { path });
    assert.equal((await first.evaluate(input)).confidence, 0.9);
    assert.equal(calls, 1);
    assert.equal(first.snapshot().entries_written, 1);
    assert.equal(readFileSync(path, 'utf8').includes(input.event.payload.text), false);

    const second = new CachedJudge(fixtureJudge(async () => { calls++; return decision; }), { path });
    assert.equal((await second.evaluate(input)).confidence, 0.9);
    assert.equal(calls, 1);
    assert.equal(second.snapshot().cache_hits, 1);
    assert.deepEqual(second.snapshot().observed.provider_routes, { 'fixture-route': 1 });

    const changed = new CachedJudge({
      descriptor: { provider: 'fixture', model: 'fixture-v1', prompt_version: 'v2' },
      evaluate: async () => { calls++; return decision; },
    }, { path });
    await changed.evaluate(input);
    assert.equal(calls, 2);

    const invalidPath = join(directory, 'invalid.jsonl');
    const invalid = new CachedJudge(fixtureJudge(async () => ({ ...decision, confidence: 2 })), { path: invalidPath });
    await assert.rejects(() => invalid.evaluate(input), /Invalid judge confidence/);
    assert.equal(invalid.snapshot().entries_written, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
