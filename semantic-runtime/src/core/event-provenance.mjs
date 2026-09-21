import { createHash } from 'node:crypto';
import { resolveIdentity } from './identity.mjs';

/** Wire contracts only: callers authenticate producers and verify source/storage facts. */
export const EVENT_CONTRACT_VERSION = 1;
export const EVENT_TYPES = Object.freeze([
  'USER_INTENT', 'AGENT_MESSAGE', 'TOOL_CALL', 'TOOL_RESULT', 'FILE_READ', 'FILE_WRITE',
  'GIT_DIFF', 'GIT_COMMIT', 'TICKET_STATE', 'EVIDENCE_CREATED', 'OUTCOME_CREATED',
  'SLACK_MESSAGE', 'DOC_CHANGED', 'ISSUE_CHANGED', 'HUMAN_DECISION', 'SYSTEM_CHECKPOINT',
  'SOURCE_TOMBSTONE', 'SOURCE_ACCESS_CHANGED', 'GIT_REF_CHANGED',
]);
const SENSITIVITIES = ['normal', 'sensitive', 'restricted'];
const IDENTITY_FIELDS = ['workspace_id', 'repository_id', 'membership_id', 'checkout_id',
  'worktree_id', 'session_id', 'execution_id'];
const RAW_FIELDS = ['schema_version', 'kind', 'event_id', 'partition', 'source_native_event_id',
  'idempotency_key', 'source_event_type', 'occurred_at', 'observed_at', 'producer',
  'causal_parents', 'identity', 'payload', 'provenance', 'acl', 'sensitivity'];
const NORMAL_FIELDS = ['event_type', 'normalization', 'effective_access', 'replay'];
const fail = message => { throw new TypeError(`Event contract: ${message}`); };
const assert = (ok, message) => { if (!ok) fail(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function fields(value, required, optional = []) {
  assert(object(value), 'expected plain object');
  assert(required.every(key => Object.hasOwn(value, key)), 'missing field');
  assert(Object.keys(value).every(key => required.includes(key) || optional.includes(key)), 'unknown field');
}
function id(value) {
  assert(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/.test(value), 'invalid identifier');
}
function digest(value) { assert(typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value), 'invalid digest'); }
function timestamp(value) {
  assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, 'invalid UTC timestamp');
}
function list(value, maximum = 128) { assert(Array.isArray(value) && value.length <= maximum, 'invalid bounded array'); }
function ids(value) { list(value); value.forEach(id); assert(new Set(value).size === value.length, 'duplicate identifier'); }
function sensitivity(value) { assert(SENSITIVITIES.includes(value), 'invalid sensitivity'); }
function json(value, ancestors = new Set(), budget = { count: 0 }) {
  assert(++budget.count <= 25000 && ancestors.size < 32, 'JSON limit exceeded');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') { assert(value.length <= 8192, 'string limit exceeded'); return; }
  if (typeof value === 'number') { assert(Number.isFinite(value), 'non-finite number'); return; }
  assert((object(value) || Array.isArray(value)) && !ancestors.has(value), 'expected acyclic JSON');
  assert(Object.getOwnPropertySymbols(value).length === 0, 'symbol keys are unsupported');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (Array.isArray(value) && key === 'length') continue;
    assert(Object.hasOwn(descriptor, 'value') && descriptor.enumerable, 'expected JSON data properties');
    assert(!Array.isArray(value) || /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length, 'invalid array property');
  }
  if (Array.isArray(value)) assert(Object.keys(value).length === value.length, 'sparse array');
  ancestors.add(value);
  for (const item of Object.values(value)) json(item, ancestors, budget);
  ancestors.delete(value);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const stable = value => JSON.stringify(canonical(value));
