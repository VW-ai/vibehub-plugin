import { DomainStore } from '../adapters/sqlite/domain-store.mjs';
import { AccessAuthority, LOCAL_AUDIENCE } from '../domain/identity/access-authority.mjs';
import { canonical, fingerprint } from '../core/contracts.mjs';
import { validateNormalizedEvent, effectiveEventAccess, sourceObjectKey } from '../core/event-provenance.mjs';
import { sourcePartitionKey } from '../core/causal-ordering.mjs';
import { types as utilTypes } from 'node:util';

export const SOURCE_INVALIDATION_NAMESPACE = 'source-invalidation';
const NS = SOURCE_INVALIDATION_NAMESPACE;
const levels = ['normal', 'sensitive', 'restricted'];
const safeCodes = new Set(['invalidation_unauthorized', 'invalid_invalidation_input', 'missing_invalidation',
  'invalidation_corrupt', 'invalidation_conflict', 'stale_invalidation_fence', 'source_invalidation_denied',
  'store_closed', 'store_busy', 'store_unavailable', 'store_unauthorized', 'invalid_store_input',
  'unknown_namespace', 'cas_conflict', 'duplicate_identity', 'async_transaction', 'stale_transaction',
  'nested_transaction', 'migration_required', 'incompatible_store', 'store_page_too_large']);
const retryable = new Set(['store_closed', 'store_busy', 'store_unavailable']);
const fail = code => Object.assign(new Error(`Source invalidation: ${code}`), {
  code, category: retryable.has(code) ? 'retryable_failure' : 'rejected',
});
const assert = (condition, code = 'invalid_invalidation_input') => { if (!condition) throw fail(code); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(value);
const digest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const copy = value => JSON.parse(canonical(value));
const equal = (left, right) => canonical(left) === canonical(right);
const hash = value => `sha256:${fingerprint(value)}`;
function errorCode(value) {
  try {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null || utilTypes.isProxy(value)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'code');
    return descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string'
      ? descriptor.value : null;
  } catch { return null; }
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function fields(value, required, optional = []) {
  assert(plain(value) && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key)));
}
function input(value) {
  let nodes = 0; const stack = new Set();
  const visit = (item, depth) => {
    assert(++nodes <= 50000 && depth < 16);
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number') { assert(Number.isFinite(item)); return; }
    assert(!utilTypes.isProxy(item));
    assert((plain(item) || Array.isArray(item) && Object.getPrototypeOf(item) === Array.prototype) && !stack.has(item));
    assert(Object.getOwnPropertySymbols(item).length === 0);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (Array.isArray(item) && key === 'length') continue;
      assert(Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
      assert(!Array.isArray(item) || /^(0|[1-9]\d*)$/.test(key) && Number(key) < item.length);
    }
    if (Array.isArray(item)) assert(Object.keys(item).length === item.length);
    stack.add(item); Object.values(item).forEach(child => visit(child, depth + 1)); stack.delete(item);
  };
  visit(value, 0); const encoded = canonical(value); assert(Buffer.byteLength(encoded) <= 1048576);
  return JSON.parse(encoded);
}
function scope(value) {
  fields(value, ['tenant_id', 'project_id']); assert(id(value.tenant_id) && id(value.project_id));
}
function guardKey(object_key, stream_key) { return `guard-${fingerprint([1, object_key, stream_key])}`; }
function summaryKey(object_key) { return `summary-${fingerprint([1, object_key])}`; }
function originKey(object_key) { return `origin-${fingerprint([1, object_key])}`; }
const commandKey = (actor, registration_id, idempotency_key) => `command-${fingerprint([1, actor, registration_id, idempotency_key])}`;
const headKey = 'project-fence';
const noticeId = sequence => `notice-${String(sequence).padStart(16, '0')}`;
function sourceFrom(event) {
  return { partition: event.partition, producer: { producer_id: event.producer.producer_id, epoch: event.producer.epoch } };
}
function guardTargets(event) {
  const values = event.provenance.source_objects.map(item => ({ object: item.object, object_key: sourceObjectKey(item.object) }));
  assert(values.length <= 32 && new Set(values.map(item => item.object_key)).size === values.length);
  return values.sort((a, b) => a.object_key.localeCompare(b.object_key));
}
function targets(event) {
  const values = guardTargets(event); assert(values.length > 0); return values;
}
function summary(value) {
  fields(value, ['schema_version', 'kind', 'object', 'object_key', 'blocking_stream_count', 'tombstoned']);
  assert(value.schema_version === 1 && value.kind === 'source_object_invalidation_summary'
    && sourceObjectKey(value.object) === value.object_key && integer(value.blocking_stream_count)
    && typeof value.tombstoned === 'boolean', 'invalidation_corrupt');
  return value;
}
function guard(value) {
  fields(value, ['schema_version', 'kind', 'object', 'object_key', 'stream_key', 'registration_id', 'state',
    'event_id', 'event_digest', 'sequence', 'notice_sequence']);
  assert(value.schema_version === 1 && value.kind === 'source_object_stream_guard'
    && sourceObjectKey(value.object) === value.object_key && typeof value.stream_key === 'string'
    && value.stream_key.length <= 4096 && id(value.registration_id) && ['active', 'unknown', 'tombstoned'].includes(value.state)
    && id(value.event_id) && digest(value.event_digest) && (value.sequence === null || integer(value.sequence))
    && integer(value.notice_sequence), 'invalidation_corrupt');
  return value;
}
function zeroSummary(object, object_key) {
  return { schema_version: 1, kind: 'source_object_invalidation_summary', object, object_key,
    blocking_stream_count: 0, tombstoned: false };
}
function origin(value) {
  fields(value, ['schema_version', 'kind', 'object', 'object_key']);
  assert(value.schema_version === 1 && value.kind === 'source_object_invalidation_origin'
    && sourceObjectKey(value.object) === value.object_key, 'invalidation_corrupt');
  return value;
}
function objectOrigin(object, object_key) {
  return { schema_version: 1, kind: 'source_object_invalidation_origin', object, object_key };
}
function grantFor(authority, context, action, { write = false, kinds = null } = {}) {
  const grant = authority.inspect(context);
  assert(grant && grant.audience === LOCAL_AUDIENCE && grant.actions.includes(action)
    && grant.actions.includes('store:read') && (!write || grant.actions.includes('store:write'))
    && (!kinds || kinds.includes(grant.kind)), 'invalidation_unauthorized');
  return grant;
}

