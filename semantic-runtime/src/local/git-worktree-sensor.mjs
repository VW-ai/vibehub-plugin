import { isProxy } from 'node:util/types';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { DomainStore } from './domain-store.mjs';
import { AccessAuthority, LOCAL_AUDIENCE } from '../domain/identity/access-authority.mjs';
import { GitProjectRegistry } from './git-projects.mjs';
import { ProjectActivation } from './project-activation.mjs';
import { DurableIngress } from './durable-ingress.mjs';
import { observeGitWorktree } from '../adapters/git-worktree-observer.mjs';
import { canonical } from '../core/contracts.mjs';
import { GIT_SENSOR_LIMITS as L, SENSOR_CODES, sensorInput, sensorFields, sensorId,
  sensorAssert as check, sensorError, validateGitWorktreeObservation } from '../core/git-worktree-observation.mjs';
export const GIT_SENSOR_ERROR_CODES = SENSOR_CODES;
const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const copy = v => JSON.parse(JSON.stringify(v));
const same = (a, b) => canonical(a) === canonical(b);
const scope = g => JSON.stringify([g.tenant_id, g.project_id, g.principal_id]);
const retryable = new Set(['store_busy', 'store_closed', 'store_unavailable']);
const normalizedCode = error => {
  if (isProxy(error)) return 'delivery_failed';
  const descriptor = error && Object.getOwnPropertyDescriptor(error, 'code'), code = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : null;
  if (SENSOR_CODES.includes(code)) return code;
  if (['ingress_unauthorized', 'activation_unauthorized', 'unauthorized', 'store_unauthorized'].includes(code)) return 'sensor_unauthorized';
  if (['source_disabled', 'source_tombstoned', 'source_access_denied', 'source_invalidated'].includes(code)) return 'source_access_denied';
  return 'delivery_failed';
};
const add = (object, key, count = 1) => { object[key] = Math.min(Number.MAX_SAFE_INTEGER, (object[key] ?? 0) + count); };
const gap = b => ({ preceding_interval: 'unknown', reasons: Object.entries(b.gaps).sort(([a], [z]) => a.localeCompare(z)).map(([code, count]) => ({ code, count })) });

