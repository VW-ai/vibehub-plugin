import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { DurableIngress, TypeSafeJevJudge, verifyEventPayload } from '../src/index.mjs';
import { ResilientJudge } from '../src/adapters/resilient-judge.mjs';
import { canonical, validateDecision } from '../src/core/contracts.mjs';
import { edgeCases } from './check-jev-synthetic.mjs';
import { fixture, bind, executionFor, git, register, rows } from '../test/helpers/exploration-fixture.mjs';

// These four existing synthetic cases are the complete source allowlist. Local
// labels never determine which target text enters a Graph or the model input.
const selectedCases = edgeCases.slice(0, 4);
const selectedTexts = new Set(selectedCases.flatMap(entry => [entry[2], ...entry[3].map(ref => ref.text)]));
const questions = {
  acceptance_relevance: 'Does this event provide relevant evidence or change information for this acceptance criterion?',
  context_relevance: 'Does this event change or directly relate to this existing context?',
};
const NOW = '2026-09-22T00:00:00.000Z';
const same = (left, right) => canonical(left) === canonical(right);
const check = condition => { if (!condition) throw new Error('Synthetic exploration check failed'); };
const digest = text => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
const errorCode = error => error && typeof error.code === 'string' && /^[a-z_]{1,80}$/.test(error.code) ? error.code : 'publication_rejected';

