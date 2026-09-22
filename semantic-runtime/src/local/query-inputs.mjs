import { DomainStore } from './domain-store.mjs';
import { LocalCredentialAuthority, LOCAL_AUDIENCE } from './auth.mjs';
import { GraphInputs, graphHash, graphEqual, graphErrorCode } from './graph-inputs.mjs';
import { GraphStorage } from './graph-storage.mjs';
import { ExplorationInputs, readExplorationOwner } from './exploration-inputs.mjs';
import { ExplorationCanonical } from './exploration-canonical.mjs';
import { ContextInputs } from './context-inputs.mjs';
import { planContextSelection, readContextSelection } from './context-reader.mjs';
import { verifyExplorationPublication } from './exploration-adoption.mjs';
import { SourceInvalidationFeed } from './source-invalidation.mjs';
import { queryRequest, queryCopy, queryCheck, queryFailure } from './query-contract.mjs';
import { canonical } from '../core/contracts.mjs';
import { exactRevisionAddress } from '../core/working-graph.mjs';
import { eventObservationKey } from '../core/event-provenance.mjs';
import { sourcePartitionKey } from '../core/causal-ordering.mjs';

const ACTIONS = ['query:read', 'context:read', 'store:read', 'graph:read', 'exploration:read', 'ingress:read', 'source:invalidation:read'];
const check = (condition, code = 'invalid_query_input') => queryCheck(condition, code);
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const ordered = values => [...values].sort((a, b) => cmp(canonical(a), canonical(b)));
const unique = values => [...new Map(values.map(value => [canonical(value), value])).values()];
const refKey = ref => graphHash(ref);
const eventRef = event => ({ kind: 'event_ref', observation_key: eventObservationKey(event), event_digest: graphHash(event) });
const candidateKey = (scope, ref) => graphHash([scope.layer, scope.exploration_id, ref]);
const groupKey = (scope, ref) => graphHash([scope.layer, scope.exploration_id, scope.at, ref.entity_id]);
const pinKey = ref => canonical([ref.at, ref.address]);
const selectedItems = (recipe, selected) => recipe.method === 'page' ? selected.local.items
  : recipe.method === 'resolve' ? selected.local.item ? [selected.local.item] : []
    : selected.local.root ? [selected.local.root] : [];