/** Callable capture adapter. No watcher, listener, producer enrollment, model or durable queue. */
export class LocalGitWorktreeSensor {
  #authority; #registry; #activation; #ingress; #clock; #lastClock = 0; #bindings = new Map(); #pending = null;
  #closed = false; #running = false; #abort = null; #approval = null;
  constructor({ store, authority, monotonicNow = () => performance.now() }) {
    check(store instanceof DomainStore && authority instanceof AccessAuthority && typeof monotonicNow === 'function');
    this.#authority = authority; this.#clock = monotonicNow;
    this.#registry = new GitProjectRegistry({ store, authority }); this.#activation = new ProjectActivation({ store, authority });
    this.#ingress = new DurableIngress({ store, authority, snapshotPolicy: ({ text, event }) =>
      this.#approval?.text === text && this.#approval.event_id === event.event_id ? text : null });
  }
  #time() { const value = this.#clock(); check(Number.isFinite(value) && value >= 0); this.#lastClock = Math.max(value, this.#lastClock); return this.#lastClock; }
  #grant(context, read = false) {
    const g = this.#authority.inspect(context), actions = read ? ['sensor:read', 'store:read', 'ingress:read']
      : ['sensor:capture', 'ingress:read', 'ingress:submit', 'store:read', 'store:write', 'project:inspect', 'activation:read', 'activation:admit'];
    check(g && g.audience === LOCAL_AUDIENCE && actions.every(a => g.actions.includes(a)), 'sensor_unauthorized'); return g;
  }
  #options(value) { const v = sensorInput(value, 4096); sensorFields(v, ['registration_id']); check(sensorId(v.registration_id)); return v; }
  #binding(context, id, read = false) { const g = this.#grant(context, read), b = this.#bindings.get(id);
    check(b && b.scope === scope(g), 'unknown_binding'); return { g, b }; }
  #selected(context, id) {
    const g = this.#grant(context), source = this.#ingress.getSource(context, { registration_id: id }), r = source.registration;
    check(r.producer_principal_id === g.principal_id && r.partition.tenant_id === g.tenant_id && r.partition.project_id === g.project_id
      && r.access.enabled && r.access.allow_snapshots && r.mapping.event_types.git_worktree_snapshot === 'GIT_DIFF' && r.execution, 'invalid_sensor_source');
    const catalog = this.#registry.get(context); check(catalog && catalog.value.installation_id === r.partition.source_installation_id, 'membership_gap');
    const checkout = catalog.value.checkouts.find(c => c.state === 'active' && c.checkout_id === r.execution.checkout_id && c.repository_id === r.execution.repository_id);
    const worktree = checkout?.worktrees.find(w => w.state === 'active' && w.status === 'available' && w.worktree_id === r.execution.worktree_id);
    check(worktree && worktree.git_dir && worktree.identity, 'membership_gap');
    return { g, source, catalog, checkout, worktree, activation: this.#activation.get(context) };
  }
  bind(context, options) {
    check(!this.#closed, 'sensor_closed'); const { registration_id } = this.#options(options), selected = this.#selected(context, registration_id);
    const prior = this.#bindings.get(registration_id); check(!prior || prior.scope === scope(selected.g), 'sensor_unauthorized');
    check(prior || this.#bindings.size < L.bindings, 'binding_limit');
    if (!prior) this.#bindings.set(registration_id, { registration_id, scope: scope(selected.g), hint: null, lastSignature: null, lastReceipt: null,
      lastEpoch: selected.activation.state.epoch, stopped: null, gaps: { process_start: 1 }, counters: {}, identity: copy(selected.source.registration.execution) });
    return { registration_id, ...selected.source.registration.execution, state: 'bound' };
  }
  hint(options) {
    const { registration_id } = this.#options(options); if (this.#closed) return { status: 'ignored' };
    const b = this.#bindings.get(registration_id); if (!b) return { status: 'ignored' };
    const now = this.#time(), coalesced = b.hint !== null;
    if (b.hint) b.hint.last = now; else b.hint = { first: now, last: now };
    add(b.counters, 'hints'); return { status: coalesced ? 'coalesced' : 'queued' };
  }
  status(context, options) {
    const { registration_id } = this.#options(options); this.#grant(context, true);
    if (this.#closed) { this.#ingress.getSource(context, { registration_id }); return { registration_id, state: 'closed', pending_event_id: null, last_receipt_event_id: null,
      gap_summary: { preceding_interval: 'unknown', reasons: [] }, counters: {} }; }
    const { b } = this.#binding(context, registration_id, true); this.#ingress.getSource(context, { registration_id });
    return { registration_id, state: this.#pending?.binding === b ? 'pending' : 'bound', pending_event_id: this.#pending?.binding === b ? this.#pending.event.event_id : null,
      last_receipt_event_id: b.lastReceipt, gap_summary: gap(b), counters: copy(b.counters) };
  }
  #drop(b, code, unknown = false) {
    add(b.gaps, code); add(b.counters, 'gaps');
    if (['cursor_capacity', 'ingress_capacity'].includes(code)) { b.stopped = code; b.counters.capacity_stopped = 1; }
    if (this.#pending?.binding === b) { this.#pending = null; this.#approval = null; }
    return { registration_id: b.registration_id, status: 'gap', code: unknown ? 'delivery_unknown' : code };
  }
  #done(pending, receipt, status) {
    const b = pending.binding; b.lastSignature = pending.signature; b.lastReceipt = receipt.event_id; b.gaps = {}; add(b.counters, 'accepted');
    this.#pending = null; this.#approval = null; return { registration_id: b.registration_id, status, event_id: receipt.event_id, receipt };
  }
  #deliver(context) {
    const p = this.#pending, b = p.binding;
    try {
      this.#binding(context, b.registration_id); // Never reconcile another actor's pending observation.
      p.attempts++;
      const prior = this.#ingress.getReceipt(context, { event_id: p.event.event_id });
      if (prior) {
        const captured = this.#ingress.readEvent(context, { event_id: p.event.event_id });
        const snapshot = this.#ingress.readSnapshot(context, { event_id: p.event.event_id });
        check(same(captured.raw, p.event) && snapshot?.text === p.text && prior.activation_epoch === p.epoch, 'delivery_failed');
        return this.#done(p, prior, 'duplicate');
      }
      p.unknown = false; // A successful current receipt lookup established non-admission at this read.
      const s = this.#selected(context, b.registration_id);
      if (!s.activation.state.enabled) return this.#drop(b, 'project_disabled');
      if (s.activation.state.epoch !== p.epoch) return this.#drop(b, 'stale_activation_epoch');
      if (s.source.version !== p.sourceVersion || s.catalog.version !== p.catalogVersion) return this.#drop(b, 'source_changed');
      check(!this.#closed, 'sensor_closed'); this.#approval = { text: p.text, event_id: p.event.event_id };
      try { const result = this.#ingress.submit(context, { registration_id: b.registration_id, epoch: p.epoch, event: p.event, snapshot_text: p.text });
        return this.#done(p, result.receipt, result.status); } finally { this.#approval = null; }
    } catch (e) {
      const code = normalizedCode(e);
      if (retryable.has(code)) { p.unknown = true; if (p.attempts < L.submit_attempts) return { registration_id: b.registration_id, status: 'pending', event_id: p.event.event_id, code };
        return this.#drop(b, 'retry_exhausted', true); }
      return this.#drop(b, code, p.unknown || code === 'delivery_failed');
    }
  }
  async #capture(context, b) {
    let selected;
    try {
      if (b.stopped) return { registration_id: b.registration_id, status: 'paused', code: b.stopped };
      selected = this.#selected(context, b.registration_id); const epoch = selected.activation.state.epoch;
      if (b.lastEpoch !== epoch) { add(b.gaps, 'stale_activation_epoch'); b.lastEpoch = epoch; b.lastSignature = null; }
      if (!selected.activation.state.enabled) { add(b.gaps, 'project_disabled'); return { registration_id: b.registration_id, status: 'paused', code: 'project_disabled' }; }
      const guard = () => {
        check(!this.#closed, 'capture_cancelled'); const s = this.#selected(context, b.registration_id);
        check(s.activation.state.enabled, 'project_disabled'); check(s.activation.state.epoch === epoch, 'stale_activation_epoch');
        check(s.source.version === selected.source.version && s.catalog.version === selected.catalog.version, 'source_changed');
      };
      this.#abort = new AbortController(); const start = new Date().toISOString();
      const { observation, metrics } = await observeGitWorktree({ checkout: selected.checkout, worktree: selected.worktree, guard, signal: this.#abort.signal }); guard();
      for (const [key, value] of Object.entries(metrics)) add(b.counters, key, Math.ceil(value));
      const ref = selected.checkout.refs.find(r => r.state === 'active' && r.oid === observation.head.oid
        && Buffer.from(r.name).toString('base64') === observation.head.branch_base64);
      const metadata = { schema_version: 1, kind: 'git_worktree_snapshot', comparison_profile: 'isolated-raw-v1', observed_at: new Date().toISOString(), capture_started_at: start,
        catalog: { version: selected.catalog.version, source_ref: `catalog-v${selected.catalog.version}` },
        identity: { ...copy(selected.source.registration.execution), source_installation_id: selected.catalog.value.installation_id }, ...observation,
        mapping: { host_session: 'unknown', execution: 'unknown', exploration: 'unmapped', ref_incarnation_id: ref?.ref_incarnation_id ?? null, ref_assurance: ref ? 'catalog_observed' : 'unmapped' },
        consistency: 'observed_stable_endpoints', gap_summary: gap(b) };
      validateGitWorktreeObservation(metadata);
      const { observed_at, capture_started_at, gap_summary, ...semantic } = metadata;
      const signature = hash(canonical({ semantic, source_version: selected.source.version, epoch }));
      if (b.lastSignature === signature && gap_summary.reasons.length === 0) return { registration_id: b.registration_id, status: 'unchanged' };
      const text = canonical(metadata); check(Buffer.byteLength(text) <= L.snapshot_bytes, 'capture_limit');
      const key = `git-snapshot-${randomUUID()}`, r = selected.source.registration;
      const acl = { revision: `source-access-${selected.source.version}`, allowed_principal_ids: [...r.access.allowed_principal_ids] }, sensitivity = r.access.sensitivity;
      const supports = [{ object: { kind: 'source_object', tenant_id: selected.g.tenant_id, provider: 'vibehub', authority: 'local', object_id: `git-worktree:${r.execution.worktree_id}` }, acl, sensitivity }];
      if (metadata.head.oid) supports.push({ object: { kind: 'git_commit', tenant_id: selected.g.tenant_id, repository_id: r.execution.repository_id, object_format: metadata.head.object_format, oid: metadata.head.oid }, acl, sensitivity });
      const event = { schema_version: 1, kind: 'raw_event', event_id: this.#ingress.eventIdFor(context, { registration_id: b.registration_id, idempotency_key: key }),
        partition: copy(r.partition), source_native_event_id: null, idempotency_key: key, source_event_type: 'git_worktree_snapshot', occurred_at: null,
        observed_at, producer: { ...r.producer, sequence: null }, causal_parents: [], identity: copy(r.execution), payload: { kind: 'snapshot', snapshot_id: key, digest: hash(text) },
        provenance: { delivery: { channel: 'local_git', delivery_id: key }, source_objects: supports }, acl, sensitivity };
      this.#pending = { binding: b, text, event, signature, epoch, sourceVersion: selected.source.version, catalogVersion: selected.catalog.version, attempts: 0, unknown: false };
      return this.#deliver(context);
    } catch (e) { return this.#drop(b, normalizedCode(e)); }
    finally { this.#abort = null; }
  }
  async drain(context, options = { limit: 1 }) {
    const g = this.#grant(context); check(!this.#closed, 'sensor_closed'); const o = sensorInput(options, 4096); sensorFields(o, ['limit'], ['force']);
    check(Number.isSafeInteger(o.limit) && o.limit >= 1 && o.limit <= 4 && (o.force === undefined || typeof o.force === 'boolean'));
    check(!this.#running, 'sensor_busy'); this.#running = true;
    try {
      const results = [];
      if (this.#pending) { if (this.#pending.binding.scope !== scope(g)) return { status: 'idle', results, more_due: [...this.#bindings.values()].some(b => b.scope === scope(g) && b.hint) };
        results.push(this.#deliver(context)); if (this.#pending) return { status: 'drained', results, more_due: true }; }
      for (const b of this.#bindings.values()) {
        if (b.scope !== scope(g) || !b.hint || results.length >= o.limit) continue;
        const now = this.#time(); if (!o.force && now - b.hint.last < L.debounce_ms && now - b.hint.first < L.maximum_wait_ms) continue;
        b.hint = null; results.push(await this.#capture(context, b)); if (this.#pending || this.#closed) break;
      }
      const more_due = Boolean(this.#pending?.binding.scope === scope(g) || [...this.#bindings.values()].some(b => b.scope === scope(g) && b.hint));
      return { status: results.length ? results.every(r => r.status === 'paused') ? 'paused' : 'drained' : 'idle', results, more_due };
    } finally { this.#running = false; }
  }
  close() { if (this.#closed) return; this.#closed = true; this.#abort?.abort(); this.#pending = null; this.#approval = null; this.#bindings.clear(); }
}