/** Stable exact lookup used by Graph source_access without adding a caller-supplied locator. */
export function sourceLifecycleInvalidationId(value, event_id) {
  const selected = input({ scope: value, event_id });
  scope(selected.scope); assert(id(selected.event_id));
  return `source-lifecycle-${fingerprint([1, selected.scope, selected.event_id])}`;
}

function lifecycleRecord(value) {
  fields(value, ['schema_version', 'kind', 'invalidation_id', 'scope', 'registration_id', 'event', 'event_digest',
    'receipt', 'access_state', 'status', 'notice_sequence', 'notice_id', 'captured_access', 'request_digest', 'target_refs']);
  scope(value.scope);
  assert(value.schema_version === 1 && value.kind === 'source_lifecycle_invalidation'
    && id(value.invalidation_id) && id(value.registration_id) && digest(value.event_digest)
    && digest(value.request_digest) && ['active', 'unknown', 'tombstoned'].includes(value.access_state)
    && ['applied', 'superseded'].includes(value.status) && plain(value.receipt)
    && Array.isArray(value.target_refs) && value.target_refs.length > 0 && value.target_refs.length <= 32
    && value.target_refs.every(target => plain(target) && Object.keys(target).length === 2
      && typeof target.object_key === 'string' && target.object_key.length > 0 && target.object_key.length <= 4096
      && typeof target.applied === 'boolean')
    && new Set(value.target_refs.map(target => target.object_key)).size === value.target_refs.length
    && (value.status === 'applied' ? integer(value.notice_sequence) && id(value.notice_id)
      : value.notice_sequence === null && value.notice_id === null), 'invalidation_corrupt');
  return value;
}

