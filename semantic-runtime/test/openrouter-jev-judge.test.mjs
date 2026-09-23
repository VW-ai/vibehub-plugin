import test from 'node:test';
import assert from 'node:assert/strict';
import { experimental_evaluate as evaluate } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { OpenRouterJevJudge, OPENROUTER_JEV_MODEL } from '../src/index.mjs';
import { validateDecision } from '../src/domain/shared/contracts.mjs';
import { ResilientJudge } from '../src/adapters/providers/resilient-judge.mjs';

const apiKey = 'synthetic-test-key';
const input = {
  event: { type: 'HUMAN_DECISION', timestamp: '2026-09-22T00:00:00.000Z',
    payload: { text: 'Keep the token schema.', secret_metadata: 'not-for-model' },
    source: { ref: 'private-local-ref' } },
  stateRefs: [], question: { family: 'durable_cross_ticket_value', text: 'Is this durable?' },
};
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json', ...headers },
});
const answer = probability => ({ answers: { relevant: { type: 'noul', noul: probability } } });

test('real SDK uses explicit OpenRouter alpha endpoint and preserves bounded metadata', async () => {
  let calls = 0;
  const judge = new OpenRouterJevJudge({ apiKey, fetch: async (url, options) => {
    calls++;
    assert.equal(url, 'https://openrouter.ai/api/alpha/decisions');
    assert.equal(new Headers(options.headers).get('authorization'), `Bearer ${apiKey}`);
    const body = JSON.parse(options.body);
    assert.equal(body.model, OPENROUTER_JEV_MODEL);
    assert.deepEqual(body.provider, { allow_fallbacks: false });
    assert.deepEqual(body.questions, { relevant: { type: 'noul', instructions: input.question.text } });
    assert.deepEqual(body.state, { event: { type: input.event.type, timestamp: input.event.timestamp, text: input.event.payload.text }, candidates: [] });
    assert.ok(!options.body.includes('private-local-ref'));
    return json({ ...answer(0.91), model: 'typesafe/jev-1.13-resolved', provider: 'TypeSafe', usage: { input_tokens: 100, output_tokens: 4, cost: 0.0002 } });
  } });
  const result = await judge.evaluate(input);
  assert.equal(calls, 1);
  assert.equal(result.confidence, 0.91);
  assert.equal(result.model, 'typesafe/jev-1.13-resolved');
  assert.equal(judge.descriptor.model, OPENROUTER_JEV_MODEL);
  assert.equal(validateDecision(result, input).value.relevant, true);
  assert.deepEqual(result.telemetry, { final_provider: 'TypeSafe', cost_usd: 0.0002, input_tokens: 100, output_tokens: 4, total_tokens: 104 });
  assert.equal(judge.descriptor.calibrated, false);
});

test('target slots map only visible IDs and negative probability means confidence in false', async () => {
  const relational = { ...input, question: { family: 'context_relevance', text: 'Which context?' }, stateRefs: [
    { id: 'schema', type: 'context', text: 'Stable schema' }, { id: 'ui', type: 'context', text: 'Green UI' },
  ] };
  const judge = new OpenRouterJevJudge({ apiKey, fetch: async (_, options) => {
    assert.deepEqual(Object.keys(JSON.parse(options.body).questions), ['target_0', 'target_1']);
    return json({ answers: { target_1: { type: 'noul', noul: 0.1 }, target_0: { type: 'noul', noul: 0.84 } } });
  } });
  const result = await judge.evaluate(relational);
  assert.deepEqual(validateDecision(result, relational).value, { relevant: true, target_ids: ['schema'] });
  const negative = await new OpenRouterJevJudge({ apiKey, fetch: async () => json(answer(0.2)) }).evaluate(input);
  assert.equal(negative.value.relevant, false); assert.equal(negative.confidence, 0.8);
  assert.equal(negative.telemetry.cost_usd, null);
});

test('no targets, unsupported family, duplicate IDs and excess targets never call a provider', async () => {
  let calls = 0;
  const judge = new OpenRouterJevJudge({ apiKey, maxTargets: 1, fetch: async () => { calls++; throw new Error('unexpected'); } });
  const empty = { ...input, question: { ...input.question, family: 'acceptance_relevance' } };
  assert.equal(judge.requiresNetwork(empty), false);
  assert.equal((await judge.evaluate(empty)).reason_code, 'no_visible_targets');
  await assert.rejects(judge.evaluate({ ...input, question: { family: 'unknown', text: 'x' } }), /Unsupported/);
  await assert.rejects(judge.evaluate({ ...input, stateRefs: [{ id: 'a' }, { id: 'b' }] }), /budget/);
  const duplicate = new OpenRouterJevJudge({ apiKey, fetch: async () => { calls++; } });
  await assert.rejects(duplicate.evaluate({ ...input, stateRefs: [{ id: 'a' }, { id: 'a' }] }), /Duplicate/);
  assert.equal(calls, 0);
});

