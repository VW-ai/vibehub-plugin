import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { DomainStore, migrateDomainStore, LocalCredentialAuthority, LOCAL_AUDIENCE,
  scopedReference, GitProjectRegistry, ProjectActivation, ACTIVATION_NAMESPACE,
  GIT_ENROLLMENT_NAMESPACE, DurableIngress, INGRESS_NAMESPACE,
  verifyEventPayload, TypeSafeJevJudge } from '../src/index.mjs';
import { ResilientJudge } from '../src/adapters/resilient-judge.mjs';
import { checkSyntheticJev, edgeCases } from './check-jev-synthetic.mjs';

const digest = text => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
const SCOPE = { tenant_id: 'synthetic', project_id: 'jev-ingress-check' };
const PRINCIPAL = 'synthetic-check';
const NOW = '2026-09-22T00:00:00.000Z';
const ACTIONS = ['store:read', 'store:write', 'project:inspect', 'project:enroll', 'project:initialize',
  'activation:read', 'activation:write', 'activation:admit',
  'ingress:register', 'ingress:read', 'ingress:submit', 'ingress:handoff'];

function localContext(authority) {
  const issued = authority.issue({ principal_id: PRINCIPAL, kind: 'service', scope: SCOPE, actions: ACTIONS });
  const result = authority.authorize(issued.credential, { scope: SCOPE, audience: LOCAL_AUDIENCE,
    action: 'store:read', kinds: ['service'], boundary: 'http', reference: scopedReference('http', SCOPE, 'synthetic-check') });
  if (!result.allowed) throw new Error('Synthetic scope unavailable');
  return result.context;
}

// This policy attests only this file's deliberately selected synthetic corpus.
// It is not a general transcript sanitizer and accepts no user input.
const selectedTexts = new Set(edgeCases.map(entry => entry[2]));

/** Opt-in composition smoke. Only fixed synthetic texts may reach the judge. */
export async function checkPersistedJev(judge, { timeoutMs = 15_000 } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vh-jev-ingress-')));
  const folder = join(root, 'synthetic-project'); mkdirSync(folder);
  const authority = new LocalCredentialAuthority();
  let store;
  try {
    const context = localContext(authority), filePath = join(root, 'domain.sqlite');
    migrateDomainStore({ filePath });
    const options = { filePath, authority,
      namespaces: [INGRESS_NAMESPACE, ACTIVATION_NAMESPACE, GIT_ENROLLMENT_NAMESPACE] };
    const open = () => {
      store = new DomainStore(options);
      return new DurableIngress({ store, authority,
        snapshotPolicy: ({ text }) => selectedTexts.has(text) ? text : null });
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
    for (const [sequence, [id, , text]] of edgeCases.entries()) {
      const event = { schema_version: 1, kind: 'raw_event',
        event_id: ingress.eventIdFor(context, { registration_id, idempotency_key: id }),
        partition, source_native_event_id: id, idempotency_key: id, source_event_type: 'message',
        occurred_at: NOW, observed_at: NOW, producer: { ...producer, sequence }, causal_parents: [], identity: {},
        payload: { kind: 'snapshot', snapshot_id: id, digest: digest(text) },
        provenance: { delivery: { channel: 'system', delivery_id: id }, source_objects: [] },
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
    let materialized = 0;
    const report = await checkSyntheticJev({ async evaluate(input, request) {
      const observation = observations.get(input.event.payload.text);
      if (!observation) throw new Error('Unexpected synthetic input');
      const retained = ingress.readEvent(context, { event_id: observation.event.event_id });
      const snapshot = ingress.readSnapshot(context, { event_id: observation.event.event_id });
      if (!retained || !snapshot || snapshot.text !== input.event.payload.text
        || snapshot.digest !== observation.event.payload.digest) throw new Error('Synthetic snapshot mismatch');
      verifyEventPayload(retained.event.payload, Buffer.from(snapshot.text, 'utf8'));
      materialized++;
      // Do not spread the persisted envelope: source IDs, ACL, paths, catalog,
      // receipt, provenance, digest and labels have no role in model input.
      return judge.evaluate({ event: { type: retained.event.event_type,
        timestamp: retained.event.observed_at, payload: { text: snapshot.text } },
      stateRefs: input.stateRefs, question: input.question }, request);
    } }, { suite: 'edge', timeoutMs });
    return { ...report, dataset: 'persisted-synthetic-edge-eight-v1',
      ingress: { stored: observations.size, reopened: true, deduplicated, materialized,
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
      const report = await checkPersistedJev(judge);
      console.log(JSON.stringify({ ...report, operational: judge.snapshot() }, null, 2));
      if (report.completed !== report.total || report.matched !== report.total) process.exitCode = 1;
    } catch { console.error('Persisted JEV check failed. No raw source or provider error is printed.'); process.exitCode = 1; }
  }
}
