import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  normalizeAuditEnvelope, appendAuditEnvelope, auditCorrelationId, validateMetricLabels, admitMetricSeries,
  normalizeResourceBudgets, decideResourceAdmission, normalizeUsageObservation,
  AUDIT_SUBJECTS, AUDIT_STATUSES, AUDIT_REASON_CODES, TELEMETRY_LIMITS,
  ALPHA_WORKLOAD, ALPHA_SLO_TARGETS, DEFAULT_RESOURCE_BUDGETS, selectAlphaWorkloadEvent,
} from '../src/domain/decisions/observability-contract.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/observability/audit.json', import.meta.url)));
const rejected = JSON.parse(readFileSync(new URL('./fixtures/observability/rejected-fields.json', import.meta.url)));
const audit = () => structuredClone(fixture);
const admission = (operation, extra = {}) => ({ operation, project_used: 0, global_used: 0, requested: 1, ...extra });
const model = (operation = 'model_call', extra = {}) => admission(operation, { run_calls: 0, run_tokens: 0, retry_count: 0, account_status: 'available', ...extra });

test('audit v1 accepts explicit correlation and numeric measurements without retaining mutable caller objects', () => {
  const input = audit();
  const result = normalizeAuditEnvelope(input);
  input.correlation.event_id = 'changed';
  assert.equal(result.correlation.event_id, 'event_000001');
  assert.ok(Object.isFrozen(result.correlation));
  assert.throws(() => { result.measurements.duration_ms = 7; }, TypeError);
});

test('every lifecycle subject has its required correlation and rejects absent bindings', () => {
  const fields = {
    event: { event_id: 'event_a' },
    policy_run: { event_id: 'event_a', policy_run_id: 'run_a', policy_revision: fixture.correlation.policy_revision },
    node_attempt: { event_id: 'event_a', policy_run_id: 'run_a', policy_revision: fixture.correlation.policy_revision, node_id: 'classify', node_attempt_id: 'attempt_a' },
    graph_revision: { graph_revision_id: 'graph_a' },
    job: { job_id: 'job_a', job_attempt_id: 'job_attempt_a' },
    query: { query_id: 'query_a' },
    package: { query_id: 'query_a', package_id: 'package_a', graph_revision_id: 'graph_a' },
  };
  for (const subject of AUDIT_SUBJECTS) {
    const input = { ...audit(), subject, correlation: { tenant_id: 'tenant_a', project_id: 'project_a', ...fields[subject] } };
    assert.equal(normalizeAuditEnvelope(input).subject, subject);
    delete input.correlation[Object.keys(fields[subject])[0]];
    assert.throws(() => normalizeAuditEnvelope(input));
  }
});

test('redaction contract rejects secrets, raw payload and unbounded prose with fixed diagnostic codes', () => {
  for (const item of rejected) {
    const input = audit();
    (item.target === 'root' ? input : input[item.target])[item.field] = item.value;
    assert.throws(() => normalizeAuditEnvelope(input), { message: 'forbidden_telemetry_field' });
  }
  for (const id of ['sk-synthetic', 'github_pat_synthetic', 'Bearer secret', '/Users/person/private', 'https://example.invalid', 'a'.repeat(129)]) {
    const input = audit(); input.correlation.event_id = id;
    assert.throws(() => normalizeAuditEnvelope(input), error => !error.message.includes(id));
  }
  const input = audit(); input.reason_code = 'provider error including secret';
  assert.throws(() => normalizeAuditEnvelope(input), { message: 'unknown_telemetry_category' });
});

test('audit rejects unsupported versions, impossible dates, malformed numbers and broken parent references', () => {
  for (const change of [
    item => { item.schema_version = 2; },
    item => { item.recorded_at = '2026-02-30T12:00:00.000Z'; },
    item => { item.measurements.duration_ms = NaN; },
    item => { item.measurements.input_tokens = -1; },
    item => { item.measurements.cached_input_tokens = 2048; },
    item => { item.measurements.stable_prefix_bytes = 9999; },
    item => { item.correlation.job_attempt_id = 'attempt_orphan'; },
    item => { item.subject = 'graph_revision'; item.correlation.graph_revision_id = 'graph_a'; delete item.correlation.policy_revision; },
    item => { item.correlation.policy_revision = 'latest'; },
  ]) { const input = audit(); change(input); assert.throws(() => normalizeAuditEnvelope(input)); }
});

