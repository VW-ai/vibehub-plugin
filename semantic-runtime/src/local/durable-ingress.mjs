import { randomUUID } from 'node:crypto';
import { DomainStore } from './domain-store.mjs';
import { LocalCredentialAuthority, LOCAL_AUDIENCE } from './auth.mjs';
import { GitProjectRegistry } from './git-projects.mjs';
import { ProjectActivation } from './project-activation.mjs';
import { canonical, fingerprint } from '../core/contracts.mjs';
import { EVENT_TYPES, validateRawEvent, normalizeRawEvent, effectiveEventAccess,
  verifyEventPayload, eventIdempotencyKey } from '../core/event-provenance.mjs';
import { sourcePartitionKey, sourceEventFingerprint, createSourceCursor, acceptSourceEvent } from '../core/causal-ordering.mjs';

export const INGRESS_NAMESPACE = 'durable-ingress';
const NS = INGRESS_NAMESPACE;
const levels = ['normal', 'sensitive', 'restricted'];
const ownCodes = new Set(['ingress_unauthorized', 'invalid_ingress_input', 'unknown_source', 'duplicate_source',
  'source_disabled', 'source_access_denied', 'source_changed', 'source_mismatch', 'invalid_event_identity',
  'unmapped_event', 'invalid_event', 'sanitization_required', 'invalid_snapshot', 'snapshot_conflict',
  'observation_conflict', 'cursor_capacity', 'ingress_capacity', 'missing_event', 'corrupt_ingress_state',
  'async_ingress_callback', 'consumer_failed', 'project_disabled', 'stale_activation_epoch']);
const upstreamCodes = new Set(['activation_unauthorized', 'invalid_activation_input', 'invalid_activation_state',
  'project_not_enrolled', 'invalid_execution_membership', 'async_activation_callback', 'project_unauthorized',
  'store_closed', 'store_busy', 'store_unavailable', 'store_unauthorized', 'invalid_store_input',
  'unknown_namespace', 'cas_conflict', 'duplicate_identity', 'async_transaction', 'stale_transaction',
  'nested_transaction', 'migration_required', 'incompatible_store']);
const retryable = new Set(['store_busy', 'store_unavailable', 'store_closed', 'consumer_failed']);
const fail = code => Object.assign(new Error(`Durable ingress: ${code}`), {
  code, category: retryable.has(code) ? 'retryable_failure' : 'rejected' });
const assert = (condition, code = 'invalid_ingress_input') => { if (!condition) throw fail(code); };
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const equal = (a, b) => canonical(a) === canonical(b);
const hash = value => `sha256:${fingerprint(value)}`;
const key = (kind, value) => `${kind}-${fingerprint(value)}`;
const copy = value => JSON.parse(canonical(value));
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
// Validate descriptors before copying: caller getters/toJSON never run.
function input(value, maximum = 131072) {
  let count = 0; const ancestors = new Set();
  function visit(item, depth) {
    assert(++count <= 25000 && depth <= 16, 'ingress_capacity');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return;
    if (typeof item === 'number') { assert(Number.isFinite(item)); return; }
    assert((plain(item) || Array.isArray(item) && Object.getPrototypeOf(item) === Array.prototype) && !ancestors.has(item));
    assert(!Object.getOwnPropertySymbols(item).length);
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (Array.isArray(item) && name === 'length') continue;
      assert(Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
      assert(!Array.isArray(item) || /^(0|[1-9]\d*)$/.test(name) && Number(name) < item.length);
    }
    if (Array.isArray(item)) assert(Object.keys(item).length === item.length);
    ancestors.add(item); Object.values(item).forEach(child => visit(child, depth + 1)); ancestors.delete(item);
  }
  visit(value, 0); const encoded = canonical(value);
  assert(Buffer.byteLength(encoded) <= maximum, 'ingress_capacity'); return JSON.parse(encoded);
}
function fields(value, required, optional = []) {
  assert(plain(value) && required.every(k => Object.hasOwn(value, k))
    && Object.keys(value).every(k => required.includes(k) || optional.includes(k)));
}
function access(value) {
  fields(value, ['enabled', 'allowed_principal_ids', 'sensitivity', 'allow_snapshots']);
  assert(typeof value.enabled === 'boolean' && typeof value.allow_snapshots === 'boolean' && levels.includes(value.sensitivity));
  assert(Array.isArray(value.allowed_principal_ids) && value.allowed_principal_ids.length <= 128
    && value.allowed_principal_ids.every(id) && new Set(value.allowed_principal_ids).size === value.allowed_principal_ids.length);
}
function mapping(value) {
  fields(value, ['schema_version', 'mapping_id', 'revision', 'event_types']);
  assert(value.schema_version === 1 && id(value.mapping_id) && id(value.revision) && plain(value.event_types)
    && Object.keys(value.event_types).length <= 128);
  for (const [native, type] of Object.entries(value.event_types)) assert(id(native) && EVENT_TYPES.includes(type));
}
function execution(value) {
  if (value === undefined) return;
  fields(value, ['repository_id', 'checkout_id', 'worktree_id']); assert(Object.values(value).every(id));
}
const sourceKey = source => key('stream', sourcePartitionKey(source));
const registrationKey = registration_id => key('registration', registration_id);
const cursorKey = registration => key('cursor', sourcePartitionKey(registration));
const eventKey = event_id => key('event', event_id);
const handoffKey = event_id => key('handoff', event_id);
const outboxKey = event_id => key('pending', event_id);

