import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  normalizeRawEvent, createSourceCursor, acceptSourceEvent, completeSourceEvent,
  projectFreshness, validateGraphGenerationPin, createWorkingGraph,
  graphRevisionAddress, applyGraphAssertion, updateGraphSourceAccess,
  resolveWorkingGraphAddress, validateWorkerGraphInput,
  sourceObjectKey,
} from '../src/index.mjs';

const fixture = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const scope = { tenant_id: 'acme', project_id: 'product' };
function inputs() {
  const catalog = fixture('./fixtures/identity/multi-source.json');
  catalog.sessions.push({ tenant_id: 'acme', session_id: 'web-session', project_id: 'product',
    source_installation_id: 'laptop', worktree_id: 'web-main' });
  catalog.executions.push({ tenant_id: 'acme', execution_id: 'web-attempt', session_id: 'web-session',
    repository_id: 'web', worktree_id: 'web-main' });
  const mapping = fixture('./fixtures/event-provenance/mapping.json');
  mapping.event_types['source.access.changed'] = 'SOURCE_ACCESS_CHANGED';
  const raw = (repository, principals) => {
    const value = fixture('./fixtures/event-provenance/git-observation.json');
    value.event_id = `${repository}-event`; value.idempotency_key = `${repository}-retry`;
    value.partition.partition_id = `${repository}-events`;
    value.identity = { worktree_id: repository === 'api' ? 'feature-a' : 'web-main' };
    value.payload.object.repository_id = repository;
    value.provenance.source_objects[0].object.repository_id = repository;
    value.acl.allowed_principal_ids = principals;
    value.provenance.source_objects[0].acl.allowed_principal_ids = principals;
    return value;
  };
  const apiRaw = raw('api', ['alice', 'bob']);
  const webRaw = raw('web', ['alice']);
  const normalize = value => normalizeRawEvent(value, { catalog, mapping }).event;
  return { catalog, api: normalize(apiRaw), web: normalize(webRaw), webRaw, normalize };
}
function freshness(events) {
  const cursors = events.map(event => {
    const source = { partition: event.partition,
      producer: { producer_id: event.producer.producer_id, epoch: event.producer.epoch } };
    const cursor = acceptSourceEvent(createSourceCursor({ ...source, start_sequence: 0 }), event).state;
    return completeSourceEvent(cursor, { event_id: event.event_id, completed_parents: [] });
  });
  return projectFreshness({ scope, cursors,
    requirements: cursors.map(cursor => ({ source: cursor.source, target_sequence: 0 })) });
}
const assertion = (entity_id, event, execution_id) => ({
  schema_version: 1, assertion_id: `${entity_id}-assertion`, entity_kind: 'entity', entity_id,
  base_revision: null, parents: [], execution_id, status: 'candidate',
  content: { semantic_type: 'constraint', data: { text: `${entity_id} keeps v1` } },
  events: [event], canonical_refs: [],
});

test('public Graph can combine separately authorized observations of one immutable source object', () => {
  const { catalog, api, normalize } = inputs();
  const raw = fixture('./fixtures/event-provenance/git-observation.json');
  raw.event_id = 'remote-api-observation'; raw.idempotency_key = 'remote-api-retry';
  raw.partition.source_installation_id = 'connector'; raw.partition.partition_id = 'remote-api-events';
  raw.producer = { producer_id: 'connector-producer', epoch: 'installation-epoch-1', sequence: 0 };
  raw.identity = { repository_id: 'api' };
  raw.provenance.delivery = { channel: 'push', delivery_id: 'remote-delivery' };
  const remote = normalize(raw);
  assert.equal(sourceObjectKey(api.payload.object), sourceObjectKey(remote.payload.object));
  let state = createWorkingGraph({ catalog, scope, generation_id: 'live', watermarks: freshness([api, remote]) });
  const combined = { ...assertion('combined-observation', api, 'attempt-a'), events: [api, remote] };
  const applied = applyGraphAssertion(state, { expected_graph: graphRevisionAddress(state), assertion: combined });
  assert.equal(applied.status, 'applied'); state = applied.state;
  const read = principal_id => resolveWorkingGraphAddress(state, applied.revision, { principal_id, current_graph: state });
  const allowed = read('alice');
  assert.equal(allowed.status, 'resolved');
  assert.equal(allowed.revision.provenance.events.length, 2);
  assert.deepEqual(allowed.revision.provenance.effective_access.allowed_principal_ids, ['alice']);
  assert.equal(read('bob').status, 'denied');
});

