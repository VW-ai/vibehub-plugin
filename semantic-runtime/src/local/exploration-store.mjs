import { LocalGraphStore } from './graph-store.mjs';
import { ExplorationCanonical } from './exploration-canonical.mjs';
import { graphInput } from './graph-inputs.mjs';

export { EXPLORATION_NAMESPACE } from './exploration-inputs.mjs';

/** Selected in-process exploration API. The Graph owns every admitted transaction. */
export class LocalExplorationStore {
  #graph; #config;
  constructor({ store, authority, canonical_reader }) {
    // Validate the inert owner configuration even before the first operation.
    this.#config = graphInput(canonical_reader);
    new ExplorationCanonical({ store, authority, canonical_reader: this.#config });
    this.#graph = new LocalGraphStore({ store, authority });
  }
  bind(context, options) { return this.#graph.bindExploration(context, options, this.#config); }
  mutate(context, options) { return this.#graph.mutateExploration(context, options, this.#config); }
  setProjectSelection(context, options) { return this.#graph.setExplorationProjectSelection(context, options, this.#config); }
  getBinding(context, options) { return this.#graph.getExplorationBinding(context, options, this.#config); }
  getSelection(context, options) { return this.#graph.getExplorationSelection(context, options, this.#config); }
  resolve(context, options) { return this.#graph.resolveExploration(context, options, this.#config); }
  page(context, options) { return this.#graph.pageExploration(context, options, this.#config); }
  list(context, options) { return this.#graph.listExplorations(context, options, this.#config); }
  getReceipt(context, options) { return this.#graph.getExplorationReceipt(context, options, this.#config); }
}