test('append transition pins scope, sequence and hash without editing historical envelopes', () => {
  const first = appendAuditEnvelope(null, audit());
  const original = JSON.stringify(first);
  const nextInput = { ...audit(), sequence: 2, audit_id: 'audit_000002', previous_digest: first.cursor.head_digest, status: 'deferred', reason_code: 'judge_unavailable' };
  const second = appendAuditEnvelope(first.cursor, nextInput);
  assert.equal(second.cursor.sequence, 2);
  assert.notEqual(second.cursor.head_digest, first.cursor.head_digest);
  assert.equal(JSON.stringify(first), original);
  assert.throws(() => appendAuditEnvelope(second.cursor, nextInput), /audit_sequence_conflict/);
  assert.throws(() => appendAuditEnvelope(first.cursor, { ...nextInput, previous_digest: 'sha256:' + '0'.repeat(64) }), /audit_sequence_conflict/);
  assert.throws(() => appendAuditEnvelope(first.cursor, { ...nextInput, correlation: { ...nextInput.correlation, project_id: 'project_other' } }), /audit_scope_conflict/);
  assert.throws(() => appendAuditEnvelope(null, nextInput), /audit_sequence_conflict/);
  const reordered = Object.fromEntries(Object.entries(audit()).reverse());
  assert.equal(appendAuditEnvelope(null, reordered).cursor.head_digest, first.cursor.head_digest);
});

test('metrics refuse identifiers and enforce series cardinality while allowing existing series', () => {
  assert.throws(() => validateMetricLabels({ project_id: 'project_a' }), /forbidden_telemetry_field/);
  assert.throws(() => validateMetricLabels({ reason_code: 'arbitrary_provider_text' }), /unknown_telemetry_category/);
  let series = [];
  outer: for (const subject of AUDIT_SUBJECTS) for (const status of AUDIT_STATUSES) for (const reason_code of AUDIT_REASON_CODES) {
    const result = admitMetricSeries(series, { subject, status, reason_code });
    if (!result.admitted) { assert.equal(result.reason_code, 'cardinality_limit'); break outer; }
    series = result.series;
  }
  assert.equal(series.length, TELEMETRY_LIMITS.series_per_metric);
  assert.equal(admitMetricSeries(series, series[0]).admitted, true);
  assert.equal(admitMetricSeries(series, {}).admitted, false);
  assert.throws(() => admitMetricSeries([series[0], series[0]], series[1]), /duplicate_metric_series/);
});

test('engineering workload is explicit, internally bounded and remains unproven', () => {
  assert.equal(ALPHA_WORKLOAD.evidence_status, 'unproven');
  assert.equal(ALPHA_SLO_TARGETS.evidence_status, 'unproven');
  assert.equal(ALPHA_WORKLOAD.workload_id, ALPHA_SLO_TARGETS.workload_id);
  assert.ok(Object.isFrozen(ALPHA_SLO_TARGETS.latency_ms));
  assert.equal(ALPHA_WORKLOAD.tenants * ALPHA_WORKLOAD.projects_per_tenant, 4);
  assert.ok(ALPHA_WORKLOAD.event_payload_bytes.maximum >= ALPHA_WORKLOAD.event_payload_bytes.typical);
  const burstCalls = ALPHA_WORKLOAD.burst.events_per_second * ALPHA_WORKLOAD.model_event_fraction * ALPHA_WORKLOAD.model_calls_per_selected_event * DEFAULT_RESOURCE_BUDGETS.accounting_window_seconds;
  assert.ok(burstCalls <= DEFAULT_RESOURCE_BUDGETS.model_calls_global_window);
  assert.ok(burstCalls * (ALPHA_WORKLOAD.synthetic_model_input_tokens + ALPHA_WORKLOAD.synthetic_model_output_tokens) <= DEFAULT_RESOURCE_BUDGETS.tokens_global_window);
  assert.ok(ALPHA_WORKLOAD.worker_deadline_seconds * 1000 <= ALPHA_SLO_TARGETS.latency_ms.worker_completion.p99);
  assert.equal(ALPHA_SLO_TARGETS.crash_acked_event_loss_max, 0);
  assert.ok(ALPHA_SLO_TARGETS.disaster_rto_seconds > ALPHA_SLO_TARGETS.backlog_recovery_max_ms / 1000);
});

test('resource configuration is immutable, rejects typos and preserves project/global bounds', () => {
  const budget = normalizeResourceBudgets({ event_queue_per_project: 10, event_queue_global: 20, retries_per_call: 0 });
  assert.equal(budget.event_queue_per_project, 10);
  assert.ok(Object.isFrozen(budget));
  for (const bad of [{ event_queue: 1 }, { schema_version: 2 }, { worker_concurrency_per_project: 5 }, { retries_per_call: -1 }, { accounting_window_seconds: Infinity }]) {
    assert.throws(() => normalizeResourceBudgets(bad));
  }
});

