import { createHash } from 'node:crypto';

// This module specifies contracts. Adapters own collection, persistence, quota
// reservation and release. None of these functions performs I/O or model calls.
export const OBSERVABILITY_CONTRACT_VERSION = 1;
const freeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const fail = code => { throw new Error(code); };
const ensure = (condition, code = 'invalid_observability_contract') => { if (!condition) fail(code); };
const object = (value, allowed, required = allowed) => {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value));
  ensure(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  ensure(Reflect.ownKeys(value).every(key => typeof key === 'string' && allowed.includes(key)), 'forbidden_telemetry_field');
  ensure(required.every(key => Object.hasOwn(value, key)));
};
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => ensure(Number.isSafeInteger(value) && value >= min && value <= max);
const number = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => ensure(Number.isFinite(value) && value >= min && value <= max);
const enumValue = (value, values) => ensure(values.includes(value), 'unknown_telemetry_category');
const opaqueId = value => {
  ensure(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value), 'invalid_correlation_id');
  ensure(!/^(?:sk-|sk_|ghp_|gho_|github_pat_|AKIA|AIza|xox[baprs]-|eyJ)/i.test(value), 'secret_like_correlation_id');
};
const digest = value => ensure(typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value));
const instant = value => {
  ensure(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value));
  ensure(Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
};
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
    : JSON.stringify(value);
const hash = value => 'sha256:' + createHash('sha256').update(canonical(value)).digest('hex');

export const AUDIT_SUBJECTS = freeze(['event', 'policy_run', 'node_attempt', 'graph_revision', 'job', 'query', 'package']);
export const AUDIT_STATUSES = freeze(['started', 'succeeded', 'ignored', 'deferred', 'rejected', 'failed']);
export const AUDIT_REASON_CODES = freeze([
  'started', 'completed', 'mechanical_ignore', 'candidate_written', 'conflict_unresolved',
  'acl_denied', 'source_revoked', 'invalid_input', 'duplicate', 'stale_revision',
  'judge_unavailable', 'provider_rate_limit', 'deadline_exceeded', 'lease_expired',
  'retry_exhausted', 'queue_full', 'concurrency_limit', 'call_budget_exhausted',
  'token_budget_exhausted', 'usage_unavailable', 'account_exhausted',
  'storage_unavailable', 'delivery_unavailable', 'recovery_completed', 'cancelled', 'cardinality_limit',
]);
export const TELEMETRY_LIMITS = freeze({ audit_bytes: 8192, id_characters: 128, metric_label_count: 3, series_per_metric: 256 });
const CORRELATION_FIELDS = [
  'tenant_id', 'project_id', 'event_id', 'policy_run_id', 'policy_revision',
  'node_id', 'node_attempt_id', 'graph_revision_id', 'job_id', 'job_attempt_id',
  'query_id', 'package_id', 'source_id', 'session_id',
];
// Alias trusted logical identity fields before telemetry; never pass credentials,
// names, URLs or raw source references here. Hashing is not a secrecy guarantee.
export function auditCorrelationId(kind, tenantId, logicalId) {
  ensure(CORRELATION_FIELDS.includes(kind) && kind !== 'policy_revision', 'unknown_correlation_kind');
  for (const value of [tenantId, logicalId]) {
    ensure(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/.test(value), 'invalid_logical_identity');
    ensure(!/^(?:sk-|sk_|ghp_|gho_|github_pat_|AKIA|AIza|xox[baprs]-|eyJ)/i.test(value), 'secret_like_correlation_id');
  }
  ensure(kind !== 'tenant_id' || tenantId === logicalId, 'tenant_correlation_conflict');
  return 'c_' + hash([OBSERVABILITY_CONTRACT_VERSION, kind, tenantId, logicalId]).slice(7);
}
const REQUIRED_CORRELATION = {
  event: ['event_id'],
  policy_run: ['event_id', 'policy_run_id', 'policy_revision'],
  node_attempt: ['event_id', 'policy_run_id', 'policy_revision', 'node_id', 'node_attempt_id'],
  graph_revision: ['graph_revision_id'],
  job: ['job_id'],
  query: ['query_id'],
  package: ['query_id', 'package_id', 'graph_revision_id'],
};
const MEASUREMENTS = [
  'duration_ms', 'queue_age_ms', 'input_tokens', 'output_tokens', 'cached_input_tokens',
  'usage_proxy_units', 'payload_bytes', 'package_tokens', 'stable_prefix_bytes',
  'total_prefix_bytes', 'retry_count',
];

