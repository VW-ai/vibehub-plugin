import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  INCREMENTAL_GRAPH_CONTRACT_VERSION, INCREMENTAL_GRAPH_LIMITS,
  validateGraphManifest2, validateGraphCommit2, validateGraphCommitAddress2,
  validateGraphMutation2, validateGraphEffectPlan2, validateGraphPageCursor2,
  planGraphGenesis, planGraphMutation, resolveIncrementalGraph, pageIncrementalGraph,
  validateGraphRevisionAddress, graphRevisionAddress,
} from '../../src/index.mjs';
import { graph, assertion, scope, catalog, event, watermarks } from '../fixtures/working-graph/scenario.mjs';
import { IndexedGraphFixture } from '../support/incremental-graph-fixture.mjs';

const digest = `sha256:${'a'.repeat(64)}`;
const address = () => ({ schema_version: 2, kind: 'graph_commit', scope,
  generation_id: 'live-1', commit_digest: digest });
const command = () => ({ schema_version: 2, kind: 'graph_mutation',
  expected_graph: address(), catalog_pin: { revision_id: 'catalog-1', digest },
  operation: { kind: 'assert', assertion: assertion() } });
const validators = [validateGraphManifest2, validateGraphCommit2,
  validateGraphCommitAddress2, validateGraphMutation2, validateGraphEffectPlan2,
  validateGraphPageCursor2];
const operations = [planGraphGenesis, planGraphMutation,
  resolveIncrementalGraph, pageIncrementalGraph];
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
const replace = (value, from, to) => Array.isArray(value)
  ? value.map(v => replace(v, from, to))
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v, from, to)]))
    : value === from ? to : value;

test('public incremental API keeps graph commit addresses distinct from legacy snapshots', () => {
  assert.equal(INCREMENTAL_GRAPH_CONTRACT_VERSION, 2);
  assert.equal(Object.isFrozen(INCREMENTAL_GRAPH_LIMITS), true);
  assert.equal(validateGraphCommitAddress2(address()), true);
  const legacy = graphRevisionAddress(graph());
  assert.equal(validateGraphRevisionAddress(legacy), true);
  assert.throws(() => validateGraphCommitAddress2(legacy));
  assert.throws(() => validateGraphRevisionAddress(address()));
  for (const mutate of [v => { v.schema_version = 1; },
    v => { v.snapshot_digest = v.commit_digest; },
    v => { v.commit_digest = 'latest'; },
    v => { v.scope = { ...scope, extra: true }; }]) {
    const v = address(); mutate(v);
    assert.throws(() => validateGraphCommitAddress2(v));
  }
});

test('all new public validators and operations reject getters without executing them', () => {
  let getterCalls = 0;
  const hostile = {};
  Object.defineProperty(hostile, 'schema_version', {
    enumerable: true, get() { getterCalls++; throw new Error('getter executed'); },
  });
  for (const validate of validators) assert.throws(() => validate(hostile));
  let portCalls = 0;
  const port = Object.fromEntries(['current', 'read', 'page', 'authorizeLifecycle']
    .map(name => [name, () => { portCalls++; throw new Error('port reached'); }]));
  for (const operation of operations) assert.throws(() => operation(port, hostile));
  assert.equal(getterCalls, 0);
  assert.equal(portCalls, 0, 'invalid wire input must be rejected before selected reads');
});

test('nested accessors and JSON hooks cannot execute through mutation validation', () => {
  let invoked = 0;
  for (const decorate of [
    value => Object.defineProperty(value, 'text', { enumerable: true,
      get() { invoked++; return 'secret'; } }),
    value => Object.defineProperty(value, 'toJSON', { enumerable: false,
      value() { invoked++; return {}; } }),
  ]) {
    const request = command();
    request.operation.assertion.content.data = {};
    decorate(request.operation.assertion.content.data);
    assert.throws(() => validateGraphMutation2(request));
  }
  assert.equal(invoked, 0);
});

