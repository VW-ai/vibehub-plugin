import { createHash } from 'node:crypto';
import { validateIdentityCatalog, resolveIdentity } from '../identity/identity.mjs';
import { validateNormalizedEvent, effectiveEventAccess, eventObservationKey, sourceObjectKey } from '../sources/event-provenance.mjs';
import { validateFreshnessVector, sourcePartitionKey } from '../sources/causal-ordering.mjs';
import { validateSemanticRevision, validateSemanticAddress, validateGraphConflict,
  exactRevisionAddress, semanticAddress, canonicalArtifactAddress, SEMANTIC_STATES, SEMANTIC_RELATIONS } from './working-graph.mjs';

export const INCREMENTAL_GRAPH_CONTRACT_VERSION = 2;
export const INCREMENTAL_GRAPH_LIMITS = Object.freeze({ bytes: 1048576, depth: 16, nodes: 50000,
  support: 32, page: 64, mutationReads: 256, pointReads: 256, pageReads: 2048 });
const fail = message => { throw new TypeError(`Incremental Graph: ${message}`); };
const assert = (ok, message) => { if (!ok) fail(message); };
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
function inert(v, stack = new Set(), count = { n: 0 }) {
  assert(++count.n <= 50000 && stack.size < 16, 'JSON budget exceeded');
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return;
  if (typeof v === 'number') { assert(Number.isFinite(v), 'invalid JSON number'); return; }
  assert((plain(v) || Array.isArray(v)) && !stack.has(v), 'inert JSON required');
  assert(Object.getOwnPropertySymbols(v).length === 0, 'symbol property');
  for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
    if (Array.isArray(v) && key === 'length') continue;
    assert(Object.hasOwn(d, 'value') && d.enumerable, 'data property required');
    assert(!Array.isArray(v) || /^(0|[1-9]\d*)$/.test(key) && Number(key) < v.length, 'array property');
  }
  if (Array.isArray(v)) assert(Object.keys(v).length === v.length, 'sparse array');
  stack.add(v); Object.values(v).forEach(x => inert(x, stack, count)); stack.delete(v);
}
function json(v) { inert(v); assert(Buffer.byteLength(JSON.stringify(v)) <= 1048576, 'JSON bytes exceeded'); }
const canonical = v => Array.isArray(v) ? v.map(canonical) : plain(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const stable = v => JSON.stringify(canonical(v));
const hash = v => `sha256:${createHash('sha256').update(stable(v)).digest('hex')}`;
const same = (a, b) => stable(a) === stable(b);
const copy = v => JSON.parse(stable(v));
const order = list => [...list].sort((a, b) => stable(a) < stable(b) ? -1 : stable(a) > stable(b) ? 1 : 0);
const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
const result = v => { json(v); return freeze(copy(v)); };
function fields(v, required, optional = []) {
  assert(plain(v) && required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k)), 'invalid fields');
}
const id = v => assert(typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(v), 'invalid identifier');
const digest = v => assert(typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v), 'invalid digest');
const uint = v => assert(Number.isSafeInteger(v) && v >= 0, 'invalid integer');
const list = (v, max = 32) => assert(Array.isArray(v) && v.length <= max, 'list budget exceeded');
function scope(v) { fields(v, ['tenant_id', 'project_id']); id(v.tenant_id); id(v.project_id); }
function wire(v, kind) { assert(v.schema_version === 2 && v.kind === kind, 'unsupported wire version/kind'); scope(v.scope); id(v.generation_id); }
function pin(v) { fields(v, ['revision_id', 'digest']); id(v.revision_id); digest(v.digest); }
function bound(v, selected) { assert(same(v.scope, selected.scope) && v.generation_id === selected.generation_id, 'scope/generation mismatch'); }
const source = e => ({ partition: e.partition, producer: { producer_id: e.producer.producer_id, epoch: e.producer.epoch } });
const rowKey = (kind, key) => stable([kind, key]);
const immutableKinds = new Set(['manifest', 'revision', 'conflict', 'resolution', 'access_update']);
const projectionKinds = new Set(['entity', 'assertion_id', 'source_epoch', 'source_object', 'source_object_epoch', 'source_access']);
function keyShape(kind, key) {
  const lengths = { manifest: 1, commit: 1, catalog: 2, revision: 1, entity: 2, assertion_id: 1,
    accepted_event: 1, source_epoch: 1, source_object: 1, source_object_epoch: 2, source_access: 1, conflict: 1, resolution: 1, access_update: 1 };
  assert(Object.hasOwn(lengths, kind) && Array.isArray(key) && key.length === lengths[kind]
    && key.every(v => typeof v === 'string' && v.length > 0 && v.length <= 4096), 'invalid selected key');
}