const hash = value => `sha256:${createHash('sha256').update(stable(value)).digest('hex')}`;
const copy = value => JSON.parse(stable(value));
function same(left, right) { return stable(left) === stable(right); }
function partition(value, allowUnknown = false) {
  fields(value, ['tenant_id', 'project_id', 'source_installation_id', 'partition_id']);
  for (const [key, item] of Object.entries(value)) if (key !== 'project_id' || item !== null || !allowUnknown) id(item);
}
function acl(value) {
  fields(value, ['revision', 'allowed_principal_ids']); id(value.revision); ids(value.allowed_principal_ids);
}
function identity(value) { fields(value, [], IDENTITY_FIELDS); Object.values(value).forEach(id); }
function sourceObject(value) {
  assert(object(value), 'invalid source object');
  if (value.kind === 'git_commit') {
    fields(value, ['kind', 'tenant_id', 'repository_id', 'object_format', 'oid']);
    id(value.tenant_id); id(value.repository_id);
    assert(['sha1', 'sha256'].includes(value.object_format), 'invalid Git object format');
    assert(typeof value.oid === 'string' && new RegExp(`^[a-f0-9]{${value.object_format === 'sha1' ? 40 : 64}}$`).test(value.oid),
      'Git object requires full lowercase OID');
  } else {
    fields(value, ['kind', 'tenant_id', 'provider', 'authority', 'object_id']);
    assert(value.kind === 'source_object', 'invalid source object kind');
    for (const key of ['tenant_id', 'provider', 'authority', 'object_id']) id(value[key]);
  }
}
/** Source identity deliberately excludes delivery, Project, clone, branch and ACL. */
export function sourceObjectKey(value) {
  json(value); sourceObject(value);
  return value.kind === 'git_commit'
    ? JSON.stringify([1, 'git_commit', value.tenant_id, value.repository_id, value.object_format, value.oid])
    : JSON.stringify([1, 'source_object', value.tenant_id, value.provider, value.authority, value.object_id]);
}
function payload(value) {
  assert(object(value), 'invalid payload');
  if (value.kind === 'git_revision') {
    fields(value, ['kind', 'object', 'path', 'digest']); sourceObject(value.object); digest(value.digest);
    assert(value.object.kind === 'git_commit', 'Git payload requires Git commit');
    if (value.path !== null) {
      assert(typeof value.path === 'string' && value.path.length > 0 && value.path.length <= 4096
        && !/[\x00-\x1f\x7f\\]/.test(value.path) && !value.path.startsWith('/')
        && value.path.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'invalid Git relative path');
    }
  } else if (value.kind === 'object_revision') {
    fields(value, ['kind', 'object', 'revision_id', 'digest']); sourceObject(value.object); id(value.revision_id); digest(value.digest);
    assert(value.object.kind === 'source_object', 'object payload requires source object');
  } else if (value.kind === 'snapshot') {
    fields(value, ['kind', 'snapshot_id', 'digest']); id(value.snapshot_id); digest(value.digest);
  } else {
    fields(value, ['kind', 'pointer_id', 'digest']);
    assert(value.kind === 'mutable_pointer', 'invalid payload kind'); id(value.pointer_id);
    if (value.digest !== null) digest(value.digest);
  }
}
function provenance(value, tenantId) {
  fields(value, ['delivery', 'source_objects']); fields(value.delivery, ['channel', 'delivery_id']);
  assert(['local_git', 'fetch', 'push', 'pull_request', 'host', 'webhook', 'poll', 'backfill', 'human', 'system'].includes(value.delivery.channel),
    'invalid delivery channel'); id(value.delivery.delivery_id); list(value.source_objects);
  const keys = new Set();
  for (const support of value.source_objects) {
    fields(support, ['object', 'acl', 'sensitivity']); sourceObject(support.object); acl(support.acl); sensitivity(support.sensitivity);
    assert(support.object.tenant_id === tenantId, 'source object crosses tenant');
    const key = sourceObjectKey(support.object); assert(!keys.has(key), 'duplicate supporting source object'); keys.add(key);
  }
}
function rawEnvelope(value, normalized = false) {
  fields(value, [...RAW_FIELDS, ...(normalized ? NORMAL_FIELDS : [])]);
  assert(value.schema_version === 1 && value.kind === (normalized ? 'normalized_event' : 'raw_event'), 'unsupported event schema');
  id(value.event_id); partition(value.partition, !normalized); id(value.idempotency_key); id(value.source_event_type);
  if (value.source_native_event_id !== null) id(value.source_native_event_id);
  if (value.occurred_at !== null) timestamp(value.occurred_at);
  timestamp(value.observed_at);
  fields(value.producer, ['producer_id', 'epoch', 'sequence']); id(value.producer.producer_id); id(value.producer.epoch);
  assert(value.producer.sequence === null || Number.isSafeInteger(value.producer.sequence) && value.producer.sequence >= 0, 'invalid producer sequence');
  list(value.causal_parents);
  const parents = new Set();
  for (const parent of value.causal_parents) {
    fields(parent, ['tenant_id', 'project_id', 'event_id']); Object.values(parent).forEach(id);
    assert(parent.tenant_id === value.partition.tenant_id, 'causal parent crosses tenant');
    assert(value.partition.project_id === null || parent.project_id === value.partition.project_id, 'causal parent crosses project');
    assert(parent.event_id !== value.event_id, 'self causal parent');
    assert(!parents.has(stable(parent)), 'duplicate causal parent'); parents.add(stable(parent));
  }
  identity(value.identity); payload(value.payload); provenance(value.provenance, value.partition.tenant_id);
  acl(value.acl); sensitivity(value.sensitivity);
  if (value.payload.object) assert(value.provenance.source_objects.some(item =>
    sourceObjectKey(item.object) === sourceObjectKey(value.payload.object)), 'payload object lacks source provenance');
}
/** Strict version-1 shape checks; no authentication, I/O, semantic classification or mutation. */
export function validateRawEvent(value) { json(value); rawEnvelope(value); return true; }
function mapping(value) {
  fields(value, ['schema_version', 'mapping_id', 'revision', 'event_types']);
  assert(value.schema_version === 1, 'unsupported mapping schema'); id(value.mapping_id); id(value.revision);
  assert(object(value.event_types) && Object.keys(value.event_types).length <= 128, 'invalid event mapping');
  for (const [nativeType, eventType] of Object.entries(value.event_types)) {
    id(nativeType); assert(EVENT_TYPES.includes(eventType), 'invalid normalized taxonomy');
  }
}
function access(value) {
  const supports = [{ acl: value.acl, sensitivity: value.sensitivity }, ...value.provenance.source_objects];
  const allowed = supports[0].acl.allowed_principal_ids.filter(principal =>
    supports.every(support => support.acl.allowed_principal_ids.includes(principal))).sort();
  return { allowed_principal_ids: allowed, sensitivity: SENSITIVITIES[Math.max(...supports.map(item => SENSITIVITIES.indexOf(item.sensitivity)))] };
}
/** Empty principal intersection is deny-all, never a wildcard or public grant. */
export function effectiveEventAccess(value) {
  if (value?.kind === 'normalized_event') validateNormalizedEvent(value); else validateRawEvent(value);
  return access(value);
}
function authorization(value) {
  fields(value, ['schema_version', 'authorization_id', 'partition', 'snapshot_id', 'digest',
    'authorized_at', 'purpose', 'storage', 'allowed_principal_ids', 'sensitivity']);
  assert(value.schema_version === 1 && value.purpose === 'runtime_replay' && value.storage === 'immutable', 'invalid snapshot authorization');
  id(value.authorization_id); partition(value.partition); id(value.snapshot_id); digest(value.digest); timestamp(value.authorized_at);
  ids(value.allowed_principal_ids); sensitivity(value.sensitivity);
}
function replayFor(value, authorizations) {
  if (value.payload.kind === 'mutable_pointer') return { eligible: false, reason: 'mutable_pointer', authorization: null };
  if (value.payload.kind !== 'snapshot') return { eligible: true, reason: 'immutable_revision', authorization: null };
  const match = authorizations.filter(item => item.snapshot_id === value.payload.snapshot_id && same(item.partition, value.partition));
  assert(match.length <= 1, 'conflicting snapshot authorizations');
  if (!match.length) return { eligible: false, reason: 'snapshot_authorization_missing', authorization: null };
  const auth = match[0]; const effective = access(value);
  assert(auth.digest === value.payload.digest, 'snapshot authorization digest mismatch');
  assert(same([...auth.allowed_principal_ids].sort(), effective.allowed_principal_ids)
    && auth.sensitivity === effective.sensitivity, 'snapshot authorization access mismatch');
  return { eligible: true, reason: 'authorized_snapshot', authorization: copy(auth) };
}
function normalizedRaw(value) {
  const raw = Object.fromEntries(RAW_FIELDS.map(field => [field, value[field]]));
  raw.kind = 'raw_event'; raw.partition = value.normalization.raw_partition; raw.identity = value.normalization.raw_identity;
  return raw;
}
/** Validate carried pins and mechanical derivations, never the truth of a source assertion. */
export function validateNormalizedEvent(value) {
  json(value); rawEnvelope(value, true);
  const norm = value.normalization;
  fields(norm, ['normalizer_version', 'raw_partition', 'raw_identity', 'raw_event_digest', 'catalog_digest', 'mapping', 'mapping_digest']);
  assert(norm.normalizer_version === 1, 'unsupported normalizer version'); partition(norm.raw_partition, true); identity(norm.raw_identity);
  digest(norm.raw_event_digest); digest(norm.catalog_digest); mapping(norm.mapping); digest(norm.mapping_digest);
  const expectedPartition = { ...norm.raw_partition, project_id: value.partition.project_id };
  assert(same(expectedPartition, value.partition)
    && (norm.raw_partition.project_id === null || norm.raw_partition.project_id === value.partition.project_id), 'normalizer changed partition');
  assert(Object.entries(norm.raw_identity).every(([key, item]) => value.identity[key] === item), 'normalizer changed asserted identity');
  assert(typeof value.identity.workspace_id === 'string', 'missing resolved workspace');
  assert(Object.hasOwn(norm.mapping.event_types, value.source_event_type)
    && norm.mapping.event_types[value.source_event_type] === value.event_type, 'taxonomy mapping mismatch');
  assert(norm.mapping_digest === hash(norm.mapping), 'mapping digest mismatch');
  const raw = normalizedRaw(value); validateRawEvent(raw);
  assert(norm.raw_event_digest === hash(raw), 'raw event digest mismatch');
  assert(same(value.effective_access, access(value)), 'effective access mismatch');
  fields(value.replay, ['eligible', 'reason', 'authorization']);
  if (value.replay.authorization !== null) authorization(value.replay.authorization);
  const expectedReplay = replayFor(value, value.replay.authorization === null ? [] : [value.replay.authorization]);
  assert(same(value.replay, expectedReplay), 'replay classification mismatch');
  return true;
}
/**
 * One-to-one mechanical enrichment. Catalog, mapping and snapshot authorizations
 * are explicit trusted adapter inputs; mutable names and timestamps never select scope.
 */
