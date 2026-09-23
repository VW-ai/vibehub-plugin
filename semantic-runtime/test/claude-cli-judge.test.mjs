import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClaudeCliJudge } from '../src/adapters/providers/claude-cli-judge.mjs';
import { validateDecision } from '../src/domain/shared/contracts.mjs';

const event = {
  type: 'HUMAN_DECISION', timestamp: '2026-09-20T00:00:00.000Z',
  payload: { text: 'Preserve the refresh token schema.' },
};
const stateRefs = [
  { id: 'acceptance-schema', type: 'acceptance', text: 'Token schema stays stable.' },
  { id: 'acceptance-ui', type: 'acceptance', text: 'Login renders correctly.' },
];

test('Claude CLI Haiku uses the shared prompt/schema and returns a bounded decision', async () => {
  let request;
  const signal = new AbortController().signal;
  const judge = new ClaudeCliJudge({ runFn: async input => {
    request = input;
    return {
      is_error: false,
      subtype: 'success',
      structured_output: { probabilities: [0.91] },
      total_cost_usd: 0.004,
      usage: { input_tokens: 30, output_tokens: 4 },
    };
  } });
  const input = { event, stateRefs: [], question: { family: 'durable_cross_ticket_value', text: 'Is this durable?' } };
  const result = await judge.evaluate(input, { signal });
  assert.equal(request.model, 'claude-haiku-4-5-20251001');
  assert.equal(request.signal, signal);
  assert.equal(request.schema.properties.probabilities.minItems, 1);
  assert.equal(JSON.parse(request.prompt).state.event.text, event.payload.text);
  assert.deepEqual(result.value, { relevant: true, target_ids: [] });
  assert.equal(result.confidence, 0.91);
  assert.equal(result.telemetry.final_provider, 'claude-cli');
  assert.equal(result.telemetry.cost_usd, 0.004);
  assert.equal(result.telemetry.total_tokens, 34);
  assert.deepEqual(validateDecision(result, input).value, result.value);
});

test('Claude CLI Haiku maps relational slots in candidate order and validates cardinality', async () => {
  const judge = new ClaudeCliJudge({ runFn: async () => ({
    is_error: false, subtype: 'success', structured_output: { probabilities: [0.88, 0.15] }, usage: {},
  }) });
  const input = { event, stateRefs, question: { family: 'acceptance_relevance', text: 'Does this support acceptance?' } };
  const result = await judge.evaluate(input);
  assert.deepEqual(result.value, { relevant: true, target_ids: ['acceptance-schema'] });
  assert.equal(result.confidence, 0.88);

  const malformed = new ClaudeCliJudge({ runFn: async () => ({
    is_error: false, subtype: 'success', structured_output: { probabilities: [0.88] }, usage: {},
  }) });
  await assert.rejects(() => malformed.evaluate(input), /invalid probability vector/);
});

test('Claude CLI Haiku avoids spawning for empty relational state', async () => {
  let calls = 0;
  const judge = new ClaudeCliJudge({ runFn: async () => { calls++; } });
  const result = await judge.evaluate({
    event, stateRefs: [], question: { family: 'context_relevance', text: 'Which context is relevant?' },
  });
  assert.deepEqual(result.value, { relevant: false, target_ids: [] });
  assert.equal(calls, 0);
});