function exact(ref, view) { validateSemanticAddress(ref); bound(ref, view.current); assert(ref.kind === 'semantic_revision', 'exact semantic reference required'); }
function pins(e) {
  return [{ key: stable(['event', eventObservationKey(e)]), source: source(e), object: null, acl: e.acl, sensitivity: e.sensitivity },
    ...e.provenance.source_objects.map(s => ({ key: stable(['object', eventObservationKey(e), sourceObjectKey(s.object)]), source: source(e), ...s }))];
}
function closure(events, accessEvents = []) {
  const unique = new Map();
  for (const e of events) {
    validateNormalizedEvent(e); assert(e.provenance.source_objects.length > 0, 'support event requires source objects');
    const key = eventObservationKey(e); assert(!unique.has(key) || same(unique.get(key), e), 'event identity rebound'); unique.set(key, e);
  }
  const ordered = [...unique.values()].sort((a, b) => eventObservationKey(a) < eventObservationKey(b) ? -1 : eventObservationKey(a) > eventObservationKey(b) ? 1 : 0);
  list(ordered); const objects = new Set(ordered.flatMap(e => e.provenance.source_objects.map(s => sourceObjectKey(s.object)))); assert(objects.size <= 32, 'source closure budget exceeded');
  const sourcePins = new Map(); for (const e of ordered) for (const p of pins(e)) sourcePins.set(stable(p), p);
  const access = [...accessEvents].sort((a, b) => hash(a) < hash(b) ? -1 : hash(a) > hash(b) ? 1 : 0); list(access);
  assert(new Set(access.map(hash)).size === access.length, 'duplicate access revision');
  const effective = [...ordered, ...access].map(effectiveEventAccess), levels = ['normal', 'sensitive', 'restricted'];
  return { schema_version: 1, events: ordered, access_events: access, source_pins: order([...sourcePins.values()]), effective_access: {
    allowed_principal_ids: effective.length ? effective[0].allowed_principal_ids.filter(p => effective.every(a => a.allowed_principal_ids.includes(p))).sort() : [],
    sensitivity: levels[Math.max(0, ...effective.map(a => levels.indexOf(a.sensitivity)))] } };
}
function supportRefs(a, view) {
  const refs = [...a.parents];
  if (a.entity_kind === 'relation') for (const p of [a.content.from, a.content.to]) {
    if (p.kind === 'canonical_artifact') assert(same(p, canonicalArtifactAddress(p.event)) && same(p.scope, view.current.scope), 'canonical endpoint mismatch');
    else { exact(p, view); refs.push(p); }
  }
  refs.forEach(p => exact(p, view)); list(refs); return refs;
}
function directEvents(a, view) {
  const events = [...a.events];
  for (const p of a.canonical_refs) { assert(same(p, canonicalArtifactAddress(p.event)) && same(p.scope, view.current.scope), 'canonical association mismatch'); events.push(p.event); }
  if (a.entity_kind === 'relation') for (const p of [a.content.from, a.content.to]) if (p.kind === 'canonical_artifact') events.push(p.event);
  events.forEach(e => view.event(e)); return events;
}
function revision(view, ref, at) {
  exact(ref, view); const cacheKey = stable([at, ref]);
  if (view.revisions.has(cacheKey)) return view.revisions.get(cacheKey);
  assert(!view.visiting.has(cacheKey) && view.revisions.size + view.visiting.size < 32, 'support closure budget/cycle'); view.visiting.add(cacheKey);
  const r = view.fact('revision', [ref.revision_digest], at).value;
  if (!r) { view.visiting.delete(cacheKey); return null; }
  validateSemanticRevision(r); assert(same(exactRevisionAddress(r), ref), 'revision address mismatch');
  list(r.assertion.parents); list(r.assertion.events); list(r.assertion.canonical_refs);
  const events = directEvents(r.assertion, view);
  for (const parent of supportRefs(r.assertion, view)) {
    const selected = revision(view, parent, at); assert(selected, 'missing exact supporting revision'); events.push(...selected.provenance.events);
  }
  r.provenance.access_events.forEach(e => view.event(e));
  assert(same(r.provenance, closure(events, r.provenance.access_events)), 'incomplete provenance closure');
  view.visiting.delete(cacheKey); view.revisions.set(cacheKey, r); return r;
}
function entity(view, kind, entityId, at) {
  const e = view.fact('entity', [kind, entityId], at).value; if (!e) return null;
  fields(e, ['entity_kind', 'entity_id', 'head', 'competing', 'open_conflicts']); entityName(e);
  assert(e.entity_kind === kind && e.entity_id === entityId, 'entity key mismatch'); exact(e.head, view); list(e.competing); list(e.open_conflicts);
  const refs = [e.head, ...e.competing]; refs.forEach(p => { exact(p, view); assert(p.entity_kind === kind && p.entity_id === entityId, 'head entity mismatch'); });
  assert(new Set(e.competing.map(stable)).size === e.competing.length && new Set(e.open_conflicts).size === e.open_conflicts.length, 'duplicate conflict projection');
  e.open_conflicts.forEach(digest); return e;
}
function conflicts(view, e, at) {
  if (!e) return [];
  const out = e.open_conflicts.map(d => {
    const c = view.fact('conflict', [d], at).value; assert(c, 'missing conflict'); validateGraphConflict(c); bound(c, view.current);
    assert(c.conflict_digest === d && c.entity_kind === e.entity_kind && c.entity_id === e.entity_id, 'conflict key mismatch');
    assert(view.fact('resolution', [d], at).value === null, 'resolved conflict is still open'); return c;
  });
  const expected = [...new Map(out.flatMap(c => c.assertions).map(p => [stable(p), p])).values()];
  assert(same(e.competing, expected), 'conflict projection incomplete'); return out;
}
function updates(view, events) {
  const objects = new Map(events.flatMap(e => e.provenance.source_objects.map(s => [sourceObjectKey(s.object), s.object]))); assert(objects.size <= 32, 'source closure budget');
  const all = new Map();
  for (const [key, object] of objects) {
    const value = view.fact('source_access', [key]).value;
    if (!value) continue;
    fields(value, ['object', 'updates']); assert(same(value.object, object), 'source access key mismatch'); list(value.updates);
    const seen = new Set();
    for (const u of value.updates) {
      fields(u, ['event', 'event_digest', 'access_state']); view.event(u.event);
      assert(hash(u.event) === u.event_digest && ['SOURCE_ACCESS_CHANGED', 'SOURCE_TOMBSTONE'].includes(u.event.event_type)
        && ['active', 'unknown', 'tombstoned'].includes(u.access_state), 'invalid access update');
      assert(u.event.provenance.source_objects.some(s => sourceObjectKey(s.object) === key), 'access target mismatch');
      const epoch = sourcePartitionKey(source(u.event)); assert(!seen.has(epoch), 'duplicate observer restriction'); seen.add(epoch);
      const admitted = view.fact('access_update', [u.event_digest]).value;
      assert(admitted && same(admitted.event, u.event) && admitted.event_digest === u.event_digest && admitted.access_state === u.access_state, 'missing access admission');
      all.set(u.event_digest, u);
    }
  }
  list([...all.values()]); return [...all.values()];
}
function available(view, r) {
  const latest = updates(view, r.provenance.events);
  if (latest.some(u => u.access_state !== 'active') || !same(latest.map(u => u.event_digest).sort(), r.provenance.access_events.map(hash).sort())) return false;
  for (const e of r.provenance.events) for (const { object } of e.provenance.source_objects) {
    const s = view.fact('source_object', [sourceObjectKey(object)]).value;
    if (!s || !same(s.object, object) || s.tombstone !== null) return false;
    const p = view.fact('source_object_epoch', [sourceObjectKey(object), sourcePartitionKey(source(e))]).value;
    if (!p || !same(p.object, object) || !same(p.source, source(e))) return false;
    if (e.producer.sequence === null ? !p.has_unordered : p.maximum_sequence === null || p.maximum_sequence < e.producer.sequence) return false;
  }
  return true;
}
function materialize(view, ref, at) {
  validateSemanticAddress(ref); bound(ref, view.current);
  const e = entity(view, ref.entity_kind, ref.entity_id, at);
  const r = ref.kind === 'semantic_revision' ? revision(view, ref, at) : e && revision(view, e.head, at);
  if (!r) return { status: 'unavailable', revision: null };
  const open = conflicts(view, e, at);
  const readable = row => available(view, row) && row.provenance.effective_access.allowed_principal_ids.includes(view.current.principal_id);
  if (!readable(r)) return { status: 'denied', revision: null };
  for (const p of e?.competing ?? []) { const competitor = revision(view, p, at); assert(competitor, 'missing competing revision'); if (!readable(competitor)) return { status: 'denied', revision: null }; }
  const head = e && revision(view, e.head, at); assert(!e || head, 'missing entity head');
  const quarantined = e ? [head, ...e.competing.map(p => revision(view, p, at))].some(row => !available(view, row)) : false;
  const projection = e && { entity_kind: e.entity_kind, entity_id: e.entity_id, head: e.head, competing: e.competing,
    status: quarantined ? 'stale' : e.competing.length ? 'contested' : head.assertion.status, quarantined };
  return { status: 'resolved', revision: r, entity: projection, conflicts: open, graph_revision: at };
}
function makePlan(view, input, append, changes, operation, entities = [], sources = [], manifest = null) {
  const before = view.current.head && view.commit(view.current.head);
  const sequence = before ? before.sequence + 1 : 0; uint(sequence);
  const projections = [...changes.values()].sort((a, b) => rowKey(a.kind, a.key) < rowKey(b.kind, b.key) ? -1 : 1);
  append = [...append].sort((a, b) => rowKey(a.kind, a.key) < rowKey(b.kind, b.key) ? -1 : 1);
  const commit = sealed({ schema_version: 2, kind: 'graph_commit_record', scope: view.current.scope, generation_id: view.current.generation_id,
    manifest_digest: manifest?.manifest_digest ?? before.manifest_digest, sequence, previous_commit: view.current.head,
    catalog_pin: view.current.catalog_pin, watermarks: input.operation?.watermarks ?? before?.watermarks ?? input.watermarks, command_digest: hash(input),
    records: append.map(r => ({ kind: r.kind, key: r.key, digest: hash(r.value) })),
    projections: projections.map(p => ({ kind: p.kind, key: p.key, previous_digest: p.expected_digest, value: p.value })) }, 'commit_digest');
  const next = address(commit), common = { schema_version: 2, scope: view.current.scope, generation_id: view.current.generation_id };
  const plan = sealed({ ...common, kind: 'graph_effect_plan', expected_graph: view.current.head, expected_head_version: view.current.head_version,
    next_graph: next, commit, append, cas: projections.map(p => ({ ...p, origin: next })),
    audit: { ...common, kind: 'graph_transition_audit', command_digest: commit.command_digest, previous_graph: view.current.head, next_graph: next, operation },
    outbox: { ...common, kind: 'graph_changed', previous_graph: view.current.head, next_graph: next, changed_entities: entities, changed_sources: sources } }, 'plan_digest');
  validateGraphEffectPlan2(plan); return plan;
}
function change(view, changes, kind, key, value) {
  const encoded = rowKey(kind, key), existing = changes.get(encoded), prior = existing ?? view.fact(kind, key);
  changes.set(encoded, { kind, key, expected_version: existing ? existing.expected_version : prior.version,
    expected_digest: existing ? existing.expected_digest : prior.value === null ? null : hash(prior.value), value });
}
function overlay(view, changes, kind, key) { return changes.get(rowKey(kind, key))?.value ?? view.fact(kind, key).value; }
function observe(view, changes, events) {
  for (const e of events) {
    const src = source(e), sourceKey = sourcePartitionKey(src), prior = overlay(view, changes, 'source_epoch', [sourceKey]);
    change(view, changes, 'source_epoch', [sourceKey], { source: src, observed: true, last_access: prior?.last_access ?? null });
    for (const { object } of e.provenance.source_objects) {
      const objectKey = sourceObjectKey(object), current = overlay(view, changes, 'source_object', [objectKey]);
      assert(current?.tombstone === null || current === null, 'tombstone cannot reopen');
      if (!current) change(view, changes, 'source_object', [objectKey], { object, first_event: eventObservationKey(e), tombstone: null });
      const key = [objectKey, sourceKey], seen = overlay(view, changes, 'source_object_epoch', key);
      const sequences = [seen?.maximum_sequence, e.producer.sequence].filter(x => x !== null && x !== undefined);
      change(view, changes, 'source_object_epoch', key, { object, source: src, maximum_sequence: sequences.length ? Math.max(...sequences) : null,
        has_unordered: Boolean(seen?.has_unordered) || e.producer.sequence === null });
    }
  }
}

