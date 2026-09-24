import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LocalJudgeRuntime, ProviderSettings } from '../../../src/index.mjs';
import { graphEqual } from '../../../src/application/graph/graph-inputs.mjs';
import { fixture, adoption, ADOPTION_ACTIONS } from '../../../test/support/adoption-fixture.mjs';
import { mutation, assertion, capture, SCOPE, rows } from '../../../test/support/exploration-fixture.mjs';
import { JUDGE_ACTIONS } from '../../../test/support/judge-fixture.mjs';
import { judgeArtifact } from '../../../test/support/judge-runtime-fixture.mjs';
import { cases } from './check-jev-synthetic.mjs';

const selected = cases.filter(row => row[1] === 'context_relevance');
const allowed = new Set(selected.flatMap(row => [row[2], ...row[3].map(target => target.text)]));
const check = value => { if (!value) throw new Error('Synthetic adoption check failed'); };

/** Four real selected-Judge calls on fixed public synthetic text, after an actual A -> B adoption. */
export async function checkAdoptionJev(apiKey) {
  check(typeof apiKey === 'string' && apiKey.length > 0);
  const cleanup = [], fetch = globalThis.fetch;
  let settings, sends = 0;
  try {
    const f = fixture({ after(fn) { cleanup.push(fn); } });
    f.context = f.issue({ actions: [...new Set([...ADOPTION_ACTIONS, ...JUDGE_ACTIONS])] }).context;
    const events = selected.map((entry, index) => capture(f, f.source, { sequence: index + 1,
      key: `adoption-question-${index}`, text: entry[2], objectId: `adoption-question-${index}` }));
    const targetText = selected[0][3][0].text;
    const support = capture(f, f.source, { sequence: 3, key: 'adoption-target', text: targetText, objectId: 'adoption-target' });
    const source = f.explorations.mutate(f.context, mutation(f, f.a, 'judge-adoption-target', {
      expected_graph: f.original.receipt.next_graph, operation: { kind: 'assert', assertion: assertion(f, support, 'judge-adoption-target', {
        entity_id: 'judge-adoption-target', content: { semantic_type: 'judge-target', data: {
          schema_version: 1, kind: 'judge_target', target_kind: 'context', text: targetText } } }) } }));
    const secrets = new Map();
    settings = new ProviderSettings({ filePath: join(f.root, 'adoption-settings.sqlite'), secretStore: {
      async put(ref, value) { secrets.set(ref, value); }, async remove(ref) { secrets.delete(ref); },
      async status(ref) { return secrets.has(ref) ? 'configured' : 'missing'; },
      async use(ref, fn) { check(secrets.has(ref)); return fn(secrets.get(ref)); },
    } });
    const project = 'synthetic-adoption-check';
    await settings.configure(project, { primary: { provider: 'typesafe', model: 'jev-latest', capability: 'semantic-judge-v0' },
      fallbacks: [], timeout_ms: 15000, max_attempts: 1 });
    await settings.replaceCredential(project, 'typesafe', apiKey);
    const runtime = new LocalJudgeRuntime({ store: f.store, authority: f.authority, provider_settings: settings, canonical_reader: f.config,
      configuration: { schema_version: 1, scope: SCOPE, settings_project_id: project,
        artifact: judgeArtifact({ family: 'context_relevance', question_text: 'Does this event change or directly relate to this existing context?',
          threshold: 0.8, timeout_ms: 15000, max_attempts: 1, max_tokens: 10000, max_cost_microunits: 100000 }),
        egress_policy: { policy_id: 'synthetic-adoption-only', revision: '1', max_sensitivity: 'INTERNAL', allowed_providers: ['typesafe'],
          sources: [{ registration_id: f.source.registration_id, local_only: false, allowed_providers: ['typesafe'], text_policy: 'selected-fields' }] } } });
    const request = (binding, execution, at, target, event, name) => ({ invocation_id: name, node_id: 'judge', epoch: f.epoch, execution,
      exploration_id: binding.exploration_id, execution_workspace_id: binding.execution_workspace_id,
      expected_binding_version: binding.binding_version, expected_catalog_version: f.registry.get(f.context).version,
      expected_project_selection_version: null, at, event_id: event.event_id, target_refs: [target],
      expected_source_fence: f.feed.head(f.context).sequence });
    globalThis.fetch = (url, options) => {
      check(url === 'https://api.typesafe.ai/v1/systemone' && ++sends <= 4);
      const body = JSON.parse(options.body);
      check(body.model === 'jev-latest' && allowed.has(body.state.event.text));
      check(Object.keys(body.state).sort().join(',') === 'candidates,event');
      check(body.state.candidates.length === 1 && body.state.candidates.every(item => item.text === targetText && /^target-[a-f0-9]{64}$/.test(item.id)));
      return fetch(url, options);
    };
    let foreignRefused = false;
    try { const foreign = await runtime.evaluate(f.context,
      request(f.b, f.executionB, f.b.graph_revision, source.revision, events[0], 'foreign-before-adoption'));
      foreignRefused = foreign.status === 'refused';
    } catch (error) { foreignRefused = error?.code === 'invalid_judge_input'; }
    check(foreignRefused && sends === 0);
    const beforeHeadA = f.graph.getHead(f.context, { generation_id: f.a.generation_id });
    const adopted = f.explorations.adopt(f.context, adoption(f, { source }));
    check(adopted.status === 'applied' && sends === 0 && graphEqual(beforeHeadA, f.graph.getHead(f.context, { generation_id: f.a.generation_id })));
    const results = [];
    for (const [label, binding, execution, published] of [['A', f.a, f.execution, source], ['B', f.b, f.executionB, adopted]]) {
      for (let index = 0; index < selected.length; index++) {
        const entry = selected[index], input = request(binding, execution, published.receipt.next_graph, published.revision, events[index], `${label}-${entry[0]}`);
        const before = rows(f), result = await runtime.evaluate(f.context, input);
        check(graphEqual(before, rows(f)));
        results.push({ branch: label, case: entry[0], status: result.status, reason_code: result.reason_code,
          matched: result.status === 'decision' && result.decision.value.relevant === entry[4]
            && graphEqual(result.target_refs, entry[4] ? [published.revision] : []),
          relevant: result.decision?.value.relevant ?? null, confidence: result.decision?.confidence ?? null,
          model: result.decision?.model ?? null, latency_ms: result.decision ? Math.round(result.decision.latency_ms) : null,
          attempts: result.attempts.length, input_hash: result.input_hash, result_digest: result.result_digest });
      }
    }
    const registration = f.ingress.getRegistration(f.context, { registration_id: f.source.registration_id });
    f.ingress.updateSourceAccess(f.context, { registration_id: registration.registration_id, expectedVersion: registration.version,
      access: { ...registration.registration.access, allowed_principal_ids: [] } });
    const denied = await runtime.evaluate(f.context, request(f.b, f.executionB, adopted.receipt.next_graph, adopted.revision, events[0], 'revoked-after-adoption'));
    check(denied.status === 'refused' && sends === 4);
    return { schema_version: 1, dataset: 'synthetic-adoption-judge-four-v1', measured_at: new Date().toISOString(),
      provider: 'typesafe-direct', transport_calls: sends, matched: results.filter(r => r.matched).length, total: results.length,
      before_adoption_foreign_target_refused: true, adoption_model_calls: 0, source_graph_unchanged: true,
      destination_candidates: 1, source_revocation_refused_before_send: true, canonical_promotion: false, results };
  } finally {
    globalThis.fetch = fetch; await settings?.close();
    for (const fn of cleanup.reverse()) await fn();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.env.TYPESAFE_API_KEY) { console.error('Set TYPESAFE_API_KEY locally; do not paste or print it.'); process.exitCode = 1; }
  else {
    try { const report = await checkAdoptionJev(process.env.TYPESAFE_API_KEY); console.log(JSON.stringify(report, null, 2));
      if (report.matched !== report.total) process.exitCode = 1;
    } catch { console.error('JEV adoption check failed. No source, credential or raw provider error is printed.'); process.exitCode = 1; }
  }
}
