import { DomainStore } from './domain-store.mjs';
import { LocalCredentialAuthority, LOCAL_AUDIENCE } from './auth.mjs';
import { CanonicalSourceReaderService } from './canonical-source-reader-service.mjs';
import { graphCapabilityFrom, graphGetHead, withGraphCapability } from './graph-capability.mjs';
import { GraphStorage } from './graph-storage.mjs';
import { GraphInputs, GRAPH_NS, graphInput, graphFields, graphHash, graphKey, graphEqual, graphId, graphErrorCode } from './graph-inputs.mjs';
import { DurableIngress } from './durable-ingress.mjs';
import { SourceInvalidationFeed } from './source-invalidation.mjs';
import { validateGraphCommitAddress2 } from '../core/incremental-graph.mjs';
import { validateSemanticAddress, exactRevisionAddress } from '../core/working-graph.mjs';
import { eventObservationKey } from '../core/event-provenance.mjs';

export const EXPLORATION_CANONICAL_ERROR_CODES = Object.freeze([
  'invalid_graph_input', 'graph_capacity', 'graph_unauthorized', 'graph_access_denied', 'graph_corrupt',
  'graph_unavailable', 'graph_plan_rejected', 'graph_storage_invalid', 'graph_storage_corrupt',
  'graph_storage_conflict', 'graph_maintenance', 'unsupported_graph_format', 'ingress_unauthorized',
  'missing_event', 'corrupt_ingress_state', 'unknown_source', 'store_closed', 'store_busy', 'store_unavailable',
  'store_unauthorized', 'invalidation_unauthorized', 'invalid_invalidation_input', 'missing_invalidation',
  'invalidation_corrupt', 'stale_invalidation_fence', 'invalid_store_input', 'unknown_namespace',
  'cas_conflict', 'duplicate_identity', 'async_transaction', 'stale_transaction', 'nested_transaction',
  'migration_required', 'incompatible_store', 'store_page_too_large',
  'invalid_canonical_reader_input', 'canonical_reader_unauthorized', 'canonical_selection_mismatch',
  'canonical_graph_changed', 'canonical_record_corrupt', 'canonical_source_mismatch', 'canonical_capacity',
  'source_access_denied', 'source_invalidation_denied', 'invalid_exploration_canonical_proof',
  'exploration_canonical_unchecked', 'canonical_source_unavailable']);
const codes = new Set(EXPLORATION_CANONICAL_ERROR_CODES);
const denied = new Set(['graph_access_denied', 'source_access_denied', 'source_invalidation_denied']);
const fail = code => Object.assign(new Error(`Exploration canonical: ${code}`), { code,
  category: ['store_busy', 'store_closed', 'store_unavailable'].includes(code) ? 'retryable_failure' : 'rejected' });
const check = (ok, code = 'canonical_selection_mismatch') => { if (!ok) throw fail(code); };
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const scopeOf = grant => ({ tenant_id: grant.tenant_id, project_id: grant.project_id });
const sameActor = (left, right) => graphEqual(scopeOf(left), scopeOf(right)) && left.principal_id === right.principal_id && left.kind === right.kind;

