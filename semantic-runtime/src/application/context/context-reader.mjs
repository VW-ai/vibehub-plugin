import { GraphInputs, graphInput, graphFields, graphId, graphEqual, graphHash, graphKey, graphErrorCode, graphFail } from '../../local/graph-inputs.mjs';
import { GraphStorage } from '../../adapters/sqlite/graph-storage.mjs';
import { selectGraph } from '../graph/graph-selected.mjs';
import { ExplorationInputs, readExplorationOwner, EXPLORATION_NAMESPACE } from '../../local/exploration-inputs.mjs';
import { verifyExplorationPublication } from '../../local/exploration-adoption.mjs';
import { resolveIncrementalGraph, pageIncrementalGraph, validateGraphCommitAddress2 } from '../../core/incremental-graph.mjs';
import { exactRevisionAddress, semanticAddress, validateSemanticAddress } from '../../core/working-graph.mjs';
import { validateContextContent1, validateContextOperation1 } from '../../core/context-profile.mjs';

export const CONTEXT_READER_ERROR_CODES = Object.freeze(['context_invalid_request', 'context_cursor_mismatch',
  'context_graph_changed', 'context_capacity', 'context_unavailable', 'context_corrupt']);
const check = (ok, code = 'context_invalid_request') => { if (!ok) throw graphFail(code); };
const scopeOf = grant => ({ tenant_id: grant.tenant_id, project_id: grant.project_id });
const digest = value => check(typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value));
const shape = (value, required) => { try { graphFields(value, required); } catch { throw graphFail('context_invalid_request'); } };

/** Materialize the shared Context layers after their exact canonical proofs have been asserted. */
export function materializeContextShared(canonical, origin, project, version) {
  const origin_base = canonical.material(origin);
  const current_project = { ...canonical.material(project), version };
  const governing = [];
  for (const [layer, material] of Object.entries({ origin_base, current_project })) {
    for (const entry of material.data?.records ?? []) {
      if (entry.status !== 'usable' || entry.kind !== 'context' || entry.record?.type !== 'authority' || entry.record.state !== 'active') continue;
      const artifact = material.canonical_refs[entry.canonical_ref_index];
      check(artifact, 'canonical_record_corrupt');
      governing.push({ layer, pin: material.pin, status: material.status, record: entry.record, artifact });
    }
  }
  return { origin_base, current_project, governing, coverage: current_project.coverage };
}

function collection(value) {
  check(value && ['heads', 'history', 'conflicts'].includes(value.kind));
  shape(value, value.kind === 'heads' ? ['kind'] : value.kind === 'history' ? ['kind', 'entity_kind', 'entity_id'] : ['kind', 'entity']);
  if (value.kind === 'heads') return;
  const entity = value.kind === 'history' ? value : value.entity;
  if (value.kind === 'conflicts') shape(entity, ['entity_kind', 'entity_id']);
  check(entity.entity_kind === 'entity'); graphId(entity.entity_id);
}

/** Strict public read wire. A cursor is only a locator, never an authorization proof. */
export function validateContextReadRequest(options, kind) {
  try {
    check(['resolve', 'page', 'lineage'].includes(kind));
    const value = graphInput(options);
    shape(value, ['exploration_id', 'at', 'mode', ...(kind === 'page' ? ['collection'] : ['address']),
      ...(kind === 'resolve' ? [] : ['cursor', 'limit'])]);
    graphId(value.exploration_id); validateGraphCommitAddress2(value.at);
    check(['current', 'as_of'].includes(value.mode));
    if (kind === 'page') collection(value.collection);
    else {
      validateSemanticAddress(value.address);
      check(value.address.entity_kind === 'entity' && value.address.generation_id === value.at.generation_id
        && graphEqual(value.address.scope, value.at.scope));
    }
    if (kind !== 'resolve') {
      check(Number.isSafeInteger(value.limit) && value.limit >= 1 && value.limit <= 16);
      if (value.cursor !== null) {
        const c = value.cursor;
        shape(c, ['schema_version', 'kind', 'scope', 'config_digest', 'exploration_id', 'at', 'mode',
          kind === 'page' ? 'collection' : 'root', 'position', 'read_pins']);
        check(c.schema_version === 1 && c.kind === `context_${kind}_cursor`, 'context_cursor_mismatch');
        digest(c.config_digest); graphId(c.exploration_id); validateGraphCommitAddress2(c.at);
        check(Number.isSafeInteger(c.position) && c.position >= 0, 'context_cursor_mismatch');
        if (kind === 'page') collection(c.collection); else validateSemanticAddress(c.root);
      }
    }
    return value;
  } catch (error) {
    if (CONTEXT_READER_ERROR_CODES.includes(graphErrorCode(error))) throw error;
    throw graphFail(graphErrorCode(error) === 'graph_capacity' ? 'context_capacity' : 'context_invalid_request');
  }
}

