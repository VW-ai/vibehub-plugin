import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { graphHash } from '../../../src/application/graph/graph-inputs.mjs';
import { queryFixture, QUERY_ACTIONS, capture } from '../../../test/support/query-fixture.mjs';

export const QUERY_JEV_CASES = Object.freeze([
  { id: 'query-relevant', text: 'Implement PostgreSQL migration tracking for durable project records.', expected: true },
  { id: 'query-unrelated', text: 'Make the decorative header purple and enlarge its logo.', expected: false },
]);
const selectedText = 'decision\nUse PostgreSQL as the durable primary store.\n\nPersist durable project records in PostgreSQL.';
const check = condition => { if (!condition) throw new Error('Synthetic Query JEV check failed'); };

/** Exactly two approved synthetic sends on a successful opt-in run. */
export async function checkQueryJev(apiKey) {
  check(typeof apiKey === 'string' && apiKey.length > 0);
  const cleanup = [], originalFetch = globalThis.fetch, bodies = []; let calls = 0, active = null;
  try {
    const f = await queryFixture({ after(fn) { cleanup.push(fn); } }, { timeout_ms: 15000, max_attempts: 1,
      max_tokens: 10000, max_cost_microunits: 100000 });
    await f.providerSettings.replaceCredential(f.configuration.settings_project_id, 'typesafe', apiKey);
    const canaries = [f.root, f.source.registration_id, f.supportSource.registration_id,
      f.execution.worktree_id, 'Explicit synthetic create', 'Synthetic captured decision support.', apiKey];
    globalThis.fetch = (url, options) => {
      check(url === 'https://api.typesafe.ai/v1/systemone' && active !== null && calls < 2);
      const body = JSON.parse(options.body), serialized = JSON.stringify(body);
      check(body.model === 'jev-latest' && body.state.event.text === active.text);
      check(body.state.candidates.length === 1 && body.state.candidates[0].text === selectedText);
      check(canaries.every(canary => !serialized.includes(canary)));
      bodies.push(graphHash(body)); calls++; return originalFetch(url, options);
    };
    const results = [];
    for (const [index, entry] of QUERY_JEV_CASES.entries()) {
      Object.assign(f, f.issue({ actions: QUERY_ACTIONS }));
      f.judgeEvent = capture(f, f.source, { sequence: index + 1, key: `query-jev-event-${index + 1}`,
        objectId: `query-jev-input-${index + 1}`, text: entry.text });
      const engine = f.makeQueryEngine(f.runtime), baseRequest = f.queryRequest({ request_id: `query-jev-${entry.id}` });
      const baseline = await engine.query(f.context, baseRequest), before = calls, started = performance.now(); active = entry;
      const result = await engine.query(f.context, { ...baseRequest, request_id: `query-jev-ranked-${entry.id}`, judge: f.queryJudge() });
      active = null; const variant = result.rank_trace.variants.find(item => item.ref.entity_id === f.target.entity_id);
      const baseVariant = baseline.rank_trace.variants.find(item => item.ref.entity_id === f.target.entity_id);
      const contribution = variant.factors.judge.contribution, observed = contribution > 0 ? true : contribution < 0 ? false : null;
      results.push({ id: entry.id, expected_relevant: entry.expected, observed_relevant: observed,
        matched: observed === entry.expected, provider_sends: calls - before, elapsed_ms: Math.round(performance.now() - started),
        input_hash: result.rank_trace.replay_input.judge?.result.input_hash ?? null,
        result_digest: result.rank_trace.replay_input.judge?.result.result_digest ?? null,
        selection_digest: result.rank_trace.replay_input.judge?.result.selection
          ? graphHash(result.rank_trace.replay_input.judge.result.selection) : null,
        baseline_score: baseVariant.score, ranked_score: variant.score, judge_contribution: contribution,
        reason: variant.factors.judge.reason,
        model: result.rank_trace.replay_input.judge?.result.decision?.model ?? null,
        model_latency_ms: result.rank_trace.replay_input.judge?.result.decision?.latency_ms ?? null,
        usage: result.rank_trace.replay_input.judge?.result.usage ?? null });
    }
    const matched = results.filter(result => result.matched).length;
    return { schema_version: 1, dataset: 'synthetic-selected-window-query-jev-v1', measured_at: new Date().toISOString(),
      provider: 'typesafe-direct', transport_calls: calls, labelled_cases: results.length, matched,
      passed: calls === 2 && matched === 2 && results.every(result => result.provider_sends === 1),
      max_attempts_per_invocation: 1, pagination_provider_sends: 0, global_recall: 'unknown',
      embeddings: 'not_configured', canonical_promotion: false, query_effects: false,
      structural_canaries_excluded: true, synthetic_body_digests: bodies, results };
  } finally {
    globalThis.fetch = originalFetch;
    for (const fn of cleanup.reverse()) await fn();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.env.TYPESAFE_API_KEY) { console.error('Set TYPESAFE_API_KEY locally; do not paste or print it.'); process.exitCode = 1; }
  else {
    try { const report = await checkQueryJev(process.env.TYPESAFE_API_KEY); console.log(JSON.stringify(report, null, 2)); if (!report.passed) process.exitCode = 1; }
    catch { console.error('Synthetic Query JEV check failed. No credential, headers, source text or raw provider error is printed.'); process.exitCode = 1; }
  }
}
