import { createHash } from 'node:crypto';
import { resolveIdentity, validateIdentityCatalog } from '../identity/identity.mjs';
import { validateNormalizedEvent, eventObservationKey, effectiveEventAccess } from '../sources/event-provenance.mjs';
import { validateFreshnessVector } from '../sources/causal-ordering.mjs';
import { validateSemanticAddress, validateGraphRevisionAddress, graphRevisionAddress, resolveWorkingGraphAddress, validateWorkingGraph } from '../graph/working-graph.mjs';
import { compilePolicyArtifact } from '../decisions/policy-artifacts.mjs';
import { normalizeUsageObservation } from '../decisions/observability-contract.mjs';

// Pure wire contracts. Trusted adapters own authentication, current-state reads,
// atomic CAS/outbox/accounting, immutable source bytes, and durable fencing.
export const WORKER_PROTOCOL_VERSION = 1;
export const WORKER_JOB_STATES = Object.freeze(['queued', 'leased', 'running', 'succeeded', 'failed', 'expired', 'cancelled', 'superseded', 'dead-letter']);
export const WORKER_OPERATIONS = Object.freeze(['read_context', 'propose_candidate', 'propose_resolution', 'propose_canonical', 'propose_plan']);
const TERMINAL = ['succeeded', 'failed', 'expired', 'cancelled', 'superseded', 'dead-letter'];
const ATTEMPT_STATES = ['leased', 'running', 'succeeded', 'failed', 'expired', 'cancelled', 'superseded'];
const SENSITIVITY = ['normal', 'sensitive', 'restricted'];
const LOCALITIES = ['local', 'cloud'];
const FAILURE_CODES = ['executor_unavailable', 'provider_unavailable', 'rate_limited', 'invalid_output', 'permission_denied', 'cancelled', 'budget_exhausted', 'internal_failure'];
const assert = (v, code) => { if (!v) throw new TypeError(`Worker protocol: ${code}`); };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
function json(v, ancestors = new Set(), budget = { n: 0 }) {
  assert(++budget.n <= 250000 && ancestors.size < 40, 'json_limit');
  if (v === null || typeof v === 'boolean') return;
  if (typeof v === 'string') { assert(v.length <= 16384, 'string_limit'); return; }
  if (typeof v === 'number') { assert(Number.isFinite(v), 'finite_number_required'); return; }
  assert((object(v) || Array.isArray(v)) && !ancestors.has(v), 'json_required');
  assert(!Object.getOwnPropertySymbols(v).length, 'json_symbols');
  for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
    if (Array.isArray(v) && key === 'length') continue;
    assert(Object.hasOwn(d, 'value') && d.enumerable, 'json_data_property_required');
    assert(!Array.isArray(v) || /^(0|[1-9]\d*)$/.test(key) && Number(key) < v.length, 'json_array_property');
  }
  if (Array.isArray(v)) assert(Object.keys(v).length === v.length, 'json_sparse_array');
  ancestors.add(v); Object.values(v).forEach(x => json(x, ancestors, budget)); ancestors.delete(v);
}
const canonical = v => Array.isArray(v) ? v.map(canonical) : object(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const stable = v => JSON.stringify(canonical(v));
const hash = v => `sha256:${createHash('sha256').update(stable(v)).digest('hex')}`;
const same = (a, b) => stable(a) === stable(b);
const clone = v => JSON.parse(stable(v));
function freeze(v) { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
const output = v => freeze(clone(v));
function fields(v, required, optional = []) {
  assert(object(v) && required.every(k => Object.hasOwn(v, k)), 'missing_field');
  assert(Object.keys(v).every(k => required.includes(k) || optional.includes(k)), 'unknown_field');
}
const id = v => assert(typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(v), 'invalid_id');
const exactVersion = v => { id(v); assert(!['latest', 'current', '*'].includes(v.toLowerCase()), 'exact_version_required'); };
const digest = v => assert(typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v), 'invalid_digest');
const integer = (v, min = 0, max = Number.MAX_SAFE_INTEGER) => assert(Number.isSafeInteger(v) && v >= min && v <= max, 'invalid_integer');
const enumValue = (v, values) => assert(values.includes(v), 'invalid_category');
function list(v, max = 128) { assert(Array.isArray(v) && v.length <= max, 'bounded_list_required'); }
function ids(v, values) { list(v); v.forEach(values ? x => enumValue(x, values) : id); assert(new Set(v).size === v.length, 'duplicate_id'); }
function scope(v) { fields(v, ['tenant_id', 'project_id']); Object.values(v).forEach(id); }
function scoped(v, job) { assert(same(v, job.scope), 'scope_mismatch'); }
function version(v) { assert(v.schema_version === 1, 'unsupported_version'); }
function bounded(v, bytes) { json(v); assert(Buffer.byteLength(stable(v)) <= bytes, 'envelope_size'); }
function policyPin(v) {
  fields(v, ['policy_id', 'version', 'content_hash', 'executable_hash']); id(v.policy_id); exactVersion(v.version); digest(v.content_hash); digest(v.executable_hash);
}
function operation(v) { fields(v, ['id', 'version', 'implementation_hash']); id(v.id); exactVersion(v.version); digest(v.implementation_hash); }
function schemaPin(v) { fields(v, ['id', 'version', 'digest']); id(v.id); exactVersion(v.version); digest(v.digest); }
function capabilities(v) {
  fields(v, ['allowed_principal_ids', 'allowed_operations', 'allowed_provider_ids', 'allowed_localities', 'sensitivity_ceiling']);
  ids(v.allowed_principal_ids); ids(v.allowed_operations, WORKER_OPERATIONS); ids(v.allowed_provider_ids); ids(v.allowed_localities, LOCALITIES); enumValue(v.sensitivity_ceiling, SENSITIVITY);
}
// This fixed schema deliberately has no arbitrary reasoning, command, approval,
// or canonical-status fields. Human-readable findings are untrusted data.
const findingFields = ['finding_id', 'operation', 'summary', 'confidence', 'input_revision_indexes', 'source_event_indexes', 'artifact_indexes'];
export const WORKER_OUTPUT_SCHEMA = freeze({ id: 'worker-findings', version: '1', digest: hash({ version: 1, finding_fields: findingFields, operations: WORKER_OPERATIONS.filter(x => x !== 'read_context'), authority: 'proposal_only' }) });
function inputSet(v, job) {
  fields(v, ['graph_revision', 'revisions', 'source_events', 'watermarks']); validateGraphRevisionAddress(v.graph_revision); scoped(v.graph_revision.scope, job);
  list(v.revisions, 32); assert(v.revisions.length > 0, 'input_revision_required');
  const seen = new Set();
  for (const r of v.revisions) {
    validateSemanticAddress(r); assert(r.kind === 'semantic_revision', 'immutable_revision_required'); scoped(r.scope, job);
    assert(r.generation_id === v.graph_revision.generation_id, 'generation_mismatch'); assert(!seen.has(stable(r)), 'duplicate_revision'); seen.add(stable(r));
  }
  list(v.source_events, 64); assert(v.source_events.length > 0, 'source_provenance_required'); const events = new Set();
  for (const e of v.source_events) {
    validateNormalizedEvent(e); scoped({ tenant_id: e.partition.tenant_id, project_id: e.partition.project_id }, job);
    assert(e.replay.eligible && e.payload.kind !== 'mutable_pointer' && e.provenance.source_objects.length > 0, 'immutable_source_required');
    const key = eventObservationKey(e); assert(!events.has(key), 'duplicate_source_event'); events.add(key);
  }
  validateFreshnessVector(v.watermarks); scoped(v.watermarks.scope, job);
}
export function validateWorkerJob(job) {
  bounded(job, 524288); fields(job, ['schema_version', 'job_id', 'scope', 'worker_type', 'trigger', 'continuation', 'inputs', 'capability_ceiling', 'output_schema', 'created_at_ms', 'deadline_ms', 'retry', 'idempotency_key']);
  version(job); id(job.job_id); scope(job.scope); id(job.worker_type); id(job.idempotency_key);
  fields(job.trigger, ['policy_run_id', 'policy', 'node_id', 'operation']); id(job.trigger.policy_run_id); policyPin(job.trigger.policy); id(job.trigger.node_id); operation(job.trigger.operation);
  fields(job.continuation, ['policy', 'node_id']); policyPin(job.continuation.policy); id(job.continuation.node_id);
  // Wire v1 resumes a named node in the same pinned artifact as a NEW policy run.
  assert(same(job.continuation.policy, job.trigger.policy), 'continuation_policy_mismatch');
  inputSet(job.inputs, job); capabilities(job.capability_ceiling); schemaPin(job.output_schema);
  assert(same(job.output_schema, WORKER_OUTPUT_SCHEMA), 'unsupported_output_schema');
  integer(job.created_at_ms); integer(job.deadline_ms, job.created_at_ms + 1); assert(job.deadline_ms - job.created_at_ms <= 86400000, 'deadline_limit');
  fields(job.retry, ['max_attempts', 'lease_ms']); integer(job.retry.max_attempts, 1, 32); integer(job.retry.lease_ms, 1, 600000);
  return true;
}
function workerDescriptor(w) {
  fields(w, ['scope', 'worker_id', 'principal_id', 'provider_id', 'model_id', 'locality']); scope(w.scope);
  for (const k of ['worker_id', 'principal_id', 'provider_id']) id(w[k]); exactVersion(w.model_id); enumValue(w.locality, LOCALITIES);
}
function authorization(a) {
  fields(a, ['schema_version', 'scope', 'authorization_revision', 'revoked', 'capabilities']); version(a); scope(a.scope); id(a.authorization_revision); assert(typeof a.revoked === 'boolean', 'invalid_revocation'); capabilities(a.capabilities);
}
function intersection(a, b) {
  return { allowed_principal_ids: a.allowed_principal_ids.filter(x => b.allowed_principal_ids.includes(x)),
    allowed_operations: a.allowed_operations.filter(x => b.allowed_operations.includes(x)),
    allowed_provider_ids: a.allowed_provider_ids.filter(x => b.allowed_provider_ids.includes(x)),
    allowed_localities: a.allowed_localities.filter(x => b.allowed_localities.includes(x)),
    sensitivity_ceiling: SENSITIVITY[Math.min(SENSITIVITY.indexOf(a.sensitivity_ceiling), SENSITIVITY.indexOf(b.sensitivity_ceiling))] };
}
function eventUnion(revisions) {
  const events = new Map();
  for (const r of revisions) for (const e of [...r.provenance.events, ...r.provenance.access_events]) {
    const key = eventObservationKey(e); assert(!events.has(key) || same(events.get(key), e), 'source_identity_rebound'); events.set(key, e);
  }
  return [...events.values()];
}
const unorderedSame = (a, b) => same(a.map(stable).sort(), b.map(stable).sort());
/** Current inputs are selected by a trusted service, not taken from a worker request. */
export function validateWorkerAdmission(job, context) {
  validateWorkerJob(job); json(context); fields(context, ['catalog', 'policy_artifact', 'current_graph', 'authorization', 'worker']);
  validateIdentityCatalog(context.catalog); authorization(context.authorization); workerDescriptor(context.worker);
  const denied = reason => output({ status: 'denied', reason, capabilities: null });
  if (!same(context.authorization.scope, job.scope) || !same(context.worker.scope, job.scope)) return denied('scope_mismatch');
  if (resolveIdentity(context.catalog, job.scope).status !== 'resolved') return denied('unmapped_scope');
  const artifact = context.policy_artifact;
  const compiled = compilePolicyArtifact(artifact.definition, { operations: artifact.operations });
  assert(same(compiled, artifact), 'invalid_policy_artifact');
  const pin = { policy_id: artifact.policy_id, version: artifact.version, content_hash: artifact.content_hash, executable_hash: artifact.executable_hash };
  if (!same(pin, job.trigger.policy)) return denied('policy_mismatch');
  const node = artifact.definition.nodes[job.trigger.node_id];
  const descriptor = artifact.operations.find(x => x.id === job.trigger.operation.id && x.version === job.trigger.operation.version);
  if (!node || node.type !== 'worker' || !same(node.operation, { id: job.trigger.operation.id, version: job.trigger.operation.version }) || descriptor?.implementation_hash !== job.trigger.operation.implementation_hash) return denied('operation_mismatch');
  if (!Object.hasOwn(artifact.definition.nodes, job.continuation.node_id)) return denied('continuation_missing');
  if (context.authorization.revoked) return denied('authorization_revoked');
  const effective = intersection(job.capability_ceiling, context.authorization.capabilities), worker = context.worker;
  if (!effective.allowed_principal_ids.includes(worker.principal_id) || !effective.allowed_operations.includes('read_context') || effective.allowed_operations.length < 2 || !effective.allowed_provider_ids.includes(worker.provider_id) || !effective.allowed_localities.includes(worker.locality)) return denied('capability_denied');
  validateWorkingGraph(context.current_graph);
  if (!same(context.current_graph.catalog, context.catalog)) return denied('catalog_mismatch');
  if (!same(graphRevisionAddress(context.current_graph), job.inputs.graph_revision)) return denied('stale_graph');
  if (job.inputs.watermarks.status !== 'caught-up' || context.current_graph.snapshots.at(-1).watermarks.status !== 'caught-up' || !same(job.inputs.watermarks, context.current_graph.snapshots.at(-1).watermarks)) return denied('stale_sources');
  const revisions = [];
  for (const address of job.inputs.revisions) {
    const found = resolveWorkingGraphAddress(context.current_graph, address, { principal_id: worker.principal_id, current_graph: context.current_graph, graph_revision: job.inputs.graph_revision });
    if (found.status !== 'resolved') return denied('source_unavailable');
    revisions.push(found.revision);
  }
  if (!unorderedSame(eventUnion(revisions), job.inputs.source_events)) return denied('provenance_mismatch');
  for (const e of job.inputs.source_events) {
    const access = effectiveEventAccess(e);
    if (!access.allowed_principal_ids.includes(worker.principal_id) || SENSITIVITY.indexOf(access.sensitivity) > SENSITIVITY.indexOf(effective.sensitivity_ceiling)) return denied('source_access_denied');
  }
  return output({ status: 'allowed', reason: 'current_authorization_intersection', capabilities: effective });
}
function indexes(v, length, nonempty = false) {
  list(v, 64); assert(!nonempty || v.length > 0, 'provenance_indexes_required'); v.forEach(x => integer(x, 0, length - 1)); assert(new Set(v).size === v.length, 'duplicate_index');
}
function classifiedFailure(value) {
  fields(value, ['code', 'retryable']); enumValue(value.code, FAILURE_CODES); assert(typeof value.retryable === 'boolean', 'invalid_failure');
  if (['permission_denied', 'cancelled', 'budget_exhausted'].includes(value.code)) assert(!value.retryable, 'nonretryable_failure');
}
function resultBody(value) { const { result_digest: ignored, ...body } = value; return body; }
/** Digest is an identity/integrity binding, never an executor credential. */
export function workerResultDigest(body) { bounded(body, 1048576); return hash(body); }
export function validateWorkerResult(value, job) {
  validateWorkerJob(job); bounded(value, 1048576);
  fields(value, ['schema_version', 'result_id', 'result_digest', 'scope', 'job_id', 'job_digest', 'attempt_id', 'fencing_token', 'trigger', 'consumed_inputs', 'output_schema', 'status', 'findings', 'artifacts', 'provenance', 'executor', 'usage', 'timings', 'failure']);
  version(value); scope(value.scope); scoped(value.scope, job); id(value.result_id); id(value.job_id); id(value.attempt_id); integer(value.fencing_token, 1, 32); digest(value.job_digest); digest(value.result_digest);
  assert(value.job_id === job.job_id && value.job_digest === hash(job), 'job_identity_mismatch');
  assert(same(value.trigger, job.trigger) && same(value.consumed_inputs, job.inputs) && same(value.output_schema, job.output_schema), 'consumed_input_mismatch');
  enumValue(value.status, ['succeeded', 'failed']); workerDescriptor(value.executor); scoped(value.executor.scope, job);
  normalizeUsageObservation(value.usage); fields(value.timings, ['started_at_ms', 'finished_at_ms', 'duration_ms']);
  integer(value.timings.started_at_ms, job.created_at_ms); integer(value.timings.finished_at_ms, value.timings.started_at_ms); integer(value.timings.duration_ms);
  assert(value.timings.duration_ms === value.timings.finished_at_ms - value.timings.started_at_ms, 'timing_mismatch');
  list(value.artifacts, 32);
  const artifacts = new Set();
  for (const a of value.artifacts) {
    fields(a, ['schema_version', 'scope', 'artifact_id', 'revision', 'digest', 'kind', 'source_event_indexes']); version(a); scoped(a.scope, job); id(a.artifact_id); exactVersion(a.revision); digest(a.digest); enumValue(a.kind, ['candidate', 'proposal']);
    indexes(a.source_event_indexes, job.inputs.source_events.length, true); const key = stable([a.artifact_id, a.revision]); assert(!artifacts.has(key), 'duplicate_artifact'); artifacts.add(key);
  }
  fields(value.provenance, ['source_event_indexes', 'input_revision_indexes', 'authority']); assert(value.provenance.authority === 'proposal_only', 'authority_elevation');
  assert(same(value.provenance.source_event_indexes, job.inputs.source_events.map((_, i) => i)) && same(value.provenance.input_revision_indexes, job.inputs.revisions.map((_, i) => i)), 'incomplete_provenance');
  list(value.findings, 64); const findings = new Set();
  for (const f of value.findings) {
    fields(f, findingFields); id(f.finding_id); assert(!findings.has(f.finding_id), 'duplicate_finding'); findings.add(f.finding_id);
    enumValue(f.operation, WORKER_OPERATIONS.filter(x => x !== 'read_context')); assert(job.capability_ceiling.allowed_operations.includes(f.operation), 'operation_exceeds_ceiling');
    assert(typeof f.summary === 'string' && f.summary.trim().length > 0 && f.summary.length <= 4096, 'invalid_finding_summary');
    assert(typeof f.confidence === 'number' && f.confidence >= 0 && f.confidence <= 1, 'invalid_confidence');
    indexes(f.input_revision_indexes, job.inputs.revisions.length, true); indexes(f.source_event_indexes, job.inputs.source_events.length, true); indexes(f.artifact_indexes, value.artifacts.length);
  }
  if (value.status === 'succeeded') assert(value.failure === null, 'success_has_failure');
  else {
    assert(value.findings.length === 0 && value.artifacts.length === 0, 'failed_result_has_proposals');
    classifiedFailure(value.failure);
  }
  assert(value.result_digest === hash(resultBody(value)), 'result_digest_mismatch'); return true;
}
function stateBody(state) { const { state_digest: ignored, ...body } = state; return body; }
function sealState(state) { state.state_digest = hash(stateBody(state)); return output(state); }
export function createWorkerJobState(job) {
  validateWorkerJob(job);
  return sealState({ schema_version: 1, job, job_digest: hash(job), revision: 0, status: 'queued', last_now_ms: job.created_at_ms, attempts: [], receipts: [] });
}
export function validateWorkerJobState(state) {
  bounded(state, 2097152); fields(state, ['schema_version', 'job', 'job_digest', 'state_digest', 'revision', 'status', 'last_now_ms', 'attempts', 'receipts']); version(state); validateWorkerJob(state.job); digest(state.job_digest); digest(state.state_digest);
  assert(state.job_digest === hash(state.job) && state.state_digest === hash(stateBody(state)), 'state_digest_mismatch'); integer(state.revision); integer(state.last_now_ms, state.job.created_at_ms); enumValue(state.status, WORKER_JOB_STATES);
  list(state.attempts, state.job.retry.max_attempts); list(state.receipts, state.job.retry.max_attempts); const seen = new Set();
  for (const [i, a] of state.attempts.entries()) {
    fields(a, ['attempt_id', 'fencing_token', 'worker', 'status', 'claimed_at_ms', 'started_at_ms', 'lease_expires_at_ms', 'last_now_ms', 'finished_at_ms', 'result_digest', 'failure']);
    id(a.attempt_id); assert(!seen.has(a.attempt_id), 'duplicate_attempt'); seen.add(a.attempt_id); assert(a.fencing_token === i + 1, 'fencing_sequence'); workerDescriptor(a.worker); scoped(a.worker.scope, state.job); enumValue(a.status, ATTEMPT_STATES);
    integer(a.claimed_at_ms, state.job.created_at_ms, state.last_now_ms); integer(a.lease_expires_at_ms, a.claimed_at_ms + 1, state.job.deadline_ms); integer(a.last_now_ms, a.claimed_at_ms, state.last_now_ms);
    if (i > 0) assert(state.attempts[i - 1].finished_at_ms <= a.claimed_at_ms, 'attempt_time_regression');
    if (a.started_at_ms !== null) integer(a.started_at_ms, a.claimed_at_ms, a.last_now_ms);
    if (a.finished_at_ms !== null) integer(a.finished_at_ms, a.claimed_at_ms, a.last_now_ms);
    if (a.result_digest !== null) digest(a.result_digest);
    if (['leased', 'running'].includes(a.status)) assert(i === state.attempts.length - 1 && a.finished_at_ms === null && a.result_digest === null && state.status === a.status && a.lease_expires_at_ms > a.last_now_ms, 'active_attempt_invariant');
    else assert(a.finished_at_ms !== null && a.finished_at_ms === a.last_now_ms, 'terminal_attempt_invariant');
    if (a.status === 'leased') assert(a.started_at_ms === null, 'leased_attempt_started');
    if (['running', 'succeeded', 'failed'].includes(a.status)) assert(a.started_at_ms !== null, 'attempt_not_started');
    assert(['succeeded', 'failed'].includes(a.status) === (a.result_digest !== null), 'attempt_result_invariant');
    if (a.result_digest !== null) assert(a.finished_at_ms < a.lease_expires_at_ms && a.finished_at_ms < state.job.deadline_ms, 'late_result_receipt');
    if (a.status === 'failed') classifiedFailure(a.failure); else assert(a.failure === null, 'unexpected_failure');
    assert(a.claimed_at_ms < state.job.deadline_ms && a.lease_expires_at_ms >= Math.min(a.claimed_at_ms + state.job.retry.lease_ms, state.job.deadline_ms), 'invalid_lease_history');
    assert(a.lease_expires_at_ms <= Math.min(a.last_now_ms + state.job.retry.lease_ms, state.job.deadline_ms), 'lease_exceeds_renewal_window');
    if (a.started_at_ms !== null) assert(a.started_at_ms < a.lease_expires_at_ms && a.started_at_ms < state.job.deadline_ms, 'invalid_start_time');
    if (a.status === 'expired') assert(a.finished_at_ms >= a.lease_expires_at_ms, 'lease_not_expired');
    if (['cancelled', 'superseded'].includes(a.status)) assert(a.finished_at_ms < state.job.deadline_ms, 'terminal_after_deadline');
    if (i < state.attempts.length - 1) assert((a.status === 'expired' || a.status === 'failed' && a.failure.retryable) && a.finished_at_ms < state.job.deadline_ms, 'attempt_cannot_retry');
  }
  const receiptIds = new Set(), receiptAttempts = new Set();
  for (const r of state.receipts) {
    fields(r, ['result_id', 'result_digest', 'attempt_id', 'worker_id', 'fencing_token', 'usage']); id(r.result_id); digest(r.result_digest); id(r.attempt_id); id(r.worker_id); integer(r.fencing_token, 1); normalizeUsageObservation(r.usage);
    const a = state.attempts.find(x => x.attempt_id === r.attempt_id); assert(a && a.result_digest === r.result_digest && a.worker.worker_id === r.worker_id && a.fencing_token === r.fencing_token, 'receipt_attempt_mismatch');
    assert(!receiptIds.has(r.result_id) && !receiptAttempts.has(r.attempt_id), 'duplicate_receipt'); receiptIds.add(r.result_id); receiptAttempts.add(r.attempt_id);
  }
  for (const a of state.attempts) assert(a.result_digest === null || state.receipts.some(r => r.attempt_id === a.attempt_id), 'missing_result_receipt');
  const active = state.attempts.at(-1);
  // Reconstruct the Job status implied by the final Attempt. Only a still-queued
  // Job can acquire a later cancellation, supersession or deadline transition.
  // A digest alone cannot make an impossible lifecycle history valid.
  let derived = 'queued';
  if (active) {
    if (active.status === 'expired') derived = active.finished_at_ms >= state.job.deadline_ms ? 'expired' : 'queued';
    else if (active.status === 'failed') derived = active.failure.retryable ? 'queued' : 'failed';
    else derived = active.status;
    if (derived === 'queued' && state.attempts.length === state.job.retry.max_attempts) derived = 'dead-letter';
  }
  const extraTermination = derived === 'queued' && ['cancelled', 'superseded', 'expired'].includes(state.status);
  assert(state.status === derived || extraTermination, 'job_attempt_history_mismatch');
  if (extraTermination) {
    assert(state.last_now_ms >= (active?.finished_at_ms ?? state.job.created_at_ms), 'terminal_time_regression');
    assert(state.status === 'expired' ? state.last_now_ms >= state.job.deadline_ms : state.last_now_ms < state.job.deadline_ms, 'terminal_deadline_mismatch');
  } else assert(state.last_now_ms === (active?.last_now_ms ?? state.job.created_at_ms), 'job_attempt_time_mismatch');
  if (['queued', 'leased', 'running'].includes(state.status)) assert(state.last_now_ms < state.job.deadline_ms, 'active_after_deadline');
  const minimumRevision = state.attempts.reduce((n, a) => n + 1 + Number(a.started_at_ms !== null) + Number(a.finished_at_ms !== null), 0) + Number(extraTermination);
  assert(state.revision >= minimumRevision, 'revision_precedes_history');
  if (!active) assert(state.revision === minimumRevision, 'revision_without_attempt');
  return true;
}
function commandShape(command) {
  const shared = ['type', 'expected_revision'];
  const extra = { claim: ['attempt_id'], start: ['attempt_id', 'fencing_token'], heartbeat: ['attempt_id', 'fencing_token'], complete: ['attempt_id', 'fencing_token', 'result'], expire: [], cancel: [], supersede: [] };
  assert(object(command) && Object.hasOwn(extra, command.type), 'unknown_command'); fields(command, [...shared, ...extra[command.type]]); integer(command.expected_revision);
  if (command.attempt_id !== undefined) id(command.attempt_id);
  if (command.fencing_token !== undefined) integer(command.fencing_token, 1, 32);
}
/**
 * Pure compare-and-set proposal. Commit expected revision, state, receipts, usage
 * and returned effects atomically in a later adapter. Never execute both results
 * from competing calls against the same state snapshot.
 */
export function transitionWorkerJob(state, command, context) {
  validateWorkerJobState(state); json(command); json(context); commandShape(command);
  fields(context, ['actor', 'now_ms'], ['admission']); fields(context.actor, ['role', 'actor_id', 'scope']); enumValue(context.actor.role, ['runtime', 'worker']); id(context.actor.actor_id); scope(context.actor.scope); integer(context.now_ms);
  const reject = reason => output({ status: 'rejected', reason, state, effects: [] });
  const workerCommand = ['start', 'heartbeat', 'complete'].includes(command.type);
  if (!same(context.actor.scope, state.job.scope)) return reject('scope_mismatch');
  if (context.actor.role !== (workerCommand ? 'worker' : 'runtime')) return reject('actor_denied');
  if (context.now_ms < state.last_now_ms) return reject('backward_time');
  // An exact already-recorded completion is an idempotent acknowledgement, not
  // a new lease action. It remains a no-op after expiry, cancellation or retry.
  if (command.type === 'complete') {
    validateWorkerResult(command.result, state.job);
    const old = state.receipts.find(r => r.result_id === command.result.result_id || r.attempt_id === command.attempt_id);
    if (old) {
      if (old.result_digest !== command.result.result_digest || old.attempt_id !== command.attempt_id || old.fencing_token !== command.fencing_token || old.worker_id !== context.actor.actor_id) return reject('completion_conflict');
      return output({ status: 'duplicate', reason: 'already_recorded', state, effects: [] });
    }
  }
  if (command.expected_revision !== state.revision) return reject('state_revision_mismatch');
  if (TERMINAL.includes(state.status)) return reject('terminal_job');
  if (context.now_ms >= state.job.deadline_ms && command.type !== 'expire') return reject('job_deadline_expired');
  const next = clone(state); delete next.state_digest; const active = next.attempts.at(-1); const effects = [];
  const admit = () => {
    if (!context.admission) return { status: 'denied', reason: 'admission_required' };
    return validateWorkerAdmission(state.job, context.admission);
  };
  const finish = reason => {
    next.revision++; next.last_now_ms = context.now_ms;
    const sealed = sealState(next); validateWorkerJobState(sealed);
    return output({ status: 'applied', reason, state: sealed, effects });
  };
  const endAttempt = status => {
    if (active && ['leased', 'running'].includes(active.status)) { active.status = status; active.finished_at_ms = context.now_ms; active.last_now_ms = context.now_ms; }
  };
  if (command.type === 'claim') {
    if (state.status !== 'queued') return reject('not_queued');
    if (next.attempts.some(a => a.attempt_id === command.attempt_id)) return reject('attempt_identity_reused');
    const admission = admit(); if (admission.status !== 'allowed') return reject(admission.reason);
    next.attempts.push({ attempt_id: command.attempt_id, fencing_token: next.attempts.length + 1, worker: context.admission.worker, status: 'leased', claimed_at_ms: context.now_ms, started_at_ms: null, lease_expires_at_ms: Math.min(context.now_ms + state.job.retry.lease_ms, state.job.deadline_ms), last_now_ms: context.now_ms, finished_at_ms: null, result_digest: null, failure: null });
    next.status = 'leased'; effects.push({ type: 'attempt_reserved', attempt_id: command.attempt_id, fencing_token: next.attempts.length }); return finish('claimed');
  }
  if (command.type === 'expire') {
    if (context.now_ms >= state.job.deadline_ms) { endAttempt('expired'); next.status = 'expired'; return finish('job_deadline_expired'); }
    if (!active || !['leased', 'running'].includes(active.status) || context.now_ms < active.lease_expires_at_ms) return reject('lease_not_expired');
    endAttempt('expired'); next.status = next.attempts.length === state.job.retry.max_attempts ? 'dead-letter' : 'queued'; return finish(next.status === 'queued' ? 'attempt_lease_expired' : 'retry_exhausted');
  }
  if (command.type === 'cancel' || command.type === 'supersede') {
    endAttempt(command.type === 'cancel' ? 'cancelled' : 'superseded'); next.status = command.type === 'cancel' ? 'cancelled' : 'superseded'; return finish(next.status);
  }
  if (!active || active.attempt_id !== command.attempt_id || active.fencing_token !== command.fencing_token || active.worker.worker_id !== context.actor.actor_id) return reject('lease_owner_mismatch');
  if (!['leased', 'running'].includes(active.status) || context.now_ms >= active.lease_expires_at_ms) return reject('lease_expired');
  const admission = admit(); if (admission.status !== 'allowed') return reject(admission.reason);
  if (!same(context.admission.worker, active.worker)) return reject('worker_capability_changed');
  if (command.type === 'start') {
    if (state.status !== 'leased') return reject('not_leased'); active.status = 'running'; active.started_at_ms = context.now_ms; active.last_now_ms = context.now_ms; next.status = 'running'; return finish('started');
  }
  if (command.type === 'heartbeat') {
    active.lease_expires_at_ms = Math.min(context.now_ms + state.job.retry.lease_ms, state.job.deadline_ms); active.last_now_ms = context.now_ms; return finish('lease_renewed');
  }
  if (state.status !== 'running') return reject('not_running');
  const result = command.result;
  if (result.attempt_id !== active.attempt_id || result.fencing_token !== active.fencing_token || !same(result.executor, active.worker)) return reject('result_attempt_mismatch');
  if (result.timings.started_at_ms !== active.started_at_ms || result.timings.finished_at_ms > context.now_ms || result.timings.finished_at_ms >= active.lease_expires_at_ms || result.timings.finished_at_ms >= state.job.deadline_ms) return reject('result_timing_mismatch');
  if (result.findings.some(f => !admission.capabilities.allowed_operations.includes(f.operation))) return reject('operation_revoked');
  endAttempt(result.status); active.result_digest = result.result_digest; active.failure = result.failure;
  next.receipts.push({ result_id: result.result_id, result_digest: result.result_digest, attempt_id: active.attempt_id, worker_id: active.worker.worker_id, fencing_token: active.fencing_token, usage: result.usage });
  effects.push({ type: 'record_usage', attempt_id: active.attempt_id, result_id: result.result_id, usage: result.usage });
  if (result.status === 'succeeded') {
    next.status = 'succeeded'; effects.push({ type: 'result_available', result_id: result.result_id, result_digest: result.result_digest, authority: 'proposal_only' });
  } else next.status = result.failure.retryable ? (next.attempts.length === state.job.retry.max_attempts ? 'dead-letter' : 'queued') : 'failed';
  return finish(next.status === 'queued' ? 'retryable_failure' : next.status);
}
