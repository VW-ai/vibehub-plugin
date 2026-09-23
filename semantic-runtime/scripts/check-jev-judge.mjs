import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { LocalJudgeRuntime, ProviderSettings, DurableIngress } from '../src/index.mjs';
import { graphHash, graphEqual } from '../src/application/graph/graph-inputs.mjs';
import { cases } from './check-jev-synthetic.mjs';
import { fixture, bind, executionFor, git, SCOPE, register, mutation, assertion, rows } from '../test/helpers/exploration-fixture.mjs';
import { JUDGE_ACTIONS } from '../test/helpers/judge-fixture.mjs';
import { judgeArtifact } from '../test/helpers/judge-runtime-fixture.mjs';

const questions = {
  durable_cross_ticket_value: 'Does this event contain project knowledge useful beyond the current task?',
  independently_schedulable_work: 'Does this event propose concrete work that can be a separately scheduled task?',
  acceptance_relevance: 'Does this event provide relevant evidence or change information for this acceptance criterion?',
  context_relevance: 'Does this event change or directly relate to this existing context?',
};
const allowedTexts = new Set(cases.flatMap(entry => [entry[2], ...entry[3].map(ref => ref.text)]));
const check = condition => { if (!condition) throw new Error('Synthetic Judge service check failed'); };