/** Local durable intake. Trusted callbacks may compose writes, never network/model work. */
export class DurableIngress {
  #store; #authority; #registry; #activation; #policy; #now;
  constructor({ store, authority, snapshotPolicy, now = () => Date.now() }) {
    assert(store instanceof DomainStore && authority instanceof LocalCredentialAuthority
      && (snapshotPolicy === undefined || typeof snapshotPolicy === 'function') && typeof now === 'function');
    this.#store = store; this.#authority = authority; this.#policy = snapshotPolicy; this.#now = now;
    this.#registry = new GitProjectRegistry({ store, authority });
    this.#activation = new ProjectActivation({ store, authority, now });
  }
  #call(operation) {
    try { return operation(); } catch (error) {
      throw fail(ownCodes.has(error?.code) || upstreamCodes.has(error?.code) ? error.code : 'invalid_ingress_input');
    }
  }
  #grant(context, action, { write = false, owner = false, project = false } = {}) {
    const grant = this.#authority.inspect(context);
    assert(grant && grant.audience === LOCAL_AUDIENCE && grant.actions.includes(action)
      && grant.actions.includes('store:read') && (!write || grant.actions.includes('store:write'))
      && (!owner || ['human', 'service'].includes(grant.kind))
      && (!project || grant.actions.includes('project:inspect')), 'ingress_unauthorized');
    return grant;
  }
  #transaction(context, operation, admission) {
    let domainCode;
    const guarded = tx => { try { return operation(tx); } catch (error) {
      if (ownCodes.has(error?.code)) domainCode = error.code; throw error;
    } };
    try {
      if (!admission) return this.#store.transaction(context, guarded);
      const result = this.#activation.withAdmission(context, admission, guarded);
      if (!result.admitted) throw fail(result.reason);
      return result.value;
    } catch (error) { if (domainCode) throw fail(domainCode); throw error; }
  }
  #time() { const now = this.#now(); assert(integer(now)); return new Date(now).toISOString(); }
  #source(context, registration_id, tx) {
    assert(id(registration_id));
    const row = tx ? tx.getRecord(NS, registrationKey(registration_id))
      : this.#store.getRecord(context, NS, registrationKey(registration_id));
    assert(row, 'unknown_source'); return row;
  }
  #live(context, registration) {
    const grant = this.#authority.inspect(context), catalog = this.#registry.identityCatalog(context);
    assert(catalog && registration.partition.tenant_id === grant.tenant_id
      && registration.partition.project_id === grant.project_id
      && catalog.source_installations.some(s => s.source_installation_id === registration.partition.source_installation_id)
      && catalog.worktrees.length > 0, 'source_mismatch');
    if (registration.execution) {
      const e = registration.execution;
      assert(catalog.checkouts.some(c => c.checkout_id === e.checkout_id && c.repository_id === e.repository_id)
        && catalog.worktrees.some(w => w.worktree_id === e.worktree_id && w.checkout_id === e.checkout_id), 'source_mismatch');
    }
    return catalog;
  }
  #readAllowed(grant, registration, event) {
    assert(registration.access.allowed_principal_ids.includes(grant.principal_id)
      && (!event || event.effective_access.allowed_principal_ids.includes(grant.principal_id)
        && levels.indexOf(registration.access.sensitivity) <= levels.indexOf(event.effective_access.sensitivity)), 'source_access_denied');
  }
  #readFence(context, bundle) {
    const grant = this.#grant(context, 'ingress:read');
    this.#readAllowed(grant, this.#source(context, bundle.receipt.registration_id).value, bundle.event);
  }
  #writeAllowed(grant, registration, event, producer = false) {
    assert(registration.access.enabled, 'source_disabled');
    if (producer) assert(grant.principal_id === registration.producer_principal_id, 'ingress_unauthorized');
    const captured = effectiveEventAccess(event);
    assert(captured.allowed_principal_ids.every(p => registration.access.allowed_principal_ids.includes(p))
      && levels.indexOf(captured.sensitivity) >= levels.indexOf(registration.access.sensitivity), 'source_access_denied');
  }
  #stableSource(context, registration_id, version, tx, action, options) {
    this.#grant(context, action, options);
    assert(this.#source(context, registration_id, tx).version === version, 'source_changed');
  }
  registerSource(context, options) {
    return this.#call(() => {
      this.#grant(context, 'ingress:register', { write: true, owner: true, project: true });
      const value = input(options);
      fields(value, ['partition', 'producer', 'producer_principal_id', 'start_sequence', 'mapping', 'access'], ['execution']);
      assert(id(value.producer_principal_id)); mapping(value.mapping); access(value.access); execution(value.execution);
      let cursor;
      try { cursor = createSourceCursor({ partition: value.partition, producer: value.producer, start_sequence: value.start_sequence }); }
      catch { throw fail('invalid_ingress_input'); }
      return this.#transaction(context, tx => {
        this.#grant(context, 'ingress:register', { write: true, owner: true, project: true });
        this.#live(context, value);
        const stream = sourceKey(cursor.source);
        assert(!tx.getRecord(NS, stream), 'duplicate_source');
        const registration_id = `source-${randomUUID()}`, registration = { ...value, registration_id, schema_version: 1, registered_at: this.#time() };
        const version = tx.compareAndSwap(NS, registrationKey(registration_id), null, registration);
        tx.compareAndSwap(NS, stream, null, { registration_id });
        tx.compareAndSwap(NS, cursorKey(cursor.source), null, cursor);
        tx.appendSource(NS, key('source-origin', registration_id), 'source-registration', registration);
        return { registration_id, version, registration };
      });
    });
  }
  updateSourceAccess(context, options) {
    return this.#call(() => {
      this.#grant(context, 'ingress:register', { write: true, owner: true });
      const value = input(options); fields(value, ['registration_id', 'expectedVersion', 'access']); access(value.access);
      assert(integer(value.expectedVersion) && value.expectedVersion > 0);
      return this.#transaction(context, tx => {
        const grant = this.#grant(context, 'ingress:register', { write: true, owner: true });
        const row = this.#source(context, value.registration_id, tx), registration = { ...row.value, access: value.access };
        const version = tx.compareAndSwap(NS, registrationKey(value.registration_id), value.expectedVersion, registration);
        tx.appendSource(NS, key('source-access', [value.registration_id, version]), 'source-access', {
          registration_id: value.registration_id, version, access: value.access, actor: grant.principal_id, at: this.#time() });
        return { registration_id: value.registration_id, version, registration };
      });
    });
  }
  getSource(context, options) {
    return this.#call(() => {
      const grant = this.#grant(context, 'ingress:read'), value = input(options); fields(value, ['registration_id']);
      const row = this.#source(context, value.registration_id); this.#readAllowed(grant, row.value);
      const cursor = this.#store.getRecord(context, NS, cursorKey({ partition: row.value.partition, producer: row.value.producer }));
      // A filtered cursor would manufacture continuity. Deny the whole cursor
      // when its observation IDs/pins include an event this reader cannot see.
      for (const entry of cursor.value.entries) this.#bundle(context, entry.event_ref.event_id, grant);
      this.#readAllowed(this.#grant(context, 'ingress:read'), this.#source(context, value.registration_id).value);
      return { registration_id: value.registration_id, version: row.version, registration: row.value,
        cursor: { version: cursor.version, state: cursor.value } };
    });
  }
  eventIdFor(context, options) {
    return this.#call(() => {
      const grant = this.#grant(context, 'ingress:submit'), value = input(options);
      fields(value, ['registration_id', 'idempotency_key']); assert(id(value.idempotency_key));
      const row = this.#source(context, value.registration_id);
      assert(grant.principal_id === row.value.producer_principal_id, 'ingress_unauthorized');
      return this.#eventId(grant, value.registration_id, value.idempotency_key);
    });
  }
  #eventId(grant, registration_id, idempotency_key) {
    return key('observation', [1, grant.tenant_id, grant.project_id, registration_id, idempotency_key]);
  }
  submit(context, options) {
    return this.#call(() => {
      this.#grant(context, 'ingress:submit', { write: true, project: true });
      const value = input(options); fields(value, ['registration_id', 'epoch', 'event'], ['snapshot_text']);
      assert(id(value.registration_id) && integer(value.epoch));
      try { validateRawEvent(value.event); } catch { throw fail('invalid_event'); }
      const raw = value.event, hasSnapshot = Object.hasOwn(value, 'snapshot_text');
      if (hasSnapshot) {
        assert(raw.payload.kind === 'snapshot' && typeof value.snapshot_text === 'string'
          && Buffer.byteLength(value.snapshot_text, 'utf8') <= 65536
          && Buffer.from(value.snapshot_text, 'utf8').toString('utf8') === value.snapshot_text, 'invalid_snapshot');
        try { verifyEventPayload(raw.payload, Buffer.from(value.snapshot_text, 'utf8')); } catch { throw fail('invalid_snapshot'); }
      }
      return this.#transaction(context, tx => {
        const grant = this.#grant(context, 'ingress:submit', { write: true, project: true });
        const row = this.#source(context, value.registration_id, tx), registration = row.value;
        this.#writeAllowed(grant, registration, raw, true);
        assert(equal(raw.partition, registration.partition)
          && raw.producer.producer_id === registration.producer.producer_id && raw.producer.epoch === registration.producer.epoch, 'source_mismatch');
        assert(raw.event_id === this.#eventId(grant, value.registration_id, raw.idempotency_key), 'invalid_event_identity');
        if (registration.execution) assert(Object.entries(registration.execution).every(([k, v]) => raw.identity[k] === v), 'source_mismatch');
        const catalog = this.#live(context, registration), accepted_at = this.#time();
        let authorization = null, snapshot_ref = null;
        if (hasSnapshot) {
          assert(registration.access.allow_snapshots && this.#policy, 'sanitization_required');
          assert(this.#policy.constructor?.name !== 'AsyncFunction', 'sanitization_required');
          let approved;
          try { approved = this.#policy(freeze({ text: value.snapshot_text, registration: copy(registration), event: copy(raw) })); }
          catch { throw fail('sanitization_required'); }
          if (approved && typeof approved.then === 'function') { Promise.resolve(approved).catch(() => {}); throw fail('sanitization_required'); }
          assert(approved === value.snapshot_text, 'sanitization_required');
          snapshot_ref = key('snapshot', [registration.partition, raw.payload.snapshot_id]);
          authorization = { schema_version: 1, authorization_id: key('snapshot-grant', raw.event_id), partition: registration.partition,
            snapshot_id: raw.payload.snapshot_id, digest: raw.payload.digest, authorized_at: accepted_at,
            purpose: 'runtime_replay', storage: 'immutable', ...effectiveEventAccess(raw) };
        }
        let normalized;
        try { normalized = normalizeRawEvent(raw, { catalog, mapping: registration.mapping, snapshot_authorizations: authorization ? [authorization] : [] }); }
        catch { throw fail('invalid_event'); }
        assert(normalized.status === 'normalized', 'unmapped_event');
        const event = normalized.event, cursorId = cursorKey({ partition: registration.partition, producer: registration.producer });
        const cursor = tx.getRecord(NS, cursorId); assert(cursor, 'corrupt_ingress_state');
        let accepted;
        try { accepted = acceptSourceEvent(cursor.value, event); }
        catch { throw fail(cursor.value.entries.length >= 4096 ? 'cursor_capacity' : 'observation_conflict'); }
        this.#stableSource(context, registration.registration_id, row.version, tx, 'ingress:submit', { write: true, project: true });
        if (accepted.status === 'duplicate') {
          const prior = this.#store.getSource(context, NS, eventKey(event.event_id));
          assert(prior && prior.value.receipt.source_fingerprint === sourceEventFingerprint(event), 'corrupt_ingress_state');
          return { status: 'duplicate', receipt: prior.value.receipt };
        }
        const catalog_ref = key('catalog', catalog), mapping_ref = key('mapping', registration.mapping);
        const snapshot_authorization_ref = authorization ? authorization.authorization_id : null;
        const receipt = { schema_version: 1, event_id: event.event_id, registration_id: registration.registration_id,
          registration_version: row.version, source_access_ref: row.version === 1 ? key('source-origin', registration.registration_id)
            : key('source-access', [registration.registration_id, row.version]),
          activation_epoch: value.epoch, accepted_at, event_digest: hash(event), source_fingerprint: sourceEventFingerprint(event),
          idempotency_key: eventIdempotencyKey(event), cursor_status: accepted.status, catalog_ref, mapping_ref, snapshot_ref, snapshot_authorization_ref };
        const pin = (ref, kind, data) => {
          const prior = this.#store.getSource(context, NS, ref);
          if (prior) assert(equal(prior.value, data), 'snapshot_conflict');
          else tx.appendSource(NS, ref, kind, data);
        };
        pin(catalog_ref, 'identity-catalog', catalog); pin(mapping_ref, 'event-mapping', registration.mapping);
        if (hasSnapshot) {
          pin(snapshot_ref, 'payload-snapshot', { text: value.snapshot_text, digest: raw.payload.digest, snapshot_id: raw.payload.snapshot_id });
          pin(snapshot_authorization_ref, 'snapshot-authorization', authorization);
        }
        tx.appendSource(NS, eventKey(event.event_id), 'admitted-event', { raw, event, receipt });
        try { tx.compareAndSwap(NS, cursorId, cursor.version, accepted.state); }
        catch (error) { if (error?.code === 'invalid_store_input') throw fail('ingress_capacity'); throw error; }
        tx.enqueue(NS, outboxKey(event.event_id), { schema_version: 1, event_id: event.event_id,
          registration_id: registration.registration_id, activation_epoch: value.epoch, event_digest: receipt.event_digest });
        return { status: 'accepted', receipt };
      }, { epoch: value.epoch, stage: 'capture' });
    });
  }
  #bundle(context, event_id, grant, { optional = false, tx } = {}) {
    assert(id(event_id)); const stored = this.#store.getSource(context, NS, eventKey(event_id));
    if (!stored && optional) return null;
    assert(stored, 'missing_event');
    const row = this.#source(context, stored.value.receipt.registration_id, tx);
    this.#readAllowed(grant, row.value, stored.value.event);
    return { bundle: stored.value, row };
  }
  getReceipt(context, options) {
    return this.#call(() => {
      const grant = this.#grant(context, 'ingress:read'), value = input(options); fields(value, ['event_id']);
      const found = this.#bundle(context, value.event_id, grant, { optional: true });
      if (!found) return null;
      this.#readFence(context, found.bundle); return found.bundle.receipt;
    });
  }
  readEvent(context, options) {
    return this.#call(() => {
      const grant = this.#grant(context, 'ingress:read'), value = input(options); fields(value, ['event_id']);
      const { bundle } = this.#bundle(context, value.event_id, grant);
      this.#readFence(context, bundle); return bundle;
    });
  }
  readSnapshot(context, options) {
    return this.#call(() => {
      const grant = this.#grant(context, 'ingress:read'), value = input(options); fields(value, ['event_id']);
      const { bundle } = this.#bundle(context, value.event_id, grant);
      if (!bundle.receipt.snapshot_ref) { this.#readFence(context, bundle); return null; }
      const snapshot = this.#store.getSource(context, NS, bundle.receipt.snapshot_ref);
      assert(snapshot, 'corrupt_ingress_state'); this.#readFence(context, bundle); return snapshot.value;
    });
  }
  listPending(context, options = { limit: 64 }) {
    return this.#call(() => {
      const grant = this.#grant(context, 'ingress:read'), value = input(options); fields(value, ['limit']);
      assert(Number.isInteger(value.limit) && value.limit >= 1 && value.limit <= 64);
      return this.#store.pendingOutbox(context, NS, { limit: value.limit }).filter(item => {
        try { const { bundle } = this.#bundle(context, item.value.event_id, grant); this.#readFence(context, bundle); return true; }
        catch (error) { if (error?.code === 'source_access_denied') return false; throw error; }
      });
    });
  }
  handoff(context, options, operation) {
    return this.#call(() => {
      const grant = this.#grant(context, 'ingress:handoff', { write: true, owner: true, project: true });
      const value = input(options); fields(value, ['event_id']);
      assert(typeof operation === 'function'); assert(operation.constructor?.name !== 'AsyncFunction', 'async_ingress_callback');
      const original = this.#bundle(context, value.event_id, grant).bundle;
      return this.#transaction(context, tx => {
        const current = this.#grant(context, 'ingress:handoff', { write: true, owner: true, project: true });
        const { bundle, row } = this.#bundle(context, value.event_id, current, { tx });
        this.#writeAllowed(current, row.value, bundle.event);
        const catalog = this.#live(context, row.value);
        const normalized = normalizeRawEvent(bundle.raw, { catalog, mapping: row.value.mapping });
        assert(normalized.status === 'normalized' && equal(normalized.event.identity, bundle.event.identity), 'unmapped_event');
        const prior = this.#store.getSource(context, NS, handoffKey(value.event_id));
        if (prior) return { status: 'duplicate', receipt: prior.value };
        const snapshot = bundle.receipt.snapshot_ref ? this.#store.getSource(context, NS, bundle.receipt.snapshot_ref)?.value : null;
        let result;
        try { result = operation(tx, freeze({ ...copy(bundle), snapshot: snapshot ? copy(snapshot) : null })); }
        catch { throw fail('consumer_failed'); }
        if (result && typeof result.then === 'function') { Promise.resolve(result).catch(() => {}); throw fail('async_ingress_callback'); }
        const receipt = { schema_version: 1, event_id: value.event_id, event_digest: bundle.receipt.event_digest,
          activation_epoch: bundle.receipt.activation_epoch, handed_off_at: this.#time(), consumer: 'ingress-policy' };
        this.#stableSource(context, row.value.registration_id, row.version, tx, 'ingress:handoff', { write: true, owner: true, project: true });
        tx.appendSource(NS, handoffKey(value.event_id), 'ingress-handoff', receipt);
        assert(tx.ack(NS, outboxKey(value.event_id)), 'corrupt_ingress_state');
        return { status: 'handed_off', receipt };
      }, { epoch: original.receipt.activation_epoch, stage: 'dispatch' });
    });
  }
}
