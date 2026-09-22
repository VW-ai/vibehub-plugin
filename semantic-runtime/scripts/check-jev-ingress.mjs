import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { DomainStore, migrateDomainStore, LocalCredentialAuthority, LOCAL_AUDIENCE,
  scopedReference, GitProjectRegistry, ProjectActivation, ACTIVATION_NAMESPACE,
  GIT_ENROLLMENT_NAMESPACE, DurableIngress, INGRESS_NAMESPACE,
  verifyEventPayload, TypeSafeJevJudge, LocalGraphStore, WORKING_GRAPH_NAMESPACE } from '../src/index.mjs';
import { validateDecision, canonical } from '../src/core/contracts.mjs';
import { ResilientJudge } from '../src/adapters/resilient-judge.mjs';
import { checkSyntheticJev, edgeCases } from './check-jev-synthetic.mjs';

const digest = text => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
const SCOPE = { tenant_id: 'synthetic', project_id: 'jev-ingress-check' };
const PRINCIPAL = 'synthetic-check';
const NOW = '2026-09-22T00:00:00.000Z';
const ACTIONS = ['store:read', 'store:write', 'project:inspect', 'project:enroll', 'project:initialize',
  'activation:read', 'activation:write', 'activation:admit',
  'ingress:register', 'ingress:read', 'ingress:submit', 'ingress:handoff'];

function localContext(authority, graphRoundTrip) {
  const actions = [...ACTIONS, ...(graphRoundTrip ? ['graph:read', 'graph:write', 'graph:publish'] : [])];
  const issued = authority.issue({ principal_id: PRINCIPAL, kind: 'service', scope: SCOPE, actions });
  const result = authority.authorize(issued.credential, { scope: SCOPE, audience: LOCAL_AUDIENCE,
    action: 'store:read', kinds: ['service'], boundary: 'http', reference: scopedReference('http', SCOPE, 'synthetic-check') });
  if (!result.allowed) throw new Error('Synthetic scope unavailable');
  return result.context;
}

// This policy attests only this file's deliberately selected synthetic corpus.
// It is not a general transcript sanitizer and accepts no user input.
const selectedTexts = new Set(edgeCases.map(entry => entry[2]));

