import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { graphHash, graphEqual } from '../src/application/graph/graph-inputs.mjs';
import { contextJudgeFixture, CONTEXT_JUDGE_ACTIONS, capture, publish, adoption, rows, head } from '../test/helpers/context-judge-fixture.mjs';

export const CONTEXT_JEV_CASES = Object.freeze([
  { id: 'own-relevant', branch: 'A', text: 'The durable project store will use PostgreSQL; add its connection pooling and transaction support.', expected: true },
  { id: 'own-unrelated', branch: 'A', text: 'The presentation header now uses a purple background and a larger decorative logo.', expected: false },
  { id: 'adopted-after-source-supersession', branch: 'B', text: 'Add PostgreSQL migration tracking for the durable project records in this exploration.', expected: true },
  { id: 'inflight-source-revocation', branch: 'B', text: 'Review PostgreSQL transaction handling for durable project record updates.' },
]);
const targetText = 'decision\nUse PostgreSQL as the durable primary store.\n\nPersist durable project records in PostgreSQL.';
const check = ok => { if (!ok) throw new Error('Synthetic Context Judge check failed'); };

/** Exactly four approved synthetic sends on a successful run; never called by normal verification. */
export async function checkContextJev(apiKey) {
  check(typeof apiKey === 'string' && apiKey.length > 0);
  const cleanup = [], originalFetch = globalThis.fetch; let calls = 0, activeCase = null, revoked = false,
    fourthTransportReturned = false, afterRevocation = null;
  try {
    const f = await contextJudgeFixture({ after(fn) { cleanup.push(fn); } }, { timeout_ms: 15000, max_attempts: 1,
      max_tokens: 10000, max_cost_microunits: 100000 });
    await f.providerSettings.replaceCredential(f.configuration.settings_project_id, 'typesafe', apiKey);
    const canaries = [f.root, f.source.registration_id, f.supportSource.registration_id, f.execution.worktree_id,
      f.executionB.worktree_id, 'Explicit synthetic create', 'Synthetic captured decision support.', apiKey];
    const observedBodies = [];
    globalThis.fetch = (url, options) => {
      check(url === 'https://api.typesafe.ai/v1/systemone' && activeCase !== null && calls < 4);
      const body = JSON.parse(options.body), serialized = JSON.stringify(body);
      check(body.model === 'jev-latest' && body.state.event.text === activeCase.text);
      check(Object.keys(body.state).sort().join(',') === 'candidates,event');
      check(body.state.candidates.length === 1 && body.state.candidates[0].text === targetText
        && /^target-[a-f0-9]{64}$/.test(body.state.candidates[0].id));
      check(canaries.every(canary => !serialized.includes(canary)));
      observedBodies.push(graphHash(body)); calls++;
      const pending = originalFetch(url, options);
      // Entry to this actual fetch is the measured boundary. It cannot prove
      // when the remote endpoint receives bytes or recall already-sent input.
      const fourth = activeCase.id === 'inflight-source-revocation';
      if (fourth) {
        const source = f.ingress.getRegistration(f.context, { registration_id: f.supportSource.registration_id });
        f.ingress.updateSourceAccess(f.context, { registration_id: source.registration_id, expectedVersion: source.version,
          access: { ...source.registration.access, allowed_principal_ids: [] } });
        revoked = true; afterRevocation = rows(f);
      }
      return Promise.resolve(pending).then(response => { if (fourth) fourthTransportReturned = true; return response; });
    };
    const results = []; let cacheHits = 0, sourceUnchangedByAdoption = false, aSupersededBCurrent = false;
    for (const [index, entry] of CONTEXT_JEV_CASES.entries()) {
      Object.assign(f, f.issue({ actions: CONTEXT_JUDGE_ACTIONS }));
      if (index === 2) {
        const sourceHead = f.graph.getHead(f.context, { generation_id: f.a.generation_id });
        const adopted = f.contexts.adopt(f.context, adoption(f, { source: f.targetResult, key: 'synthetic-context-judge-adoption' }));
        sourceUnchangedByAdoption = graphEqual(sourceHead, f.graph.getHead(f.context, { generation_id: f.a.generation_id }));
        const superseded = publish(f, 'synthetic-source-supersession', { base: f.target, status: 'superseded', change: 'supersede', events: [f.supportEvent] });
        f.target = adopted.revision; f.binding = f.b;
        const selectedA = f.contexts.resolve(f.context, { exploration_id: f.a.exploration_id, at: head(f, f.a), address: superseded.revision, mode: 'current' }).local.item;
        const selectedB = f.contexts.resolve(f.context, { exploration_id: f.b.exploration_id, at: head(f, f.b), address: adopted.revision, mode: 'current' }).local.item;
        aSupersededBCurrent = selectedA?.projection.status === 'superseded' && selectedB?.historical_role === 'head'
          && selectedB.projection.status === 'candidate' && graphEqual(selectedB.ref, adopted.revision);
        check(sourceUnchangedByAdoption && aSupersededBCurrent);
      }
      f.judgeEvent = capture(f, f.source, { sequence: index + 1, key: `context-jev-event-${index + 1}`,
        objectId: `context-jev-input-${index + 1}`, text: entry.text });
      const request = f.request({ invocation_id: `context-jev-${index + 1}-${entry.id}` });
      const beforeRows = rows(f), beforeCalls = calls, started = performance.now(); activeCase = entry;
      const result = await f.runtime.evaluateContext(f.context, request); activeCase = null;
      check(graphEqual(rows(f), index === 3 && afterRevocation ? afterRevocation : beforeRows));
      if (index < 3 && result.status === 'decision') {
        const hit = await f.runtime.evaluateContext(f.context, request);
        check(hit.cache === 'hit' && hit.result_digest === result.result_digest && calls === beforeCalls + 1); cacheHits++;
      }
      const basic = { id: entry.id, branch: entry.branch, status: result.status, reason_code: result.reason_code,
        provider_sends: calls - beforeCalls, attempts: result.attempts.length,
        input_hash: result.input_hash, result_digest: result.result_digest,
        selection_digest: result.selection ? graphHash(result.selection) : null,
        selected_ref: request.target_refs[0], elapsed_ms: Math.round(performance.now() - started),
        reserved_usage: result.usage.reserved, observed_usage: result.usage.observed };
      if (index < 3) results.push({ ...basic, expected_relevant: entry.expected, observed_relevant: result.decision?.value.relevant ?? null,
        matched: result.status === 'decision' && result.decision.value.relevant === entry.expected
          && graphEqual(result.target_refs, entry.expected ? request.target_refs : []),
        confidence: result.decision?.confidence ?? null, model: result.decision?.model ?? null,
        model_latency_ms: result.decision ? Math.round(result.decision.latency_ms) : null });
      else {
        const providerCompleted = fourthTransportReturned && result.attempts.length === 1 && result.attempts[0].status === 'completed';
        const discarded = providerCompleted && result.status === 'refused' && result.decision === null && result.target_refs.length === 0;
        const retry = await f.runtime.evaluateContext(f.context, request);
        check(retry.status === 'refused' && retry.decision === null && retry.cache === 'miss' && calls === beforeCalls + 1);
        results.push({ ...basic, fetch_boundary_entered: revoked, provider_completed: providerCompleted,
          completed_response_discarded: discarded, no_cached_success: retry.cache === 'miss', evaluation_effects: false });
      }
    }
    const fourth = results[3], matched = results.slice(0, 3).filter(item => item.matched).length;
    return { schema_version: 1, dataset: 'synthetic-typed-context-judge-four-v1', measured_at: new Date().toISOString(),
      provider: 'typesafe-direct', transport_calls: calls, labelled_cases: 3, matched,
      status: calls === 4 && fourth.completed_response_discarded ? 'completed' : 'incomplete',
      passed: calls === 4 && matched === 3 && fourth.completed_response_discarded && sourceUnchangedByAdoption && aSupersededBCurrent,
      fresh_opaque_contexts: 4, distinct_invocation_ids: 4, max_attempts_per_invocation: 1, completed_cache_hits: cacheHits,
      source_graph_unchanged_by_adoption: sourceUnchangedByAdoption, a_superseded_b_current: aSupersededBCurrent,
      structural_canaries_excluded: true, synthetic_body_digests: observedBodies,
      governance_evaluated: false, shared_material_sent: false, canonical_promotion: false, ingress_acknowledged: false,
      evaluation_effects: false, results };
  } finally {
    globalThis.fetch = originalFetch;
    for (const fn of cleanup.reverse()) await fn();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.env.TYPESAFE_API_KEY) { console.error('Set TYPESAFE_API_KEY locally; do not paste or print it.'); process.exitCode = 1; }
  else {
    try { const report = await checkContextJev(process.env.TYPESAFE_API_KEY); console.log(JSON.stringify(report, null, 2)); if (!report.passed) process.exitCode = 1; }
    catch { console.error('Synthetic Context JEV check failed. No credential, headers, source text or raw provider error is printed.'); process.exitCode = 1; }
  }
}
