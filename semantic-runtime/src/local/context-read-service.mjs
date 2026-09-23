import { exactRevisionAddress } from '../core/working-graph.mjs';
import { DomainStore } from '../adapters/sqlite/domain-store.mjs';
import { AccessAuthority } from '../domain/identity/access-authority.mjs';
import { ContextInputs, CONTEXT_INPUT_ERROR_CODES } from './context-inputs.mjs';
import { ExplorationCanonical, EXPLORATION_CANONICAL_ERROR_CODES } from './exploration-canonical.mjs';
import { ExplorationInputs, EXPLORATION_ERROR_CODES, readExplorationOwner } from './exploration-inputs.mjs';
import { GraphInputs, graphAssert, graphEqual, graphErrorCode, graphFail, graphHash, graphInput } from './graph-inputs.mjs';
import { SourceInvalidationFeed } from './source-invalidation.mjs';
import {
  CONTEXT_READER_ERROR_CODES,
  materializeContextShared,
  planContextSelection,
  readContextSelection,
  validateContextReadRequest,
} from './context-reader.mjs';

// Preserve the Graph facade's bounded error surface while DomainStore replaces
// arbitrary callback failures with store_unavailable at its transaction edge.
const READ_CODES = new Set([
  'invalid_graph_input', 'graph_capacity', 'graph_unauthorized', 'graph_access_denied',
  'graph_corrupt', 'graph_publisher_unavailable', 'graph_idempotency_conflict', 'graph_unavailable',
  'graph_plan_rejected', 'graph_storage_invalid', 'graph_storage_corrupt', 'graph_storage_conflict',
  'graph_maintenance', 'unsupported_graph_format', 'project_disabled', 'stale_activation_epoch',
  'activation_unauthorized', 'invalid_activation_input', 'invalid_activation_state', 'project_not_enrolled',
  'invalid_execution_membership', 'project_unauthorized', 'ingress_unauthorized', 'missing_event',
  'corrupt_ingress_state', 'unknown_source', 'store_closed', 'store_busy', 'store_unavailable',
  'store_unauthorized', 'invalidation_unauthorized', 'invalid_invalidation_input', 'missing_invalidation',
  'invalidation_corrupt', 'stale_invalidation_fence', 'invalid_store_input', 'unknown_namespace',
  'cas_conflict', 'duplicate_identity', 'async_transaction', 'stale_transaction', 'nested_transaction',
  'migration_required', 'incompatible_store', 'store_page_too_large', 'exploration_route_required',
  ...EXPLORATION_ERROR_CODES,
  ...EXPLORATION_CANONICAL_ERROR_CODES,
  ...CONTEXT_INPUT_ERROR_CODES,
  ...CONTEXT_READER_ERROR_CODES,
]);