// Never copy raw objects into this envelope. Unknown fields fail closed rather
// than being silently dropped; errors contain only fixed codes, never input.
export function normalizeAuditEnvelope(input) {
  object(input, ['schema_version', 'stream_id', 'sequence', 'previous_digest', 'audit_id', 'recorded_at', 'subject', 'status', 'reason_code', 'correlation', 'measurements']);
  ensure(input.schema_version === OBSERVABILITY_CONTRACT_VERSION, 'unsupported_observability_version');
  opaqueId(input.stream_id); opaqueId(input.audit_id); integer(input.sequence, 1); instant(input.recorded_at);
  if (input.sequence === 1) ensure(input.previous_digest === null, 'invalid_audit_predecessor');
  else digest(input.previous_digest);
  enumValue(input.subject, AUDIT_SUBJECTS); enumValue(input.status, AUDIT_STATUSES); enumValue(input.reason_code, AUDIT_REASON_CODES);
  object(input.correlation, CORRELATION_FIELDS, ['tenant_id', 'project_id', ...REQUIRED_CORRELATION[input.subject]]);
  for (const [key, value] of Object.entries(input.correlation)) key === 'policy_revision' ? digest(value) : opaqueId(value);
  ensure(!input.correlation.policy_run_id || ['policy_revision', 'event_id'].every(key => input.correlation[key]), 'missing_parent_correlation');
  ensure(!input.correlation.job_attempt_id || input.correlation.job_id, 'missing_parent_correlation');
  ensure(!input.correlation.node_attempt_id || ['policy_run_id', 'policy_revision', 'node_id', 'event_id'].every(key => input.correlation[key]), 'missing_parent_correlation');
  object(input.measurements, MEASUREMENTS, []);
  for (const [key, value] of Object.entries(input.measurements)) key.endsWith('_ms') ? number(value) : integer(value);
  if (Object.hasOwn(input.measurements, 'cached_input_tokens')) {
    integer(input.measurements.input_tokens);
    ensure(input.measurements.cached_input_tokens <= input.measurements.input_tokens);
  }
  if (Object.hasOwn(input.measurements, 'stable_prefix_bytes')) {
    integer(input.measurements.total_prefix_bytes);
    ensure(input.measurements.stable_prefix_bytes <= input.measurements.total_prefix_bytes);
  }
  ensure(Buffer.byteLength(canonical(input), 'utf8') <= TELEMETRY_LIMITS.audit_bytes, 'audit_size_exceeded');
  return freeze(structuredClone(input));
}

// Cursor compare-and-swap and the append must be one storage transaction in a
// future adapter. This pure transition cannot attest that a database is durable.
export function appendAuditEnvelope(cursor, input) {
  const envelope = normalizeAuditEnvelope(input);
  if (cursor === null) ensure(envelope.sequence === 1, 'audit_sequence_conflict');
  else {
    object(cursor, ['tenant_id', 'project_id', 'stream_id', 'sequence', 'head_digest']);
    opaqueId(cursor.tenant_id); opaqueId(cursor.project_id); opaqueId(cursor.stream_id);
    integer(cursor.sequence, 1); digest(cursor.head_digest);
    ensure(cursor.tenant_id === envelope.correlation.tenant_id && cursor.project_id === envelope.correlation.project_id && cursor.stream_id === envelope.stream_id, 'audit_scope_conflict');
    ensure(envelope.sequence === cursor.sequence + 1 && envelope.previous_digest === cursor.head_digest, 'audit_sequence_conflict');
  }
  const next = {
    tenant_id: envelope.correlation.tenant_id, project_id: envelope.correlation.project_id,
    stream_id: envelope.stream_id, sequence: envelope.sequence, head_digest: hash(envelope),
  };
  return freeze({ envelope, cursor: next });
}

