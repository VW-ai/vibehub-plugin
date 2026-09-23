import { createHash } from 'node:crypto';
import { validateIdentityCatalog, resolveIdentity } from '../identity/identity.mjs';
import { validateNormalizedEvent, effectiveEventAccess, sourceObjectKey, eventObservationKey } from '../sources/event-provenance.mjs';
import { validateFreshnessVector, validateGraphGenerationPin, sourcePartitionKey } from '../sources/causal-ordering.mjs';

export const WORKING_GRAPH_CONTRACT_VERSION = 1;
export const SEMANTIC_STATES = Object.freeze(['candidate', 'validated', 'rejected', 'stale', 'superseded', 'contested', 'resolved']);
export const SEMANTIC_RELATIONS = Object.freeze(['RELEVANT_TO', 'BELONGS_TO', 'SUPPORTS', 'CONTRADICTS', 'SUPERSEDES', 'DERIVED_FROM', 'EVIDENCE_FOR', 'GOVERNS', 'BLOCKS', 'DEPENDS_ON', 'SAME_AS_CANDIDATE']);
const assert = (ok, message) => { if (!ok) throw new TypeError(`Working Graph: ${message}`); };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
function json(v, ancestors = new Set(), budget = { n: 0 }) {
  assert(++budget.n <= 2000000 && ancestors.size < 48, 'JSON limit exceeded');
  if (v === null || typeof v === 'boolean') return;
  if (typeof v === 'string') { assert(v.length <= 16384, 'string limit'); return; }
  if (typeof v === 'number') { assert(Number.isFinite(v), 'nonfinite number'); return; }
  assert((object(v) || Array.isArray(v)) && !ancestors.has(v), 'expected acyclic JSON');
  assert(!Object.getOwnPropertySymbols(v).length, 'symbol keys');
  for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
    if (Array.isArray(v) && key === 'length') continue;
    assert(Object.hasOwn(d, 'value') && d.enumerable, 'expected JSON data property');
    assert(!Array.isArray(v) || /^(0|[1-9]\d*)$/.test(key) && Number(key) < v.length, 'array property');
  }
  if (Array.isArray(v)) assert(Object.keys(v).length === v.length, 'sparse array');
  ancestors.add(v); Object.values(v).forEach(x => json(x, ancestors, budget)); ancestors.delete(v);
}
function fields(v, required, optional = []) {
  assert(object(v) && required.every(k => Object.hasOwn(v, k)), 'missing field');
  assert(Object.keys(v).every(k => required.includes(k) || optional.includes(k)), 'unknown field');
}
const canonical = v => Array.isArray(v) ? v.map(canonical) : object(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const stable = v => JSON.stringify(canonical(v));
const hash = v => `sha256:${createHash('sha256').update(stable(v)).digest('hex')}`;
const same = (a, b) => stable(a) === stable(b);
const clone = v => JSON.parse(stable(v));
function frozen(v) { if (v && typeof v === 'object') { Object.values(v).forEach(frozen); Object.freeze(v); } return v; }
const result = v => frozen(clone(v));
const id = v => assert(typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(v), 'invalid identifier');
const digest = v => assert(typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v), 'invalid digest');
const list = (v, max = 512) => assert(Array.isArray(v) && v.length <= max, 'bounded list required');
function scope(v) { fields(v, ['tenant_id', 'project_id']); Object.values(v).forEach(id); }
function version(v) { assert(v.schema_version === 1, 'unsupported schema version'); }
function bound(v, graph) { assert(same(v.scope, graph.scope) && v.generation_id === graph.generation_id, 'scope or generation mismatch'); }
const sourceOf = e => ({ partition: e.partition, producer: { producer_id: e.producer.producer_id, epoch: e.producer.epoch } });
const entityKey = (kind, entityId) => stable([kind, entityId]);
const current = state => state.snapshots.at(-1);
const record = (snapshot, address) => snapshot.revisions.find(r => r.revision_digest === address.revision_digest && r.entity_kind === address.entity_kind && r.entity_id === address.entity_id);

function snapshotSources(snapshot) {
  return [...snapshot.watermarks.watermarks.map(w => w.source), ...snapshot.sources.map(s => s.pin.source),
    ...snapshot.access_updates.map(u => sourceOf(u.event))];
}
function assertLifecycleSourceAdmission(event, snapshot) {
  const key = sourcePartitionKey(sourceOf(event));
  assert(snapshotSources(snapshot).some(source => sourcePartitionKey(source) === key),
    'lifecycle source epoch must be explicitly admitted before the access event');
}

