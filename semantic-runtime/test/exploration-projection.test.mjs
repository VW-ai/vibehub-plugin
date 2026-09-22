import test from 'node:test';
import assert from 'node:assert/strict';
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, bind, bindRequest, mutation, resolve, executionFor, git, rows, rejected, assertion, SCOPE } from './helpers/exploration-fixture.mjs';
import { semanticAddress } from '../src/core/working-graph.mjs';

test('same-theme alternatives in real external worktrees have separate owned generations and exact origins', t => {
  const f = fixture(t), outside = join(f.root, 'outside-selected-folder');
  git(f.folder, 'worktree', 'add', '-b', 'alternative-b', outside); f.refresh();
  const executionB = executionFor(f, outside), a = bind(f), b = bind(f, { key: 'bind-b', execution: executionB });
  assert.notEqual(a.exploration_id, b.exploration_id); assert.notEqual(a.generation_id, b.generation_id);
  const requestA = mutation(f, a, 'choice-a'), requestB = mutation(f, b, 'choice-b');
  const resultA = f.explorations.mutate(f.context, requestA), resultB = f.explorations.mutate(f.context, requestB);
  assert.equal(resultA.status, 'applied'); assert.equal(resultB.status, 'applied');
  assert.equal(resolve(f, a, resultA).local.revision.assertion.content.data.text, 'Synthetic choice-a');
  assert.equal(resolve(f, b, resultB).local.revision.assertion.content.data.text, 'Synthetic choice-b');
  assert.notDeepEqual(resultA.operation_origin_ref, resultB.operation_origin_ref);
  for (const [binding, result, execution] of [[a, resultA, f.execution], [b, resultB, executionB]]) {
    const retained = f.store.getSource(f.context, 'exploration-projection', result.operation_origin_ref);
    assert.equal(retained.kind, 'exploration-operation-origin');
    assert.deepEqual(retained.value.execution, execution); assert.equal(retained.value.execution_workspace_id, binding.execution_workspace_id);
    assert.equal(retained.value.exploration_id, binding.exploration_id); assert.equal(retained.value.generation_id, binding.generation_id);
    assert.equal(retained.value.actor, 'owner'); assert.equal(retained.value.publisher_ref, f.publisher.publisher_ref);
  }
  rejected(() => f.explorations.resolve(f.context, { exploration_id: a.exploration_id, at: resultB.receipt.next_graph, address: resultB.revision, shared_keys: null }));
  const listing = f.explorations.list(f.context, { cursor: null, limit: 32 });
  assert.deepEqual(new Set(listing.items.map(item => item.exploration_id)), new Set([a.exploration_id, b.exploration_id]));
  assert(!JSON.stringify(listing).includes('Synthetic choice-'), 'overview contains metadata, never candidate content');
  const before = rows(f), stale = f.explorations.mutate(f.context, { ...requestA, idempotency_key: 'stale-graph', operation: mutation(f, a, 'stale').operation });
  assert.equal(stale.status, 'graph_revision_mismatch'); assert.deepEqual(rows(f), before);
  assert.deepEqual(stale.proposal, { ...requestA, idempotency_key: 'stale-graph', operation: mutation(f, a, 'stale').operation });
  assert.deepEqual(stale.effects, []);
});

test('same ref can explicitly select several explorations without moving any origin or automatically adopting', t => {
  const f = fixture(t), a = bind(f), firstRequest = mutation(f, a, 'same-ref-a');
  const first = f.explorations.mutate(f.context, firstRequest), originA = f.explorations.list(f.context, { cursor: null, limit: 32 }).items[0].origin;
  const b = bind(f, { key: 'another-on-same-ref' });
  assert.notEqual(b.exploration_id, a.exploration_id); assert(b.binding_version > a.binding_version);
  assert.equal(f.explorations.getBinding(f.context, { execution: f.execution }).binding.exploration_id, b.exploration_id);
  const before = rows(f); rejected(() => f.explorations.mutate(f.context, mutation(f, a, 'stale-binding'))); assert.deepEqual(rows(f), before);
  const back = bind(f, { key: 'select-first-again', exploration_id: a.exploration_id });
  assert.equal(back.generation_id, a.generation_id); assert.deepEqual(back.graph_revision, first.receipt.next_graph);
  assert.notEqual(back.execution_workspace_id, a.execution_workspace_id);
  assert.deepEqual(f.explorations.list(f.context, { cursor: null, limit: 32 }).items.find(item => item.exploration_id === a.exploration_id).origin, originA);
  assert.equal(resolve(f, a, first).local.status, 'resolved');
  const empty = f.explorations.page(f.context, { exploration_id: b.exploration_id, at: b.graph_revision, collection: { kind: 'heads' }, cursor: null, limit: 32, shared_keys: null });
  assert.equal(empty.local.items.length, 0);
});