test('mutation JSON bounds reject cycles, sparse arrays, prototypes, depth and aggregate bytes', () => {
  const unsupported = [undefined, () => {}, 1n, Number.NaN, new Date(), new Map(),
    Object.create({ inherited: true }), [, 'hole']];
  const cycle = {}; cycle.self = cycle; unsupported.push(cycle);
  let deep = {}; for (let i = 0; i < 20; i++) deep = { child: deep };
  unsupported.push(deep);
  // Each leaf is small; this exercises an aggregate row/request limit.
  unsupported.push(Object.fromEntries(Array.from({ length: 150 }, (_, i) =>
    [`field${i}`, 'x'.repeat(8000)])));
  for (const value of unsupported) {
    const request = command(); request.operation.assertion.content.data = value;
    assert.throws(() => validateGraphMutation2(request));
  }
});

test('mutation wire validation checks the full assertion before selected-record admission', () => {
  for (const mutate of [
    a => { a.schema_version = 9; }, a => { a.unknown = true; },
    a => { a.entity_kind = 'arbitrary'; }, a => { a.status = 'canonical'; },
    a => { a.execution_id = ''; }, a => { a.content = { text: 'wrong shape' }; },
    a => { a.events = [{}]; }, a => { a.parents = [address()]; },
    a => { a.canonical_refs = [{ kind: 'canonical_artifact' }]; },
    a => { a.base_revision = address(); },
  ]) {
    const request = command(); mutate(request.operation.assertion);
    assert.throws(() => validateGraphMutation2(request));
  }
});

function setup(a = assertion('security')) {
  const fixture = new IndexedGraphFixture({ catalog: catalog(), scope,
    generation_id: 'live-1', watermarks: watermarks() });
  fixture.commit(planGraphGenesis(fixture.port, { scope, generation_id: 'live-1',
    catalog_pin: fixture.catalogPin, watermarks: watermarks() }).plan);
  const genesis = fixture.head;
  a.events.forEach(e => fixture.retainEvent(e));
  const mutation = { schema_version: 2, kind: 'graph_mutation', expected_graph: fixture.head,
    catalog_pin: fixture.catalogPin, operation: { kind: 'assert', assertion: a } };
  const result = planGraphMutation(fixture.port, mutation);
  fixture.commit(result.plan);
  return { fixture, genesis, result };
}

function wrapRead(fixture, change) {
  return { ...fixture.port, read(query) {
    const fact = structuredClone(fixture.port.read(query));
    return change(fact, query) ?? fact;
  } };
}

function append(fixture, a) {
  a.events.forEach(e => fixture.retainEvent(e));
  const result = planGraphMutation(fixture.port, { schema_version: 2, kind: 'graph_mutation',
    expected_graph: fixture.head, catalog_pin: fixture.catalogPin,
    operation: { kind: 'assert', assertion: a } });
  fixture.commit(result.plan); return result;
}

test('base digest membership cannot be rebound to a different entity address', () => {
  const { fixture, result } = setup();
  append(fixture, assertion('another-entity', { entity_id: 'another-entity' }));
  const before = fixture.head;
  assert.throws(() => planGraphMutation(fixture.port, {
    schema_version: 2, kind: 'graph_mutation', expected_graph: before,
    catalog_pin: fixture.catalogPin, operation: { kind: 'assert',
      assertion: assertion('forged-base', { entity_id: 'another-entity',
        base_revision: { ...result.revision, entity_id: 'another-entity' } }) },
  }));
  assert.deepEqual(fixture.head, before);
});

