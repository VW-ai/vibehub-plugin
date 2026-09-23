import { createHash } from 'node:crypto';
import { sourceObjectKey, validateNormalizedEvent, eventObservationKey } from './event-provenance.mjs';
import { classifyGitRefMovement } from './causal-ordering.mjs';

export const GIT_PROVENANCE_VERSION = 1;
const assert = (ok, message) => { if (!ok) throw new TypeError(`Git provenance: ${message}`); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function json(value, ancestors = new Set(), budget = { count: 0 }) {
  assert(++budget.count <= 250000 && ancestors.size < 32, 'JSON limit exceeded');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') { assert(value.length <= 16 * 1024 * 1024, 'string limit exceeded'); return; }
  if (typeof value === 'number') { assert(Number.isFinite(value), 'non-finite number'); return; }
  assert((plain(value) || Array.isArray(value)) && !ancestors.has(value), 'expected acyclic JSON');
  assert(Object.getOwnPropertySymbols(value).length === 0, 'symbol keys unsupported');
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (Array.isArray(value) && key === 'length') continue;
    assert(Object.hasOwn(descriptor, 'value') && descriptor.enumerable, 'expected data properties');
    assert(!Array.isArray(value) || /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length, 'invalid array property');
  }
  if (Array.isArray(value)) assert(Object.keys(value).length === value.length, 'sparse array');
  ancestors.add(value); for (const item of Object.values(value)) json(item, ancestors, budget); ancestors.delete(value);
}
function fields(value, keys) {
  assert(plain(value) && keys.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => keys.includes(key)), 'invalid fields');
}
function stable(value) {
  return JSON.stringify(value, (_key, item) => plain(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
const copy = value => JSON.parse(stable(value));
const same = (a, b) => stable(a) === stable(b);
const hash = value => `sha256:${createHash('sha256').update(stable(value)).digest('hex')}`;
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function list(value, max = 4096) { assert(Array.isArray(value) && value.length <= max, 'invalid bounded array'); }
function digest(value) { assert(typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value), 'invalid digest'); }
function id(value) { assert(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/.test(value), 'invalid identifier'); }
function object(value) { assert(value?.kind === 'git_commit', 'expected Git commit identity'); sourceObjectKey(value); }
function oid(value, format) { assert(typeof value === 'string' && new RegExp(`^[a-f0-9]{${format === 'sha1' ? 40 : 64}}$`).test(value), 'invalid full OID'); }
function bytes(value) {
  assert(typeof value === 'string' && Buffer.from(value, 'base64').toString('base64') === value, 'invalid canonical base64');
  return Buffer.from(value, 'base64');
}
function path(value) {
  const raw = bytes(value); assert(raw.length > 0 && raw.length <= 4096 && !raw.includes(0)
    && raw[0] !== 47 && raw.toString('latin1').split('/').every(part => part && part !== '.' && part !== '..'), 'invalid Git path bytes');
}
function person(value) {
  fields(value, ['name_base64', 'email_base64', 'timestamp_seconds', 'timezone']); bytes(value.name_base64); bytes(value.email_base64);
  assert(Number.isSafeInteger(value.timestamp_seconds), 'invalid Git timestamp');
  assert(typeof value.timezone === 'string' && /^[+-]\d{4}$/.test(value.timezone), 'invalid Git timezone');
}
const content = value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'changed_paths'));

