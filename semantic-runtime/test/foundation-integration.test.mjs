import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  resolveIdentity, createPolicyRegistry, auditCorrelationId,
  appendAuditEnvelope, decideResourceAdmission, validateMetricLabels,
} from '../src/index.mjs';

const fixture = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

test('public foundation contracts connect resolved scope, exact policy and safe audit references', () => {
  const catalog = JSON.parse(JSON.stringify(fixture('./fixtures/identity/multi-source.json'))
    .replaceAll('"product"', '"product:api.v1"'));
  const resolved = resolveIdentity(catalog, { tenant_id: 'acme', worktree_id: 'feature-a' });
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.identity.project_id, 'product:api.v1');

  const { definition, operations } = fixture('./fixtures/policy-artifacts/ingress.json');
  const registry = createPolicyRegistry({ operations });
  const { artifact } = registry.publish(definition);
  const input = fixture('./fixtures/observability/audit.json');
  const tenant = resolved.identity.tenant_id;
  input.correlation = {
    tenant_id: auditCorrelationId('tenant_id', tenant, tenant),
    project_id: auditCorrelationId('project_id', tenant, resolved.identity.project_id),
    source_id: auditCorrelationId('source_id', tenant, resolved.identity.source_installation_id),
    session_id: auditCorrelationId('session_id', tenant, 'session:1'),
    event_id: auditCorrelationId('event_id', tenant, 'event:1'),
    policy_run_id: auditCorrelationId('policy_run_id', tenant, 'run:1'),
    policy_revision: artifact.content_hash,
    node_id: auditCorrelationId('node_id', tenant, artifact.definition.entry),
    node_attempt_id: auditCorrelationId('node_attempt_id', tenant, 'attempt:1'),
  };
  const first = appendAuditEnvelope(null, input);
  assert.equal(first.envelope.correlation.policy_revision, artifact.content_hash);
  assert.ok(!JSON.stringify(first).includes('product:api.v1'));
  assert.ok(!JSON.stringify(first).includes('/synthetic/'));

  const next = { ...input, sequence: 2, previous_digest: first.cursor.head_digest, audit_id: 'audit_000002' };
  assert.equal(appendAuditEnvelope(first.cursor, next).cursor.sequence, 2);
  assert.throws(() => appendAuditEnvelope(first.cursor, {
    ...next, correlation: { ...next.correlation, project_id: auditCorrelationId('project_id', tenant, 'shared') },
  }), /audit_scope_conflict/);
  assert.throws(() => validateMetricLabels({ project_id: input.correlation.project_id }), /forbidden_telemetry_field/);
});

test('resource saturation produces a bounded reason that the audit contract accepts', () => {
  const decision = decideResourceAdmission({
    operation: 'start_policy', project_used: 4, global_used: 4, requested: 1,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.action, 'defer');
  const input = fixture('./fixtures/observability/audit.json');
  input.status = 'deferred';
  input.reason_code = decision.reason_code;
  const record = appendAuditEnvelope(null, input);
  assert.equal(record.envelope.reason_code, 'concurrency_limit');
});
