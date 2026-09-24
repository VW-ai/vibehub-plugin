import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { canonical } from '../shared/contracts.mjs';

export const CONTEXT_PACKAGE_VERSION = 1;
export const CONTEXT_COMPILER_VERSION = 'context-compiler-v1';
export const CONTEXT_PACKAGE_LAYERS = Object.freeze([
  'governing_context',
  'task_contract',
  'decisions_and_constraints',
  'working_state',
  'evidence',
  'unresolved',
  'other_exploration_awareness',
  'source_pointers',
]);
export const CONTEXT_INJECTION_MODES = Object.freeze(['silent', 'soft', 'hard']);

const fail = code => Object.assign(new Error(`Context package: ${code}`), { code });
const check = (condition, code = 'context_package_invalid') => { if (!condition) throw fail(code); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const digest = value => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
const id = value => check(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(value));
const sha = value => check(typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value));
const integer = (value, low, high) => check(Number.isSafeInteger(value) && value >= low && value <= high);

function inert(input) {
  let nodes = 0;
  const ancestors = new Set();
  const visit = (value, depth) => {
    check(++nodes <= 100000 && depth < 32, 'context_package_capacity');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') { check(Number.isFinite(value)); return; }
    check(!isProxy(value) && (plain(value) || Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype)
      && !ancestors.has(value));
    check(Object.getOwnPropertySymbols(value).length === 0);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (Array.isArray(value) && key === 'length') continue;
      check(Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
      check(!Array.isArray(value) || /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length);
    }
    if (Array.isArray(value)) check(Object.keys(value).length === value.length);
    ancestors.add(value); Object.values(value).forEach(child => visit(child, depth + 1)); ancestors.delete(value);
  };
  visit(input, 0);
  check(Buffer.byteLength(JSON.stringify(input)) <= 4 * 1024 * 1024, 'context_package_capacity');
  return JSON.parse(canonical(input));
}

function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

function identityProjection(value) {
  const { package_id: _packageId, ...packageBody } = value;
  return { ...packageBody, usage: { ...packageBody.usage, used_tokens: null } };
}

export function contextPackageId(value) { return digest(identityProjection(value)); }

export function validateContextPackage(input) {
  const value = inert(input);
  check(value.schema_version === CONTEXT_PACKAGE_VERSION && value.kind === 'context_package');
  sha(value.package_id); sha(value.query_result_digest); sha(value.request_digest); sha(value.rank_digest);
  check(plain(value.compiler)); id(value.compiler.compiler_version); id(value.compiler.policy_id); id(value.compiler.policy_version);
  check(value.compiler.compiler_version === CONTEXT_COMPILER_VERSION);
  check(plain(value.consumer) && plain(value.consumer.scope));
  id(value.consumer.consumer_id); id(value.consumer.actor); id(value.consumer.actor_kind);
  id(value.consumer.scope.tenant_id); id(value.consumer.scope.project_id);
  check(value.consumer.session_id === null || typeof value.consumer.session_id === 'string');
  check(value.consumer.task === null || plain(value.consumer.task));
  check(plain(value.window_profile)); id(value.window_profile.profile_id);
  integer(value.window_profile.context_window_tokens, 1, 1048576);
  integer(value.window_profile.reserved_output_tokens, 0, value.window_profile.context_window_tokens - 1);
  check(plain(value.capabilities));
  for (const field of ['callbacks', 'hard_injection', 'markdown', 'source_links']) check(typeof value.capabilities[field] === 'boolean');
  check(plain(value.recommendation) && CONTEXT_INJECTION_MODES.includes(value.recommendation.mode)
    && value.recommendation.executable === false && Array.isArray(value.recommendation.reasons));
  value.recommendation.reasons.forEach(id);
  check(plain(value.pins) && Array.isArray(value.pins.scopes) && Array.isArray(value.pins.shared_bases));
  check(Array.isArray(value.layers) && value.layers.length === CONTEXT_PACKAGE_LAYERS.length);
  check(value.layers.every((layer, index) => plain(layer) && layer.id === CONTEXT_PACKAGE_LAYERS[index] && Array.isArray(layer.items)));
  const pointerLayer = value.layers.at(-1);
  const pointerKeys = new Set();
  for (const pointer of pointerLayer.items) {
    check(plain(pointer)); id(pointer.key); check(!pointerKeys.has(pointer.key)); pointerKeys.add(pointer.key);
  }
  const itemKeys = new Set();
  for (const layer of value.layers.slice(0, -1)) for (const item of layer.items) {
    check(plain(item)); id(item.key); check(!itemKeys.has(item.key)); itemKeys.add(item.key);
    check(typeof item.title === 'string' && item.title.length <= 1024);
    check(item.body === null || typeof item.body === 'string');
    check(['materialized', 'pointer'].includes(item.text_state));
    check(Array.isArray(item.pointer_keys) && item.pointer_keys.length > 0 && item.pointer_keys.every(key => pointerKeys.has(key)));
    if (item.variants !== undefined) {
      check(Array.isArray(item.variants) && item.variants.length > 1);
      for (const variant of item.variants) {
        check(plain(variant) && typeof variant.title === 'string' && (variant.body === null || typeof variant.body === 'string'));
        check(Array.isArray(variant.pointer_keys) && variant.pointer_keys.every(key => pointerKeys.has(key)));
      }
    }
  }
  check(Array.isArray(value.omissions));
  for (const omission of value.omissions) {
    check(plain(omission) && typeof omission.key === 'string' && typeof omission.reason === 'string');
  }
  check(plain(value.usage) && value.usage.accounting === 'utf8_bytes_upper_bound');
  integer(value.usage.max_tokens, 1, 1048576); integer(value.usage.used_tokens, 1, value.usage.max_tokens);
  check(value.usage.max_tokens <= value.window_profile.context_window_tokens - value.window_profile.reserved_output_tokens);
  check(Buffer.byteLength(JSON.stringify(value)) === value.usage.used_tokens);
  check(value.package_id === contextPackageId(value), 'context_package_identity_mismatch');
  return freeze(value);
}

export function contextPackageFailure(code) { return fail(code); }
