import assert from 'node:assert/strict';
import { fingerprint, canonical } from '../../src/core/contracts.mjs';
import { eventObservationKey, validateNormalizedEvent } from '../../src/core/event-provenance.mjs';
import { validateIdentityCatalog } from '../../src/core/identity.mjs';
import { validateGraphEffectPlan2 } from '../../src/core/incremental-graph.mjs';

const hash = value => `sha256:${fingerprint(value)}`;
const keyOf = (kind, key) => JSON.stringify(canonical([kind, key]));
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const queryKinds = new Set(['manifest', 'commit', 'catalog', 'revision', 'entity', 'assertion_id', 'accepted_event', 'source_epoch', 'source_object', 'source_object_epoch', 'source_access', 'conflict', 'resolution', 'access_update']);
const projectionKinds = new Set(['entity', 'assertion_id', 'source_epoch', 'source_object', 'source_object_epoch', 'source_access']);
const historyKey = (kind, id) => keyOf('history', [kind, id]);

/** Synthetic, indexed contract port. No persistence, authentication or throughput claim. */
export class IndexedGraphFixture {
  #scope; #generation; #principal; #catalogPin; #accessVersion = 0; #head = null; #headVersion = null;
  #rows = new Map(); #external = new Map(); #commits = new Map(); #headIndex = []; #history = new Map(); #conflicts = []; #entityConflicts = new Map();
  #lifecycleAllowed = true; #counts = {}; #maxPlanBytes = 0; #maxRowBytes = 0;
  constructor({ catalog, scope, generation_id = 'live-1', watermarks, principal_id = 'alice' }) {
    this.#scope = structuredClone(scope); this.#generation = generation_id; this.#principal = principal_id;
    this.watermarks = structuredClone(watermarks); this.resetMetrics(); this.#catalogPin = this.retainCatalog(catalog, 'catalog-v1');
    this.port = Object.freeze({ current: () => this.#current(), read: query => this.#read(query),
      page: query => this.#page(query), authorizeLifecycle: query => this.#authority(query) });
  }
  get head() { return structuredClone(this.#head); }
  get catalogPin() { return structuredClone(this.#catalogPin); }
  get metrics() { return structuredClone({ ...this.stats, max_plan_bytes: this.#maxPlanBytes, max_row_bytes: this.#maxRowBytes,
    record_counts: this.#counts, committed_transitions: this.#head ? this.#commits.get(this.#head.commit_digest).sequence : 0 }); }
  resetMetrics() { this.stats = { current: 0, read: 0, page: 0, authority: 0, candidate_rows: 0, binary_search_steps: 0, point_lookups: 0, read_kinds: {}, requests: [] }; }
  #record(method, request) { this.stats[method]++; this.stats.requests.push({ method, ...(request === undefined ? {} : structuredClone(request)) }); }
  #count(kind, value) { this.#counts[kind] = (this.#counts[kind] ?? 0) + 1; this.#maxRowBytes = Math.max(this.#maxRowBytes, bytes(value)); }
  #view() { return { scope: structuredClone(this.#scope), generation_id: this.#generation, head: this.head, head_version: this.#headVersion,
    catalog_pin: this.catalogPin, access_view: `access-${this.#accessVersion}`, principal_id: this.#principal }; }
  #current() { this.#record('current'); return this.#view(); }
  #at(address) {
    this.stats.point_lookups++;
    assert(address && same(address.scope, this.#scope) && address.generation_id === this.#generation, 'fixture: foreign selected graph');
    const commit = this.#commits.get(address.commit_digest); assert(commit && same(commit.address, address), 'fixture: uncommitted graph');
    return commit.sequence;
  }
  #upper(rows, value, field) {
    let lo = 0, hi = rows.length;
    while (lo < hi) { this.stats.binary_search_steps++; const mid = lo + Math.floor((hi - lo) / 2); if (rows[mid][field] <= value) lo = mid + 1; else hi = mid; }
    return lo;
  }
  #row(kind, key, sequence) {
    this.stats.point_lookups++; const versions = this.#rows.get(keyOf(kind, key));
    if (!versions) return null;
    const index = this.#upper(versions, sequence, 'sequence') - 1; return index < 0 ? null : versions[index];
  }
  #read({ at, kind, key }) {
    this.#record('read', { at, kind, key }); this.stats.read_kinds[kind] = (this.stats.read_kinds[kind] ?? 0) + 1;
    assert(queryKinds.has(kind) && Array.isArray(key) && key.length >= 1 && key.length <= 2 && key.every(v => typeof v === 'string'), 'fixture: finite point query required');
    const sequence = at === null ? (assert.equal(this.#head, null, 'fixture: null at after genesis'), -1) : this.#at(at);
    let row;
    if (['catalog', 'accepted_event'].includes(kind)) { this.stats.point_lookups++; row = this.#external.get(keyOf(kind, key)); }
    else row = this.#row(kind, key, sequence);
    return { at: structuredClone(at), current_head: this.head, access_view: this.#view().access_view, kind, key: structuredClone(key), complete: true,
      version: row?.version ?? null, value: row ? structuredClone(row.value) : null, origin: row ? structuredClone(row.origin) : null };
  }
  #page({ at, collection, after, limit }) {
    this.#record('page', { at, collection, after, limit }); const sequence = this.#at(at);
    assert(Number.isInteger(limit) && limit >= 1 && limit <= 64, 'fixture: bounded page required');
    assert(after === null || (Number.isSafeInteger(after) && after >= 0), 'fixture: invalid position');
    let index;
    if (collection.kind === 'heads') { assert.deepEqual(Object.keys(collection), ['kind']); index = this.#headIndex; }
    else if (collection.kind === 'history') index = this.#history.get(historyKey(collection.entity_kind, collection.entity_id)) ?? [];
    else if (collection.kind === 'conflicts') index = collection.entity === null ? this.#conflicts : this.#entityConflicts.get(historyKey(collection.entity.entity_kind, collection.entity.entity_id)) ?? [];
    else assert.fail('fixture: no all-history/all-entity materialization query');
    this.stats.point_lookups++; const start = after === null ? 0 : this.#upper(index, after, 'position');
    const end = this.#upper(index, sequence, 'sequence'), stop = Math.min(start + limit, end);
    const selected = start < end ? index.slice(start, stop) : []; this.stats.candidate_rows += selected.length;
    return { at: structuredClone(at), current_head: this.head, access_view: this.#view().access_view, collection: structuredClone(collection), after,
      rows: selected.map(({ position, kind, key }) => ({ position, kind, key: structuredClone(key) })),
      next_position: stop < end && selected.length ? selected.at(-1).position : null };
  }
  #authority({ at, event_digest, targets }) {
    this.#record('authority', { at, event_digest, targets }); this.#at(at);
    return { at: structuredClone(at), current_head: this.head, access_view: this.#view().access_view, event_digest,
      targets: structuredClone(targets), principal_id: this.#principal, allowed: this.#lifecycleAllowed, authority_ref: 'synthetic-explicit-lifecycle-grant' };
  }
  retainCatalog(catalog, revision_id) {
    validateIdentityCatalog(catalog); const pin = { revision_id, digest: hash(catalog) }, key = keyOf('catalog', [pin.revision_id, pin.digest]);
    const value = { pin, catalog: structuredClone(catalog) }, previous = this.#external.get(key);
    if (previous) assert(same(previous.value, value), 'fixture: immutable catalog rebound');
    else { this.#external.set(key, { value, version: 1, origin: null }); this.#count('catalog', value); }
    return structuredClone(pin);
  }
  setCatalog(pin) { assert(this.#external.has(keyOf('catalog', [pin.revision_id, pin.digest])), 'fixture: missing catalog'); this.#catalogPin = structuredClone(pin); this.#accessVersion++; }
  retainEvent(event, catalogPin = this.catalogPin) {
    validateNormalizedEvent(event); assert.equal(event.normalization.catalog_digest, catalogPin.digest, 'fixture: original catalog pin mismatch');
    assert(this.#external.has(keyOf('catalog', [catalogPin.revision_id, catalogPin.digest])), 'fixture: original catalog unavailable');
    const event_digest = hash(event), value = { event: structuredClone(event), event_digest, catalog_pin: structuredClone(catalogPin), source_ref: `accepted-${event_digest.slice(7)}` };
    const key = keyOf('accepted_event', [eventObservationKey(event)]), previous = this.#external.get(key);
    if (previous) assert(same(previous.value, value), 'fixture: immutable observation rebound');
    else { this.#external.set(key, { value, version: 1, origin: null }); this.#count('accepted_event', value); }
    return event_digest;
  }
  setPrincipal(principal_id) { this.#principal = principal_id; this.#accessVersion++; }
  setLifecycleAllowed(allowed) { this.#lifecycleAllowed = allowed; this.#accessVersion++; }
  #index(array, sequence, kind, key) { array.push({ sequence, position: array.length + 1, kind, key: structuredClone(key) }); }
  #indexMap(map, key, sequence, kind, rowKey) { let list = map.get(key); if (!list) { list = []; map.set(key, list); } this.#index(list, sequence, kind, rowKey); }
  /** Validate every precondition first, then apply only exact named rows; no cumulative graph copy. */
  commit(plan) {
    validateGraphEffectPlan2(plan); assert(same(plan.scope, this.#scope) && plan.generation_id === this.#generation, 'fixture: foreign plan');
    assert(same(plan.expected_graph, this.#head) && plan.expected_head_version === this.#headVersion, 'fixture: graph CAS mismatch');
    const sequence = this.#head === null ? 0 : this.#commits.get(this.#head.commit_digest).sequence + 1;
    assert.equal(plan.commit.sequence, sequence); assert.equal(plan.next_graph.commit_digest, plan.commit.commit_digest);
    assert(!this.#commits.has(plan.commit.commit_digest), 'fixture: duplicate commit');
    const prepared = [];
    for (const append of plan.append) {
      const key = keyOf(append.kind, append.key); assert(!this.#rows.has(key), 'fixture: immutable append conflict');
      prepared.push({ ...structuredClone(append), version: 1, origin: append.kind === 'manifest' ? null : structuredClone(plan.next_graph) });
    }
    for (const change of plan.cas) {
      assert(projectionKinds.has(change.kind), 'fixture: unknown projection kind');
      const previous = this.#rows.get(keyOf(change.kind, change.key))?.at(-1) ?? null;
      assert.equal(change.expected_version, previous?.version ?? null, 'fixture: projection CAS mismatch');
      assert.equal(change.expected_digest, previous ? hash(previous.value) : null, 'fixture: projection digest mismatch');
      prepared.push({ ...structuredClone(change), version: (previous?.version ?? 0) + 1 });
    }
    prepared.push({ kind: 'commit', key: [plan.commit.commit_digest], value: structuredClone(plan.commit), origin: null, version: 1 });
    for (const row of prepared) {
      const key = keyOf(row.kind, row.key), versions = this.#rows.get(key) ?? [];
      if (row.kind === 'entity' && versions.length === 0) this.#index(this.#headIndex, sequence, 'entity', row.key);
      if (row.kind === 'revision') this.#indexMap(this.#history, historyKey(row.value.entity_kind, row.value.entity_id), sequence, 'revision', row.key);
      if (row.kind === 'conflict') { this.#index(this.#conflicts, sequence, 'conflict', row.key); this.#indexMap(this.#entityConflicts, historyKey(row.value.entity_kind, row.value.entity_id), sequence, 'conflict', row.key); }
      versions.push({ sequence, version: row.version, value: row.value, origin: row.origin }); this.#rows.set(key, versions); this.#count(row.kind, row.value);
    }
    this.#commits.set(plan.commit.commit_digest, { sequence, address: structuredClone(plan.next_graph) });
    this.#head = structuredClone(plan.next_graph); this.#headVersion = (this.#headVersion ?? 0) + 1; this.#accessVersion++;
    this.#maxPlanBytes = Math.max(this.#maxPlanBytes, bytes(plan)); return this.head;
  }
  apply(plan) { return this.commit(plan); }
}