test('planning cannot disclose private supporting parents or relation endpoints', () => {
  const privateEvent = event('api', 0, raw => {
    raw.acl.allowed_principal_ids = ['alice'];
    raw.provenance.source_objects[0].acl.allowed_principal_ids = ['alice'];
  });
  const { fixture, result } = setup(assertion('private', { events: [privateEvent] }));
  fixture.setPrincipal('bob');
  assert.equal(resolveIncrementalGraph(fixture.port, { at: fixture.head, address: result.revision }).status, 'denied');
  for (const a of [
    assertion('private-parent', { entity_id: 'derived', events: [], parents: [result.revision] }),
    assertion('private-endpoint', { entity_kind: 'relation', entity_id: 'derived-relation', events: [],
      content: { relation_type: 'SUPPORTS', from: result.revision, to: result.revision, data: {} } }),
  ]) {
    assert.throws(() => planGraphMutation(fixture.port, { schema_version: 2, kind: 'graph_mutation',
      expected_graph: fixture.head, catalog_pin: fixture.catalogPin, operation: { kind: 'assert', assertion: a } }));
  }
});

test('historical supporting events keep their original catalog after an execution is retired', () => {
  const { fixture, result } = setup();
  const nextCatalog = catalog();
  nextCatalog.executions = nextCatalog.executions.filter(e => e.execution_id !== 'attempt-a');
  fixture.setCatalog(fixture.retainCatalog(nextCatalog, 'catalog-v2'));
  const historic = resolveIncrementalGraph(fixture.port, { at: fixture.head, address: result.revision });
  assert.equal(historic.status, 'resolved');
  const planned = planGraphMutation(fixture.port, { schema_version: 2, kind: 'graph_mutation',
    expected_graph: fixture.head, catalog_pin: fixture.catalogPin, operation: { kind: 'assert',
      assertion: assertion('new-execution', { entity_id: 'new-derived', execution_id: 'attempt-b',
        events: [], parents: [result.revision] }) } });
  assert.equal(planned.status, 'planned');
  const derived = planned.plan.append.find(r => r.kind === 'revision').value;
  assert.deepEqual(derived.provenance.events, historic.revision.provenance.events);
  assert.equal(derived.assertion.execution_id, 'attempt-b');
});

test('coherent hashes cannot hide omitted parent or endpoint provenance at materialization', () => {
  for (const kind of ['parent', 'endpoint']) {
    const { fixture, result } = setup();
    const a = kind === 'parent'
      ? assertion('closure-child', { entity_id: 'child', events: [], parents: [result.revision] })
      : assertion('closure-relation', { entity_kind: 'relation', entity_id: 'child-relation', events: [],
        content: { relation_type: 'SUPPORTS', from: result.revision, to: result.revision, data: {} } });
    const planned = planGraphMutation(fixture.port, { schema_version: 2, kind: 'graph_mutation',
      expected_graph: fixture.head, catalog_pin: fixture.catalogPin, operation: { kind: 'assert', assertion: a } });
    let forged = structuredClone(planned.plan);
    const revision = forged.append.find(r => r.kind === 'revision').value;
    const oldRevision = revision.revision_digest;
    revision.provenance = { schema_version: 1, events: [], access_events: [], source_pins: [],
      effective_access: { allowed_principal_ids: [], sensitivity: 'normal' } };
    delete revision.revision_digest; revision.revision_digest = hash(revision);
    const forgedRevision = revision.revision_digest;
    forged = replace(forged, oldRevision, forgedRevision);
    forged.commit.records = forged.append.map(r => ({ kind: r.kind, key: r.key, digest: hash(r.value) }));
    const oldCommit = forged.commit.commit_digest;
    delete forged.commit.commit_digest; forged.commit.commit_digest = hash(forged.commit);
    forged = replace(forged, oldCommit, forged.commit.commit_digest);
    delete forged.plan_digest; forged.plan_digest = hash(forged);
    // This simulates a coherent but semantically corrupt trusted repository.
    // Structural validation and matching hashes are not semantic admission.
    assert.equal(validateGraphEffectPlan2(forged), true);
    fixture.commit(forged);
    assert.throws(() => resolveIncrementalGraph(fixture.port, { at: fixture.head,
      address: { ...planned.revision, revision_digest: forgedRevision } }), /incomplete provenance closure/);
  }
});

