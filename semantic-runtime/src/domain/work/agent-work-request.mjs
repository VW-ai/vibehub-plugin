import { isProxy } from 'node:util/types';
import { fingerprint, canonical } from '../shared/contracts.mjs';

export const AGENT_WORK_REQUEST_VERSION = 1;
export const AGENT_WORK_ACTIONS = Object.freeze(['read_context', 'submit_proposal', 'propose_context', 'propose_ticket', 'propose_resolution', 'propose_plan']);
export const AGENT_WORK_PHASES = Object.freeze(['pending', 'offered', 'claimed', 'completed', 'expired', 'cancelled']);
const proposals = AGENT_WORK_ACTIONS.filter(value => value.startsWith('propose_'));
const fail = code => { throw Object.assign(new TypeError(`Agent work request: ${code}`), { code }); };
const check = (ok, code = 'invalid_contract') => { if (!ok) fail(code); };
const same = (a, b) => canonical(a) === canonical(b);
const hash = value => `sha256:${fingerprint(value)}`;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function inert(value, bytes = 524288) {
  let nodes = 0;
  function visit(v, depth) {
    check(++nodes <= 50000 && depth < 24 && !isProxy(v), 'json_limit');
    if (v === null || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v)) return;
    if (typeof v === 'string') { check(v.length <= 32768, 'string_limit'); return; }
    check(object(v) || Array.isArray(v), 'inert_json_required');
    const array = Array.isArray(v); check([Object.prototype, null, ...(array ? [Array.prototype] : [])].includes(Object.getPrototypeOf(v)), 'inert_json_required');
    check(Object.getOwnPropertySymbols(v).length === 0, 'inert_json_required');
    const descriptors = Object.getOwnPropertyDescriptors(v); check(!array || Object.keys(descriptors).length === v.length + 1, 'inert_json_required');
    for (const [key, d] of Object.entries(descriptors)) {
      if (array && key === 'length') continue;
      check('value' in d && d.enumerable && (!array || /^(0|[1-9]\d*)$/.test(key) && Number(key) < v.length), 'inert_json_required'); visit(d.value, depth + 1);
    }
  }
  visit(value, 0); check(Buffer.byteLength(JSON.stringify(value)) <= bytes, 'byte_limit');
}
const copy = value => JSON.parse(canonical(value));
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const output = value => freeze(copy(value));
function fields(v, required, optional = []) { check(object(v) && required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k)), 'invalid_fields'); }
const id = v => check(typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(v), 'invalid_id');
const exact = v => { id(v); check(!['latest', 'current', '*'].includes(v.toLowerCase()), 'exact_version_required'); };
const digest = v => check(typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v), 'invalid_digest');
const uint = (v, min = 0, max = Number.MAX_SAFE_INTEGER) => check(Number.isSafeInteger(v) && v >= min && v <= max, 'invalid_integer');
const list = (v, max, min = 0) => check(Array.isArray(v) && v.length >= min && v.length <= max, 'list_limit');
function ids(v, max = 32, choices) { list(v, max); v.forEach(choices ? x => check(choices.includes(x), 'invalid_action') : id); check(new Set(v).size === v.length, 'duplicate_id'); }
function scope(v) { fields(v, ['tenant_id', 'project_id']); id(v.tenant_id); id(v.project_id); }
function sealed(v, key) { const { [key]: signature, ...body } = v; digest(signature); check(hash(body) === signature, 'digest_mismatch'); }
function pin(v) { fields(v, ['id', 'version', 'digest']); id(v.id); exact(v.version); digest(v.digest); }
function reference(v) {
  fields(v, ['ref_id', 'scope', 'kind', 'object_id', 'revision', 'digest']); id(v.ref_id); scope(v.scope); id(v.object_id); exact(v.revision); digest(v.digest);
  check(['semantic_revision', 'graph_commit', 'source_snapshot', 'git_revision', 'artifact', 'record'].includes(v.kind), 'invalid_reference_kind');
}
function refs(v, selected, max, minimum = 0) { list(v, max, minimum); v.forEach(r => { reference(r); check(same(r.scope, selected), 'scope_mismatch'); }); check(new Set(v.map(r => r.ref_id)).size === v.length, 'duplicate_reference'); }

