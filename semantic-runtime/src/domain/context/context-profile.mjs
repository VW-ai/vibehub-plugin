import { isProxy } from 'node:util/types';
import { canonical } from '../../core/contracts.mjs';
import { validateGraphCommitAddress2 } from '../graph/incremental-graph.mjs';
import { canonicalArtifactAddress, exactRevisionAddress, validateSemanticAddress, validateSemanticRevision } from '../graph/working-graph.mjs';
import { validateNormalizedEvent } from '../sources/event-provenance.mjs';

export const CONTEXT_PROFILE_ERROR_CODES = Object.freeze(['invalid_context_input', 'context_capacity', 'context_transition_invalid']);
const fail = code => Object.assign(new Error(`Context profile: ${code}`), { code });
const check = (ok, code = 'invalid_context_input') => { if (!ok) throw fail(code); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const same = (left, right) => canonical(left) === canonical(right);
function inert(input) {
  let nodes = 0; const stack = new Set();
  const visit = (value, depth) => {
    check(++nodes <= 50000 && depth < 16, 'context_capacity');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') { check(Number.isFinite(value)); return; }
    check(!isProxy(value) && (plain(value) || Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype) && !stack.has(value));
    check(Object.getOwnPropertySymbols(value).length === 0);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (Array.isArray(value) && key === 'length') continue;
      check(Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
      check(!Array.isArray(value) || /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length);
    }
    if (Array.isArray(value)) check(Object.keys(value).length === value.length);
    stack.add(value); Object.values(value).forEach(child => visit(child, depth + 1)); stack.delete(value);
  };
  visit(input, 0); check(Buffer.byteLength(JSON.stringify(input)) <= 1048576, 'context_capacity');
  return JSON.parse(canonical(input));
}
function fields(value, required, optional = []) {
  check(plain(value) && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key)));
}
const id = value => check(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(value));
const digest = value => check(typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value));
const text = (value, max, nonempty = true) => check(typeof value === 'string' && value.length <= max && (!nonempty || value.trim().length > 0));
const exact = value => { validateSemanticAddress(value); check(value.kind === 'semantic_revision'); };
function call(fn) {
  try { return fn(); } catch (error) {
    const descriptor = !isProxy(error) && error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : null;
    throw fail(descriptor && Object.hasOwn(descriptor, 'value') && CONTEXT_PROFILE_ERROR_CODES.includes(descriptor.value)
      ? descriptor.value : 'invalid_context_input');
  }
}
function refs(value, validator) {
  fields(value, ['mode', 'refs']); check(['unspecified', 'any', 'exact'].includes(value.mode));
  check(Array.isArray(value.refs) && value.refs.length <= 8, 'context_capacity');
  check(value.mode === 'exact' ? value.refs.length > 0 : value.refs.length === 0);
  value.refs.forEach(validator);
  const keys = value.refs.map(canonical); check(new Set(keys).size === keys.length);
  value.refs.sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);
}
function content(value) {
  fields(value, ['semantic_type', 'data']); check(value.semantic_type === 'context');
  const data = value.data; fields(data, ['schema_version', 'kind', 'role', 'summary', 'detail', 'applicability', 'change']);
  check(data.schema_version === 1 && data.kind === 'runtime_context');
  check(['decision', 'constraint', 'observation', 'evidence', 'question'].includes(data.role));
  text(data.summary, 512); text(data.detail, 8192, false);
  const applicability = data.applicability;
  fields(applicability, ['project', 'exploration', 'tickets', 'code']);
  check(applicability.project === 'owning' && ['owning', 'unspecified'].includes(applicability.exploration));
  refs(applicability.tickets, ref => {
    fields(ref, ['at', 'address', 'record_key']); validateGraphCommitAddress2(ref.at); exact(ref.address); id(ref.record_key);
    check(ref.address.entity_kind === 'entity' && ref.address.generation_id === ref.at.generation_id && same(ref.address.scope, ref.at.scope));
  });
  refs(applicability.code, ref => { fields(ref, ['event_digest']); digest(ref.event_digest); });
  fields(data.change, ['kind', 'reason']);
  check(['create', 'derive', 'branch', 'revise', 'supersede', 'invalidate', 'resolve'].includes(data.change.kind));
  text(data.change.reason, 2048); return value;
}