test('selected fact getters, including then, are rejected without execution', () => {
  const { fixture, result } = setup();
  for (const key of ['then', 'complete', 'value']) {
    let getterCalls = 0;
    const port = { ...fixture.port, read(query) {
      const fact = fixture.port.read(query);
      Object.defineProperty(fact, key, { enumerable: true,
        get() { getterCalls++; throw new Error('fact getter ran'); } });
      return fact;
    } };
    assert.throws(() => resolveIncrementalGraph(port, { at: fixture.head, address: result.revision }));
    assert.equal(getterCalls, 0, key);
  }
});

test('selected facts reject wrong views, keys, scope, digests and missing commitments', () => {
  const { fixture, result } = setup();
  const lookup = { at: fixture.head, address: result.revision };
  const cases = [
    ['entity', fact => { fact.complete = false; }],
    ['entity', fact => { fact.access_view = 'old-access-view'; }],
    ['entity', fact => { fact.current_head.commit_digest = digest; }],
    ['entity', fact => { fact.at.scope.project_id = 'elsewhere'; }],
    ['entity', fact => { fact.kind = 'assertion_id'; }],
    ['entity', fact => { fact.key = ['entity', 'unrelated']; }],
    ['entity', fact => { fact.origin = null; }],
    ['entity', fact => { fact.version = 0; }],
    ['entity', fact => { fact.value.head.revision_digest = digest; }],
    ['revision', fact => { fact.value.assertion.content.data.text = 'tampered'; }],
    ['accepted_event', fact => { fact.value.event_digest = digest; }],
    ['catalog', fact => { fact.value.catalog.executions = []; }],
    ['source_access', fact => { fact.complete = false; }],
  ];
  for (const [kind, mutate] of cases) {
    let exercised = false;
    const port = wrapRead(fixture, (fact, query) => {
      if (query.kind === kind) { exercised = true; mutate(fact); }
    });
    assert.throws(() => resolveIncrementalGraph(port, lookup), kind);
    assert.equal(exercised, true, `attack must reach ${kind} rather than fail incidentally`);
  }
});

test('a missing predecessor cannot certify a current graph or projection origin', () => {
  const { fixture, genesis, result } = setup();
  let exercised = false;
  const port = wrapRead(fixture, (fact, query) => {
    if (query.kind === 'commit' && query.key[0] === genesis.commit_digest) {
      exercised = true;
      return { ...fact, version: null, value: null, origin: null };
    }
  });
  assert.throws(() => resolveIncrementalGraph(port, { at: fixture.head, address: result.revision }));
  assert.equal(exercised, true);
});

test('current principal and access view are rechecked before returning content', () => {
  const { fixture, result } = setup();
  let calls = 0;
  const port = { ...fixture.port, current() {
    const value = fixture.port.current();
    return ++calls === 1 ? value : { ...value, principal_id: 'another-principal' };
  } };
  assert.throws(() => resolveIncrementalGraph(port, { at: fixture.head, address: result.revision }));
  assert.ok(calls >= 2);
});

test('a reused mutable authority object cannot erase the captured caller boundary', () => {
  const privateEvent = event('api', 0, raw => {
    raw.acl.allowed_principal_ids = ['alice'];
    raw.provenance.source_objects[0].acl.allowed_principal_ids = ['alice'];
  });
  const { fixture, result } = setup(assertion('alias-private', { events: [privateEvent] }));
  const shared = fixture.port.current(); let calls = 0;
  const port = { ...fixture.port, current() {
    if (++calls > 1) shared.principal_id = 'bob';
    return shared;
  } };
  assert.throws(() => resolveIncrementalGraph(port, { at: fixture.head, address: result.revision }), /current view changed/);
  assert.ok(calls >= 2);
});

test('graph CAS mismatch preserves the exact proposal and creates no effects', () => {
  const { fixture, genesis } = setup();
  const request = { schema_version: 2, kind: 'graph_mutation', expected_graph: genesis,
    catalog_pin: fixture.catalogPin, operation: { kind: 'assert', assertion: assertion('late') } };
  const before = fixture.head;
  const result = planGraphMutation(fixture.port, request);
  assert.equal(result.status, 'graph_revision_mismatch');
  assert.deepEqual(result.proposal, request);
  assert.deepEqual(result.effects, []);
  assert.deepEqual(fixture.head, before);
  assert.equal(Object.isFrozen(result.proposal.operation.assertion), true);
});

