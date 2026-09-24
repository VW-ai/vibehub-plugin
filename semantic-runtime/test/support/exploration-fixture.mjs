import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DomainStore, migrateDomainStore, LocalCredentialAuthority, LOCAL_AUDIENCE, scopedReference,
  GitProjectRegistry, ProjectActivation, DurableIngress, LocalGraphStore, LocalExplorationStore,
  EXPLORATION_NAMESPACE, SourceInvalidationFeed } from '../../src/index.mjs';
import { CanonicalSourceReader } from '../../src/application/sources/canonical-source-reader.mjs';
import { records, writeRecords, READER_ACTIONS } from './canonical-reader-fixture.mjs';
import { git, SCOPE, register, capture, assertion } from './graph-store-fixture.mjs';

export const ACTIONS = [...READER_ACTIONS, 'exploration:read', 'exploration:write'];
export const NAMESPACES = ['working-graph', 'git-enrollment', 'project-activation', 'durable-ingress', 'source-invalidation', 'exploration-projection'];

// Independent fixture composition: the pre-existing Graph fixture stays unchanged.
export function connect(filePath, canonical_reader = null, { clock = { now: 1000 }, namespaces = NAMESPACES } = {}) {
  const authority = new LocalCredentialAuthority({ now: () => clock.now });
  const issue = ({ principal = 'owner', actions = ACTIONS, kind = 'service', scope = SCOPE, ttl_ms = 3600000 } = {}) => {
    const issued = authority.issue({ principal_id: principal, kind, scope, actions, ttl_ms });
    const granted = authority.authorize(issued.credential, { scope, audience: LOCAL_AUDIENCE, action: actions[0], kinds: [kind],
      boundary: 'object', reference: scopedReference('object', scope, 'exploration-test') });
    assert(granted.allowed); return { context: granted.context, issued };
  };
  const store = new DomainStore({ filePath, authority, namespaces });
  const f = { filePath, clock, authority, issue, store, ...issue(),
    graph: new LocalGraphStore({ store, authority }), registry: new GitProjectRegistry({ store, authority }),
    activation: new ProjectActivation({ store, authority }), ingress: new DurableIngress({ store, authority, snapshotPolicy: ({ text }) => text }),
    feed: new SourceInvalidationFeed({ store, authority }) };
  if (canonical_reader) {
    f.config = canonical_reader;
    f.reader = new CanonicalSourceReader({ store, authority, ...canonical_reader });
    f.explorations = new LocalExplorationStore({ store, authority, canonical_reader });
  }
  return f;
}

export function executionFor(f, path = f.folder) {
  const catalog = f.registry.get(f.context), checkout = catalog.value.checkouts.find(c => c.worktrees.some(w => w.path === path && w.state === 'active'));
  assert(checkout, 'the fixture path must belong to a real enrolled checkout');
  const worktree = checkout.worktrees.find(w => w.path === path && w.state === 'active');
  return { repository_id: checkout.repository_id, checkout_id: checkout.checkout_id, worktree_id: worktree.worktree_id };
}