/** Fixed transaction helpers. DurableIngress remains the only mutation facade. */
export class SourceInvalidationDomain {
  #store; #authority;
  constructor({ store, authority }) {
    assert(store instanceof DomainStore && authority instanceof AccessAuthority);
    this.#store = store; this.#authority = authority;
  }
  grant(context, action, options) { return grantFor(this.#authority, context, action, options); }
  #row(context, tx, key, validator) {
    const row = tx ? tx.getRecord(NS, key) : this.#store.getRecord(context, NS, key);
    if (row) validator(row.value);
    return row;
  }
  assertProspectiveObjectAllowed(context, object, { tx = null } = {}) {
    const grant = this.grant(context, 'store:read'), object_key = sourceObjectKey(object);
    assert(object.tenant_id === grant.tenant_id);
    const head = this.#head(context, tx), row = this.#row(context, tx, summaryKey(object_key), summary);
    if (!row) {
      // Unobserved objects need no write just to authorize a selected read.
      // An immutable origin distinguishes them from a lost known summary.
      assert(!this.#row(context, tx, originKey(object_key), origin), 'invalidation_corrupt');
    } else {
      assert(equal(row.value.object, object), 'invalidation_corrupt');
      assert(!row.value.tombstoned && row.value.blocking_stream_count === 0, 'source_invalidation_denied');
    }
    this.grant(context, 'store:read');
    return { sequence: head.sequence };
  }
  assertEventAllowed(context, event, { tx = null, initialize = false } = {}) {
    this.#head(context, tx); // Also proves the required namespace exists for zero-target events.
    for (const item of guardTargets(event)) {
      const object_key = sourceObjectKey(item.object);
      const row = this.#row(context, tx, summaryKey(object_key), summary);
      if (!row) {
        const first = this.#row(context, tx, originKey(object_key), origin);
        assert(initialize && tx && !first, 'invalidation_corrupt');
        tx.compareAndSwap(NS, originKey(object_key), null, objectOrigin(item.object, object_key));
        tx.compareAndSwap(NS, summaryKey(object_key), null, zeroSummary(item.object, object_key));
        continue;
      }
      assert(equal(row.value.object, item.object), 'invalidation_corrupt');
      assert(!row.value.tombstoned && row.value.blocking_stream_count === 0, 'source_invalidation_denied');
    }
    // Recheck local authority after all selected reads.
    this.grant(context, tx ? 'store:write' : 'store:read', { write: Boolean(tx) });
  }
  #head(context, tx) {
    const row = this.#row(context, tx, headKey, value => {
      fields(value, ['schema_version', 'kind', 'sequence']);
      assert(value.schema_version === 1 && value.kind === 'source_invalidation_head'
        && integer(value.sequence), 'invalidation_corrupt');
    });
    if (!row) {
      const first = tx ? tx.getSource(NS, noticeId(1)) : this.#store.getSource(context, NS, noticeId(1));
      assert(!first, 'invalidation_corrupt');
      return { row: null, sequence: 0 };
    }
    assert(row.value.sequence >= 1 && row.version === row.value.sequence, 'invalidation_corrupt');
    return { row, sequence: row.value.sequence };
  }
  #advance(context, tx) {
    const current = this.#head(context, tx); assert(current.sequence < Number.MAX_SAFE_INTEGER, 'invalidation_conflict');
    const sequence = current.sequence + 1;
    tx.compareAndSwap(NS, headKey, current.row?.version ?? null,
      { schema_version: 1, kind: 'source_invalidation_head', sequence });
    return sequence;
  }
  #appendNotice(tx, sequence, value) {
    const notice_id = noticeId(sequence);
    tx.appendSource(NS, notice_id, 'source-invalidation-notice', {
      schema_version: 1, kind: 'source_invalidation_notice', notice_id, sequence, ...value,
    });
    return notice_id;
  }
  command(context, { registration_id, idempotency_key }, { tx = null } = {}) {
    const grant = this.grant(context, 'source:invalidate', { write: true, kinds: ['human', 'service'] });
    assert(id(registration_id) && id(idempotency_key));
    const key = commandKey(grant.principal_id, registration_id, idempotency_key);
    return tx ? tx.getSource(NS, key) : this.#store.getSource(context, NS, key);
  }
  recordCommand(context, tx, value) {
    const grant = this.grant(context, 'source:invalidate', { write: true, kinds: ['human', 'service'] });
    fields(value, ['registration_id', 'idempotency_key', 'request_digest', 'result']);
    assert(id(value.registration_id) && id(value.idempotency_key) && digest(value.request_digest));
    const command_id = commandKey(grant.principal_id, value.registration_id, value.idempotency_key);
    const prior = tx.getSource(NS, command_id);
    if (prior) {
      assert(prior.kind === 'source-invalidation-command' && prior.value.request_digest === value.request_digest,
        'invalidation_conflict');
      return prior.value.result;
    }
    const result = copy(value.result);
    tx.appendSource(NS, command_id, 'source-invalidation-command', {
      schema_version: 1, kind: 'source_invalidation_command', command_id, actor: grant.principal_id,
      registration_id: value.registration_id, idempotency_key: value.idempotency_key,
      request_digest: value.request_digest, result,
    });
    return result;
  }
  lifecycle(context, event_id, { action, tx = null } = {}) {
    const grant = this.grant(context, action, { write: true }); assert(id(event_id));
    const key = sourceLifecycleInvalidationId({
      tenant_id: grant.tenant_id, project_id: grant.project_id,
    }, event_id);
    const row = tx ? tx.getSource(NS, key) : this.#store.getSource(context, NS, key);
    if (!row) return null;
    assert(row.kind === 'source-lifecycle-invalidation'
      && row.value?.kind === 'source_lifecycle_invalidation', 'invalidation_corrupt');
    return lifecycleRecord(row.value);
  }
  recordPolicyChange(context, tx, value) {
    const grant = this.grant(context, value.action, { write: true, kinds: ['human', 'service'] });
    fields(value, ['action', 'registration_id', 'registration_version', 'reason', 'access', 'request_digest'], ['idempotency_key']);
    assert(id(value.registration_id) && integer(value.registration_version) && value.registration_version > 0
      && id(value.reason) && digest(value.request_digest));
    const command_id = value.idempotency_key === undefined ? null
      : commandKey(grant.principal_id, value.registration_id, value.idempotency_key);
    if (command_id) {
      const prior = tx.getSource(NS, command_id);
      if (prior) {
        assert(prior.kind === 'source-invalidation-command' && prior.value.request_digest === value.request_digest,
          'invalidation_conflict');
        return prior.value.result;
      }
    }
    const sequence = this.#advance(context, tx), notice_id = this.#appendNotice(tx, sequence, {
      change_kind: 'registration_policy', reason: value.reason, actor: grant.principal_id,
      registration_id: value.registration_id, registration_version: value.registration_version,
      access: copy(value.access), target_refs: [], invalidation_id: null,
    });
    const result = freeze(copy({ status: 'applied', sequence, notice_id, registration_id: value.registration_id,
      registration_version: value.registration_version, reason: value.reason }));
    if (command_id) tx.appendSource(NS, command_id, 'source-invalidation-command', {
      schema_version: 1, kind: 'source_invalidation_command', command_id, actor: grant.principal_id,
      registration_id: value.registration_id, idempotency_key: value.idempotency_key,
      request_digest: value.request_digest, result,
    });
    return result;
  }
  applyLifecycle(context, tx, value) {
    const grant = this.grant(context, value.action, { write: true });
    fields(value, ['action', 'registration_id', 'event', 'receipt', 'access_state', 'access', 'request_digest']);
    assert(id(value.registration_id) && ['active', 'unknown', 'tombstoned'].includes(value.access_state)
      && digest(value.request_digest));
    try { validateNormalizedEvent(value.event); } catch { throw fail('invalid_invalidation_input'); }
    const event = value.event, event_digest = hash(event), invalidation_id = sourceLifecycleInvalidationId({
      tenant_id: grant.tenant_id, project_id: grant.project_id,
    }, event.event_id);
    assert(value.receipt?.registration_id === value.registration_id && value.receipt?.event_id === event.event_id
      && value.receipt?.event_digest === event_digest, 'invalidation_corrupt');
    assert(event.event_type === 'SOURCE_TOMBSTONE' ? value.access_state === 'tombstoned'
      : event.event_type === 'SOURCE_ACCESS_CHANGED' && ['active', 'unknown'].includes(value.access_state));
    const existing = tx.getSource(NS, invalidation_id);
    if (existing) {
      assert(existing.kind === 'source-lifecycle-invalidation'
        && lifecycleRecord(existing.value).request_digest === value.request_digest,
        'invalidation_conflict');
      return existing.value;
    }
    const stream_key = sourcePartitionKey(sourceFrom(event)), eventTargets = targets(event), planned = [];
    for (const target of eventTargets) {
      const sKey = summaryKey(target.object_key), sRow = this.#row(context, tx, sKey, summary);
      const oKey = originKey(target.object_key);
      if (!sRow) assert(!this.#row(context, tx, oKey, origin), 'invalidation_corrupt');
      const currentSummary = sRow?.value ?? zeroSummary(target.object, target.object_key);
      assert(equal(currentSummary.object, target.object), 'invalidation_corrupt');
      const gKey = guardKey(target.object_key, stream_key), gRow = this.#row(context, tx, gKey, guard);
      const previous = gRow?.value ?? null, sequence = event.producer.sequence;
      if (previous) assert(previous.object_key === target.object_key && equal(previous.object, target.object)
        && previous.stream_key === stream_key && previous.registration_id === value.registration_id,
      'invalidation_corrupt');
      let apply = false;
      if (currentSummary.tombstoned) apply = false;
      else if (previous && previous.event_id === event.event_id) {
        assert(previous.event_digest === event_digest && previous.state === value.access_state, 'invalidation_conflict');
      } else if (previous?.sequence === null) apply = value.access_state === 'tombstoned';
      else if (previous && previous.sequence !== null && sequence !== null && sequence < previous.sequence) apply = false;
      else if (previous && previous.sequence !== null && sequence !== null && sequence === previous.sequence) {
        throw fail('invalidation_conflict');
      } else if (value.access_state === 'active') {
        apply = sequence !== null && (!previous || previous.sequence !== null && sequence > previous.sequence);
      } else if (value.access_state === 'tombstoned') apply = true;
      else if (sequence === null) apply = true;
      else apply = !previous || sequence > previous.sequence;
      let nextSummary = currentSummary;
      if (apply) {
        const oldBlocking = previous?.state === 'unknown' ? 1 : 0;
        const newBlocking = value.access_state === 'unknown' ? 1 : 0;
        const count = currentSummary.blocking_stream_count - oldBlocking + newBlocking;
        assert(integer(count), 'invalidation_corrupt');
        nextSummary = { ...currentSummary, blocking_stream_count: count,
          tombstoned: currentSummary.tombstoned || value.access_state === 'tombstoned' };
      }
      planned.push({ ...target, originKey: oKey, needsOrigin: !sRow,
        summaryKey: sKey, summaryRow: sRow, summary: nextSummary,
        guardKey: gKey, guardRow: gRow, previous, apply });
    }
    const applied = planned.filter(item => item.apply), status = applied.length ? 'applied' : 'superseded';
    const sequence = applied.length ? this.#advance(context, tx) : null;
    if (applied.length) for (const item of applied) {
      if (item.needsOrigin) tx.compareAndSwap(NS, item.originKey, null, objectOrigin(item.object, item.object_key));
      tx.compareAndSwap(NS, item.summaryKey, item.summaryRow?.version ?? null, item.summary);
      tx.compareAndSwap(NS, item.guardKey, item.guardRow?.version ?? null, {
        schema_version: 1, kind: 'source_object_stream_guard', object: item.object, object_key: item.object_key,
        stream_key, registration_id: value.registration_id, state: value.access_state, event_id: event.event_id,
        event_digest, sequence: event.producer.sequence, notice_sequence: sequence,
      });
    }
    const target_refs = planned.map(item => ({ object_key: item.object_key, applied: item.apply }));
    const notice_id = applied.length ? this.#appendNotice(tx, sequence, {
      change_kind: 'source_lifecycle', reason: event.event_type, actor: grant.principal_id,
      registration_id: value.registration_id, registration_version: value.receipt.registration_version,
      access: copy(value.access), target_refs, invalidation_id,
    }) : null;
    const record = { schema_version: 1, kind: 'source_lifecycle_invalidation', invalidation_id,
      scope: { tenant_id: grant.tenant_id, project_id: grant.project_id }, registration_id: value.registration_id,
      event: copy(event), event_digest, receipt: copy(value.receipt), access_state: value.access_state,
      status, notice_sequence: sequence, notice_id, captured_access: copy(effectiveEventAccess(event)),
      request_digest: value.request_digest, target_refs };
    assert(equal(record.captured_access, event.effective_access), 'invalidation_corrupt');
    tx.appendSource(NS, invalidation_id, 'source-lifecycle-invalidation', record);
    return freeze(copy(record));
  }
}