/** A serializable commit snapshot. Changed paths are per-base observations, never part of object identity. */
export function validateGitCommit(value) {
  json(value);
  if (value?.kind === 'unresolved_git_commit') {
    fields(value, ['schema_version', 'kind', 'object', 'reason']); object(value.object);
    assert(value.schema_version === 1 && ['object_unavailable', 'not_commit', 'read_failed', 'limit_exceeded', 'unsupported_commit'].includes(value.reason), 'invalid unresolved pointer');
    return true;
  }
  fields(value, ['schema_version', 'kind', 'object', 'tree_oid', 'parent_oids', 'author', 'committer', 'raw_commit_digest', 'message_base64', 'changed_paths']);
  assert(value.schema_version === 1 && value.kind === 'git_commit_record', 'unsupported commit schema'); object(value.object);
  const format = value.object.object_format; oid(value.tree_oid, format); list(value.parent_oids, 128);
  for (const parent of value.parent_oids) { oid(parent, format); assert(parent !== value.object.oid, 'self parent'); }
  assert(new Set(value.parent_oids).size === value.parent_oids.length, 'duplicate parent');
  person(value.author); person(value.committer); digest(value.raw_commit_digest); bytes(value.message_base64);
  list(value.changed_paths, 128);
  assert(value.changed_paths.length === Math.max(1, value.parent_oids.length), 'each parent needs an explicit diff base');
  for (const [i, diff] of value.changed_paths.entries()) {
    fields(diff, ['base', 'status', 'reason', 'changes']); fields(diff.base, ['kind', 'oid']); oid(diff.base.oid, format);
    if (value.parent_oids.length) assert(diff.base.kind === 'parent' && diff.base.oid === value.parent_oids[i], 'diff base differs from ordered parent');
    else assert(diff.base.kind === 'empty_tree' && diff.base.oid === createHash(format).update('tree 0\0').digest('hex'), 'invalid root diff base');
    list(diff.changes);
    assert(diff.status === 'resolved' && diff.reason === null || diff.status === 'unresolved'
      && ['base_unavailable', 'tree_unavailable', 'read_failed', 'limit_exceeded'].includes(diff.reason) && diff.changes.length === 0, 'invalid diff resolution');
    const paths = new Set();
    for (const change of diff.changes) {
      fields(change, ['status', 'path_base64', 'old_mode', 'new_mode', 'old_oid', 'new_oid']);
      assert(['A', 'D', 'M', 'T'].includes(change.status), 'invalid diff status'); path(change.path_base64);
      assert(!paths.has(change.path_base64), 'duplicate changed path'); paths.add(change.path_base64);
      for (const side of ['old', 'new']) {
        assert(typeof change[`${side}_mode`] === 'string' && /^(000000|100644|100755|120000|160000|040000)$/.test(change[`${side}_mode`]), 'invalid Git mode');
        if (change[`${side}_oid`] !== null) oid(change[`${side}_oid`], format);
        assert((change[`${side}_oid`] === null) === (change[`${side}_mode`] === '000000'), 'mode and OID absence mismatch');
      }
      assert(change.status === 'A' ? change.old_oid === null && change.new_oid !== null
        : change.status === 'D' ? change.old_oid !== null && change.new_oid === null
          : change.old_oid !== null && change.new_oid !== null, 'status and OID absence mismatch');
    }
  }
  return true;
}
export function createGitCommit(value) { validateGitCommit(value); return freeze(copy(value)); }

/** Keep the complete normalized event and its ACL; correlation grants no access. */
export function createGitCommitObservation(input) {
  json(input); fields(input, ['commit', 'event']); validateGitCommit(input.commit); validateNormalizedEvent(input.event);
  const key = sourceObjectKey(input.commit.object); const event = input.event;
  assert(event.event_type === 'GIT_COMMIT' && event.partition.tenant_id === input.commit.object.tenant_id
    && event.identity.repository_id === input.commit.object.repository_id, 'commit observation scope/type mismatch');
  assert(event.provenance.source_objects.some(item => sourceObjectKey(item.object) === key), 'commit observation lacks source support');
  if (event.payload.kind === 'git_revision' && event.payload.path === null && sourceObjectKey(event.payload.object) === key
    && input.commit.kind === 'git_commit_record') assert(event.payload.digest === input.commit.raw_commit_digest, 'commit payload digest mismatch');
  return freeze({ schema_version: 1, kind: 'git_commit_observation', object_key: key,
    observation_ref: { tenant_id: event.partition.tenant_id, project_id: event.partition.project_id, event_id: event.event_id },
    observation_key: eventObservationKey(event), event_digest: hash(event), commit: copy(input.commit), event: copy(event) });
}
function observation(value) {
  fields(value, ['schema_version', 'kind', 'object_key', 'observation_ref', 'observation_key', 'event_digest', 'commit', 'event']);
  assert(same(value, createGitCommitObservation({ commit: value.commit, event: value.event })), 'observation pins mismatch');
}
export function correlateGitCommitObservations(values) {
  json(values); list(values); const groups = new Map(); const seen = new Map();
  for (const value of values) {
    observation(value); const previous = seen.get(value.observation_key);
    if (previous) { assert(same(value, previous), 'observation identity conflict'); continue; }
    seen.set(value.observation_key, value);
    let group = groups.get(value.object_key);
    if (!group) { group = { object_key: value.object_key, object: copy(value.commit.object), content: null, observation_refs: [], observations: [] }; groups.set(value.object_key, group); }
    if (value.commit.kind === 'git_commit_record') {
      const candidate = content(value.commit); assert(group.content === null || same(group.content, candidate), 'immutable commit content conflict'); group.content = copy(candidate);
    }
    group.observation_refs.push(copy(value.observation_ref)); group.observations.push(copy(value));
  }
  return freeze([...groups.values()]);
}