function supported(revision) {
  const content = revision.assertion.content;
  if (revision.entity_kind !== 'entity' || content.semantic_type !== 'context'
    || content.data?.kind !== 'runtime_context' || content.data.schema_version !== 1) return false;
  validateContextContent1(content); return true;
}

function publicationItem(proof) {
  const o = proof.origin;
  return { operation_origin_ref: proof.ref, operation: o.operation, exploration_id: o.exploration_id,
    generation_id: o.generation_id, actor: o.actor, actor_kind: o.actor_kind, execution_workspace_id: o.execution_workspace_id,
    publisher_ref: o.publisher_ref, publisher_execution_id: o.publisher_execution_id, epoch: o.epoch };
}

// Generic exploration writes may carry Context-shaped content without using
// the typed facade. An adoption must not turn an invalid original transition
// into a typed fact. Follow only its immutable publication sources, never the
// source exploration's current head or a general semantic neighborhood.
function verifyTypedPublication(view, storage, at, revision, proof, config) {
  const seen = new Set();
  for (let depth = 0; depth < 32; depth++) {
    const key = graphHash(exactRevisionAddress(revision));
    check(!seen.has(key), 'context_corrupt'); seen.add(key);
    const meaning = validateContextContent1(revision.assertion.content).data;
    if (proof.origin.operation !== 'adopt') {
      if (['create', 'derive', 'branch'].includes(meaning.change.kind)) {
        check(storage.fact({ at: proof.origin.previous_graph, kind: 'entity', key: ['entity', revision.entity_id] }).value === null,
          'context_transition_invalid');
      }
      const parent = meaning.change.kind === 'branch'
        ? storage.fact({ at, kind: 'revision', key: [revision.assertion.parents[0]?.revision_digest] }).value : null;
      validateContextOperation1(proof.operation, parent === null ? {} : { branch_parent: parent });
      return;
    }
    check(depth < 31, 'context_capacity');
    const source = proof.origin.adoption?.source;
    check(source && source.address?.kind === 'semantic_revision' && source.address.entity_kind === 'entity'
      && graphEqual(source.at.scope, revision.scope) && graphEqual(source.address.scope, revision.scope)
      && source.at.generation_id === source.address.generation_id, 'context_corrupt');
    const owner = readExplorationOwner(view, { scope: revision.scope, generation_id: source.at.generation_id });
    check(owner?.exploration_id === source.exploration_id && owner.config_digest === config, 'context_corrupt');
    storage = new GraphStorage({ view, scope: revision.scope, generation_id: source.at.generation_id });
    const adopted = storage.fact({ at: source.at, kind: 'revision', key: [source.address.revision_digest] }).value;
    check(adopted && graphEqual(exactRevisionAddress(adopted), source.address)
      && graphEqual(adopted.assertion.content, revision.assertion.content), 'context_corrupt');
    const published = verifyExplorationPublication(view, storage, source.at, adopted, source.exploration_id, config);
    check(published.ref === source.operation_origin_ref, 'context_corrupt');
    at = source.at; revision = adopted; proof = published;
  }
  throw graphFail('context_capacity');
}

