import { LocalGraphStore } from './graph-store.mjs';
import { CanonicalSourceReaderService } from '../application/sources/canonical-source-reader-service.mjs';
import { graphCapabilityFor, withGraphCapability } from './graph-capability.mjs';
import { graphServiceBundle } from './graph-service-bundle.mjs';

/** Fixed local composition. No capability or transaction handle is returned to callers. */
export function composeLocalServices({ store, authority, canonical_reader }) {
  const graph = new LocalGraphStore({ store, authority });
  return graphServiceBundle({ graph, store, authority, canonical_reader });
}

export function composeCanonicalReader(options) {
  let graph;
  try {
    graph = new LocalGraphStore({ store: options.store, authority: options.authority });
  } catch (error) {
    if (error?.code === 'invalid_graph_input') {
      throw Object.assign(new Error('Local composition: invalid_canonical_reader_owner'), { code: 'invalid_canonical_reader_owner' });
    }
    throw error;
  }
  const reader = new CanonicalSourceReaderService(withGraphCapability(
    { ...options },
    graphCapabilityFor(graph, { store: options.store, authority: options.authority }),
  ));
  return Object.freeze({ graph, reader });
}