test('queue and concurrency decisions handle exact reservation boundaries and safe saturation actions', () => {
  const config = { event_queue_per_project: 2, event_queue_global: 3 };
  assert.equal(decideResourceAdmission(admission('enqueue_event', { project_used: 1, global_used: 2 }), config).allowed, true);
  const fullProject = decideResourceAdmission(admission('enqueue_event', { project_used: 2, global_used: 2 }), config);
  assert.equal(fullProject.action, 'reject_before_ack');
  assert.equal(fullProject.reason_code, 'queue_full');
  assert.equal(decideResourceAdmission(admission('enqueue_event', { global_used: 3 }), config).allowed, false);
  assert.equal(decideResourceAdmission(admission('start_policy', { project_used: 4, global_used: 4 })).action, 'defer');
  assert.equal(decideResourceAdmission(admission('enqueue_worker', { project_used: 20, global_used: 20 })).action, 'keep_unresolved');
  assert.equal(decideResourceAdmission(admission('start_worker', { global_used: 4 })).action, 'defer');
  assert.throws(() => decideResourceAdmission(admission('enqueue_event', { requested: 0 })));
  assert.throws(() => decideResourceAdmission(admission('enqueue_event', { project_used: 2, global_used: 1 })), /inconsistent_budget_counters/);
});

test('model budgets count retries, run calls, tokens, proxies and unknown account usage separately', () => {
  assert.equal(decideResourceAdmission(model('model_call', { retry_count: 2 })).allowed, true);
  assert.equal(decideResourceAdmission(model('model_call', { retry_count: 3 })).reason_code, 'retry_exhausted');
  assert.equal(decideResourceAdmission(model('model_call', { run_calls: 4 })).reason_code, 'call_budget_exhausted');
  assert.equal(decideResourceAdmission(model('model_tokens', { run_tokens: 8192 })).reason_code, 'token_budget_exhausted');
  assert.equal(decideResourceAdmission(model('model_usage_proxy', { project_used: 240, global_used: 240 })).allowed, false);
  const unknown = decideResourceAdmission(model('model_call', { account_status: 'unknown' }));
  assert.equal(unknown.allowed, true);
  assert.equal(unknown.diagnostic.account_usage, 'unknown');
  assert.equal(unknown.diagnostic.estimated_cost, 'not_evaluated');
  assert.equal(decideResourceAdmission(model('model_call', { account_status: 'exhausted' })).reason_code, 'account_exhausted');
  assert.equal(decideResourceAdmission(model('model_call', { global_used: 960 })).allowed, false);
  assert.throws(() => decideResourceAdmission(admission('model_call')));
});

test('account usage absence and cost absence are explicit rather than zero or unlimited', () => {
  const unknown = {
    account_usage: { status: 'unknown', remaining_percent: null, observed_at: null },
    consumption: { basis: 'unknown', input_tokens: null, output_tokens: null, usage_proxy_units: null },
    estimated_cost: { status: 'unknown', currency: null, microunits: null },
  };
  assert.deepEqual(normalizeUsageObservation(unknown), unknown);
  const proxy = structuredClone(unknown);
  proxy.consumption = { basis: 'usage_proxy', input_tokens: null, output_tokens: null, usage_proxy_units: 1 };
  assert.equal(normalizeUsageObservation(proxy).estimated_cost.status, 'unknown');
  const invalid = structuredClone(unknown); invalid.estimated_cost.microunits = 0;
  assert.throws(() => normalizeUsageObservation(invalid));
  invalid.estimated_cost = { status: 'estimated', currency: 'USD', microunits: 120 };
  assert.equal(normalizeUsageObservation(invalid).account_usage.status, 'unknown');
  const tokens = structuredClone(unknown);
  tokens.consumption = { basis: 'provider_tokens', input_tokens: 1024, output_tokens: 128, usage_proxy_units: null };
  tokens.account_usage = { status: 'available', remaining_percent: 20, observed_at: '2026-09-21T12:00:00.000Z' };
  assert.equal(normalizeUsageObservation(tokens).consumption.input_tokens, 1024);
});

