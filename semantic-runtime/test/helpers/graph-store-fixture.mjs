import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DomainStore, migrateDomainStore, LocalCredentialAuthority, LOCAL_AUDIENCE, scopedReference,
  GitProjectRegistry, ProjectActivation, DurableIngress } from '../../src/index.mjs';
import { LocalGraphStore } from '../../src/local/graph-store.mjs';

export const SCOPE = { tenant_id: 'synthetic', project_id: 'graph-store' };
export const NS = 'working-graph';
export const ACTIONS = ['store:read', 'store:write', 'project:inspect', 'project:enroll', 'activation:read', 'activation:write', 'activation:admit',
  'ingress:register', 'ingress:read', 'ingress:submit', 'graph:read', 'graph:write', 'graph:publish', 'graph:lifecycle', 'graph:rebuild'];
export const hashText = text => `sha256:${createHash('sha256').update(text).digest('hex')}`;
export function git(folder, ...args) {
  return execFileSync('git', ['-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'init.templateDir=', ...args],
    { cwd: folder, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: folder, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
}
export function connect(filePath, { clock = { now: 1000 } } = {}) {
  const authority = new LocalCredentialAuthority({ now: () => clock.now });
  const issue = ({ principal = 'owner', actions = ACTIONS, kind = 'service', scope = SCOPE, ttl_ms = 3600000 } = {}) => {
    const issued = authority.issue({ principal_id: principal, kind, scope, actions, ttl_ms });
    const result = authority.authorize(issued.credential, { scope, audience: LOCAL_AUDIENCE, action: actions[0], kinds: [kind], boundary: 'object', reference: scopedReference('object', scope, 'graph-test') });
    assert(result.allowed); return { context: result.context, issued };
  };
  const store = new DomainStore({ filePath, authority, namespaces: [NS, 'git-enrollment', 'project-activation', 'durable-ingress'] });
  return { filePath, clock, authority, issue, store, ...issue(), graph: new LocalGraphStore({ store, authority }),
    ingress: new DurableIngress({ store, authority, snapshotPolicy: ({ text }) => text }),
    registry: new GitProjectRegistry({ store, authority }), activation: new ProjectActivation({ store, authority }) };
}
export function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vh-real-graph-'))), folder = join(root, 'synthetic-project'); mkdirSync(folder);
  git(folder, 'init', '--initial-branch=main'); writeFileSync(join(folder, 'fixture.txt'), 'Synthetic source only.\n');
  git(folder, 'add', 'fixture.txt'); git(folder, 'commit', '-m', 'synthetic initial');
  const filePath = join(root, 'domain.sqlite'); migrateDomainStore({ filePath });
  const f = { root, folder, ...connect(filePath) }, handles = [f];
  f.reopen = () => { const next = connect(filePath); handles.push(next); return next; };
  t.after(() => { for (const h of handles) { h.store.close(); h.authority.close(); } rmSync(root, { recursive: true, force: true }); });
  f.registry.enroll(f.context, { folder, expectedVersion: null });
  f.epoch = f.activation.setEnabled(f.context, { enabled: true, expectedVersion: null }).state.epoch;
  f.publisher = f.graph.registerPublisherRun(f.context, { epoch: f.epoch, run_key: 'synthetic-run' });
  return f;
}
export function register(f, { partition = 'selected-events', principals = ['owner', 'reader'], producerEpoch = 'epoch-1', ...other } = {}) {
  const catalog = f.registry.get(f.context).value;
  return f.ingress.registerSource(f.context, { partition: { ...SCOPE, source_installation_id: catalog.installation_id, partition_id: partition },
    producer: { producer_id: 'synthetic-adapter', epoch: producerEpoch }, producer_principal_id: 'owner', start_sequence: 0,
    mapping: { schema_version: 1, mapping_id: 'selected-events', revision: 'v1', event_types: { note: 'USER_INTENT', access: 'SOURCE_ACCESS_CHANGED', tombstone: 'SOURCE_TOMBSTONE' } },
    access: { enabled: true, allowed_principal_ids: principals, sensitivity: 'normal', allow_snapshots: true }, ...other });
}
export function capture(f, source, { sequence = 0, key = `event-${sequence}`, type = 'note', text = 'Selected synthetic context.', principals = ['owner', 'reader'], objectId = 'decision-source', sensitivity = 'normal' } = {}) {
  const acl = { revision: `acl-${key}`, allowed_principal_ids: principals };
  const event = { schema_version: 1, kind: 'raw_event',
    event_id: f.ingress.eventIdFor(f.context, { registration_id: source.registration_id, idempotency_key: key }),
    partition: source.registration.partition, source_native_event_id: key, idempotency_key: key, source_event_type: type,
    occurred_at: null, observed_at: '2026-09-22T12:00:00.000Z', producer: { ...source.registration.producer, sequence }, causal_parents: [], identity: {},
    payload: { kind: 'snapshot', snapshot_id: key, digest: hashText(text) },
    provenance: { delivery: { channel: 'system', delivery_id: key }, source_objects: [{ object: { kind: 'source_object', tenant_id: SCOPE.tenant_id, provider: 'vibehub', authority: 'local', object_id: objectId }, acl, sensitivity }] }, acl, sensitivity };
  f.ingress.submit(f.context, { registration_id: source.registration_id, epoch: f.epoch, event, snapshot_text: text });
  return f.ingress.readEvent(f.context, { event_id: event.event_id }).event;
}
export function initialize(f, coverage = [], generation_id = 'generation-1') {
  return f.graph.initialize(f.context, { generation_id, epoch: f.epoch, idempotency_key: 'initialize', publisher_ref: f.publisher.publisher_ref, coverage });
}
export function assertion(f, event, name = 'first', overrides = {}) {
  return { schema_version: 1, assertion_id: `assert-${name}`, entity_kind: 'entity', entity_id: 'context-a', base_revision: null, parents: [],
    execution_id: f.publisher.execution_id, status: 'candidate', content: { semantic_type: 'decision', data: { text: `Synthetic ${name}` } }, events: [event], canonical_refs: [], ...overrides };
}
export function mutation(f, expected_graph, a, extras = {}) {
  return { epoch: f.epoch, idempotency_key: a.assertion_id, publisher_ref: f.publisher.publisher_ref, expected_graph, operation: { kind: 'assert', assertion: a }, coverage: null, ...extras };
}
export function rows(f) {
  const db = new DatabaseSync(f.filePath, { readOnly: true });
  try { return Object.fromEntries(['records', 'sources', 'outbox'].map(table => [table, db.prepare(`SELECT * FROM ${table} WHERE namespace=? ORDER BY rowid`).all(NS)])); }
  finally { db.close(); }
}
