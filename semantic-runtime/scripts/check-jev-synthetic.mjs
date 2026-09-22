import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { TypeSafeJevJudge } from '../src/adapters/typesafe-jev-judge.mjs';
import { ResilientJudge } from '../src/adapters/resilient-judge.mjs';
import { validateDecision } from '../src/core/contracts.mjs';

// Labels stay local. Only event text and point-in-time target text enter the Judge.
export const cases = [
  ['durable-yes', 'durable_cross_ticket_value', 'Decision: all future schema migrations must preserve existing refresh tokens.', [], true],
  ['durable-no', 'durable_cross_ticket_value', 'I am taking a short coffee break now.', [], false],
  ['work-yes', 'independently_schedulable_work', 'Create a separate task to add an export endpoint with a CSV download and integration tests.', [], true],
  ['work-no', 'independently_schedulable_work', 'Thanks, that explanation answered my question.', [], false],
  ['acceptance-yes', 'acceptance_relevance', 'Added the sign-out endpoint and verified that it revokes every active refresh token.',
    [{ id: 'logout', text: 'Signing out must revoke every active refresh token.' }], true],
  ['acceptance-no', 'acceptance_relevance', 'Changed the footer icon from blue to green.',
    [{ id: 'logout', text: 'Signing out must revoke every active refresh token.' }], false],
  ['context-yes', 'context_relevance', 'We changed the login design: use device authorization rather than copying a long-lived API key.',
    [{ id: 'login', text: 'Login currently uses a copied long-lived API key.' }], true],
  ['context-no', 'context_relevance', 'Use a larger margin around the documentation footer.',
    [{ id: 'login', text: 'Login currently uses a copied long-lived API key.' }], false],
];
const questions = {
  durable_cross_ticket_value: 'Does this event contain project knowledge useful beyond the current task?',
  independently_schedulable_work: 'Does this event propose concrete work that can be a separately scheduled task?',
  acceptance_relevance: 'Does this event provide relevant evidence or change information for this acceptance criterion?',
  context_relevance: 'Does this event change or directly relate to this existing context?',
};

export async function checkSyntheticJev(judge, { timeoutMs = 15_000 } = {}) {
  const rows = [];
  for (const [id, family, text, stateRefs, expected] of cases) {
    const input = { event: { type: 'AGENT_MESSAGE', timestamp: '2026-09-22T00:00:00.000Z', payload: { text } },
      stateRefs, question: { family, text: questions[family] } };
    const start = performance.now();
    try {
      const raw = await judge.evaluate(input, { signal: AbortSignal.timeout(timeoutMs) });
      const decision = validateDecision(raw, input);
      rows.push({ id, family, expected, status: 'ok', matched: decision.value.relevant === expected,
        relevant: decision.value.relevant, target_ids: decision.value.target_ids, confidence: decision.confidence,
        model: decision.model, latency_ms: Math.round(performance.now() - start) });
    } catch {
      rows.push({ id, family, expected, status: 'failed', latency_ms: Math.round(performance.now() - start) });
    }
  }
  return { schema_version: 1, dataset: 'synthetic-eight-v1', measured_at: new Date().toISOString(),
    completed: rows.filter(r => r.status === 'ok').length,
    matched: rows.filter(r => r.matched).length, total: rows.length, rows };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.env.TYPESAFE_API_KEY) {
    console.error('Set TYPESAFE_API_KEY locally; do not paste or print it.'); process.exitCode = 1;
  } else {
    try {
      const judge = new ResilientJudge(new TypeSafeJevJudge(), { maxAttempts: 2, minIntervalMs: 500, baseDelayMs: 500, maxDelayMs: 2_000 });
      const report = await checkSyntheticJev(judge);
      console.log(JSON.stringify({ ...report, operational: judge.snapshot() }, null, 2));
      if (report.completed !== report.total) process.exitCode = 1;
    } catch { console.error('Synthetic JEV check failed. No raw provider error is printed.'); process.exitCode = 1; }
  }
}