test('branch switching requires explicit binding while unchanged registry rescans preserve usability', t => {
  const f = fixture(t), a = bind(f), pending = mutation(f, a, 'prior-branch');
  f.refresh(); assert.equal(f.explorations.getBinding(f.context, { execution: f.execution }).status, 'bound');
  const committedRequest = { ...pending, expected_catalog_version: f.registry.get(f.context).version };
  const unchanged = f.explorations.mutate(f.context, committedRequest);
  assert.equal(unchanged.status, 'applied');
  git(f.folder, 'switch', '-c', 'alternate');
  const before = rows(f); rejected(() => f.explorations.mutate(f.context, mutation(f, a, 'unsurveyed-switch', { expected_graph: unchanged.receipt.next_graph })));
  assert.deepEqual(rows(f), before);
  f.refresh(); assert.equal(f.explorations.getBinding(f.context, { execution: f.execution }).status, 'rebind_required');
  const b = bind(f, { key: 'bind-alternate' });
  const duplicate = f.explorations.mutate(f.context, committedRequest);
  assert.equal(duplicate.status, 'duplicate'); assert.deepEqual(duplicate.receipt, unchanged.receipt);
  assert.notEqual(a.exploration_id, b.exploration_id);
  assert.equal(resolve(f, a, unchanged).local.revision.assertion.content.data.text, 'Synthetic prior-branch');
});

test('observed worktree/ref deletion and recreation preserve history but allocate fresh execution identity', t => {
  const f = fixture(t), linked = join(f.root, 'ephemeral');
  git(f.folder, 'worktree', 'add', '-b', 'ephemeral', linked); f.refresh();
  const oldExecution = executionFor(f, linked), a = bind(f, { execution: oldExecution }), published = f.explorations.mutate(f.context, mutation(f, a, 'before-delete'));
  git(f.folder, 'worktree', 'remove', linked); git(f.folder, 'branch', '-D', 'ephemeral'); f.refresh();
  assert(['unavailable', 'rebind_required'].includes(f.explorations.getBinding(f.context, { execution: oldExecution }).status));
  git(f.folder, 'worktree', 'add', '-b', 'ephemeral', linked); f.refresh();
  const freshExecution = executionFor(f, linked); assert.notEqual(freshExecution.worktree_id, oldExecution.worktree_id);
  assert.equal(f.explorations.getBinding(f.context, { execution: freshExecution }).status, 'unmapped');
  const b = bind(f, { key: 'recreated-worktree', execution: freshExecution });
  assert.notEqual(b.exploration_id, a.exploration_id);
  assert.equal(resolve(f, a, published).local.status, 'resolved');
  assert.equal(f.explorations.list(f.context, { cursor: null, limit: 32 }).items.length, 2);
});

test('independent clones with the same branch name never inherit another repository exploration', t => {
  const f = fixture(t), a = bind(f), clone = join(f.root, 'independent-clone');
  git(f.root, 'clone', '--local', '--no-hardlinks', f.folder, clone);
  f.registry.enroll(f.context, { folder: clone, expectedVersion: f.registry.get(f.context).version });
  const execution = executionFor(f, clone); assert.notEqual(execution.repository_id, f.execution.repository_id);
  assert.equal(f.explorations.getBinding(f.context, { execution }).status, 'unmapped');
  const before = rows(f); rejected(() => bind(f, { key: 'cross-repository', execution, exploration_id: a.exploration_id })); assert.deepEqual(rows(f), before);
  const b = bind(f, { key: 'clone-exploration', execution }); assert.notEqual(b.exploration_id, a.exploration_id);
});

test('explicit detached selection and unborn-to-first-commit retain their actual origin bases', t => {
  const f = fixture(t, { unborn: true }), a = bind(f);
  const origin = f.explorations.list(f.context, { cursor: null, limit: 32 }).items[0].origin;
  assert.deepEqual(origin.git_base, { state: 'unborn', commit: null });
  git(f.folder, 'add', '.'); git(f.folder, 'commit', '-m', 'first synthetic commit'); f.refresh();
  assert.equal(f.explorations.getBinding(f.context, { execution: f.execution }).status, 'rebind_required');
  const resumed = bind(f, { key: 'explicit-after-first-commit', exploration_id: a.exploration_id });
  assert.equal(resumed.exploration_id, a.exploration_id);
  git(f.folder, 'checkout', '--detach'); f.refresh();
  assert.equal(f.explorations.getBinding(f.context, { execution: f.execution }).status, 'rebind_required');
  const detached = bind(f, { key: 'explicit-detached-selection', exploration_id: a.exploration_id });
  assert.equal(detached.exploration_id, a.exploration_id);
  assert.deepEqual(f.explorations.list(f.context, { cursor: null, limit: 32 }).items[0].origin, origin);
});

