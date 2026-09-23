import { canonical, fingerprint } from '../shared/contracts.mjs';
import { validateNormalizedEvent, sourceObjectKey, eventIdempotencyKey } from './event-provenance.mjs';
import { compilePolicyArtifact } from '../decisions/policy-artifacts.mjs';

export const CAUSAL_CONTRACT_VERSION = 1;
const MAX_ENTRIES = 4096;
const fail = message => { throw new TypeError(`Causal contract: ${message}`); };
const assert = (condition, message) => { if (!condition) fail(message); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const hash = value => `sha256:${fingerprint(value)}`;
const equal = (a, b) => canonical(a) === canonical(b);
const copy = value => JSON.parse(canonical(value));
const lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function json(value, ancestors = new Set(), budget = { count: 0 }) {
  assert(++budget.count <= 250000 && ancestors.size < 48, 'JSON bound exceeded');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') { assert(value.length <= 100000, 'string bound exceeded'); return; }
  if (typeof value === 'number') { assert(Number.isFinite(value), 'non-finite JSON'); return; }
  assert((plain(value) || Array.isArray(value)) && !ancestors.has(value), 'expected acyclic plain JSON');
  for (const key of Reflect.ownKeys(value)) {
    assert(typeof key === 'string', 'symbol keys are not JSON');
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assert(descriptor.enumerable && Object.hasOwn(descriptor, 'value'), 'expected JSON data properties');
    assert(!Array.isArray(value) || /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length, 'decorated array');
  }
  if (Array.isArray(value)) assert(Object.keys(value).length === value.length, 'sparse array');
  ancestors.add(value); Object.values(value).forEach(item => json(item, ancestors, budget)); ancestors.delete(value);
}
function fields(value, required, optional = []) {
  assert(plain(value), 'expected object');
  assert(required.every(key => Object.hasOwn(value, key)), 'missing field');
  assert(Object.keys(value).every(key => required.includes(key) || optional.includes(key)), 'unknown field');
}
function id(value) { assert(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(value), 'invalid identifier'); }
function digest(value) { assert(typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value), 'invalid digest'); }
function sequence(value) { assert(Number.isSafeInteger(value) && value >= 0, 'invalid sequence'); }
function list(value, max = MAX_ENTRIES) { assert(Array.isArray(value) && value.length <= max, 'invalid bounded list'); }
function scope(value) { fields(value, ['tenant_id', 'project_id']); Object.values(value).forEach(id); }
function partition(value) {
  fields(value, ['tenant_id', 'project_id', 'source_installation_id', 'partition_id']); Object.values(value).forEach(id);
}
function source(value) {
  fields(value, ['partition', 'producer']); partition(value.partition);
  fields(value.producer, ['producer_id', 'epoch']); Object.values(value.producer).forEach(id);
}
function ref(value) { fields(value, ['tenant_id', 'project_id', 'event_id']); Object.values(value).forEach(id); }
function eventRef(event) { return { tenant_id: event.partition.tenant_id, project_id: event.partition.project_id, event_id: event.event_id }; }
function sourceFromEvent(event) {
  return { partition: event.partition, producer: { producer_id: event.producer.producer_id, epoch: event.producer.epoch } };
}
function sortedRefs(refs) { return [...refs].sort((a, b) => lexical(canonical(a), canonical(b))); }
function sortedAcl(acl) { return { ...acl, allowed_principal_ids: [...acl.allowed_principal_ids].sort() }; }
/** Reusable strict partition/producer schema, without storage or authentication. */
export function validateSourcePartition(value) { json(value); source(value); return true; }
/** Epochs and producers never share sequence continuity, even within one installation. */
export function sourcePartitionKey(value) {
  json(value); source(value);
  const p = value.partition;
  return JSON.stringify([1, p.tenant_id, p.project_id, p.source_installation_id, p.partition_id,
    value.producer.producer_id, value.producer.epoch]);
}
/**
 * A source position binds source contents, not receipt metadata. Full event pins
 * in replay still include receipt and normalization metadata. See contract doc.
 */
