import { DomainStore } from '../adapters/sqlite/domain-store.mjs';
import { AccessAuthority, LOCAL_AUDIENCE } from '../domain/identity/access-authority.mjs';
import { DurableIngress } from './durable-ingress.mjs';
import { ProjectActivation } from './project-activation.mjs';
import { LocalExplorationStore } from './exploration-store.mjs';
import { LocalContextStore } from '../application/context/context-store.mjs';
import { readContextSelection } from '../application/context/context-reader.mjs';
import { composeLocalServices } from './local-runtime-composition.mjs';
import { GraphStorage } from '../adapters/sqlite/graph-storage.mjs';
import { SourceInvalidationFeed } from './source-invalidation.mjs';
import { GraphInputs, graphInput, graphFields, graphEqual, graphHash, graphId, graphErrorCode } from './graph-inputs.mjs';
import { canonical, FAMILIES, judgeInputHash } from '../core/contracts.mjs';
import { scopedReference } from '../core/service-access.mjs';
import { effectiveEventAccess, eventObservationKey, verifyEventPayload } from '../core/event-provenance.mjs';
import { validateGraphCommitAddress2 } from '../core/incremental-graph.mjs';
import { exactRevisionAddress, validateSemanticAddress } from '../core/working-graph.mjs';
import { validateContextContent1 } from '../core/context-profile.mjs';

const ACTIONS = ['judge:execute', 'model:dispatch', 'source:read', 'store:read', 'store:write', 'ingress:read',
  'graph:read', 'exploration:read', 'source:invalidation:read', 'project:inspect', 'activation:admit'];
const PROVIDERS = ['typesafe', 'vercel', 'openrouter'];
const SENSITIVITY = ['normal', 'sensitive', 'restricted'];
const MAPPED = ['INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'];
const CONTEXT_PROFILE = Object.freeze({ id: 'runtime-context', version: 1 });
const fail = code => Object.assign(new Error(`Judge inputs: ${code}`), { code });
const check = (ok, code = 'invalid_judge_input') => { if (!ok) throw fail(code); };
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const copy = value => freeze(graphInput(value));
const safeCode = error => { const code = graphErrorCode(error); return code && /^[a-z_]{1,80}$/.test(code) ? code : 'invalid_judge_input'; };
const bytes = (text, max) => check(typeof text === 'string' && text.trim().length > 0 && Buffer.byteLength(text) <= max, 'judge_input_capacity');
const summary = value => Object.fromEntries(['pin', 'status', 'configured_record_keys', 'selected_record_keys',
  'returned_record_keys', 'authority_record_keys', 'coverage', 'version'].filter(k => Object.hasOwn(value, k)).map(k => [k, value[k]]));