/** Fixed selected-window composition. Raw planning locators never authorize output. */
export class QueryInputs {
  #store; #authority; #graph; #metadata; #canonical; #contexts; #feed; #proofs = new WeakMap();
  constructor({ store, authority, canonical_reader }) {
    check(store instanceof DomainStore && authority instanceof LocalCredentialAuthority, 'invalid_query_configuration');
    this.#store = store; this.#authority = authority;
    this.#graph = new GraphInputs({ store, authority });
    this.#canonical = new ExplorationCanonical({ store, authority, canonical_reader });
    this.#metadata = new ExplorationInputs({ store, authority, config_digest: this.#canonical.config_digest });
    this.#contexts = new ContextInputs({ authority, canonical: this.#canonical });
    this.#feed = new SourceInvalidationFeed({ store, authority });
  }
  get config_digest() { return this.#canonical.config_digest; }
  #call(fn) {
    try { return fn(); } catch (error) {
      const code = graphErrorCode(error);
      throw queryFailure(code && /^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : 'query_unavailable');
    }
  }
  #view(context, fn) {
    let failure;
    try { return this.#store.readSnapshot(context, view => { try { return fn(view); } catch (error) { failure = error; throw error; } }); }
    catch (error) { throw failure ?? error; }
  }
  grant(context) {
    return this.#call(() => {
      const grant = this.#authority.inspect(context);
      check(grant && grant.audience === LOCAL_AUDIENCE && ACTIONS.every(action => grant.actions.includes(action)), 'query_unauthorized');
      return queryCopy({ scope: { tenant_id: grant.tenant_id, project_id: grant.project_id }, actor: grant.principal_id, actor_kind: grant.kind });
    });
  }
  #metadataAt(view, context, request, grant) {
    const project = this.#metadata.projectSelection(view, context);
    check(project.version === request.expected_project_selection_version, 'query_selection_changed');
    this.#feed.assertFence(context, { sequence: request.expected_source_fence });
    const scopes = [request.own, ...request.related].map((selection, index) => {
      check(graphEqual(selection.at.scope, grant.scope), 'query_unauthorized');
      const exploration = this.#metadata.getExploration(view, context, { exploration_id: selection.exploration_id });
      check(exploration && exploration.generation_id === selection.at.generation_id, 'query_scope_unavailable');
      check(graphEqual(this.#canonical.pin(selection.expected_shared_base), this.#canonical.pin(exploration.origin.shared_base)), 'query_selection_changed');
      const storage = new GraphStorage({ view, scope: grant.scope, generation_id: exploration.generation_id });
      const head = storage.head(); check(head && head.value.maintenance === null, 'query_scope_unavailable');
      check(selection.mode !== 'current' || graphEqual(selection.at, head.value.head), 'query_selection_changed');
      const commit = storage.fact({ at: selection.at, kind: 'commit', key: [selection.at.commit_digest] }).value;
      check(commit, 'query_scope_unavailable');
      const catalog = this.#graph.catalogFromPin(context, commit.catalog_pin); check(catalog, 'query_scope_unavailable');
      return { ...selection, layer: index === 0 ? 'own' : 'notice', generation_id: exploration.generation_id,
        exploration, head: head.value.head, observed_sequence: head.value.sequence, commit, catalog };
    });
    return { project, scopes };
  }
  #read(view, context, proof, recipe, planning) {
    return (planning ? planContextSelection : readContextSelection)({ view, context, inputs: this.#graph,
      explorations: this.#metadata, config_digest: this.config_digest, request: recipe.request, kind: recipe.method,
      read_pins: { project_selection: proof.metadata.project, source_fence: proof.request.expected_source_fence } });
  }
  #recipe(scope, kind, method, locator, extra) {
    return { scope, kind, method, source_id: graphHash([kind, scope.exploration_id, scope.at, locator]),
      request: { exploration_id: scope.exploration_id, at: scope.at, mode: scope.mode, ...extra } };
  }
  #plan(view, context, proof) {
    const recipes = [], inventory = new Map(), groups = new Map(), represented = new Set();
    const select = recipe => {
      const planned = this.#read(view, context, proof, recipe, true);
      recipe.planned = planned;
      recipe.inspected = recipe.method === 'page' ? new GraphStorage({ view, scope: proof.grant.scope,
        generation_id: recipe.scope.generation_id }).page({ at: recipe.scope.at, collection: { kind: 'heads' },
        after: recipe.request.cursor?.position ?? null, limit: 8 }).rows.length
        : recipe.method === 'lineage' ? (planned.local.root ? 1 : 0) + (planned.local.links?.length ?? 0) : 1;
      for (const revision of planned.revisions) {
        inventory.set(refKey(exactRevisionAddress(revision)), revision);
        check(inventory.size <= 64, 'query_capacity');
      }
      recipes.push(recipe);
      for (const item of selectedItems(recipe, planned)) represented.add(candidateKey(recipe.scope, item.ref));
      return recipe;
    };
    for (const scope of proof.metadata.scopes) select(this.#recipe(scope, 'heads', 'page', scope.heads_cursor,
      { collection: { kind: 'heads' }, cursor: scope.heads_cursor, limit: 8 }));
    for (const selector of proof.request.exact) {
      const scope = proof.metadata.scopes.find(s => s.exploration_id === selector.exploration_id);
      select(this.#recipe(scope, 'exact', 'resolve', selector.address, { address: selector.address }));
    }
    if (proof.request.lineage) {
      const scope = proof.metadata.scopes[0], recipe = select(this.#recipe(scope, 'lineage', 'lineage', proof.request.lineage,
        { ...proof.request.lineage, limit: 8 }));
      for (const link of recipe.planned.local.links ?? []) {
        if (!link.item) continue;
        const selectedScope = proof.metadata.scopes.find(s => s.generation_id === link.item.ref.generation_id);
        if (!selectedScope) continue;
        // A foreign adoption pointer is selected afresh at the explicitly
        // requested scope pin. Its historic link body is never returned.
        const target = this.#recipe(selectedScope, 'lineage', 'resolve', { root: recipe.request.address, ref: link.item.ref }, { address: link.item.ref });
        select(target);
      }
    }
    for (const recipe of [...recipes]) for (const item of selectedItems(recipe, recipe.planned)) {
      if (!item.projection.competing.length) continue;
      const key = groupKey(recipe.scope, item.ref), refs = ordered(unique([item.projection.head, ...item.projection.competing]));
      check(refs.length <= 16, 'query_capacity');
      groups.set(key, { key, scope: recipe.scope, refs });
    }
    let extra = 0;
    for (const group of groups.values()) for (const ref of group.refs) {
      if (represented.has(candidateKey(group.scope, ref))) continue;
      check(++extra <= 16, 'query_capacity');
      select(this.#recipe(group.scope, 'conflict', 'resolve', group.key, { address: ref }));
    }
    return { recipes, inventory, groups };
  }
  #canonicalProofs(context, proof) {
    proof.originProofs = proof.metadata.scopes.map(scope => this.#canonical.prepare(context, scope.exploration.origin.shared_base));
    for (let index = 0; index < proof.originProofs.length; index++) check(proof.metadata.scopes[index].exploration.origin.shared_base === null
      || ['current', 'historical'].includes(this.#canonical.status(proof.originProofs[index])), 'canonical_source_unavailable');
    proof.projectProof = this.#canonical.prepare(context, proof.metadata.project.pin, { requireCurrent: proof.metadata.project.pin !== null });
    const filterRefs = unique([...(proof.request.consumer.task ? [proof.request.consumer.task] : []),
      ...proof.request.scope.tickets, ...proof.request.scope.rooms]);
    const allRefs = unique([...filterRefs, ...[...proof.inventory.values()].flatMap(r => r.assertion.content.data.applicability.tickets.refs)]);
    check(new Set(allRefs.map(pinKey)).size <= 8, 'query_capacity');
    proof.contextProofs = new Map();
    for (const [key, revision] of proof.inventory) {
      try { proof.contextProofs.set(key, { proof: this.#contexts.prepare(context, revision.assertion.content, allRefs) }); }
      catch (error) { proof.contextProofs.set(key, { error }); }
    }
    proof.filterProofs = new Map();
    for (const ref of filterRefs) {
      check(graphEqual(ref.at.scope, proof.grant.scope), 'query_unauthorized');
      const key = pinKey(ref); if (proof.filterProofs.has(key)) continue;
      const pin = { at: ref.at, address: ref.address, record_keys: allRefs.filter(r => pinKey(r) === key).map(r => r.record_key) };
      proof.filterProofs.set(key, this.#canonical.prepare(context, this.#canonical.pin(pin)));
    }
  }
  #filterFacts(view, context, proof) {
    const materials = new Map();
    for (const [key, prepared] of proof.filterProofs) {
      this.#canonical.assert(view, context, prepared); const material = this.#canonical.material(prepared);
      check(['current', 'historical'].includes(material.status) && material.data, 'query_scope_unavailable'); materials.set(key, material);
    }
    const entry = (ref, kind) => {
      const material = materials.get(pinKey(ref)), selected = material?.data.records.find(r => r.key === ref.record_key);
      check(selected?.status === 'usable' && selected.kind === kind && selected.record?.kind === kind, 'query_scope_unavailable');
      const event = material.canonical_refs[selected.canonical_ref_index]?.event;
      const position = material.data.source_watermark.positions.find(p => p.key === ref.record_key);
      check(event?.payload.kind === 'git_revision' && event.payload.path === selected.path
        && position?.event_id === event.event_id && position.event_digest === graphHash(event), 'query_scope_unavailable');
      return { record: selected.record, event, status: material.status };
    };
    const ticket = ref => {
      const { record, event, status } = entry(ref, 'ticket');
      const contract = record.contract_revisions.find(c => c.revision === record.active_contract_revision);
      check(contract, 'query_scope_unavailable');
      return { ref, ticket_id: record.ticket_id, contract_revision: { revision: contract.revision, identity: contract.identity },
        selection_status: status, event_ref: eventRef(event) };
    };
    const room = ref => {
      const { record, event, status } = entry(ref, 'room'), object = event.payload.object;
      return { ref, room_id: record.room_id, stale: record.stale, anchors: record.anchors, selection_status: status,
        event_ref: eventRef(event), git: { repository_id: object.repository_id, object_format: object.object_format, commit_oid: object.oid } };
    };
    const repositories = proof.request.scope.repositories.map(repository_id => {
      const catalogs = proof.metadata.scopes.filter(s => s.catalog.catalog.repositories.some(r => r.tenant_id === proof.grant.scope.tenant_id && r.repository_id === repository_id)
        && s.catalog.catalog.memberships.some(m => m.tenant_id === proof.grant.scope.tenant_id && m.project_id === proof.grant.scope.project_id && m.repository_id === repository_id));
      check(catalogs.length, 'query_scope_unavailable');
      return { repository_id, catalog_pins: unique(catalogs.map(s => s.commit.catalog_pin)) };
    });
    return { task: proof.request.consumer.task ? ticket(proof.request.consumer.task) : null,
      tickets: proof.request.scope.tickets.map(ticket), rooms: proof.request.scope.rooms.map(room), repositories };
  }
  #scopeMatch(item, filters) {
    const app = item.applicability, tickets = unique([...(filters.task ? [filters.task] : []), ...filters.tickets]);
    const dimensions = [];
    const dimension = (name, requested, mode, supports, matches, allowAny = true) => {
      const status = requested.length === 0 ? 'not_requested' : mode === 'unspecified' ? 'uncertain'
        : mode === 'any' ? allowAny ? 'any' : 'uncertain' : matches.length ? 'matched' : supports.length ? 'mismatch' : 'uncertain';
      dimensions.push({ dimension: name, status, filter_refs: requested, support_refs: matches });
    };
    const ticketMatches = app.tickets.refs.filter(actual => tickets.some(filter => actual.ticket_id === filter.ticket_id
      && actual.contract_revision.identity === filter.contract_revision.identity)).map(actual => actual.ref);
    dimension('tickets', tickets.map(t => t.ref), app.tickets.mode, app.tickets.refs, ticketMatches);
    const roomMatches = app.code.refs.filter(code => filters.rooms.some(room => room.git.repository_id === code.repository_id
      && room.git.object_format === code.object_format && room.git.commit_oid === code.commit_oid
      && room.anchors.some(anchor => code.path === anchor || code.path.startsWith(`${anchor}/`)))).map(code => code.ref);
    dimension('rooms', filters.rooms.map(room => room.ref), app.code.mode, app.code.refs, roomMatches);
    const repositoryMatches = app.code.refs.filter(code => filters.repositories.some(r => r.repository_id === code.repository_id))
      .map(code => ({ repository_id: code.repository_id, catalog_pins: filters.repositories.find(r => r.repository_id === code.repository_id).catalog_pins }));
    dimension('repositories', filters.repositories.map(r => ({ repository_id: r.repository_id })), app.code.mode, app.code.refs, unique(repositoryMatches));
    return { status: dimensions.some(d => d.status === 'mismatch') ? 'mismatch' : dimensions.some(d => d.status === 'uncertain') ? 'uncertain' : 'matched',
      verified_dimensions: dimensions.filter(d => d.status === 'matched').length, dimensions };
  }
  #freshness(proof) {
    const f = proof.request.freshness;
    const scopes = proof.metadata.scopes.map(scope => {
      const commit_lag = scope.observed_sequence - scope.commit.sequence, reasons = [];
      check(f.max_commit_lag === null || commit_lag <= f.max_commit_lag, 'query_stale');
      const minimum = f.minimum_watermarks.find(m => m.exploration_id === scope.exploration_id)?.vector ?? null;
      if (minimum?.watermarks.length) for (const requested of minimum.watermarks) {
        const actual = scope.commit.watermarks.watermarks.find(w => sourcePartitionKey(w.source) === sourcePartitionKey(requested.source));
        if (!actual || requested.target_sequence === null || actual.start_sequence === null
          || requested.target_sequence < actual.start_sequence || actual.unordered_count > 0
          || actual.accepted_through === null || actual.completed_through === null) { reasons.push('source_coverage_unknown'); continue; }
        check(actual.accepted_through >= requested.target_sequence && actual.completed_through >= requested.target_sequence, 'query_stale');
      }
      // An empty caller-supplied minimum proves no source coverage. Preserve
      // the selected commit's own unknown state instead of treating the empty
      // loop as satisfaction.
      else if (scope.commit.watermarks.status === 'unknown') reasons.push('source_coverage_unknown');
      const status = reasons.length ? 'unknown' : 'satisfied';
      check(f.allow_unknown_coverage || status !== 'unknown', 'query_freshness_unknown');
      return { exploration_id: scope.exploration_id, status, commit_lag, minimum, reasons: unique(reasons) };
    });
    return { status: scopes.some(s => s.status === 'unknown') ? 'unknown' : 'satisfied', scopes };
  }
  #shared(view, context, proof) {
    proof.originProofs.forEach(p => this.#canonical.assert(view, context, p));
    this.#canonical.assert(view, context, proof.projectProof);
    const current_project = { ...this.#canonical.material(proof.projectProof), version: proof.metadata.project.version };
    const origins = proof.originProofs.map((p, index) => ({ exploration_id: proof.metadata.scopes[index].exploration_id,
      layer: proof.metadata.scopes[index].layer, material: this.#canonical.material(p) }));
    const documents = [], mandatory_authority_keys = [];
    const add = (material, role, exploration_id) => {
      for (const entry of material.data?.records ?? []) {
        if (entry.status !== 'usable' || !entry.record) continue;
        const event = material.canonical_refs[entry.canonical_ref_index]?.event; check(event, 'query_scope_unavailable');
        const ref = { at: material.pin.at, address: material.pin.address, record_key: entry.key };
        const key = graphHash([role, exploration_id, ref]);
        documents.push({ key, role, exploration_id, ref, record_key: entry.key, kind: entry.kind, record: entry.record, event_ref: eventRef(event) });
        if (material.authority_record_keys.includes(entry.key)) mandatory_authority_keys.push(key);
      }
    };
    add(current_project, 'current_project', null); origins.forEach(origin => add(origin.material, 'origin_base', origin.exploration_id));
    return { current_project, origins, documents, mandatory_authority_keys };
  }
  #materialize(view, context, proof) {
    check(context === proof.context && graphEqual(this.grant(context), proof.grant), 'query_unauthorized');
    check(graphEqual(this.#metadataAt(view, context, proof.request, proof.grant), proof.metadata), 'query_selection_changed');
    const shared = this.#shared(view, context, proof), filters = this.#filterFacts(view, context, proof);
    const candidates = new Map(), selectedGroups = new Map(), sources = new Map(), omissions = [], asserted = new Map();
    let lineage = null;
    const itemWithProof = (item, revisions) => {
      const key = refKey(item.ref), revision = revisions.find(r => graphEqual(exactRevisionAddress(r), item.ref));
      const retained = proof.inventory.get(key), prepared = proof.contextProofs.get(key);
      check(revision && retained && graphEqual(revision, retained) && prepared, 'query_selection_changed');
      if (prepared.error) throw prepared.error;
      const applicability = this.#contexts.assert(view, context, prepared.proof, { assertion: revision.assertion, provenance: revision.provenance });
      const owner = readExplorationOwner(view, { scope: proof.grant.scope, generation_id: item.ref.generation_id });
      check(owner, 'query_scope_unavailable'); asserted.set(key, revision);
      return { ...item, applicability: { ...applicability, scope: proof.grant.scope, exploration_id: owner.exploration_id } };
    };
    const add = (recipe, item, revisions) => {
      const verified = itemWithProof(item, revisions), key = candidateKey(recipe.scope, item.ref);
      let candidate = candidates.get(key);
      if (!candidate) {
        const storage = new GraphStorage({ view, scope: proof.grant.scope, generation_id: item.ref.generation_id });
        const revision = proof.inventory.get(refKey(item.ref));
        const publication = verifyExplorationPublication(view, storage, recipe.scope.at, revision, recipe.scope.exploration_id, this.config_digest);
        const at = publication.origin.next_graph;
        const commit = storage.fact({ at, kind: 'commit', key: [at.commit_digest] }).value; check(commit, 'query_scope_unavailable');
        candidate = { key, ref: item.ref, exploration_id: recipe.scope.exploration_id, layer: recipe.scope.layer,
          item: verified, source_reasons: [], conflict_group: null,
          publication: { origin_ref: publication.ref, graph_revision: at, sequence: commit.sequence },
          selected_sequence: recipe.scope.commit.sequence, scope_match: this.#scopeMatch(verified, filters) };
        candidates.set(key, candidate); check(candidates.size <= 64, 'query_capacity');
      } else check(graphEqual(candidate.item, verified), 'query_selection_changed');
      candidate.source_reasons = unique([...candidate.source_reasons, { kind: recipe.kind, source_id: recipe.source_id }]);
      if (item.projection.competing.length) {
        const gkey = groupKey(recipe.scope, item.ref), refs = ordered(unique([item.projection.head, ...item.projection.competing]));
        check(refs.length <= 16, 'query_capacity');
        const retained = proof.groups.get(gkey); check(retained && graphEqual(retained.refs, refs), 'query_selection_changed');
        selectedGroups.set(gkey, { key: gkey, exploration_id: recipe.scope.exploration_id, layer: recipe.scope.layer,
          entity_id: item.ref.entity_id, at: recipe.scope.at, member_keys: [], projected_refs: refs,
          conflict_refs: unique([...storageConflicts(view, proof.grant.scope, recipe.scope, item.ref.entity_id)]) });
        candidate.conflict_group = gkey;
      }
    };
    for (const recipe of proof.recipes) {
      const selected = this.#read(view, context, proof, recipe, false);
      const { source_heads: plannedHeads, ...plannedPins } = recipe.planned.selection;
      const { source_heads, ...actualPins } = selected.selection;
      check(graphEqual(plannedPins, actualPins) && source_heads.every(h => plannedHeads.some(p => graphEqual(p, h))), 'query_selection_changed');
      for (const item of selectedItems(recipe, selected)) add(recipe, item, selected.revisions);
      const next = recipe.method === 'page' || recipe.method === 'lineage' ? selected.local.next_cursor ?? null : null;
      const count = recipe.method === 'lineage' ? (selected.local.root ? 1 : 0) + (selected.local.links?.length ?? 0) : selectedItems(recipe, selected).length;
      const prior = sources.get(recipe.source_id);
      if (prior) { prior.inspected += recipe.inspected; prior.returned += count; }
      else sources.set(recipe.source_id, { source_id: recipe.source_id, kind: recipe.kind, exploration_id: recipe.scope.exploration_id,
        at: recipe.scope.at, requested_limit: recipe.method === 'resolve' ? 1 : 8, inspected: recipe.inspected, returned: count, next_cursor: next });
      if (recipe.method === 'resolve' && !selected.local.item) omissions.push({ source_id: recipe.source_id,
        ref: recipe.kind === 'exact' || recipe.kind === 'lineage' ? recipe.request.address : null, reason: selected.local.status });
      if (recipe.method === 'lineage') {
        // Assert every actually materialized link even though only its authorized
        // pointer leaves this layer; candidate bodies use the selected scope.
        for (const link of selected.local.links ?? []) if (link.item) itemWithProof(link.item, selected.revisions);
        lineage = { root_ref: selected.local.root?.ref ?? null, links: (selected.local.links ?? []).map(({ item, ...link }) => link), next_cursor: next };
      }
    }
    for (const group of selectedGroups.values()) {
      const scope = proof.metadata.scopes.find(s => s.exploration_id === group.exploration_id);
      for (const ref of group.projected_refs) check(candidates.has(candidateKey(scope, ref)), 'query_conflict_unavailable');
      group.member_keys = [...candidates.values()].filter(c => c.exploration_id === group.exploration_id && c.ref.entity_id === group.entity_id).map(c => c.key).sort();
      check(group.member_keys.length <= 16, 'query_capacity');
      for (const key of group.member_keys) candidates.get(key).conflict_group = group.key;
    }
    // Reassert proofs and endpoints after assembly, including sources that only
    // contributed lineage metadata. A partial prefix never escapes a race.
    for (const [key, revision] of asserted) this.#contexts.assert(view, context, proof.contextProofs.get(key).proof,
      { assertion: revision.assertion, provenance: revision.provenance });
    proof.originProofs.forEach(p => this.#canonical.assert(view, context, p)); this.#canonical.assert(view, context, proof.projectProof);
    for (const p of proof.filterProofs.values()) this.#canonical.assert(view, context, p);
    check(graphEqual(this.#metadataAt(view, context, proof.request, proof.grant), proof.metadata)
      && graphEqual(this.grant(context), proof.grant), 'query_selection_changed');
    const scopes = proof.metadata.scopes.map(s => ({ layer: s.layer, exploration_id: s.exploration_id, generation_id: s.generation_id,
      mode: s.mode, at: s.at, origin_ref: s.exploration.origin_ref ?? s.exploration.exploration_id,
      shared_base: s.exploration.origin.shared_base, observed_head: s.head, selected_sequence: s.commit.sequence,
      observed_sequence: s.observed_sequence, commit_lag: s.observed_sequence - s.commit.sequence,
      catalog_pin: s.commit.catalog_pin, watermarks: s.commit.watermarks }));
    return queryCopy({ schema_version: 1, request_digest: graphHash(proof.request), grant: proof.grant,
      selection: { source_fence: proof.request.expected_source_fence, project: proof.metadata.project, scopes },
      shared, filters, candidates: [...candidates.values()].sort((a, b) => cmp(a.key, b.key)),
      conflict_groups: [...selectedGroups.values()].sort((a, b) => cmp(a.key, b.key)), lineage,
      freshness: this.#freshness(proof), coverage: { kind: 'selected_window', global_recall: 'unknown', sources: [...sources.values()] }, omissions });
  }
  prepare(context, input) {
    return this.#call(() => {
      const request = queryRequest(input), grant = this.grant(context);
      const metadata = this.#view(context, view => this.#metadataAt(view, context, request, grant));
      const proof = { context, request, grant, metadata };
      Object.assign(proof, this.#view(context, view => this.#plan(view, context, proof)));
      this.#canonicalProofs(context, proof);
      const prepared = this.#view(context, view => this.#materialize(view, context, proof));
      this.#proofs.set(prepared, proof); return prepared;
    });
  }
  assertCurrent(context, prepared) {
    return this.#call(() => {
      const proof = prepared && typeof prepared === 'object' && this.#proofs.get(prepared);
      check(proof, 'invalid_query_proof'); check(proof.context === context, 'query_unauthorized');
      const actual = this.#view(context, view => this.#materialize(view, context, proof));
      check(graphEqual(actual, prepared), 'query_selection_changed'); return prepared;
    });
  }
}

function storageConflicts(view, scope, selection, entity_id) {
  const storage = new GraphStorage({ view, scope, generation_id: selection.generation_id });
  const entity = storage.fact({ at: selection.at, kind: 'entity', key: ['entity', entity_id] }).value;
  check(entity, 'query_scope_unavailable'); return entity.open_conflicts.map(conflict_digest => ({ conflict_digest }));
}
