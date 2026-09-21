import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TypeSafeJevJudge } from '../src/adapters/typesafe-jev-judge.mjs';
import { validateDecision } from '../src/core/contracts.mjs';

const event = {
  type: 'HUMAN_DECISION', timestamp: '2026-09-20T00:00:00.000Z',
  payload: { text: 'Preserve the refresh token schema.' },
};
const stateRefs = [
  { id: 'acceptance-schema', type: 'acceptance', text: 'Token schema stays stable.' },
  { id: 'acceptance-ui', type: 'acceptance', text: 'Login renders correctly.' },
];

test('direct TypeSafe JEV maps a batched noul response into the shared contract', async () => {
  let request;
  let options;
  const signal = new AbortController().signal;
  const judge = new TypeSafeJevJudge({ client: { async systemOne(nextRequest, nextOptions) {
    request = nextRequest;
    options = nextOptions;
    return {
      model: 'jev-1.13.0',
      answers: {
        target_0: { type: 'noul', noul: 0.94 },
        target_1: { type: 'noul', noul: 0.12 },
      },
      usage: { input_tokens: 120, output_tokens: 16 },
    };
  } } });
  const input = { event, stateRefs, question: { family: 'acceptance_relevance', text: 'Does this support the acceptance?' } };
  const result = await judge.evaluate(input, { signal });
  assert.deepEqual(result.value, { relevant: true, target_ids: ['acceptance-schema'] });
  assert.equal(result.confidence, 0.94);
  assert.equal(result.model, 'jev-1.13.0');
  assert.equal(result.telemetry.total_tokens, 136);
  assert.equal(request.model, 'jev-latest');
  assert.equal(request.state.candidates.length, 2);
  assert.deepEqual(Object.keys(request.questions), ['target_0', 'target_1']);
  assert.ok(Object.values(request.questions).every(question => question.type === 'noul'));
  assert.equal(options.signal, signal);
  assert.deepEqual(options.retry, { maxRetries: 0 });
  assert.deepEqual(validateDecision(result, input).value, result.value);
});

test('direct TypeSafe JEV maps a non-relational noul and validates it', async () => {
  const judge = new TypeSafeJevJudge({ client: { async systemOne() {
    return {
      model: 'jev-1.13.0', answers: { relevant: { type: 'noul', noul: 0.2 } },
      usage: { input_tokens: 10, output_tokens: 2 },
    };
  } } });
  const result = await judge.evaluate({
    event, stateRefs: [], question: { family: 'durable_cross_ticket_value', text: 'Is this durable?' },
  });
  assert.deepEqual(result.value, { relevant: false, target_ids: [] });
  assert.equal(result.confidence, 0.8);
  assert.equal(result.reason_code, 'jev_direct_negative');

  const malformed = new TypeSafeJevJudge({ client: { async systemOne() {
    return { model: 'jev', answers: { relevant: { type: 'noul', noul: 2 } }, usage: {} };
  } } });
  await assert.rejects(() => malformed.evaluate({
    event, stateRefs: [], question: { family: 'durable_cross_ticket_value', text: 'Is this durable?' },
  }), /invalid noul answer/);
});

test('direct TypeSafe JEV avoids a request for empty relational state', async () => {
  let calls = 0;
  const judge = new TypeSafeJevJudge({ client: { async systemOne() { calls++; } } });
  const result = await judge.evaluate({
    event, stateRefs: [], question: { family: 'context_relevance', text: 'Which context is relevant?' },
  });
  assert.equal(calls, 0);
  assert.deepEqual(result.value, { relevant: false, target_ids: [] });
  assert.equal(result.telemetry.total_tokens, 0);
});

test('direct TypeSafe JEV enforces its target budget', async () => {
  const judge = new TypeSafeJevJudge({ client: { async systemOne() {} }, maxTargets: 1 });
  await assert.rejects(() => judge.evaluate({
    event, stateRefs, question: { family: 'acceptance_relevance', text: 'Is this evidence?' },
  }), /target budget exceeded/);
});
