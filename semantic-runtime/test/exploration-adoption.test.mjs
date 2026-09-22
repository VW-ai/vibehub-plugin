import test from 'node:test';
import assert from 'node:assert/strict';
import { renameSync } from 'node:fs';
import { fixture, adoption, ADOPTION_ACTIONS } from './helpers/adoption-fixture.mjs';
import { rows, rejected, resolve, mutation, assertion, git } from './helpers/exploration-fixture.mjs';

test('explicit adoption copies exact content into a new candidate with separate publication and immutable A lineage', t => {
  const f = fixture(t), beforeA = f.graph.getHead(f.context, { generation_id: f.a.generation_id });
  const request = adoption(f), result = f.explorations.adopt(f.context, request);
  assert.equal(result.status, 'applied'); assert.equal(result.revision.generation_id, f.b.generation_id);
  const a = resolve(f, f.a, f.original).local.revision, b = resolve(f, f.b, result).local.revision;
  assert.deepEqual(b.assertion.content, a.assertion.content); assert.equal(b.assertion.status, 'candidate');
  assert.notEqual(a.entity_id, b.entity_id); assert.deepEqual(b.assertion.parents, []); assert.equal(b.assertion.base_revision, null);
  assert.deepEqual(b.provenance.events, a.provenance.events); assert.deepEqual(b.assertion.events, a.provenance.events);
  assert.deepEqual(f.graph.getHead(f.context, { generation_id: f.a.generation_id }), beforeA);
  const origin = f.store.getSource(f.context, 'exploration-projection', result.operation_origin_ref).value;
  assert.equal(origin.operation, 'adopt'); assert.equal(origin.execution_workspace_id, f.b.execution_workspace_id);
  assert.equal(origin.exploration_id, f.b.exploration_id); assert.equal(origin.actor, 'owner');
  assert.deepEqual(origin.previous_graph, request.destination.expected_graph); assert.deepEqual(origin.next_graph, result.receipt.next_graph);
  assert.equal(result.receipt.operation_origin_ref, result.operation_origin_ref); assert(result.adoption);
  const before = rows(f), retry = f.explorations.adopt(f.context, request);
  assert.equal(retry.status, 'duplicate'); assert.deepEqual(retry.receipt, result.receipt); assert.deepEqual(rows(f), before);
  assert.deepEqual(f.explorations.getReceipt(f.context, { idempotency_key: request.idempotency_key }), result.receipt);
});

test('historical eligible source remains explicitly adoptable after later semantic supersession', t => {
  const f = fixture(t);
  const updated = f.explorations.mutate(f.context, mutation(f, f.a, 'new-direction', {
    expected_graph: f.original.receipt.next_graph,
    operation: { kind: 'assert', assertion: assertion(f, f.event, 'new-direction', {
      base_revision: f.original.revision, parents: [f.original.revision], status: 'validated' }) }
  }));
  const request = adoption(f); assert.deepEqual(request.source.expected_head, updated.receipt.next_graph);
  const result = f.explorations.adopt(f.context, request);
  assert.equal(result.status, 'applied');
  assert.deepEqual(resolve(f, f.b, result).local.revision.assertion.content, resolve(f, f.a, f.original).local.revision.assertion.content);
});

test('fresh intent creates another candidate; stale destination and changed same-key bodies have no effects', t => {
  const f = fixture(t), request = adoption(f), first = f.explorations.adopt(f.context, request);
  let before = rows(f);
  rejected(() => f.explorations.adopt(f.context, { ...request, epoch: request.epoch + 1 })); assert.deepEqual(rows(f), before);
  const stale = { ...request, idempotency_key: 'stale-destination' };
  rejected(() => f.explorations.adopt(f.context, stale)); assert.deepEqual(rows(f), before);
  const second = f.explorations.adopt(f.context, adoption(f, { key: 'explicit-second-intent' }));
  assert.notDeepEqual(first.revision, second.revision); assert.notEqual(first.revision.entity_id, second.revision.entity_id);
});

test('committed adoption retry survives restart, removed worktrees and disabled Project without rewriting history', t => {
  const f = fixture(t), request = adoption(f), result = f.explorations.adopt(f.context, request);
  const active = f.activation.get(f.context); f.activation.setEnabled(f.context, { enabled: false, expectedVersion: active.version });
  renameSync(f.folder, `${f.folder}-gone`); renameSync(f.otherFolder, `${f.otherFolder}-gone`);
  const before = rows(f); f.store.close(); const reopened = f.reopen();
  assert.deepEqual(reopened.explorations.adopt(reopened.context, request), { ...result, status: 'duplicate' });
  assert.deepEqual(reopened.explorations.getReceipt(reopened.context, { idempotency_key: request.idempotency_key }), result.receipt);
  assert.deepEqual(rows(reopened), before);
});

test('new adoption needs explicit action and actual current destination physical binding', t => {
  const f = fixture(t), request = adoption(f), before = rows(f);
  for (const omitted of ['exploration:adopt', 'source:read']) {
    const limited = f.issue({ actions: ADOPTION_ACTIONS.filter(action => action !== omitted) }).context;
    rejected(() => f.explorations.adopt(limited, request)); assert.deepEqual(rows(f), before);
  }
  git(f.otherFolder, 'switch', '-c', 'unsurveyed-branch');
  rejected(() => f.explorations.adopt(f.context, request)); assert.deepEqual(rows(f), before);
});

test('untrusted content, same exploration, forged exact source and invalid endpoint mappings refuse without effects', t => {
  const f = fixture(t), request = adoption(f), before = rows(f);
  for (const altered of [
    { ...request, assertion: { content: 'caller replacement' } },
    { ...request, source: { ...request.source, exploration_id: f.b.exploration_id } },
    { ...request, source: { ...request.source, address: { ...request.source.address, revision_digest: `sha256:${'0'.repeat(64)}` } } },
    { ...request, endpoint_map: [{ source: f.original.revision, destination: f.original.revision }] },
    { ...request, source: { ...request.source, expected_head: f.a.graph_revision } }
  ]) { rejected(() => f.explorations.adopt(f.context, altered)); assert.deepEqual(rows(f), before); }
});