test('public Graph pins cross-repo relations, inherits endpoint access and rechecks old snapshots after revocation', () => {
  const { catalog, api, web, webRaw, normalize } = inputs();
  let state = createWorkingGraph({ catalog, scope, generation_id: 'live', watermarks: freshness([api, web]) });
  const apply = value => {
    const applied = applyGraphAssertion(state, { expected_graph: graphRevisionAddress(state), assertion: value });
    assert.equal(applied.status, 'applied'); state = applied.state; return applied.revision;
  };
  const apiAssertion = assertion('api-contract', api, 'attempt-a');
  const apiRevision = apply(apiAssertion);
  const webRevision = apply(assertion('web-contract', web, 'web-attempt'));
  const relation = apply({ schema_version: 1, assertion_id: 'relation-assertion', entity_kind: 'relation',
    entity_id: 'web-depends-on-api', base_revision: null, parents: [], execution_id: 'web-attempt',
    status: 'candidate', content: { relation_type: 'DEPENDS_ON', from: webRevision, to: apiRevision, data: {} },
    events: [], canonical_refs: [] });
  const historical = state;
  const captured = graphRevisionAddress(state);
  assert.equal(validateGraphGenerationPin({ generation_id: captured.generation_id, snapshot_digest: captured.snapshot_digest }), true);
  const resolve = (graph, address, principal_id, current_graph = graph) =>
    resolveWorkingGraphAddress(graph, address, { principal_id, current_graph });
  const allowed = resolve(state, relation, 'alice');
  assert.equal(allowed.status, 'resolved');
  assert.equal(allowed.revision.provenance.events.length, 2);
  assert.deepEqual(allowed.revision.provenance.effective_access.allowed_principal_ids, ['alice']);
  assert.equal(resolve(state, apiRevision, 'bob').status, 'resolved');
  assert.equal(resolve(state, relation, 'bob').status, 'denied');

  const revisedApi = apply({ ...apiAssertion, assertion_id: 'api-revision-2', base_revision: apiRevision,
    status: 'validated', content: { semantic_type: 'constraint', data: { text: 'API keeps v2' } } });
  assert.notEqual(revisedApi.revision_digest, apiRevision.revision_digest);
  assert.deepEqual(resolve(state, relation, 'alice').revision.assertion.content.to, apiRevision);
  assert.deepEqual(graphRevisionAddress(historical), captured);
  assert.equal(validateWorkerGraphInput(state, { graph_revision: captured, revisions: [apiRevision], principal_id: 'alice' }).status, 'stale');

  const revokeRaw = structuredClone(webRaw);
  revokeRaw.event_id = 'web-access-revoked'; revokeRaw.idempotency_key = 'web-access-revoked-retry';
  revokeRaw.source_event_type = 'source.access.changed'; revokeRaw.producer.sequence = 1;
  revokeRaw.acl = { revision: 'acl-revoked', allowed_principal_ids: [] };
  revokeRaw.provenance.source_objects[0].acl = { revision: 'repo-acl-revoked', allowed_principal_ids: [] };
  const revoked = updateGraphSourceAccess(state, { expected_graph: graphRevisionAddress(state),
    event: normalize(revokeRaw), access_state: 'active' });
  assert.equal(revoked.status, 'applied'); state = revoked.state;
  assert.equal(resolve(historical, relation, 'alice', state).status, 'denied');
  assert.equal(resolve(historical, webRevision, 'alice', state).status, 'denied');
  assert.equal(resolve(state, revisedApi, 'bob').status, 'resolved');
  assert.throws(() => resolve(state, { ...relation, scope: { tenant_id: 'other', project_id: 'product' } }, 'alice'));
});
