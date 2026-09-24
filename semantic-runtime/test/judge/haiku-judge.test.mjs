import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HaikuJudge } from '../../src/adapters/providers/haiku-judge.mjs';
import { validateDecision } from '../../src/domain/shared/contracts.mjs';

const event = {
  type: 'HUMAN_DECISION', timestamp: '2026-09-20T00:00:00.000Z',
  payload: { text: 'Preserve the refresh token schema.' },
};
const stateRefs = [
  { id: 'acceptance-schema', type: 'acceptance', text: 'Token schema stays stable.' },
  { id: 'acceptance-ui', type: 'acceptance', text: 'Login renders correctly.' },
];

test('Haiku maps schema-validated probabilities into the shared decision contract', async () => {
  let request;
  const signal = new AbortController().signal;
  const judge = new HaikuJudge({ generateTextFn: async input => {
    request = input;
    return {
      output: { probabilities: [0.91] },
      usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 },
      providerMetadata: { gateway: { cost: '0.00004', routing: { finalProvider: 'anthropic' } } },
    };
  } });
  const input = { event, stateRefs: [], question: { family: 'durable_cross_ticket_value', text: 'Is this durable?' } };
  const result = await judge.evaluate(input, { signal });
  assert.deepEqual(result.value, { relevant: true, target_ids: [] });
  assert.equal(result.confidence, 0.91);
  assert.equal(result.reason_code, 'haiku_positive');
  assert.equal(request.model, 'anthropic/claude-haiku-4.5');
  assert.equal(request.abortSignal, signal);
  assert.equal(request.maxRetries, 0);
  assert.deepEqual(request.providerOptions, { gateway: { sort: 'latency' } });
  const prompt = JSON.parse(request.prompt);
  assert.equal(prompt.state.event.text, event.payload.text);
  assert.deepEqual(prompt.state.candidates, []);
  assert.equal(prompt.family, 'durable_cross_ticket_value');
  assert.equal(result.telemetry.final_provider, 'anthropic');
  assert.equal(result.telemetry.cost_usd, 0.00004);
  assert.deepEqual(validateDecision(result, input).value, result.value);
});

test('Haiku evaluates relational candidates in the same visible order as JEV', async () => {
  let request;
  const judge = new HaikuJudge({ generateTextFn: async input => {
    request = input;
    return { output: { probabilities: [0.94, 0.12] }, usage: {}, providerMetadata: {} };
  } });
  const input = { event, stateRefs, question: { family: 'acceptance_relevance', text: 'Does this support the acceptance?' } };
  const result = await judge.evaluate(input);
  assert.deepEqual(result.value, { relevant: true, target_ids: ['acceptance-schema'] });
  assert.equal(result.confidence, 0.94);
  const prompt = JSON.parse(request.prompt);
  assert.deepEqual(prompt.state.candidates.map(item => item.id), ['acceptance-schema', 'acceptance-ui']);
  assert.deepEqual(prompt.slots.map(item => item.index), [0, 1]);
  assert.deepEqual(validateDecision(result, input).value, result.value);
});

test('Haiku avoids a provider call when no relational targets are visible', async () => {
  let calls = 0;
  const judge = new HaikuJudge({ generateTextFn: async () => { calls += 1; } });
  const result = await judge.evaluate({
    event, stateRefs: [], question: { family: 'context_relevance', text: 'Which context is relevant?' },
  });
  assert.deepEqual(result.value, { relevant: false, target_ids: [] });
  assert.equal(result.confidence, 1);
  assert.equal(result.reason_code, 'no_visible_targets');
  assert.equal(calls, 0);
});

test('Haiku makes zero data retention explicit and rejects malformed vectors', async () => {
  let request;
  const judge = new HaikuJudge({
    zeroDataRetention: true,
    generateTextFn: async input => {
      request = input;
      return { output: { probabilities: [0.7] }, usage: {}, providerMetadata: {} };
    },
  });
  await judge.evaluate({ event, stateRefs: [], question: { family: 'durable_cross_ticket_value', text: 'Is this durable?' } });
  assert.deepEqual(request.providerOptions, { gateway: { sort: 'latency', zeroDataRetention: true } });

  const malformed = new HaikuJudge({ generateTextFn: async () => ({
    output: { probabilities: [0.9] }, usage: {}, providerMetadata: {},
  }) });
  await assert.rejects(() => malformed.evaluate({
    event, stateRefs, question: { family: 'acceptance_relevance', text: 'Is this evidence?' },
  }), /invalid probability vector/);
});