test('committed bind and mutation retry survive restart, disabled Project and removed Git without changing origin', t => {
  const f = fixture(t), request = bindRequest(f), a = f.explorations.bind(f.context, request);
  const command = mutation(f, a, 'retained-exact'), applied = f.explorations.mutate(f.context, command);
  const active = f.activation.get(f.context); f.activation.setEnabled(f.context, { enabled: false, expectedVersion: active.version });
  renameSync(f.folder, `${f.folder}-unavailable`);
  const before = rows(f); f.store.close(); const reopened = f.reopen();
  const boundRetry = reopened.explorations.bind(reopened.context, request), retry = reopened.explorations.mutate(reopened.context, command);
  assert.equal(boundRetry.status, 'duplicate'); assert.equal(boundRetry.exploration_id, a.exploration_id);
  assert.equal(retry.status, 'duplicate'); assert.deepEqual(retry.receipt, applied.receipt); assert.deepEqual(retry.operation_origin_ref, applied.operation_origin_ref);
  assert.deepEqual(reopened.explorations.getReceipt(reopened.context, { idempotency_key: command.idempotency_key }), applied.receipt);
  assert.equal(resolve(reopened, a, applied).local.status, 'resolved');
  rejected(() => reopened.explorations.mutate(reopened.context, { ...command, coverage: [] }));
  rejected(() => reopened.explorations.mutate(reopened.context, { ...command, idempotency_key: request.idempotency_key }));
  assert.deepEqual(rows(reopened), before);
});

test('catalog and binding CAS reject stale commands with no new Graph, origin, receipt or outbox', t => {
  const f = fixture(t), a = bind(f), oldRequest = mutation(f, a, 'stale-catalog');
  git(f.folder, 'branch', 'new-observed-ref'); f.refresh();
  let before = rows(f); rejected(() => f.explorations.mutate(f.context, oldRequest)); assert.deepEqual(rows(f), before);
  const request = bindRequest(f, { key: 'stale-bind' }); bind(f, { key: 'superseding-bind' }); before = rows(f);
  rejected(() => f.explorations.bind(f.context, request)); assert.deepEqual(rows(f), before);
});

test('owned generation keeps semantic alternatives until complete explicit resolution and rejects other-generation parents', t => {
  const f = fixture(t), a = bind(f), first = f.explorations.mutate(f.context, mutation(f, a, 'first-hypothesis'));
  const second = f.explorations.mutate(f.context, mutation(f, a, 'second-hypothesis', { expected_graph: first.receipt.next_graph }));
  assert(second.conflict);
  const address = semanticAddress({ scope: SCOPE, generation_id: a.generation_id, entity_kind: 'entity', entity_id: 'context-a' });
  const contested = f.explorations.resolve(f.context, { exploration_id: a.exploration_id, at: second.receipt.next_graph, address, shared_keys: null });
  assert.equal(contested.local.entity.status, 'contested'); assert.equal(contested.local.entity.competing.length, 2);
  const resolution = assertion(f, f.event, 'full-resolution', { base_revision: first.revision, parents: contested.local.entity.competing, status: 'resolved' });
  const operation = { kind: 'resolve', conflict_digest: second.conflict.conflict_digest ?? second.conflict, assertion: resolution };
  const before = rows(f);
  rejected(() => f.explorations.mutate(f.context, mutation(f, a, 'incomplete-resolution', { expected_graph: second.receipt.next_graph,
    operation: { ...operation, assertion: { ...resolution, parents: [first.revision] } } })));
  assert.deepEqual(rows(f), before);
  const settled = f.explorations.mutate(f.context, mutation(f, a, 'full-resolution', { expected_graph: second.receipt.next_graph, operation }));
  assert.equal(resolve(f, a, settled).local.entity.status, 'resolved');
  const b = bind(f, { key: 'separate-for-parent-check' }), after = rows(f);
  rejected(() => f.explorations.mutate(f.context, mutation(f, b, 'foreign-parent', {
    operation: { kind: 'assert', assertion: assertion(f, f.event, 'foreign-parent', { parents: [settled.revision] }) } })));
  assert.deepEqual(rows(f), after);
});
