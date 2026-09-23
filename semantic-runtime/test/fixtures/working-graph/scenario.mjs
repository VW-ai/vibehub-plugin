import { readFileSync } from 'node:fs';
import { normalizeRawEvent } from '../../../src/domain/sources/event-provenance.mjs';
import { createSourceCursor, acceptSourceEvent, completeSourceEvent, projectFreshness } from '../../../src/domain/sources/causal-ordering.mjs';
import { createWorkingGraph, applyGraphAssertion, graphRevisionAddress } from '../../../src/domain/graph/working-graph.mjs';
const fixture = name => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
export const scope = { tenant_id: 'acme', project_id: 'product' };
export function catalog() {
  const c = fixture('identity/multi-source.json');
  c.sessions.push({ tenant_id: 'acme', session_id: 'session-b', project_id: 'product', source_installation_id: 'laptop', worktree_id: 'web-main' });
  c.executions.push({ tenant_id: 'acme', execution_id: 'attempt-b', session_id: 'session-b', repository_id: 'web', worktree_id: 'web-main' });
  return c;
}
export function event(repo = 'api', sequence = 0, alter = () => {}) {
  const raw = fixture('event-provenance/git-observation.json');
  raw.event_id = `${repo}-event-${sequence}`; raw.idempotency_key = `${repo}-retry-${sequence}`; raw.source_native_event_id = `${repo}-native-${sequence}`;
  raw.partition.partition_id = `git-${repo}-events`; raw.producer.sequence = sequence;
  raw.identity = { execution_id: repo === 'api' ? 'attempt-a' : 'attempt-b' };
  raw.payload.object.repository_id = repo; raw.provenance.source_objects[0].object.repository_id = repo;
  raw.acl.allowed_principal_ids = ['alice', 'bob']; raw.provenance.source_objects[0].acl.allowed_principal_ids = ['alice', 'bob'];
  if (repo === 'web') raw.provenance.source_objects[0].sensitivity = 'restricted';
  alter(raw);
  const mapping = fixture('event-provenance/mapping.json');
  mapping.event_types['access.changed'] = 'SOURCE_ACCESS_CHANGED'; mapping.event_types['source.deleted'] = 'SOURCE_TOMBSTONE';
  const normalized = normalizeRawEvent(raw, { catalog: catalog(), mapping });
  if (normalized.status !== 'normalized') throw new Error(normalized.reason);
  return normalized.event;
}
export function watermarks(events = [event(), event('web')]) {
  const requirements = [], cursors = [];
  for (const e of events) {
    const source = { partition: e.partition, producer: { producer_id: e.producer.producer_id, epoch: e.producer.epoch } };
    requirements.push({ source, target_sequence: e.producer.sequence });
    let cursor = acceptSourceEvent(createSourceCursor({ ...source, start_sequence: 0 }), e).state;
    cursor = completeSourceEvent(cursor, { event_id: e.event_id, completed_parents: [] }); cursors.push(cursor);
  }
  return projectFreshness({ scope, requirements, cursors });
}
export function graph() { return createWorkingGraph({ catalog: catalog(), scope, generation_id: 'live-1', watermarks: watermarks() }); }
export function assertion(name = 'a', overrides = {}) {
  return { schema_version: 1, assertion_id: `assert-${name}`, entity_kind: 'entity', entity_id: 'context-a', base_revision: null, parents: [], execution_id: 'attempt-a',
    status: 'candidate', content: { semantic_type: 'constraint', data: { text: 'API remains v1' } }, events: [event()], canonical_refs: [], ...overrides };
}
export function apply(state, a) { return applyGraphAssertion(state, { expected_graph: graphRevisionAddress(state), assertion: a }); }