/** Fixed, owner-composed reader capability. Proofs never cross the public wire. */
export class ExplorationCanonical {
  #store; #authority; #reader; #graph; #inputs; #ingress; #feed; #config; #digest; #keys; #proofs = new WeakMap();
  constructor(options) {
    const { store, authority, canonical_reader } = options;
    check(store instanceof DomainStore && authority instanceof LocalCredentialAuthority, 'invalid_canonical_reader_input');
    this.#graph = graphCapabilityFrom(options, { store, authority });
    // Inspect/copy the complete configuration before destructuring any caller data.
    const config = graphInput(canonical_reader);
    graphFields(config, ['repository_path', 'execution', 'registration_id', 'selection']);
    this.#reader = new CanonicalSourceReaderService(withGraphCapability({ store, authority, ...config }, this.#graph));
    config.selection.records.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    this.#config = freeze(config); this.#digest = graphHash(config);
    this.#keys = freeze(config.selection.records.map(record => record.key));
    this.#store = store; this.#authority = authority;
    this.#inputs = new GraphInputs({ store, authority });
    this.#ingress = new DurableIngress({ store, authority }); this.#feed = new SourceInvalidationFeed({ store, authority });
  }
  get config_digest() { return this.#digest; }
  #call(operation) {
    try { return operation(); } catch (error) {
      const code = graphErrorCode(error); throw fail(codes.has(code) ? code : 'invalid_canonical_reader_input');
    }
  }
  #grant(context) {
    const grant = this.#authority.inspect(context);
    check(grant && grant.audience === LOCAL_AUDIENCE
      && ['store:read', 'graph:read', 'ingress:read', 'source:invalidation:read'].every(action => grant.actions.includes(action)),
    'canonical_reader_unauthorized');
    return grant;
  }
  #proof(proof) {
    const stored = proof && typeof proof === 'object' ? this.#proofs.get(proof) : null;
    check(stored, 'invalid_exploration_canonical_proof'); return stored;
  }
  #keysInput(input) {
    const keys = graphInput(input);
    check(Array.isArray(keys) && keys.length <= 16 && new Set(keys).size === keys.length, 'invalid_canonical_reader_input');
    keys.forEach(key => { graphId(key); check(this.#keys.includes(key), 'canonical_selection_mismatch'); });
    return keys.sort();
  }
  pin(input) {
    return this.#call(() => {
      if (input === null) return null;
      const value = graphInput(input); graphFields(value, ['at', 'address', 'record_keys']);
      validateGraphCommitAddress2(value.at); validateSemanticAddress(value.address);
      check(value.address.kind === 'semantic_revision' && value.address.entity_kind === 'entity'
        && value.address.generation_id === value.at.generation_id && graphEqual(value.address.scope, value.at.scope));
      value.record_keys = this.#keysInput(value.record_keys); return freeze(value);
    });
  }
  fence(context) { return this.#call(() => { this.#grant(context); return this.#feed.head(context).sequence; }); }
  summary(proof) {
    return this.#call(() => { const p = this.#proof(proof); return freeze(graphInput({ pin: p.pin, status: p.status, source_fence: p.fence })); });
  }
  status(proof) { return this.#call(() => this.#proof(proof).status); }
  #selection(tx, grant, pin) {
    check(graphEqual(pin.at.scope, scopeOf(grant)));
    const entityId = graphKey('canonical-selection', [scopeOf(grant), this.#config.execution.repository_id, this.#config.selection.selection_id]);
    check(pin.address.entity_id === entityId);
    const storage = new GraphStorage({ view: tx, scope: scopeOf(grant), generation_id: pin.at.generation_id });
    const revision = storage.fact({ at: pin.at, kind: 'revision', key: [pin.address.revision_digest] }).value;
    if (!revision) return null;
    check(graphEqual(exactRevisionAddress(revision), pin.address));
    const assertion = revision.assertion, data = assertion.content.data;
    check(assertion.content.semantic_type === 'canonical-selection' && data.kind === 'canonical_selection'
      && data.schema_version === 1 && data.config_digest === this.#digest && data.selection_id === this.#config.selection.selection_id
      && data.policy_id === this.#config.selection.policy_id && data.schema_profile === this.#config.selection.schema_profile);
    check(Array.isArray(data.records) && data.records.length === this.#keys.length, 'canonical_record_corrupt');
    for (let index = 0; index < this.#keys.length; index++) {
      const configured = this.#config.selection.records[index], record = data.records[index];
      check(['key', 'kind', 'id', 'path'].every(field => configured[field] === record[field]), 'canonical_record_corrupt');
    }
    const issuance = { schema_version: 1, kind: 'canonical_reader_issuance', scope: revision.scope, generation_id: revision.generation_id,
      entity_id: assertion.entity_id, selection_id: this.#config.selection.selection_id, config_digest: this.#digest,
      request_digest: data.request_digest, commit_oid: data.commit_oid, source_fence: data.source_fence, assertion_digest: graphHash(assertion) };
    const row = tx.getSource(GRAPH_NS, graphKey('canonical-issuance', [issuance.config_digest, issuance.request_digest]));
    check(row?.kind === 'canonical-reader-issuance' && graphEqual(row.value, issuance));
    return revision;
  }
  #source(context, revision) {
    const grant = this.#grant(context), configured = this.#config;
    const registration = this.#ingress.getRegistration(context, { registration_id: configured.registration_id }).registration;
    check(graphEqual(registration.execution, configured.execution) && graphEqual({ tenant_id: registration.partition.tenant_id,
      project_id: registration.partition.project_id }, scopeOf(grant)) && registration.mapping.event_types.canonical_record === 'DOC_CHANGED',
    'canonical_source_mismatch');
    const events = [...revision.provenance.events, ...revision.provenance.access_events];
    check(events.length <= 64, 'canonical_capacity');
    for (const event of events) {
      const selected = this.#inputs.acceptedEvent(context, eventObservationKey(event));
      check(selected.retained && graphEqual(selected.fact.event, event), 'canonical_record_corrupt');
      if (revision.provenance.events.includes(event)) check(selected.receipt.registration_id === configured.registration_id,
        'canonical_source_mismatch');
    }
  }
  prepare(context, input, options = {}) {
    return this.#call(() => {
      const opts = graphInput(options); graphFields(opts, [], ['requireCurrent']);
      check(opts.requireCurrent === undefined || typeof opts.requireCurrent === 'boolean', 'invalid_canonical_reader_input');
      const grant = this.#grant(context), pin = this.pin(input), fence = this.fence(context);
      let result = { status: 'unavailable', selection: null }, head = null;
      if (pin !== null) {
        check(graphEqual(pin.at.scope, scopeOf(grant)));
        head = graphGetHead(this.#graph, context, { generation_id: pin.at.generation_id });
        result = this.#reader.resolve(context, { at: pin.at, address: pin.address });
        check(graphEqual(head, graphGetHead(this.#graph, context, { generation_id: pin.at.generation_id })), 'canonical_graph_changed');
      }
      this.#feed.assertFence(context, { sequence: fence }); check(sameActor(grant, this.#grant(context)), 'canonical_reader_unauthorized');
      if (opts.requireCurrent) check(result.status === 'current', result.status === 'quarantined' ? 'stale_invalidation_fence' : 'canonical_selection_mismatch');
      const proof = Object.freeze({});
      this.#proofs.set(proof, { context, grant, pin, fence, head, status: result.status, revision: result.selection, checked: false });
      return proof;
    });
  }
  assert(tx, context, proof) {
    return this.#call(() => {
      const p = this.#proof(proof); p.checked = false;
      const grant = this.#grant(context);
      check(context === p.context && sameActor(grant, p.grant), 'invalid_exploration_canonical_proof');
      this.#feed.assertFence(context, { sequence: p.fence });
      if (p.pin !== null) {
        const storage = new GraphStorage({ view: tx, scope: scopeOf(grant), generation_id: p.pin.at.generation_id });
        const head = storage.head();
        check(graphEqual(p.head, { graph_revision: head?.value.head ?? null, maintenance: head?.value.maintenance ? 'building' : null }), 'canonical_graph_changed');
        const revision = this.#selection(tx, grant, p.pin);
        if (p.revision !== null) {
          check(graphEqual(revision, p.revision), 'canonical_selection_mismatch');
          check(revision.assertion.content.data.source_fence === p.fence, 'stale_invalidation_fence');
          this.#source(context, revision);
        } else if (revision !== null) {
          // A denied/stale selection is still checked against real issuance. It
          // carries no material, and never upgrades itself to a usable proof.
          check(p.status === 'quarantined', 'canonical_selection_mismatch');
          try { this.#source(context, revision); } catch (error) { if (!denied.has(graphErrorCode(error))) throw error; }
        } else check(p.status === 'unavailable', 'canonical_selection_mismatch');
      }
      this.#feed.assertFence(context, { sequence: p.fence }); check(sameActor(grant, this.#grant(context)), 'canonical_reader_unauthorized');
      p.checked = true;
    });
  }
  material(proof, shared_keys = null) {
    return this.#call(() => {
      const p = this.#proof(proof); check(p.checked, 'exploration_canonical_unchecked');
      const filter = shared_keys === null ? null : this.#keysInput(shared_keys);
      const selected = p.pin?.record_keys ?? [], requested = selected.filter(key => filter === null || filter.includes(key));
      const data = p.revision?.assertion.content.data ?? null;
      const authorities = data ? data.records.filter(entry => entry.status === 'usable' && entry.kind === 'context'
        && entry.record?.type === 'authority' && entry.record.state === 'active').map(entry => entry.key) : [];
      const returned = this.#keys.filter(key => data && (requested.includes(key) || authorities.includes(key)));
      const records = data?.records.filter(entry => returned.includes(entry.key)) ?? [];
      const coverageStatus = !data ? 'unavailable' : returned.length === this.#keys.length
        && data.evaluation_status === 'usable' ? 'selected' : 'partial';
      return freeze(graphInput({ pin: p.pin, status: p.status, configured_record_keys: this.#keys,
        selected_record_keys: selected, returned_record_keys: returned, authority_record_keys: authorities,
        coverage: { scope: 'configured_selection', status: coverageStatus, configured_record_keys: this.#keys,
          selected_record_keys: selected, returned_record_keys: returned },
        data: data ? { ...data, records } : null, canonical_refs: p.revision?.assertion.canonical_refs ?? [] }));
    });
  }
}