/** Caller supplies observed endpoints and ancestry; reported command is not inferred. */
export function createRefMovement(input) {
  json(input); fields(input, ['ref', 'before', 'after', 'commits', 'reported_operation', 'event']);
  const { event, ...causal } = input; validateNormalizedEvent(event);
  const result = classifyGitRefMovement(causal);
  assert(event.event_type === 'GIT_REF_CHANGED' && event.partition.tenant_id === result.ref.tenant_id
    && event.identity.repository_id === result.ref.repository_id, 'ref observation scope/type mismatch');
  for (const endpoint of [result.before, result.after].filter(Boolean)) assert(event.provenance.source_objects.some(item =>
    sourceObjectKey(item.object) === sourceObjectKey(endpoint)), 'ref endpoint lacks source support');
  const classification = { advance: 'fast-forward', diverge: 'force' }[result.movement] ?? result.movement;
  const body = { schema_version: 1, kind: 'git_ref_movement', ...copy(result), classification,
    ancestry: copy(input.commits), event: copy(event), observation_key: eventObservationKey(event), event_digest: hash(event) };
  return freeze({ ...body, movement_id: hash(body) });
}
export function validateRefMovement(value) {
  json(value); fields(value, ['schema_version', 'kind', 'ref', 'before', 'after', 'reported_operation', 'movement', 'before_is_ancestor',
    'after_is_ancestor', 'classification', 'ancestry', 'event', 'observation_key', 'event_digest', 'movement_id']);
  const expected = createRefMovement({ ref: value.ref, before: value.before, after: value.after, commits: value.ancestry,
    reported_operation: value.reported_operation, event: value.event });
  assert(same(value, expected), 'ref movement pins mismatch'); return true;
}
/** A proposal about a narrowly scoped ref-head claim; never edits a claim or old provenance. */
export function assessGitClaimAfterMovement(claim, movement) {
  json(claim); validateRefMovement(movement);
  fields(claim, ['claim_id', 'basis']); id(claim.claim_id);
  let status = 'unaffected'; let reason = 'different_ref_or_revision';
  if (claim.basis?.kind === 'exact_commit') {
    fields(claim.basis, ['kind', 'object']); object(claim.basis.object); reason = 'immutable_commit_claim';
  } else {
    fields(claim.basis, ['kind', 'ref', 'object']); assert(claim.basis.kind === 'ref_head', 'unsupported claim basis'); object(claim.basis.object);
    classifyGitRefMovement({ ref: claim.basis.ref, before: claim.basis.object, after: null, commits: [], reported_operation: 'update' });
    if (same(claim.basis.ref, movement.ref) && movement.before !== null
      && sourceObjectKey(claim.basis.object) === sourceObjectKey(movement.before) && movement.movement !== 'unchanged') {
      status = 'stale'; reason = 'observed_ref_head_changed';
    }
  }
  return freeze({ schema_version: 1, claim_id: claim.claim_id, status, reason, movement_id: movement.movement_id,
    observation_key: movement.observation_key });
}
