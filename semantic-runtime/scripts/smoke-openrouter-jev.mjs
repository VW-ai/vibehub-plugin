import { OpenRouterJevJudge } from '../src/adapters/providers/openrouter-jev-judge.mjs';
import { validateDecision } from '../src/domain/shared/contracts.mjs';

const input = {
  event: { type: 'HUMAN_DECISION', timestamp: '2026-09-22T00:00:00.000Z',
    payload: { text: 'Decision: preserve the stable refresh-token schema across releases.' } },
  stateRefs: [],
  question: { family: 'durable_cross_ticket_value', text: 'Does this event contain knowledge useful beyond this task?' },
};
if (!process.env.OPENROUTER_API_KEY) {
  console.error('Set OPENROUTER_API_KEY locally in the process environment; never paste it into chat.');
  process.exitCode = 1;
} else {
  try {
    const judge = new OpenRouterJevJudge({ apiKey: process.env.OPENROUTER_API_KEY });
    const result = await judge.evaluate(input);
    console.log(JSON.stringify({ ok: true, decision: validateDecision(result, input), telemetry: result.telemetry }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error.code ?? 'openrouter_smoke_failed', status: error.statusCode ?? null }));
    process.exitCode = 1;
  }
}
