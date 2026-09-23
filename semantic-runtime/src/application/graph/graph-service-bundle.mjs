import { ExplorationCanonical } from '../explorations/exploration-canonical.mjs';
import { ContextInputs } from '../context/context-inputs.mjs';
import { ExplorationInputs } from '../explorations/exploration-inputs.mjs';
import { ContextReadService } from '../context/context-read-service.mjs';
import { graphCapabilityFor, withGraphCapability } from './graph-capability.mjs';
import { graphHash, graphInput } from './graph-inputs.mjs';

const bundles = new WeakMap();
const invalid = () => Object.assign(new Error('Graph service bundle: invalid_graph_input'), { code: 'invalid_graph_input' });

/** One proof-owning service bundle per exact Graph and canonical configuration object. */
export function graphServiceBundle({ graph, store, authority, canonical_reader }) {
  if (!canonical_reader || typeof canonical_reader !== 'object') throw invalid();
  const capability = graphCapabilityFor(graph, { store, authority });
  const fingerprint = graphHash(graphInput(canonical_reader));
  let byConfiguration = bundles.get(graph);
  if (!byConfiguration) { byConfiguration = new WeakMap(); bundles.set(graph, byConfiguration); }
  const retained = byConfiguration.get(canonical_reader);
  if (retained?.fingerprint === fingerprint) return retained.bundle;
  const canonical = new ExplorationCanonical(withGraphCapability({ store, authority, canonical_reader }, capability));
  const contexts = new ContextInputs({ authority, canonical });
  const inputs = new ExplorationInputs({ store, authority, config_digest: canonical.config_digest });
  const bundle = Object.freeze({
    graph,
    canonical,
    contexts,
    inputs,
    contextReads: new ContextReadService({ store, authority, canonical, contexts, explorations: inputs }),
  });
  byConfiguration.set(canonical_reader, { fingerprint, bundle });
  return bundle;
}