export function planGraphGenesis(port, input) {
  json(input); fields(input, ['scope', 'generation_id', 'catalog_pin', 'watermarks']); scope(input.scope); id(input.generation_id); pin(input.catalog_pin);
  validateFreshnessVector(input.watermarks); assert(same(input.scope, input.watermarks.scope), 'watermark scope mismatch');
  input = freeze(copy(input));
  const view = new View(port, 256); bound(input, view.current); assert(view.current.head === null && same(input.catalog_pin, view.current.catalog_pin), 'genesis already exists/catalog mismatch'); view.catalog(input.catalog_pin);
  const manifest = sealed({ schema_version: 2, kind: 'graph_manifest', scope: input.scope, generation_id: input.generation_id, semantic_version: 1,
    initial_catalog_pin: input.catalog_pin, initial_watermarks: input.watermarks }, 'manifest_digest'); validateGraphManifest2(manifest);
  return view.finish({ status: 'planned', plan: makePlan(view, input, [{ kind: 'manifest', key: [manifest.manifest_digest], value: manifest }], new Map(), 'genesis', [], [], manifest) });
}

export function planGraphMutation(port, input) {
  validateGraphMutation2(input); input = freeze(copy(input)); const view = new View(port, 256); bound(input.expected_graph, view.current);
  view.selected(view.current.head);
  if (!same(input.expected_graph, view.current.head)) return view.finish({ status: 'graph_revision_mismatch', graph_revision: view.current.head, proposal: input, effects: [] });
  assert(same(input.catalog_pin, view.current.catalog_pin), 'current catalog pin mismatch'); const catalog = view.catalog(input.catalog_pin);
  const op = input.operation, changes = new Map(), append = [];
  if (op.kind === 'source_access') return lifecycle(view, input, changes, append);
  const a = { ...copy(op.assertion), events: order(op.assertion.events), parents: order(op.assertion.parents), canonical_refs: order(op.assertion.canonical_refs),
    ...(op.assertion.access_revisions === undefined ? {} : { access_revisions: [...op.assertion.access_revisions].sort() }) };
  entityName(a); id(a.assertion_id); id(a.execution_id);
  assert(resolveIdentity(catalog, { ...view.current.scope, execution_id: a.execution_id }).status === 'resolved', 'execution unmapped');
  assert(view.fact('assertion_id', [a.assertion_id]).value === null, 'assertion id already exists');
  const e = entity(view, a.entity_kind, a.entity_id, view.current.head), open = conflicts(view, e, view.current.head);
  if (a.base_revision !== null) {
    exact(a.base_revision, view); const base = view.fact('revision', [a.base_revision.revision_digest]).value;
    assert(base && same(exactRevisionAddress(base), a.base_revision), 'missing exact base');
  }
  const events = directEvents(a, view);
  for (const p of supportRefs(a, view)) {
    const r = revision(view, p, view.current.head);
    assert(r && available(view, r) && r.provenance.effective_access.allowed_principal_ids.includes(view.current.principal_id), 'stale/denied/missing supporting revision');
    events.push(...r.provenance.events);
  }
  const access = updates(view, events);
  assert(same([...(a.access_revisions ?? [])].sort(), access.map(u => u.event_digest).sort()) && access.every(u => u.access_state === 'active'), 'stale source access revisions');
  const body = { schema_version: 1, scope: view.current.scope, generation_id: view.current.generation_id,
    entity_kind: a.entity_kind, entity_id: a.entity_id, assertion: a, provenance: closure(events, access.map(u => u.event)) };
  assert(body.provenance.events.length === 0 && body.provenance.access_events.length === 0
    || body.provenance.effective_access.allowed_principal_ids.includes(view.current.principal_id), 'derived provenance is not authorized for caller');
  const r = sealed(body, 'revision_digest'); validateSemanticRevision(r);
  r.provenance.events.forEach(event => assert(!['SOURCE_ACCESS_CHANGED', 'SOURCE_TOMBSTONE'].includes(event.event_type), 'lifecycle cannot assert content'));
  const ref = exactRevisionAddress(r); let conflict = null, nextEntity;
  if (!e) {
    assert(op.kind === 'assert' && a.base_revision === null && a.status === 'candidate', 'new entity must start candidate');
    nextEntity = { entity_kind: a.entity_kind, entity_id: a.entity_id, head: ref, competing: [], open_conflicts: [] };
  } else if (op.kind === 'resolve') {
    assert(a.status === 'resolved' && e.competing.length > 0 && same(a.base_revision, e.head) && e.open_conflicts.includes(op.conflict_digest), 'invalid explicit resolution');
    assert(e.competing.every(p => a.parents.some(parent => same(parent, p))), 'resolution omitted competitors');
    for (const c of open) append.push({ kind: 'resolution', key: [c.conflict_digest], value: { conflict_digest: c.conflict_digest, resolution: ref } });
    nextEntity = { ...e, head: ref, competing: [], open_conflicts: [] };
  } else {
    assert(a.status !== 'resolved', 'resolution requires explicit operation');
    if (e.competing.length || !same(a.base_revision, e.head)) {
      const assertions = [...new Map([e.head, ...e.competing, ref].map(p => [stable(p), p])).values()]; list(assertions);
      conflict = sealed({ schema_version: 1, scope: view.current.scope, generation_id: view.current.generation_id,
        entity_kind: a.entity_kind, entity_id: a.entity_id, assertions }, 'conflict_digest'); validateGraphConflict(conflict);
      append.push({ kind: 'conflict', key: [conflict.conflict_digest], value: conflict });
      nextEntity = { ...e, competing: assertions, open_conflicts: [...e.open_conflicts, conflict.conflict_digest] }; list(nextEntity.open_conflicts);
    } else nextEntity = { ...e, head: ref };
  }
  append.push({ kind: 'revision', key: [r.revision_digest], value: r });
  change(view, changes, 'entity', [a.entity_kind, a.entity_id], nextEntity); change(view, changes, 'assertion_id', [a.assertion_id], { revision: ref });
  observe(view, changes, r.provenance.events);
  const logical = semanticAddress({ scope: view.current.scope, generation_id: view.current.generation_id, entity_kind: a.entity_kind, entity_id: a.entity_id });
  const plan = makePlan(view, input, append, changes, op.kind, [logical]);
  return view.finish({ status: 'planned', plan, revision: ref, ...(op.kind === 'assert' ? { conflict } : {}) });
}

