import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { DomainStore } from '../../adapters/sqlite/domain-store.mjs';
import { AccessAuthority, LOCAL_AUDIENCE } from '../../domain/identity/access-authority.mjs';
import { GitProjectRegistry } from '../../adapters/git/git-projects.mjs';
import { DurableIngress, INGRESS_NAMESPACE } from '../project/durable-ingress.mjs';
import { SourceInvalidationFeed, sourceLifecycleInvalidationId } from '../sources/source-invalidation.mjs';
import { canonical, fingerprint } from '../../domain/shared/contracts.mjs';
import { validateIdentityCatalog } from '../../domain/identity/identity.mjs';
import { validateNormalizedEvent, eventObservationKey, effectiveEventAccess } from '../../domain/sources/event-provenance.mjs';
import { projectFreshness, sourcePartitionKey } from '../../domain/sources/causal-ordering.mjs';

// Internal fixed domain helpers, shared only with the authenticated facade.
export const GRAPH_NS = 'working-graph';
export const graphFail = code => Object.assign(new Error(`Local Graph: ${code}`), { code, category: ['store_busy', 'store_unavailable', 'store_closed'].includes(code) ? 'retryable_failure' : 'rejected' });
export const graphAssert = (ok, code = 'invalid_graph_input') => { if (!ok) throw graphFail(code); };
export const graphHash = value => `sha256:${fingerprint(value)}`;
export const graphKey = (kind, value) => `${kind}/${fingerprint(value)}`;
export const graphEqual = (a, b) => canonical(a) === canonical(b);
export const graphId = value => graphAssert(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(value));
export const graphUint = value => graphAssert(Number.isSafeInteger(value) && value >= 0);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export function graphInput(value) {
  const stack = new Set(); let nodes = 0;
  const visit = (v, depth) => {
    graphAssert(++nodes <= 50000 && depth < 16, 'graph_capacity');
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number') { graphAssert(Number.isFinite(v)); return; }
    graphAssert(!types.isProxy(v) && (plain(v) || Array.isArray(v) && Object.getPrototypeOf(v) === Array.prototype) && !stack.has(v));
    graphAssert(Object.getOwnPropertySymbols(v).length === 0);
    for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
      if (Array.isArray(v) && key === 'length') continue;
      graphAssert(Object.hasOwn(d, 'value') && d.enumerable);
      graphAssert(!Array.isArray(v) || /^(0|[1-9]\d*)$/.test(key) && Number(key) < v.length);
    }
    if (Array.isArray(v)) graphAssert(Object.keys(v).length === v.length);
    stack.add(v); Object.values(v).forEach(x => visit(x, depth + 1)); stack.delete(v);
  };
  visit(value, 0); graphAssert(Buffer.byteLength(JSON.stringify(value)) <= 1048576, 'graph_capacity');
  return JSON.parse(canonical(value));
}
export function graphFields(value, required, optional = []) {
  graphAssert(plain(value) && required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => required.includes(k) || optional.includes(k)));
}
export function graphErrorCode(error) {
  if (!error || typeof error !== 'object' || types.isProxy(error)) return null;
  const d = Object.getOwnPropertyDescriptor(error, 'code'); return d && Object.hasOwn(d, 'value') && typeof d.value === 'string' ? d.value : null;
}
const scopeOf = g => ({ tenant_id: g.tenant_id, project_id: g.project_id });
const fact = (kind, tuple, value) => ({ id: graphKey(kind, tuple), kind, value });
const catalogFact = catalog => {
  validateIdentityCatalog(catalog); const digest = graphHash(catalog);
  return { pin: { revision_id: `catalog-${digest.slice(7)}`, digest }, catalog };
};
const catalogDescriptor = cf => fact('graph-catalog', cf.pin, cf);
const publisherKey = (grant, key) => graphKey('publisher', [1, scopeOf(grant), grant.principal_id, key]);
const admittedKey = observation => graphKey('accepted-event', observation);
function publisherShape(run) {
  graphFields(run, ['schema_version', 'kind', 'publisher_ref', 'scope', 'actor', 'actor_kind', 'run_key', 'epoch', 'installation_id', 'workspace_id', 'session_id', 'execution_id']);
  graphAssert(run.schema_version === 1 && run.kind === 'runtime_publication_run' && ['human', 'service'].includes(run.actor_kind), 'graph_corrupt');
  graphFields(run.scope, ['tenant_id', 'project_id']);
  [run.scope.tenant_id, run.scope.project_id, run.publisher_ref, run.actor, run.run_key, run.installation_id, run.workspace_id, run.session_id, run.execution_id].forEach(graphId); graphUint(run.epoch);
  graphAssert(run.publisher_ref === graphKey('publisher', [1, run.scope, run.actor, run.run_key]), 'graph_corrupt');
}