// IDs belong in access-controlled audit records, never metric labels. This
// fixed vocabulary bounds per-label cardinality; admission bounds combinations.
export function validateMetricLabels(input) {
  object(input, ['subject', 'status', 'reason_code'], []);
  for (const [key, value] of Object.entries(input)) enumValue(value, { subject: AUDIT_SUBJECTS, status: AUDIT_STATUSES, reason_code: AUDIT_REASON_CODES }[key]);
  return freeze({ ...input });
}
export function admitMetricSeries(existing, labels) {
  ensure(Array.isArray(existing) && existing.length <= TELEMETRY_LIMITS.series_per_metric);
  const normalized = existing.map(validateMetricLabels);
  const keys = normalized.map(canonical);
  ensure(new Set(keys).size === keys.length, 'duplicate_metric_series');
  const next = validateMetricLabels(labels);
  if (keys.includes(canonical(next))) return freeze({ admitted: true, series: normalized, reason_code: 'completed' });
  if (existing.length === TELEMETRY_LIMITS.series_per_metric) return freeze({ admitted: false, series: normalized, reason_code: 'cardinality_limit' });
  return freeze({ admitted: true, series: [...normalized, next], reason_code: 'completed' });
}

export const ALPHA_WORKLOAD = freeze({
  schema_version: 1, workload_id: 'alpha-synthetic-v1', evidence_status: 'unproven', seed: 20260921,
  tenants: 2, projects_per_tenant: 2, repositories_per_project: 2, agent_sources_per_project: 1,
  active_clients: 16, max_inflight_requests: 32,
  graph_entities_per_project: 10000, graph_relations_per_project: 50000, query_candidate_limit: 64,
  event_payload_bytes: { typical: 2048, maximum: 16384 }, query_payload_max_bytes: 4096, context_package_max_tokens: 4096,
  steady: { duration_seconds: 1200, events_per_second: 4, queries_per_second: 1 },
  burst: { duration_seconds: 60, events_per_second: 16, queries_per_second: 4 },
  recovery_observation_seconds: 300, distribution: 'round_robin_projects',
  model_event_fraction: 0.25,
  model_event_selection: { basis: 'project_local_event_ordinal', every_n_events: 4, remainder: 3 },
  model_calls_per_selected_event: 2,
  synthetic_model_input_tokens: 1024, synthetic_model_output_tokens: 128,
  worker_jobs_per_project_per_minute: 1, synthetic_worker_duration_seconds: 30, worker_deadline_seconds: 120,
});
// Zero-based global ordinal, continuous across phases. Select every fourth
// project-local event, so round-robin routing cannot concentrate model calls in
// one project. The capacity harness uses this reference selection unchanged.
export function selectAlphaWorkloadEvent(globalEventOrdinal) {
  integer(globalEventOrdinal);
  const projectCount = ALPHA_WORKLOAD.tenants * ALPHA_WORKLOAD.projects_per_tenant;
  const projectIndex = globalEventOrdinal % projectCount;
  const localOrdinal = Math.floor(globalEventOrdinal / projectCount);
  const rule = ALPHA_WORKLOAD.model_event_selection;
  const calls = localOrdinal % rule.every_n_events === rule.remainder ? ALPHA_WORKLOAD.model_calls_per_selected_event : 0;
  return freeze({
    tenant_index: Math.floor(projectIndex / ALPHA_WORKLOAD.projects_per_tenant),
    project_index: projectIndex, project_local_event_ordinal: localOrdinal,
    model_calls: calls,
    model_tokens: calls * (ALPHA_WORKLOAD.synthetic_model_input_tokens + ALPHA_WORKLOAD.synthetic_model_output_tokens),
    usage_proxy_units: calls,
  });
}

