import { createHash } from 'node:crypto';

export const FAMILIES = Object.freeze([
  'acceptance_relevance', 'durable_cross_ticket_value',
  'context_relevance', 'independently_schedulable_work',
]);
export const EVENT_TYPES = Object.freeze([
  'USER_INTENT', 'AGENT_MESSAGE', 'TOOL_CALL', 'TOOL_RESULT', 'FILE_READ',
  'FILE_WRITE', 'GIT_DIFF', 'GIT_COMMIT', 'TICKET_STATE', 'EVIDENCE_CREATED',
  'OUTCOME_CREATED', 'HUMAN_DECISION', 'SYSTEM_CHECKPOINT',
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

// Only the explicit replay envelope is accepted. Unknown host fields (including
// labels/outcomes) are never passed to the judge. Native host adapters come later.
export function normalizeEvent(input) {
  requireValue(input?.schema_version === 1, 'Unsupported event schema_version');
  requireValue(EVENT_TYPES.includes(input.type), 'Unsupported event type');
  requireValue(SENSITIVITIES.includes(input.acl?.sensitivity), 'Invalid event sensitivity');
  requireValue(input.acl?.visibility === 'project', 'Phase 0 requires project visibility');
  requireValue(['normal', 'high'].includes(input.impact ?? 'normal'), 'Invalid event impact');
  const source = {
    provider: identifier(input.source?.provider, 'source.provider'),
    ref: text(input.source?.ref, 'source.ref'),
  };
  for (const key of ['session_id', 'worktree_id']) {
    if (input.source[key] !== undefined) source[key] = identifier(input.source[key], `source.${key}`);
  }
  requireValue(typeof input.payload?.text === 'string' && input.payload.text.length <= 1_000_000, 'Invalid payload.text');
  const provenance = {};
  for (const key of ['repo', 'commit', 'path']) {
    if (input.provenance?.[key] !== undefined && input.provenance[key] !== null) {
      provenance[key] = text(input.provenance[key], `provenance.${key}`);
    }
  }
  return {
    schema_version: 1, ...normalizeScope(input),
    event_id: identifier(input.event_id, 'event_id'), type: input.type,
    timestamp: timestamp(input.timestamp, 'timestamp'), source,
    payload_ref: text(input.payload_ref, 'payload_ref'),
    payload: { text: input.payload.text }, provenance,
    acl: { visibility: 'project', sensitivity: input.acl.sensitivity },
    impact: input.impact ?? 'normal',
  };
}

export function normalizeState(input) {
  requireValue(Array.isArray(input), 'State must be an array');
  const seen = new Set();
  return input.map(item => {
    requireValue(['acceptance', 'context'].includes(item.type), 'Unsupported state type');
    requireValue(item.acl?.visibility === 'project' && SENSITIVITIES.includes(item.acl?.sensitivity), 'Invalid state ACL');
    const record = {
      ...normalizeScope(item), id: identifier(item.id, 'state.id'), type: item.type,
      available_at: timestamp(item.available_at, 'state.available_at'),
      text: text(item.text, 'state.text', 100_000), source_ref: text(item.source_ref, 'state.source_ref'),
      acl: { visibility: 'project', sensitivity: item.acl.sensitivity },
    };
    const key = canonical([record.tenant_id, record.project_id, record.id]);
    requireValue(!seen.has(key), 'Duplicate state identity; supply a point-in-time snapshot');
    seen.add(key);
    return record;
  }).sort((a, b) => compareText(canonical(a), canonical(b)));
}

export function visibleState(event, family, state) {
  const type = { acceptance_relevance: 'acceptance', context_relevance: 'context' }[family];
  return state.filter(item => type === item.type && sameScope(event, item) && item.available_at <= event.timestamp);
}

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