/** Actual local authority, Git enrollment and ingress facts; never a client-supplied oracle. */
export class GraphInputs {
  #store; #authority; #registry; #ingress; #invalidations;
  constructor({ store, authority }) {
    graphAssert(store instanceof DomainStore && authority instanceof AccessAuthority);
    this.#store = store; this.#authority = authority;
    this.#registry = new GitProjectRegistry({ store, authority });
    this.#ingress = new DurableIngress({ store, authority });
    this.#invalidations = new SourceInvalidationFeed({ store, authority });
  }
  grant(context, action, { write = false, owner = false } = {}) {
    const g = this.#authority.inspect(context);
    graphAssert(g && g.audience === LOCAL_AUDIENCE && g.actions.includes(action) && g.actions.includes('store:read')
      && (!write || g.actions.includes('store:write')) && (!owner || ['human', 'service'].includes(g.kind)), 'graph_unauthorized');
    return g;
  }
  #current(context) {
    const catalog = graphInput(this.#registry.identityCatalog(context)); validateIdentityCatalog(catalog);
    const g = this.#authority.inspect(context), project = catalog.projects.find(p => p.tenant_id === g.tenant_id && p.project_id === g.project_id);
    const installs = catalog.source_installations.filter(i => i.tenant_id === g.tenant_id && i.kind === 'local' && i.project_ids.includes(g.project_id));
    graphAssert(project && installs.length === 1, 'graph_publisher_unavailable');
    return { catalog, installation_id: installs[0].source_installation_id, workspace_id: project.workspace_id };
  }
  registration(context, { epoch, run_key }) {
    const g = this.grant(context, 'graph:publish', { owner: true });
    const row = this.#store.getSource(context, GRAPH_NS, publisherKey(g, run_key));
    if (!row) return null;
    const r = row.value; publisherShape(r);
    graphAssert(row.kind === 'graph-publisher' && r.run_key === run_key && r.epoch === epoch && graphEqual(r.scope, scopeOf(g))
      && r.actor === g.principal_id && r.actor_kind === g.kind, 'graph_idempotency_conflict');
    return { status: 'duplicate', publisher_ref: r.publisher_ref, session_id: r.session_id, execution_id: r.execution_id, epoch: r.epoch };
  }
  registerPublisher(tx, context, { epoch, run_key }) {
    const g = this.grant(context, 'graph:publish', { write: true, owner: true });
    const prior = this.registration(context, { epoch, run_key }); if (prior) return prior;
    const { installation_id, workspace_id } = this.#current(context), publisher_ref = publisherKey(g, run_key);
    const run = { schema_version: 1, kind: 'runtime_publication_run', publisher_ref, scope: scopeOf(g), actor: g.principal_id, actor_kind: g.kind,
      run_key, epoch, installation_id, workspace_id, session_id: `runtime-session-${randomUUID()}`, execution_id: `runtime-execution-${randomUUID()}` };
    tx.appendSource(GRAPH_NS, publisher_ref, 'graph-publisher', run);
    return { status: 'registered', publisher_ref, session_id: run.session_id, execution_id: run.execution_id, epoch };
  }
  publisher(context, publisher_ref, { epoch }) {
    const g = this.grant(context, 'graph:write', { write: true, owner: true }); graphId(publisher_ref);
    const stored = this.#store.getSource(context, GRAPH_NS, publisher_ref), run = stored?.value;
    if (run) publisherShape(run);
    graphAssert(stored?.kind === 'graph-publisher' && run.publisher_ref === publisher_ref && graphEqual(run.scope, scopeOf(g))
      && run.actor === g.principal_id && run.actor_kind === g.kind && run.epoch === epoch, 'graph_publisher_unavailable');
    const { catalog, installation_id, workspace_id } = this.#current(context);
    graphAssert(run.installation_id === installation_id && run.workspace_id === workspace_id, 'graph_publisher_unavailable');
    catalog.sessions = [{ tenant_id: g.tenant_id, project_id: g.project_id, source_installation_id: installation_id,
      session_id: run.session_id, attributes: { purpose: 'runtime_semantic_publication', attribution: 'logical_runtime_run' } }];
    catalog.executions = [{ tenant_id: g.tenant_id, session_id: run.session_id, execution_id: run.execution_id,
      attributes: { purpose: 'runtime_semantic_publication', attribution: 'logical_runtime_run' } }];
    const cf = catalogFact(catalog); return { run, catalogFact: cf, facts: [catalogDescriptor(cf)] };
  }
  catalogFromPin(context, pin) {
    const row = this.#store.getSource(context, GRAPH_NS, graphKey('graph-catalog', pin)); if (!row) return null;
    graphAssert(row.kind === 'graph-catalog' && graphEqual(row.value.pin, pin) && graphHash(row.value.catalog) === pin.digest, 'graph_corrupt');
    validateIdentityCatalog(row.value.catalog); return row.value;
  }
  acceptedEvent(context, observation) {
    this.grant(context, 'ingress:read');
    let tuple; try { tuple = JSON.parse(observation); } catch { throw graphFail('invalid_graph_input'); }
    const g = this.#authority.inspect(context);
    graphAssert(Array.isArray(tuple) && tuple.length === 4 && tuple[0] === 1 && tuple[1] === 'observation' && tuple[2] === g.tenant_id);
    graphId(tuple[3]);
    let bundle;
    try { bundle = this.#ingress.readEvent(context, { event_id: tuple[3] }); }
    catch (error) { if (graphErrorCode(error) === 'source_access_denied') throw graphFail('graph_access_denied'); throw error; }
    return this.#acceptedBundle(context, observation, bundle);
  }
  // Called only by the source_access planner's selected port. Prior metadata
  // must additionally be selected from current Graph access projections there.
  lifecycleEvent(context, event, { prior = false, access_state = null } = {}) {
    const g = this.grant(context, 'graph:lifecycle', { write: true, owner: true });
    this.grant(context, 'source:invalidation:read'); this.grant(context, 'source:invalidation:consume');
    graphAssert(g.kind === 'service', 'graph_unauthorized');
    validateNormalizedEvent(event);
    graphAssert(['SOURCE_ACCESS_CHANGED', 'SOURCE_TOMBSTONE'].includes(event.event_type)
      && event.partition.tenant_id === g.tenant_id && event.partition.project_id === g.project_id, 'graph_unauthorized');
    graphAssert(effectiveEventAccess(event).allowed_principal_ids.includes(g.principal_id), 'graph_access_denied');
    const observation = eventObservationKey(event);
    let bundle;
    if (prior) {
      const source = this.#store.getSource(context, GRAPH_NS, admittedKey(observation));
      graphAssert(source?.kind === 'graph-accepted-event' && source.value.observation === observation
        && graphEqual(source.value.fact.event, event), 'graph_corrupt');
      bundle = { event: source.value.fact.event, receipt: source.value.receipt };
    } else {
      const selected = this.#invalidations.readLifecycleEvent(context, {
        invalidation_id: sourceLifecycleInvalidationId(scopeOf(g), event.event_id),
      });
      graphAssert(selected.status === 'applied' && selected.access_state === access_state && graphEqual(selected.event, event)
        && selected.event_digest === graphHash(event), 'graph_access_denied');
      bundle = { event: selected.event, receipt: selected.receipt };
    }
    return this.#acceptedBundle(context, observation, bundle);
  }
  #acceptedBundle(context, observation, bundle) {
    const g = this.#authority.inspect(context);
    const { event, receipt } = bundle; validateNormalizedEvent(event);
    graphAssert(eventObservationKey(event) === observation && event.partition.tenant_id === g.tenant_id
      && event.partition.project_id === g.project_id && receipt.event_id === event.event_id
      && graphHash(event) === receipt.event_digest, 'graph_corrupt');
    const original = this.#store.getSource(context, INGRESS_NAMESPACE, receipt.catalog_ref);
    graphAssert(original?.kind === 'identity-catalog' && graphHash(original.value) === event.normalization.catalog_digest, 'graph_corrupt');
    const cf = catalogFact(original.value), source_ref = admittedKey(observation);
    const selected = { event, event_digest: receipt.event_digest, catalog_pin: cf.pin, source_ref };
    const storedValue = { schema_version: 1, observation, fact: selected, receipt };
    const prior = this.#store.getSource(context, GRAPH_NS, source_ref);
    graphAssert(!prior || prior.kind === 'graph-accepted-event' && graphEqual(prior.value, storedValue), 'graph_corrupt');
    return { fact: selected, catalogFact: cf, receipt, retained: Boolean(prior),
      facts: [catalogDescriptor(cf), { id: source_ref, kind: 'graph-accepted-event', value: storedValue }] };
  }
  coverage(context, selectors, previousVector) {
    const g = this.grant(context, 'ingress:read'), scope = scopeOf(g);
    if (selectors === null) { graphAssert(previousVector, 'invalid_graph_input'); return { watermarks: previousVector, pins: [], facts: [] }; }
    graphAssert(Array.isArray(selectors) && selectors.length <= 8);
    const requirements = [], cursors = [], pins = [], facts = [], seen = new Set();
    for (const selector of selectors) {
      graphFields(selector, ['registration_id', 'target_event_id']); graphId(selector.registration_id);
      if (selector.target_event_id !== null) graphId(selector.target_event_id);
      let selected;
      try { selected = this.#ingress.getSource(context, { registration_id: selector.registration_id }); }
      catch (error) { if (graphErrorCode(error) === 'source_access_denied') throw graphFail('graph_access_denied'); throw error; }
      const source = selected.cursor.state.source, stream = sourcePartitionKey(source);
      graphAssert(!seen.has(stream)); seen.add(stream);
      let target = null;
      if (selector.target_event_id !== null) {
        const admitted = this.acceptedEvent(context, JSON.stringify([1, 'observation', g.tenant_id, selector.target_event_id]));
        graphAssert(admitted.receipt.registration_id === selector.registration_id, 'invalid_graph_input');
        target = admitted.fact.event.producer.sequence; facts.push(...admitted.facts);
      }
      const value = { schema_version: 1, selector, registration_version: selected.version, cursor_version: selected.cursor.version, cursor: selected.cursor.state };
      const descriptor = fact('graph-coverage', value, value); facts.push(descriptor);
      pins.push({ selector, registration_version: selected.version, cursor_version: selected.cursor.version, snapshot_ref: descriptor.id });
      requirements.push({ source, target_sequence: target }); cursors.push(selected.cursor.state);
      graphInput(cursors); // Aggregate bound, never truncate a partial coverage proof.
    }
    return { watermarks: projectFreshness({ scope, requirements, cursors }), pins, facts };
  }
  lifecycle(context, { at, current_head, access_view, event, targets, epoch }, selected = null) {
    const g = this.grant(context, 'graph:lifecycle', { write: true, owner: true });
    const admitted = selected ?? this.acceptedEvent(context, eventObservationKey(event)); graphAssert(graphEqual(admitted.fact.event, event), 'graph_corrupt');
    const sorted = event.provenance.source_objects.map(x => x.object).sort((a, b) => canonical(a).localeCompare(canonical(b)));
    graphAssert(graphEqual(sorted, [...targets].sort((a, b) => canonical(a).localeCompare(canonical(b)))));
    const value = { schema_version: 1, scope: scopeOf(g), actor: g.principal_id, actor_kind: g.kind, epoch,
      event_digest: graphHash(event), targets, predecessor: at };
    const descriptor = fact('graph-lifecycle-authority', value, value);
    return { fact: { at, current_head, access_view, event_digest: value.event_digest, targets, principal_id: g.principal_id, allowed: true, authority_ref: descriptor.id },
      facts: [...admitted.facts, descriptor] };
  }
  retain(tx, context, facts) {
    const seen = new Map();
    for (const item of facts) {
      graphInput(item); const duplicate = seen.get(item.id); graphAssert(!duplicate || graphEqual(duplicate, item), 'graph_corrupt'); seen.set(item.id, item);
    }
    for (const item of seen.values()) {
      const prior = tx.getSource(GRAPH_NS, item.id);
      if (prior) graphAssert(prior.kind === item.kind && graphEqual(prior.value, item.value), 'graph_corrupt');
      else tx.appendSource(GRAPH_NS, item.id, item.kind, item.value);
    }
  }
}
