import {
  SENSITIVITIES, canonical, compareText, identifier, normalizeScope,
  requireValue, sameScope, text, timestamp,
} from '../../../src/domain/shared/contracts.mjs';

export const EVENT_TYPES = Object.freeze([
  'USER_INTENT', 'AGENT_MESSAGE', 'TOOL_CALL', 'TOOL_RESULT', 'FILE_READ',
  'FILE_WRITE', 'GIT_DIFF', 'GIT_COMMIT', 'TICKET_STATE', 'EVIDENCE_CREATED',
  'OUTCOME_CREATED', 'HUMAN_DECISION', 'SYSTEM_CHECKPOINT',
]);

// Only the explicit replay envelope is accepted. Unknown host fields (including
// labels/outcomes) are never passed to the judge.
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
