import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { compilePolicyArtifact, validatePolicyArtifact, createPolicyRegistry, loadPhaseZeroPolicyArtifact, POLICY_ARTIFACT_SCHEMA, POLICY_NODE_TYPES } from '../src/domain/decisions/policy-artifacts.mjs';
import { fingerprint, judgeInputHash } from '../src/core/contracts.mjs';
import { evaluateEvent } from '../src/core/policy.mjs';
import { event, target, decision } from './helpers.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/policy-artifacts/ingress.json', import.meta.url), 'utf8'));
const source = () => structuredClone(fixture.definition);
const operations = () => structuredClone(fixture.operations);
const compile = (definition = source(), registry = operations()) => compilePolicyArtifact(definition, { operations: registry });
const ref = artifact => ({ policy_id: artifact.policy_id, version: artifact.version, content_hash: artifact.content_hash });
const audit = { at: '2026-09-21T12:00:00Z', actor_ref: 'test-publisher', reason: 'synthetic contract test' };
const registry = (extra = {}) => createPolicyRegistry({ operations: operations(), ...extra });

test('schema compiles all seven kinds, typed opaque references and safe terminal actions', () => {
  const artifact = compile();
  assert.deepEqual([...new Set(Object.values(artifact.definition.nodes).map(node => node.type))].sort(), [...POLICY_NODE_TYPES].sort());
  assert.equal(POLICY_ARTIFACT_SCHEMA.properties.schema_version.const, 2);
  assert.equal(artifact.bounds.max_nodes, 9);
  assert.equal(artifact.bounds.max_attempts, 9);
  assert.equal(artifact.bounds.timeout_ms, 450);
  assert.equal(artifact.topological_order[0], 'scope');
  assert.ok(Object.isFrozen(artifact.definition.nodes.scope.budget));
  assert.deepEqual(validatePolicyArtifact(source(), { operations: operations() }), artifact.definition);
  for (const action of ['IGNORE', 'INGEST', 'INJECT', 'DEFER', 'ESCALATE']) {
    const input = source(); input.nodes.ingest.action = action; assert.equal(compile(input).definition.nodes.ingest.action, action);
  }
  const longer = source();
  longer.nodes.extra1 = structuredClone(longer.nodes.submit);
  longer.nodes.extra2 = structuredClone(longer.nodes.submit);
  longer.nodes.submit.next.submitted.target = 'extra1';
  longer.nodes.extra1.next.submitted.target = 'extra2';
  assert.equal(compile(longer).bounds.max_attempts, 11);
});

test('semantic identity ignores key/declaration ordering and presentation but binds execution and operation semantics', () => {
  function reverseKeys(value) {
    if (Array.isArray(value)) return value.map(reverseKeys);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)]));
  }
  const original = compile(); const reordered = reverseKeys(source());
  reordered.presentation = { label: 'New display name' }; reordered.nodes.scope.presentation = { description: 'Display only' };
  const op = reverseKeys(operations()).reverse(); op.forEach(value => value.branches.reverse());
  const compiled = compile(reordered, op);
  assert.equal(compiled.executable_hash, original.executable_hash);
  assert.equal(compiled.content_hash, original.content_hash);
  assert.deepEqual(compiled.topological_order, original.topological_order);
  const changed = source(); changed.nodes.durability.config.question = 'Does this alter behavior?';
  assert.notEqual(compile(changed).executable_hash, original.executable_hash);
  const changedOperations = operations(); changedOperations[0].implementation_hash = `sha256:${'a'.repeat(64)}`;
  assert.notEqual(compile(source(), changedOperations).executable_hash, original.executable_hash);
  const versioned = source(); versioned.version = '2';
  assert.equal(compile(versioned).executable_hash, original.executable_hash);
  assert.notEqual(compile(versioned).content_hash, original.content_hash);
});

test('compiler rejects missing, unreachable, cyclic, unbounded and incomplete graph declarations', () => {
  const cases = [
    [d => { d.entry = 'missing'; }, /missing entry/],
    [d => { d.nodes.scope.next.inside.target = 'missing'; }, /missing edge target/],
    [d => { d.nodes.unused = structuredClone(d.nodes.ingest); }, /unreachable/],
    [d => { d.nodes.submit.next.submitted.target = 'related'; d.nodes.submit.next.submitted.ports = {event:'event',snapshot:'snapshot'}; }, /cycle/],
    [d => { delete d.nodes.durability.next.low; }, /incomplete branches/],
    [d => { delete d.nodes.scope.on_error; }, /incomplete action\/error/],
    [d => { d.nodes.scope.on_error.target = 'ingest'; }, /error edge must terminate/],
    [d => { d.nodes.ingest.action = 'CANONICALIZE'; }, /unsupported value/],
    [d => { d.nodes.scope.operation.id = 'unknown'; }, /unknown operation/],
    [d => { d.nodes.scope.budget.timeout_ms = 0; }, /below minimum/],
    [d => { d.nodes.scope.budget.max_attempts = 11; }, /above maximum/],
    [d => { d.nodes.scope.budget.max_tokens = Infinity; }, /non-finite/],
    [d => { d.limits.timeout_ms = 449; }, /aggregate timeout_ms/],
    [d => { d.limits.max_attempts = 8; }, /aggregate max_attempts/],
    [d => { d.limits.max_nodes = 8; }, /node count/],
    [d => { d.compatibility.min_runtime_version = 2; }, /compatibility range/],
    [d => { delete d.nodes.related.join; }, /require named join/],
  ];
  for (const [mutate, error] of cases) { const input = source(); mutate(input); assert.throws(() => compile(input), error); }
});