export function sourceEventFingerprint(event) {
  validateNormalizedEvent(event);
  const contents = copy(event);
  delete contents.observed_at;
  delete contents.normalization;
  delete contents.replay;
  delete contents.provenance.delivery.delivery_id;
  contents.causal_parents = sortedRefs(contents.causal_parents);
  contents.acl = sortedAcl(contents.acl);
  contents.provenance.source_objects = contents.provenance.source_objects.map(item => ({ ...item, acl: sortedAcl(item.acl) }))
    .sort((a, b) => lexical(sourceObjectKey(a.object), sourceObjectKey(b.object)));
  return hash({ causal_contract_version: 1, asserted_partition: event.normalization.raw_partition,
    asserted_identity: event.normalization.raw_identity, contents });
}
function progress(entries, start, completedOnly = false) {
  const positions = entries.filter(item => item.sequence !== null && (!completedOnly || item.completed))
    .map(item => item.sequence).sort((a, b) => a - b);
  let cursor = null; let expected = start;
  for (const position of positions) {
    if (position !== expected) break;
    cursor = position;
    if (position === Number.MAX_SAFE_INTEGER) break;
    expected = position + 1;
  }
  return cursor;
}
function ranges(entries, start, head, completedOnly = false) {
  if (head === null || head < start) return [];
  const positions = entries.filter(item => item.sequence !== null && item.sequence <= head && (!completedOnly || item.completed))
    .map(item => item.sequence).sort((a, b) => a - b);
  const result = []; let expected = start;
  for (const position of positions) {
    if (position > expected) result.push({ from: expected, through: position - 1 });
    if (position === Number.MAX_SAFE_INTEGER) return result;
    expected = position + 1;
  }
  if (expected <= head) result.push({ from: expected, through: head });
  return result;
}
function derived(state) {
  const sequenced = state.entries.filter(item => item.sequence !== null);
  const maximum = sequenced.length ? Math.max(...sequenced.map(item => item.sequence)) : null;
  return { maximum_sequence: maximum, accepted_through: progress(state.entries, state.start_sequence),
    completed_through: progress(state.entries, state.start_sequence, true),
    gaps: ranges(state.entries, state.start_sequence, maximum),
    unordered_count: state.entries.filter(item => item.sequence === null).length };
}
function assertAcyclic(keys, parentsOf, message) {
  const visited = new Set(); const active = new Set();
  for (const initial of keys) {
    const stack = [{ key: initial, exiting: false }];
    while (stack.length) {
      const { key, exiting } = stack.pop();
      if (exiting) { active.delete(key); visited.add(key); continue; }
      assert(!active.has(key), message); if (visited.has(key)) continue;
      active.add(key); stack.push({ key, exiting: true });
      for (const parent of parentsOf(key)) stack.push({ key: parent, exiting: false });
    }
  }
}
function assertCausalEntries(entries) {
  const index = new Map(entries.map(item => [canonical(item.event_ref), item]));
  const edges = new Map();
  for (const item of entries) {
    const parents = [];
    for (const parentRef of item.causal_parents) {
      const parentKey = canonical(parentRef); const parent = index.get(parentKey);
      if (parent) {
        assert(item.sequence === null || parent.sequence === null || parent.sequence < item.sequence,
          'causal parent contradicts producer order');
        parents.push(parentKey);
      }
    }
    edges.set(canonical(item.event_ref), parents);
  }
  assertAcyclic(index.keys(), key => edges.get(key), 'causal cycle');
}
export function validateSourceCursor(state) {
  json(state);
  fields(state, ['schema_version', 'kind', 'source', 'start_sequence', 'entries', 'maximum_sequence',
    'accepted_through', 'completed_through', 'gaps', 'unordered_count']);
  assert(state.schema_version === 1 && state.kind === 'source_cursor', 'unsupported cursor');
  source(state.source); sequence(state.start_sequence); list(state.entries);
  const ids = new Set(); const positions = new Set(); const retries = new Set();
  for (const entry of state.entries) {
    fields(entry, ['event_ref', 'sequence', 'fingerprint', 'first_event_digest', 'idempotency_key', 'causal_parents', 'completed']);
    ref(entry.event_ref); digest(entry.fingerprint); digest(entry.first_event_digest);
    assert(typeof entry.idempotency_key === 'string' && entry.idempotency_key.length <= 2000, 'invalid retry key');
    assert(entry.event_ref.tenant_id === state.source.partition.tenant_id && entry.event_ref.project_id === state.source.partition.project_id,
      'entry scope mismatch');
    assert(!ids.has(entry.event_ref.event_id) && !retries.has(entry.idempotency_key), 'duplicate entry');
    ids.add(entry.event_ref.event_id); retries.add(entry.idempotency_key);
    if (entry.sequence !== null) {
      sequence(entry.sequence); assert(entry.sequence >= state.start_sequence && !positions.has(entry.sequence), 'invalid cursor position');
      positions.add(entry.sequence);
    }
    list(entry.causal_parents, 128); const parents = new Set();
    for (const parent of entry.causal_parents) {
      ref(parent); const key = canonical(parent);
      assert(parent.tenant_id === entry.event_ref.tenant_id && parent.project_id === entry.event_ref.project_id
        && parent.event_id !== entry.event_ref.event_id && !parents.has(key), 'invalid causal parent'); parents.add(key);
    }
    assert(typeof entry.completed === 'boolean', 'invalid completion flag');
  }
  assertCausalEntries(state.entries);
  const expected = derived(state);
  for (const [key, value] of Object.entries(expected)) assert(equal(state[key], value), 'cursor summary mismatch');
  return true;
}
/** start_sequence is an adapter-attested epoch start, never inferred from first arrival. */
export function createSourceCursor(input) {
  json(input); fields(input, ['partition', 'producer', 'start_sequence']);
  const stream = { partition: input.partition, producer: input.producer }; source(stream); sequence(input.start_sequence);
  const state = { schema_version: 1, kind: 'source_cursor', source: copy(stream), start_sequence: input.start_sequence, entries: [] };
  return freeze({ ...state, ...derived(state) });
}
export function acceptSourceEvent(state, event) {
  validateSourceCursor(state); validateNormalizedEvent(event);
  assert(sourcePartitionKey(state.source) === sourcePartitionKey(sourceFromEvent(event)), 'event belongs to another source partition or epoch');
  const seq = event.producer.sequence;
  assert(seq === null || seq >= state.start_sequence, 'event precedes attested epoch start');
  const entry = { event_ref: eventRef(event), sequence: seq, fingerprint: sourceEventFingerprint(event),
    first_event_digest: hash(event), idempotency_key: eventIdempotencyKey(event),
    causal_parents: sortedRefs(event.causal_parents), completed: false };
  const matches = state.entries.filter(item => item.event_ref.event_id === event.event_id
    || item.idempotency_key === entry.idempotency_key || seq !== null && item.sequence === seq);
  if (matches.length) {
    assert(matches.length === 1 && matches[0].fingerprint === entry.fingerprint, 'conflicting contents at existing source identity or position');
    return freeze({ status: 'duplicate', state: copy(state) });
  }
  assert(state.entries.length < MAX_ENTRIES, 'cursor capacity exceeded; external checkpoint required');
  const next = { ...copy(state), entries: [...copy(state.entries), entry] };
  Object.assign(next, derived(next)); validateSourceCursor(next);
  return freeze({ status: seq === null ? 'unordered' : state.maximum_sequence !== null && seq < state.maximum_sequence ? 'late' : 'accepted', state: next });
}
/** Completion is a caller's committed-projection attestation, not mere receipt. */
export function completeSourceEvent(state, input) {
  validateSourceCursor(state); json(input); fields(input, ['event_id', 'completed_parents']); id(input.event_id);
  list(input.completed_parents, 128); input.completed_parents.forEach(ref);
  const item = state.entries.find(entry => entry.event_ref.event_id === input.event_id);
  assert(item, 'completion refers to unaccepted event');
  assert(equal(sortedRefs(input.completed_parents), item.causal_parents), 'completion must attest exact scoped causal parents');
  for (const parent of item.causal_parents) {
    const local = state.entries.find(entry => equal(entry.event_ref, parent));
    assert(!local || local.completed, 'local causal parent projection incomplete');
  }
  const next = copy(state); next.entries.find(entry => entry.event_ref.event_id === input.event_id).completed = true;
  Object.assign(next, derived(next)); return freeze(next);
}
/** Requirements enumerate the intended source set and captured heads for this view. */
export function projectFreshness(input) {
  json(input); fields(input, ['scope', 'requirements', 'cursors']); scope(input.scope); list(input.requirements); list(input.cursors);
  const cursorMap = new Map();
  for (const cursor of input.cursors) {
    validateSourceCursor(cursor); const key = sourcePartitionKey(cursor.source);
    assert(!cursorMap.has(key), 'duplicate cursor'); cursorMap.set(key, cursor);
    assert(cursor.source.partition.tenant_id === input.scope.tenant_id && cursor.source.partition.project_id === input.scope.project_id,
      'cursor crosses Project scope');
  }
  const seen = new Set();
  const watermarks = input.requirements.map(requirement => {
    fields(requirement, ['source', 'target_sequence']); source(requirement.source);
    assert(requirement.source.partition.tenant_id === input.scope.tenant_id && requirement.source.partition.project_id === input.scope.project_id,
      'requirement crosses Project scope');
    if (requirement.target_sequence !== null) sequence(requirement.target_sequence);
    const key = sourcePartitionKey(requirement.source); assert(!seen.has(key), 'duplicate source requirement'); seen.add(key);
    const cursor = cursorMap.get(key); const target = requirement.target_sequence;
    let status; let reason;
    if (!cursor) { status = 'unknown'; reason = 'missing_source'; }
    else if (target === null) { status = 'unknown'; reason = 'head_not_captured'; }
    else if (target < cursor.start_sequence) { status = 'unknown'; reason = 'head_precedes_attested_start'; }
    else if (cursor.unordered_count > 0) { status = 'unknown'; reason = 'unsequenced_observations'; }
    else if (cursor.accepted_through === null || cursor.accepted_through < target) { status = 'known-gap'; reason = 'source_input_incomplete'; }
    else if (cursor.completed_through === null || cursor.completed_through < target) { status = 'known-gap'; reason = 'projection_incomplete'; }
    else { status = 'caught-up'; reason = 'captured_head_projected'; }
    return { source: copy(requirement.source), target_sequence: target, status, reason,
      accepted_through: cursor?.accepted_through ?? null, completed_through: cursor?.completed_through ?? null,
      maximum_sequence: cursor?.maximum_sequence ?? null,
      start_sequence: cursor?.start_sequence ?? null, unordered_count: cursor?.unordered_count ?? null,
      input_gaps: cursor && target !== null ? ranges(cursor.entries, cursor.start_sequence, target) : null,
      projection_gaps: cursor && target !== null ? ranges(cursor.entries, cursor.start_sequence, target, true) : null };
  });
  const status = !watermarks.length || watermarks.some(item => item.status === 'unknown') ? 'unknown'
    : watermarks.some(item => item.status === 'known-gap') ? 'known-gap' : 'caught-up';
  const result = { schema_version: 1, scope: copy(input.scope), status, watermarks };
  validateFreshnessVector(result); return freeze(result);
}
/** Validate a captured Project/Context vector; source facts remain adapter attestations. */
export function validateFreshnessVector(value) {
  json(value); fields(value, ['schema_version', 'scope', 'status', 'watermarks']); scope(value.scope);
  assert(value.schema_version === 1, 'unsupported freshness vector'); list(value.watermarks);
  const keys = new Set();
  for (const item of value.watermarks) {
    fields(item, ['source', 'target_sequence', 'status', 'reason', 'accepted_through', 'completed_through',
      'maximum_sequence', 'start_sequence', 'unordered_count', 'input_gaps', 'projection_gaps']);
    source(item.source); const key = sourcePartitionKey(item.source); assert(!keys.has(key), 'duplicate watermark'); keys.add(key);
    assert(item.source.partition.tenant_id === value.scope.tenant_id && item.source.partition.project_id === value.scope.project_id,
      'watermark crosses Project');
    for (const field of ['target_sequence', 'accepted_through', 'completed_through', 'maximum_sequence', 'start_sequence', 'unordered_count']) {
      if (item[field] !== null) sequence(item[field]);
    }
    for (const field of ['accepted_through', 'completed_through']) {
      if (item[field] !== null) assert(item.start_sequence !== null && item[field] >= item.start_sequence
        && item.maximum_sequence !== null && item[field] <= item.maximum_sequence, 'invalid watermark cursor');
    }
    assert(item.completed_through === null || item.accepted_through !== null && item.completed_through <= item.accepted_through,
      'projection exceeds accepted cursor');
    let status; let reason;
    if (item.start_sequence === null) {
      assert(['accepted_through', 'completed_through', 'maximum_sequence', 'unordered_count'].every(field => item[field] === null), 'missing source has progress');
      status = 'unknown'; reason = 'missing_source';
    } else {
      assert(item.unordered_count !== null && item.unordered_count <= MAX_ENTRIES, 'missing unordered count');
      assert(item.maximum_sequence === null || item.maximum_sequence >= item.start_sequence, 'maximum precedes start');
      // A known observation at the first missing position would extend the prefix,
      // even when a source head was never captured or lies before this epoch.
      assert(item.maximum_sequence === null || item.maximum_sequence === item.accepted_through
        || item.maximum_sequence !== (item.accepted_through === null ? item.start_sequence : item.accepted_through + 1),
      'maximum observation contradicts contiguous accepted prefix');
      if (item.target_sequence === null) { status = 'unknown'; reason = 'head_not_captured'; }
      else if (item.target_sequence < item.start_sequence) { status = 'unknown'; reason = 'head_precedes_attested_start'; }
      else if (item.unordered_count > 0) { status = 'unknown'; reason = 'unsequenced_observations'; }
      else if (item.accepted_through === null || item.accepted_through < item.target_sequence) { status = 'known-gap'; reason = 'source_input_incomplete'; }
      else if (item.completed_through === null || item.completed_through < item.target_sequence) { status = 'known-gap'; reason = 'projection_incomplete'; }
      else { status = 'caught-up'; reason = 'captured_head_projected'; }
    }
    assert(item.status === status && item.reason === reason, 'freshness status mismatch');
    for (const [field, cursorField] of [['input_gaps', 'accepted_through'], ['projection_gaps', 'completed_through']]) {
      if (item.start_sequence === null || item.target_sequence === null) { assert(item[field] === null, 'unknown range must be null'); continue; }
      list(item[field], MAX_ENTRIES + 1); let previous = null;
      for (const range of item[field]) {
        fields(range, ['from', 'through']); sequence(range.from); sequence(range.through);
        assert(range.from >= item.start_sequence && range.from <= range.through && range.through <= item.target_sequence
          && (previous === null || range.from > previous + 1), 'invalid gap range'); previous = range.through;
      }
      const cursor = item[cursorField];
      if (item.target_sequence < item.start_sequence || cursor !== null && cursor >= item.target_sequence) assert(item[field].length === 0, 'continuous prefix has gaps');
      else assert(item[field].length > 0 && item[field][0].from === (cursor === null ? item.start_sequence : cursor + 1), 'missing first gap');
    }
    if (item.input_gaps !== null) {
      const covers = (ranges, from, through) => ranges.some(range => range.from <= from && range.through >= through);
      for (const gap of item.input_gaps) assert(covers(item.projection_gaps, gap.from, gap.through), 'missing input is reported projected');
      if (item.target_sequence >= item.start_sequence) {
        if (item.maximum_sequence === null) {
          const missing = [{ from: item.start_sequence, through: item.target_sequence }];
          assert(equal(item.input_gaps, missing) && equal(item.projection_gaps, missing), 'unobserved source has known positions');
        } else {
          assert(!covers(item.input_gaps, item.maximum_sequence, item.maximum_sequence), 'maximum observation is reported missing');
          if (item.maximum_sequence < item.target_sequence) {
            assert(covers(item.input_gaps, item.maximum_sequence + 1, item.target_sequence)
              && covers(item.projection_gaps, item.maximum_sequence + 1, item.target_sequence), 'unobserved tail is reported complete');
          }
        }
      }
    }
  }
  const status = !value.watermarks.length || value.watermarks.some(item => item.status === 'unknown') ? 'unknown'
    : value.watermarks.some(item => item.status === 'known-gap') ? 'known-gap' : 'caught-up';
  assert(value.status === status, 'Project freshness mismatch'); return true;
}

