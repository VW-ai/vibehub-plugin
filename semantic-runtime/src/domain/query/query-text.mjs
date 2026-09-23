import { isProxy } from 'node:util/types';
import { canonical, fingerprint, compareText } from '../../core/contracts.mjs';

export const CONTEXT_TEXT_VERSION = 'context-text-v1';
const INDEX_BYTES = 262144, INDEX_POSTINGS = 65536;
const failure = code => Object.assign(new Error(`Query text: ${code}`), { code });
const check = (ok, code = 'query_invalid_request') => { if (!ok) throw failure(code); };
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };

// Shared only by the two pure Query modules. Validate descriptors before reading
// values so even rejected input cannot invoke caller accessors or proxy traps.
export function copyQueryFacts(input) {
  let nodes = 0; const stack = new Set();
  const visit = (v, depth) => {
    check(++nodes <= 50000 && depth < 16, 'query_capacity');
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number') { check(Number.isFinite(v)); return; }
    check(!isProxy(v) && (plain(v) || Array.isArray(v) && Object.getPrototypeOf(v) === Array.prototype) && !stack.has(v));
    check(Object.getOwnPropertySymbols(v).length === 0);
    for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
      if (Array.isArray(v) && key === 'length') continue;
      check(Object.hasOwn(d, 'value') && d.enumerable);
      check(!Array.isArray(v) || /^(0|[1-9]\d*)$/.test(key) && Number(key) < v.length);
    }
    if (Array.isArray(v)) check(Object.keys(v).length === v.length);
    stack.add(v); Object.values(v).forEach(child => visit(child, depth + 1)); stack.delete(v);
  };
  visit(input, 0); check(Buffer.byteLength(JSON.stringify(input)) <= 1048576, 'query_capacity');
  return JSON.parse(canonical(input));
}

// An internal index implementation may explicitly report its own unavailability.
// Unknown exceptions, including arbitrary RangeErrors, must still refuse Query.
export class ContextTextIndexUnavailable extends Error {}
const capacity = new ContextTextIndexUnavailable('index_capacity');
const normalized = text => text.normalize('NFKC').toLowerCase();
const tokens = text => text.match(/[\p{L}\p{N}_]+/gu) ?? [];
const fields = (v, keys) => check(plain(v) && keys.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => keys.includes(k)));

/** Positional FTS over an already authorized, bounded selected window; no I/O. */
export function matchContextTextV1(input) {
  const r = copyQueryFacts(input); fields(r, ['documents', 'text']); fields(r.text, ['value', 'match']);
  check(typeof r.text.value === 'string' && Buffer.byteLength(r.text.value) <= 4096 && ['all_terms', 'phrase'].includes(r.text.match));
  const query = tokens(normalized(r.text.value)), terms = [...new Set(query)];
  check(query.length <= 32); check(Array.isArray(r.documents) && r.documents.length <= 128, 'query_capacity');
  const keys = new Set();
  const documents = r.documents.map(doc => {
    fields(doc, ['key', 'fields']);
    check(typeof doc.key === 'string' && doc.key.length > 0 && doc.key.length <= 200 && !keys.has(doc.key)); keys.add(doc.key);
    check(Array.isArray(doc.fields) && doc.fields.length <= 8 && doc.fields.every(value => typeof value === 'string'));
    const content = doc.fields.map(normalized);
    return { key: doc.key, content, text_digest: `sha256:${fingerprint(content)}` };
  }).sort((a, b) => compareText(a.key, b.key));
  let indexed_bytes = 0, postings = 0;
  try {
    const index = new Map();
    for (const doc of documents) {
      const text = doc.content.join('\n'); indexed_bytes += Buffer.byteLength(text);
      if (indexed_bytes > INDEX_BYTES) throw capacity;
      let position = 0;
      for (const field of doc.content) {
        const words = tokens(field); postings += words.length;
        if (postings > INDEX_POSTINGS) throw capacity;
        words.forEach((word, offset) => {
          if (!index.has(word)) index.set(word, new Map());
          const posting = index.get(word);
          if (!posting.has(doc.key)) posting.set(doc.key, []);
          posting.get(doc.key).push(position + offset);
        });
        // Queries contain at most 32 terms, so this gap prevents a phrase
        // from crossing two independently meaningful fields.
        position += words.length + 33;
      }
    }
    const matched = documents.map(doc => {
      const count = terms.filter(term => index.get(term)?.has(doc.key)).length;
      let hit = count === terms.length;
      if (hit && query.length && r.text.match === 'phrase') {
        hit = index.get(query[0]).get(doc.key).some(start => query.every((term, offset) =>
          index.get(term).get(doc.key).includes(start + offset)));
      }
      return { key: doc.key, evaluated: true, hit, matched_distinct_terms: hit ? count : 0, text_digest: doc.text_digest };
    });
    return freeze({ version: CONTEXT_TEXT_VERSION, matched,
      coverage: { documents: documents.length, indexed_bytes, postings }, degradation: null });
  } catch (error) {
    if (!(error instanceof ContextTextIndexUnavailable)) throw error;
    return freeze({ version: CONTEXT_TEXT_VERSION,
      matched: documents.map(doc => ({ key: doc.key, evaluated: false, hit: null, matched_distinct_terms: 0, text_digest: doc.text_digest })),
      coverage: { documents: documents.length, indexed_bytes: Math.min(indexed_bytes, INDEX_BYTES), postings: Math.min(postings, INDEX_POSTINGS) },
      degradation: { code: 'text_unavailable', reason: error === capacity ? 'index_capacity' : 'index_failure' } });
  }
}
