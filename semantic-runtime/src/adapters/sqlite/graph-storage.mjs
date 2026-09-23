import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { fingerprint, canonical } from '../../core/contracts.mjs';
import { validateGraphCommitAddress2, validateGraphCommit2, validateGraphEffectPlan2,
  validateGraphPageCursor2 } from '../../core/incremental-graph.mjs';

export const WORKING_GRAPH_NAMESPACE = 'working-graph';
const NS = WORKING_GRAPH_NAMESPACE;
const FORMAT = Object.freeze({ schema_version: 1, kind: 'graph_store_format', semantic_wire_version: 1, commit_wire_version: 2, index_version: 1 });
const immutable = new Set(['manifest', 'revision', 'conflict', 'resolution', 'access_update']);
const projections = new Set(['entity', 'assertion_id', 'source_epoch', 'source_object', 'source_object_epoch', 'source_access']);
const absent = () => ({ version: null, value: null, origin: null });
const stable = value => JSON.stringify(canonical(value));
const same = (a, b) => stable(a) === stable(b);
const hash = value => `sha256:${fingerprint(value)}`;
const error = code => Object.assign(new Error(`Graph storage: ${code}`), { code });
const requireThat = (condition, code = 'graph_storage_corrupt') => { if (!condition) throw error(code); };
const uint = value => Number.isSafeInteger(value) && value >= 0;
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(value);
const padded = sequence => { requireThat(uint(sequence), 'graph_storage_invalid'); return String(sequence).padStart(16, '0'); };
const upper = prefix => `${prefix.slice(0, -1)}0`;
const address = commit => ({ schema_version: 2, kind: 'graph_commit', scope: commit.scope, generation_id: commit.generation_id, commit_digest: commit.commit_digest });
function copy(value) {
  // Internal inputs are inert JSON too: never evaluate accessors or Proxy traps.
  let count = 0;
  function visit(v, depth) {
    requireThat(++count <= 50_000 && depth <= 16 && !types.isProxy(v), 'graph_storage_invalid');
    if (v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v)) return v;
    requireThat(v && typeof v === 'object' && [Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(v)), 'graph_storage_invalid');
    requireThat(Object.getOwnPropertySymbols(v).length === 0, 'graph_storage_invalid');
    const descriptors = Object.getOwnPropertyDescriptors(v), array = Array.isArray(v), out = array ? [] : {};
    requireThat(!array || Object.getPrototypeOf(v) === Array.prototype && Object.keys(descriptors).length === v.length + 1, 'graph_storage_invalid');
    for (const [key, d] of Object.entries(descriptors)) {
      if (array && key === 'length') continue;
      requireThat('value' in d && d.enumerable && (!array || /^(0|[1-9]\d*)$/.test(key) && Number(key) < v.length), 'graph_storage_invalid');
      Object.defineProperty(out, key, { value: visit(d.value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  const out = visit(value, 0); requireThat(Buffer.byteLength(JSON.stringify(out)) <= 1_048_576, 'graph_storage_invalid'); return out;
}
function fields(value, keys) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','));
}
function validate(validator, value) { try { validator(value); } catch { throw error('graph_storage_corrupt'); } }
function keyValid(kind, key) {
  const lengths = { manifest: 1, commit: 1, revision: 1, entity: 2, assertion_id: 1, source_epoch: 1, source_object: 1, source_object_epoch: 2, source_access: 1, conflict: 1, resolution: 1, access_update: 1 };
  requireThat(Object.hasOwn(lengths, kind) && Array.isArray(key) && key.length === lengths[kind] && key.every(v => typeof v === 'string' && v.length > 0 && v.length <= 4096), 'graph_storage_invalid');
}

/** Project-scoped metadata; initialization is only an explicit outer owner write. */
export function checkGraphFormat(view, { initialize = false } = {}) {
  requireThat(typeof initialize === 'boolean', 'graph_storage_invalid');
  const row = view.getRecord(NS, 'format');
  if (row) { requireThat(row.version === 1 && same(row.value, FORMAT), 'unsupported_graph_format'); return row.value; }
  // Every owned source prefix is between ASCII 0 and z. Missing metadata in
  // a populated namespace is corruption, not a new store or implicit migration.
  requireThat(view.getSourceRange(NS, { lower: '0', upper: 'z', order: 'asc', limit: 1, after: null }).rows.length === 0);
  if (!initialize) return null;
  view.compareAndSwap(NS, 'format', null, FORMAT); return { ...FORMAT };
}

/** Finite storage port over a scoped DomainStore handle. The caller owns the transaction. */
export class GraphStorage {
  #view; #scope; #generation; #generationHash; #headKey;
  constructor({ view, scope, generation_id }) {
    const input = copy({ scope, generation_id });
    fields(input.scope, ['tenant_id', 'project_id']);
    requireThat(id(input.scope.tenant_id) && id(input.scope.project_id) && id(input.generation_id), 'graph_storage_invalid');
    this.#view = view; this.#scope = input.scope; this.#generation = input.generation_id;
    this.#generationHash = fingerprint(['graph_generation', this.#scope, this.#generation]); this.#headKey = `head/${this.#generationHash}`;
  }
  #bound(value) { requireThat(same(value.scope, this.#scope) && value.generation_id === this.#generation); }
  #base() { return { schema_version: 1, scope: this.#scope, generation_id: this.#generation }; }
  #commitId(sequence) { return `c/${this.#generationHash}/${padded(sequence)}`; }
  #recordId(kind, key) { return `r/${this.#generationHash}/${fingerprint([1, this.#scope, this.#generation, kind, key])}`; }
  #currentId(index, kind, key) { return `h/${index}/${fingerprint([kind, key])}`; }
  #temporalPrefix(index, kind, key) { return `v/${index}/${kind}/${fingerprint(key)}/`; }
  #pagePrefix(index, collection) { return `p/${index}/${fingerprint(collection)}/`; }
  #source(sourceId, kind) {
    const source = this.#view.getSource(NS, sourceId); if (!source) return null;
    requireThat(source.kind === kind); return source.value;
  }
  #append(sourceId, kind, value) { this.#view.appendSource(NS, sourceId, kind, value); }
  head() {
    const format = checkGraphFormat(this.#view), row = this.#view.getRecord(NS, this.#headKey);
    if (!row) return null;
    requireThat(format !== null && uint(row.version) && row.version > 0);
    const h = row.value;
    fields(h, ['schema_version', 'kind', 'scope', 'generation_id', 'head', 'sequence', 'active_index', 'maintenance']);
    this.#bound(h); validate(validateGraphCommitAddress2, h.head); this.#bound(h.head);
    requireThat(h.schema_version === 1 && h.kind === 'graph_head' && uint(h.sequence) && hex(h.active_index));
    if (h.maintenance !== null) {
      fields(h.maintenance, ['build_id', 'index', 'pinned_head', 'next_sequence', 'previous_commit']);
      const m = h.maintenance;
      requireThat(id(m.build_id) && hex(m.index) && uint(m.next_sequence) && m.next_sequence <= h.sequence + 1 && same(m.pinned_head, h.head));
      if (m.previous_commit !== null) { validate(validateGraphCommitAddress2, m.previous_commit); this.#bound(m.previous_commit); }
      requireThat((m.next_sequence === 0) === (m.previous_commit === null));
    }
    return row;
  }
  #canonical(sequence) {
    const commit = this.#source(this.#commitId(sequence), 'graph-commit'); requireThat(commit !== null);
    validate(validateGraphCommit2, commit); this.#bound(commit); requireThat(commit.sequence === sequence); return commit;
  }
  #member(at, head) {
    validate(validateGraphCommitAddress2, at); this.#bound(at); requireThat(head !== null);
    const membership = this.#source(`a/${head.value.active_index}/${at.commit_digest.slice(7)}`, 'graph-membership'); requireThat(membership !== null);
    fields(membership, ['schema_version', 'scope', 'generation_id', 'sequence', 'address']); this.#bound(membership);
    requireThat(membership.schema_version === 1 && uint(membership.sequence) && membership.sequence <= head.value.sequence && same(membership.address, at));
    const commit = this.#canonical(membership.sequence); requireThat(same(address(commit), at));
    if (membership.sequence === head.value.sequence) requireThat(same(at, head.value.head));
    return commit;
  }
  #rawRecord(kind, key) {
    const row = this.#source(this.#recordId(kind, key), 'graph-record'); if (!row) return null;
    fields(row, ['schema_version', 'scope', 'generation_id', 'record_kind', 'key', 'version', 'origin', 'sequence', 'value']); this.#bound(row);
    requireThat(row.schema_version === 1 && row.record_kind === kind && same(row.key, key) && row.version === 1 && uint(row.sequence));
    return row;
  }
  #recordProof(row, commit) {
    requireThat(row.sequence === commit.sequence && (row.record_kind === 'manifest' ? row.origin === null && commit.sequence === 0 : same(row.origin, address(commit))));
    const pin = commit.records.find(r => r.kind === row.record_kind && same(r.key, row.key)); requireThat(pin && pin.digest === hash(row.value));
  }
  #current(index, kind, key) {
    const row = this.#view.getRecord(NS, this.#currentId(index, kind, key)); if (!row) return null;
    this.#projectionEnvelope(row.value, kind, key);
    requireThat(row.version === row.value.version); return row;
  }
  #projectionEnvelope(row, kind, key) {
    fields(row, ['schema_version', 'scope', 'generation_id', 'record_kind', 'key', 'version', 'first_sequence', 'sequence', 'origin', 'value']); this.#bound(row);
    requireThat(row.schema_version === 1 && row.record_kind === kind && same(row.key, key) && uint(row.version) && row.version > 0
      && uint(row.first_sequence) && row.first_sequence > 0 && uint(row.sequence) && row.sequence >= row.first_sequence);
    validate(validateGraphCommitAddress2, row.origin); this.#bound(row.origin);
  }
  #projectionProof(row, commit) {
    requireThat(row.sequence === commit.sequence && same(row.origin, address(commit)));
    const pin = commit.projections.find(p => p.kind === row.record_kind && same(p.key, row.key)); requireThat(pin && same(pin.value, row.value)); return pin;
  }
  fact(input) {
    const { at, kind, key } = copy(input); keyValid(kind, key);
    if (immutable.has(kind) || kind === 'commit') requireThat(/^sha256:[a-f0-9]{64}$/.test(key[0]), 'graph_storage_invalid');
    const head = this.head();
    if (at === null) { requireThat(head === null, 'graph_storage_invalid'); return absent(); }
    const selected = this.#member(at, head);
    if (kind === 'commit') {
      const entry = this.#source(`a/${head.value.active_index}/${key[0].replace(/^sha256:/, '')}`, 'graph-membership');
      if (!entry) return absent();
      const commit = this.#member(entry.address, head); requireThat(commit.commit_digest === key[0]);
      return commit.sequence > selected.sequence ? absent() : { version: 1, value: commit, origin: null };
    }
    if (immutable.has(kind)) {
      const row = this.#rawRecord(kind, key); if (!row || row.sequence > selected.sequence) return absent();
      const origin = row.origin ?? at;
      const commit = kind === 'manifest' ? this.#canonical(0) : this.#member(origin, head);
      this.#recordProof(row, commit);
      requireThat(commit.manifest_digest === selected.manifest_digest); return { version: 1, value: row.value, origin: row.origin };
    }
    const current = this.#current(head.value.active_index, kind, key), prefix = this.#temporalPrefix(head.value.active_index, kind, key);
    if (!current) {
      const probe = this.#view.getSourceRange(NS, { lower: prefix, upper: upper(prefix), order: 'desc', limit: 1, after: null });
      requireThat(probe.rows.length === 0); return absent();
    }
    requireThat(current.value.sequence <= head.value.sequence);
    this.#projectionProof(current.value, this.#member(current.value.origin, head));
    const cutoff = selected.sequence === Number.MAX_SAFE_INTEGER ? upper(prefix) : `${prefix}${padded(selected.sequence + 1)}`;
    const page = this.#view.getSourceRange(NS, { lower: prefix, upper: cutoff, order: 'desc', limit: 1, after: null });
    const indexed = source => {
      requireThat(source.kind === 'graph-projection'); const value = source.value; this.#projectionEnvelope(value, kind, key);
      requireThat(source.id === `${prefix}${padded(value.sequence)}` && value.first_sequence === current.value.first_sequence
        && value.sequence <= current.value.sequence && value.version <= current.value.version);
      return value;
    };
    if (!page.rows.length) {
      requireThat(selected.sequence < current.value.first_sequence);
      const first = this.#view.getSourceRange(NS, { lower: prefix, upper: upper(prefix), order: 'asc', limit: 1, after: null });
      requireThat(first.rows.length === 1); const row = indexed(first.rows[0]);
      requireThat(row.version === 1 && row.sequence === current.value.first_sequence);
      this.#projectionProof(row, this.#member(row.origin, head)); return absent();
    }
    const row = indexed(page.rows[0]); requireThat(row.sequence <= selected.sequence);
    this.#projectionProof(row, this.#member(row.origin, head));
    if (current.value.sequence <= selected.sequence) requireThat(same(row, current.value));
    // The immediate successor proves that a missing middle temporal entry did
    // not turn an older committed value into a false exact-as-of answer.
    const successor = this.#view.getSourceRange(NS, { lower: prefix, upper: upper(prefix), order: 'asc', limit: 1, after: page.rows[0].id });
    if (successor.rows.length) {
      const next = indexed(successor.rows[0]); requireThat(next.sequence > selected.sequence && next.version === row.version + 1);
      const pin = this.#projectionProof(next, this.#member(next.origin, head)); requireThat(pin.previous_digest === hash(row.value));
    } else requireThat(same(row, current.value));
    return { version: row.version, value: row.value, origin: row.origin };
  }
  page(input) {
    const { at, collection, after, limit } = copy(input);
    validate(validateGraphPageCursor2, { ...at, kind: 'graph_page_cursor', collection, position: after ?? 0 });
    requireThat((after === null || uint(after)) && Number.isInteger(limit) && limit >= 1 && limit <= 64, 'graph_storage_invalid');
    const head = this.head(), selected = this.#member(at, head);
    requireThat(after === null || after <= selected.sequence, 'graph_storage_invalid');
    const prefix = this.#pagePrefix(head.value.active_index, collection), cutoff = selected.sequence === Number.MAX_SAFE_INTEGER ? upper(prefix) : `${prefix}${padded(selected.sequence + 1)}`;
    const found = this.#view.getSourceRange(NS, { lower: prefix, upper: cutoff, order: 'asc', limit, after: after === null ? null : `${prefix}${padded(after)}` });
    const rows = found.rows.map(source => {
      const row = source.value; requireThat(source.kind === 'graph-page');
      fields(row, ['schema_version', 'scope', 'generation_id', 'collection', 'position', 'kind', 'key', 'origin']); this.#bound(row);
      requireThat(row.schema_version === 1 && same(row.collection, collection) && uint(row.position) && row.position <= selected.sequence && source.id === `${prefix}${padded(row.position)}`);
      const commit = this.#member(row.origin, head); requireThat(commit.sequence === row.position);
      const choices = this.#pageRows(commit); requireThat(choices.some(candidate => same(candidate.collection, collection) && candidate.kind === row.kind && same(candidate.key, row.key)));
      return { position: row.position, kind: row.kind, key: row.key };
    });
    return { rows, next_position: rows.length === limit ? rows.at(-1).position : null };
  }
  #pageRows(commit) {
    const rows = [];
    for (const p of commit.projections) if (p.kind === 'entity' && p.previous_digest === null) rows.push({ collection: { kind: 'heads' }, kind: 'entity', key: p.key });
    for (const r of commit.records) {
      if (r.kind !== 'revision' && r.kind !== 'conflict') continue;
      const row = this.#rawRecord(r.kind, r.key); requireThat(row !== null); this.#recordProof(row, commit);
      const entity = { entity_kind: row.value.entity_kind, entity_id: row.value.entity_id };
      if (r.kind === 'revision') rows.push({ collection: { kind: 'history', ...entity }, kind: 'revision', key: r.key });
      else rows.push({ collection: { kind: 'conflicts', entity: null }, kind: 'conflict', key: r.key }, { collection: { kind: 'conflicts', entity }, kind: 'conflict', key: r.key });
    }
    return rows;
  }
  #indexCommit(index, commit) {
    const origin = address(commit);
    for (const p of commit.projections) {
      const current = this.#current(index, p.kind, p.key);
      requireThat((current ? hash(current.value.value) : null) === p.previous_digest, 'graph_storage_conflict');
      const row = { ...this.#base(), record_kind: p.kind, key: p.key, version: (current?.value.version ?? 0) + 1,
        first_sequence: current?.value.first_sequence ?? commit.sequence, sequence: commit.sequence, origin, value: p.value };
      this.#view.compareAndSwap(NS, this.#currentId(index, p.kind, p.key), current?.version ?? null, row);
      this.#append(`${this.#temporalPrefix(index, p.kind, p.key)}${padded(commit.sequence)}`, 'graph-projection', row);
    }
    for (const row of this.#pageRows(commit)) this.#append(`${this.#pagePrefix(index, row.collection)}${padded(commit.sequence)}`, 'graph-page', { ...this.#base(), ...row, position: commit.sequence, origin });
    this.#append(`a/${index}/${commit.commit_digest.slice(7)}`, 'graph-membership', { ...this.#base(), sequence: commit.sequence, address: origin });
  }
  applyPlan(input) {
    const plan = copy(input); validate(validateGraphEffectPlan2, plan); this.#bound(plan);
    const head = this.head(); requireThat(!head?.value.maintenance, 'graph_maintenance');
    requireThat(same(plan.expected_graph, head?.value.head ?? null) && plan.expected_head_version === (head?.version ?? null), 'graph_storage_conflict');
    requireThat(plan.commit.sequence === (head ? head.value.sequence + 1 : 0), 'graph_storage_conflict');
    if (head) requireThat(plan.commit.manifest_digest === this.#member(head.value.head, head).manifest_digest);
    const index = head?.value.active_index ?? fingerprint([this.#generationHash, 'initial']);
    for (const p of plan.cas) {
      const row = this.#current(index, p.kind, p.key);
      requireThat((row?.value.version ?? null) === p.expected_version && (row ? hash(row.value.value) : null) === p.expected_digest, 'graph_storage_conflict');
    }
    checkGraphFormat(this.#view, { initialize: true });
    for (const r of plan.append) this.#append(this.#recordId(r.kind, r.key), 'graph-record', { ...this.#base(), record_kind: r.kind, key: r.key,
      version: 1, origin: r.kind === 'manifest' ? null : plan.next_graph, sequence: plan.commit.sequence, value: r.value });
    this.#append(this.#commitId(plan.commit.sequence), 'graph-commit', plan.commit);
    this.#indexCommit(index, plan.commit);
    this.#view.compareAndSwap(NS, this.#headKey, head?.version ?? null, { ...this.#base(), kind: 'graph_head', head: plan.next_graph, sequence: plan.commit.sequence, active_index: index, maintenance: null });
    return plan.next_graph;
  }
  #cursor(build, expected, next) { return { ...this.#base(), kind: 'graph_rebuild_cursor', build_id: build, expected_graph: expected, next_sequence: next }; }
  #receipt(receipt, request, head, build) {
    requireThat(receipt !== null); fields(receipt, ['schema_version', 'scope', 'generation_id', 'request', 'result']); this.#bound(receipt);
    requireThat(receipt.schema_version === 1 && same(receipt.request, request), 'graph_storage_conflict');
    const result = receipt.result; fields(result, ['status', 'cursor', 'processed', 'total', 'head', 'index']);
    requireThat(['building', 'complete'].includes(result.status) && uint(result.processed) && result.total === head.value.sequence + 1
      && result.processed <= result.total && same(result.head, request.expected_graph) && hex(result.index));
    if (result.status === 'complete') requireThat(result.processed === result.total && result.cursor === null);
    else requireThat(result.processed < result.total && same(result.cursor, this.#cursor(build, request.expected_graph, result.processed)));
    if (request.cursor === null) requireThat(result.processed === 0 && result.status === 'building');
    else requireThat(result.processed > request.cursor.next_sequence && result.processed <= request.cursor.next_sequence + request.limit);
    return { ...result, status: 'duplicate' };
  }
  #rebuildResult(head, maintenance, complete = false) {
    return { status: complete ? 'complete' : 'building', cursor: complete ? null : this.#cursor(maintenance.build_id, maintenance.pinned_head, maintenance.next_sequence),
      processed: maintenance.next_sequence, total: head.value.sequence + 1, head: maintenance.pinned_head, index: maintenance.index };
  }
  rebuildStep(input) {
    const request = copy(input); fields(request, ['expected_graph', 'cursor', 'limit']);
    const { expected_graph, cursor, limit } = request; validate(validateGraphCommitAddress2, expected_graph); this.#bound(expected_graph);
    requireThat(Number.isInteger(limit) && limit >= 1 && limit <= 64, 'graph_storage_invalid');
    const head = this.head(); requireThat(head !== null && same(head.value.head, expected_graph), 'graph_storage_conflict');
    // Repair admission is anchored in canonical storage, never the derived index being repaired.
    requireThat(same(address(this.#canonical(head.value.sequence)), expected_graph));
    if (cursor === null) {
      if (head.value.maintenance) {
        const receipt = this.#source(`b/${head.value.maintenance.build_id}/start`, 'graph-rebuild-step');
        return this.#receipt(receipt, request, head, head.value.maintenance.build_id);
      }
      const build = randomUUID(), maintenance = { build_id: build, index: fingerprint([this.#generationHash, build]), pinned_head: expected_graph, next_sequence: 0, previous_commit: null };
      const result = this.#rebuildResult(head, maintenance);
      this.#view.compareAndSwap(NS, this.#headKey, head.version, { ...head.value, maintenance });
      this.#append(`b/${build}/start`, 'graph-rebuild-step', { ...this.#base(), request, result }); return result;
    }
    fields(cursor, ['schema_version', 'scope', 'generation_id', 'kind', 'build_id', 'expected_graph', 'next_sequence']); this.#bound(cursor);
    requireThat(cursor.schema_version === 1 && cursor.kind === 'graph_rebuild_cursor' && id(cursor.build_id) && uint(cursor.next_sequence) && same(cursor.expected_graph, expected_graph), 'graph_storage_invalid');
    const receiptId = `b/${cursor.build_id}/${padded(cursor.next_sequence)}`, existing = this.#source(receiptId, 'graph-rebuild-step');
    if (existing) return this.#receipt(existing, request, head, cursor.build_id);
    const maintenance = head.value.maintenance;
    requireThat(maintenance !== null && cursor.build_id === maintenance.build_id && cursor.next_sequence === maintenance.next_sequence && same(expected_graph, maintenance.pinned_head), 'graph_storage_conflict');
    const prefix = `c/${this.#generationHash}/`, batch = this.#view.getSourceRange(NS, { lower: `${prefix}${padded(maintenance.next_sequence)}`, upper: upper(prefix), order: 'asc', limit, after: null });
    requireThat(batch.rows.length > 0);
    let sequence = maintenance.next_sequence, previous = maintenance.previous_commit;
    for (const row of batch.rows) {
      requireThat(row.kind === 'graph-commit' && row.id === this.#commitId(sequence) && sequence <= head.value.sequence);
      const commit = row.value; validate(validateGraphCommit2, commit); this.#bound(commit);
      requireThat(commit.sequence === sequence && same(commit.previous_commit, previous));
      for (const pin of commit.records) { const record = this.#rawRecord(pin.kind, pin.key); requireThat(record !== null); this.#recordProof(record, commit); }
      this.#indexCommit(maintenance.index, commit); previous = address(commit); sequence++;
    }
    const next = { ...maintenance, next_sequence: sequence, previous_commit: previous }, complete = sequence === head.value.sequence + 1;
    if (complete) requireThat(same(previous, expected_graph));
    const result = this.#rebuildResult(head, next, complete);
    this.#view.compareAndSwap(NS, this.#headKey, head.version, { ...head.value, active_index: complete ? next.index : head.value.active_index, maintenance: complete ? null : next });
    this.#append(receiptId, 'graph-rebuild-step', { ...this.#base(), request, result }); return result;
  }
}