function commit(value) { assert(value?.kind === 'git_commit', 'expected immutable Git commit'); sourceObjectKey(value); }
function repositoryKey(value) { return canonical([value.tenant_id, value.repository_id, value.object_format]); }
/** A partial DAG returns unknown, not unrelated; timestamps never enter reachability. */
export function classifyGitRefMovement(input) {
  json(input); fields(input, ['ref', 'before', 'after', 'commits', 'reported_operation']);
  fields(input.ref, ['tenant_id', 'repository_id', 'object_format', 'name']);
  id(input.ref.tenant_id); id(input.ref.repository_id); assert(['sha1', 'sha256'].includes(input.ref.object_format), 'invalid object format');
  assert(typeof input.ref.name === 'string' && input.ref.name.length <= 1024 && input.ref.name.startsWith('refs/')
    && !/[\x00-\x20\x7f~^:?*\[\\]/.test(input.ref.name) && !input.ref.name.includes('..') && !input.ref.name.includes('@{')
    && input.ref.name.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock')), 'invalid full ref name');
  assert(['update', 'force_push', 'rebase'].includes(input.reported_operation), 'invalid reported operation');
  assert(input.before !== null || input.after !== null, 'empty ref movement'); list(input.commits);
  const repo = repositoryKey(input.ref);
  function scoped(value) { commit(value); assert(repositoryKey(value) === repo, 'commit crosses repository identity'); }
  if (input.before !== null) scoped(input.before); if (input.after !== null) scoped(input.after);
  const graph = new Map();
  for (const entry of input.commits) {
    fields(entry, ['commit', 'parents', 'parents_complete']); scoped(entry.commit); list(entry.parents, 128);
    assert(typeof entry.parents_complete === 'boolean', 'missing ancestry completeness');
    const key = sourceObjectKey(entry.commit); assert(!graph.has(key), 'duplicate commit record'); const parents = new Set();
    for (const parent of entry.parents) { scoped(parent); const p = sourceObjectKey(parent); assert(p !== key && !parents.has(p), 'invalid Git parent'); parents.add(p); }
    graph.set(key, { parents: [...parents], complete: entry.parents_complete });
  }
  assertAcyclic(graph.keys(), key => graph.get(key)?.parents ?? [], 'Git ancestry cycle');
  function ancestor(older, newer) {
    const oldKey = sourceObjectKey(older); const stack = [sourceObjectKey(newer)]; const seen = new Set(); let missing = false;
    while (stack.length) {
      const key = stack.pop(); if (key === oldKey) return 'yes'; if (seen.has(key)) continue; seen.add(key);
      const node = graph.get(key); if (!node) { missing = true; continue; }
      if (!node.complete) missing = true; stack.push(...node.parents);
    }
    return missing ? 'unknown' : 'no';
  }
  let movement; let forward = null; let backward = null;
  if (input.before === null) movement = 'create';
  else if (input.after === null) movement = 'delete';
  else {
    forward = ancestor(input.before, input.after); backward = ancestor(input.after, input.before);
    movement = sourceObjectKey(input.before) === sourceObjectKey(input.after) ? 'unchanged'
      : forward === 'yes' ? 'advance' : backward === 'yes' ? 'rewind'
        : forward === 'unknown' || backward === 'unknown' ? 'unknown' : 'diverge';
  }
  return freeze({ schema_version: 1, ref: copy(input.ref), before: copy(input.before), after: copy(input.after),
    reported_operation: input.reported_operation, movement, before_is_ancestor: forward, after_is_ancestor: backward });
}

function graphPin(value) { fields(value, ['generation_id', 'snapshot_digest']); id(value.generation_id); digest(value.snapshot_digest); }
export function validateGraphGenerationPin(value) { json(value); graphPin(value); return true; }
function modelDescriptor(value) {
  fields(value, ['model_id', 'provider', 'model', 'model_revision', 'adapter_id', 'adapter_version', 'parameters_digest']);
  for (const key of ['model_id', 'provider', 'model', 'model_revision', 'adapter_id', 'adapter_version']) id(value[key]);
  digest(value.parameters_digest);
}
function manifestBody(input) {
  fields(input, ['replay_id', 'scope', 'input_graph', 'output_generation_id', 'events', 'policy', 'models', 'model_bindings']);
  id(input.replay_id); scope(input.scope); graphPin(input.input_graph); id(input.output_generation_id);
  assert(input.output_generation_id !== input.input_graph.generation_id, 'replay output must have a separate generation');
  list(input.events); list(input.models, 128);
  const modelIds = new Set();
  for (const model of input.models) { modelDescriptor(model); assert(!modelIds.has(model.model_id), 'duplicate model descriptor'); modelIds.add(model.model_id); }
  assert(input.policy?.kind === 'policy_artifact', 'replay requires a compiled versioned Policy artifact');
  const policy = compilePolicyArtifact(input.policy.definition, { operations: input.policy.operations });
  assert(equal(policy, input.policy), 'policy pin or descriptor mismatch');
  const judges = Object.entries(policy.definition.nodes).filter(([, node]) => node.type === 'judge').map(([key]) => key);
  fields(input.model_bindings, judges);
  for (const modelId of Object.values(input.model_bindings)) assert(modelIds.has(modelId), 'judge model descriptor missing');
  const observations = new Set(); const retries = new Set(); const positions = new Set();
  const inputs = input.events.map(event => {
    validateNormalizedEvent(event);
    assert(event.partition.tenant_id === input.scope.tenant_id && event.partition.project_id === input.scope.project_id, 'replay event crosses Project');
    assert(event.replay.eligible, 'replay input is not immutable and authorized');
    const observation = canonical(eventRef(event)); const retry = eventIdempotencyKey(event);
    assert(!observations.has(observation) && !retries.has(retry), 'duplicate replay observation'); observations.add(observation); retries.add(retry);
    if (event.producer.sequence !== null) {
      const position = canonical([sourcePartitionKey(sourceFromEvent(event)), event.producer.sequence]);
      assert(!positions.has(position), 'duplicate replay source position'); positions.add(position);
    }
    return { event: copy(event), event_digest: hash(event), payload_digest: event.payload.digest };
  });
  return { schema_version: 1, kind: 'replay_manifest', replay_id: input.replay_id, scope: copy(input.scope),
    input_graph: copy(input.input_graph), output_generation_id: input.output_generation_id, inputs, policy,
    models: [...copy(input.models)].sort((a, b) => lexical(a.model_id, b.model_id)), model_bindings: copy(input.model_bindings) };
}
/** Frozen replay input and operation descriptors; this neither retrieves nor calls models. */
export function createReplayManifest(input) {
  json(input); const body = manifestBody(input); return freeze({ ...body, manifest_digest: hash(body) });
}
export function validateReplayManifest(manifest) {
  json(manifest);
  fields(manifest, ['schema_version', 'kind', 'replay_id', 'scope', 'input_graph', 'output_generation_id', 'inputs', 'policy', 'models', 'model_bindings', 'manifest_digest']);
  assert(manifest.schema_version === 1 && manifest.kind === 'replay_manifest', 'unsupported replay manifest'); list(manifest.inputs);
  for (const input of manifest.inputs) { fields(input, ['event', 'event_digest', 'payload_digest']); digest(input.event_digest); digest(input.payload_digest); }
  const body = manifestBody({ replay_id: manifest.replay_id, scope: manifest.scope, input_graph: manifest.input_graph,
    output_generation_id: manifest.output_generation_id, events: manifest.inputs.map(item => item.event), policy: manifest.policy, models: manifest.models, model_bindings: manifest.model_bindings });
  digest(manifest.manifest_digest); assert(equal(manifest, { ...body, manifest_digest: hash(body) }), 'replay pins mismatch'); return true;
}
/** A deny-by-default boundary. Adapters must call this before dispatching an effect. */
export function assertReplayEffect(manifest, effect) {
  validateReplayManifest(manifest); json(effect);
  fields(effect, ['kind', 'record_id', 'replay_id', 'manifest_digest', 'scope', 'generation_id', 'data']);
  assert(['replay_derived_write', 'replay_audit_append'].includes(effect.kind), 'live or external replay effect forbidden');
  id(effect.record_id); id(effect.replay_id); digest(effect.manifest_digest); scope(effect.scope); id(effect.generation_id);
  assert(effect.replay_id === manifest.replay_id && effect.manifest_digest === manifest.manifest_digest && equal(effect.scope, manifest.scope)
    && effect.generation_id === manifest.output_generation_id, 'effect crosses replay generation');
  assert(plain(effect.data), 'replay data must be an object'); return true;
}
export function createReplayState(manifest) {
  validateReplayManifest(manifest);
  return freeze({ schema_version: 1, kind: 'replay_state', replay_id: manifest.replay_id, manifest_digest: manifest.manifest_digest,
    scope: copy(manifest.scope), generation_id: manifest.output_generation_id, records: [] });
}
/** Pure reference dispatcher: no live store, connector, queue, callback or writer handle is accepted. */
export function applyReplayEffect(state, manifest, effect) {
  assertReplayEffect(manifest, effect); json(state);
  fields(state, ['schema_version', 'kind', 'replay_id', 'manifest_digest', 'scope', 'generation_id', 'records']); list(state.records);
  const empty = createReplayState(manifest);
  assert(equal({ ...state, records: [] }, empty), 'state crosses replay generation');
  const ids = new Set();
  for (const record of state.records) { assertReplayEffect(manifest, record); assert(!ids.has(record.record_id), 'duplicate replay record'); ids.add(record.record_id); }
  const existing = state.records.find(record => record.record_id === effect.record_id);
  if (existing) { assert(equal(existing, effect), 'replay record identity conflict'); return freeze(copy(state)); }
  assert(state.records.length < MAX_ENTRIES, 'replay state capacity exceeded');
  return freeze({ ...copy(state), records: [...copy(state.records), copy(effect)] });
}
