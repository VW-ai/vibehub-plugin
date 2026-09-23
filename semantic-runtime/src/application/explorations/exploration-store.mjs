import { graphInput } from '../graph/graph-inputs.mjs';
import { composeLocalServices } from '../support/local-runtime-composition.mjs';

export { EXPLORATION_NAMESPACE } from './exploration-inputs.mjs';

/** Selected in-process exploration API. The Graph owns every admitted transaction. */
export class LocalExplorationStore {
  #graph; #config;
  constructor({ store, authority, canonical_reader }) {
    // Validate the inert owner configuration even before the first operation.
    this.#config = graphInput(canonical_reader);
    this.#graph = composeLocalServices({ store, authority, canonical_reader: this.#config }).graph;
  }
  bind(context, options) { return this.#graph.bindExploration(context, options, this.#config); }
  mutate(context, options) { return this.#graph.mutateExploration(context, options, this.#config); }
  adopt(context, options) { return this.#graph.adoptExploration(context, options, this.#config); }
  setProjectSelection(context, options) { return this.#graph.setExplorationProjectSelection(context, options, this.#config); }
  getBinding(context, options) { return this.#graph.getExplorationBinding(context, options, this.#config); }
  getSelection(context, options) { return this.#graph.getExplorationSelection(context, options, this.#config); }
  resolve(context, options) { return this.#graph.resolveExploration(context, options, this.#config); }
  page(context, options) { return this.#graph.pageExploration(context, options, this.#config); }
  list(context, options) { return this.#graph.listExplorations(context, options, this.#config); }
  getReceipt(context, options) { return this.#graph.getExplorationReceipt(context, options, this.#config); }
}
