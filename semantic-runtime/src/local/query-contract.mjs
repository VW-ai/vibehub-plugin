import { types } from 'node:util';
import { graphInput, graphFields, graphId, graphEqual, graphHash, graphErrorCode } from './graph-inputs.mjs';
import { validateGraphCommitAddress2 } from '../core/incremental-graph.mjs';
import { validateSemanticAddress } from '../core/working-graph.mjs';
import { validateFreshnessVector } from '../core/causal-ordering.mjs';
import { validateExplorationPin } from './exploration-inputs.mjs';
import { validateContextReadRequest } from './context-reader.mjs';

export const queryFailure = code => Object.assign(new Error(`Local Query: ${code}`), { code });
export const queryCheck = (ok, code = 'query_invalid_request') => { if (!ok) throw queryFailure(code); };
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export function queryCopy(value) {
  try { return freeze(graphInput(value)); }
  catch (error) { throw queryFailure(graphErrorCode(error) === 'graph_capacity' ? 'query_capacity' : 'query_invalid_request'); }
}
const fields = graphFields;
const integer = (v, low, high) => queryCheck(Number.isSafeInteger(v) && v >= low && v <= high);
const list = (v, max) => queryCheck(Array.isArray(v) && v.length <= max);
const unique = array => queryCheck(new Set(array.map(graphHash)).size === array.length);
const exact = ref => { validateSemanticAddress(ref); queryCheck(ref.kind === 'semantic_revision' && ref.entity_kind === 'entity'); };
const canonicalRef = ref => {
  fields(ref, ['at', 'address', 'record_key']); validateGraphCommitAddress2(ref.at); exact(ref.address); graphId(ref.record_key);
  queryCheck(graphEqual(ref.at.scope, ref.address.scope) && ref.at.generation_id === ref.address.generation_id);
};
const scopeSelection = value => {
  fields(value, ['exploration_id', 'at', 'mode', 'expected_shared_base', 'heads_cursor']);
  graphId(value.exploration_id); validateGraphCommitAddress2(value.at);
  queryCheck(['current', 'as_of'].includes(value.mode));
  if (value.expected_shared_base !== null) { validateExplorationPin(value.expected_shared_base); value.expected_shared_base.record_keys.sort(); }
  validateContextReadRequest({ exploration_id: value.exploration_id, at: value.at, mode: value.mode,
    collection: { kind: 'heads' }, cursor: value.heads_cursor, limit: 8 }, 'page');
};