function lifecycle(view, input, changes, append) {
  const { event: e, access_state } = input.operation; view.event(e);
  assert(e.event_type === 'SOURCE_TOMBSTONE' ? access_state === 'tombstoned' : e.event_type === 'SOURCE_ACCESS_CHANGED' && ['active', 'unknown'].includes(access_state), 'invalid lifecycle');
  assert(e.producer.sequence !== null && e.provenance.source_objects.length > 0, 'sequenced lifecycle targets required'); list(e.provenance.source_objects);
  const src = source(e), sourceKey = sourcePartitionKey(src), before = view.commit(view.current.head), epoch = view.fact('source_epoch', [sourceKey]).value;
  assert(epoch?.observed || epoch?.last_access || before.watermarks.watermarks.some(w => sourcePartitionKey(w.source) === sourceKey), 'lifecycle cannot admit own epoch');
  if (epoch?.last_access) assert(e.producer.sequence > epoch.last_access.sequence, 'lifecycle sequence did not advance');
  const priorUpdates = updates(view, [e]); // Preserve fully proved prior observer/epoch restrictions.
  assert(priorUpdates.every(u => effectiveEventAccess(u.event).allowed_principal_ids.includes(view.current.principal_id)), 'prior lifecycle provenance is not authorized for caller');
  const targets = order(e.provenance.source_objects.map(s => s.object)), eventDigest = hash(e);
  const admission = view.call('authorizeLifecycle', { at: view.current.head, event_digest: eventDigest, targets }); json(admission);
  fields(admission, ['at', 'current_head', 'access_view', 'event_digest', 'targets', 'principal_id', 'allowed', 'authority_ref']); id(admission.authority_ref);
  assert(admission.allowed === true && same(admission.at, view.current.head) && same(admission.current_head, view.current.head)
    && admission.access_view === view.current.access_view && admission.principal_id === view.current.principal_id && admission.event_digest === eventDigest && same(admission.targets, targets), 'lifecycle authority missing');
  for (const object of targets) {
    const objectKey = sourceObjectKey(object), known = view.fact('source_object', [objectKey]).value;
    assert(known && same(known.object, object) && known.tombstone === null, 'unknown/tombstoned source target');
    const observed = view.fact('source_object_epoch', [objectKey, sourceKey]).value;
    if (observed) assert(observed.has_unordered === false && observed.maximum_sequence !== null && e.producer.sequence > observed.maximum_sequence, 'lifecycle precedes observed content');
    const previous = view.fact('source_access', [objectKey]).value; if (previous) { fields(previous, ['object', 'updates']); assert(same(previous.object, object), 'source access mismatch'); list(previous.updates); }
    const latest = new Map((previous?.updates ?? []).map(u => [sourcePartitionKey(source(u.event)), u]));
    latest.set(sourceKey, { event: e, event_digest: eventDigest, access_state }); list([...latest.values()]);
    const values = [...latest.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, u]) => u);
    change(view, changes, 'source_access', [objectKey], { object, updates: values });
    if (access_state === 'tombstoned') change(view, changes, 'source_object', [objectKey], { ...known, tombstone: eventDigest });
  }
  change(view, changes, 'source_epoch', [sourceKey], { source: src, observed: epoch?.observed ?? false, last_access: { event_digest: eventDigest, sequence: e.producer.sequence } });
  append.push({ kind: 'access_update', key: [eventDigest], value: { event: e, event_digest: eventDigest, access_state,
    authority_ref: admission.authority_ref, principal_id: admission.principal_id, predecessor: view.current.head } });
  return view.finish({ status: 'planned', plan: makePlan(view, input, append, changes, 'source_access', [], targets), access_revision: eventDigest });
}

