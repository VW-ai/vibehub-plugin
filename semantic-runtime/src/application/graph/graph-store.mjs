import { CONTEXT_INPUT_ERROR_CODES } from '../context/context-inputs.mjs';
import { validateContextContent1, validateContextOperation1 } from '../../domain/context/context-profile.mjs';
import { materializeContextShared, validateContextReadRequest, CONTEXT_READER_ERROR_CODES } from '../context/context-reader.mjs';
import { selectGraph } from './graph-selected.mjs';
import { DomainStore } from '../../adapters/sqlite/domain-store.mjs';
import { AccessAuthority } from '../../domain/identity/access-authority.mjs';
import { ProjectActivation } from '../project/project-activation.mjs';
import { GraphStorage, checkGraphFormat, WORKING_GRAPH_NAMESPACE } from '../../adapters/sqlite/graph-storage.mjs';
import { GraphInputs, GRAPH_NS, graphFail, graphAssert, graphHash, graphKey, graphEqual, graphId,
  graphUint, graphInput, graphFields, graphErrorCode } from './graph-inputs.mjs';
import { planGraphGenesis, planGraphMutation, resolveIncrementalGraph, pageIncrementalGraph,
  validateGraphCommitAddress2, validateGraphEffectPlan2, validateGraphMutation2 } from '../../domain/graph/incremental-graph.mjs';
import { eventObservationKey, sourceObjectKey } from '../../domain/sources/event-provenance.mjs';
import { validateSourceCursor } from '../../domain/sources/causal-ordering.mjs';
import { SourceInvalidationFeed } from '../sources/source-invalidation.mjs';
import { readExplorationOwner, EXPLORATION_ERROR_CODES } from '../explorations/exploration-inputs.mjs';
import { EXPLORATION_CANONICAL_ERROR_CODES } from '../explorations/exploration-canonical.mjs';
import { materializeExplorationAdoption, verifyExplorationAdoptionResult, verifyExplorationPublication } from '../explorations/exploration-adoption.mjs';
import { registerGraphCapability } from './graph-capability.mjs';
import { graphServiceBundle } from './graph-service-bundle.mjs';

export { WORKING_GRAPH_NAMESPACE };
export const GRAPH_ERROR_CODES = Object.freeze(['invalid_graph_input', 'graph_capacity', 'graph_unauthorized', 'graph_access_denied',
  'graph_corrupt', 'graph_publisher_unavailable', 'graph_idempotency_conflict', 'graph_unavailable', 'graph_plan_rejected',
  'graph_storage_invalid', 'graph_storage_corrupt', 'graph_storage_conflict', 'graph_maintenance', 'unsupported_graph_format',
  'project_disabled', 'stale_activation_epoch', 'activation_unauthorized', 'invalid_activation_input', 'invalid_activation_state',
  'project_not_enrolled', 'invalid_execution_membership', 'project_unauthorized', 'ingress_unauthorized', 'missing_event',
  'corrupt_ingress_state', 'unknown_source', 'store_closed', 'store_busy', 'store_unavailable', 'store_unauthorized',
  'invalidation_unauthorized', 'invalid_invalidation_input', 'missing_invalidation', 'invalidation_corrupt', 'stale_invalidation_fence',
  'invalid_store_input', 'unknown_namespace', 'cas_conflict', 'duplicate_identity', 'async_transaction', 'stale_transaction',
  'nested_transaction', 'migration_required', 'incompatible_store', 'store_page_too_large',
  ...EXPLORATION_ERROR_CODES, 'exploration_route_required']);
const CODES = new Set([
  ...GRAPH_ERROR_CODES,
  ...EXPLORATION_CANONICAL_ERROR_CODES,
  ...CONTEXT_INPUT_ERROR_CODES,
  ...CONTEXT_READER_ERROR_CODES,
]);
const scopeOf = g => ({ tenant_id: g.tenant_id, project_id: g.project_id });
const commandKey = (g, generation, key) => graphKey('command', [1, scopeOf(g), g.principal_id, generation, key]);
const receiptKey = (g, generation, key) => graphKey('receipt', [1, scopeOf(g), g.principal_id, generation, key]);
const descriptor = (kind, value) => ({ id: graphKey(kind, value), kind, value });
const planner = fn => { try { return fn(); } catch (error) { if (CODES.has(graphErrorCode(error))) throw error; throw graphFail('graph_plan_rejected'); } };