/** Fixed synthetic nine-call check. Does not read user project/configuration/trace files. */
export async function checkJudgeJev(apiKey) {
  check(typeof apiKey === 'string' && apiKey.length > 0);
  const cleanup = [], originalFetch = globalThis.fetch;
  let settings, sends = 0, revoked = false, revokeOnSend = null;
  try {
    const f = fixture({ after(operation) { cleanup.push(operation); } });
    Object.assign(f, f.issue({ actions: JUDGE_ACTIONS }));
    f.ingress = new DurableIngress({ store: f.store, authority: f.authority,
      snapshotPolicy: ({ text }) => allowedTexts.has(text) ? text : null });
    const linked = join(f.root, 'synthetic-alternative');
    git(f.folder, 'worktree', 'add', '-b', 'synthetic-alternative', linked); f.refresh();
    const branches = [f.execution, executionFor(f, linked)].map((execution, index) => ({ label: index ? 'B' : 'A', execution,
      binding: bind(f, { key: `judge-bind-${index}`, execution }), sequence: 0,
      source: register(f, { partition: `judge-smoke-${index}`, execution }) }));
    branches.forEach(branch => { branch.head = branch.binding.graph_revision; });
    check(branches[0].binding.generation_id !== branches[1].binding.generation_id);

    // A disposable secure-store binding holds the explicitly supplied key only
    // in process memory. Runtime receives it solely via useCredential callback.
    const secrets = new Map();
    settings = new ProviderSettings({ filePath: join(f.root, 'synthetic-provider.sqlite'), secretStore: {
      async put(ref, value) { secrets.set(ref, value); }, async remove(ref) { secrets.delete(ref); },
      async status(ref) { return secrets.has(ref) ? 'configured' : 'missing'; },
      async use(ref, operation) { check(secrets.has(ref)); return operation(secrets.get(ref)); },
    } });
    const settingsProject = 'synthetic-judge-smoke';
    await settings.configure(settingsProject, { primary: { provider: 'typesafe', model: 'jev-latest', capability: 'semantic-judge-v0' },
      fallbacks: [], timeout_ms: 15000, max_attempts: 1 });
    await settings.replaceCredential(settingsProject, 'typesafe', apiKey);
    const runtimes = Object.fromEntries(Object.entries(questions).map(([family, question_text]) => [family,
      new LocalJudgeRuntime({ store: f.store, authority: f.authority, provider_settings: settings, canonical_reader: f.config,
        configuration: { schema_version: 1, scope: SCOPE, settings_project_id: settingsProject,
          artifact: judgeArtifact({ family, question_text, threshold: 0.8, timeout_ms: 15000, max_attempts: 1, max_tokens: 10000, max_cost_microunits: 100000 }),
          egress_policy: { policy_id: 'synthetic-judge-selected-only', revision: 'v1', max_sensitivity: 'INTERNAL', allowed_providers: ['typesafe'],
            sources: branches.map(b => ({ registration_id: b.source.registration_id, local_only: false,
              allowed_providers: ['typesafe'], text_policy: 'selected-fields' })) } } })]));
    const observe = (branch, key, text) => {
      check(allowedTexts.has(text));
      const { registration_id, registration } = branch.source, acl = { revision: 'synthetic-judge-v1', allowed_principal_ids: ['owner', 'reader'] };
      const event = { schema_version: 1, kind: 'raw_event',
        event_id: f.ingress.eventIdFor(f.context, { registration_id, idempotency_key: key }),
        partition: registration.partition, source_native_event_id: key, idempotency_key: key, source_event_type: 'note',
        occurred_at: null, observed_at: '2026-09-22T12:00:00.000Z', producer: { ...registration.producer, sequence: branch.sequence++ },
        causal_parents: [], identity: branch.execution,
        payload: { kind: 'snapshot', snapshot_id: key, digest: `sha256:${createHash('sha256').update(text).digest('hex')}` },
        provenance: { delivery: { channel: 'system', delivery_id: key }, source_objects: [{
          object: { kind: 'source_object', tenant_id: SCOPE.tenant_id, provider: 'vibehub', authority: 'local', object_id: key },
          acl, sensitivity: 'normal' }] }, acl, sensitivity: 'normal' };
      check(f.ingress.submit(f.context, { registration_id, epoch: f.epoch, event, snapshot_text: text }).status === 'accepted');
      return f.ingress.readEvent(f.context, { event_id: event.event_id }).event;
    };
    const publish = (branch, key, event, content, parents = []) => {
      const saved = f.explorations.mutate(f.context, mutation(f, branch.binding, key, { expected_graph: branch.head,
        operation: { kind: 'assert', assertion: assertion(f, event, key, { entity_id: key, parents, content }) } }));
      check(saved.status === 'applied'); branch.head = saved.receipt.next_graph; return saved;
    };
    const selected = cases.map((entry, index) => {
      const branch = branches[index % 2], event = observe(branch, `selected-event-${index}`, entry[2]);
      const targets = entry[3].map((ref, j) => {
        const key = `selected-target-${index}-${j}`, sourceEvent = observe(branch, key, ref.text);
        return publish(branch, key, sourceEvent, { semantic_type: 'judge-target', data: {
          schema_version: 1, kind: 'judge_target', target_kind: entry[1] === 'acceptance_relevance' ? 'acceptance' : 'context', text: ref.text } }).revision;
      });
      return { entry, branch, event, targets };
    });
    const request = ({ branch, event, targets }, invocation_id) => ({ invocation_id, node_id: 'judge', epoch: f.epoch,
      execution: branch.execution, exploration_id: branch.binding.exploration_id, execution_workspace_id: branch.binding.execution_workspace_id,
      expected_binding_version: branch.binding.binding_version, expected_catalog_version: f.registry.get(f.context).version,
      expected_project_selection_version: null, at: branch.head, event_id: event.event_id, target_refs: targets,
      expected_source_fence: f.feed.head(f.context).sequence });
    // Inspect only our own synthetic outgoing body. No headers/key enter reports.
    globalThis.fetch = (url, options) => {
      check(url === 'https://api.typesafe.ai/v1/systemone' && ++sends <= 9);
      const body = JSON.parse(options.body);
      check(body.model === 'jev-latest' && allowedTexts.has(body.state.event.text));
      check(body.state.candidates.every(item => allowedTexts.has(item.text) && /^target-[a-f0-9]{64}$/.test(item.id)));
      check(Object.keys(body.state).sort().join(',') === 'candidates,event');
      const pending = originalFetch(url, options);
      // This proves the actual fetch boundary was entered; it does not claim
      // remote receipt preceded revocation or that sent input can be recalled.
      if (revokeOnSend) { const revoke = revokeOnSend; revokeOnSend = null; revoke(); revoked = true; }
      return pending;
    };
    const results = []; let published = 0, cacheHits = 0;
    for (const item of selected) {
      const runtime = runtimes[item.entry[1]], input = request(item, item.entry[0]);
      const beforeRows = rows(f), beforeSends = sends, started = performance.now();
      const result = await runtime.evaluate(f.context, input);
      check(graphEqual(beforeRows, rows(f)) && sends === beforeSends + 1);
      if (result.status === 'decision') {
        const cached = await runtime.evaluate(f.context, input);
        check(cached.cache === 'hit' && cached.result_digest === result.result_digest && sends === beforeSends + 1); cacheHits++;
      }
      const expectedTargets = item.entry[4] ? item.targets : [];
      const matched = result.status === 'decision' && result.decision.value.relevant === item.entry[4]
        && graphEqual(result.target_refs, expectedTargets);
      if (result.status === 'decision' && result.decision.value.relevant) {
        publish(item.branch, `candidate-${item.entry[0]}`, item.event,
          { semantic_type: 'judge-observation', data: { result_digest: result.result_digest, relevant: true } }, result.target_refs); published++;
      }
      results.push({ id: item.entry[0], family: item.entry[1], branch: item.branch.label, status: result.status,
        reason_code: result.reason_code, matched, relevant: result.decision?.value.relevant ?? null,
        target_count: result.target_refs.length, confidence: result.decision?.confidence ?? null, model: result.decision?.model ?? null,
        model_latency_ms: result.decision ? Math.round(result.decision.latency_ms) : null,
        elapsed_ms: Math.round(performance.now() - started), input_hash: result.input_hash,
        result_digest: result.result_digest, attempts: result.attempts.length, observed_usage: result.usage.observed });
    }
    const lateCase = selected.find(item => item.entry[0] === 'context-yes'), lateRequest = request(lateCase, 'inflight-revocation');
    const preLate = rows(f), preHead = lateCase.branch.head;
    revokeOnSend = () => {
      const source = f.ingress.getRegistration(f.context, { registration_id: lateCase.branch.source.registration_id });
      f.ingress.updateSourceAccess(f.context, { registration_id: source.registration_id, expectedVersion: source.version,
        access: { ...source.registration.access, allowed_principal_ids: [] } });
    };
    const late = await runtimes.context_relevance.evaluate(f.context, lateRequest);
    check(revoked && late.status === 'refused' && late.decision === null && late.target_refs.length === 0);
    check(late.attempts.length === 1 && late.attempts[0].status === 'completed');
    check(graphEqual(f.graph.getHead(f.context, { generation_id: preHead.generation_id }).graph_revision, preHead));
    const finalRows = rows(f);
    check(finalRows.records.filter(r => r.namespace === 'working-graph').length === preLate.records.filter(r => r.namespace === 'working-graph').length);
    return { schema_version: 1, dataset: 'synthetic-selected-judge-nine-v1', measured_at: new Date().toISOString(),
      transport_calls: sends, provider: 'typesafe-direct', matched: results.filter(r => r.matched).length, total: results.length,
      isolated_explorations: 2, completed_cache_hits: cacheHits, explicit_candidate_publications: published,
      inflight_revocation: { fetch_boundary_entered: revoked, provider_completed: true, result_status: late.status,
        reason_code: late.reason_code, graph_unchanged: true, model_output_discarded: true },
      canonical_promotion: false, ingress_acknowledged: false, other_routes_live: false, results };
  } finally {
    globalThis.fetch = originalFetch;
    await settings?.close();
    for (const operation of cleanup.reverse()) await operation();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.env.TYPESAFE_API_KEY) {
    console.error('Set TYPESAFE_API_KEY locally; do not paste or print it.'); process.exitCode = 1;
  } else {
    try {
      const report = await checkJudgeJev(process.env.TYPESAFE_API_KEY);
      console.log(JSON.stringify(report, null, 2)); if (report.matched !== report.total) process.exitCode = 1;
    } catch { console.error('JEV Judge service check failed. No source, credential or raw provider error is printed.'); process.exitCode = 1; }
  }
}