test('lifecycle messages need a separate exact current authority fact for all targets', () => {
  const { fixture } = setup();
  const e = event('api', 1, raw => { raw.source_event_type = 'access.changed'; });
  fixture.retainEvent(e);
  const request = { schema_version: 2, kind: 'graph_mutation', expected_graph: fixture.head,
    catalog_pin: fixture.catalogPin, operation: { kind: 'source_access', event: e, access_state: 'active' } };
  const before = fixture.head;
  for (const mutate of [
    value => { value.allowed = false; },
    value => { value.principal_id = 'someone-else'; },
    value => { value.event_digest = digest; },
    value => { value.targets = []; },
    value => { value.access_view = 'old-access-view'; },
    value => { value.authority_ref = ''; },
  ]) {
    let exercised = false;
    const port = { ...fixture.port, authorizeLifecycle(query) {
      const value = structuredClone(fixture.port.authorizeLifecycle(query));
      exercised = true; mutate(value); return value;
    } };
    assert.throws(() => planGraphMutation(port, request));
    assert.equal(exercised, true);
    assert.deepEqual(fixture.head, before);
  }
});

test('an immutable lifecycle receipt must bind its actual admission predecessor', () => {
  const { fixture, genesis } = setup();
  const e = event('api', 1, raw => { raw.source_event_type = 'access.changed'; });
  fixture.retainEvent(e);
  const original = planGraphMutation(fixture.port, { schema_version: 2, kind: 'graph_mutation',
    expected_graph: fixture.head, catalog_pin: fixture.catalogPin,
    operation: { kind: 'source_access', event: e, access_state: 'active' } });
  let forged = structuredClone(original.plan);
  forged.append.find(r => r.kind === 'access_update').value.predecessor = genesis;
  forged.commit.records = forged.append.map(r => ({ kind: r.kind, key: r.key, digest: hash(r.value) }));
  const oldCommit = forged.commit.commit_digest;
  delete forged.commit.commit_digest; forged.commit.commit_digest = hash(forged.commit);
  forged = replace(forged, oldCommit, forged.commit.commit_digest);
  delete forged.plan_digest; forged.plan_digest = hash(forged);
  assert.throws(() => validateGraphEffectPlan2(forged), /lifecycle predecessor mismatch/);
});

test('fresh public input cannot disclose restricted current lifecycle provenance', () => {
  const { fixture, result } = setup();
  const restricted = event('api', 1, raw => {
    raw.source_event_type = 'access.changed'; raw.acl.allowed_principal_ids = ['alice'];
    raw.provenance.source_objects[0].acl.allowed_principal_ids = ['alice'];
  });
  fixture.retainEvent(restricted);
  const lifecycle = planGraphMutation(fixture.port, { schema_version: 2, kind: 'graph_mutation',
    expected_graph: fixture.head, catalog_pin: fixture.catalogPin,
    operation: { kind: 'source_access', event: restricted, access_state: 'active' } });
  fixture.commit(lifecycle.plan);
  const fresh = event('api', 2); fixture.retainEvent(fresh);
  const request = { schema_version: 2, kind: 'graph_mutation', expected_graph: fixture.head,
    catalog_pin: fixture.catalogPin, operation: { kind: 'assert', assertion: assertion('fresh-access', {
      base_revision: result.revision, events: [fresh], access_revisions: [lifecycle.access_revision],
    }) } };
  fixture.setPrincipal('bob');
  assert.throws(() => planGraphMutation(fixture.port, request));
  // A lifecycle write grant also does not grant access to retained private history.
  const nextAccess = event('api', 3, raw => { raw.source_event_type = 'access.changed'; });
  fixture.retainEvent(nextAccess);
  assert.throws(() => planGraphMutation(fixture.port, { schema_version: 2, kind: 'graph_mutation',
    expected_graph: fixture.head, catalog_pin: fixture.catalogPin,
    operation: { kind: 'source_access', event: nextAccess, access_state: 'active' } }));
  fixture.setPrincipal('alice');
  assert.equal(planGraphMutation(fixture.port, request).status, 'planned');
});