/** Local authenticated graph service. Every database operation remains synchronous and scoped. */
export class LocalGraphStore {
  #store; #authority; #inputs; #activation; #invalidations;
  constructor({ store, authority }) {
    graphAssert(store instanceof DomainStore && authority instanceof AccessAuthority);
    this.#store = store; this.#authority = authority; this.#inputs = new GraphInputs({ store, authority });
    this.#activation = new ProjectActivation({ store, authority });
    this.#invalidations = new SourceInvalidationFeed({ store, authority });
    registerGraphCapability(this, { store, authority });
  }
  #call(fn) {
    try { return graphInput(fn()); } catch (error) {
      const code = graphErrorCode(error); throw graphFail(CODES.has(code) ? code : 'invalid_graph_input');
    }
  }
  #view(context, action, write, operation, epoch, reconcile, execution) {
    let domainCode;
    const run = tx => {
      try {
        this.#inputs.grant(context, action, { write, owner: write });
        if (action === 'graph:read' || action === 'graph:write') this.#inputs.grant(context, 'ingress:read');
        const value = operation(tx);
        this.#inputs.grant(context, action, { write, owner: write });
        if (action === 'graph:read' || action === 'graph:write') this.#inputs.grant(context, 'ingress:read');
        // Validate the result before commit; output capacity is atomic too.
        return graphInput(value);
      } catch (error) { const code = graphErrorCode(error); if (CODES.has(code)) domainCode = code; throw error; }
    };
    try {
      if (!write) return this.#store.readSnapshot(context, run);
      const admitted = this.#activation.withAdmission(context, { epoch, stage: 'result', ...(execution ? { execution } : {}) }, run);
      if (!admitted.admitted) {
        // Another process may have committed this exact request after the first read,
        // then disabled capture before this admission obtained the writer lock.
        const prior = reconcile ? this.#view(context, action, false, reconcile) : null;
        if (prior) return prior;
        throw graphFail(admitted.reason);
      }
      return admitted.value;
    } catch (error) { if (domainCode) throw graphFail(domainCode); throw error; }
  }
  #scope(context, action, options) { return scopeOf(this.#inputs.grant(context, action, options)); }
  #sourceFence(context, request) {
    if (Object.hasOwn(request, 'expected_source_fence')) {
      this.#invalidations.assertFence(context, { sequence: request.expected_source_fence });
    }
  }
  #storage(tx, context, generation, action) {
    return new GraphStorage({ view: tx, scope: this.#scope(context, action), generation_id: generation });
  }
  #selected(context, tx, storage, options) {
    return selectGraph({ inputs: this.#inputs, context, tx, storage, ...options });
  }
  #receiptAllowed(context, tx, receipt, action = 'graph:read') {
    const g = this.#inputs.grant(context, action);
    graphAssert(receipt.actor === g.principal_id && receipt.actor_kind === g.kind && graphEqual(receipt.scope, scopeOf(g)), 'graph_access_denied');
    const events = [];
    for (const ref of receipt.source_refs) {
      const source = tx.getSource(GRAPH_NS, ref);
      graphAssert(source?.kind === 'graph-accepted-event', 'graph_corrupt');
      const current = this.#inputs.acceptedEvent(context, source.value.observation);
      graphAssert(current.retained && graphEqual(current.receipt, source.value.receipt), 'graph_corrupt'); events.push(current.fact.event);
    }
    events.push(...this.#coverageAllowed(context, tx, receipt.coverage_pins));
    const storage = this.#storage(tx, context, receipt.generation_id, action), head = storage.head();
    graphAssert(head, 'graph_corrupt');
    const capturedAccess = new Set(events.filter(e => ['SOURCE_ACCESS_CHANGED', 'SOURCE_TOMBSTONE'].includes(e.event_type)).map(graphHash));
    const objects = new Map(events.flatMap(e => e.provenance.source_objects.map(s => [sourceObjectKey(s.object), s.object])));
    for (const [key, object] of objects) {
      const current = storage.fact({ at: head.value.head, kind: 'source_object', key: [key] }).value;
      if (current) graphAssert(graphEqual(current.object, object) && current.tombstone === null, 'graph_access_denied');
      const access = storage.fact({ at: head.value.head, kind: 'source_access', key: [key] }).value;
      if (!access) continue;
      graphAssert(graphEqual(access.object, object), 'graph_corrupt');
      for (const update of access.updates) {
        const admitted = this.#inputs.acceptedEvent(context, eventObservationKey(update.event));
        graphAssert(graphEqual(admitted.fact.event, update.event) && admitted.fact.event_digest === update.event_digest, 'graph_corrupt');
        graphAssert(update.access_state === 'active' && capturedAccess.has(update.event_digest), 'graph_access_denied');
      }
    }
  }
  #coverageAllowed(context, tx, pins) {
    const events = [];
    for (const pin of pins) {
      const source = tx.getSource(GRAPH_NS, pin.snapshot_ref); graphAssert(source?.kind === 'graph-coverage'
        && graphKey('graph-coverage', source.value) === pin.snapshot_ref && graphEqual(source.value.selector, pin.selector)
        && source.value.registration_version === pin.registration_version && source.value.cursor_version === pin.cursor_version, 'graph_corrupt');
      try { validateSourceCursor(source.value.cursor); } catch { throw graphFail('graph_corrupt'); }
      // Every retained cursor entry is a selected original input, even when not in the semantic closure.
      for (const entry of source.value.cursor.entries) {
        const admitted = this.#inputs.acceptedEvent(context, JSON.stringify([1, 'observation', entry.event_ref.tenant_id, entry.event_ref.event_id]));
        graphAssert(admitted.fact.event_digest === entry.first_event_digest, 'graph_corrupt'); events.push(admitted.fact.event);
      }
    }
    return events;
  }
  #prior(context, tx, generation, idempotency, request = null) {
    const action = request ? 'graph:write' : 'graph:read', grant = this.#inputs.grant(context, action), key = commandKey(grant, generation, idempotency);
    const row = tx.getSource(GRAPH_NS, key); if (!row) return null;
    graphAssert(row.kind === 'graph-command' && row.value.generation_id === generation && row.value.idempotency_key === idempotency
      && row.value.receipt_ref === receiptKey(grant, generation, idempotency), 'graph_corrupt');
    if (request) graphAssert(graphEqual(row.value.request, request), 'graph_idempotency_conflict');
    this.#sourceFence(context, row.value.request);
    const stored = tx.getSource(GRAPH_NS, row.value.receipt_ref);
    graphAssert(stored?.kind === 'graph-receipt' && graphHash(stored.value) === row.value.receipt_digest
      && stored.value.generation_id === generation && stored.value.idempotency_key === idempotency
      && stored.value.raw_request_digest === graphHash(row.value.request) && stored.value.command_digest === graphHash(row.value.command)
      && graphEqual(stored.value.result, row.value.result), 'graph_corrupt');
    this.#receiptAllowed(context, tx, stored.value, action);
    return { status: 'duplicate', receipt: stored.value, ...row.value.result };
  }
  registerPublisherRun(context, options) {
    return this.#call(() => {
      const input = graphInput(options); graphFields(input, ['epoch', 'run_key']); graphUint(input.epoch); graphId(input.run_key);
      this.#inputs.grant(context, 'graph:publish', { write: true, owner: true });
      const prior = this.#view(context, 'graph:publish', false, tx => { checkGraphFormat(tx); return this.#inputs.registration(context, input); });
      if (prior) return prior;
      return this.#view(context, 'graph:publish', true, tx => { checkGraphFormat(tx, { initialize: true }); return this.#inputs.registerPublisher(tx, context, input); }, input.epoch, tx => { checkGraphFormat(tx); return this.#inputs.registration(context, input); });
    });
  }
  #save(context, tx, request, command, planned, selected, publisher, coverage, generation, exploration = null) {
    const grant = this.#inputs.grant(context, 'graph:write', { write: true, owner: true }), scope = scopeOf(grant), plan = planned.plan;
    validateGraphEffectPlan2(plan);
    const facts = [...publisher.facts, ...coverage.facts, ...selected.facts];
    this.#inputs.retain(tx, context, facts);
    const audit = descriptor('graph-audit', { ...plan.audit, actor: grant.principal_id, actor_kind: grant.kind, epoch: request.epoch, publisher_ref: request.publisher_ref });
    tx.appendSource(GRAPH_NS, audit.id, audit.kind, audit.value);
    const source_refs = [...new Set(facts.filter(f => f.kind === 'graph-accepted-event').map(f => f.id))].sort();
    const result = Object.fromEntries(['revision', 'conflict', 'access_revision'].filter(k => Object.hasOwn(planned, k)).map(k => [k, planned[k]]));
    const receipt = { schema_version: 1, kind: 'graph_receipt', scope, generation_id: generation, actor: grant.principal_id, actor_kind: grant.kind,
      idempotency_key: request.idempotency_key, raw_request_digest: graphHash(request), command_digest: graphHash(command), plan_digest: plan.plan_digest,
      publisher_ref: request.publisher_ref, epoch: request.epoch, catalog_pin: publisher.catalogFact.pin, previous_graph: plan.expected_graph, next_graph: plan.next_graph,
      source_refs, coverage_pins: coverage.pins, authority_refs: [...new Set(selected.authorityRefs)], audit_ref: audit.id,
      record_refs: plan.commit.records, result };
    if (exploration) receipt.operation_origin_ref = exploration.inputs.retainOrigin(tx, context, exploration.route,
      { previous_graph: plan.expected_graph, next_graph: plan.next_graph, revision: result.revision });
    const rKey = receiptKey(grant, generation, request.idempotency_key), cKey = commandKey(grant, generation, request.idempotency_key);
    tx.appendSource(GRAPH_NS, rKey, 'graph-receipt', receipt);
    tx.appendSource(GRAPH_NS, graphKey('commit-receipt', plan.next_graph), 'graph-commit-receipt', { next_graph: plan.next_graph, receipt_ref: rKey });
    tx.appendSource(GRAPH_NS, cKey, 'graph-command', { schema_version: 1, generation_id: generation, idempotency_key: request.idempotency_key,
      request, command, receipt_ref: rKey, receipt_digest: graphHash(receipt), result });
    tx.enqueue(GRAPH_NS, graphKey('changed', [scope, generation, plan.next_graph]), plan.outbox);
    return { status: 'applied', receipt, ...result, ...(receipt.operation_origin_ref ? { operation_origin_ref: receipt.operation_origin_ref } : {}) };
  }
  #ordinaryWrite(tx, context, generation, operation = null) {
    const owner = readExplorationOwner(tx, { scope: this.#scope(context, 'graph:write'), generation_id: generation });
    graphAssert(!owner || operation?.kind === 'source_access', 'exploration_route_required');
  }
  #initializeInView(context, tx, request, exploration = null) {
    const storage = this.#storage(tx, context, request.generation_id, 'graph:write'); graphAssert(!storage.head(), 'graph_storage_conflict');
    const publisher = this.#inputs.publisher(context, request.publisher_ref, { epoch: request.epoch });
    const coverage = this.#inputs.coverage(context, request.coverage, null);
    const selected = this.#selected(context, tx, storage, { generation_id: request.generation_id, write: true, catalogFact: publisher.catalogFact, epoch: request.epoch });
    const command = { scope: this.#scope(context, 'graph:write'), generation_id: request.generation_id, catalog_pin: publisher.catalogFact.pin, watermarks: coverage.watermarks };
    const planned = planner(() => planGraphGenesis(selected.port, command)); storage.applyPlan(planned.plan);
    return this.#save(context, tx, request, command, planned, selected, publisher, coverage, request.generation_id, exploration);
  }
  initialize(context, options) {
    return this.#call(() => {
      const request = graphInput(options); graphFields(request, ['generation_id', 'epoch', 'idempotency_key', 'publisher_ref', 'coverage']);
      graphId(request.generation_id); graphId(request.idempotency_key); graphId(request.publisher_ref); graphUint(request.epoch);
      graphAssert(Array.isArray(request.coverage)); this.#inputs.grant(context, 'graph:write', { write: true, owner: true });
      const prior = this.#view(context, 'graph:write', false, tx => { checkGraphFormat(tx); this.#ordinaryWrite(tx, context, request.generation_id); return this.#prior(context, tx, request.generation_id, request.idempotency_key, request); });
      if (prior) return prior;
      return this.#view(context, 'graph:write', true, tx => {
        checkGraphFormat(tx, { initialize: true }); this.#ordinaryWrite(tx, context, request.generation_id); const duplicate = this.#prior(context, tx, request.generation_id, request.idempotency_key, request); if (duplicate) return duplicate;
        return this.#initializeInView(context, tx, request);
      }, request.epoch, tx => { checkGraphFormat(tx); this.#ordinaryWrite(tx, context, request.generation_id); return this.#prior(context, tx, request.generation_id, request.idempotency_key, request); });
    });
  }
  #mutationRequest(context, options) {
    const request = graphInput(options); graphFields(request, ['epoch', 'idempotency_key', 'publisher_ref', 'expected_graph', 'operation', 'coverage'], ['expected_source_fence']);
    graphUint(request.epoch); graphId(request.idempotency_key); graphId(request.publisher_ref); validateGraphCommitAddress2(request.expected_graph);
    if (Object.hasOwn(request, 'expected_source_fence')) graphUint(request.expected_source_fence);
    graphAssert(request.operation && !Object.hasOwn(request.operation, 'watermarks'));
    graphAssert(request.operation.kind === 'assert' ? request.coverage === null || Array.isArray(request.coverage) : request.coverage === null);
    const g = this.#inputs.grant(context, 'graph:write', { write: true, owner: true }); graphAssert(graphEqual(request.expected_graph.scope, scopeOf(g)));
    return request;
  }
  #mutateInView(context, tx, request, exploration = null) {
    request = this.#mutationRequest(context, request);
    const generation = request.expected_graph.generation_id;
    const storage = this.#storage(tx, context, generation, 'graph:write'), head = storage.head(); graphAssert(head, 'graph_unavailable');
    const current = storage.fact({ at: head.value.head, kind: 'commit', key: [head.value.head.commit_digest] }).value;
    graphAssert(current, 'graph_corrupt');
    // Validate the wire body even for a stale proposal. This retained pin is used
    // only for syntax; a new command below obtains its actual current publisher catalog.
    planner(() => validateGraphMutation2({ schema_version: 2, kind: 'graph_mutation', expected_graph: request.expected_graph, catalog_pin: current.catalog_pin, operation: request.operation }));
    if (!graphEqual(head.value.head, request.expected_graph)) return { status: 'graph_revision_mismatch', graph_revision: head.value.head, proposal: request, effects: [] };
    graphAssert(head.value.maintenance === null, 'graph_maintenance');
    const publisher = this.#inputs.publisher(context, request.publisher_ref, { epoch: request.epoch });
    if (['assert', 'resolve'].includes(request.operation.kind)) graphAssert(request.operation.assertion?.execution_id === publisher.run.execution_id, 'graph_publisher_unavailable');
    const coverage = this.#inputs.coverage(context, request.coverage, current.watermarks);
    if (request.coverage === null) {
      const link = tx.getSource(GRAPH_NS, graphKey('commit-receipt', head.value.head));
      graphAssert(link?.kind === 'graph-commit-receipt' && graphEqual(link.value.next_graph, head.value.head), 'graph_corrupt');
      const previous = tx.getSource(GRAPH_NS, link.value.receipt_ref); graphAssert(previous?.kind === 'graph-receipt', 'graph_corrupt');
      coverage.pins = previous.value.coverage_pins;
      // Inherited coverage preserves old capture facts, with current access checked anew.
      this.#coverageAllowed(context, tx, coverage.pins);
    }
    const operation = request.coverage === null ? request.operation : { ...request.operation, watermarks: coverage.watermarks };
    const selected = this.#selected(context, tx, storage, { generation_id: generation, write: true, catalogFact: publisher.catalogFact, epoch: request.epoch, operation });
    const command = { schema_version: 2, kind: 'graph_mutation', expected_graph: request.expected_graph, catalog_pin: publisher.catalogFact.pin, operation };
    const planned = planner(() => planGraphMutation(selected.port, command)); graphAssert(planned.status === 'planned', 'graph_storage_conflict');
    storage.applyPlan(planned.plan);
    const saved = this.#save(context, tx, request, command, planned, selected, publisher, coverage, generation, exploration);
    this.#sourceFence(context, request);
    return saved;
  }
  mutate(context, options) {
    return this.#call(() => {
      const request = this.#mutationRequest(context, options);
      const generation = request.expected_graph.generation_id;
      const prior = this.#view(context, 'graph:write', false, tx => { checkGraphFormat(tx); this.#ordinaryWrite(tx, context, generation, request.operation); this.#sourceFence(context, request); return this.#prior(context, tx, generation, request.idempotency_key, request); });
      if (prior) return prior;
      return this.#view(context, 'graph:write', true, tx => {
        checkGraphFormat(tx); this.#ordinaryWrite(tx, context, generation, request.operation); this.#sourceFence(context, request);
        const duplicate = this.#prior(context, tx, generation, request.idempotency_key, request); if (duplicate) return duplicate;
        return this.#mutateInView(context, tx, request);
      }, request.epoch, tx => { checkGraphFormat(tx); this.#ordinaryWrite(tx, context, generation, request.operation); return this.#prior(context, tx, generation, request.idempotency_key, request); });
    });
  }
  #explorationServices(canonical_reader, domain = false) {
    const services = graphServiceBundle({ graph: this, store: this.#store, authority: this.#authority, canonical_reader });
    return domain ? services : { ...services, contexts: null };
  }
  #contextOperation(context, tx, services, operation, at, write = true) {
    if (!services.contexts) return;
    services.contexts.grant(context, { write });
    if (['create', 'derive', 'branch'].includes(operation.assertion?.content?.data?.change?.kind)) {
      const storage = this.#storage(tx, context, at.generation_id, 'graph:read');
      graphAssert(storage.fact({ at, kind: 'entity', key: ['entity', operation.assertion.entity_id] }).value === null,
        'context_transition_invalid');
    }
    let branch_parent = null;
    if (operation.assertion?.content?.data?.change?.kind === 'branch') {
      graphAssert(operation.assertion.parents?.length === 1);
      const selected = this.#readInView(context, tx, { at, address: operation.assertion.parents[0] }, false);
      graphAssert(selected.status === 'resolved', 'graph_access_denied'); branch_parent = selected.revision;
    }
    validateContextOperation1(operation, { branch_parent });
  }
  #contextResult(context, tx, services, proof, result) {
    if (!services.contexts) return;
    graphAssert(result.revision && result.receipt?.next_graph, 'invalid_graph_input');
    const selected = this.#readInView(context, tx, { at: result.receipt.next_graph, address: result.revision }, false);
    graphAssert(selected.status === 'resolved', 'graph_access_denied');
    validateContextContent1(selected.revision.assertion.content);
    services.contexts.assert(tx, context, proof, { assertion: selected.revision.assertion, provenance: selected.revision.provenance });
  }
  #explorationProofs(context, canonical, shared, { requireCurrent = false } = {}) {
    this.#invalidations.assertFence(context, { sequence: shared.source_fence });
    const origin = canonical.prepare(context, shared.origin_base);
    const project = canonical.prepare(context, shared.project_selection.pin, { requireCurrent });
    for (const proof of [origin, project]) {
      const summary = canonical.summary(proof);
      graphAssert(summary.source_fence === shared.source_fence, 'stale_invalidation_fence');
      graphAssert(summary.pin === null || ['current', 'historical'].includes(summary.status), 'canonical_source_unavailable');
    }
    return { origin, project, shared };
  }
  #assertExplorationProofs(tx, context, services, proofs) {
    services.inputs.grant(context, { write: true });
    this.#invalidations.assertFence(context, { sequence: proofs.shared.source_fence });
    services.canonical.assert(tx, context, proofs.origin);
    services.canonical.assert(tx, context, proofs.project);
  }
  #explorationPrior(context, services, { kind, request, idempotency_key }) {
    return this.#view(context, 'graph:read', false, tx => kind
      ? services.inputs.prior(tx, context, { kind, request })
      : services.inputs.receipt(tx, context, { idempotency_key }));
  }
  #returnExplorationPrior(context, services, selected, { kind, request, idempotency_key, readOnly = false }) {
    services.contexts?.grant(context, { write: !readOnly });
    const domainProof = services.contexts ? services.contexts.prepare(context,
      validateContextContent1(selected.graph_request?.operation?.assertion?.content)) : null;
    const proofs = this.#explorationProofs(context, services.canonical, selected.receipt.shared);
    const currentProject = services.contexts && readOnly ? this.#view(context, 'graph:read', false,
      tx => services.inputs.projectSelection(tx, context)) : null;
    const currentProjectProof = currentProject ? services.canonical.prepare(context, currentProject.pin) : null;
    const adoptionRequest = selected.receipt.operation === 'adopt' ? selected.request : null;
    const sourceProofs = adoptionRequest ? this.#explorationProofs(context, services.canonical,
      { ...selected.receipt.shared, origin_base: adoptionRequest.source.shared_base }) : null;
    return this.#view(context, readOnly ? 'graph:read' : 'graph:write', false, tx => {
      services.inputs.grant(context, { write: !readOnly });
      const prior = kind ? services.inputs.prior(tx, context, { kind, request })
        : services.inputs.receipt(tx, context, { idempotency_key });
      graphAssert(prior && graphEqual(prior, selected), 'exploration_corrupt');
      this.#invalidations.assertFence(context, { sequence: proofs.shared.source_fence });
      services.canonical.assert(tx, context, proofs.origin); services.canonical.assert(tx, context, proofs.project);
      if (adoptionRequest) {
        services.inputs.grant(context, { write: !readOnly, adopt: true });
        services.canonical.assert(tx, context, sourceProofs.origin); services.canonical.assert(tx, context, sourceProofs.project);
        const material = this.#adoptionMaterial(context, tx, services, adoptionRequest,
          prior.graph_request.operation.assertion.execution_id, { current: false });
        graphAssert(graphEqual(material.operation, prior.graph_request.operation)
          && graphEqual(material.adoption, prior.result.adoption), 'exploration_corrupt');
        verifyExplorationAdoptionResult({ view: tx, request: adoptionRequest, result: prior.result,
          destination_storage: this.#storage(tx, context, adoptionRequest.destination.expected_graph.generation_id, 'graph:read'),
          destination_exploration: services.inputs.getExploration(tx, context,
            { exploration_id: adoptionRequest.destination.exploration_id }), config_digest: services.canonical.config_digest });
      }
      if (prior.graph_request) {
        const graphRequest = prior.graph_request;
        const generation = graphRequest.generation_id ?? graphRequest.expected_graph.generation_id;
        const retained = this.#prior(context, tx, generation, graphRequest.idempotency_key, readOnly ? null : graphRequest);
        graphAssert(retained, 'exploration_corrupt');
      }
      if (services.contexts && prior.receipt.operation === 'mutate') {
        this.#contextOperation(context, tx, services, prior.graph_request.operation, prior.graph_request.expected_graph, !readOnly);
      }
      this.#contextResult(context, tx, services, domainProof, prior.result);
      services.contexts?.grant(context, { write: !readOnly });
      const publicReceipt = prior.result.receipt ?? prior.receipt;
      if (currentProject) {
        graphAssert(graphEqual(currentProject, services.inputs.projectSelection(tx, context)), 'exploration_selection_conflict');
        services.canonical.assert(tx, context, currentProjectProof);
        const shared = materializeContextShared(services.canonical, proofs.origin, currentProjectProof, currentProject.version);
        this.#invalidations.assertFence(context, { sequence: proofs.shared.source_fence });
        return { ...publicReceipt, shared };
      }
      this.#invalidations.assertFence(context, { sequence: proofs.shared.source_fence });
      return readOnly ? publicReceipt : { ...prior.result, status: 'duplicate', receipt: publicReceipt };
    });
  }
  // The same exact historical reads are used for first admission and retained
  // results. Only a new command checks the current heads and physical B route.
  #adoptionMaterial(context, tx, services, request, execution_id, { current = true, destinationWritten = false } = {}) {
    const { inputs, canonical } = services, g = inputs.grant(context, { adopt: true });
    const source = inputs.getExploration(tx, context, { exploration_id: request.source.exploration_id });
    const destination = inputs.getExploration(tx, context, { exploration_id: request.destination.exploration_id });
    graphAssert(source && destination && source.exploration_id !== destination.exploration_id
      && source.generation_id !== destination.generation_id, 'exploration_unavailable');
    graphAssert(source.generation_id === request.source.at.generation_id
      && source.generation_id === request.source.expected_head.generation_id
      && destination.generation_id === request.destination.expected_graph.generation_id, 'invalid_exploration_input');
    graphAssert(graphEqual(canonical.pin(source.origin.shared_base), request.source.shared_base)
      && graphEqual(canonical.pin(destination.origin.shared_base), request.destination.shared_base), 'exploration_selection_conflict');
    const sourceStorage = this.#storage(tx, context, source.generation_id, 'graph:read');
    const destinationStorage = this.#storage(tx, context, destination.generation_id, 'graph:read');
    const aHead = sourceStorage.head(), bHead = destinationStorage.head();
    graphAssert(aHead && bHead, 'graph_unavailable');
    graphAssert(aHead.value.maintenance === null && bHead.value.maintenance === null, 'graph_maintenance');
    if (current) {
      graphAssert(graphEqual(aHead.value.head, request.source.expected_head), 'graph_storage_conflict');
      if (!destinationWritten) graphAssert(graphEqual(bHead.value.head, request.destination.expected_graph), 'graph_storage_conflict');
    }
    const localSource = this.#readInView(context, tx, { at: request.source.at, address: request.source.address }, false);
    if (services.contexts) {
      graphAssert(localSource.status === 'resolved', 'graph_access_denied');
      validateContextContent1(localSource.revision.assertion.content);
      const publication = verifyExplorationPublication(tx, sourceStorage, request.source.at, localSource.revision,
        source.exploration_id, canonical.config_digest);
      if (publication.origin.operation !== 'adopt') this.#contextOperation(context, tx, services,
        publication.operation, publication.origin.previous_graph, false);
    }
    const endpoints = request.endpoint_map.map(mapping => ({ ...mapping, resolved: this.#readInView(context, tx,
      { at: request.destination.expected_graph, address: mapping.destination }, false) }));
    this.#sourceFence(context, request);
    return materializeExplorationAdoption({ view: tx, context, inputs: this.#inputs, request, source: localSource, endpoints,
      source_storage: sourceStorage, destination_storage: destinationStorage, grant: g, execution_id,
      source_exploration: source, destination_exploration: destination, config_digest: canonical.config_digest });
  }
  #adoptExploration(context, options, canonical_reader, domain) {
    return this.#call(() => {
      const services = this.#explorationServices(canonical_reader, domain), { inputs, canonical } = services;
      const request = inputs.parse('adopt', options); inputs.grant(context, { write: true, adopt: true });
      services.contexts?.grant(context, { write: true });
      if (domain) graphAssert(request.endpoint_map.length === 0 && request.source.address.entity_kind === 'entity');
      const identity = { kind: 'adopt', request }, prior = this.#explorationPrior(context, services, identity);
      if (prior) return this.#returnExplorationPrior(context, services, prior, identity);
      const observation = inputs.preflight(context, identity);
      const shared = { source_fence: canonical.fence(context), origin_base: observation.origin_base,
        project_selection: observation.project_selection };
      graphAssert(shared.source_fence === request.expected_source_fence, 'stale_invalidation_fence');
      const proofs = this.#explorationProofs(context, canonical, shared);
      const sourceProofs = this.#explorationProofs(context, canonical, { ...shared, origin_base: request.source.shared_base });
      // Materialize public selected views before final admission. All authoritative
      // checks repeat through private selected readers under the Graph writer.
      const visible = this.resolveExploration(context, { exploration_id: request.source.exploration_id,
        at: request.source.at, address: request.source.address, shared_keys: null }, canonical_reader);
      graphAssert(visible.local?.status === 'resolved', 'graph_access_denied');
      const domainProof = services.contexts ? services.contexts.prepare(context, validateContextContent1(visible.local.revision.assertion.content)) : null;
      for (const mapping of request.endpoint_map) {
        const endpoint = this.resolveExploration(context, { exploration_id: request.destination.exploration_id,
          at: request.destination.expected_graph, address: mapping.destination, shared_keys: null }, canonical_reader);
        graphAssert(endpoint.local?.status === 'resolved', 'graph_access_denied');
      }
      const duplicate = tx => inputs.prior(tx, context, identity) ? { status: 'exploration_duplicate_recheck' } : null;
      const result = this.#view(context, 'graph:write', true, tx => {
        checkGraphFormat(tx); const committed = duplicate(tx); if (committed) return committed;
        inputs.grant(context, { write: true, adopt: true });
        services.contexts?.grant(context, { write: true });
        this.#assertExplorationProofs(tx, context, services, proofs);
        this.#assertExplorationProofs(tx, context, services, sourceProofs);
        const publisher = this.#inputs.publisher(context, request.publisher_ref, { epoch: request.epoch });
        const material = this.#adoptionMaterial(context, tx, services, request, publisher.run.execution_id);
        const { route } = inputs.adoption(tx, context, { request, observation, shared, adoption: material.adoption });
        const graphRequest = { epoch: request.epoch,
          idempotency_key: graphKey('exploration-graph', [route.scope, route.actor, request.idempotency_key]),
          publisher_ref: request.publisher_ref, expected_graph: request.destination.expected_graph,
          expected_source_fence: request.expected_source_fence, operation: material.operation, coverage: null };
        const changed = this.#mutateInView(context, tx, graphRequest, { inputs, route });
        graphAssert(changed.status === 'applied', 'graph_storage_conflict');
        const output = { ...changed, adoption: material.adoption };
        inputs.assertUnchanged(tx, context, route);
        this.#assertExplorationProofs(tx, context, services, proofs);
        this.#assertExplorationProofs(tx, context, services, sourceProofs);
        const after = this.#adoptionMaterial(context, tx, services, request, publisher.run.execution_id, { destinationWritten: true });
        graphAssert(graphEqual(after, material), 'exploration_corrupt');
        this.#contextResult(context, tx, services, domainProof, output);
        const saved = inputs.finish(tx, context, route, { result: output, graph_request: graphRequest });
        inputs.assertUnchanged(tx, context, route);
        this.#assertExplorationProofs(tx, context, services, proofs);
        this.#assertExplorationProofs(tx, context, services, sourceProofs);
        this.#sourceFence(context, request);
        this.#contextResult(context, tx, services, domainProof, saved.result);
        services.contexts?.grant(context, { write: true });
        return saved.result;
      }, request.epoch, duplicate, observation.execution);
      if (result.status !== 'exploration_duplicate_recheck') return result;
      const committed = this.#explorationPrior(context, services, identity);
      graphAssert(committed, 'exploration_corrupt');
      return this.#returnExplorationPrior(context, services, committed, identity);
    });
  }
  adoptExploration(context, options, canonical_reader) { return this.#adoptExploration(context, options, canonical_reader, false); }
  adoptContext(context, options, canonical_reader) { return this.#adoptExploration(context, options, canonical_reader, true); }
  #changeExploration(context, options, canonical_reader, kind, domain = false) {
    return this.#call(() => {
      const services = this.#explorationServices(canonical_reader, domain), { inputs, canonical } = services;
      const request = inputs.parse(kind, options); inputs.grant(context, { write: true });
      services.contexts?.grant(context, { write: true });
      if (domain) validateContextContent1(request.operation?.assertion?.content);
      const identity = { kind, request };
      const prior = this.#explorationPrior(context, services, identity);
      if (prior) return this.#returnExplorationPrior(context, services, prior, identity);
      const domainProof = services.contexts ? services.contexts.prepare(context, request.operation.assertion.content) : null;
      const observation = kind === 'selection' ? null : inputs.preflight(context, identity);
      const metadata = observation ?? this.#view(context, 'graph:read', false, tx => inputs.metadata(tx, context, identity));
      const shared = { source_fence: canonical.fence(context), origin_base: metadata.origin_base,
        project_selection: metadata.project_selection };
      if (kind === 'mutate') graphAssert(shared.source_fence === request.expected_source_fence, 'stale_invalidation_fence');
      // Changing the Project pointer verifies the newly declared selection. The
      // old pointer is only a CAS input; a revoked old selection can be replaced.
      const selectedShared = kind === 'selection' ? { ...shared, project_selection: {
        version: (request.expected_version ?? 0) + 1, pin: request.pin } } : shared;
      const proofs = this.#explorationProofs(context, canonical, selectedShared, { requireCurrent: kind === 'selection' });
      const duplicate = tx => inputs.prior(tx, context, identity) ? { status: 'exploration_duplicate_recheck' } : null;
      const result = this.#view(context, 'graph:write', true, tx => {
        checkGraphFormat(tx, { initialize: true });
        services.contexts?.grant(context, { write: true });
        const committed = duplicate(tx); if (committed) return committed;
        this.#assertExplorationProofs(tx, context, services, proofs);
        let routed, output;
        if (kind === 'selection') {
          routed = inputs.setProjectSelection(tx, context, { request, shared });
          output = { status: 'applied', version: routed.version, pin: routed.pin };
        } else if (kind === 'bind') {
          // An existing exploration rebind still needs a real current publisher.
          this.#inputs.publisher(context, request.publisher_ref, { epoch: request.epoch });
          routed = inputs.bind(tx, context, { request, observation, shared });
          const graphResult = routed.created
            ? this.#initializeInView(context, tx, routed.graph_request, { inputs, route: routed.route }) : null;
          const graph_revision = graphResult?.receipt.next_graph
            ?? this.#storage(tx, context, routed.generation_id, 'graph:write').head()?.value.head;
          graphAssert(graph_revision, 'graph_unavailable');
          const operation_origin_ref = graphResult?.operation_origin_ref ?? inputs.retainOrigin(tx, context, routed.route,
            { previous_graph: graph_revision, next_graph: graph_revision });
          output = { status: 'applied', exploration_id: routed.route.exploration_id, generation_id: routed.generation_id,
            execution_workspace_id: routed.route.execution_workspace_id, binding_version: routed.route.binding_version,
            graph_revision, operation_origin_ref };
        } else {
          routed = inputs.mutation(tx, context, { request, observation, shared });
          this.#contextOperation(context, tx, services, request.operation, request.expected_graph);
          output = this.#mutateInView(context, tx, routed.graph_request, { inputs, route: routed.route });
          if (output.status === 'graph_revision_mismatch') return { ...output, proposal: request };
        }
        inputs.assertUnchanged(tx, context, routed.route);
        this.#assertExplorationProofs(tx, context, services, proofs);
        this.#contextResult(context, tx, services, domainProof, output);
        const saved = inputs.finish(tx, context, routed.route, { result: output, graph_request: routed.graph_request ?? null });
        inputs.assertUnchanged(tx, context, routed.route);
        this.#assertExplorationProofs(tx, context, services, proofs);
        this.#contextResult(context, tx, services, domainProof, saved.result);
        services.contexts?.grant(context, { write: true });
        return { ...saved.result, receipt: saved.result.receipt ?? saved.receipt };
      }, request.epoch, duplicate, observation?.execution);
      if (result.status !== 'exploration_duplicate_recheck') return result;
      const committed = this.#explorationPrior(context, services, identity);
      graphAssert(committed, 'exploration_corrupt');
      return this.#returnExplorationPrior(context, services, committed, identity);
    });
  }
  bindExploration(context, options, canonical_reader) { return this.#changeExploration(context, options, canonical_reader, 'bind'); }
  mutateExploration(context, options, canonical_reader) { return this.#changeExploration(context, options, canonical_reader, 'mutate'); }
  mutateContext(context, options, canonical_reader) { return this.#changeExploration(context, options, canonical_reader, 'mutate', true); }
  setExplorationProjectSelection(context, options, canonical_reader) { return this.#changeExploration(context, options, canonical_reader, 'selection'); }
  #getExplorationReceipt(context, options, canonical_reader, domain) {
    return this.#call(() => {
      const input = graphInput(options); graphFields(input, ['idempotency_key']); graphId(input.idempotency_key);
      const services = this.#explorationServices(canonical_reader, domain);
      services.contexts?.grant(context);
      const prior = this.#explorationPrior(context, services, input);
      return prior ? this.#returnExplorationPrior(context, services, prior, { ...input, readOnly: true }) : null;
    });
  }
  getExplorationReceipt(context, options, canonical_reader) { return this.#getExplorationReceipt(context, options, canonical_reader, false); }
  getContextReceipt(context, options, canonical_reader) { return this.#getExplorationReceipt(context, options, canonical_reader, true); }
  getExplorationBinding(context, options, canonical_reader) {
    return this.#call(() => {
      const input = graphInput(options); graphFields(input, ['execution']);
      const { inputs } = this.#explorationServices(canonical_reader);
      return this.#view(context, 'graph:read', false, tx => inputs.getBinding(tx, context, input));
    });
  }
  listExplorations(context, options, canonical_reader) {
    return this.#call(() => {
      const input = graphInput(options); graphFields(input, ['cursor', 'limit']);
      const { inputs } = this.#explorationServices(canonical_reader);
      return this.#view(context, 'graph:read', false, tx => {
        const page = inputs.list(tx, context, input);
        return { ...page, items: page.items.map(item => {
          const head = this.#storage(tx, context, item.generation_id, 'graph:read').head();
          graphAssert(head, 'exploration_corrupt');
          return { ...item, graph_revision: head.value.head, maintenance: head.value.maintenance ? 'building' : null };
        }) };
      });
    });
  }
  #contextReadService(options, canonical_reader, kind) {
    try {
      // Preserve the public facade's request-first failure order without
      // moving the read workflow back out of the application service.
      validateContextReadRequest(options, kind);
      return this.#explorationServices(canonical_reader, true).contextReads;
    } catch (error) {
      const code = graphErrorCode(error);
      throw graphFail(CODES.has(code) ? code : 'invalid_graph_input');
    }
  }
  resolveContext(context, options, canonical_reader) {
    return this.#contextReadService(options, canonical_reader, 'resolve').resolve(context, options);
  }
  pageContexts(context, options, canonical_reader) {
    return this.#contextReadService(options, canonical_reader, 'page').page(context, options);
  }
  contextLineage(context, options, canonical_reader) {
    return this.#contextReadService(options, canonical_reader, 'lineage').lineage(context, options);
  }
  #readExploration(context, options, canonical_reader, paging, selectionOnly = false) {
    return this.#call(() => {
      const input = graphInput(options);
      graphFields(input, selectionOnly ? ['exploration_id', 'at'] : paging ? ['exploration_id', 'at', 'collection', 'cursor', 'limit', 'shared_keys']
        : ['exploration_id', 'at', 'address', 'shared_keys']);
      graphId(input.exploration_id); validateGraphCommitAddress2(input.at);
      if (paging) graphAssert(Number.isInteger(input.limit) && input.limit >= 1 && input.limit <= 32);
      const services = this.#explorationServices(canonical_reader), { inputs, canonical } = services;
      const metadata = this.#view(context, 'graph:read', false, tx => {
        const exploration = inputs.getExploration(tx, context, { exploration_id: input.exploration_id });
        graphAssert(exploration && exploration.generation_id === input.at.generation_id, 'exploration_unavailable');
        return { exploration, project: inputs.projectSelection(tx, context) };
      });
      const fence = canonical.fence(context);
      const origin = canonical.prepare(context, metadata.exploration.origin.shared_base);
      const project = canonical.prepare(context, metadata.project.pin);
      const localInput = Object.fromEntries(Object.entries(input).filter(([key]) => !['exploration_id', 'shared_keys'].includes(key)));
      return this.#view(context, 'graph:read', false, tx => {
        inputs.grant(context);
        graphAssert(graphEqual(metadata.exploration, inputs.getExploration(tx, context, { exploration_id: input.exploration_id }))
          && graphEqual(metadata.project, inputs.projectSelection(tx, context)), 'exploration_selection_conflict');
        this.#invalidations.assertFence(context, { sequence: fence });
        canonical.assert(tx, context, origin); canonical.assert(tx, context, project);
        let local = null;
        if (selectionOnly) {
          graphAssert(graphEqual(input.at.scope, this.#scope(context, 'graph:read')));
          const storage = this.#storage(tx, context, input.at.generation_id, 'graph:read');
          graphAssert(storage.fact({ at: input.at, kind: 'commit', key: [input.at.commit_digest] }).value, 'graph_unavailable');
          graphAssert(!storage.head().value.maintenance, 'graph_maintenance');
          // Validate the retained catalog behind the current selected Graph,
          // without selecting any unrelated local entity or source payload.
          this.#selected(context, tx, storage, { generation_id: input.at.generation_id });
        } else local = this.#readInView(context, tx, localInput, paging);
        // No previously materialized fragment is returned when final access changes.
        canonical.assert(tx, context, origin); canonical.assert(tx, context, project);
        this.#invalidations.assertFence(context, { sequence: fence });
        const origin_base = canonical.material(origin, selectionOnly ? null : input.shared_keys);
        const current_project = { ...canonical.material(project, selectionOnly ? null : input.shared_keys), version: metadata.project.version };
        const coverage = current_project.coverage;
        return { exploration_id: input.exploration_id, generation_id: input.at.generation_id, graph_revision: input.at,
          ...(selectionOnly ? {} : { local }), shared: { origin_base, current_project, coverage }, availability: {
            local: local?.status ?? 'selected', origin_base: origin_base.status, current_project: current_project.status } };
      });
    });
  }
  resolveExploration(context, options, canonical_reader) { return this.#readExploration(context, options, canonical_reader, false); }
  pageExploration(context, options, canonical_reader) { return this.#readExploration(context, options, canonical_reader, true); }
  getExplorationSelection(context, options, canonical_reader) { return this.#readExploration(context, options, canonical_reader, false, true); }
  getHead(context, options) {
    return this.#call(() => {
      const input = graphInput(options); graphFields(input, ['generation_id']); graphId(input.generation_id);
      return this.#view(context, 'graph:read', false, tx => {
        checkGraphFormat(tx); const head = this.#storage(tx, context, input.generation_id, 'graph:read').head();
        return { graph_revision: head?.value.head ?? null, maintenance: head?.value.maintenance ? 'building' : null };
      });
    });
  }
  getReceipt(context, options) {
    return this.#call(() => {
      const input = graphInput(options); graphFields(input, ['generation_id', 'idempotency_key']); graphId(input.generation_id); graphId(input.idempotency_key);
      return this.#view(context, 'graph:read', false, tx => { checkGraphFormat(tx); return this.#prior(context, tx, input.generation_id, input.idempotency_key)?.receipt ?? null; });
    });
  }
  #readInView(context, tx, input, paging) {
    checkGraphFormat(tx); graphAssert(graphEqual(input.at.scope, this.#scope(context, 'graph:read')));
    const storage = this.#storage(tx, context, input.at.generation_id, 'graph:read');
    const { port } = this.#selected(context, tx, storage, { generation_id: input.at.generation_id });
    try { return planner(() => paging ? pageIncrementalGraph(port, input) : resolveIncrementalGraph(port, input)); }
    catch (error) { if (!paging && graphErrorCode(error) === 'graph_access_denied') return { status: 'denied', revision: null }; throw error; }
  }
  #read(context, options, paging) {
    const input = graphInput(options); graphFields(input, paging ? ['at', 'collection', 'cursor', 'limit'] : ['at', 'address']); validateGraphCommitAddress2(input.at);
    return this.#view(context, 'graph:read', false, tx => {
      return this.#readInView(context, tx, input, paging);
    });
  }
  resolve(context, options) { return this.#call(() => this.#read(context, options, false)); }
  page(context, options) { return this.#call(() => this.#read(context, options, true)); }
  rebuildProjection(context, options) {
    return this.#call(() => {
      const input = graphInput(options); graphFields(input, ['generation_id', 'expected_graph', 'epoch', 'cursor', 'limit']);
      graphId(input.generation_id); graphUint(input.epoch); validateGraphCommitAddress2(input.expected_graph);
      graphAssert(input.generation_id === input.expected_graph.generation_id && Number.isInteger(input.limit) && input.limit >= 1 && input.limit <= 64);
      graphAssert(graphEqual(input.expected_graph.scope, this.#scope(context, 'graph:rebuild', { write: true, owner: true })));
      return this.#view(context, 'graph:rebuild', true, tx => {
        checkGraphFormat(tx); const storage = this.#storage(tx, context, input.generation_id, 'graph:rebuild');
        const result = storage.rebuildStep({ expected_graph: input.expected_graph, cursor: input.cursor, limit: input.limit });
        return { status: result.status, cursor: result.cursor, processed: result.processed, total: result.total, graph_revision: result.head };
      }, input.epoch);
    });
  }
}
