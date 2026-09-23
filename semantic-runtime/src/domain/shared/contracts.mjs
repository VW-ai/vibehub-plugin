import { createHash } from 'node:crypto';

export const FAMILIES = Object.freeze([
  'acceptance_relevance', 'durable_cross_ticket_value',
  'context_relevance', 'independently_schedulable_work',
]);
export const SENSITIVITIES = Object.freeze(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']);

export function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
export function text(value, field, max = 4096) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `Invalid ${field}`);
  return value;
}
export function identifier(value, field) {
  text(value, field, 200);
  requireValue(/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$/.test(value), `Invalid ${field}`);
  return value;
}
export function timestamp(value, field) {
  text(value, field, 50);
  requireValue(/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)), `Invalid ${field}`);
  return new Date(value).toISOString();
}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  requireValue(value !== undefined && (typeof value !== 'number' || Number.isFinite(value)), 'Non-JSON value');
  return JSON.stringify(value);
}
export const fingerprint = value => createHash('sha256').update(canonical(value)).digest('hex');
export const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
export function normalizeScope(scope) {
  return { tenant_id: identifier(scope?.tenant_id, 'tenant_id'), project_id: identifier(scope?.project_id, 'project_id') };
}
export const sameScope = (left, right) => left.tenant_id === right.tenant_id && left.project_id === right.project_id;

// Exclude timeout/policy identity so the same semantic question can be replayed
// under different routing thresholds. Include all content visible to the judge.
export const judgeInputHash = input => fingerprint({ event: input.event, stateRefs: input.stateRefs, question: input.question });

export function validateDecision(result, input) {
  requireValue(typeof result?.value?.relevant === 'boolean', 'Invalid judge relevance');
  requireValue(Number.isFinite(result.confidence) && result.confidence >= 0 && result.confidence <= 1, 'Invalid judge confidence');
  requireValue(Number.isFinite(result.latency_ms) && result.latency_ms >= 0, 'Invalid judge latency');
  const ids = result.value.target_ids;
  requireValue(Array.isArray(ids) && new Set(ids).size === ids.length, 'Invalid judge target_ids');
  const allowed = new Set(input.stateRefs.map(item => item.id));
  requireValue(ids.every(id => allowed.has(id)), 'Judge returned an invisible target');
  const relational = ['acceptance_relevance', 'context_relevance'].includes(input.question.family);
  requireValue(result.value.relevant ? (!relational || ids.length > 0) : ids.length === 0, 'Invalid judge target association');
  requireValue(relational || ids.length === 0, 'Non-relational decision has targets');
  const reason = text(result.reason_code, 'reason_code', 100);
  requireValue(/^[a-z0-9_.-]+$/.test(reason), 'reason_code must be a bounded category');
  return {
    value: { relevant: result.value.relevant, target_ids: [...ids].sort() },
    confidence: result.confidence, latency_ms: result.latency_ms,
    provider: identifier(result.provider, 'judge.provider'), model: identifier(result.model, 'judge.model'),
    reason_code: reason,
  };
}
