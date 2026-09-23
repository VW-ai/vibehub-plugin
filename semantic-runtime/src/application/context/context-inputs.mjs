import { AccessAuthority, LOCAL_AUDIENCE } from '../../domain/identity/access-authority.mjs';
import { ExplorationCanonical, EXPLORATION_CANONICAL_ERROR_CODES } from '../explorations/exploration-canonical.mjs';
import { graphInput, graphFields, graphEqual, graphHash, graphErrorCode } from '../graph/graph-inputs.mjs';
import { validateContextContent1, CONTEXT_PROFILE_ERROR_CODES } from '../../domain/context/context-profile.mjs';
import { canonicalArtifactAddress, validateProvenanceClosure } from '../../domain/graph/working-graph.mjs';
import { eventObservationKey } from '../../domain/sources/event-provenance.mjs';
import { canonical } from '../../domain/shared/contracts.mjs';

export const CONTEXT_INPUT_ERROR_CODES = Object.freeze(['invalid_context_input', 'context_capacity', 'context_transition_invalid',
  'context_unauthorized', 'invalid_context_proof', 'context_ticket_unavailable', 'context_source_mismatch']);
const fail = code => Object.assign(new Error(`Context inputs: ${code}`), { code });
const check = (ok, code = 'invalid_context_input') => { if (!ok) throw fail(code); };
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const copy = value => freeze(graphInput(value));
const eventRef = event => ({ kind: 'event_ref', observation_key: eventObservationKey(event), event_digest: graphHash(event) });