export function validateSemanticAddress(v) {
  json(v); fields(v, ['schema_version', 'kind', 'scope', 'generation_id', 'entity_kind', 'entity_id'], v?.kind === 'semantic_revision' ? ['revision_digest'] : []);
  version(v); scope(v.scope); id(v.generation_id); id(v.entity_id);
  assert(['entity', 'relation'].includes(v.entity_kind), 'invalid entity kind');
  assert(['semantic_entity', 'semantic_revision'].includes(v.kind), 'invalid semantic address');
  if (v.kind === 'semantic_revision') digest(v.revision_digest);
  return true;
}
export function semanticAddress(input) {
  json(input); fields(input, ['scope', 'generation_id', 'entity_kind', 'entity_id']);
  const value = { schema_version: 1, kind: 'semantic_entity', ...input }; validateSemanticAddress(value); return result(value);
}
export function exactRevisionAddress(revision) {
  json(revision);
  const { scope, generation_id, entity_kind, entity_id } = revision;
  const value = { ...semanticAddress({ scope, generation_id, entity_kind, entity_id }), kind: 'semantic_revision', revision_digest: revision.revision_digest };
  validateSemanticAddress(value); return result(value);
}
function exact(v, graph) { validateSemanticAddress(v); assert(v.kind === 'semantic_revision', 'exact revision required'); if (graph) bound(v, graph); }
export function validateGraphRevisionAddress(v) {
  json(v); fields(v, ['schema_version', 'kind', 'scope', 'generation_id', 'snapshot_digest']); version(v); scope(v.scope);
  assert(v.kind === 'graph_revision', 'invalid graph address');
  validateGraphGenerationPin({ generation_id: v.generation_id, snapshot_digest: v.snapshot_digest }); return true;
}
export function graphRevisionAddress(value) {
  json(value);
  const snapshot = value.snapshots ? current(value) : value;
  const address = { schema_version: 1, kind: 'graph_revision', scope: snapshot.scope, generation_id: snapshot.generation_id, snapshot_digest: snapshot.snapshot_digest };
  validateGraphRevisionAddress(address); return result(address);
}
export function canonicalArtifactAddress(event) {
  validateNormalizedEvent(event); assert(['git_revision', 'object_revision'].includes(event.payload.kind), 'canonical artifact requires immutable source revision');
  return result({ schema_version: 1, kind: 'canonical_artifact', scope: { tenant_id: event.partition.tenant_id, project_id: event.partition.project_id }, event });
}
function canonicalArtifact(v, graph) {
  fields(v, ['schema_version', 'kind', 'scope', 'event']); version(v); scope(v.scope);
  assert(v.kind === 'canonical_artifact' && same(v, canonicalArtifactAddress(v.event)), 'invalid canonical artifact');
  if (graph) assert(same(v.scope, graph.scope), 'canonical artifact scope mismatch');
}
function endpoint(v, graph) { if (v?.kind === 'canonical_artifact') canonicalArtifact(v, graph); else exact(v, graph); }
function eventScope(e, graph, catalog) {
  validateNormalizedEvent(e); assert(e.partition.tenant_id === graph.scope.tenant_id && e.partition.project_id === graph.scope.project_id, 'event scope mismatch');
  if (catalog) {
    const r = resolveIdentity(catalog, { ...graph.scope, source_installation_id: e.partition.source_installation_id, ...e.identity });
    assert(r.status === 'resolved', 'event identity unmapped');
    const installation = catalog.source_installations.find(s => s.tenant_id === graph.scope.tenant_id && s.source_installation_id === e.partition.source_installation_id);
    for (const { object: o } of e.provenance.source_objects) {
      if (o.kind === 'git_commit') assert(resolveIdentity(catalog, { ...graph.scope, source_installation_id: e.partition.source_installation_id, repository_id: o.repository_id }).status === 'resolved', 'source repository unmapped');
      else assert(o.provider === installation.external_identity.provider && o.authority === installation.external_identity.authority, 'source authority unmapped');
    }
  }
}
function sourcePins(e) {
  const source = sourceOf(e);
  return [{ key: stable(['event', eventObservationKey(e)]), source, object: null, acl: e.acl, sensitivity: e.sensitivity },
    ...e.provenance.source_objects.map(s => ({ key: stable(['object', eventObservationKey(e), sourceObjectKey(s.object)]), source, ...s }))];
}
function provenance(events, accessEvents = []) {
  const unique = new Map();
  for (const e of events) { validateNormalizedEvent(e); assert(e.provenance.source_objects.length > 0, 'supporting event requires source object for invalidation'); const key = eventObservationKey(e); assert(!unique.has(key) || same(unique.get(key), e), 'conflicting event pin'); unique.set(key, e); }
  const ordered = [...unique.values()].sort((a, b) => eventObservationKey(a) < eventObservationKey(b) ? -1 : eventObservationKey(a) > eventObservationKey(b) ? 1 : 0);
  const pins = new Map(); for (const e of ordered) for (const pin of sourcePins(e)) pins.set(stable(pin), pin);
  const accessOrdered = [...accessEvents].sort((a, b) => hash(a) < hash(b) ? -1 : hash(a) > hash(b) ? 1 : 0);
  assert(new Set(accessOrdered.map(hash)).size === accessOrdered.length, 'duplicate access event');
  accessOrdered.forEach(e => { validateNormalizedEvent(e); assert(['SOURCE_ACCESS_CHANGED', 'SOURCE_TOMBSTONE'].includes(e.event_type), 'invalid access event'); });
  const access = [...ordered, ...accessOrdered].map(effectiveEventAccess);
  const levels = ['normal', 'sensitive', 'restricted'];
  return { schema_version: 1, events: ordered, access_events: accessOrdered, source_pins: [...pins.values()].sort((a, b) => stable(a) < stable(b) ? -1 : stable(a) > stable(b) ? 1 : 0),
    effective_access: { allowed_principal_ids: access.length ? access[0].allowed_principal_ids.filter(p => access.every(a => a.allowed_principal_ids.includes(p))).sort() : [],
      sensitivity: levels[Math.max(0, ...access.map(a => levels.indexOf(a.sensitivity)))] } };
}
export function validateProvenanceClosure(value) {
  json(value); fields(value, ['schema_version', 'events', 'access_events', 'source_pins', 'effective_access']); version(value); list(value.events, 128); list(value.access_events, 128);
  assert(same(value, provenance(value.events, value.access_events)), 'provenance closure mismatch'); return true;
}
function assertionShape(a, graph) {
  fields(a, ['schema_version', 'assertion_id', 'entity_kind', 'entity_id', 'base_revision', 'parents', 'execution_id', 'status', 'content', 'events', 'canonical_refs'], ['access_revisions']); version(a);
  id(a.assertion_id); id(a.entity_id); id(a.execution_id); assert(['entity', 'relation'].includes(a.entity_kind), 'invalid entity kind');
  assert(SEMANTIC_STATES.includes(a.status) && a.status !== 'contested', 'invalid assertion lifecycle');
  if (a.base_revision !== null) { exact(a.base_revision, graph); assert(a.base_revision.entity_kind === a.entity_kind && a.base_revision.entity_id === a.entity_id, 'base entity mismatch'); }
  list(a.parents, 128); a.parents.forEach(p => exact(p, graph)); assert(new Set(a.parents.map(stable)).size === a.parents.length, 'duplicate parents');
  list(a.events, 128); a.events.forEach(e => eventScope(e, graph));
  if (a.access_revisions !== undefined) { list(a.access_revisions, 128); a.access_revisions.forEach(digest); assert(new Set(a.access_revisions).size === a.access_revisions.length, 'duplicate access revision'); }
  list(a.canonical_refs, 32); a.canonical_refs.forEach(c => canonicalArtifact(c, graph));
  if (a.entity_kind === 'entity') { fields(a.content, ['semantic_type', 'data']); id(a.content.semantic_type); }
  else { fields(a.content, ['relation_type', 'from', 'to', 'data']); assert(SEMANTIC_RELATIONS.includes(a.content.relation_type), 'unsupported relation'); endpoint(a.content.from, graph); endpoint(a.content.to, graph); }
}
function supportingEvents(a, snapshot) {
  const events = [...a.events, ...a.canonical_refs.map(c => c.event)];
  const refs = [...a.parents];
  if (a.entity_kind === 'relation') for (const point of [a.content.from, a.content.to]) {
    if (point.kind === 'canonical_artifact') events.push(point.event); else refs.push(point);
  }
  for (const p of refs) { const r = record(snapshot, p); assert(r, 'missing exact supporting revision'); events.push(...r.provenance.events); }
  return events;
}
function revisionBody(r) { const { revision_digest, ...body } = r; return body; }
export function validateSemanticRevision(r) {
  json(r); fields(r, ['schema_version', 'scope', 'generation_id', 'entity_kind', 'entity_id', 'assertion', 'provenance', 'revision_digest']); version(r); scope(r.scope); id(r.generation_id);
  assertionShape(r.assertion, r); assert(r.entity_id === r.assertion.entity_id && r.entity_kind === r.assertion.entity_kind, 'assertion entity mismatch');
  validateProvenanceClosure(r.provenance); [...r.provenance.events, ...r.provenance.access_events].forEach(e => eventScope(e, r));
  assert(same([...(r.assertion.access_revisions ?? [])].sort(), r.provenance.access_events.map(hash).sort()), 'access revision pins mismatch'); digest(r.revision_digest);
  assert(hash(revisionBody(r)) === r.revision_digest, 'revision digest mismatch'); return true;
}
function relevantAccess(events, snapshot) {
  const targets = new Set(events.flatMap(e => e.provenance.source_objects.map(s => sourceObjectKey(s.object))));
  const latest = new Map();
  for (const update of snapshot.access_updates) for (const support of update.event.provenance.source_objects) {
    const key = sourceObjectKey(support.object);
    if (targets.has(key)) latest.set(stable([sourcePartitionKey(sourceOf(update.event)), key]), update);
  }
  return [...new Map([...latest.values()].map(u => [u.event_digest, u])).values()];
}
function unavailable(revision, snapshot) {
  const updates = relevantAccess(revision.provenance.events, snapshot);
  return updates.some(u => u.access_state !== 'active')
    || !same(updates.map(u => u.event_digest).sort(), revision.provenance.access_events.map(hash).sort())
    || revision.provenance.source_pins.some(pin => !snapshot.sources.some(s => same(s.pin, pin)));
}
function projection(snapshot) {
  return snapshot.entities.map(e => {
    const refs = [e.head, ...e.competing];
    const quarantined = refs.some(ref => unavailable(record(snapshot, ref), snapshot));
    return { ...e, status: quarantined ? 'stale' : e.competing.length ? 'contested' : record(snapshot, e.head).assertion.status, quarantined };
  });
}
/** Reconstruct the derived head and every implied conflict from immutable assertion order. */
function advanceAssertionProjection(snapshot, revision) {
  const a = revision.assertion; const address = exactRevisionAddress(revision);
  const head = snapshot.entities.find(e => e.entity_kind === a.entity_kind && e.entity_id === a.entity_id);
  if (!head) {
    assert(a.base_revision === null && a.status === 'candidate', 'new entity starts as candidate with no base');
    snapshot.entities.push({ entity_kind: a.entity_kind, entity_id: a.entity_id, head: address, competing: [], status: a.status, quarantined: false });
    return null;
  }
  if (a.status === 'resolved') {
    assert(head.competing.length > 0 && same(a.base_revision, head.head), 'resolution requires current contested base');
    assert(head.competing.every(p => a.parents.some(parent => same(parent, p))), 'resolution omitted competing parent');
    for (const open of snapshot.conflicts.filter(c => c.entity_id === a.entity_id && c.entity_kind === a.entity_kind
      && !snapshot.resolutions.some(r => r.conflict_digest === c.conflict_digest))) {
      snapshot.resolutions.push({ conflict_digest: open.conflict_digest, resolution: address });
    }
    head.head = address; head.competing = []; return null;
  }
  if (head.competing.length || !same(a.base_revision, head.head)) {
    const assertions = [...new Map([head.head, ...head.competing, address].map(p => [stable(p), p])).values()];
    const body = { schema_version: 1, scope: snapshot.scope, generation_id: snapshot.generation_id, entity_kind: a.entity_kind, entity_id: a.entity_id, assertions };
    const conflict = { ...body, conflict_digest: hash(body) }; snapshot.conflicts.push(conflict); head.competing = assertions;
    return conflict;
  }
  head.head = address; return null;
}
function snapshotBody(s) { const { snapshot_digest, ...body } = s; return body; }
function seal(snapshot) { snapshot.entities = projection(snapshot); snapshot.snapshot_digest = hash(snapshotBody(snapshot)); return result(snapshot); }
function next(state) { const s = clone(current(state)); s.previous_snapshot_digest = s.snapshot_digest; s.sequence++; delete s.snapshot_digest; return s; }
function finish(state, snapshot, extra = {}) {
  assert(state.snapshots.length < 128, 'snapshot capacity exceeded');
  const out = { ...state, snapshots: [...state.snapshots, seal(snapshot)] }; validateWorkingGraph(out);
  return result({ status: 'applied', state: out, graph_revision: graphRevisionAddress(out), ...extra });
}
export function validateGraphConflict(c) {
  json(c); fields(c, ['schema_version', 'scope', 'generation_id', 'entity_kind', 'entity_id', 'assertions', 'conflict_digest']); version(c); scope(c.scope); id(c.generation_id); id(c.entity_id);
  list(c.assertions, 512); assert(c.assertions.length >= 2, 'conflict needs competing assertions');
  c.assertions.forEach(r => { exact(r, c); assert(r.entity_id === c.entity_id && r.entity_kind === c.entity_kind, 'conflict entity mismatch'); });
  assert(new Set(c.assertions.map(stable)).size === c.assertions.length, 'duplicate conflict assertion');
  const { conflict_digest, ...body } = c; assert(hash(body) === conflict_digest, 'conflict digest mismatch'); return true;
}
export function validateGraphRevision(s) {
  json(s); fields(s, ['schema_version', 'scope', 'generation_id', 'sequence', 'previous_snapshot_digest', 'catalog_digest', 'revisions', 'entities', 'conflicts', 'resolutions', 'sources', 'access_updates', 'watermarks', 'snapshot_digest']);
  version(s); scope(s.scope); validateGraphGenerationPin({ generation_id: s.generation_id, snapshot_digest: s.snapshot_digest }); digest(s.catalog_digest);
  assert(Number.isSafeInteger(s.sequence) && s.sequence >= 0, 'invalid graph sequence');
  if (s.sequence === 0) assert(s.previous_snapshot_digest === null, 'genesis previous snapshot'); else digest(s.previous_snapshot_digest);
  validateFreshnessVector(s.watermarks); assert(same(s.scope, s.watermarks.scope), 'watermark scope mismatch');
  for (const k of ['revisions', 'entities', 'conflicts', 'resolutions', 'sources', 'access_updates']) list(s[k]);
  const seen = new Map();
  for (const r of s.revisions) {
    validateSemanticRevision(r); bound(r, s); assert(!seen.has(r.revision_digest), 'duplicate revision');
    const earlier = { revisions: [...seen.values()] }; if (r.assertion.base_revision) assert(record(earlier, r.assertion.base_revision), 'missing exact base revision');
    assert(same(r.provenance, provenance(supportingEvents(r.assertion, earlier), r.provenance.access_events)), 'incomplete provenance closure'); seen.set(r.revision_digest, r);
  }
  assert(new Set(s.revisions.map(r => r.assertion.assertion_id)).size === s.revisions.length, 'duplicate assertion id');
  const eventPins = new Map();
  for (const e of [...s.revisions.flatMap(r => [...r.provenance.events, ...r.provenance.access_events]), ...s.sources.map(x => x.event), ...s.access_updates.map(x => x.event)]) {
    const key = eventObservationKey(e); assert(!eventPins.has(key) || same(eventPins.get(key), e), 'source event identity rebound'); eventPins.set(key, e);
  }
  const keys = new Set();
  for (const e of s.entities) {
    fields(e, ['entity_kind', 'entity_id', 'head', 'competing', 'status', 'quarantined']); exact(e.head, s); list(e.competing); e.competing.forEach(p => exact(p, s));
    assert([e.head, ...e.competing].every(p => p.entity_kind === e.entity_kind && p.entity_id === e.entity_id && record(s, p)), 'invalid projection head');
    const key = entityKey(e.entity_kind, e.entity_id); assert(!keys.has(key), 'duplicate entity'); keys.add(key);
  }
  assert(s.revisions.every(r => keys.has(entityKey(r.entity_kind, r.entity_id))), 'unprojected entity');
  s.conflicts.forEach(c => { validateGraphConflict(c); bound(c, s); assert(c.assertions.every(p => record(s, p)), 'missing conflict revision'); });
  assert(new Set(s.conflicts.map(c => c.conflict_digest)).size === s.conflicts.length, 'duplicate conflict');
  const resolved = new Set();
  for (const r of s.resolutions) {
    fields(r, ['conflict_digest', 'resolution']); exact(r.resolution, s); const c = s.conflicts.find(x => x.conflict_digest === r.conflict_digest); const revision = record(s, r.resolution);
    assert(c && revision?.assertion.status === 'resolved' && c.entity_id === revision.entity_id && c.entity_kind === revision.entity_kind, 'invalid resolution');
    assert(c.assertions.every(p => revision.assertion.parents.some(parent => same(parent, p))), 'resolution omitted competing parent');
    assert(!resolved.has(r.conflict_digest), 'duplicate resolution'); resolved.add(r.conflict_digest);
  }
  for (const e of s.entities) {
    const open = s.conflicts.filter(c => c.entity_id === e.entity_id && c.entity_kind === e.entity_kind && !resolved.has(c.conflict_digest));
    const expected = [...new Map(open.flatMap(c => c.assertions).map(p => [stable(p), p])).values()];
    assert(same(e.competing, expected), 'conflict projection mismatch');
  }
  const sourceKeys = new Set();
  for (const entry of s.sources) {
    fields(entry, ['pin', 'event']); eventScope(entry.event, s);
    assert(sourcePins(entry.event).some(p => same(p, entry.pin)), 'invalid source pin');
    assert(!sourceKeys.has(entry.pin.key), 'duplicate source key'); sourceKeys.add(entry.pin.key);
  }
  const priorAccess = [];
  for (const update of s.access_updates) {
    fields(update, ['event', 'event_digest', 'access_state']); eventScope(update.event, s); digest(update.event_digest);
    assert(hash(update.event) === update.event_digest, 'access event digest mismatch');
    accessUpdate(update, { ...s, access_updates: priorAccess }, true); priorAccess.push(update);
  }
  for (const revision of s.revisions) for (const e of revision.provenance.access_events) {
    assert(s.access_updates.some(u => u.event_digest === hash(e)), 'missing access revision');
  }
  assert(s.sequence === s.revisions.length + s.access_updates.length, 'snapshot sequence does not match immutable mutation history');
  const derived = { ...s, entities: [], conflicts: [], resolutions: [] };
  for (const revision of s.revisions) advanceAssertionProjection(derived, revision);
  assert(same(s.conflicts, derived.conflicts) && same(s.resolutions, derived.resolutions), 'assertion history conflict/resolution mismatch');
  assert(same(s.entities, projection(derived)), 'assertion history head/lifecycle mismatch');
  if (s.sequence === 0) assert(['revisions', 'entities', 'conflicts', 'resolutions', 'sources', 'access_updates'].every(k => s[k].length === 0), 'genesis must be empty');
  assert(hash(snapshotBody(s)) === s.snapshot_digest, 'snapshot digest mismatch'); return true;
}
/** Admission of an imported snapshot uses only facts available in its predecessor. */
function validateSnapshotStep(state, before, after) {
  const revisionCount = after.revisions.length - before.revisions.length;
  const accessCount = after.access_updates.length - before.access_updates.length;
  assert(revisionCount === 1 && accessCount === 0 || revisionCount === 0 && accessCount === 1, 'snapshot must contain exactly one mutation');
  const expected = clone(before); expected.sequence++; expected.previous_snapshot_digest = before.snapshot_digest; delete expected.snapshot_digest;
  if (revisionCount) {
    const revision = after.revisions.at(-1); const resolving = revision.assertion.status === 'resolved';
    // Only ordinary assertion admission can explicitly update the captured watermark vector.
    if (!resolving) expected.watermarks = after.watermarks;
    appendAssertion(state, expected, revision.assertion, resolving);
    advanceAssertionProjection(expected, expected.revisions.at(-1));
  } else {
    const update = after.access_updates.at(-1); accessUpdate(update, expected); expected.access_updates.push(update);
  }
  assert(same(after, seal(expected)), 'snapshot transition mismatch');
}
export function validateWorkingGraph(state) {
  json(state); fields(state, ['schema_version', 'catalog', 'scope', 'generation_id', 'snapshots']); version(state); scope(state.scope); id(state.generation_id); validateIdentityCatalog(state.catalog);
  assert(resolveIdentity(state.catalog, state.scope).status === 'resolved', 'unmapped graph scope'); list(state.snapshots, 128); assert(state.snapshots.length > 0, 'missing snapshot');
  for (const [i, s] of state.snapshots.entries()) {
    validateGraphRevision(s); bound(s, state); assert(s.catalog_digest === hash(state.catalog) && s.sequence === i, 'catalog/sequence mismatch');
    assert(s.previous_snapshot_digest === (i ? state.snapshots[i - 1].snapshot_digest : null), 'snapshot chain mismatch');
    for (const r of s.revisions) {
     assert(resolveIdentity(state.catalog, { ...state.scope, execution_id: r.assertion.execution_id }).status === 'resolved', 'execution scope mismatch');
      [...r.provenance.events, ...r.provenance.access_events].forEach(e => eventScope(e, state, state.catalog));
    }
    [...s.sources.map(x => x.event), ...s.access_updates.map(x => x.event)].forEach(e => eventScope(e, state, state.catalog));
    if (i) {
      const prev = state.snapshots[i - 1];
      assert(same(s.revisions.slice(0, prev.revisions.length), prev.revisions) && same(s.conflicts.slice(0, prev.conflicts.length), prev.conflicts)
        && same(s.resolutions.slice(0, prev.resolutions.length), prev.resolutions), 'history rewritten');
      assert(same(s.sources.slice(0, prev.sources.length), prev.sources) && same(s.access_updates.slice(0, prev.access_updates.length), prev.access_updates), 'source history rewritten');
      validateSnapshotStep(state, prev, s);
    }
  }
  return true;
}
export function createWorkingGraph(input) {
  json(input); fields(input, ['catalog', 'scope', 'generation_id', 'watermarks']); validateIdentityCatalog(input.catalog); scope(input.scope); id(input.generation_id);
  const state = { schema_version: 1, catalog: clone(input.catalog), scope: input.scope, generation_id: input.generation_id, snapshots: [seal({ schema_version: 1,
    scope: input.scope, generation_id: input.generation_id, sequence: 0, previous_snapshot_digest: null, catalog_digest: hash(input.catalog),
    revisions: [], entities: [], conflicts: [], resolutions: [], sources: [], access_updates: [], watermarks: input.watermarks })] };
  validateWorkingGraph(state); return result(state);
}
function transaction(state, input, required, optional = []) {
  validateWorkingGraph(state); json(input); fields(input, ['expected_graph', ...required], optional); validateGraphRevisionAddress(input.expected_graph); bound(input.expected_graph, state);
  if (!same(input.expected_graph, graphRevisionAddress(state))) return result({ status: 'graph_revision_mismatch', state, proposal: input, graph_revision: graphRevisionAddress(state) });
  return null;
}
function appendAssertion(state, snapshot, a, resolving = false) {
  assertionShape(a, state);
  const ordered = values => [...values].sort((left, right) => stable(left) < stable(right) ? -1 : stable(left) > stable(right) ? 1 : 0);
  a = { ...a, events: ordered(a.events), parents: ordered(a.parents), canonical_refs: ordered(a.canonical_refs),
    ...(a.access_revisions === undefined ? {} : { access_revisions: [...a.access_revisions].sort() }) };
  assert(resolveIdentity(state.catalog, { ...state.scope, execution_id: a.execution_id }).status === 'resolved', 'execution scope mismatch');
  assert(!snapshot.revisions.some(r => r.assertion.assertion_id === a.assertion_id), 'assertion id already exists');
  if (a.base_revision) assert(record(snapshot, a.base_revision), 'missing exact base revision');
  assert(resolving ? a.status === 'resolved' : a.status !== 'resolved', 'resolution requires explicit conflict transition');
  const events = supportingEvents(a, snapshot);
  const updates = relevantAccess(events, snapshot);
  assert(same([...(a.access_revisions ?? [])].sort(), updates.map(u => u.event_digest).sort()), 'stale source access revisions');
  const supportRefs = [...a.parents, ...(a.entity_kind === 'relation' ? [a.content.from, a.content.to].filter(p => p.kind === 'semantic_revision') : [])];
  assert(supportRefs.every(p => !unavailable(record(snapshot, p), snapshot)), 'stale supporting revision');
  const body = { schema_version: 1, scope: state.scope, generation_id: state.generation_id, entity_kind: a.entity_kind, entity_id: a.entity_id,
    assertion: a, provenance: provenance(events, updates.map(u => u.event)) };
  body.provenance.events.forEach(e => eventScope(e, state, state.catalog));
  for (const e of body.provenance.events) {
    assert(!['SOURCE_TOMBSTONE', 'SOURCE_ACCESS_CHANGED'].includes(e.event_type), 'lifecycle event cannot assert content');
    for (const pin of sourcePins(e)) if (!snapshot.sources.some(s => s.pin.key === pin.key)) snapshot.sources.push({ pin, event: e });
  }
  const revision = { ...body, revision_digest: hash(body) }; assert(!unavailable(revision, snapshot), 'stale source access or tombstone');
  snapshot.revisions.push(revision); return exactRevisionAddress(revision);
}
export function applyGraphAssertion(state, input) {
  const failed = transaction(state, input, ['assertion'], ['watermarks']); if (failed) return failed;
  const snapshot = next(state); if (input.watermarks) snapshot.watermarks = input.watermarks;
  const address = appendAssertion(state, snapshot, input.assertion);
  const conflict = advanceAssertionProjection(snapshot, snapshot.revisions.at(-1));
  return finish(state, snapshot, { revision: address, conflict });
}
export function resolveGraphConflict(state, input) {
  const failed = transaction(state, input, ['conflict_digest', 'assertion']); if (failed) return failed;
  digest(input.conflict_digest); const snapshot = next(state); const c = snapshot.conflicts.find(x => x.conflict_digest === input.conflict_digest);
  assert(c && !snapshot.resolutions.some(r => r.conflict_digest === c.conflict_digest), 'conflict not open');
  const head = snapshot.entities.find(e => e.entity_kind === c.entity_kind && e.entity_id === c.entity_id); const a = input.assertion;
  assert(a.entity_id === c.entity_id && a.entity_kind === c.entity_kind && same(a.base_revision, head.head), 'resolution base mismatch');
  assert(head.competing.every(p => a.parents.some(parent => same(parent, p))), 'resolution omitted competing parent');
  const address = appendAssertion(state, snapshot, a, true);
  advanceAssertionProjection(snapshot, snapshot.revisions.at(-1));
  return finish(state, snapshot, { revision: address });
}
function accessUpdate(update, snapshot, historical = false) {
  const e = update.event;
  // Historical admission is proved against its original predecessor by validateSnapshotStep.
  // A later captured watermark view may omit that source without revoking its history.
  if (!historical) assertLifecycleSourceAdmission(e, snapshot);
  assert(['SOURCE_ACCESS_CHANGED', 'SOURCE_TOMBSTONE'].includes(e.event_type), 'source lifecycle event required');
  assert(e.event_type === 'SOURCE_TOMBSTONE' ? update.access_state === 'tombstoned' : ['active', 'unknown'].includes(update.access_state), 'invalid lifecycle access state');
  assert(e.producer.sequence !== null, 'source update requires sequenced event');
  assert(e.provenance.source_objects.length > 0, 'lifecycle update requires explicit source objects');
  const previous = snapshot.access_updates.filter(u => sourcePartitionKey(sourceOf(u.event)) === sourcePartitionKey(sourceOf(e))).at(-1);
  assert(!previous || e.producer.sequence > previous.event.producer.sequence, 'source update lacks causal order');
  for (const support of e.provenance.source_objects) {
    const key = sourceObjectKey(support.object);
    const observed = snapshot.sources.filter(s => s.pin.object && sourceObjectKey(s.pin.object) === key);
    assert(observed.length > 0, 'unknown lifecycle target source object');
    for (const pin of observed) if (!historical && sourcePartitionKey(pin.pin.source) === sourcePartitionKey(sourceOf(e))) {
      assert(pin.event.producer.sequence !== null && e.producer.sequence > pin.event.producer.sequence, 'source update lacks causal order');
    }
    assert(!snapshot.access_updates.some(u => u.access_state === 'tombstoned' && u.event.provenance.source_objects.some(s => sourceObjectKey(s.object) === key)), 'tombstone cannot reopen');
  }
}
export function updateGraphSourceAccess(state, input) {
  const failed = transaction(state, input, ['event', 'access_state']); if (failed) return failed;
  eventScope(input.event, state, state.catalog);
  const update = { event: input.event, event_digest: hash(input.event), access_state: input.access_state };
  const snapshot = next(state); accessUpdate(update, snapshot); snapshot.access_updates.push(update);
  return finish(state, snapshot, { access_revision: update.event_digest });
}
export function resolveWorkingGraphAddress(state, address, options) {
  validateWorkingGraph(state); json(address); json(options); fields(options, ['principal_id', 'current_graph'], ['graph_revision']); id(options.principal_id);
  validateWorkingGraph(options.current_graph); bound(state, options.current_graph);
  const now = current(options.current_graph); const requested = options.graph_revision ?? graphRevisionAddress(state); validateGraphRevisionAddress(requested); bound(requested, state);
  const snapshot = state.snapshots.find(s => s.snapshot_digest === requested.snapshot_digest); assert(snapshot, 'exact graph revision unavailable');
  assert(options.current_graph.snapshots.some(s => s.snapshot_digest === snapshot.snapshot_digest), 'current authorization graph lacks snapshot lineage');
  validateSemanticAddress(address); bound(address, state);
  const entity = snapshot.entities.find(e => e.entity_kind === address.entity_kind && e.entity_id === address.entity_id);
  const revision = address.kind === 'semantic_revision' ? record(snapshot, address) : entity && record(snapshot, entity.head);
  if (!revision) return result({ status: 'unavailable', revision: null });
  if (unavailable(revision, now) || !revision.provenance.effective_access.allowed_principal_ids.includes(options.principal_id)) return result({ status: 'denied', revision: null });
  const competing = entity?.competing ?? [];
  if (competing.some(p => { const r = record(snapshot, p); return unavailable(r, now) || !r.provenance.effective_access.allowed_principal_ids.includes(options.principal_id); })) return result({ status: 'denied', revision: null });
  return result({ status: 'resolved', revision, entity, conflicts: snapshot.conflicts.filter(c => c.entity_kind === revision.entity_kind && c.entity_id === revision.entity_id && !snapshot.resolutions.some(r => r.conflict_digest === c.conflict_digest)), graph_revision: requested });
}
export function validateWorkerGraphInput(state, input) {
  validateWorkingGraph(state); json(input); fields(input, ['graph_revision', 'revisions', 'principal_id']); validateGraphRevisionAddress(input.graph_revision); bound(input.graph_revision, state); list(input.revisions, 128); id(input.principal_id);
  if (!same(input.graph_revision, graphRevisionAddress(state))) return result({ status: 'stale', reason: 'graph_revision_changed' });
  for (const address of input.revisions) {
    exact(address, state); const snapshot = current(state); const entity = snapshot.entities.find(e => e.entity_kind === address.entity_kind && e.entity_id === address.entity_id);
    if (!entity || !same(entity.head, address) || entity.competing.length || entity.quarantined) return result({ status: 'stale', reason: 'input_revision_changed' });
    if (resolveWorkingGraphAddress(state, address, { principal_id: input.principal_id, current_graph: state }).status !== 'resolved') return result({ status: 'stale', reason: 'source_access_changed' });
  }
  return result({ status: 'valid' });
}
