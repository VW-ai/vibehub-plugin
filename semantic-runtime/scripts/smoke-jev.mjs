import { validateDecision } from '../src/core/contracts.mjs';
import { JevJudge } from '../src/adapters/jev-judge.mjs';

if (!process.env.AI_GATEWAY_API_KEY) throw new Error('AI_GATEWAY_API_KEY is required');

const input = {
  event: {
    schema_version: 1,
    tenant_id: 'smoke',
    project_id: 'jev',
    event_id: 'synthetic-decision',
    type: 'HUMAN_DECISION',
    timestamp: '2026-09-20T00:00:00.000Z',
    source: { provider: 'synthetic', ref: 'synthetic://jev-smoke' },
    payload_ref: 'synthetic://jev-smoke/payload',
    payload: { text: 'Decision: preserve the stable refresh-token schema across releases.' },
    provenance: {},
    acl: { visibility: 'project', sensitivity: 'INTERNAL' },
    impact: 'normal',
  },
  stateRefs: [],
  question: {
    family: 'durable_cross_ticket_value',
    text: 'Does this event contain knowledge useful beyond this task?',
  },
};

const decision = validateDecision(await new JevJudge().evaluate(input), input);
console.log(JSON.stringify({ ok: true, decision }, null, 2));
