import { composeCanonicalReader } from '../support/local-runtime-composition.mjs';

const invalid = () => Object.assign(new Error('Canonical reader: invalid_canonical_reader_input'), {
  code: 'invalid_canonical_reader_input',
  category: 'rejected',
});

/** Public nominal facade; the internal composition owns its Graph capability. */
export class CanonicalSourceReader {
  #reader;
  constructor({ store, authority, repository_path, execution, registration_id, selection }) {
    try {
      this.#reader = composeCanonicalReader({ store, authority, repository_path, execution, registration_id, selection }).reader;
    } catch (error) {
      if (error?.code === 'invalid_canonical_reader_owner') throw invalid();
      throw error;
    }
  }
  resolve(context, options) { return this.#reader.resolve(context, options); }
  refresh(context, options) { return this.#reader.refresh(context, options); }
}