test('typed aliases bridge full logical identities into bounded telemetry without cross-tenant/type collision', () => {
  const logicalId = 'project:org/service.feature-' + 'a'.repeat(172);
  assert.equal(logicalId.length, 200);
  const alias = auditCorrelationId('project_id', 'tenant:one', logicalId);
  assert.match(alias, /^c_[a-f0-9]{64}$/);
  assert.equal(alias, auditCorrelationId('project_id', 'tenant:one', logicalId));
  assert.notEqual(alias, auditCorrelationId('project_id', 'tenant:two', logicalId));
  assert.notEqual(alias, auditCorrelationId('event_id', 'tenant:one', logicalId));
  const input = audit();
  input.correlation.project_id = alias;
  input.correlation.tenant_id = auditCorrelationId('tenant_id', 'tenant:one', 'tenant:one');
  assert.equal(normalizeAuditEnvelope(input).correlation.project_id, alias);
  assert.throws(() => auditCorrelationId('tenant_id', 'tenant:one', 'tenant:two'));
  assert.throws(() => auditCorrelationId('source_url', 'tenant:one', 'anything'));
  assert.throws(() => auditCorrelationId('event_id', 'tenant:one', 'sk-synthetic'));
});

test('project-local model selection keeps the complete steady and burst trace within every project budget', () => {
  const projectCount = ALPHA_WORKLOAD.tenants * ALPHA_WORKLOAD.projects_per_tenant;
  const perCallTokens = ALPHA_WORKLOAD.synthetic_model_input_tokens + ALPHA_WORKLOAD.synthetic_model_output_tokens;
  let ordinal = 0;
  assert.deepEqual(ALPHA_WORKLOAD.model_event_selection, { basis: 'project_local_event_ordinal', every_n_events: 4, remainder: 3 });
  assert.deepEqual(Array.from({ length: 16 }, (_, index) => selectAlphaWorkloadEvent(index).model_calls),
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 2]);
  for (const phase of ['steady', 'burst']) {
    const workload = ALPHA_WORKLOAD[phase];
    const windows = new Map();
    const projectEventCounts = Array(projectCount).fill(0);
    for (let second = 0; second < workload.duration_seconds; second++) {
      const window = Math.floor(second / DEFAULT_RESOURCE_BUDGETS.accounting_window_seconds);
      if (!windows.has(window)) windows.set(window, Array.from({ length: projectCount }, () => ({ calls: 0, tokens: 0, proxy: 0 })));
      for (let event = 0; event < workload.events_per_second; event++, ordinal++) {
        const selection = selectAlphaWorkloadEvent(ordinal);
        assert.equal(selection.project_index, ordinal % projectCount);
        assert.equal(selection.project_local_event_ordinal, Math.floor(ordinal / projectCount));
        assert.equal(selection.tenant_index, Math.floor(selection.project_index / ALPHA_WORKLOAD.projects_per_tenant));
        projectEventCounts[selection.project_index]++;
        const counts = windows.get(window)[selection.project_index];
        counts.calls += selection.model_calls;
        counts.tokens += selection.model_tokens;
        counts.proxy += selection.usage_proxy_units;
      }
    }
    assert.equal(new Set(projectEventCounts).size, 1, phase + ' distributes events equally');
    for (const projects of windows.values()) {
      const expectedCalls = phase === 'steady' ? 30 : 120;
      assert.deepEqual(projects.map(counts => counts.calls), Array(projectCount).fill(expectedCalls));
      for (const counts of projects) {
        assert.equal(counts.tokens, counts.calls * perCallTokens);
        assert.equal(counts.proxy, counts.calls);
        assert.ok(counts.calls <= DEFAULT_RESOURCE_BUDGETS.model_calls_per_project_window);
        assert.ok(counts.tokens <= DEFAULT_RESOURCE_BUDGETS.tokens_per_project_window);
        assert.ok(counts.proxy <= DEFAULT_RESOURCE_BUDGETS.usage_proxy_units_per_project_window);
      }
      assert.ok(projects.reduce((sum, counts) => sum + counts.calls, 0) <= DEFAULT_RESOURCE_BUDGETS.model_calls_global_window);
      assert.ok(projects.reduce((sum, counts) => sum + counts.tokens, 0) <= DEFAULT_RESOURCE_BUDGETS.tokens_global_window);
      assert.ok(projects.reduce((sum, counts) => sum + counts.proxy, 0) <= DEFAULT_RESOURCE_BUDGETS.usage_proxy_units_global_window);
    }
  }
  assert.throws(() => selectAlphaWorkloadEvent(-1));
  assert.throws(() => selectAlphaWorkloadEvent(0.5));
  assert.throws(() => selectAlphaWorkloadEvent(NaN));
});
