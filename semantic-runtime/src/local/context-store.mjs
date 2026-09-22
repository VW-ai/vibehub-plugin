import { LocalGraphStore } from './graph-store.mjs';
import { ExplorationCanonical } from './exploration-canonical.mjs';
import { graphInput } from './graph-inputs.mjs';

/** Typed Context lifecycle over the existing exploration-owned Graph transaction. */
export class LocalContextStore {
  #graph; #config;
  constructor({ store, authority, canonical_reader }) {
    this.#config = graphInput(canonical_reader);
    new ExplorationCanonical({ store, authority, canonical_reader: this.#config });
    this.#graph = new LocalGraphStore({ store, authority });
  }
  mutate(context, request) { return this.#graph.mutateContext(context, request, this.#config); }
  adopt(context, request) { return this.#graph.adoptContext(context, request, this.#config); }
  resolve(context, request) { return this.#graph.resolveContext(context, request, this.#config); }
  page(context, request) { return this.#graph.pageContexts(context, request, this.#config); }
  lineage(context, request) { return this.#graph.contextLineage(context, request, this.#config); }
  getReceipt(context, request) { return this.#graph.getContextReceipt(context, request, this.#config); }
}
