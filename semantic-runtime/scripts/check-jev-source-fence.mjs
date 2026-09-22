import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { DomainStore, migrateDomainStore, LocalCredentialAuthority, LOCAL_AUDIENCE, scopedReference,
  GitProjectRegistry, ProjectActivation, DurableIngress, LocalGraphStore, TypeSafeJevJudge } from '../src/index.mjs';
import { validateDecision, canonical } from '../src/core/contracts.mjs';
import { cases } from './check-jev-synthetic.mjs';

const scope = { tenant_id: 'synthetic', project_id: 'jev-source-fence' };
const principal = 'synthetic-check', timestamp = '2026-09-22T00:00:00.000Z';
const digest = text => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const sample = cases.find(entry => entry[0] === 'context-yes');
const selectedTexts = new Set([sample[2], sample[3][0].text]);
const requireThat = value => { if (!value) throw new Error('Synthetic source fence failed'); };

/** Fixed synthetic input only. Revocation occurs after dispatch, before await. */
export async function checkJevSourceFence(judge, { timeoutMs = 15_000 } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vh-jev-fence-')));
  const folder = join(root, 'synthetic-project'); mkdirSync(folder);
  const authority = new LocalCredentialAuthority(); let store;
  try {
    const actions = ['store:read', 'store:write', 'project:inspect', 'project:enroll', 'project:initialize',
      'activation:read', 'activation:write', 'activation:admit', 'ingress:register', 'ingress:read', 'ingress:submit',
      'graph:read', 'graph:write', 'graph:publish'];
    const issued = authority.issue({ principal_id: principal, kind: 'service', scope, actions });
    const authorized = authority.authorize(issued.credential, { scope, audience: LOCAL_AUDIENCE,
      action: 'store:read', kinds: ['service'], boundary: 'object', reference: scopedReference('object', scope, 'synthetic-check') });
    requireThat(authorized.allowed); const context = authorized.context;
    const filePath = join(root, 'domain.sqlite'); migrateDomainStore({ filePath });
    store = new DomainStore({ filePath, authority,
      namespaces: ['git-enrollment', 'project-activation', 'durable-ingress', 'working-graph', 'source-invalidation'] });
    const registry = new GitProjectRegistry({ store, authority }); registry.initialize(context, folder);
    const enrolled = registry.enroll(context, { folder, expectedVersion: null });
    const epoch = new ProjectActivation({ store, authority }).setEnabled(context, { enabled: true, expectedVersion: null }).state.epoch;
    const ingress = new DurableIngress({ store, authority, snapshotPolicy: ({ text }) => selectedTexts.has(text) ? text : null });
    const capture = (id, text) => {
      const source = ingress.registerSource(context, { partition: { ...scope,
        source_installation_id: enrolled.catalog.installation_id, partition_id: id },
        producer: { producer_id: 'synthetic-check', epoch: 'v1' }, producer_principal_id: principal, start_sequence: 0,
        mapping: { schema_version: 1, mapping_id: 'synthetic-check', revision: 'v1', event_types: { message: 'AGENT_MESSAGE' } },
        access: { enabled: true, allowed_principal_ids: [principal], sensitivity: 'normal', allow_snapshots: true } });
      const acl = { revision: 'synthetic-v1', allowed_principal_ids: [principal] };
      const event = { schema_version: 1, kind: 'raw_event',
        event_id: ingress.eventIdFor(context, { registration_id: source.registration_id, idempotency_key: id }),
        partition: source.registration.partition, source_native_event_id: id, idempotency_key: id, source_event_type: 'message',
        occurred_at: timestamp, observed_at: timestamp, producer: { ...source.registration.producer, sequence: 0 }, causal_parents: [], identity: {},
        payload: { kind: 'snapshot', snapshot_id: id, digest: digest(text) },
        provenance: { delivery: { channel: 'system', delivery_id: id }, source_objects: [{
          object: { kind: 'source_object', tenant_id: scope.tenant_id, provider: 'vibehub', authority: 'local', object_id: id },
          acl, sensitivity: 'normal' }] }, acl, sensitivity: 'normal' };
      ingress.submit(context, { registration_id: source.registration_id, epoch, event, snapshot_text: text });
      return { source, event: ingress.readEvent(context, { event_id: event.event_id }).event };
    };
    const state = capture('state', sample[3][0].text), observation = capture('event', sample[2]);
    const graph = new LocalGraphStore({ store, authority }), generation_id = 'synthetic-source-fence';
    const publisher = graph.registerPublisherRun(context, { epoch, run_key: 'synthetic-check' });
    const genesis = graph.initialize(context, { generation_id, epoch, idempotency_key: 'initialize', publisher_ref: publisher.publisher_ref, coverage: [] });
    const makeRequest = (id, at, data, events, parents = []) => ({ epoch, idempotency_key: id, publisher_ref: publisher.publisher_ref,
      expected_graph: at, operation: { kind: 'assert', assertion: { schema_version: 1, assertion_id: id,
        entity_kind: 'entity', entity_id: id, base_revision: null, parents, execution_id: publisher.execution_id,
        status: 'candidate', content: { semantic_type: 'decision', data }, events, canonical_refs: [] } }, coverage: null });
    const savedState = graph.mutate(context, makeRequest('state', genesis.receipt.next_graph, sample[3][0], [state.event]));
    const visible = graph.resolve(context, { at: savedState.receipt.next_graph, address: savedState.revision });
    requireThat(visible.status === 'resolved');
    const snapshot = ingress.readSnapshot(context, { event_id: observation.event.event_id });
    const input = { event: { type: observation.event.event_type, timestamp, payload: { text: snapshot.text } },
      stateRefs: [visible.revision.assertion.content.data],
      question: { family: sample[1], text: 'Does this event change or directly relate to this existing context?' } };
    // No database view survives dispatch. No automatic retry may resend the
    // already-materialized context after this source has been revoked.
    const started = performance.now();
    const pending = judge.evaluate(input, { signal: AbortSignal.timeout(timeoutMs) })
      .then(value => ({ value }), () => ({ failed: true }));
    ingress.updateSourceAccess(context, { registration_id: state.source.registration_id,
      expectedVersion: state.source.version, access: { ...state.source.registration.access, allowed_principal_ids: [] } });
    const response = await pending; requireThat(!response.failed);
    const decision = validateDecision(response.value, input);
    requireThat(ingress.readEvent(context, { event_id: observation.event.event_id }).event.event_id === observation.event.event_id);
    requireThat(graph.resolve(context, { at: savedState.receipt.next_graph, address: savedState.revision }).status === 'denied');
    let rejection = null;
    try { graph.mutate(context, makeRequest('late-judgment', savedState.receipt.next_graph, decision.value,
      [observation.event], [savedState.revision])); } catch (error) { rejection = error.code; }
    requireThat(rejection === 'graph_access_denied');
    requireThat(canonical(graph.getHead(context, { generation_id }).graph_revision) === canonical(savedState.receipt.next_graph));
    requireThat(graph.getReceipt(context, { generation_id, idempotency_key: 'late-judgment' }) === null);
    return { schema_version: 1, dataset: 'synthetic-inflight-source-revocation-v1', measured_at: new Date().toISOString(),
      model: decision.model, model_completed: true, matched: decision.value.relevant === true
        && canonical(decision.value.target_ids) === canonical(['login']), successful_attempt_ms: Math.round(decision.latency_ms),
      elapsed_ms: Math.round(performance.now() - started), source_revoked_after_dispatch: true,
      direct_event_still_readable: true, state_parent_denied: true, result_publication: 'rejected',
      rejection_code: rejection, graph_unchanged: true, result_receipt_absent: true, retries: 0,
      canonical_promotion: false, ingress_acknowledged: false };
  } finally { store?.close(); authority.close(); rmSync(root, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.env.TYPESAFE_API_KEY) {
    console.error('Set TYPESAFE_API_KEY locally; do not paste or print it.'); process.exitCode = 1;
  } else {
    try {
      const client = new TypeSafeClient({ baseURL: 'https://api.typesafe.ai', logLevel: 'off', retry: { maxRetries: 0 } });
      const report = await checkJevSourceFence(new TypeSafeJevJudge({ client }));
      console.log(JSON.stringify(report, null, 2)); if (!report.matched) process.exitCode = 1;
    } catch { console.error('JEV source fence check failed. No raw source or provider error is printed.'); process.exitCode = 1; }
  }
}