export function resolveIncrementalGraph(port, input) {
  json(input); fields(input, ['at', 'address']); validateGraphCommitAddress2(input.at); validateSemanticAddress(input.address); bound(input.address, input.at);
  input = freeze(copy(input));
  const view = new View(port, 256); view.selected(input.at); return view.finish(materialize(view, input.address, input.at));
}
export function pageIncrementalGraph(port, input) {
  json(input); fields(input, ['at', 'collection', 'cursor', 'limit']); validateGraphCommitAddress2(input.at); collection(input.collection);
  assert(Number.isSafeInteger(input.limit) && input.limit > 0 && input.limit <= 64, 'invalid page limit');
  if (input.cursor !== null) {
    validateGraphPageCursor2(input.cursor); bound(input.cursor, input.at);
    assert(input.cursor.commit_digest === input.at.commit_digest && same(input.cursor.collection, input.collection), 'page cursor mismatch');
  }
  input = freeze(copy(input));
  const view = new View(port, 2048); view.selected(input.at); const after = input.cursor?.position ?? null;
  const page = view.call('page', { at: input.at, collection: input.collection, after, limit: input.limit }); json(page);
  fields(page, ['at', 'current_head', 'access_view', 'collection', 'after', 'rows', 'next_position']);
  assert(same(page.at, input.at) && same(page.current_head, view.current.head) && page.access_view === view.current.access_view
    && same(page.collection, input.collection) && page.after === after, 'stale page'); list(page.rows, input.limit);
  let position = after ?? -1; const items = [];
  for (const row of page.rows) {
    fields(row, ['position', 'kind', 'key']); uint(row.position); assert(row.position > position, 'page order mismatch'); position = row.position; keyShape(row.kind, row.key);
    // Each item has its own bounded reachable closure; no cumulative entity budget.
    view.revisions.clear(); view.visiting.clear();
    if (input.collection.kind === 'conflicts') {
      assert(row.kind === 'conflict', 'wrong page row'); const c = view.fact('conflict', row.key, input.at).value;
      assert(c, 'missing paged conflict'); validateGraphConflict(c); bound(c, view.current); assert(c.conflict_digest === row.key[0], 'wrong paged conflict');
      if (input.collection.entity) assert(c.entity_kind === input.collection.entity.entity_kind && c.entity_id === input.collection.entity.entity_id, 'conflict selector mismatch');
      if (view.fact('resolution', [c.conflict_digest], input.at).value !== null) continue;
      if (c.assertions.every(ref => materialize(view, ref, input.at).status === 'resolved')) items.push({ status: 'resolved', conflict: c, graph_revision: input.at });
    } else {
      let ref;
      if (input.collection.kind === 'heads') {
        assert(row.kind === 'entity', 'wrong head row'); ref = semanticAddress({ scope: input.at.scope, generation_id: input.at.generation_id, entity_kind: row.key[0], entity_id: row.key[1] });
      } else {
        assert(row.kind === 'revision', 'wrong history row'); const r = view.fact('revision', row.key, input.at).value;
        assert(r, 'missing history revision'); validateSemanticRevision(r);
        assert(r.entity_kind === input.collection.entity_kind && r.entity_id === input.collection.entity_id && r.revision_digest === row.key[0], 'history selector mismatch'); ref = exactRevisionAddress(r);
      }
      const value = materialize(view, ref, input.at); if (value.status === 'resolved') items.push(value);
    }
  }
  if (page.next_position !== null) { uint(page.next_position); assert(page.rows.length > 0 && page.next_position === position, 'invalid continuation'); }
  const next = page.next_position === null ? null : { schema_version: 2, kind: 'graph_page_cursor', scope: input.at.scope, generation_id: input.at.generation_id,
    commit_digest: input.at.commit_digest, collection: input.collection, position: page.next_position };
  return view.finish({ items, next_cursor: next, graph_revision: input.at });
}
function sealed(body, field) { return { ...body, [field]: hash(body) }; }
function checkSeal(value, field) { const { [field]: selected, ...body } = value; digest(selected); assert(hash(body) === selected, 'digest mismatch'); }
const address = commit => ({ schema_version: 2, kind: 'graph_commit', scope: commit.scope, generation_id: commit.generation_id, commit_digest: commit.commit_digest });