/** Fixed local composition. Its private proof, never wire JSON, authorizes each send/result. */
export class JudgeInputs {
  #store; #authority; #config; #explorations; #contexts; #contextInputs; #metadata; #canonical; #graph; #ingress; #activation; #feed; #proofs = new WeakMap();
  constructor({ store, authority, canonical_reader, configuration }) {
    check(store instanceof DomainStore && authority instanceof AccessAuthority);
    this.#config = copy(configuration);
    graphFields(this.#config.scope, ['tenant_id', 'project_id']); Object.values(this.#config.scope).forEach(graphId);
    check(this.#config.egress_policy && Array.isArray(this.#config.egress_policy.sources) && this.#config.egress_policy.sources.length <= 32);
    this.#store = store; this.#authority = authority;
    this.#graph = new GraphInputs({ store, authority });
    const services = composeLocalServices({ store, authority, canonical_reader });
    this.#canonical = services.canonical;
    this.#metadata = services.inputs;
    this.#explorations = new LocalExplorationStore({ store, authority, canonical_reader });
    this.#contexts = new LocalContextStore({ store, authority, canonical_reader });
    this.#contextInputs = services.contexts;
    this.#ingress = new DurableIngress({ store, authority }); this.#feed = new SourceInvalidationFeed({ store, authority });
    this.#activation = new ProjectActivation({ store, authority });
  }
  get canonical_config_digest() { return this.#canonical.config_digest; }
  #call(fn) { try { return fn(); } catch (error) { throw fail(safeCode(error)); } }
  // Preserve only bounded domain codes across DomainStore's deliberately opaque error boundary.
  #view(context, fn, admission = null) {
    let code;
    const run = tx => { try { return fn(tx); } catch (error) { code = safeCode(error); throw error; } };
    try {
      if (!admission) return this.#store.readSnapshot(context, run);
      const result = this.#activation.withAdmission(context, admission, run);
      check(result.admitted, result.reason); return result.value;
    } catch (error) { throw fail(code ?? safeCode(error)); }
  }
  grant(context) {
    return this.#call(() => {
      const g = this.#authority.inspect(context);
      check(g && g.audience === LOCAL_AUDIENCE && ['human', 'service'].includes(g.kind)
        && ACTIONS.every(action => g.actions.includes(action)) && graphEqual(this.#config.scope,
        { tenant_id: g.tenant_id, project_id: g.project_id }), 'judge_unauthorized');
      return copy({ scope: this.#config.scope, actor: g.principal_id, actor_kind: g.kind });
    });
  }
  #request(options) {
    const r = graphInput(options);
    graphFields(r, ['invocation_id', 'node_id', 'epoch', 'execution', 'exploration_id', 'execution_workspace_id',
      'expected_binding_version', 'expected_catalog_version', 'expected_project_selection_version', 'at', 'event_id', 'target_refs', 'expected_source_fence']);
    for (const k of ['invocation_id', 'node_id', 'exploration_id', 'execution_workspace_id', 'event_id']) graphId(r[k]);
    graphFields(r.execution, ['repository_id', 'checkout_id', 'worktree_id']); Object.values(r.execution).forEach(graphId);
    check(Number.isSafeInteger(r.epoch) && r.epoch >= 0 && Number.isSafeInteger(r.expected_source_fence) && r.expected_source_fence >= 0);
    for (const k of ['expected_binding_version', 'expected_catalog_version']) check(Number.isSafeInteger(r[k]) && r[k] > 0);
    check(r.expected_project_selection_version === null || Number.isSafeInteger(r.expected_project_selection_version) && r.expected_project_selection_version > 0);
    validateGraphCommitAddress2(r.at); check(graphEqual(r.at.scope, this.#config.scope), 'judge_unauthorized');
    check(Array.isArray(r.target_refs) && r.target_refs.length <= 32, 'judge_input_capacity');
    for (const ref of r.target_refs) {
      validateSemanticAddress(ref);
      check(ref.kind === 'semantic_revision' && ref.entity_kind === 'entity' && ref.generation_id === r.at.generation_id
        && graphEqual(ref.scope, r.at.scope), 'judge_target_invalid');
    }
    r.target_refs.sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);
    check(new Set(r.target_refs.map(canonical)).size === r.target_refs.length, 'judge_target_invalid'); return freeze(r);
  }
  #endpoints(tx, context, r) {
    const binding = this.#metadata.getBinding(tx, context, { execution: r.execution });
    check(binding.status === 'bound' && binding.binding_version === r.expected_binding_version
      && binding.binding?.execution_workspace_id === r.execution_workspace_id
      && binding.binding.exploration_id === r.exploration_id && binding.binding.generation_id === r.at.generation_id,
    'exploration_binding_conflict');
    check(binding.observed_catalog_version === r.expected_catalog_version, 'exploration_catalog_conflict');
    const exploration = this.#metadata.getExploration(tx, context, { exploration_id: r.exploration_id });
    check(exploration && exploration.generation_id === r.at.generation_id, 'exploration_unavailable');
    const project = this.#metadata.projectSelection(tx, context);
    check(project.version === r.expected_project_selection_version, 'exploration_selection_conflict');
    const storage = new GraphStorage({ view: tx, scope: this.#config.scope, generation_id: r.at.generation_id }), head = storage.head();
    check(head && graphEqual(head.value.head, r.at), 'judge_graph_changed');
    check(head.value.maintenance === null, 'graph_maintenance');
    const commit = storage.fact({ at: r.at, kind: 'commit', key: [r.at.commit_digest] }).value;
    check(commit, 'graph_unavailable');
    const catalog = this.#graph.catalogFromPin(context, commit.catalog_pin); check(catalog, 'graph_corrupt');
    this.#feed.assertFence(context, { sequence: r.expected_source_fence });
    return { binding, exploration, project, head, catalog };
  }
  #support(context, event, grant) {
    const bundle = this.#ingress.readEvent(context, { event_id: event.event_id });
    check(graphEqual(bundle.event, event) && bundle.receipt.event_digest === graphHash(event), 'judge_source_changed');
    check(graphEqual({ tenant_id: event.partition.tenant_id, project_id: event.partition.project_id }, grant.scope), 'judge_unauthorized');
    const registration = this.#ingress.getRegistration(context, { registration_id: bundle.receipt.registration_id });
    const policy = this.#config.egress_policy.sources.find(p => p.registration_id === registration.registration_id);
    check(policy && policy.text_policy === 'selected-fields', 'judge_source_policy_denied');
    const effective = effectiveEventAccess(event), current = registration.registration.access;
    const principals = effective.allowed_principal_ids.filter(id => current.allowed_principal_ids.includes(id));
    check(principals.includes(grant.actor), 'source_access_denied');
    const capturedLevel = SENSITIVITY.indexOf(effective.sensitivity), currentLevel = SENSITIVITY.indexOf(current.sensitivity);
    check(capturedLevel >= 0 && currentLevel >= 0, 'judge_source_policy_denied');
    const source = { reference: scopedReference('object', grant.scope, event.event_id),
      acl: { revision: graphHash({ event_digest: bundle.receipt.event_digest, effective, registration_version: registration.version,
        registration_id: registration.registration_id }), allowed_principal_ids: principals },
      sensitivity: MAPPED[Math.max(capturedLevel, currentLevel)], local_only: policy.local_only, allowed_providers: policy.allowed_providers };
    return { event, receipt: bundle.receipt, registration, source };
  }
  #snapshot(context, event) {
    const snapshot = this.#ingress.readSnapshot(context, { event_id: event.event_id });
    check(snapshot && event.payload.kind === 'snapshot' && snapshot.snapshot_id === event.payload.snapshot_id, 'judge_snapshot_unavailable');
    bytes(snapshot.text, 16384); verifyEventPayload(event.payload, Buffer.from(snapshot.text, 'utf8')); return snapshot;
  }
  #assert(tx, context, proof, provider = undefined) {
    check(context === proof.context && graphEqual(this.grant(context), proof.grant), 'judge_unauthorized');
    if (proof.contextTargets) this.#contextInputs.grant(context);
    check(graphEqual(this.#endpoints(tx, context, proof.request), proof.endpoints), 'judge_selection_changed');
    this.#canonical.assert(tx, context, proof.origin); this.#canonical.assert(tx, context, proof.project);
    const storage = new GraphStorage({ view: tx, scope: this.#config.scope, generation_id: proof.request.at.generation_id });
    for (const revision of proof.revisions) check(graphEqual(storage.fact({ at: proof.request.at, kind: 'revision',
      key: [revision.revision_digest] }).value, revision), 'judge_target_invalid');
    for (const target of proof.contextTargets ?? []) {
      const selected = readContextSelection({ view: tx, context, inputs: this.#graph, explorations: this.#metadata,
        config_digest: this.#canonical.config_digest, request: target.request, kind: 'resolve',
        read_pins: { project_selection: proof.endpoints.project, source_fence: proof.request.expected_source_fence } });
      this.#contextTarget(selected.local, target.item.ref);
      check(selected.revisions.length === 1 && graphEqual(selected.revisions[0], target.revision), 'judge_target_invalid');
      const applicability = this.#contextInputs.assert(tx, context, target.proof,
        { assertion: target.revision.assertion, provenance: target.revision.provenance });
      const item = { ...selected.local.item, applicability: { ...applicability,
        scope: proof.grant.scope, exploration_id: proof.request.exploration_id } };
      const { source_heads, ...selection } = selected.selection;
      check(graphEqual(item, target.item) && graphEqual(selection, target.selection)
        && source_heads.length === 1 && graphEqual(source_heads[0], {
          generation_id: proof.request.at.generation_id, head: proof.request.at }), 'judge_selection_changed');
    }
    const sources = proof.supports.map(support => {
      const current = this.#support(context, support.event, proof.grant);
      check(graphEqual(current, support), 'judge_source_changed'); return current.source;
    });
    check(graphEqual(this.#snapshot(context, proof.event), proof.snapshot), 'judge_source_changed');
    if (provider !== undefined) {
      const decision = this.#authority.materialize(context, { scope: this.#config.scope, sources,
        destination: provider === null ? { kind: 'local' } : { kind: 'provider', provider }, tenant_policy: this.#config.egress_policy });
      check(decision.allowed, `judge_${decision.reason}`);
    }
    check(graphEqual(this.#endpoints(tx, context, proof.request), proof.endpoints), 'judge_selection_changed');
    check(graphEqual(this.grant(context), proof.grant), 'judge_unauthorized');
    if (proof.contextTargets) this.#contextInputs.grant(context);
  }
  #contextTarget(local, ref) {
    const item = local.item, allowed = ['candidate', 'validated', 'resolved'];
    check(local.status === 'resolved' && item && graphEqual(item.ref, ref)
      && allowed.includes(item.assertion_status) && allowed.includes(item.projection.status)
      && item.projection.quarantined === false && item.projection.competing.length === 0
      && graphEqual(item.projection.head, ref) && item.historical_role === 'head', 'judge_target_invalid');
    return validateContextContent1({ semantic_type: 'context', data: item.meaning });
  }
  prepare(context, request, { family, question } = {}) {
    return this.#call(() => {
      const grant = this.grant(context), r = this.#request(request), q = graphInput(question);
      graphFields(q, ['family', 'text']); check(FAMILIES.includes(family) && q.family === family); bytes(q.text, 4096);
      const targetKind = { acceptance_relevance: 'acceptance', context_relevance: 'context' }[family] ?? null;
      check(targetKind !== null || r.target_refs.length === 0, 'judge_target_invalid');
      const endpoints = this.#view(context, tx => this.#endpoints(tx, context, r));
      const selected = this.#explorations.getSelection(context, { exploration_id: r.exploration_id, at: r.at });
      const origin = this.#canonical.prepare(context, endpoints.exploration.origin.shared_base);
      const project = this.#canonical.prepare(context, endpoints.project.pin, { requireCurrent: endpoints.project.pin !== null });
      check(endpoints.exploration.origin.shared_base === null || ['current', 'historical'].includes(this.#canonical.status(origin)), 'canonical_source_unavailable');
      const revisions = [], stateRefs = [], target_map = [], events = new Map();
      const event = this.#ingress.readEvent(context, { event_id: r.event_id }).event;
      const addEvent = value => {
        const key = eventObservationKey(value), prior = events.get(key);
        check(!prior || graphEqual(prior, value), 'judge_source_changed'); events.set(key, value);
        check(events.size <= 32, 'judge_input_capacity');
      };
      addEvent(event);
      for (const ref of r.target_refs) {
        const view = this.#explorations.resolve(context, { exploration_id: r.exploration_id, at: r.at, address: ref, shared_keys: [] });
        const local = view.local, revision = local.revision;
        check(local.status === 'resolved' && revision && local.entity?.status === 'candidate'
          && graphEqual(local.entity.head, ref) && local.entity.competing.length === 0
          && revision.assertion.entity_kind === 'entity' && revision.assertion.status === 'candidate'
          && graphEqual(exactRevisionAddress(revision), ref) && revision.assertion.content.semantic_type === 'judge-target', 'judge_target_invalid');
        const data = revision.assertion.content.data;
        graphFields(data, ['schema_version', 'kind', 'target_kind', 'text']);
        check(data.schema_version === 1 && data.kind === 'judge_target' && data.target_kind === targetKind, 'judge_target_invalid'); bytes(data.text, 4096);
        const id = `target-${graphHash(ref).slice(7)}`;
        stateRefs.push({ id, type: data.target_kind, text: data.text }); target_map.push({ id, ref }); revisions.push(revision);
        [...revision.provenance.events, ...revision.provenance.access_events].forEach(addEvent);
      }
      const supports = [...events.values()].sort((a, b) => eventObservationKey(a).localeCompare(eventObservationKey(b))).map(e => this.#support(context, e, grant));
      check(new Set(supports.map(s => s.registration.registration_id)).size <= 32, 'judge_input_capacity');
      const snapshot = this.#snapshot(context, event);
      const proof = { context, grant, request: r, endpoints, origin, project, supports, revisions, snapshot, event };
      this.#view(context, tx => this.#assert(tx, context, proof));
      const input = { event: { type: event.event_type, timestamp: event.observed_at, payload: { text: snapshot.text } }, stateRefs, question: q };
      check(Buffer.byteLength(JSON.stringify(input)) <= 65536, 'judge_input_capacity');
      const registrations = [...new Map(supports.map(s => [s.registration.registration_id,
        { registration_id: s.registration.registration_id, version: s.registration.version }])).values()].sort((a, b) => a.registration_id.localeCompare(b.registration_id));
      const selection = { scope: grant.scope, epoch: r.epoch, exploration_id: r.exploration_id, generation_id: r.at.generation_id,
        execution: r.execution, execution_workspace_id: r.execution_workspace_id, binding_version: r.expected_binding_version,
        catalog_version: r.expected_catalog_version, project_selection_version: r.expected_project_selection_version,
        graph_revision: r.at, source_fence: r.expected_source_fence, registrations,
        shared: { origin_base: summary(selected.shared.origin_base), current_project: summary(selected.shared.current_project), coverage: selected.shared.coverage },
        governance_evaluated: false, shared_material_sent: false };
      const prepared = copy({ input, input_hash: judgeInputHash(input), selection, target_refs: r.target_refs, target_map,
        event_ref: { kind: 'event_ref', observation_key: eventObservationKey(event), event_digest: graphHash(event) },
        selection_ref: { kind: 'signal_ref', digest: graphHash(r) } });
      this.#proofs.set(prepared, proof); return prepared;
    });
  }
  prepareContext(context, request, { family, question } = {}) {
    return this.#call(() => {
      const grant = this.grant(context); this.#contextInputs.grant(context);
      const r = this.#request(request), q = graphInput(question);
      graphFields(q, ['family', 'text']);
      check(family === 'context_relevance' && q.family === family, 'judge_target_invalid'); bytes(q.text, 4096);
      check(r.target_refs.length <= 8, 'judge_input_capacity');
      const endpoints = this.#view(context, tx => this.#endpoints(tx, context, r));
      const selected = this.#explorations.getSelection(context, { exploration_id: r.exploration_id, at: r.at });
      const origin = this.#canonical.prepare(context, endpoints.exploration.origin.shared_base);
      const project = this.#canonical.prepare(context, endpoints.project.pin, { requireCurrent: endpoints.project.pin !== null });
      check(endpoints.exploration.origin.shared_base === null || ['current', 'historical'].includes(this.#canonical.status(origin)), 'canonical_source_unavailable');
      const contextTargets = [], stateRefs = [], target_map = [], events = new Map(), ticketRefs = new Map(), ticketPins = new Set();
      const event = this.#ingress.readEvent(context, { event_id: r.event_id }).event;
      const addEvent = value => {
        const key = eventObservationKey(value), prior = events.get(key);
        check(!prior || graphEqual(prior, value), 'judge_source_changed'); events.set(key, value);
        check(events.size <= 32, 'judge_input_capacity');
      };
      addEvent(event);
      // Inspect at most eight immutable shapes before canonical preparation so
      // a ninth distinct Ticket selection never starts another selected read.
      // These private bytes convey no authorization; every entry still passes
      // the public Context reader and the fixed admitted proof below.
      const inventory = this.#view(context, tx => {
        const storage = new GraphStorage({ view: tx, scope: grant.scope, generation_id: r.at.generation_id });
        return r.target_refs.map(ref => {
          const revision = storage.fact({ at: r.at, kind: 'revision', key: [ref.revision_digest] }).value;
          check(revision && graphEqual(exactRevisionAddress(revision), ref)
            && revision.assertion.content.semantic_type === 'context'
            && revision.assertion.content.data?.kind === 'runtime_context', 'judge_target_invalid');
          return { ref, revision, content: validateContextContent1(revision.assertion.content) };
        });
      });
      for (const { content } of inventory) {
        for (const ticket of content.data.applicability.tickets.refs) {
          ticketRefs.set(canonical(ticket), ticket); ticketPins.add(canonical([ticket.at, ticket.address]));
          check(ticketPins.size <= 8, 'judge_input_capacity');
        }
      }
      for (const { ref, revision, content } of inventory) {
        const targetRequest = { exploration_id: r.exploration_id, at: r.at, address: ref, mode: 'current' };
        const visible = this.#contexts.resolve(context, targetRequest);
        check(graphEqual(this.#contextTarget(visible.local, ref), content), 'judge_target_invalid');
        const text = `${content.data.role}\n${content.data.summary}\n\n${content.data.detail}`; bytes(text, 4096);
        const id = `target-${graphHash(ref).slice(7)}`;
        stateRefs.push({ id, type: 'context', text }); target_map.push({ id, ref });
        contextTargets.push({ request: targetRequest, item: visible.local.item, selection: visible.selection, revision, content });
        [...revision.provenance.events, ...revision.provenance.access_events].forEach(addEvent);
      }
      const batch = [...ticketRefs.values()];
      for (const target of contextTargets) target.proof = this.#contextInputs.prepare(context, target.content, batch);
      const supports = [...events.values()].sort((a, b) => eventObservationKey(a).localeCompare(eventObservationKey(b))).map(e => this.#support(context, e, grant));
      check(new Set(supports.map(s => s.registration.registration_id)).size <= 32, 'judge_input_capacity');
      const snapshot = this.#snapshot(context, event), revisions = contextTargets.map(target => target.revision);
      const proof = { context, grant, request: r, endpoints, origin, project, supports, revisions, snapshot, event, contextTargets };
      this.#view(context, tx => this.#assert(tx, context, proof));
      const input = { event: { type: event.event_type, timestamp: event.observed_at, payload: { text: snapshot.text } }, stateRefs, question: q };
      check(Buffer.byteLength(JSON.stringify(input)) <= 65536, 'judge_input_capacity');
      const registrations = [...new Map(supports.map(s => [s.registration.registration_id,
        { registration_id: s.registration.registration_id, version: s.registration.version }])).values()].sort((a, b) => a.registration_id.localeCompare(b.registration_id));
      const selection = { scope: grant.scope, epoch: r.epoch, exploration_id: r.exploration_id, generation_id: r.at.generation_id,
        execution: r.execution, execution_workspace_id: r.execution_workspace_id, binding_version: r.expected_binding_version,
        catalog_version: r.expected_catalog_version, project_selection_version: r.expected_project_selection_version,
        graph_revision: r.at, source_fence: r.expected_source_fence, registrations,
        shared: { origin_base: summary(selected.shared.origin_base), current_project: summary(selected.shared.current_project), coverage: selected.shared.coverage },
        governance_evaluated: false, shared_material_sent: false, input_profile: CONTEXT_PROFILE,
        context_targets: contextTargets.map(({ item }) => ({ ref: item.ref, assertion_status: item.assertion_status,
          projection_status: item.projection.status, applicability: item.applicability,
          publication_origin_ref: item.publication.operation_origin_ref })) };
      const prepared = copy({ input, input_hash: judgeInputHash(input), selection, target_refs: r.target_refs, target_map,
        event_ref: { kind: 'event_ref', observation_key: eventObservationKey(event), event_digest: graphHash(event) },
        selection_ref: { kind: 'signal_ref', digest: graphHash([CONTEXT_PROFILE, r]) } });
      this.#proofs.set(prepared, proof); return prepared;
    });
  }
  admit(context, prepared, options) {
    return this.#call(() => {
      const o = graphInput(options); graphFields(o, ['stage', 'provider']);
      check(['dispatch', 'result'].includes(o.stage) && (o.provider === null || PROVIDERS.includes(o.provider)));
      const proof = prepared && typeof prepared === 'object' && this.#proofs.get(prepared); check(proof, 'invalid_judge_proof');
      // All selected public materialization was synchronous and completed outside
      // this transaction. Only our fixed private proof reads the admitted view.
      this.#view(context, tx => this.#assert(tx, context, proof, o.provider), { epoch: proof.request.epoch, stage: o.stage, execution: proof.request.execution });
      return prepared;
    });
  }
}