/** Opt-in synthetic composition check. No caller text, credentials or remote paths are accepted. */
export async function checkExplorationJev(judge, { timeoutMs = 15_000 } = {}) {
  check(judge && typeof judge.evaluate === 'function' && Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120_000);
  const cleanup = [];
  try {
    // Reuse only this component's disposable, synthetic Git/SQLite fixture.
    // Standalone verification copies these fixture modules with the component.
    const f = fixture({ after(operation) { cleanup.push(operation); } });
    f.ingress = new DurableIngress({ store: f.store, authority: f.authority,
      snapshotPolicy: ({ text }) => selectedTexts.has(text) ? text : null });
    const linked = join(f.root, 'synthetic-alternative');
    git(f.folder, 'worktree', 'add', '-b', 'synthetic-alternative', linked); f.refresh();
    const executions = [f.execution, executionFor(f, linked)];
    const branches = executions.map((execution, index) => ({ label: index === 0 ? 'A' : 'B', execution,
      binding: bind(f, { key: `jev-bind-${index}`, execution }), sequence: 0,
      source: register(f, { partition: `jev-selected-${index}`, execution,
        mapping: { schema_version: 1, mapping_id: 'synthetic-jev-selected', revision: 'v1', event_types: { message: 'AGENT_MESSAGE' } } }) }));
    branches.forEach(branch => { branch.head = branch.binding.graph_revision; });
    check(branches[0].binding.exploration_id !== branches[1].binding.exploration_id
      && branches[0].binding.generation_id !== branches[1].binding.generation_id);
    let admittedCount = 0, exactReads = 0, modelCalls = 0, verifiedSources = 0, candidateCount = 0;
    const sourceObservation = (branch, key, text) => {
      check(selectedTexts.has(text));
      const { registration_id, registration } = branch.source;
      const acl = { revision: 'synthetic-selected-v1', allowed_principal_ids: ['owner', 'reader'] };
      const event = { schema_version: 1, kind: 'raw_event',
        event_id: f.ingress.eventIdFor(f.context, { registration_id, idempotency_key: key }),
        partition: registration.partition, source_native_event_id: key, idempotency_key: key, source_event_type: 'message',
        occurred_at: NOW, observed_at: NOW, producer: { ...registration.producer, sequence: branch.sequence++ },
        causal_parents: [], identity: branch.execution,
        payload: { kind: 'snapshot', snapshot_id: key, digest: digest(text) },
        provenance: { delivery: { channel: 'system', delivery_id: key }, source_objects: [{
          object: { kind: 'source_object', tenant_id: registration.partition.tenant_id, provider: 'vibehub', authority: 'local', object_id: key },
          acl, sensitivity: 'normal' }] }, acl, sensitivity: 'normal' };
      check(f.ingress.submit(f.context, { registration_id, epoch: f.epoch, event, snapshot_text: text }).status === 'accepted');
      admittedCount++; return f.ingress.readEvent(f.context, { event_id: event.event_id }).event;
    };
    const route = branch => ({ epoch: f.epoch, publisher_ref: f.publisher.publisher_ref,
      execution_workspace_id: branch.binding.execution_workspace_id, expected_binding_version: branch.binding.binding_version,
      expected_catalog_version: f.registry.get(f.context).version, expected_project_selection_version: null,
      expected_graph: branch.head, expected_source_fence: f.feed.head(f.context).sequence, coverage: null });
    const command = (routing, key, data, events, parents) => ({ ...routing, idempotency_key: key,
      operation: { kind: 'assert', assertion: { schema_version: 1, assertion_id: key, entity_kind: 'entity', entity_id: key,
        base_revision: null, parents, execution_id: f.publisher.execution_id, status: 'candidate',
        content: { semantic_type: 'decision', data }, events, canonical_refs: [] } } });
    const publish = (branch, request) => {
      const result = f.explorations.mutate(f.context, request); check(result.status === 'applied');
      branch.head = result.receipt.next_graph; return result;
    };
    const read = (branch, address, at = branch.head) => {
      const result = f.explorations.resolve(f.context, { exploration_id: branch.binding.exploration_id, at, address, shared_keys: null });
      check(result.local.status === 'resolved' && result.local.revision.assertion.status === 'candidate');
      check(result.local.revision.generation_id === branch.binding.generation_id);
      exactReads++; return result.local.revision;
    };
    // Persist both alternatives before any evaluation, so the isolation check
    // has actual neighboring Graph state to exclude on every dispatch.
    const preparedCases = selectedCases.map((entry, index) => {
      const branch = branches[index % 2], event = sourceObservation(branch, `jev-event-${index}`, entry[2]);
      const targets = entry[3].map((ref, targetIndex) => {
        const key = `jev-state-${index}-${targetIndex}`, event = sourceObservation(branch, key, ref.text);
        const result = publish(branch, command(route(branch), key, { id: ref.id, text: ref.text }, [event], []));
        return { ref, event, address: result.revision };
      });
      return { entry, branch, event, targets };
    });
    const materialize = selected => {
      const { entry, branch, event, targets } = selected;
      const routing = route(branch), stateRefs = targets.map(target => {
        const revision = read(branch, target.address, routing.expected_graph), data = revision.assertion.content.data;
        check(same(data, target.ref) && revision.provenance.events.length === 1
          && revision.provenance.events[0].event_id === target.event.event_id);
        return { id: data.id, text: data.text };
      });
      const snapshot = f.store.readSnapshot(f.context, () => {
        const retained = f.ingress.readEvent(f.context, { event_id: event.event_id });
        const snapshot = f.ingress.readSnapshot(f.context, { event_id: event.event_id });
        check(snapshot && snapshot.text === entry[2]); verifyEventPayload(retained.event.payload, Buffer.from(snapshot.text, 'utf8'));
        return { type: retained.event.event_type, timestamp: retained.event.observed_at, text: snapshot.text };
      });
      const input = { event: { type: snapshot.type, timestamp: snapshot.timestamp, payload: { text: snapshot.text } },
        stateRefs, question: { family: entry[1], text: questions[entry[1]] } };
      check(same(stateRefs, entry[3]));
      const serialized = JSON.stringify(input);
      const privateValues = [f.root, f.folder, linked, ...branches.flatMap(candidate => [candidate.binding.exploration_id,
        candidate.binding.generation_id, candidate.binding.execution_workspace_id, candidate.source.registration_id])];
      check(privateValues.every(value => !serialized.includes(value)));
      const foreign = preparedCases.filter(candidate => candidate.branch !== branch).flatMap(candidate => candidate.targets.map(target => target.ref.text));
      check(foreign.filter(text => !entry[3].some(ref => ref.text === text)).every(text => !serialized.includes(text)));
      return { routing, input, parents: targets.map(target => target.address) };
    };
    const judgedCommand = (selected, prepared, decision, key) => command(prepared.routing, key,
      { family: selected.entry[1], relevant: decision.value.relevant, target_ids: decision.value.target_ids,
        model: decision.model, provider: decision.provider }, [selected.event], prepared.parents);
    const resultRows = [];
    for (const [index, selected] of preparedCases.entries()) {
      const prepared = materialize(selected), started = performance.now();
      let decision;
      try {
        modelCalls++;
        decision = validateDecision(await judge.evaluate(prepared.input, { signal: AbortSignal.timeout(timeoutMs) }), prepared.input);
      } catch {
        resultRows.push({ id: selected.entry[0], exploration: selected.branch.label, status: 'model_failed',
          latency_ms: Math.round(performance.now() - started) }); continue;
      }
      const request = judgedCommand(selected, prepared, decision, `jev-judgment-${index}`);
      const result = publish(selected.branch, request), revision = read(selected.branch, result.revision);
      check(same(revision.assertion.parents, prepared.parents));
      const expectedSources = [selected.event, ...selected.targets.map(target => target.event)].map(event => event.event_id).sort();
      check(same(revision.provenance.events.map(event => event.event_id).sort(), expectedSources));
      verifiedSources += expectedSources.length; candidateCount++;
      check(prepared.parents.every(parent => parent.generation_id === selected.branch.binding.generation_id));
      const expected = selected.entry[4], expectedTargets = selected.entry[5];
      resultRows.push({ id: selected.entry[0], exploration: selected.branch.label, status: 'ok', expected,
        expected_targets: expectedTargets, matched: decision.value.relevant === expected && same(decision.value.target_ids, [...expectedTargets].sort()),
        relevant: decision.value.relevant, target_ids: decision.value.target_ids, model: decision.model,
        successful_attempt_ms: Math.round(decision.latency_ms), latency_ms: Math.round(performance.now() - started) });
    }
    // Capture the original workspace pins, then leave while the fifth evaluation
    // is pending (it may still be pacing). Its result must not re-route itself.
    const delayedCase = preparedCases[0], delayed = materialize(delayedCase), delayedStarted = performance.now();
    modelCalls++;
    const pending = Promise.resolve().then(() => judge.evaluate(delayed.input, { signal: AbortSignal.timeout(timeoutMs) }));
    // Begin evaluation before the synchronous Git/binding transition; suppress transient
    // unhandled rejection noise while keeping the result local and sanitized.
    pending.catch(() => {}); await Promise.resolve();
    git(f.folder, 'switch', '-c', 'synthetic-during-model'); f.refresh();
    const switched = bind(f, { key: 'jev-rebind-during-model', execution: f.execution });
    check(switched.exploration_id !== delayedCase.branch.binding.exploration_id);
    const before = rows(f), beforeHeads = branches.map(branch => f.graph.getHead(f.context, { generation_id: branch.binding.generation_id }).graph_revision);
    let staleResult, delayedDecision;
    try {
      delayedDecision = validateDecision(await pending, delayed.input);
    } catch {
      check(same(rows(f), before));
      staleResult = { status: 'model_failed', model_completed: false, latency_ms: Math.round(performance.now() - delayedStarted) };
    }
    if (delayedDecision) {
      const request = judgedCommand(delayedCase, delayed, delayedDecision, 'jev-stale-result');
      let rejected = null;
      try { f.explorations.mutate(f.context, request); } catch (error) { rejected = errorCode(error); }
      check(['exploration_binding_conflict', 'exploration_catalog_conflict', 'exploration_rebind_required'].includes(rejected)
        && same(rows(f), before));
      check(same(branches.map(branch => f.graph.getHead(f.context, { generation_id: branch.binding.generation_id }).graph_revision), beforeHeads));
      check(f.explorations.getReceipt(f.context, { idempotency_key: request.idempotency_key }) === null);
      staleResult = { status: 'rejected', model_completed: true, rejection: rejected,
        receipt_absent: true, unchanged_graphs: true, rejected_store_row_delta: 0,
        latency_ms: Math.round(performance.now() - delayedStarted) };
    }
    return { schema_version: 1, dataset: 'exploration-routed-synthetic-edge-four-v1', measured_at: new Date().toISOString(),
      total: selectedCases.length, completed: resultRows.filter(row => row.status === 'ok').length,
      matched: resultRows.filter(row => row.matched).length, rows: resultRows, model_calls: modelCalls,
      routing: { real_worktrees: 2, isolated_explorations: 2, state_materializations: preparedCases.reduce((n, selected) => n + selected.targets.length, 0),
        exact_local_reads: exactReads, candidate_judgments: candidateCount, provenance_sources_verified: verifiedSources,
        minimized_inputs_verified: preparedCases.length + 1, source_fence_pinned: true, cross_exploration_input: false,
        canonical_promotion: false, adoption: false, ingress_acknowledged: false },
      ingress: { selected_admitted_events: admittedCount }, stale_result: staleResult };
  } finally { for (const operation of cleanup.reverse()) operation(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.env.TYPESAFE_API_KEY) {
    console.error('Set TYPESAFE_API_KEY locally; do not paste or print it.'); process.exitCode = 1;
  } else {
    try {
      const client = new TypeSafeClient({ baseURL: 'https://api.typesafe.ai', logLevel: 'off', retry: { maxRetries: 0 } });
      const judge = new ResilientJudge(new TypeSafeJevJudge({ client }),
        { maxAttempts: 2, minIntervalMs: 500, baseDelayMs: 500, maxDelayMs: 2_000 });
      const report = await checkExplorationJev(judge);
      console.log(JSON.stringify({ ...report, operational: judge.snapshot() }, null, 2));
      if (report.completed !== report.total || report.matched !== report.total || report.stale_result.status !== 'rejected') process.exitCode = 1;
    } catch { console.error('Exploration JEV check failed. No raw source or provider error is printed.'); process.exitCode = 1; }
  }
}