test('malformed, wrong-type, missing and extra answers fail with sanitized errors', async () => {
  for (const body of [answer(2), { answers: {} }, { answers: { other: { type: 'noul', noul: 0.9 } } },
    { answers: { relevant: { type: 'score', score: 1 } } },
    { answers: { ...answer(0.9).answers, extra: { type: 'noul', noul: 0.1 } } }, { broken: apiKey }]) {
    const judge = new OpenRouterJevJudge({ apiKey, fetch: async () => json(body) });
    await assert.rejects(judge.evaluate(input), error => {
      assert.equal(error.code, 'openrouter_request_failed');
      assert.ok(!JSON.stringify(error).includes(apiKey));
      assert.equal(error.cause, undefined); assert.equal(error.requestBodyValues, undefined);
      return true;
    });
  }
});

test('unsupported model is one non-retryable call; rate limits use existing bounded retry wrapper', async () => {
  let calls = 0;
  const unsupported = new OpenRouterJevJudge({ apiKey, model: 'typesafe/not-a-model', fetch: async () => {
    calls++; return json({ error: { message: `unsupported ${apiKey}`, code: 400 } }, 400);
  } });
  await assert.rejects(unsupported.evaluate(input), error => error.statusCode === 400 && !error.message.includes(apiKey));
  assert.equal(calls, 1);
  let attempts = 0;
  const retrying = new ResilientJudge(new OpenRouterJevJudge({ apiKey, fetch: async () => {
    attempts++;
    return attempts === 1 ? json({ error: { message: 'limited', code: 429 } }, 429, { 'retry-after': '0' }) : json(answer(0.8));
  } }), { maxAttempts: 2, minIntervalMs: 0, baseDelayMs: 0, maxDelayMs: 0 });
  assert.equal((await retrying.evaluate(input)).value.relevant, true);
  assert.equal(attempts, 2); assert.equal(retrying.snapshot().rate_limited, 1);
  let exhausted = 0;
  const unavailable = new ResilientJudge(new OpenRouterJevJudge({ apiKey, fetch: async () => {
    exhausted++; return json({ error: { message: 'unavailable', code: 503 } }, 503);
  } }), { maxAttempts: 2, minIntervalMs: 0, baseDelayMs: 0, maxDelayMs: 0 });
  await assert.rejects(unavailable.evaluate(input), error => error.code === 'judge_retry_exhausted');
  assert.equal(exhausted, 2);
});

test('timeout and caller cancellation abort the actual provider transport', async () => {
  let aborted = 0;
  const pending = async (_, options) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture stuck')), 5_000);
    const stop = () => { clearTimeout(timer); aborted++; reject(options.signal.reason); };
    if (options.signal.aborted) stop();
    else options.signal.addEventListener('abort', stop, { once: true });
  });
  await assert.rejects(new OpenRouterJevJudge({ apiKey, timeoutMs: 15, fetch: pending }).evaluate(input), error => error.code === 'judge_timeout');
  const controller = new AbortController();
  const task = new OpenRouterJevJudge({ apiKey, fetch: pending }).evaluate(input, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 15);
  try { await assert.rejects(task, error => error.code === 'judge_aborted'); } finally { clearTimeout(timer); }
  assert.equal(aborted, 2);
});

test('pinned SDK preserves rounded score distributions rather than treating scores as booleans', async () => {
  const provider = createOpenRouter({ apiKey, fetch: async () => json({
    answers: { severity: { type: 'score', score: 1.67, probabilities: { 0: 0, 1: 0.33, 2: 0.67 }, confidence: 0.7, legend: { 0: 'low', 1: 'medium', 2: 'high' } } },
  }) });
  const result = await evaluate({ model: provider.evaluationModel(OPENROUTER_JEV_MODEL), state: 'synthetic', maxRetries: 0,
    questions: { severity: { type: 'score', instructions: 'Severity?', criteria: ['low', 'medium', 'high'] } } });
  assert.equal(result.answers.severity.score, 1.67);
  assert.equal(result.answers.severity.probabilities['2'], 0.67);
  assert.equal(result.providerMetadata.openrouter.answers.severity.confidence, 0.7);
});

test('invalid and overflowing token usage stays explicitly unknown', async () => {
  for (const [count, expected] of [[1e308, null], [-1, null], [0.5, null], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]]) {
    const judge = new OpenRouterJevJudge({ apiKey, fetch: async () => json({
      ...answer(0.8), usage: { input_tokens: count, output_tokens: count },
    }) });
    const { telemetry } = await judge.evaluate(input);
    assert.equal(telemetry.input_tokens, expected);
    assert.equal(telemetry.output_tokens, expected);
    assert.equal(telemetry.total_tokens, null);
    assert.equal(telemetry.cost_usd, null);
  }
});