export function validateGraphCommitAddress2(v) {
  json(v); fields(v, ['schema_version', 'kind', 'scope', 'generation_id', 'commit_digest']); wire(v, 'graph_commit'); digest(v.commit_digest); return true;
}
export function validateGraphManifest2(v) {
  json(v); fields(v, ['schema_version', 'kind', 'scope', 'generation_id', 'semantic_version', 'initial_catalog_pin', 'initial_watermarks', 'manifest_digest']);
  wire(v, 'graph_manifest'); assert(v.semantic_version === 1, 'unsupported semantic version'); pin(v.initial_catalog_pin);
  validateFreshnessVector(v.initial_watermarks); assert(same(v.scope, v.initial_watermarks.scope), 'watermark scope mismatch'); checkSeal(v, 'manifest_digest'); return true;
}
export function validateGraphCommit2(v) {
  json(v); fields(v, ['schema_version', 'kind', 'scope', 'generation_id', 'manifest_digest', 'sequence', 'previous_commit',
    'catalog_pin', 'watermarks', 'command_digest', 'records', 'projections', 'commit_digest']);
  wire(v, 'graph_commit_record'); digest(v.manifest_digest); uint(v.sequence); pin(v.catalog_pin); digest(v.command_digest);
  if (v.sequence === 0) assert(v.previous_commit === null, 'invalid genesis predecessor');
  else { validateGraphCommitAddress2(v.previous_commit); bound(v.previous_commit, v); }
  validateFreshnessVector(v.watermarks); assert(same(v.watermarks.scope, v.scope), 'watermark scope mismatch');
  list(v.records, 64); list(v.projections, 128);
  const seen = new Set();
  for (const r of v.records) {
    fields(r, ['kind', 'key', 'digest']); assert(immutableKinds.has(r.kind), 'unknown immutable record'); keyShape(r.kind, r.key); digest(r.digest);
    assert(!seen.has(rowKey(r.kind, r.key)), 'duplicate commit record'); seen.add(rowKey(r.kind, r.key));
  }
  seen.clear();
  for (const p of v.projections) {
    fields(p, ['kind', 'key', 'previous_digest', 'value']); assert(projectionKinds.has(p.kind), 'unknown projection'); keyShape(p.kind, p.key);
    rowWire(p.kind, p.key, p.value, v);
    if (p.previous_digest !== null) digest(p.previous_digest);
    assert(!seen.has(rowKey(p.kind, p.key)), 'duplicate commit projection'); seen.add(rowKey(p.kind, p.key));
  }
  if (v.sequence === 0) assert(v.records.length === 1 && v.records[0].kind === 'manifest' && v.projections.length === 0, 'invalid genesis records');
  else {
    assert(!v.records.some(r => r.kind === 'manifest'), 'manifest cannot change');
    const mutations = v.records.filter(r => ['revision', 'access_update'].includes(r.kind));
    assert(mutations.length === 1 && (mutations[0].kind !== 'access_update' || v.records.length === 1), 'commit requires exactly one mutation');
  }
  checkSeal(v, 'commit_digest'); return true;
}
function collection(v) {
  if (v?.kind === 'heads') fields(v, ['kind']);
  else if (v?.kind === 'history') { fields(v, ['kind', 'entity_kind', 'entity_id']); entityName(v); }
  else { fields(v, ['kind', 'entity']); assert(v.kind === 'conflicts', 'unknown collection'); if (v.entity !== null) { fields(v.entity, ['entity_kind', 'entity_id']); entityName(v.entity); } }
}
function entityName(v) { assert(['entity', 'relation'].includes(v.entity_kind), 'invalid entity kind'); id(v.entity_id); }
function semanticRef(ref, selected) { validateSemanticAddress(ref); bound(ref, selected); assert(ref.kind === 'semantic_revision', 'exact semantic reference required'); }
function eventScope(e, selected) { validateNormalizedEvent(e); assert(e.partition.tenant_id === selected.scope.tenant_id && e.partition.project_id === selected.scope.project_id, 'event scope mismatch'); }
function artifact(ref, selected) { assert(same(ref, canonicalArtifactAddress(ref.event)) && same(ref.scope, selected.scope), 'invalid canonical artifact'); }
function assertionWire(a, selected) {
  fields(a, ['schema_version', 'assertion_id', 'entity_kind', 'entity_id', 'base_revision', 'parents', 'execution_id', 'status', 'content', 'events', 'canonical_refs'], ['access_revisions']);
  assert(a.schema_version === 1, 'unsupported assertion version'); entityName(a); id(a.assertion_id); id(a.execution_id);
  assert(SEMANTIC_STATES.includes(a.status) && a.status !== 'contested', 'invalid assertion lifecycle');
  if (a.base_revision !== null) { semanticRef(a.base_revision, selected); assert(a.base_revision.entity_kind === a.entity_kind && a.base_revision.entity_id === a.entity_id, 'base entity mismatch'); }
  list(a.parents); a.parents.forEach(p => semanticRef(p, selected)); assert(new Set(a.parents.map(stable)).size === a.parents.length, 'duplicate supporting parent');
  list(a.events); a.events.forEach(e => eventScope(e, selected));
  list(a.canonical_refs); a.canonical_refs.forEach(c => artifact(c, selected));
  if (a.access_revisions !== undefined) { list(a.access_revisions); a.access_revisions.forEach(digest); assert(new Set(a.access_revisions).size === a.access_revisions.length, 'duplicate access revision'); }
  if (a.entity_kind === 'entity') { fields(a.content, ['semantic_type', 'data']); id(a.content.semantic_type); }
  else {
    fields(a.content, ['relation_type', 'from', 'to', 'data']); assert(SEMANTIC_RELATIONS.includes(a.content.relation_type), 'invalid relation');
    for (const p of [a.content.from, a.content.to]) if (p?.kind === 'canonical_artifact') artifact(p, selected); else semanticRef(p, selected);
  }
}
function rowWire(kind, key, value, selected) {
  keyShape(kind, key);
  const sourceScope = s => { sourcePartitionKey(s); assert(s.partition.tenant_id === selected.scope.tenant_id && s.partition.project_id === selected.scope.project_id, 'source scope mismatch'); };
  const object = o => { sourceObjectKey(o); assert(o.tenant_id === selected.scope.tenant_id, 'source tenant mismatch'); };
  if (kind === 'manifest') { validateGraphManifest2(value); bound(value, selected); assert(key[0] === value.manifest_digest, 'manifest key mismatch'); }
  else if (kind === 'revision') { validateSemanticRevision(value); bound(value, selected); assertionWire(value.assertion, selected); assert(key[0] === value.revision_digest, 'revision key mismatch'); }
  else if (kind === 'conflict') { validateGraphConflict(value); bound(value, selected); list(value.assertions); assert(key[0] === value.conflict_digest, 'conflict key mismatch'); }
  else if (kind === 'resolution') { fields(value, ['conflict_digest', 'resolution']); digest(value.conflict_digest); semanticRef(value.resolution, selected); assert(key[0] === value.conflict_digest, 'resolution key mismatch'); }
  else if (kind === 'access_update') {
    fields(value, ['event', 'event_digest', 'access_state', 'authority_ref', 'principal_id', 'predecessor']); eventScope(value.event, selected);
    digest(value.event_digest); id(value.authority_ref); id(value.principal_id); validateGraphCommitAddress2(value.predecessor); bound(value.predecessor, selected);
    assert(key[0] === value.event_digest && value.event_digest === hash(value.event), 'access event key mismatch');
    assert(value.event.event_type === 'SOURCE_TOMBSTONE' ? value.access_state === 'tombstoned' : value.event.event_type === 'SOURCE_ACCESS_CHANGED' && ['active', 'unknown'].includes(value.access_state), 'invalid access lifecycle');
  } else if (kind === 'entity') {
    fields(value, ['entity_kind', 'entity_id', 'head', 'competing', 'open_conflicts']); entityName(value); assert(same(key, [value.entity_kind, value.entity_id]), 'entity key mismatch');
    list(value.competing); list(value.open_conflicts); for (const p of [value.head, ...value.competing]) { semanticRef(p, selected); assert(p.entity_kind === value.entity_kind && p.entity_id === value.entity_id, 'entity reference mismatch'); }
    value.open_conflicts.forEach(digest); assert(new Set(value.competing.map(stable)).size === value.competing.length && new Set(value.open_conflicts).size === value.open_conflicts.length, 'duplicate entity closure');
  } else if (kind === 'assertion_id') { fields(value, ['revision']); semanticRef(value.revision, selected); id(key[0]); }
  else if (kind === 'source_epoch') {
    fields(value, ['source', 'observed', 'last_access']); sourceScope(value.source); assert(key[0] === sourcePartitionKey(value.source) && typeof value.observed === 'boolean', 'epoch key/state mismatch');
    if (value.last_access !== null) { fields(value.last_access, ['event_digest', 'sequence']); digest(value.last_access.event_digest); uint(value.last_access.sequence); }
  } else if (kind === 'source_object') {
    fields(value, ['object', 'first_event', 'tombstone']); object(value.object); assert(key[0] === sourceObjectKey(value.object) && typeof value.first_event === 'string' && value.first_event.length > 0 && value.first_event.length <= 4096, 'object key/event mismatch'); if (value.tombstone !== null) digest(value.tombstone);
  } else if (kind === 'source_object_epoch') {
    fields(value, ['object', 'source', 'maximum_sequence', 'has_unordered']); object(value.object); sourceScope(value.source);
    assert(same(key, [sourceObjectKey(value.object), sourcePartitionKey(value.source)]) && typeof value.has_unordered === 'boolean', 'object epoch mismatch');
    if (value.maximum_sequence !== null) uint(value.maximum_sequence); assert(value.maximum_sequence !== null || value.has_unordered, 'empty observed epoch');
  } else if (kind === 'source_access') {
    fields(value, ['object', 'updates']); object(value.object); assert(key[0] === sourceObjectKey(value.object), 'access object mismatch'); list(value.updates);
    let previous = null;
    for (const u of value.updates) {
      fields(u, ['event', 'event_digest', 'access_state']); eventScope(u.event, selected); digest(u.event_digest);
      assert(u.event_digest === hash(u.event) && u.event.producer.sequence !== null && u.event.provenance.source_objects.some(s => sourceObjectKey(s.object) === key[0]), 'access update target/digest mismatch');
      assert(u.event.event_type === 'SOURCE_TOMBSTONE' ? u.access_state === 'tombstoned' : u.event.event_type === 'SOURCE_ACCESS_CHANGED' && ['active', 'unknown'].includes(u.access_state), 'invalid access lifecycle');
      const epoch = sourcePartitionKey(source(u.event)); assert(previous === null || previous < epoch, 'access observer order/duplicate'); previous = epoch;
    }
  } else fail('unsupported row family');
}
export function validateGraphPageCursor2(v) {
  json(v); fields(v, ['schema_version', 'kind', 'scope', 'generation_id', 'commit_digest', 'collection', 'position']); wire(v, 'graph_page_cursor');
  digest(v.commit_digest); collection(v.collection); uint(v.position); return true;
}
export function validateGraphMutation2(v) {
  json(v); fields(v, ['schema_version', 'kind', 'expected_graph', 'catalog_pin', 'operation']);
  assert(v.schema_version === 2 && v.kind === 'graph_mutation', 'unsupported mutation'); validateGraphCommitAddress2(v.expected_graph); pin(v.catalog_pin);
  const op = v.operation;
  if (op?.kind === 'assert') fields(op, ['kind', 'assertion'], ['watermarks']);
  else if (op?.kind === 'resolve') { fields(op, ['kind', 'conflict_digest', 'assertion']); digest(op.conflict_digest); }
  else { fields(op, ['kind', 'event', 'access_state']); assert(op.kind === 'source_access', 'unknown mutation'); validateNormalizedEvent(op.event); assert(['active', 'unknown', 'tombstoned'].includes(op.access_state), 'invalid access state'); }
  if (op.watermarks !== undefined) { validateFreshnessVector(op.watermarks); assert(same(op.watermarks.scope, v.expected_graph.scope), 'watermark scope mismatch'); }
  if (op.assertion !== undefined) assertionWire(op.assertion, v.expected_graph);
  if (op.kind === 'assert') assert(op.assertion.status !== 'resolved', 'explicit resolution required');
  if (op.kind === 'resolve') assert(op.assertion.status === 'resolved', 'resolved assertion required');
  if (op.kind === 'source_access') {
    eventScope(op.event, v.expected_graph);
    assert(op.event.event_type === 'SOURCE_TOMBSTONE' ? op.access_state === 'tombstoned' : op.event.event_type === 'SOURCE_ACCESS_CHANGED' && ['active', 'unknown'].includes(op.access_state), 'invalid lifecycle operation');
    assert(op.event.producer.sequence !== null && op.event.provenance.source_objects.length > 0, 'sequenced lifecycle targets required');
  }
  return true;
}
export function validateGraphEffectPlan2(v) {
  json(v); fields(v, ['schema_version', 'kind', 'scope', 'generation_id', 'expected_graph', 'expected_head_version', 'next_graph', 'commit', 'append', 'cas', 'audit', 'outbox', 'plan_digest']);
  wire(v, 'graph_effect_plan'); validateGraphCommit2(v.commit); bound(v.commit, v); validateGraphCommitAddress2(v.next_graph);
  assert(same(v.next_graph, address(v.commit)), 'next commit mismatch');
  if (v.expected_graph === null) assert(v.expected_head_version === null && v.commit.sequence === 0, 'invalid genesis plan');
  else { validateGraphCommitAddress2(v.expected_graph); bound(v.expected_graph, v); uint(v.expected_head_version); assert(v.expected_head_version > 0 && same(v.commit.previous_commit, v.expected_graph), 'plan predecessor mismatch'); }
  list(v.append, 64); list(v.cas, 128);
  assert(v.append.length === v.commit.records.length && v.cas.length === v.commit.projections.length, 'effects differ from commitment');
  v.append.forEach((r, i) => { fields(r, ['kind', 'key', 'value']); rowWire(r.kind, r.key, r.value, v); assert(same(v.commit.records[i], { kind: r.kind, key: r.key, digest: hash(r.value) }), 'append commitment mismatch'); });
  v.cas.forEach((p, i) => {
    fields(p, ['kind', 'key', 'expected_version', 'expected_digest', 'value', 'origin']);
    rowWire(p.kind, p.key, p.value, v);
    if (p.expected_version === null) assert(p.expected_digest === null, 'absence digest mismatch'); else { uint(p.expected_version); assert(p.expected_version > 0, 'invalid CAS version'); digest(p.expected_digest); }
    assert(same(p.origin, v.next_graph) && same(v.commit.projections[i], { kind: p.kind, key: p.key, previous_digest: p.expected_digest, value: p.value }), 'CAS commitment mismatch');
  });
  fields(v.audit, ['schema_version', 'kind', 'scope', 'generation_id', 'command_digest', 'previous_graph', 'next_graph', 'operation']); wire(v.audit, 'graph_transition_audit'); bound(v.audit, v);
  assert(['genesis', 'assert', 'resolve', 'source_access'].includes(v.audit.operation) && v.audit.command_digest === v.commit.command_digest
    && same(v.audit.previous_graph, v.expected_graph) && same(v.audit.next_graph, v.next_graph), 'audit mismatch');
  fields(v.outbox, ['schema_version', 'kind', 'scope', 'generation_id', 'previous_graph', 'next_graph', 'changed_entities', 'changed_sources']); wire(v.outbox, 'graph_changed'); bound(v.outbox, v);
  assert(same(v.outbox.previous_graph, v.expected_graph) && same(v.outbox.next_graph, v.next_graph), 'outbox mismatch');
  list(v.outbox.changed_entities); v.outbox.changed_entities.forEach(a => { validateSemanticAddress(a); bound(a, v); assert(a.kind === 'semantic_entity', 'logical changed entity required'); });
  list(v.outbox.changed_sources); v.outbox.changed_sources.forEach(sourceObjectKey);
  const entities = v.cas.filter(p => p.kind === 'entity').map(p => semanticAddress({ scope: v.scope, generation_id: v.generation_id, entity_kind: p.key[0], entity_id: p.key[1] }));
  const access = v.append.filter(r => r.kind === 'access_update');
  const sources = order([...new Map(access.flatMap(r => r.value.event.provenance.source_objects.map(s => [sourceObjectKey(s.object), s.object]))).values()]);
  assert(same(v.outbox.changed_entities, entities) && same(v.outbox.changed_sources, sources), 'outbox omitted/added committed targets');
  const revisions = v.append.filter(r => r.kind === 'revision'), indexed = v.cas.filter(p => p.kind === 'assertion_id');
  if (v.audit.operation === 'genesis') {
    assert(v.commit.sequence === 0 && v.append.length === 1 && v.append[0].kind === 'manifest' && v.cas.length === 0, 'genesis effects mismatch');
    const manifest = v.append[0].value;
    assert(manifest.manifest_digest === v.commit.manifest_digest && same(manifest.initial_catalog_pin, v.commit.catalog_pin)
      && same(manifest.initial_watermarks, v.commit.watermarks), 'genesis manifest mismatch');
  }
  else if (v.audit.operation === 'source_access') {
    assert(v.commit.sequence > 0 && access.length === 1 && v.append.length === 1 && entities.length === 0 && indexed.length === 0, 'lifecycle effects mismatch');
    assert(same(access[0].value.predecessor, v.expected_graph), 'lifecycle predecessor mismatch');
  } else {
    assert(v.commit.sequence > 0 && revisions.length === 1 && access.length === 0 && entities.length === 1 && indexed.length === 1, 'semantic effects mismatch');
    const r = revisions[0].value, ref = exactRevisionAddress(r), e = v.cas.find(p => p.kind === 'entity').value;
    assert(indexed[0].key[0] === r.assertion.assertion_id && same(indexed[0].value.revision, ref)
      && e.entity_kind === r.entity_kind && e.entity_id === r.entity_id
      && (same(e.head, ref) || e.competing.some(p => same(p, ref))), 'semantic index mismatch');
    assert(v.audit.operation === 'resolve' ? r.assertion.status === 'resolved' && same(e.head, ref) && e.competing.length === 0 && e.open_conflicts.length === 0 : r.assertion.status !== 'resolved', 'semantic operation mismatch');
    for (const item of v.append) {
      if (item.kind === 'resolution') assert(v.audit.operation === 'resolve' && same(item.value.resolution, ref), 'resolution effect mismatch');
      else if (item.kind === 'conflict') assert(v.audit.operation === 'assert' && item.value.assertions.some(p => same(p, ref)) && e.open_conflicts.includes(item.value.conflict_digest), 'conflict effect mismatch');
      else assert(item.kind === 'revision', 'unexpected semantic append');
    }
  }
  checkSeal(v, 'plan_digest'); return true;
}