export function normalizeRawEvent(raw, options) {
  validateRawEvent(raw); json(options); fields(options, ['catalog', 'mapping'], ['snapshot_authorizations']); mapping(options.mapping);
  const authorizations = options.snapshot_authorizations ?? []; list(authorizations); authorizations.forEach(authorization);
  const p = raw.partition;
  const resolution = resolveIdentity(options.catalog, { tenant_id: p.tenant_id, source_installation_id: p.source_installation_id,
    ...(p.project_id === null ? {} : { project_id: p.project_id }), ...raw.identity });
  const result = (status, reason, event = null) => copy({ status, reason, event, identity_resolution: resolution });
  if (resolution.status !== 'resolved') return result(resolution.status, resolution.reason);
  if (!Object.hasOwn(options.mapping.event_types, raw.source_event_type)) return result('unmapped', 'unknown_event_type');
  const resolved = resolution.identity;
  assert(resolved.tenant_id === p.tenant_id && resolved.source_installation_id === p.source_installation_id
    && (p.project_id === null || resolved.project_id === p.project_id), 'resolved partition mismatch');
  if (raw.causal_parents.some(parent => parent.project_id !== resolved.project_id)) return result('unmapped', 'causal_parent_scope_mismatch');
  const installation = options.catalog.source_installations.find(item => item.tenant_id === p.tenant_id
    && item.source_installation_id === p.source_installation_id);
  for (const { object: source } of raw.provenance.source_objects) {
    if (source.kind === 'git_commit') {
      const support = resolveIdentity(options.catalog, { tenant_id: p.tenant_id, project_id: resolved.project_id,
        source_installation_id: p.source_installation_id, repository_id: source.repository_id });
      if (support.status !== 'resolved') return result('unmapped', 'source_object_scope_mismatch');
    } else if (source.provider !== installation.external_identity.provider || source.authority !== installation.external_identity.authority) {
      return result('unmapped', 'source_object_authority_mismatch');
    }
  }
  const event = copy({ ...raw, kind: 'normalized_event', partition: { ...p, project_id: resolved.project_id },
    identity: Object.fromEntries(IDENTITY_FIELDS.filter(field => resolved[field] !== undefined).map(field => [field, resolved[field]])),
    event_type: options.mapping.event_types[raw.source_event_type], effective_access: access(raw),
    normalization: { normalizer_version: 1, raw_partition: p, raw_identity: raw.identity, raw_event_digest: hash(raw),
      catalog_digest: hash(options.catalog), mapping: options.mapping, mapping_digest: hash(options.mapping) },
  });
  event.replay = replayFor(event, authorizations);
  validateNormalizedEvent(event);
  return result('normalized', 'mechanical_normalization', event);
}
/** Observation and retry keys are distinct from object identity and from payload bytes. */
export function eventObservationKey(value) {
  if (value?.kind === 'normalized_event') validateNormalizedEvent(value); else validateRawEvent(value);
  return JSON.stringify([1, 'observation', value.partition.tenant_id, value.event_id]);
}
export function eventIdempotencyKey(value) {
  if (value?.kind === 'normalized_event') validateNormalizedEvent(value); else validateRawEvent(value);
  const p = value.kind === 'normalized_event' ? value.normalization.raw_partition : value.partition;
  return JSON.stringify([1, 'idempotency', p.tenant_id, p.project_id, p.source_installation_id,
    p.partition_id, value.producer.producer_id, value.producer.epoch, value.idempotency_key]);
}
/** Verify the exact referenced payload bytes after separately authorized retrieval. */
export function verifyEventPayload(value, bytes) {
  json(value); payload(value);
  assert(bytes instanceof Uint8Array, 'payload verification requires bytes');
  assert(value.digest !== null, 'payload digest unavailable');
  assert(value.digest === `sha256:${createHash('sha256').update(bytes).digest('hex')}`, 'payload digest mismatch');
  return true;
}