/** Fixed selected reader; only the Graph owner supplies its real snapshot and services. */
function selectedContext({ view, context, inputs, explorations, config_digest, request, kind, read_pins }, planning) {
  check(inputs instanceof GraphInputs && explorations instanceof ExplorationInputs);
  const r = validateContextReadRequest(request, kind), pins = graphInput(read_pins);
  shape(pins, ['project_selection', 'source_fence']); digest(config_digest);
  const grant = inputs.grant(context, 'context:read'), scope = scopeOf(grant);
  check(graphEqual(scope, r.at.scope));
  const owned = explorations.getExploration(view, context, { exploration_id: r.exploration_id });
  check(owned && owned.generation_id === r.at.generation_id, 'context_unavailable');
  const stores = new Map(), heads = new Map(), revisions = new Map(), ticketRefs = new Map(), ticketPins = new Set(), cache = new Map();
  const storage = generation => {
    if (!stores.has(generation)) {
      const selected = new GraphStorage({ view, scope, generation_id: generation }), head = selected.head();
      check(head && head.value.maintenance === null, head ? 'graph_maintenance' : 'context_unavailable');
      stores.set(generation, selected); heads.set(generation, head.value.head);
    }
    return stores.get(generation);
  };
  const localStorage = storage(r.at.generation_id);
  check(r.mode !== 'current' || graphEqual(r.at, heads.get(r.at.generation_id)), 'context_graph_changed');
  check(localStorage.fact({ at: r.at, kind: 'commit', key: [r.at.commit_digest] }).value, 'context_unavailable');

  // Preparation reads immutable candidates only. It never certifies access or
  // returns a public response; the final pass alone invokes semantic readers.
  const raw = (s, at, address) => {
    const entity = s.fact({ at, kind: 'entity', key: [address.entity_kind, address.entity_id] }).value;
    const ref = address.kind === 'semantic_revision' ? address : entity?.head;
    const revision = ref ? s.fact({ at, kind: 'revision', key: [ref.revision_digest] }).value : null;
    if (!revision) return { status: 'unavailable', revision: null };
    check(entity, 'context_corrupt');
    const head = s.fact({ at, kind: 'revision', key: [entity.head.revision_digest] }).value;
    check(head, 'context_corrupt');
    const conflicts = entity.open_conflicts.map(id => {
      const fact = s.fact({ at, kind: 'conflict', key: [id] }).value; check(fact, 'context_corrupt'); return fact;
    });
    return { status: 'resolved', revision, entity: { ...entity,
      status: entity.competing.length ? 'contested' : head.assertion.status, quarantined: false }, conflicts, graph_revision: at };
  };

  const inspect = (at, address, explorationId = r.exploration_id, resolved = null) => {
    const key = graphHash([at, address]); if (cache.has(key)) return cache.get(key);
    const s = storage(at.generation_id), owner = readExplorationOwner(view, { scope, generation_id: at.generation_id });
    check(owner?.exploration_id === explorationId && owner.config_digest === config_digest, 'context_corrupt');
    check(explorations.getExploration(view, context, { exploration_id: explorationId })?.generation_id === at.generation_id, 'context_corrupt');
    let result = resolved;
    if (!result) {
      if (planning) result = raw(s, at, address);
      else {
        const { port } = selectGraph({ inputs, context, tx: view, storage: s, generation_id: at.generation_id });
        try { result = resolveIncrementalGraph(port, { at, address }); }
        catch (error) { if (graphErrorCode(error) === 'graph_access_denied') result = { status: 'denied', revision: null }; else throw error; }
      }
    }
    if (result.status !== 'resolved') {
      const absent = { status: result.status === 'denied' ? 'denied' : 'not_found', item: null };
      cache.set(key, absent); return absent;
    }
    const revision = result.revision;
    if (!supported(revision)) { const absent = { status: 'unsupported', item: null }; cache.set(key, absent); return absent; }
    const proof = verifyExplorationPublication(view, s, at, revision, explorationId, config_digest);
    const ref = exactRevisionAddress(revision), meaning = revision.assertion.content.data;
    if (!planning) verifyTypedPublication(view, s, at, revision, proof, config_digest);
    const item = { ref, assertion_status: revision.assertion.status,
      projection: { head: result.entity.head, status: result.entity.status, competing: result.entity.competing, quarantined: result.entity.quarantined },
      historical_role: graphEqual(ref, result.entity.head) ? 'head'
        : result.entity.competing.some(other => graphEqual(ref, other)) ? 'competing' : 'historical',
      meaning, sources: {
        events: revision.provenance.events.map(event => ({ event_id: event.event_id, event_digest: graphHash(event),
          source_objects: event.provenance.source_objects.map(source => source.object) })),
        canonical: revision.assertion.canonical_refs.map(source => ({ event_id: source.event.event_id,
          event_digest: graphHash(source.event), payload: source.event.payload })) },
      publication: publicationItem(proof), transition: proof.origin.operation === 'adopt'
        ? { kind: 'adopt', structural_reason: 'explicit_adoption', reason: { status: 'not_recorded', text: null } }
        : { kind: meaning.change.kind, reason: { status: 'recorded', text: meaning.change.reason } } };
    revisions.set(graphHash(ref), revision);
    for (const ticket of meaning.applicability.tickets.refs) {
      ticketRefs.set(graphHash(ticket), ticket); ticketPins.add(graphHash([ticket.at, ticket.address]));
    }
    check(ticketPins.size <= 8, 'context_capacity');
    const selected = { status: 'resolved', item, revision, proof, resolved: result };
    cache.set(key, selected); return selected;
  };
  const cursor = (position, selector) => ({ schema_version: 1, kind: `context_${kind}_cursor`, scope,
    config_digest, exploration_id: r.exploration_id, at: r.at, mode: r.mode, ...selector, position, read_pins: pins });
  const continuation = selector => {
    if (r.cursor === null || r.cursor === undefined) return null;
    const { position } = r.cursor;
    check(graphEqual(r.cursor, cursor(position, selector)), 'context_cursor_mismatch'); return position;
  };
  let local;
  if (kind === 'resolve') {
    const selected = inspect(r.at, r.address); local = { status: selected.status, item: selected.item };
  } else if (kind === 'page') {
    const position = continuation({ collection: r.collection });
    let page;
    if (planning) {
      const candidates = localStorage.page({ at: r.at, collection: r.collection, after: position, limit: r.limit });
      const items = [];
      for (const row of candidates.rows) {
        if (row.kind === 'conflict') {
          const fact = localStorage.fact({ at: r.at, kind: 'conflict', key: row.key }).value;
          check(fact, 'context_corrupt');
          if (localStorage.fact({ at: r.at, kind: 'resolution', key: row.key }).value === null) items.push({ conflict: fact });
        } else {
          const ref = row.kind === 'entity' ? semanticAddress({ scope, generation_id: r.at.generation_id,
            entity_kind: row.key[0], entity_id: row.key[1] })
            : exactRevisionAddress(localStorage.fact({ at: r.at, kind: 'revision', key: row.key }).value);
          const item = raw(localStorage, r.at, ref); if (item.revision) items.push(item);
        }
      }
      page = { items, next_cursor: candidates.next_position === null ? null : { position: candidates.next_position } };
    } else {
      const { port } = selectGraph({ inputs, context, tx: view, storage: localStorage, generation_id: r.at.generation_id });
      page = pageIncrementalGraph(port, { at: r.at, collection: r.collection, limit: r.limit,
        cursor: position === null ? null : { schema_version: 2, kind: 'graph_page_cursor', scope,
          generation_id: r.at.generation_id, commit_digest: r.at.commit_digest, collection: r.collection, position } });
    }
    const items = [];
    for (const row of page.items) {
      const selected = row.conflict
        ? inspect(r.at, semanticAddress({ scope, generation_id: r.at.generation_id, ...r.collection.entity }))
        : inspect(r.at, exactRevisionAddress(row.revision), r.exploration_id, row);
      if (selected.item) items.push({ ...selected.item, ...(row.conflict ? { conflict: row.conflict } : {}) });
    }
    local = { items, next_cursor: page.next_cursor === null ? null : cursor(page.next_cursor.position, { collection: r.collection }) };
  } else {
    const root = inspect(r.at, r.address);
    if (!root.item) local = { status: root.status, root: null, links: [], next_cursor: null };
    else {
      const selector = { root: root.item.ref }, position = continuation(selector) ?? 0, links = [];
      const add = link => { check(links.length < 128, 'context_capacity'); links.push(link); };
      const assertion = root.revision.assertion;
      if (assertion.base_revision) add({ role: 'base', ref: assertion.base_revision });
      for (const parent of assertion.parents) add({ role: 'parent', ref: parent });
      const adoption = root.proof.origin.adoption;
      if (root.proof.origin.operation === 'adopt') {
        check(adoption?.source, 'context_corrupt');
        add({ role: 'adoption_source', ref: adoption.source.address, source: adoption.source });
      }
      add({ role: 'publication', ref: { operation_origin_ref: root.proof.ref }, fact: root.item.publication });
      for (const conflict of root.resolved.conflicts) add({ role: 'conflict', ref: { conflict_digest: conflict.conflict_digest }, fact: conflict });
      if (assertion.content.data.change.kind === 'resolve' && root.proof.origin.operation !== 'adopt') {
        const origin = root.proof.origin;
        const operation = view.getSource(EXPLORATION_NAMESPACE, graphKey('operation', [scope, origin.actor, origin.idempotency_key]));
        const conflictDigest = operation?.value.request.operation.conflict_digest;
        check(typeof conflictDigest === 'string', 'context_corrupt');
        const conflict = localStorage.fact({ at: r.at, kind: 'conflict', key: [conflictDigest] }).value;
        const resolution = localStorage.fact({ at: r.at, kind: 'resolution', key: [conflictDigest] }).value;
        check(conflict && resolution && graphEqual(resolution.resolution, root.item.ref), 'context_corrupt');
        add({ role: 'resolution', ref: { conflict_digest: conflictDigest }, fact: { conflict, resolution } });
      }
      for (const event of root.revision.provenance.access_events) {
        const event_digest = graphHash(event), fact = localStorage.fact({ at: r.at, kind: 'access_update', key: [event_digest] }).value;
        check(fact && graphEqual(fact.event, event), 'context_corrupt');
        add({ role: 'source_lifecycle', ref: { event_digest }, fact: { event_digest, access_state: fact.access_state } });
      }
      check(position <= links.length, 'context_cursor_mismatch');
      const selected = links.slice(position, position + r.limit).map(link => {
        if (link.fact) return { ...link, availability: 'available' };
        const target = inspect(link.source?.at ?? r.at, link.ref, link.source?.exploration_id ?? r.exploration_id);
        if (!target.item) return { role: link.role, ref: link.ref, availability: 'unavailable' };
        if (link.source) check(target.proof.ref === link.source.operation_origin_ref, 'context_corrupt');
        return { role: link.role, ref: link.ref, availability: 'available', item: target.item,
          ...(link.source ? { source: link.source } : {}) };
      });
      local = { status: 'resolved', root: root.item, links: selected,
        next_cursor: position + selected.length < links.length ? cursor(position + selected.length, selector) : null };
    }
  }
  // Public result material gets one aggregate bound. Internal proof inputs remain separate.
  try { graphInput(local); } catch (error) { throw graphFail(graphErrorCode(error) === 'graph_capacity' ? 'context_capacity' : 'context_corrupt'); }
  inputs.grant(context, 'context:read');
  for (const [generation, s] of stores) check(graphEqual(heads.get(generation), s.head()?.value.head), 'context_graph_changed');
  return { local, revisions: [...revisions.values()], ticket_refs: [...ticketRefs.values()], selection: {
    mode: r.mode, at: r.at, observed_head: heads.get(r.at.generation_id), exploration_id: r.exploration_id,
    source_heads: [...heads].map(([generation_id, head]) => ({ generation_id, head })) } };
}

export function planContextSelection(options) { return selectedContext(options, true); }
export function readContextSelection(options) { return selectedContext(options, false); }