/** The public wire carries locators and consumer hints, never selected text or grants. */
export function queryRequest(input) {
  try {
    const r = graphInput(input);
    fields(r, ['schema_version', 'request_id', 'consumer', 'own', 'related', 'expected_project_selection_version',
      'expected_source_fence', 'exact', 'lineage', 'text', 'scope', 'seen_refs', 'freshness', 'budget', 'judge']);
    queryCheck(r.schema_version === 1); graphId(r.request_id);
    fields(r.consumer, ['consumer_id', 'session_id', 'task']); graphId(r.consumer.consumer_id);
    if (r.consumer.session_id !== null) graphId(r.consumer.session_id);
    if (r.consumer.task !== null) canonicalRef(r.consumer.task);
    scopeSelection(r.own); list(r.related, 2); r.related.forEach(scopeSelection);
    r.related.sort((a, b) => a.exploration_id < b.exploration_id ? -1 : a.exploration_id > b.exploration_id ? 1 : 0);
    const selections = [r.own, ...r.related];
    unique(selections.map(s => s.exploration_id)); unique(selections.map(s => s.at.generation_id));
    queryCheck(selections.every(s => graphEqual(s.at.scope, r.own.at.scope)));
    if (r.expected_project_selection_version !== null) integer(r.expected_project_selection_version, 1, Number.MAX_SAFE_INTEGER);
    integer(r.expected_source_fence, 0, Number.MAX_SAFE_INTEGER);
    list(r.exact, 8); unique(r.exact);
    for (const entry of r.exact) {
      fields(entry, ['exploration_id', 'address']); graphId(entry.exploration_id); exact(entry.address);
      const s = selections.find(s => s.exploration_id === entry.exploration_id);
      queryCheck(s && entry.address.generation_id === s.at.generation_id && graphEqual(entry.address.scope, s.at.scope));
    }
    if (r.lineage !== null) {
      fields(r.lineage, ['address', 'cursor']); exact(r.lineage.address);
      validateContextReadRequest({ exploration_id: r.own.exploration_id, at: r.own.at, mode: r.own.mode,
        address: r.lineage.address, cursor: r.lineage.cursor, limit: 8 }, 'lineage');
    }
    fields(r.text, ['value', 'match']); queryCheck(typeof r.text.value === 'string' && Buffer.byteLength(r.text.value) <= 4096
      && ['all_terms', 'phrase'].includes(r.text.match));
    queryCheck((r.text.value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).length <= 32);
    fields(r.scope, ['tickets', 'rooms', 'repositories']);
    for (const dimension of ['tickets', 'rooms']) { list(r.scope[dimension], 2); unique(r.scope[dimension]); r.scope[dimension].forEach(canonicalRef); }
    const filterRefs = [...r.scope.tickets, ...r.scope.rooms, ...(r.consumer.task ? [r.consumer.task] : [])];
    queryCheck(filterRefs.every(ref => graphEqual(ref.at.scope, r.own.at.scope)));
    list(r.scope.repositories, 4); unique(r.scope.repositories); r.scope.repositories.forEach(graphId);
    list(r.seen_refs, 32); unique(r.seen_refs); r.seen_refs.forEach(exact);
    queryCheck(r.seen_refs.every(ref => graphEqual(ref.scope, r.own.at.scope)));
    fields(r.freshness, ['minimum_watermarks', 'max_commit_lag', 'allow_unknown_coverage']);
    queryCheck(typeof r.freshness.allow_unknown_coverage === 'boolean');
    if (r.freshness.max_commit_lag !== null) integer(r.freshness.max_commit_lag, 0, 10000);
    list(r.freshness.minimum_watermarks, 3); unique(r.freshness.minimum_watermarks.map(m => m.exploration_id));
    for (const minimum of r.freshness.minimum_watermarks) {
      fields(minimum, ['exploration_id', 'vector']); graphId(minimum.exploration_id); validateFreshnessVector(minimum.vector);
      queryCheck(selections.some(s => s.exploration_id === minimum.exploration_id) && graphEqual(minimum.vector.scope, r.own.at.scope));
    }
    fields(r.budget, ['max_results', 'token_budget']); integer(r.budget.max_results, 1, 16); integer(r.budget.token_budget, 1, 262144);
    if (r.judge !== null) {
      fields(r.judge, ['node_id', 'event_id', 'epoch', 'execution', 'execution_workspace_id', 'expected_binding_version', 'expected_catalog_version']);
      for (const key of ['node_id', 'event_id', 'execution_workspace_id']) graphId(r.judge[key]);
      integer(r.judge.epoch, 0, Number.MAX_SAFE_INTEGER);
      integer(r.judge.expected_binding_version, 1, Number.MAX_SAFE_INTEGER); integer(r.judge.expected_catalog_version, 1, Number.MAX_SAFE_INTEGER);
      fields(r.judge.execution, ['repository_id', 'checkout_id', 'worktree_id']); Object.values(r.judge.execution).forEach(graphId);
    }
    return freeze(r);
  } catch (error) {
    const code = graphErrorCode(error);
    throw queryFailure(['graph_capacity', 'query_capacity', 'context_capacity'].includes(code) ? 'query_capacity' : 'query_invalid_request');
  }
}

export function querySignal(options) {
  queryCheck(options && typeof options === 'object' && !types.isProxy(options) && Object.getPrototypeOf(options) === Object.prototype
    && Reflect.ownKeys(options).every(key => key === 'signal')
    && Object.values(Object.getOwnPropertyDescriptors(options)).every(d => Object.hasOwn(d, 'value') && d.enumerable));
  const signal = options.signal;
  queryCheck(signal === undefined || !types.isProxy(signal) && signal instanceof AbortSignal); return signal;
}