/** Opt-in composition smoke. Only fixed synthetic texts may reach the judge. */
export async function checkPersistedJev(judge, { timeoutMs = 15_000, graphRoundTrip = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vh-jev-ingress-')));
  const folder = join(root, 'synthetic-project'); mkdirSync(folder);
  const authority = new LocalCredentialAuthority();
  let store;
  try {
    const context = localContext(authority, graphRoundTrip), filePath = join(root, 'domain.sqlite');
    migrateDomainStore({ filePath });
    const options = { filePath, authority,
      namespaces: [INGRESS_NAMESPACE, ACTIVATION_NAMESPACE, GIT_ENROLLMENT_NAMESPACE, ...(graphRoundTrip ? [WORKING_GRAPH_NAMESPACE] : [])] };
    const permitted = new Set([...selectedTexts, ...(graphRoundTrip ? edgeCases.flatMap(entry => entry[3].map(ref => ref.text)) : [])]);
    const open = () => {
      store = new DomainStore(options);
      return new DurableIngress({ store, authority,
        snapshotPolicy: ({ text }) => permitted.has(text) ? text : null });
    };
    let ingress = open();
    const registry = new GitProjectRegistry({ store, authority });
    registry.initialize(context, folder);
    const enrolled = registry.enroll(context, { folder, expectedVersion: null });
    const activation = new ProjectActivation({ store, authority });
    const epoch = activation.setEnabled(context, { enabled: true, expectedVersion: null }).state.epoch;
    const partition = { ...SCOPE, source_installation_id: enrolled.catalog.installation_id, partition_id: 'selected-synthetic-texts' };
    const producer = { producer_id: 'synthetic-check', epoch: 'synthetic-v1' };
    const { registration_id } = ingress.registerSource(context, { partition, producer,
      producer_principal_id: PRINCIPAL, start_sequence: 0,
      mapping: { schema_version: 1, mapping_id: 'synthetic-check', revision: 'v1', event_types: { message: 'AGENT_MESSAGE' } },
      access: { enabled: true, allowed_principal_ids: [PRINCIPAL], sensitivity: 'normal', allow_snapshots: true } });
    const observations = new Map();
    const inputs = [...edgeCases.map(entry => [entry[0], entry[2]]), ...(graphRoundTrip
      ? [...new Set(edgeCases.flatMap(entry => entry[3].map(ref => ref.text)))].map((text, i) => [`state-input-${i}`, text]) : [])];
    for (const [sequence, [id, text]] of inputs.entries()) {
      const event = { schema_version: 1, kind: 'raw_event',
        event_id: ingress.eventIdFor(context, { registration_id, idempotency_key: id }),
        partition, source_native_event_id: id, idempotency_key: id, source_event_type: 'message',
        occurred_at: NOW, observed_at: NOW, producer: { ...producer, sequence }, causal_parents: [], identity: {},
        payload: { kind: 'snapshot', snapshot_id: id, digest: digest(text) },
        provenance: { delivery: { channel: 'system', delivery_id: id }, source_objects: graphRoundTrip ? [{
          object: { kind: 'source_object', tenant_id: SCOPE.tenant_id, provider: 'vibehub', authority: 'local', object_id: id },
          acl: { revision: 'selected-v1', allowed_principal_ids: [PRINCIPAL] }, sensitivity: 'normal',
        }] : [] },
        acl: { revision: 'selected-v1', allowed_principal_ids: [PRINCIPAL] }, sensitivity: 'normal' };
      const accepted = ingress.submit(context, { registration_id, epoch, event, snapshot_text: text });
      if (accepted.status !== 'accepted') throw new Error('Synthetic intake failed');
      observations.set(text, { event, receipt: accepted.receipt });
    }
    store.close(); ingress = open();
    let deduplicated = 0;
    for (const [text, { event, receipt }] of observations) {
      const retry = structuredClone(event);
      retry.observed_at = '2026-09-22T00:01:00.000Z';
      retry.provenance.delivery.delivery_id = `retry-${event.idempotency_key}`;
      const accepted = ingress.submit(context, { registration_id, epoch, event: retry, snapshot_text: text });
      if (accepted.status !== 'duplicate' || JSON.stringify(accepted.receipt) !== JSON.stringify(receipt)) {
        throw new Error('Synthetic retry changed original receipt');
      }
      deduplicated++;
    }
    const generation_id = 'synthetic-judgment-check';
    let graph, publisher, graphHead, stateCount = 0;
    const published = [], stateAssertions = [];
    if (graphRoundTrip) {
      graph = new LocalGraphStore({ store, authority });
      publisher = graph.registerPublisherRun(context, { epoch, run_key: 'synthetic-judge' });
      graphHead = graph.initialize(context, { generation_id, epoch, idempotency_key: 'initialize',
        publisher_ref: publisher.publisher_ref, coverage: [] }).receipt.next_graph;
    }
    const publish = (id, data, events, parents = []) => {
      const request = { epoch, idempotency_key: id, publisher_ref: publisher.publisher_ref, expected_graph: graphHead,
        operation: { kind: 'assert', assertion: { schema_version: 1, assertion_id: id, entity_kind: 'entity', entity_id: id,
          base_revision: null, parents, execution_id: publisher.execution_id, status: 'candidate',
          content: { semantic_type: 'decision', data }, events, canonical_refs: [] } }, coverage: null };
      const result = graph.mutate(context, request);
      if (result.status !== 'applied') throw new Error('Synthetic Graph publication failed');
      graphHead = result.receipt.next_graph;
      return { request, result, data };
    };
    let materialized = 0, coherentReadSnapshots = 0;
    const report = await checkSyntheticJev({ async evaluate(input, request) {
      const observation = observations.get(input.event.payload.text);
      if (!observation) throw new Error('Unexpected synthetic input');
      const { retained, snapshot } = store.readSnapshot(context, () => ({
        retained: ingress.readEvent(context, { event_id: observation.event.event_id }),
        snapshot: ingress.readSnapshot(context, { event_id: observation.event.event_id }),
      }));
      coherentReadSnapshots++;
      if (!retained || !snapshot || snapshot.text !== input.event.payload.text
        || snapshot.digest !== observation.event.payload.digest) throw new Error('Synthetic snapshot mismatch');
      verifyEventPayload(retained.event.payload, Buffer.from(snapshot.text, 'utf8'));
      materialized++;
      // The coherent database view is closed before any model/network call.
      // Do not spread the persisted envelope: source IDs, ACL, paths, catalog,
      // receipt, provenance, digest and labels have no role in model input.
      let stateRefs = input.stateRefs;
      const stateParents = [];
      if (graphRoundTrip) {
        // Deliberately synthetic initial state has its own admitted source.
        // Labels and expected decisions never enter these state assertions.
        stateRefs = input.stateRefs.map(ref => {
          const observation = observations.get(ref.text);
          const { retained, snapshot } = store.readSnapshot(context, () => ({
            retained: ingress.readEvent(context, { event_id: observation.event.event_id }),
            snapshot: ingress.readSnapshot(context, { event_id: observation.event.event_id }),
          }));
          coherentReadSnapshots++;
          verifyEventPayload(retained.event.payload, Buffer.from(snapshot.text, 'utf8'));
          const saved = publish(`state-${stateCount++}`, { id: ref.id, text: snapshot.text }, [retained.event]); stateAssertions.push(saved);
          const read = graph.resolve(context, { at: graphHead, address: saved.result.revision });
          if (read.status !== 'resolved') throw new Error('Synthetic Graph state unavailable');
          stateParents.push(saved.result.revision);
          return read.revision.assertion.content.data;
        });
      }
      const minimal = { event: { type: retained.event.event_type,
        timestamp: retained.event.observed_at, payload: { text: snapshot.text } },
        stateRefs, question: input.question };
      const decision = await judge.evaluate(minimal, request);
      if (graphRoundTrip) {
        const validated = validateDecision(decision, minimal);
        // A fast judgment is a candidate with evidence; it does not accept a
        // Ticket, resolve semantic conflict, or ACK source processing.
        published.push(publish(`judgment-${materialized}`, { family: input.question.family,
          relevant: validated.value.relevant, target_ids: validated.value.target_ids,
          model: validated.model, provider: validated.provider }, [retained.event], stateParents));
      }
      return decision;
    } }, { suite: 'edge', timeoutMs });
    let graphReport;
    if (graphRoundTrip) {
      store.close(); ingress = open(); graph = new LocalGraphStore({ store, authority });
      let verified = 0, judgmentSources = 0;
      for (const saved of [...stateAssertions, ...published]) {
        const read = graph.resolve(context, { at: saved.result.receipt.next_graph, address: saved.result.revision });
        if (read.status !== 'resolved' || read.revision.assertion.status !== 'candidate'
          || canonical(read.revision.assertion.content.data) !== canonical(saved.data)) throw new Error('Synthetic Graph restart mismatch');
        // Every state sent to the judge, including a rejected target, helped
        // produce its output. Preserve those exact revision/source dependencies.
        const expectedEvents = [...saved.request.operation.assertion.events,
          ...saved.request.operation.assertion.parents.flatMap(parent => {
            const source = stateAssertions.find(item => canonical(item.result.revision) === canonical(parent));
            if (!source) throw new Error('Synthetic state provenance missing');
            return source.request.operation.assertion.events;
          })];
        const actualIds = read.revision.provenance.events.map(event => event.event_id).sort();
        const expectedIds = [...new Set(expectedEvents.map(event => event.event_id))].sort();
        if (canonical(actualIds) !== canonical(expectedIds)) throw new Error('Synthetic judgment provenance mismatch');
        if (published.includes(saved)) judgmentSources += actualIds.length;
        const retried = graph.mutate(context, saved.request);
        if (retried.status !== 'duplicate' || JSON.stringify(retried.receipt) !== JSON.stringify(saved.result.receipt)) throw new Error('Synthetic Graph retry mismatch');
        verified++;
      }
      graphReport = { state_materializations: stateAssertions.length, candidate_judgments: published.length,
        judgment_provenance_sources_verified: judgmentSources,
        restarted: true, historical_reads_verified: verified, exact_retries_verified: verified,
        canonical_promotion: false, ingress_acknowledged: false };
    }
    return { ...report, dataset: graphRoundTrip ? 'graph-round-trip-synthetic-edge-eight-v1' : 'persisted-synthetic-edge-eight-v1',
      ...(graphReport ? { graph: graphReport } : {}),
      ingress: { stored: observations.size, reopened: true, deduplicated, materialized,
        coherent_read_snapshots: coherentReadSnapshots,
        pending_intents: ingress.listPending(context, { limit: 64 }).length,
        semantic_processing_claimed: false } };
  } finally {
    store?.close(); authority.close(); rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.env.TYPESAFE_API_KEY) {
    console.error('Set TYPESAFE_API_KEY locally; do not paste or print it.'); process.exitCode = 1;
  } else {
    try {
      const client = new TypeSafeClient({ baseURL: 'https://api.typesafe.ai', logLevel: 'off', retry: { maxRetries: 0 } });
      const judge = new ResilientJudge(new TypeSafeJevJudge({ client }),
        { maxAttempts: 2, minIntervalMs: 500, baseDelayMs: 500, maxDelayMs: 2_000 });
      const report = await checkPersistedJev(judge, { graphRoundTrip: process.argv.includes('--graph') });
      console.log(JSON.stringify({ ...report, operational: judge.snapshot() }, null, 2));
      if (report.completed !== report.total || report.matched !== report.total) process.exitCode = 1;
    } catch { console.error('Persisted JEV check failed. No raw source or provider error is printed.'); process.exitCode = 1; }
  }
}
