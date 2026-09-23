import { validateDecision } from '../src/domain/shared/contracts.mjs';
import { ResilientJudge } from '../src/adapters/providers/resilient-judge.mjs';
import { TypeSafeJevJudge } from '../src/adapters/providers/typesafe-jev-judge.mjs';

if (!process.env.TYPESAFE_API_KEY) throw new Error('TYPESAFE_API_KEY is required');

const input = {
  event: {
    schema_version: 1, tenant_id: 'smoke', project_id: 'jev', event_id: 'synthetic-direct-decision',
    type: 'HUMAN_DECISION', timestamp: '2026-09-21T00:00:00.000Z',
    source: { provider: 'synthetic', ref: 'synthetic://typesafe-direct-smoke' },
    payload_ref: 'synthetic://typesafe-direct-smoke/payload',
    payload: { text: 'Decision: preserve the stable refresh-token schema across releases.' },
    provenance: {}, acl: { visibility: 'project', sensitivity: 'INTERNAL' }, impact: 'normal',
  },
  stateRefs: [],
  question: { family: 'durable_cross_ticket_value', text: 'Does this event contain knowledge useful beyond this task?' },
};

try {
  const judge = new ResilientJudge(new TypeSafeJevJudge(), {
    minIntervalMs: 0, maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 8_000,
  });
  const decision = validateDecision(await judge.evaluate(input), input);
  console.log(JSON.stringify({ ok: true, decision, operational: judge.snapshot() }, null, 2));
} catch {
  console.error(JSON.stringify({ ok: false, error: 'TypeSafe direct JEV smoke failed' }));
  process.exitCode = 1;
}