/** Fixed owner composition: canonical reads happen before entry to the Graph transaction. */
export class ContextInputs {
  #authority; #canonical; #proofs = new WeakMap(); #selections = new WeakMap();
  constructor({ authority, canonical }) {
    check(authority instanceof AccessAuthority && canonical instanceof ExplorationCanonical);
    this.#authority = authority; this.#canonical = canonical;
  }
  #call(fn) {
    try { return fn(); } catch (error) {
      const code = graphErrorCode(error);
      // Imported code lists are consulted lazily to preserve the Graph-owned import cycle.
      throw fail(CONTEXT_INPUT_ERROR_CODES.includes(code) || CONTEXT_PROFILE_ERROR_CODES.includes(code)
        || EXPLORATION_CANONICAL_ERROR_CODES.includes(code) ? code : 'invalid_context_input');
    }
  }
  grant(context, options = {}) {
    return this.#call(() => {
      const opts = graphInput(options); graphFields(opts, [], ['write']);
      check(opts.write === undefined || typeof opts.write === 'boolean');
      const grant = this.#authority.inspect(context);
      check(grant && grant.audience === LOCAL_AUDIENCE && grant.actions.includes('context:read')
        && (!opts.write || grant.actions.includes('context:write') && ['human', 'service'].includes(grant.kind)), 'context_unauthorized');
      return copy({ scope: { tenant_id: grant.tenant_id, project_id: grant.project_id }, actor: grant.principal_id, actor_kind: grant.kind });
    });
  }
  prepare(context, input, selection_refs = []) {
    return this.#call(() => {
      const grant = this.grant(context), content = validateContextContent1(input), groups = new Map();
      const requested = graphInput(selection_refs);
      check(Array.isArray(requested), 'invalid_context_input');
      const distinct = new Set();
      for (const ref of requested) {
        graphFields(ref, ['at', 'address', 'record_key']); distinct.add(canonical([ref.at, ref.address]));
      }
      check(distinct.size <= 8, 'context_capacity');
      for (const ref of content.data.applicability.tickets.refs) {
        check(graphEqual(ref.at.scope, grant.scope), 'context_source_mismatch');
        const key = canonical([ref.at, ref.address]), group = groups.get(key) ?? { at: ref.at, address: ref.address, record_keys: [] };
        group.record_keys.push(ref.record_key); groups.set(key, group);
      }
      // Reuse belongs to this one owner's preparation batch, never the lifetime
      // of a credential or helper. An omitted batch gets a fresh array per call.
      let batch = this.#selections.get(selection_refs);
      if (!batch) { batch = new WeakMap(); this.#selections.set(selection_refs, batch); }
      let selections = batch.get(context);
      if (!selections) { selections = new Map(); batch.set(context, selections); }
      const pins = [...groups.values()].map(pin => {
        // Keep per-content membership separate from the shared selected proof.
        // An unreadable independent target's invalid extra key must not deny a
        // readable root; that target still fails its own preparation if used.
        const own = this.#canonical.pin(pin), union = new Set(own.record_keys);
        for (const ref of requested) {
          if (!graphEqual(ref.at, pin.at) || !graphEqual(ref.address, pin.address)) continue;
          try {
            const extra = this.#canonical.pin({ at: ref.at, address: ref.address, record_keys: [ref.record_key] });
            union.add(extra.record_keys[0]);
          } catch { /* A required key is validated independently through own. */ }
        }
        const selected = this.#canonical.pin({ at: pin.at, address: pin.address, record_keys: [...union].sort() });
        const key = canonical(selected); let cached = selections.get(key);
        if (!cached) {
          try { cached = { proof: this.#canonical.prepare(context, selected) }; }
          catch (error) { cached = { error }; }
          selections.set(key, cached);
        }
        if (cached.error) throw cached.error;
        return { pin: own, proof: cached.proof };
      });
      check(graphEqual(grant, this.grant(context)), 'context_unauthorized');
      const prepared = Object.freeze({ content }); this.#proofs.set(prepared, { context, grant, pins }); return prepared;
    });
  }
  assert(view, context, prepared, input) {
    return this.#call(() => {
      const stored = prepared && typeof prepared === 'object' ? this.#proofs.get(prepared) : null;
      check(stored && stored.context === context, 'invalid_context_proof');
      check(graphEqual(stored.grant, this.grant(context)), 'context_unauthorized');
      const selected = graphInput(input); graphFields(selected, ['assertion'], ['provenance']);
      const assertion = selected.assertion;
      check(assertion?.entity_kind === 'entity' && graphEqual(validateContextContent1(assertion.content), prepared.content), 'invalid_context_proof');
      check(Array.isArray(assertion.events) && assertion.events.length <= 32 && Array.isArray(assertion.canonical_refs) && assertion.canonical_refs.length <= 32,
        'context_capacity');
      for (const ref of assertion.canonical_refs) check(graphEqual(ref, canonicalArtifactAddress(ref.event)), 'context_source_mismatch');
      const provenance = selected.provenance ?? null;
      if (provenance !== null) validateProvenanceClosure(provenance);
      const support = [...assertion.events, ...assertion.canonical_refs.map(ref => ref.event), ...(provenance?.events ?? [])];
      const tickets = new Map();
      for (const { pin, proof } of stored.pins) {
        this.#canonical.assert(view, context, proof);
        const material = this.#canonical.material(proof);
        check(['current', 'historical'].includes(material.status) && material.data !== null, 'context_ticket_unavailable');
        for (const record_key of pin.record_keys) {
          const entry = material.data.records.find(record => record.key === record_key);
          check(entry?.status === 'usable' && entry.kind === 'ticket' && entry.record?.kind === 'ticket', 'context_ticket_unavailable');
          const event = material.canonical_refs[entry.canonical_ref_index]?.event;
          const position = material.data.source_watermark?.positions.find(item => item.key === record_key);
          check(event && event.payload.kind === 'git_revision' && event.payload.path === entry.path
            && position?.event_id === event.event_id && position.event_digest === graphHash(event), 'context_source_mismatch');
          check(support.some(actual => graphEqual(actual, event)), 'context_source_mismatch');
          const contract = entry.record.contract_revisions?.find(item => item.revision === entry.record.active_contract_revision);
          check(contract, 'context_ticket_unavailable');
          const ref = { at: pin.at, address: pin.address, record_key };
          tickets.set(canonical(ref), { ref, ticket_id: entry.record.ticket_id,
            contract_revision: { revision: contract.revision, identity: contract.identity }, selection_status: material.status, event_ref: eventRef(event) });
        }
      }
      const applicability = prepared.content.data.applicability;
      const code = applicability.code.refs.map(ref => {
        const event = assertion.canonical_refs.find(artifact => graphHash(artifact.event) === ref.event_digest)?.event;
        check(event?.payload.kind === 'git_revision', 'context_source_mismatch');
        check(graphEqual({ tenant_id: event.partition.tenant_id, project_id: event.partition.project_id }, stored.grant.scope), 'context_source_mismatch');
        return { ref, repository_id: event.payload.object.repository_id, object_format: event.payload.object.object_format,
          commit_oid: event.payload.object.oid, path: event.payload.path, event_ref: eventRef(event) };
      });
      check(graphEqual(stored.grant, this.grant(context)), 'context_unauthorized');
      const uncertain_dimensions = ['exploration', 'tickets', 'code'].filter(key => key === 'exploration'
        ? applicability[key] === 'unspecified' : applicability[key].mode === 'unspecified');
      return copy({ status: uncertain_dimensions.length ? 'uncertain' : 'specified', uncertain_dimensions,
        project: 'owning', exploration: applicability.exploration,
        tickets: { mode: applicability.tickets.mode, refs: applicability.tickets.refs.map(ref => tickets.get(canonical(ref))) },
        code: { mode: applicability.code.mode, refs: code } });
    });
  }
}