test('ports and operation configuration fail closed before publication', () => {
  const cases = [
    [d => { d.nodes.scope.outputs.event = 'snapshot_ref'; }, /signature mismatch/],
    [d => { d.nodes.scope.next.inside.ports.event = 'snapshot'; }, /incompatible ports/],
    [d => { delete d.nodes.scope.next.inside.ports.event; }, /incomplete input ports/],
    [d => { d.nodes.scope.next.inside.ports.missing = 'event'; }, /missing typed port/],
    [d => { d.nodes.durability.config.question = 3; }, /must be string/],
    [d => { d.nodes.durability.config.provider = 'hardcoded-provider'; }, /unknown/],
    [d => { d.toString = 'unexpected'; }, /unknown/],
    [d => { d.nodes.scope.config.toString = 'unexpected'; }, /unknown/],
    [d => { d.nodes.scope.config.valueOf = true; }, /unknown/],
    [d => { d.unknown = true; }, /unknown/],
    [d => { d.inputs = { event: 'event_ref' }; }, /entry input/],
  ];
  for (const [mutate, error] of cases) { const input = source(); mutate(input); assert.throws(() => compile(input), error); }
  const invalid = operations(); invalid[1].config_schema.properties.question.minimum = 0;
  assert.throws(() => compile(source(), invalid), /numeric bounds require/);
  const unsupported = operations(); unsupported[1].config_schema.properties.question.pattern = '.*';
  assert.throws(() => compile(source(), unsupported), /unknown/);
  const duplicate = operations(); duplicate.push(duplicate[0]);
  assert.throws(() => compile(source(), duplicate), /duplicate operation/);
  const getter = source(); Object.defineProperty(getter, 'trap', { enumerable: true, get() { throw new Error('must not execute'); } });
  assert.throws(() => compile(getter), /accessors/);
});

function parallelFixture() {
  const configuration = { type: 'object', additionalProperties: false, properties: {}, required: [] };
  const base = { event: 'event_ref', snapshot: 'snapshot_ref' };
  const budget = { timeout_ms: 10, max_attempts: 1, max_tokens: 10, max_cost_microunits: 10 };
  const descriptor = (id, type, inputs, outputs, branches, branch_mode = 'exclusive') => ({ id, version: '1', type, inputs, outputs, error_outputs: {}, branches, branch_mode, implementation_hash: `sha256:${fingerprint(id)}`, config_schema: configuration });
  const ops = [
    descriptor('fork', 'deterministic', base, base, ['left', 'right'], 'parallel'),
    descriptor('judge', 'judge', base, { signal: 'signal_ref' }, ['ready']),
    descriptor('aggregate', 'aggregate', { left: 'signal_ref', right: 'signal_ref' }, { signal: 'signal_ref' }, ['combined']),
    descriptor('done', 'action', { signal: 'signal_ref' }, {}, [], 'terminal'),
    descriptor('defer', 'action', {}, {}, [], 'terminal'),
  ];
  const edge = (target, ports = {}) => ({ target, ports });
  const node = (id, next, extra = {}) => { const operation = ops.find(op => op.id === id); return { type: operation.type, operation: { id, version: '1' }, inputs: operation.inputs, outputs: operation.outputs, budget, config: {}, next, ...(operation.type === 'action' ? {} : { on_error: edge('defer') }), ...extra }; };
  return { operations: ops, definition: { ...source(), policy_id: 'parallel-signals', entry: 'fork', nodes: {
    fork: node('fork', { left: edge('left', { event: 'event', snapshot: 'snapshot' }), right: edge('right', { event: 'event', snapshot: 'snapshot' }) }),
    left: node('judge', { ready: edge('joined', { left: 'signal' }) }),
    right: node('judge', { ready: edge('joined', { right: 'signal' }) }),
    joined: node('aggregate', { combined: edge('done', { signal: 'signal' }) }, { join: { name: 'independent-signals', mode: 'all', fork: 'fork' } }),
    done: node('done', {}, { action: 'INGEST' }),
    defer: node('defer', {}, { action: 'DEFER', join: { name: 'errors', mode: 'any' } }),
  } } };
}