// A deliberately small JSON Schema vocabulary: no $ref, regex, callbacks,
// coercion, defaults, combinators or permissive object properties.
function schema(v, depth = 0) {
  check(object(v), 'invalid_schema');
  check(depth < 8, 'schema_depth');
  if (v.type === 'object') {
    fields(v, ['type', 'properties', 'required', 'additionalProperties']); check(object(v.properties) && Object.keys(v.properties).length <= 32 && v.additionalProperties === false, 'invalid_schema');
    ids(v.required); check(v.required.every(k => Object.hasOwn(v.properties, k)), 'invalid_schema');
    for (const [key, nested] of Object.entries(v.properties)) { id(key); schema(nested, depth + 1); }
  } else if (v.type === 'array') { fields(v, ['type', 'items', 'maxItems']); uint(v.maxItems, 1, 64); schema(v.items, depth + 1); }
  else if (v.type === 'string') { fields(v, ['type', 'maxLength'], ['enum']); uint(v.maxLength, 1, 32768); if (v.enum !== undefined) { list(v.enum, 64, 1); check(v.enum.every(x => typeof x === 'string' && x.length <= v.maxLength) && new Set(v.enum).size === v.enum.length, 'invalid_schema'); } }
  else if (['integer', 'number'].includes(v.type)) { fields(v, ['type', 'minimum', 'maximum']); check(Number.isFinite(v.minimum) && Number.isFinite(v.maximum) && v.minimum <= v.maximum, 'invalid_schema'); if (v.type === 'integer') { check(Number.isSafeInteger(v.minimum) && Number.isSafeInteger(v.maximum), 'invalid_schema'); } }
  else { fields(v, ['type']); check(['boolean', 'null'].includes(v.type), 'unsupported_schema'); }
}
function matches(value, shape) {
  if (shape.type === 'object') return object(value) && shape.required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => Object.hasOwn(shape.properties, k) && matches(value[k], shape.properties[k]));
  if (shape.type === 'array') return Array.isArray(value) && value.length <= shape.maxItems && value.every(v => matches(v, shape.items));
  if (shape.type === 'string') return typeof value === 'string' && value.length <= shape.maxLength && (!shape.enum || shape.enum.includes(value));
  if (shape.type === 'number' || shape.type === 'integer') return typeof value === 'number' && Number.isFinite(value) && (shape.type !== 'integer' || Number.isSafeInteger(value)) && value >= shape.minimum && value <= shape.maximum;
  return shape.type === 'null' ? value === null : typeof value === 'boolean';
}
function outputSchema(v) { fields(v, ['id', 'version', 'digest', 'definition']); pin({ id: v.id, version: v.version, digest: v.digest }); schema(v.definition); check(v.digest === hash(v.definition), 'schema_digest_mismatch'); }
function tool(v) {
  fields(v, ['name', 'version', 'origin', 'action', 'parameters_schema', 'examples']); id(v.name); exact(v.version); check(['native', 'runtime'].includes(v.origin), 'invalid_tool_origin');
  check(AGENT_WORK_ACTIONS.includes(v.action), 'invalid_action'); schema(v.parameters_schema); check(v.parameters_schema.type === 'object', 'tool_object_required');
  list(v.examples, 4, 1); check(v.examples.every(example => matches(example, v.parameters_schema)), 'invalid_tool_example');
}
const toolPin = t => ({ name: t.name, version: t.version, origin: t.origin, action: t.action, schema_digest: hash(t.parameters_schema) });
const stringSchema = maxLength => ({ type: 'string', maxLength });
/** Exact tool arguments. The host supplies authenticated executor/job fields. */
export function agentWorkReturnParameters(definition) {
  inert(definition); schema(definition);
  return output({ type: 'object', additionalProperties: false, required: ['request_id', 'request_digest', 'submission_id', 'actions', 'output', 'input_ids'], properties: {
    request_id: stringSchema(200), request_digest: stringSchema(71), submission_id: stringSchema(200),
    actions: { type: 'array', maxItems: 5, items: { ...stringSchema(200), enum: proposals } }, output: definition,
    input_ids: { type: 'array', maxItems: 32, items: stringSchema(200) } } });
}
export function validateAgentWorkRequest(v) {
  inert(v, 262144); fields(v, ['schema_version', 'kind', 'request_id', 'scope', 'job_id', 'attempt_id', 'fencing_token', 'applicability', 'inputs', 'base_versions',
    'instruction_bundle', 'required_tools', 'return_tool', 'output_schema', 'allowed_actions', 'allowed_principal_ids', 'created_at_ms', 'deadline_ms', 'authority', 'request_digest']);
  check(v.schema_version === 1 && v.kind === 'agent_work_request' && v.authority === 'proposal_only', 'unsupported_request');
  ['request_id', 'job_id', 'attempt_id'].forEach(k => id(v[k])); scope(v.scope); uint(v.fencing_token, 1);
  fields(v.applicability, ['exploration_id', 'execution_workspace_id', 'session_id']); Object.values(v.applicability).forEach(x => { if (x !== null) id(x); });
  list(v.inputs, 32, 1); v.inputs.forEach(item => { fields(item, ['ref', 'excerpt']); check(item.excerpt === null || typeof item.excerpt === 'string' && item.excerpt.length <= 8192, 'invalid_excerpt'); });
  refs(v.inputs.map(i => i.ref), v.scope, 32, 1); refs(v.base_versions, v.scope, 16, 1);
  fields(v.instruction_bundle, ['id', 'version', 'digest', 'instructions']); pin({ id: v.instruction_bundle.id, version: v.instruction_bundle.version, digest: v.instruction_bundle.digest });
  check(typeof v.instruction_bundle.instructions === 'string' && v.instruction_bundle.instructions.length > 0 && v.instruction_bundle.instructions.length <= 8192 && hash(v.instruction_bundle.instructions) === v.instruction_bundle.digest, 'instruction_digest_mismatch');
  ids(v.allowed_actions, 6, AGENT_WORK_ACTIONS); check(v.allowed_actions.includes('submit_proposal') && v.allowed_actions.some(x => proposals.includes(x)), 'proposal_action_required');
  ids(v.allowed_principal_ids); check(v.allowed_principal_ids.length > 0, 'principal_required'); outputSchema(v.output_schema);
  list(v.required_tools, 16, 1); v.required_tools.forEach(t => { tool(t); check(v.allowed_actions.includes(t.action), 'tool_action_outside_ceiling'); });
  check(new Set(v.required_tools.map(t => t.name)).size === v.required_tools.length, 'duplicate_tool'); fields(v.return_tool, ['name', 'version']); id(v.return_tool.name); exact(v.return_tool.version);
  const back = v.required_tools.find(t => t.name === v.return_tool.name && t.version === v.return_tool.version);
  check(back?.action === 'submit_proposal' && back.origin === 'runtime' && same(back.parameters_schema, agentWorkReturnParameters(v.output_schema.definition)), 'invalid_return_tool');
  uint(v.created_at_ms); uint(v.deadline_ms, v.created_at_ms + 1); check(v.deadline_ms - v.created_at_ms <= 86400000, 'deadline_limit'); sealed(v, 'request_digest'); return true;
}
export function createAgentWorkRequest(input) {
  inert(input, 262144); check(!['schema_version', 'kind', 'authority', 'request_digest'].some(k => Object.hasOwn(input, k)), 'derived_field'); const body = { ...copy(input), schema_version: 1, kind: 'agent_work_request', authority: 'proposal_only' };
  check(!Object.hasOwn(input, 'request_digest'), 'derived_field'); const request = { ...body, request_digest: hash(body) }; validateAgentWorkRequest(request); return output(request);
}
function executor(v, request) {
  fields(v, ['host_id', 'session_id', 'principal_id']); Object.values(v).forEach(id);
  if (request) check(request.allowed_principal_ids.includes(v.principal_id) && (request.applicability.session_id === null || request.applicability.session_id === v.session_id), 'executor_applicability');
}
export function validateAgentWorkResult(v, request) {
  validateAgentWorkRequest(request); inert(v); fields(v, ['schema_version', 'kind', 'scope', 'request_id', 'request_digest', 'job_id', 'attempt_id', 'fencing_token', 'submission_id', 'executor', 'actions', 'output', 'provenance', 'result_digest']);
  check(v.schema_version === 1 && v.kind === 'agent_work_result', 'unsupported_result');
  for (const key of ['scope', 'request_id', 'request_digest', 'job_id', 'attempt_id', 'fencing_token']) check(same(v[key], request[key]), 'result_binding_mismatch');
  id(v.submission_id); executor(v.executor, request); ids(v.actions, 5, proposals); check(v.actions.every(action => request.allowed_actions.includes(action)), 'result_action_denied');
  check(matches(v.output, request.output_schema.definition), 'invalid_output'); fields(v.provenance, ['input_ids', 'authority']); ids(v.provenance.input_ids);
  check(v.provenance.authority === 'proposal_only' && same([...v.provenance.input_ids].sort(), request.inputs.map(i => i.ref.ref_id).sort()), 'incomplete_provenance'); sealed(v, 'result_digest'); return true;
}
export function createAgentWorkResult(request, input) {
  validateAgentWorkRequest(request); inert(input); fields(input, ['submission_id', 'executor', 'actions', 'output', 'provenance']);
  const body = { schema_version: 1, kind: 'agent_work_result', ...copy(input) };
  for (const key of ['scope', 'request_id', 'request_digest', 'job_id', 'attempt_id', 'fencing_token']) body[key] = request[key];
  const result = { ...body, result_digest: hash(body) }; validateAgentWorkResult(result, request); return output(result);
}
export function agentWorkSubmissionArguments(result, request) {
  validateAgentWorkResult(result, request);
  return output({ request_id: result.request_id, request_digest: result.request_digest, submission_id: result.submission_id, actions: result.actions, output: result.output, input_ids: result.provenance.input_ids });
}
function context(v) {
  inert(v, 1048576); fields(v, ['now_ms', 'actor', 'authorization', 'host', 'trusted_bundles', 'current_bases', 'readable_inputs']); uint(v.now_ms);
  fields(v.actor, ['kind', 'principal_id']); check(['runtime', 'agent'].includes(v.actor.kind), 'invalid_actor'); id(v.actor.principal_id);
  const a = v.authorization; fields(a, ['scope', 'revision', 'revoked', 'can_manage', 'allowed_principal_ids', 'allowed_actions']); scope(a.scope); id(a.revision); check(typeof a.revoked === 'boolean' && typeof a.can_manage === 'boolean', 'invalid_authorization'); ids(a.allowed_principal_ids); ids(a.allowed_actions, 6, AGENT_WORK_ACTIONS);
  const h = v.host; fields(h, ['scope', 'host_id', 'principal_id', 'session_id', 'exploration_id', 'execution_workspace_id', 'status', 'callback', 'tools']); scope(h.scope);
  ['host_id', 'principal_id', 'session_id'].forEach(k => id(h[k])); ['exploration_id', 'execution_workspace_id'].forEach(k => { if (h[k] !== null) id(h[k]); });
  check(['active', 'dormant'].includes(h.status) && ['available', 'unavailable'].includes(h.callback), 'invalid_host'); list(h.tools, 32);
  for (const t of h.tools) { fields(t, ['name', 'version', 'origin', 'action', 'schema_digest', 'binding_id', 'callable']); id(t.name); exact(t.version); id(t.binding_id); digest(t.schema_digest); check(['native', 'runtime'].includes(t.origin) && AGENT_WORK_ACTIONS.includes(t.action) && typeof t.callable === 'boolean', 'invalid_host_tool'); }
  check(new Set(h.tools.map(t => t.name)).size === h.tools.length, 'duplicate_host_tool'); list(v.trusted_bundles, 16); v.trusted_bundles.forEach(pin);
  refs(v.current_bases, a.scope, 16); refs(v.readable_inputs, a.scope, 32);
}
function admission(request, ctx, receipt = false) {
  const a = ctx.authorization, h = ctx.host;
  const denied = reason => ({ status: 'denied', reason, binding_ids: [] });
  if (!same(a.scope, request.scope) || !same(h.scope, request.scope)) return denied('scope_denied');
  if (a.revoked || !a.allowed_principal_ids.includes(h.principal_id) || !request.allowed_principal_ids.includes(h.principal_id)) return denied('principal_denied');
  if (ctx.actor.kind === 'agent' && ctx.actor.principal_id !== h.principal_id) return denied('actor_denied');
  if (!request.allowed_actions.every(action => a.allowed_actions.includes(action))) return denied('action_denied');
  if (Object.entries(request.applicability).some(([k, value]) => value !== null && h[k] !== value)) return denied('applicability_denied');
  if (!request.inputs.every(i => ctx.readable_inputs.some(r => same(r, i.ref)))) return denied('input_denied');
  if (receipt) return { status: 'allowed', reason: null, binding_ids: [] };
  if (ctx.now_ms < request.created_at_ms) return denied('not_yet_created');
  if (ctx.now_ms >= request.deadline_ms) return denied('expired');
  if (!request.base_versions.every(base => ctx.current_bases.some(r => same(r, base)))) return denied('stale_base');
  if (!ctx.trusted_bundles.some(p => same(p, { id: request.instruction_bundle.id, version: request.instruction_bundle.version, digest: request.instruction_bundle.digest }))) return denied('untrusted_instructions');
  if (h.status !== 'active' || h.callback !== 'available') return { status: 'pending', reason: h.status !== 'active' ? 'host_dormant' : 'callback_unavailable', binding_ids: [] };
  const bindings = [];
  for (const t of request.required_tools) {
    const actual = h.tools.find(x => same(toolPin(t), { name: x.name, version: x.version, origin: x.origin, action: x.action, schema_digest: x.schema_digest }));
    if (!actual?.callable) return { status: 'pending', reason: 'tool_unavailable', binding_ids: [] }; bindings.push(actual.binding_id);
  }
  return { status: 'allowed', reason: null, binding_ids: bindings };
}
export function validateAgentWorkAdmission(request, ctx) { validateAgentWorkRequest(request); context(ctx); return output(admission(request, ctx)); }
function manager(request, ctx) { return ctx.actor.kind === 'runtime' && ctx.authorization.can_manage && !ctx.authorization.revoked && same(ctx.authorization.scope, request.scope) && ctx.authorization.allowed_principal_ids.includes(ctx.actor.principal_id); }
const owner = host => ({ host_id: host.host_id, session_id: host.session_id, principal_id: host.principal_id });
function sealState(body) { const { state_digest, ...rest } = body; return output({ ...rest, state_digest: hash(rest) }); }
export function createAgentWorkRequestState(request) {
  validateAgentWorkRequest(request); return sealState({ schema_version: 1, kind: 'agent_work_request_state', request, phase: 'pending', revision: 0,
    last_now_ms: request.created_at_ms, owner: null, offered_at_ms: null, claimed_at_ms: null, receipt: null });
}
export function validateAgentWorkReceipt(v, request) {
  validateAgentWorkRequest(request); inert(v); fields(v, ['schema_version', 'kind', 'scope', 'request_id', 'request_digest', 'job_id', 'attempt_id', 'fencing_token', 'submission_id', 'result_digest', 'executor', 'accepted_at_ms', 'authority', 'receipt_digest']);
  check(v.schema_version === 1 && v.kind === 'agent_work_receipt' && v.authority === 'accepted_submission_only', 'unsupported_receipt');
  for (const key of ['scope', 'request_id', 'request_digest', 'job_id', 'attempt_id', 'fencing_token']) check(same(v[key], request[key]), 'receipt_binding_mismatch');
  id(v.submission_id); digest(v.result_digest); executor(v.executor, request); uint(v.accepted_at_ms, request.created_at_ms, request.deadline_ms - 1); sealed(v, 'receipt_digest'); return true;
}
export function validateAgentWorkRequestState(v) {
  inert(v, 1048576); fields(v, ['schema_version', 'kind', 'request', 'phase', 'revision', 'last_now_ms', 'owner', 'offered_at_ms', 'claimed_at_ms', 'receipt', 'state_digest']);
  check(v.schema_version === 1 && v.kind === 'agent_work_request_state' && AGENT_WORK_PHASES.includes(v.phase), 'unsupported_state'); validateAgentWorkRequest(v.request); uint(v.revision); uint(v.last_now_ms, v.request.created_at_ms);
  if (v.owner !== null) executor(v.owner, v.request);
  if (v.offered_at_ms !== null) uint(v.offered_at_ms, v.request.created_at_ms, v.request.deadline_ms - 1);
  if (v.claimed_at_ms !== null) uint(v.claimed_at_ms, v.offered_at_ms ?? v.request.created_at_ms, v.request.deadline_ms - 1);
  check((v.owner === null) === (v.offered_at_ms === null) && (v.claimed_at_ms === null || v.offered_at_ms !== null), 'invalid_owner_history');
  check(v.last_now_ms >= (v.claimed_at_ms ?? v.offered_at_ms ?? v.request.created_at_ms), 'invalid_time');
  const history = Number(v.offered_at_ms !== null) + Number(v.claimed_at_ms !== null);
  if (v.phase === 'pending') check(history === 0 && v.revision === 0 && v.last_now_ms === v.request.created_at_ms, 'invalid_pending');
  if (v.phase === 'offered') check(history === 1 && v.revision === 1 && v.last_now_ms === v.offered_at_ms, 'invalid_offered');
  if (v.phase === 'claimed') check(history === 2 && v.revision === 2 && v.last_now_ms === v.claimed_at_ms, 'invalid_claimed');
  if (['completed', 'expired', 'cancelled'].includes(v.phase)) check(v.revision === history + 1, 'invalid_terminal_history');
  if (v.phase === 'completed') { check(history === 2 && v.receipt !== null, 'missing_receipt'); validateAgentWorkReceipt(v.receipt, v.request); check(same(v.receipt.executor, v.owner) && v.receipt.accepted_at_ms === v.last_now_ms, 'invalid_receipt_history'); }
  else check(v.receipt === null, 'unexpected_receipt');
  if (v.phase === 'expired') check(v.last_now_ms >= v.request.deadline_ms, 'not_expired');
  else check(v.last_now_ms < v.request.deadline_ms, 'late_state');
  sealed(v, 'state_digest'); return true;
}
export function transitionAgentWorkRequest(state, command, ctx) {
  validateAgentWorkRequestState(state); inert(command); context(ctx); fields(command, ['type', 'expected_revision'], command.type === 'submit' ? ['result'] : []); uint(command.expected_revision);
  check(['offer', 'claim', 'submit', 'expire', 'cancel'].includes(command.type), 'unknown_transition');
  const terminal = ['completed', 'expired', 'cancelled'].includes(state.phase);
  const request = state.request, response = (status, reason, next = state, effects = []) => output({ status, reason, state: next, receipt: next.receipt, effects });
  if (ctx.now_ms < state.last_now_ms) return response('rejected', 'time_reversed');
  if (command.type === 'expire' || command.type === 'cancel') {
    if (!manager(request, ctx)) return response('rejected', 'manager_denied');
  } else {
    const a = admission(request, ctx, terminal);
    if (a.status !== 'allowed') return response(a.status === 'pending' ? 'pending' : 'rejected', a.reason);
    if (command.type === 'offer' ? !manager(request, ctx) : ctx.actor.kind !== 'agent') return response('rejected', 'actor_denied');
  }
  if (terminal && !(command.type === 'submit' && state.phase === 'completed')) return response('rejected', 'terminal');
  if (command.type === 'submit') {
    try { validateAgentWorkResult(command.result, request); } catch { return response('rejected', 'invalid_result'); }
    if (!same(command.result.executor, owner(ctx.host)) || !same(state.owner, command.result.executor)) return response('rejected', 'owner_mismatch');
    if (state.receipt) return state.receipt.result_digest === command.result.result_digest && state.receipt.submission_id === command.result.submission_id
      ? response('duplicate', null) : response('rejected', 'idempotency_conflict');
  }
  if (['completed', 'expired', 'cancelled'].includes(state.phase)) return response('rejected', 'terminal');
  if (command.type !== 'expire' && ctx.now_ms >= request.deadline_ms) return response('rejected', 'expired');
  if ((command.type === 'offer' && state.phase === 'offered') || (command.type === 'claim' && state.phase === 'claimed')) return same(state.owner, owner(ctx.host)) ? response('duplicate', null) : response('rejected', 'owner_mismatch');
  if (command.expected_revision !== state.revision) return response('rejected', 'revision_mismatch');
  const next = copy(state); next.revision++; next.last_now_ms = ctx.now_ms; let effect;
  if (command.type === 'offer') {
    if (state.phase !== 'pending') return response('rejected', 'invalid_phase');
    next.phase = 'offered'; next.owner = owner(ctx.host); next.offered_at_ms = ctx.now_ms; effect = 'work_request_offered';
  } else if (command.type === 'claim') {
    if (state.phase !== 'offered' || !same(state.owner, owner(ctx.host))) return response('rejected', 'owner_mismatch');
    next.phase = 'claimed'; next.claimed_at_ms = ctx.now_ms; effect = 'work_request_claimed';
  } else if (command.type === 'submit') {
    if (state.phase !== 'claimed') return response('rejected', 'invalid_phase');
    const body = { schema_version: 1, kind: 'agent_work_receipt', authority: 'accepted_submission_only', executor: state.owner, accepted_at_ms: ctx.now_ms };
    for (const key of ['scope', 'request_id', 'request_digest', 'job_id', 'attempt_id', 'fencing_token', 'submission_id', 'result_digest']) body[key] = command.result[key];
    next.receipt = { ...body, receipt_digest: hash(body) }; next.phase = 'completed'; effect = 'proposal_submitted';
  } else {
    if (command.type === 'expire' && ctx.now_ms < request.deadline_ms) return response('rejected', 'not_expired');
    next.phase = command.type === 'cancel' ? 'cancelled' : 'expired'; effect = `work_request_${next.phase}`;
  }
  const sealed = sealState(next); validateAgentWorkRequestState(sealed);
  return response('applied', null, sealed, [{ type: effect, request_id: request.request_id, request_digest: request.request_digest, authority: 'proposal_only' }]);
}