/** Read-only bounded fence/feed and exact lifecycle metadata access. */
export class SourceInvalidationFeed {
  #store; #authority;
  constructor({ store, authority }) {
    assert(store instanceof DomainStore && authority instanceof AccessAuthority);
    this.#store = store; this.#authority = authority;
  }
  #call(operation) {
    try { return freeze(copy(operation())); } catch (error) {
      const code = errorCode(error);
      if (safeCodes.has(code)) throw fail(code);
      throw fail('invalid_invalidation_input');
    }
  }
  #grant(context, action, options) { return grantFor(this.#authority, context, action, options); }
  #head(context) {
    const row = this.#store.getRecord(context, NS, headKey);
    if (!row) {
      assert(!this.#store.getSource(context, NS, noticeId(1)), 'invalidation_corrupt');
      return { sequence: 0, version: null };
    }
    fields(row.value, ['schema_version', 'kind', 'sequence']);
    assert(row.value.schema_version === 1 && row.value.kind === 'source_invalidation_head'
      && integer(row.value.sequence), 'invalidation_corrupt');
    assert(row.value.sequence >= 1 && row.version === row.value.sequence, 'invalidation_corrupt');
    return { sequence: row.value.sequence, version: row.version };
  }
  head(context) {
    return this.#call(() => {
      const grant = this.#grant(context, 'source:invalidation:read');
      const current = this.#head(context); this.#grant(context, 'source:invalidation:read');
      return { schema_version: 1, scope: { tenant_id: grant.tenant_id, project_id: grant.project_id }, ...current };
    });
  }
  assertFence(context, options) {
    return this.#call(() => {
      this.#grant(context, 'source:invalidation:read'); const value = input(options);
      fields(value, ['sequence']); assert(integer(value.sequence));
      const current = this.#head(context); assert(current.sequence === value.sequence, 'stale_invalidation_fence');
      this.#grant(context, 'source:invalidation:read'); return { status: 'current', sequence: current.sequence };
    });
  }
  page(context, options) {
    return this.#call(() => {
      this.#grant(context, 'source:invalidation:read'); const value = input(options); fields(value, ['after', 'limit']);
      assert((value.after === null || integer(value.after)) && integer(value.limit) && value.limit >= 1 && value.limit <= 64);
      const lower = noticeId(0), upper = 'notice-z';
      const page = this.#store.getSourceRange(context, NS, { lower, upper, order: 'asc', limit: value.limit,
        after: value.after === null ? null : noticeId(value.after) });
      const items = page.rows.map(row => {
        assert(row.kind === 'source-invalidation-notice' && row.id === row.value.notice_id, 'invalidation_corrupt');
        return row.value;
      });
      this.#grant(context, 'source:invalidation:read');
      return { items, next_after: items.length === value.limit ? items.at(-1).sequence : null,
        head_sequence: this.#head(context).sequence };
    });
  }
  readLifecycleEvent(context, options) {
    return this.#call(() => {
      const grant = this.#grant(context, 'source:invalidation:consume', { kinds: ['service', 'worker'] });
      assert(grant.actions.includes('source:invalidation:read'), 'invalidation_unauthorized');
      const selected = input(options); fields(selected, ['invalidation_id']); assert(id(selected.invalidation_id));
      const row = this.#store.getSource(context, NS, selected.invalidation_id);
      assert(row, 'missing_invalidation');
      const value = lifecycleRecord(row.value);
      assert(row.kind === 'source-lifecycle-invalidation' && value.kind === 'source_lifecycle_invalidation'
        && value.invalidation_id === selected.invalidation_id
        && value.scope.tenant_id === grant.tenant_id && value.scope.project_id === grant.project_id
        && value.event.partition.tenant_id === grant.tenant_id && value.event.partition.project_id === grant.project_id
        && value.receipt.event_id === value.event.event_id && value.receipt.registration_id === value.registration_id
        && sourceLifecycleInvalidationId(value.scope, value.event.event_id) === selected.invalidation_id,
      'invalidation_corrupt');
      try { validateNormalizedEvent(value.event); } catch { throw fail('invalidation_corrupt'); }
      assert(hash(value.event) === value.event_digest && value.receipt.event_digest === value.event_digest
        && equal(value.captured_access, value.event.effective_access)
        && equal(value.target_refs.map(target => target.object_key), targets(value.event).map(target => target.object_key)),
      'invalidation_corrupt');
      this.#grant(context, 'source:invalidation:consume', { kinds: ['service', 'worker'] });
      const { request_digest: ignored, target_refs: ignoredTargets, ...result } = value;
      return result;
    });
  }
}