export const ALPHA_SLO_TARGETS = freeze({
  schema_version: 1, workload_id: ALPHA_WORKLOAD.workload_id, evidence_status: 'unproven',
  latency_ms: {
    durable_ack: { p95: 200, p99: 500 },
    event_to_candidate: { p95: 1500, p99: 5000 },
    query: { p95: 500, p99: 1500 },
    event_queue_age: { p95: 1000, p99: 3000 },
    worker_completion: { p95: 90000, p99: 180000 },
  },
  successful_request_fraction: 0.99,
  windows: { steady_seconds: 1200, burst_seconds: 60, recovery_seconds: 300, worker_minutes: 20 },
  backlog_recovery_max_ms: 300000,
  crash_acked_event_loss_max: 0, disaster_rpo_seconds: 300, disaster_rto_seconds: 900,
});
export const DEFAULT_RESOURCE_BUDGETS = freeze({
  schema_version: 1,
  event_queue_per_project: 1000, event_queue_global: 5000,
  policy_concurrency_per_project: 4, policy_concurrency_global: 16,
  worker_queue_per_project: 20, worker_queue_global: 80,
  worker_concurrency_per_project: 1, worker_concurrency_global: 4,
  model_calls_per_project_window: 240, model_calls_global_window: 960,
  tokens_per_project_window: 500000, tokens_global_window: 2000000,
  usage_proxy_units_per_project_window: 240, usage_proxy_units_global_window: 960,
  accounting_window_seconds: 60, retries_per_call: 2,
  calls_per_policy_run: 4, tokens_per_policy_run: 8192,
  retry_after_seconds: 5, worker_deadline_seconds: 120,
});
export function normalizeResourceBudgets(overrides = {}) {
  object(overrides, Object.keys(DEFAULT_RESOURCE_BUDGETS), []);
  const result = { ...DEFAULT_RESOURCE_BUDGETS, ...overrides };
  ensure(result.schema_version === 1, 'unsupported_observability_version');
  for (const [key, value] of Object.entries(result)) integer(value, key === 'retries_per_call' ? 0 : 1);
  for (const [project, global] of [
    ['event_queue_per_project', 'event_queue_global'], ['worker_queue_per_project', 'worker_queue_global'],
    ['policy_concurrency_per_project', 'policy_concurrency_global'], ['worker_concurrency_per_project', 'worker_concurrency_global'],
    ['model_calls_per_project_window', 'model_calls_global_window'], ['tokens_per_project_window', 'tokens_global_window'],
    ['usage_proxy_units_per_project_window', 'usage_proxy_units_global_window'],
  ]) ensure(result[project] <= result[global], 'project_budget_exceeds_global');
  return freeze(result);
}

// Account entitlement, measured consumption and money are independent signals.
// Unknown is explicit; a subscription never implies zero cost or infinite quota.
export function normalizeUsageObservation(input) {
  object(input, ['account_usage', 'consumption', 'estimated_cost']);
  object(input.account_usage, ['status', 'remaining_percent', 'observed_at']);
  enumValue(input.account_usage.status, ['available', 'exhausted', 'unknown']);
  if (input.account_usage.status === 'unknown') ensure(input.account_usage.remaining_percent === null && input.account_usage.observed_at === null);
  else {
    instant(input.account_usage.observed_at);
    if (input.account_usage.remaining_percent !== null) number(input.account_usage.remaining_percent, 0, 100);
    if (input.account_usage.status === 'exhausted') ensure(input.account_usage.remaining_percent === null || input.account_usage.remaining_percent === 0);
    else ensure(input.account_usage.remaining_percent === null || input.account_usage.remaining_percent > 0);
  }
  object(input.consumption, ['basis', 'input_tokens', 'output_tokens', 'usage_proxy_units']);
  enumValue(input.consumption.basis, ['provider_tokens', 'usage_proxy', 'unknown']);
  if (input.consumption.basis === 'provider_tokens') {
    integer(input.consumption.input_tokens); integer(input.consumption.output_tokens); ensure(input.consumption.usage_proxy_units === null);
  } else if (input.consumption.basis === 'usage_proxy') {
    ensure(input.consumption.input_tokens === null && input.consumption.output_tokens === null); integer(input.consumption.usage_proxy_units);
  } else ensure(input.consumption.input_tokens === null && input.consumption.output_tokens === null && input.consumption.usage_proxy_units === null);
  object(input.estimated_cost, ['status', 'currency', 'microunits']);
  enumValue(input.estimated_cost.status, ['estimated', 'unknown']);
  if (input.estimated_cost.status === 'unknown') ensure(input.estimated_cost.currency === null && input.estimated_cost.microunits === null);
  else { ensure(input.estimated_cost.currency === 'USD'); integer(input.estimated_cost.microunits); }
  return freeze(structuredClone(input));
}

