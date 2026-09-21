import { randomUUID } from 'node:crypto';
import { canonical, compareText, fingerprint, normalizeEvent, normalizeScope, normalizeState, requireValue, sameScope } from './contracts.mjs';
import { evaluateEvent, validatePolicy } from './policy.mjs';
import { evaluateLabels } from './evaluation.mjs';

/**
 * SemanticJudge: { descriptor, evaluate({event, stateRefs, question}, {signal}) }
 * CandidateStore: { startRun(manifest), appendEvent(scope, runId, event, output),
 *                  finishRun(scope, runId, status, report) }
 * Core code never imports a concrete host, judge, database, or project helper.
 */
export async function replay({ events: rawEvents, state: rawState = [], scope: rawScope, policy: rawPolicy, judge, store, labels, datasetKind = 'unspecified' }) {
  const scope = normalizeScope(rawScope);
  const policy = validatePolicy(rawPolicy);
  requireValue(Array.isArray(rawEvents) && rawEvents.length > 0, 'Replay needs at least one event');
  requireValue(['synthetic', 'real', 'unspecified'].includes(datasetKind), 'Invalid dataset kind');
  requireValue(judge && typeof judge.evaluate === 'function' && judge.descriptor, 'Invalid SemanticJudge');
  const unique = new Map();
  for (const raw of rawEvents) {
    const event = normalizeEvent(raw);
    requireValue(sameScope(event, scope), 'Event is outside the replay tenant/project');
    if (unique.has(event.event_id)) {
      requireValue(canonical(unique.get(event.event_id)) === canonical(event), 'Conflicting duplicate event identity');
    } else unique.set(event.event_id, event);
  }
  const events = [...unique.values()].sort((a, b) => compareText(a.timestamp, b.timestamp) || compareText(a.event_id, b.event_id));
  // Exclude other scopes before fingerprinting or handing state to a judge.
  const state = normalizeState(rawState).filter(item => sameScope(item, scope));
  evaluateLabels([], labels, events); // Validate labels before any persistence.
  const manifest = {
    schema_version: 1, ...scope, run_id: randomUUID(), status: 'running',
    dataset_kind: datasetKind, dataset_hash: fingerprint(events), state_hash: fingerprint(state),
    policy_hash: fingerprint(policy), policy, judge: structuredClone(judge.descriptor),
    labels_hash: labels === undefined ? null : fingerprint(labels),
    started_at: new Date().toISOString(),
  };
  store.startRun(manifest);
  const allDecisions = [];
  let candidates = 0;
  try {
    for (const event of events) {
      const output = await evaluateEvent({ event, state, policy, judge });
      store.appendEvent(scope, manifest.run_id, event, output);
      allDecisions.push(...output.decisions);
      candidates += output.candidates.length;
    }
    const actions = Object.fromEntries(['IGNORE', 'INGEST', 'DEFER', 'ESCALATE'].map(action => [action, allDecisions.filter(item => item.action === action).length]));
    const report = {
      run_id: manifest.run_id, dataset_kind: datasetKind, events: events.length,
      duplicate_events: rawEvents.length - events.length, decisions: allDecisions.length,
      candidates, actions, judge_errors: allDecisions.filter(item => item.error_code).length,
      measured_judge_ms: allDecisions.reduce((sum, item) => sum + item.elapsed_ms, 0),
      labeled_metrics: evaluateLabels(allDecisions, labels, events),
      downstream_task_success: null, repeated_work_reduction: null,
      productization_gate: 'not_evaluated',
    };
    store.finishRun(scope, manifest.run_id, 'complete', report);
    return report;
  } catch (error) {
    store.finishRun(scope, manifest.run_id, 'failed', { reason_code: 'replay_failed' });
    throw error;
  }
}