test('rehashing a plan cannot hide inconsistent append, CAS, audit or outbox descriptors', () => {
  const { result } = setup();
  assert.equal(validateGraphEffectPlan2(result.plan), true);
  assert.equal(Object.isFrozen(result.plan.commit), true);
  for (const mutate of [
    plan => { plan.append = []; },
    plan => { plan.cas = []; },
    plan => { plan.append[0].kind = 'sql'; },
    plan => { plan.append.push(structuredClone(plan.append[0])); },
    plan => { plan.cas[0].value = { unrelated: true }; },
    plan => { plan.cas[0].origin.generation_id = 'another-generation'; },
    plan => { plan.audit.command_digest = digest; },
    plan => { plan.audit.previous_graph.commit_digest = digest; },
    plan => { plan.outbox.next_graph.commit_digest = digest; },
    plan => { plan.outbox.changed_entities = []; },
  ]) {
    const altered = structuredClone(result.plan); mutate(altered);
    delete altered.plan_digest; altered.plan_digest = hash(altered);
    assert.throws(() => validateGraphEffectPlan2(altered));
  }
});

test('page cursors bind the exact view and collection but never preserve caller access', () => {
  const { fixture } = setup();
  append(fixture, assertion('page-b', { entity_id: 'page-b' }));
  const at = fixture.head, collection = { kind: 'heads' };
  const first = pageIncrementalGraph(fixture.port, { at, collection, cursor: null, limit: 1 });
  assert.equal(first.items.length, 1); assert.ok(first.next_cursor);
  assert.equal(validateGraphPageCursor2(first.next_cursor), true);
  for (const mutate of [
    c => { c.scope.project_id = 'another-project'; },
    c => { c.generation_id = 'another-generation'; },
    c => { c.commit_digest = digest; },
    c => { c.collection = { kind: 'history', entity_kind: 'entity', entity_id: 'context-a' }; },
    c => { c.position = -1; },
    c => { c.principal_id = 'alice'; },
  ]) {
    const cursor = structuredClone(first.next_cursor); mutate(cursor);
    assert.throws(() => pageIncrementalGraph(fixture.port, { at, collection, cursor, limit: 1 }));
  }
  fixture.setPrincipal('outsider');
  const denied = pageIncrementalGraph(fixture.port, { at, collection, cursor: first.next_cursor, limit: 1 });
  assert.deepEqual(denied.items, []);
  assert.deepEqual(denied.graph_revision, at);
});

test('page response ordering, view, limits and continuations are checked before return', () => {
  const { fixture } = setup();
  append(fixture, assertion('page-second', { entity_id: 'page-second' }));
  const request = { at: fixture.head, collection: { kind: 'heads' }, cursor: null, limit: 1 };
  for (const mutate of [
    p => { p.access_view = 'old-access-view'; },
    p => { p.at.commit_digest = digest; },
    p => { p.rows.push(structuredClone(p.rows[0])); },
    p => { p.rows[0].kind = 'revision'; },
    p => { p.rows[0].position = -1; },
    p => { p.next_position += 1; },
    p => { p.after = 5; },
  ]) {
    let exercised = false;
    const port = { ...fixture.port, page(query) {
      const value = structuredClone(fixture.port.page(query)); exercised = true; mutate(value); return value;
    } };
    assert.throws(() => pageIncrementalGraph(port, request));
    assert.equal(exercised, true);
  }
  for (const limit of [0, -1, 65, 1.5, Number.MAX_SAFE_INTEGER])
    assert.throws(() => pageIncrementalGraph(fixture.port, { ...request, limit }));
});