/** Internal typed Context read use case. It owns every synchronous read snapshot it opens. */
export class ContextReadService {
  #store; #graphInputs; #invalidations; #canonical; #contexts; #explorations;
  constructor({ store, authority, canonical, contexts, explorations }) {
    graphAssert(store instanceof DomainStore && authority instanceof AccessAuthority
      && canonical instanceof ExplorationCanonical && contexts instanceof ContextInputs
      && explorations instanceof ExplorationInputs);
    this.#store = store;
    this.#graphInputs = new GraphInputs({ store, authority });
    this.#invalidations = new SourceInvalidationFeed({ store, authority });
    this.#canonical = canonical;
    this.#contexts = contexts;
    this.#explorations = explorations;
  }
  #call(operation) {
    try { return graphInput(operation()); } catch (error) {
      const code = graphErrorCode(error);
      throw graphFail(READ_CODES.has(code) ? code : 'invalid_graph_input');
    }
  }
  #snapshot(context, operation) {
    let domainCode;
    try {
      return this.#store.readSnapshot(context, view => {
        try {
          this.#graphInputs.grant(context, 'graph:read');
          this.#graphInputs.grant(context, 'ingress:read');
          const value = operation(view);
          this.#graphInputs.grant(context, 'graph:read');
          this.#graphInputs.grant(context, 'ingress:read');
          return graphInput(value);
        } catch (error) {
          const code = graphErrorCode(error);
          if (READ_CODES.has(code)) domainCode = code;
          throw error;
        }
      });
    } catch (error) {
      if (domainCode) throw graphFail(domainCode);
      throw error;
    }
  }
  #read(context, options, kind) {
    return this.#call(() => {
      const request = validateContextReadRequest(options, kind);
      const canonical = this.#canonical, contexts = this.#contexts, explorations = this.#explorations;
      contexts.grant(context);
      const metadata = this.#snapshot(context, view => {
        contexts.grant(context);
        const exploration = explorations.getExploration(view, context, { exploration_id: request.exploration_id });
        graphAssert(exploration && exploration.generation_id === request.at.generation_id, 'exploration_unavailable');
        return { exploration, project: explorations.projectSelection(view, context) };
      });
      const fence = canonical.fence(context);
      const origin = canonical.prepare(context, metadata.exploration.origin.shared_base);
      const project = canonical.prepare(context, metadata.project.pin);
      const read_pins = { project_selection: metadata.project, source_fence: fence };
      // This pass reads bounded immutable locators only. It never materializes
      // authorized semantic results; the final selected pass does that once.
      const planned = this.#snapshot(context, view => {
        contexts.grant(context);
        const selected = planContextSelection({ view, context, inputs: this.#graphInputs, explorations,
          config_digest: canonical.config_digest, request, kind, read_pins });
        // Canonical preparation needs only exact locators and typed content.
        // Repeated private provenance is verified inside the final snapshot,
        // and must not consume the public response's aggregate byte budget.
        return { revisions: selected.revisions.map(revision => ({ ref: exactRevisionAddress(revision),
          content: revision.assertion.content })), ticket_refs: selected.ticket_refs, selection: selected.selection };
      });
      const prepared = new Map();
      for (const candidate of planned.revisions) {
        const key = graphHash(candidate.ref);
        try { prepared.set(key, { candidate, proof: contexts.prepare(context, candidate.content, planned.ticket_refs) }); }
        catch (error) { prepared.set(key, { candidate, error }); }
      }
      return this.#snapshot(context, view => {
        contexts.grant(context);
        explorations.grant(context);
        graphAssert(graphEqual(metadata.exploration, explorations.getExploration(view, context, { exploration_id: request.exploration_id }))
          && graphEqual(metadata.project, explorations.projectSelection(view, context)), 'exploration_selection_conflict');
        this.#invalidations.assertFence(context, { sequence: fence });
        canonical.assert(view, context, origin); canonical.assert(view, context, project);
        const selected = readContextSelection({ view, context, inputs: this.#graphInputs, explorations,
          config_digest: canonical.config_digest, request, kind, read_pins });
        const { source_heads: plannedHeads, ...plannedPins } = planned.selection;
        const { source_heads: selectedHeads, ...selectedPins } = selected.selection;
        graphAssert(graphEqual(plannedPins, selectedPins) && selectedHeads.every(head =>
          plannedHeads.some(before => graphEqual(before, head))), 'graph_storage_conflict');
        const applicability = new Map();
        for (const revision of selected.revisions) {
          const key = graphHash(exactRevisionAddress(revision)), preparedRevision = prepared.get(key);
          graphAssert(preparedRevision && graphEqual(preparedRevision.candidate.ref, exactRevisionAddress(revision))
            && graphEqual(preparedRevision.candidate.content, revision.assertion.content), 'graph_storage_conflict');
          if (preparedRevision.error) throw preparedRevision.error;
          applicability.set(key, contexts.assert(view, context, preparedRevision.proof,
            { assertion: revision.assertion, provenance: revision.provenance }));
        }
        const item = value => {
          if (!value) return value;
          const verified = applicability.get(graphHash(value.ref)); graphAssert(verified, 'graph_corrupt');
          const owner = readExplorationOwner(view, { scope: value.ref.scope, generation_id: value.ref.generation_id });
          graphAssert(owner, 'exploration_corrupt');
          return { ...value, applicability: { ...verified, scope: value.ref.scope,
            exploration_id: owner.exploration_id } };
        };
        const local = { ...selected.local };
        if (Object.hasOwn(local, 'item')) local.item = item(local.item);
        if (Object.hasOwn(local, 'root')) local.root = item(local.root);
        if (local.items) local.items = local.items.map(item);
        if (local.links) local.links = local.links.map(link => Object.hasOwn(link, 'item') ? { ...link, item: item(link.item) } : link);
        // Recheck selected canonical source material and opaque grants after
        // assembly, before any fragment can escape the snapshot.
        for (const revision of selected.revisions) {
          contexts.assert(view, context, prepared.get(graphHash(exactRevisionAddress(revision))).proof,
            { assertion: revision.assertion, provenance: revision.provenance });
        }
        canonical.assert(view, context, origin); canonical.assert(view, context, project);
        graphAssert(graphEqual(metadata.project, explorations.projectSelection(view, context)), 'exploration_selection_conflict');
        this.#invalidations.assertFence(context, { sequence: fence }); contexts.grant(context);
        const shared = materializeContextShared(canonical, origin, project, metadata.project.version);
        return { exploration_id: request.exploration_id, generation_id: request.at.generation_id,
          graph_revision: request.at, mode: request.mode, selection: selectedPins,
          local, shared, availability: { local: local.status ?? 'selected', origin_base: shared.origin_base.status,
            current_project: shared.current_project.status } };
      });
    });
  }
  resolve(context, options) { return this.#read(context, options, 'resolve'); }
  page(context, options) { return this.#read(context, options, 'page'); }
  lineage(context, options) { return this.#read(context, options, 'lineage'); }
}