test('structured all joins collect typed independent branches; ambiguous or stranded joins fail', () => {
  const fixture = parallelFixture();
  const artifact = compile(fixture.definition, fixture.operations);
  assert.equal(artifact.definition.nodes.joined.join.mode, 'all');
  for (const [mutate, pattern] of [
    [d => { d.nodes.joined.join.fork = 'left'; }, /requires parallel fork/],
    [d => { d.nodes.right.next.ready.ports = { left: 'signal' }; }, /ambiguous.*writers/],
    [d => { d.nodes.right.next.ready = { target: 'done', ports: {signal:'signal'} }; d.nodes.done.join = {name:'premature',mode:'any'}; }, /join requires|terminate before all join/],
    [d => { d.nodes.fork.next.right.target = 'left'; d.nodes.left.join = {name:'overlap',mode:'any'}; delete d.nodes.right; }, /overlap before join|join requires/],
    [d => { d.nodes.joined.join.mode = 'any'; delete d.nodes.joined.join.fork; }, /incomplete input ports/],
  ]) { const input = structuredClone(fixture.definition); mutate(input); assert.throws(() => compile(input, fixture.operations), pattern); }
});

test('publication is immutable and idempotent, including after activation and consumer mutation attempts', () => {
  const store = registry(); const input = source(); const published = store.publish(input); const exact = ref(published.artifact);
  input.nodes.scope.budget.timeout_ms = 999;
  assert.equal(store.resolve(exact).artifact.definition.nodes.scope.budget.timeout_ms, 50);
  assert.throws(() => { published.artifact.definition.nodes.scope.budget.timeout_ms = 999; }, TypeError);
  const activated = store.activate(exact, { expected_active: null, ...audit });
  assert.equal(activated.activation.at, '2026-09-21T12:00:00.000Z');
  assert.deepEqual(store.publish(source()), activated);
  assert.throws(() => { store.active(exact.policy_id).artifact.operations[0].inputs.event = 'string'; }, TypeError);
  const changed = source(); changed.nodes.durability.config.question = 'Changed question';
  assert.throws(() => store.publish(changed), /immutable/);
  assert.equal(store.resolve(exact).artifact.executable_hash, compile().executable_hash);
});

test('activation/rollback and retirement require exact refs, compatibility and compare-and-swap', () => {
  const store = registry(); const first = ref(store.publish(source()).artifact);
  store.activate(first, { expected_active: null, ...audit });
  const next = source(); next.version = '2'; next.rollback_predecessor = first;
  const second = ref(store.publish(next).artifact);
  assert.throws(() => store.activate(second, { expected_active: null, ...audit }), /compare-and-swap/);
  store.activate(second, { expected_active: first, ...audit });
  const prior = store.resolve(second).artifact.rollback_predecessor;
  store.activate(prior, { expected_active: second, ...audit, reason: 'Rollback after failed drill' });
  assert.equal(store.active(first.policy_id).artifact.version, '1');
  assert.throws(() => store.retire(first, { expected_active: second, ...audit }), /compare-and-swap/);
  store.retire(first, { expected_active: first, ...audit });
  assert.equal(store.active(first.policy_id), null);
  assert.throws(() => store.activate(first, { expected_active: null, ...audit }), /retired/);
  assert.equal(store.history(first.policy_id).length, 4);
  assert.ok(Object.isFrozen(store.history(first.policy_id)[0]));
  assert.throws(() => store.resolve({ ...second, content_hash: `sha256:${'f'.repeat(64)}` }), /not found/);
  assert.throws(() => store.activate(second, audit), /expected_active/);
  const incompatible = registry({ runtime_version: 2 }); const published = incompatible.publish(source());
  assert.throws(() => incompatible.activate(ref(published.artifact), { expected_active: null, ...audit }), /incompatible runtime/);
  const missing = source(); missing.rollback_predecessor = {...first, version:'missing'};
  assert.throws(() => registry().publish(missing), /not found/);
});

test('Phase 0 loading preserves exact policy hash, four recorded judge inputs, results and candidate IDs', async () => {
  const policy = JSON.parse(readFileSync(new URL('../policies/phase0.json', import.meta.url), 'utf8'));
  const loaded = loadPhaseZeroPolicyArtifact(policy);
  assert.deepEqual(loaded.policy, policy); assert.equal(loaded.policy_hash, fingerprint(policy));
  const ledgers = [];
  const execute = async value => { const calls = []; const judge = { evaluate(input) { calls.push(structuredClone(input)); return decision(); } }; const result = await evaluateEvent({ event: event(), state: [target()], policy: value, judge }); ledgers.push(calls); return result; };
  const before = await execute(policy); const after = await execute(loaded.policy);
  assert.equal(ledgers[0].length, 4); assert.deepEqual(ledgers[0], ledgers[1]);
  assert.deepEqual(ledgers[0].map(judgeInputHash), ledgers[1].map(judgeInputHash));
  const omitTiming = result => ({ ...result, decisions: result.decisions.map(({elapsed_ms, ...decision}) => decision) });
  assert.deepEqual(omitTiming(before), omitTiming(after));
  assert.throws(() => { loaded.policy.nodes.acceptance.question = 'mutated'; }, TypeError);
  assert.throws(() => loadPhaseZeroPolicyArtifact(source()), /Unsupported policy schema_version/);
});