export function fixture(t, { unborn = false, values = records(), canonical = false } = {}) {
  assert.equal(EXPLORATION_NAMESPACE, 'exploration-projection');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vh-exploration-'))), folder = join(root, 'selected-project'); mkdirSync(folder);
  git(folder, 'init', '--initial-branch=main');
  writeRecords(folder, values); mkdirSync(join(folder, 'src')); writeFileSync(join(folder, 'src/api.mjs'), 'export const synthetic = true;\n');
  if (!unborn) { git(folder, 'add', '.'); git(folder, 'commit', '-m', 'synthetic selected canonical records'); }
  const filePath = join(root, 'domain.sqlite'); migrateDomainStore({ filePath });
  const f = { root, folder, ...connect(filePath) }, handles = [f];
  t.after(() => { for (const h of handles) { h.store.close(); h.authority.close(); } rmSync(root, { recursive: true, force: true }); });
  f.registry.enroll(f.context, { folder, expectedVersion: null });
  f.execution = executionFor(f);
  f.epoch = f.activation.setEnabled(f.context, { enabled: true, expectedVersion: null }).state.epoch;
  f.publisher = f.graph.registerPublisherRun(f.context, { epoch: f.epoch, run_key: 'synthetic-exploration-run' });
  const catalog = f.registry.get(f.context);
  f.canonicalSource = f.ingress.registerSource(f.context, { partition: { ...SCOPE, source_installation_id: catalog.value.installation_id, partition_id: 'canonical-records' },
    producer: { producer_id: 'canonical-reader', epoch: 'incarnation-1' }, producer_principal_id: 'owner', start_sequence: 0,
    mapping: { schema_version: 1, mapping_id: 'canonical-documents', revision: 'v1', event_types: { canonical_record: 'DOC_CHANGED', tombstone: 'SOURCE_TOMBSTONE', access: 'SOURCE_ACCESS_CHANGED' } },
    access: { enabled: true, allowed_principal_ids: ['owner', 'reader'], sensitivity: 'normal', allow_snapshots: false }, execution: f.execution });
  f.selection = { schema_profile: 'vibehub-records-v1', selection_id: 'selected-project-contract', policy_id: 'explicit-synthetic-policy-v1', object_format: 'sha1',
    records: Object.entries(values).map(([key, value]) => ({ key, kind: value.kind,
      id: value.context_id ?? value.room_id ?? value.evidence_id ?? value.outcome_id ?? value.ticket_id, path: `.vibehub/${key}.yaml` })) };
  f.config = { repository_path: folder, execution: f.execution, registration_id: f.canonicalSource.registration_id, selection: f.selection };
  f.reader = new CanonicalSourceReader({ store: f.store, authority: f.authority, ...f.config });
  f.explorations = new LocalExplorationStore({ store: f.store, authority: f.authority, canonical_reader: f.config });
  f.reopen = (options = {}) => { const next = connect(filePath, f.config, { clock: f.clock, ...options }); handles.push(next); return next; };
  f.refresh = (execution = f.execution) => f.registry.refresh(f.context, { checkout_id: execution.checkout_id, expectedVersion: f.registry.get(f.context).version });
  f.source = register(f); f.event = capture(f, f.source);
  f.captureCanonical = (prior = null, key = 'canonical-initial') => {
    if (!prior) f.canonicalGenesis = f.graph.initialize(f.context, { generation_id: 'canonical-generation', epoch: f.epoch,
      idempotency_key: 'canonical-genesis', publisher_ref: f.publisher.publisher_ref, coverage: [] });
    return f.reader.refresh(f.context, { epoch: f.epoch, publisher_ref: f.publisher,
      expected_graph: prior?.graph_revision ?? f.canonicalGenesis.receipt.next_graph, previous_selection: prior?.selection ?? null,
      commit_oid: git(folder, 'rev-parse', 'HEAD'), idempotency_key: key,
      observation: { observed_at: '2026-09-22T12:00:00.000Z', sequence_start: prior ? f.selection.records.length : 0 } });
  };
  if (canonical) f.canonical = f.captureCanonical();
  return f;
}

export const pin = (result, record_keys = ['decision']) => ({ at: result.graph_revision, address: result.address, record_keys });
export function bindRequest(f, { key = 'bind-initial', execution = f.execution, exploration_id = null, shared_base = null, ...extra } = {}) {
  const current = f.explorations.getBinding(f.context, { execution });
  return { epoch: f.epoch, idempotency_key: key, publisher_ref: f.publisher.publisher_ref, execution,
    expected_catalog_version: f.registry.get(f.context).version, expected_binding_version: current.binding_version,
    exploration_id, shared_base, ...extra };
}
export const bind = (f, options = {}) => f.explorations.bind(f.context, bindRequest(f, options));
export function mutation(f, binding, name = 'first', extra = {}) {
  return { epoch: f.epoch, idempotency_key: `mutate-${name}`, publisher_ref: f.publisher.publisher_ref,
    execution_workspace_id: binding.execution_workspace_id, expected_binding_version: binding.binding_version,
    expected_catalog_version: f.registry.get(f.context).version, expected_project_selection_version: null,
    expected_graph: binding.graph_revision, expected_source_fence: f.feed.head(f.context).sequence,
    operation: { kind: 'assert', assertion: assertion(f, f.event, name) }, coverage: null, ...extra };
}
export const resolve = (f, binding, result, extra = {}) => f.explorations.resolve(f.context, {
  exploration_id: binding.exploration_id, at: result.receipt.next_graph, address: result.revision, shared_keys: null, ...extra });
export function rows(f) {
  const db = new DatabaseSync(f.filePath, { readOnly: true });
  try { return Object.fromEntries(['records', 'sources', 'outbox'].map(table => [table,
    db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])); } finally { db.close(); }
}
export const rejected = operation => assert.throws(operation, error => typeof error.code === 'string' && /^[a-z_]+$/.test(error.code));
export { git, SCOPE, register, capture, assertion, records, writeRecords };