// Counts include outstanding reservations. Callers must atomically reserve both
// project and global limits; this decision alone does not enforce concurrency.
export function decideResourceAdmission(input, overrides = {}) {
  const budgets = normalizeResourceBudgets(overrides);
  object(input, ['operation', 'project_used', 'global_used', 'requested', 'run_calls', 'run_tokens', 'retry_count', 'account_status'], ['operation', 'project_used', 'global_used', 'requested']);
  enumValue(input.operation, ['enqueue_event', 'start_policy', 'enqueue_worker', 'start_worker', 'model_call', 'model_tokens', 'model_usage_proxy']);
  integer(input.project_used); integer(input.global_used); integer(input.requested, 1);
  ensure(input.project_used <= input.global_used, 'inconsistent_budget_counters');
  const definitions = {
    enqueue_event: ['event_queue_per_project', 'event_queue_global', 'queue_full', 'reject_before_ack'],
    start_policy: ['policy_concurrency_per_project', 'policy_concurrency_global', 'concurrency_limit', 'defer'],
    enqueue_worker: ['worker_queue_per_project', 'worker_queue_global', 'queue_full', 'keep_unresolved'],
    start_worker: ['worker_concurrency_per_project', 'worker_concurrency_global', 'concurrency_limit', 'defer'],
    model_call: ['model_calls_per_project_window', 'model_calls_global_window', 'call_budget_exhausted', 'defer'],
    model_tokens: ['tokens_per_project_window', 'tokens_global_window', 'token_budget_exhausted', 'defer'],
    model_usage_proxy: ['usage_proxy_units_per_project_window', 'usage_proxy_units_global_window', 'call_budget_exhausted', 'defer'],
  };
  const [projectKey, globalKey, budgetReason, saturation] = definitions[input.operation];
  const model = input.operation.startsWith('model_');
  if (model) {
    integer(input.run_calls); integer(input.run_tokens); integer(input.retry_count);
    enumValue(input.account_status, ['available', 'exhausted', 'unknown']);
  } else ensure(['run_calls', 'run_tokens', 'retry_count', 'account_status'].every(key => !Object.hasOwn(input, key)));
  let reason = 'completed';
  if (model && input.account_status === 'exhausted') reason = 'account_exhausted';
  else if (model && input.retry_count > budgets.retries_per_call) reason = 'retry_exhausted';
  else if (model && (input.run_calls > budgets.calls_per_policy_run || (input.operation === 'model_call' && input.run_calls + input.requested > budgets.calls_per_policy_run))) reason = 'call_budget_exhausted';
  else if (model && (input.run_tokens > budgets.tokens_per_policy_run || (input.operation === 'model_tokens' && input.run_tokens + input.requested > budgets.tokens_per_policy_run))) reason = 'token_budget_exhausted';
  else if (input.project_used + input.requested > budgets[projectKey] || input.global_used + input.requested > budgets[globalKey]) reason = budgetReason;
  const allowed = reason === 'completed';
  return freeze({
    allowed, action: allowed ? 'admit' : saturation, reason_code: reason,
    retry_after_seconds: allowed ? 0 : budgets.retry_after_seconds,
    diagnostic: { project_limit: budgets[projectKey], global_limit: budgets[globalKey], project_used: input.project_used, global_used: input.global_used, requested: input.requested,
      account_usage: model ? input.account_status : 'not_applicable', estimated_cost: 'not_evaluated' },
  });
}
