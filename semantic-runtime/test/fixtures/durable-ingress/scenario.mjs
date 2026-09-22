import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DomainStore, migrateDomainStore, LocalCredentialAuthority, LOCAL_AUDIENCE, scopedReference,
  GitProjectRegistry, ProjectActivation, DurableIngress, INGRESS_NAMESPACE } from '../../../src/index.mjs';

export const NS = INGRESS_NAMESPACE;
export const WORK = 'fixture-ingress-consumer';
export const SCOPE = { tenant_id: 'acme', project_id: 'product' };
export const ACTIONS = ['ingress:register', 'ingress:read', 'ingress:submit', 'ingress:handoff',
  'activation:read', 'activation:write', 'activation:admit', 'project:inspect', 'project:enroll', 'store:read', 'store:write'];
export const digest = text => `sha256:${createHash('sha256').update(text).digest('hex')}`;
export const clone = value => structuredClone(value);
export function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'core.hooksPath=/dev/null', '-c', 'init.templateDir=', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
}
export function connect(filePath, { snapshotPolicy = ({ text }) => text, clock = { now: 1000 } } = {}) {
  const authority = new LocalCredentialAuthority({ now: () => clock.now });
  const issue = ({ actions = ACTIONS, scope = SCOPE, principal = 'owner', kind = 'service', ttl_ms = 60000 } = {}) => {
    const issued = authority.issue({ principal_id: principal, kind, scope, actions, ttl_ms });
    const { context, allowed } = authority.authorize(issued.credential, { scope, audience: LOCAL_AUDIENCE,
      action: actions[0], kinds: [kind], boundary: 'http', reference: scopedReference('http', scope, 'ingress') });
    assert(allowed); return { context, issued };
  };
  const store = new DomainStore({ filePath, authority, namespaces: [NS, WORK, 'git-enrollment', 'project-activation', 'source-invalidation'] });
  return { filePath, clock, authority, issue, store, ...issue(),
    ingress: new DurableIngress({ store, authority, snapshotPolicy, now: () => clock.now }),
    activation: new ProjectActivation({ store, authority, now: () => clock.now }), registry: new GitProjectRegistry({ store, authority }) };
}
export function fixture(t, options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vh-ingress-'))), folder = join(root, 'synthetic project'); mkdirSync(folder);
  git(folder, 'init', '--initial-branch=main'); writeFileSync(join(folder, 'fixture.txt'), 'selected synthetic source\n');
  git(folder, 'add', 'fixture.txt'); git(folder, 'commit', '-m', 'synthetic initial');
  const filePath = join(root, 'domain.sqlite'); migrateDomainStore({ filePath });
  const f = { root, folder, ...connect(filePath, options) }, handles = [f.store];
  f.reopen = (settings = {}) => { const next = connect(filePath, { ...options, ...settings }); handles.push(next.store); return next; };
  f.registry.enroll(f.context, { folder, expectedVersion: null });
  if (options.enable !== false) f.activation.setEnabled(f.context, { enabled: true, expectedVersion: null });
  t.after(() => { handles.forEach(store => store.close()); rmSync(root, { recursive: true, force: true }); }); return f;
}
export function sourceInput(f, overrides = {}) {
  const catalog = f.registry.get(f.context).value;
  return { partition: { ...SCOPE, source_installation_id: catalog.installation_id, partition_id: 'selected-text' },
    producer: { producer_id: 'fixture-adapter', epoch: 'start-1' }, producer_principal_id: 'owner', start_sequence: 0,
    mapping: { schema_version: 1, mapping_id: 'selected-text', revision: 'mapping-1',
      event_types: { 'user.note': 'USER_INTENT', 'git.commit': 'GIT_COMMIT' } },
    access: { enabled: true, allowed_principal_ids: ['owner', 'reader'], sensitivity: 'normal', allow_snapshots: true }, ...overrides };
}
export function register(f, overrides = {}) { return f.ingress.registerSource(f.context, sourceInput(f, overrides)); }
export function observation(f, source, { sequence = 0, key = `retry-${sequence}`, text = 'Selected synthetic decision.',
  snapshot = true, ...changes } = {}) {
  const registration = source.registration;
  const event = { schema_version: 1, kind: 'raw_event',
    event_id: f.ingress.eventIdFor(f.context, { registration_id: source.registration_id, idempotency_key: key }),
    partition: clone(registration.partition), source_native_event_id: `native-${key}`, idempotency_key: key,
    source_event_type: 'user.note', occurred_at: null, observed_at: '2026-09-22T10:00:00.000Z',
    producer: { ...registration.producer, sequence }, causal_parents: [], identity: clone(registration.execution ?? {}),
    payload: snapshot ? { kind: 'snapshot', snapshot_id: `snapshot-${key}`, digest: digest(text) }
      : { kind: 'mutable_pointer', pointer_id: `pointer-${key}`, digest: null },
    provenance: { delivery: { channel: 'host', delivery_id: `delivery-${key}` }, source_objects: [] },
    acl: { revision: 'captured-1', allowed_principal_ids: ['owner', 'reader'] }, sensitivity: 'normal', ...changes };
  return { registration_id: source.registration_id, epoch: 1, event, ...(snapshot ? { snapshot_text: text } : {}) };
}
export function execution(f) {
  const checkout = f.registry.get(f.context).value.checkouts[0];
  return { repository_id: checkout.repository_id, checkout_id: checkout.checkout_id,
    worktree_id: checkout.worktrees.find(item => item.state === 'active').worktree_id };
}
export function counts(f) {
  return { sources: f.store.sourceCounts(f.context, NS), pending: f.store.pendingOutbox(f.context, NS) };
}
export function effect(tx, { event }, value = 'committed') {
  tx.compareAndSwap(WORK, event.event_id, null, { value });
  tx.appendSource(WORK, event.event_id, 'consumer-effect', { event_id: event.event_id, value });
}
export function rejected(call, expectedCode) {
  assert.throws(call, error => {
    assert.equal(error.category, 'rejected');
    assert.match(error.code, /^[a-z][a-z_]+$/);
    if (expectedCode) assert.equal(error.code, expectedCode);
    return true;
  });
}
