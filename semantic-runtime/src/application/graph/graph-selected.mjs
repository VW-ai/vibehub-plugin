import { graphAssert, graphKey, graphHash, graphEqual, graphErrorCode } from './graph-inputs.mjs';
import { eventObservationKey, sourceObjectKey } from '../../domain/sources/event-provenance.mjs';

const scopeOf = g => ({ tenant_id: g.tenant_id, project_id: g.project_id });

/** Fixed selected Graph port reused by the transaction owner and domain reader. */
export function selectGraph({ inputs, context, tx, storage, generation_id, write = false, catalogFact = null, epoch = null, operation = null }) {
  const head = storage.head();
  if (!catalogFact) {
    graphAssert(head, 'graph_unavailable');
    const c = storage.fact({ at: head.value.head, kind: 'commit', key: [head.value.head.commit_digest] }).value;
    graphAssert(c, 'graph_corrupt'); catalogFact = inputs.catalogFromPin(context, c.catalog_pin);
    graphAssert(catalogFact, 'graph_corrupt');
  }
  const action = write ? 'graph:write' : 'graph:read', initial = inputs.grant(context, action);
  const access_view = graphKey('access-view', [scopeOf(initial), generation_id, head?.value.head ?? null, head?.version ?? null, initial.principal_id]);
  const facts = [], selectedEvents = new Map(), catalogs = new Map([[graphHash(catalogFact.pin), catalogFact]]), authorityRefs = [];
  const isLifecycle = write && operation?.kind === 'source_access';
  const lifecycleTargets = new Set(isLifecycle ? operation.event.provenance.source_objects.map(s => sourceObjectKey(s.object)) : []);
  const priorLifecycle = new Map();
  const lifecycleFallback = observation => {
    graphAssert(isLifecycle, 'graph_access_denied');
    if (observation === eventObservationKey(operation.event)) return inputs.lifecycleEvent(context, operation.event,
      { access_state: operation.access_state });
    const update = priorLifecycle.get(observation);
    graphAssert(update, 'graph_access_denied');
    const proof = storage.fact({ at: head.value.head, kind: 'access_update', key: [update.event_digest] }).value;
    graphAssert(proof && graphEqual(proof.event, update.event) && proof.event_digest === update.event_digest
      && proof.access_state === update.access_state, 'graph_corrupt');
    return inputs.lifecycleEvent(context, update.event, { prior: true });
  };
  const stage = items => { facts.push(...items); };
  const current = () => {
    const grant = inputs.grant(context, action), actual = storage.head();
    return { scope: scopeOf(grant), generation_id, head: actual?.value.head ?? null, head_version: actual?.version ?? null,
      catalog_pin: catalogFact.pin, access_view, principal_id: grant.principal_id };
  };
  const envelope = (query, row) => ({ ...query, current_head: head?.value.head ?? null, access_view, complete: true, ...row });
  const port = {
    current,
    read: query => {
      if (query.kind === 'catalog') {
        const pin = { revision_id: query.key[0], digest: query.key[1] };
        const value = catalogs.get(graphHash(pin)) ?? inputs.catalogFromPin(context, pin);
        return envelope(query, { version: value ? 1 : null, value, origin: null });
      }
      if (query.kind === 'accepted_event') {
        let selected = selectedEvents.get(query.key[0]);
        if (!selected) {
          try { selected = inputs.acceptedEvent(context, query.key[0]); }
          catch (error) {
            if (graphErrorCode(error) !== 'graph_access_denied') throw error;
            selected = lifecycleFallback(query.key[0]);
          }
          graphAssert(write || selected.retained, 'graph_corrupt'); selectedEvents.set(query.key[0], selected);
          catalogs.set(graphHash(selected.catalogFact.pin), selected.catalogFact); if (write) stage(selected.facts);
        }
        return envelope(query, { version: 1, value: selected.fact, origin: null });
      }
      const row = storage.fact(query);
      // Admit prior security metadata only as the core selects this target's
      // current projection; no scan, historic locator or arbitrary event read.
      if (isLifecycle && query.kind === 'source_access' && lifecycleTargets.has(query.key[0])
        && graphEqual(query.at, head.value.head) && row.value) {
        graphAssert(sourceObjectKey(row.value.object) === query.key[0] && Array.isArray(row.value.updates)
          && row.value.updates.length <= 32, 'graph_corrupt');
        for (const update of row.value.updates) {
          graphAssert(graphHash(update.event) === update.event_digest, 'graph_corrupt');
          const observation = eventObservationKey(update.event), prior = priorLifecycle.get(observation);
          graphAssert(!prior || graphEqual(prior, update), 'graph_corrupt'); priorLifecycle.set(observation, update);
          graphAssert(priorLifecycle.size <= 32, 'graph_capacity');
        }
      }
      return envelope(query, row);
    },
    page: query => ({ at: query.at, collection: query.collection, after: query.after, current_head: head?.value.head ?? null, access_view, ...storage.page(query) }),
    authorizeLifecycle: query => {
      graphAssert(write && operation?.kind === 'source_access' && graphHash(operation.event) === query.event_digest, 'graph_unauthorized');
      const admitted = selectedEvents.get(eventObservationKey(operation.event)); graphAssert(admitted, 'graph_corrupt');
      const selected = inputs.lifecycle(context, { ...query, current_head: head?.value.head ?? null, access_view, event: operation.event, epoch }, admitted);
      stage(selected.facts); authorityRefs.push(selected.fact.authority_ref); return selected.fact;
    }
  };
  return { port, facts, selectedEvents, authorityRefs };
}
