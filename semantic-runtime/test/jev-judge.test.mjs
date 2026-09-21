import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JevJudge } from '../src/adapters/jev-judge.mjs';
import { validateDecision } from '../src/core/contracts.mjs';

const event = {
  type: 'HUMAN_DECISION', timestamp: '2026-09-20T00:00:00.000Z',
  payload: { text: 'Preserve the refresh token schema.' },
};
const stateRefs = [
  { id: 'acceptance-schema', type: 'acceptance', text: 'Token schema stays stable.' },
  { id: 'acceptance-ui', type: 'acceptance', text: 'Login renders correctly.' },
];

test('JEV maps a boolean probability into a non-relational decision', async () => {
  let request;
  const signal = new AbortController().signal;
  const judge = new JevJudge({ evaluateFn: async input => {
    request = input;
    return { answers: { relevant: { type: 'boolean', probability: 0.91 } } };
  } });
  const input = { event, stateRefs: [], question: { family: 'durable_cross_ticket_value', text: 'Is this durable?' } };
  const result = await judge.evaluate(input, { signal });
  assert.deepEqual(result.value, { relevant: true, target_ids: [] });
  assert.equal(result.confidence, 0.91);
  assert.equal(result.reason_code, 'jev_positive');
  assert.equal(request.model, 'typesafe-ai/jev');
  assert.equal(request.abortSignal, signal);
  assert.equal(request.maxRetries, 0);
  assert.deepEqual(request.providerOptions, { gateway: { only: ['typesafe-ai'] } });
  assert.deepEqual(Object.keys(request.questions), ['relevant']);
  assert.equal(request.state.event.text, event.payload.text);
});

test('JEV makes zero data retention an explicit opt-in', async () => {
  let request;
  const judge = new JevJudge({
    zeroDataRetention: true,
    evaluateFn: async input => {
      request = input;
      return { answers: { relevant: { type: 'boolean', probability: 0.9 } } };
    },
  });
  await judge.evaluate({
    event, stateRefs: [], question: { family: 'durable_cross_ticket_value', text: 'Is this durable?' },
  });
  assert.deepEqual(request.providerOptions, {
    gateway: { only: ['typesafe-ai'], zeroDataRetention: true },
  });
  assert.equal(judge.descriptor.zero_data_retention, true);
});

test('JEV evaluates visible relational targets in one request', async () => {
  let request;
  const judge = new JevJudge({ evaluateFn: async input => {
    request = input;
    return { answers: {
      target_0: { type: 'boolean', probability: 0.94 },
      target_1: { type: 'boolean', probability: 0.12 },
    } };
  } });
  const input = { event, stateRefs, question: { family: 'acceptance_relevance', text: 'Does this support the acceptance?' } };
  const result = await judge.evaluate(input);
  assert.deepEqual(result.value, { relevant: true, target_ids: ['acceptance-schema'] });
  assert.equal(result.confidence, 0.94);
  assert.equal(request.state.candidates.length, 2);
  assert.deepEqual(Object.keys(request.questions), ['target_0', 'target_1']);
  assert.deepEqual(validateDecision({ ...result, latency_ms: 1 }, input).value, result.value);
});

test('JEV returns a deterministic negative when no relational targets are visible', async () => {
  let calls = 0;
  const judge = new JevJudge({ evaluateFn: async () => { calls += 1; } });
  const result = await judge.evaluate({
    event, stateRefs: [], question: { family: 'context_relevance', text: 'Which context is relevant?' },
  });
  assert.deepEqual(result.value, { relevant: false, target_ids: [] });
  assert.equal(result.confidence, 1);
  assert.equal(result.reason_code, 'no_visible_targets');
  assert.equal(calls, 0);
});

test('JEV reports confidence in the selected negative outcome', async () => {
  const judge = new JevJudge({ evaluateFn: async () => ({
    answers: { relevant: { type: 'boolean', probability: 0.2 } },
  }) });
  const result = await judge.evaluate({
    event, stateRefs: [], question: { family: 'independently_schedulable_work', text: 'Is there new work?' },
  });
  assert.equal(result.value.relevant, false);
  assert.equal(result.confidence, 0.8);
  assert.equal(result.reason_code, 'jev_negative');
});

test('JEV rejects malformed answers and an unbounded target set', async () => {
  const malformed = new JevJudge({ evaluateFn: async () => ({ answers: { relevant: { type: 'boolean', probability: 2 } } }) });
  await assert.rejects(() => malformed.evaluate({
    event, stateRefs: [], question: { family: 'durable_cross_ticket_value', text: 'Is this durable?' },
  }), /invalid boolean answer/);
  const bounded = new JevJudge({ evaluateFn: async () => ({ answers: {} }), maxTargets: 1 });
  await assert.rejects(() => bounded.evaluate({
    event, stateRefs, question: { family: 'acceptance_relevance', text: 'Is this evidence?' },
  }), /target budget exceeded/);
});