/** A discriminator only; matching data still requires full validation. */
export function isContextContent1(input) {
  if (!input || typeof input !== 'object' || isProxy(input)) return false;
  const semantic = Object.getOwnPropertyDescriptor(input, 'semantic_type'), data = Object.getOwnPropertyDescriptor(input, 'data');
  if (semantic?.value !== 'context' || !data || !Object.hasOwn(data, 'value') || !data.value
    || typeof data.value !== 'object' || isProxy(data.value)) return false;
  return Object.getOwnPropertyDescriptor(data.value, 'kind')?.value === 'runtime_context';
}

export function validateContextContent1(input) { return call(() => freeze(content(inert(input)))); }

/** The caller supplies an actual selected branch parent; Graph still owns authorization and concurrency. */
export function validateContextOperation1(input, options = {}) {
  return call(() => {
    const operation = inert(input), opts = inert(options); fields(opts, [], ['branch_parent']);
    fields(operation, ['kind', 'assertion'], operation.kind === 'resolve' ? ['conflict_digest'] : []);
    check(['assert', 'resolve'].includes(operation.kind), 'context_transition_invalid');
    if (operation.kind === 'resolve') digest(operation.conflict_digest);
    const assertion = operation.assertion;
    fields(assertion, ['schema_version', 'assertion_id', 'entity_kind', 'entity_id', 'base_revision', 'parents', 'execution_id', 'status', 'content', 'events', 'canonical_refs'], ['access_revisions']);
    check(assertion.schema_version === 1 && assertion.entity_kind === 'entity');
    [assertion.assertion_id, assertion.entity_id, assertion.execution_id].forEach(id);
    assertion.content = content(assertion.content);
    for (const key of ['parents', 'events', 'canonical_refs']) check(Array.isArray(assertion[key]) && assertion[key].length <= 32, 'context_capacity');
    assertion.parents.forEach(exact); check(new Set(assertion.parents.map(canonical)).size === assertion.parents.length);
    assertion.events.forEach(validateNormalizedEvent);
    assertion.canonical_refs.forEach(ref => check(same(ref, canonicalArtifactAddress(ref.event))));
    if (assertion.access_revisions !== undefined) {
      check(Array.isArray(assertion.access_revisions) && assertion.access_revisions.length <= 32, 'context_capacity');
      assertion.access_revisions.forEach(digest); check(new Set(assertion.access_revisions).size === assertion.access_revisions.length);
    }
    const base = assertion.base_revision, kind = assertion.content.data.change.kind;
    if (base !== null) { exact(base); check(base.entity_kind === 'entity' && base.entity_id === assertion.entity_id, 'context_transition_invalid'); }
    const transition = ok => check(ok, 'context_transition_invalid');
    if (['create', 'derive', 'branch'].includes(kind)) {
      transition(operation.kind === 'assert' && base === null && assertion.status === 'candidate');
      transition(kind === 'create' ? assertion.parents.length === 0 : kind === 'branch' ? assertion.parents.length === 1 : assertion.parents.length > 0);
      if (kind === 'branch') {
        const parent = opts.branch_parent; transition(parent !== undefined && parent !== null);
        validateSemanticRevision(parent); content(parent.assertion.content);
        transition(parent.entity_kind === 'entity' && same(exactRevisionAddress(parent), assertion.parents[0]) && parent.entity_id !== assertion.entity_id);
      }
    } else {
      transition(base !== null);
      if (kind === 'resolve') transition(operation.kind === 'resolve' && assertion.status === 'resolved' && assertion.parents.length > 0);
      else {
        transition(operation.kind === 'assert');
        transition(kind === 'revise' ? ['candidate', 'validated', 'rejected'].includes(assertion.status)
          : kind === 'supersede' ? assertion.status === 'superseded' : assertion.status === 'stale');
      }
    }
    return freeze(operation);
  });
}