/** Repository selects lineage/current access. These checks detect inconsistent facts, not a malicious repository. */
class View {
  constructor(port, budget) {
    assert(port && ['current', 'read', 'page', 'authorizeLifecycle'].every(k => typeof port[k] === 'function'), 'trusted selected-record port required');
    this.port = port; this.budget = budget; this.count = 0; this.cache = new Map(); this.revisions = new Map(); this.visiting = new Set();
    this.current = this.call('current'); json(this.current);
    fields(this.current, ['scope', 'generation_id', 'head', 'head_version', 'catalog_pin', 'access_view', 'principal_id']);
    scope(this.current.scope); id(this.current.generation_id); pin(this.current.catalog_pin); id(this.current.access_view); id(this.current.principal_id);
    if (this.current.head === null) assert(this.current.head_version === null, 'missing current head');
    else { validateGraphCommitAddress2(this.current.head); bound(this.current.head, this.current); uint(this.current.head_version); assert(this.current.head_version > 0, 'invalid head version'); }
  }
  call(name, value) {
    assert(++this.count <= this.budget, 'selected fact budget exceeded');
    const v = value === undefined ? this.port[name]() : this.port[name](result(value)); json(v);
    // The repository may reuse mutable buffers; retain an inert value snapshot.
    return freeze(copy(v));
  }
  finish(value) { const now = this.call('current'); json(now); assert(same(now, this.current), 'current view changed'); return result(value); }
  fact(kind, key, at = this.current.head) {
    keyShape(kind, key); if (at !== null) { validateGraphCommitAddress2(at); bound(at, this.current); }
    const query = { at, kind, key }, cacheKey = stable(query);
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);
    const f = this.call('read', query); json(f);
    fields(f, ['at', 'current_head', 'access_view', 'kind', 'key', 'complete', 'version', 'value', 'origin']);
    assert(same(f.at, at) && same(f.current_head, this.current.head) && f.access_view === this.current.access_view
      && f.kind === kind && same(f.key, key) && f.complete === true, 'missing/stale selected fact');
    if (f.value === null) assert(f.version === null && f.origin === null, 'invalid absent fact');
    else { uint(f.version); assert(f.version > 0, 'invalid fact version'); }
    this.cache.set(cacheKey, f);
    if (f.value !== null) {
      if (['manifest', 'commit', 'catalog', 'accepted_event'].includes(kind)) assert(f.origin === null, 'external fact has graph origin');
      else {
        rowWire(kind, key, f.value, this.current);
        validateGraphCommitAddress2(f.origin); bound(f.origin, this.current); const commit = this.commit(f.origin), selected = this.commit(at);
        assert(commit.sequence <= selected.sequence && commit.manifest_digest === selected.manifest_digest, 'future/foreign fact');
        const record = immutableKinds.has(kind) ? commit.records.find(r => r.kind === kind && same(r.key, key)) : commit.projections.find(r => r.kind === kind && same(r.key, key));
        assert(record && (immutableKinds.has(kind) ? record.digest === hash(f.value) : same(record.value, f.value)), 'uncommitted projection/record');
        if (kind === 'access_update') assert(same(f.value.predecessor, commit.previous_commit), 'access admission predecessor mismatch');
      }
    }
    return f;
  }
  commit(at, predecessor = true) {
    validateGraphCommitAddress2(at); bound(at, this.current);
    const c = this.fact('commit', [at.commit_digest], this.current.head).value; assert(c, 'missing committed address');
    validateGraphCommit2(c); bound(c, this.current); assert(c.commit_digest === at.commit_digest, 'wrong commit');
    if (c.sequence === 0) {
      const manifest = this.fact('manifest', [c.manifest_digest]).value; assert(manifest, 'genesis manifest unavailable'); validateGraphManifest2(manifest); bound(manifest, this.current);
      assert(manifest.manifest_digest === c.manifest_digest && same(manifest.initial_catalog_pin, c.catalog_pin) && same(manifest.initial_watermarks, c.watermarks), 'genesis manifest mismatch');
    }
    if (predecessor && c.sequence > 0) {
      const p = this.commit(c.previous_commit, false); assert(p.sequence + 1 === c.sequence && p.manifest_digest === c.manifest_digest, 'missing predecessor');
    }
    return c;
  }
  selected(at) {
    assert(this.current.head !== null, 'graph unavailable'); const selected = this.commit(at), current = this.commit(this.current.head);
    assert(selected.sequence <= current.sequence && selected.manifest_digest === current.manifest_digest, 'selected lineage mismatch');
    const manifest = this.fact('manifest', [selected.manifest_digest]).value; assert(manifest, 'manifest unavailable'); validateGraphManifest2(manifest); bound(manifest, this.current);
    assert(manifest.manifest_digest === selected.manifest_digest, 'manifest mismatch'); return selected;
  }
  catalog(selectedPin) {
    pin(selectedPin); const r = this.fact('catalog', [selectedPin.revision_id, selectedPin.digest]).value;
    assert(r, 'catalog unavailable'); fields(r, ['pin', 'catalog']); assert(same(r.pin, selectedPin), 'catalog pin mismatch');
    validateIdentityCatalog(r.catalog); assert(hash(r.catalog) === selectedPin.digest && resolveIdentity(r.catalog, this.current.scope).status === 'resolved', 'catalog scope/digest mismatch'); return r.catalog;
  }
  event(e) {
    validateNormalizedEvent(e); const r = this.fact('accepted_event', [eventObservationKey(e)]).value;
    assert(r, 'accepted event unavailable'); fields(r, ['event', 'event_digest', 'catalog_pin', 'source_ref']); id(r.source_ref); digest(r.event_digest);
    assert(same(r.event, e) && hash(e) === r.event_digest && e.normalization.catalog_digest === r.catalog_pin.digest, 'event identity/catalog rebound');
    this.eventIdentity(e, this.catalog(r.catalog_pin)); return e;
  }
  eventIdentity(e, catalog) {
    assert(e.partition.tenant_id === this.current.scope.tenant_id && e.partition.project_id === this.current.scope.project_id, 'event scope mismatch');
    assert(resolveIdentity(catalog, { ...this.current.scope, source_installation_id: e.partition.source_installation_id, ...e.identity }).status === 'resolved', 'event identity unmapped');
    const install = catalog.source_installations.find(s => s.tenant_id === this.current.scope.tenant_id && s.source_installation_id === e.partition.source_installation_id);
    for (const { object } of e.provenance.source_objects) {
      if (object.kind === 'git_commit') assert(resolveIdentity(catalog, { ...this.current.scope, source_installation_id: e.partition.source_installation_id, repository_id: object.repository_id }).status === 'resolved', 'source repository unmapped');
      else assert(object.provider === install.external_identity.provider && object.authority === install.external_identity.authority, 'source authority unmapped');
    }
  }
}
