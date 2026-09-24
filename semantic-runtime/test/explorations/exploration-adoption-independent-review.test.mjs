import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fixture, adoption } from '../support/adoption-fixture.mjs';
import { rows, bind, mutation, git, resolve } from '../support/exploration-fixture.mjs';
import { graphHash } from '../../src/application/graph/graph-inputs.mjs';

// One damaged selected row still has a valid local seal, but contradicts the
// independent retained publication facts. No other database row is rewritten.
function contradictOrigin(f, originRef, field, value) {
  const origin = structuredClone(f.store.getSource(f.context, 'exploration-projection', originRef).value);
  delete origin.identity;
  origin[field] = value;
  origin.identity = graphHash(origin);
  const db = new DatabaseSync(f.filePath);
  try {
    assert.equal(db.prepare('UPDATE sources SET value=? WHERE namespace=? AND id=?').run(
      JSON.stringify(origin), 'exploration-projection', originRef).changes, 1);
  } finally { db.close(); }
}

test('independent review: first adoption refuses A publication route inconsistent with its retained facts', async t => {
  for (const [field, value] of [
    ['execution_workspace_id', 'unrelated-workspace'],
    ['binding_version', 1999],
    ['catalog_version', 1999],
    ['publisher_session_id', 'unrelated-publication-session'],
  ]) await t.test(field, t => {
    const f = fixture(t), request = adoption(f);
    contradictOrigin(f, f.original.operation_origin_ref, field, value);
    const before = rows(f);
    assert.throws(() => f.explorations.adopt(f.context, request), { code: 'exploration_corrupt' });
    assert.deepEqual(rows(f), before);
    assert.equal(f.explorations.getReceipt(f.context, { idempotency_key: request.idempotency_key }), null);
  });
});

test('independent review: retained adoption and receipt refuse B origin inconsistent with its committed publication', async t => {
  for (const field of ['actor', 'previous_graph', 'next_graph', 'publisher_execution_id', 'execution_workspace_id', 'generation_id']) {
    await t.test(field, t => {
      const f = fixture(t), request = adoption(f), adopted = f.explorations.adopt(f.context, request);
      contradictOrigin(f, adopted.operation_origin_ref, field, field.endsWith('_graph') ? f.a.graph_revision : 'unrelated-retained-fact');
      const before = rows(f);
      assert.throws(() => f.explorations.adopt(f.context, request), { code: 'exploration_corrupt' });
      assert.throws(() => f.explorations.getReceipt(f.context, { idempotency_key: request.idempotency_key }), { code: 'exploration_corrupt' });
      assert.deepEqual(rows(f), before);
    });
  }
});

test('independent review: first historical adoption survives source worktree and branch deletion', t => {
  const f = fixture(t);
  // Put source A in a removable linked worktree; B remains the main checkout.
  f.a = bind(f, { key: 'removable-source', execution: f.executionB });
  f.b = bind(f, { key: 'remaining-destination', execution: f.execution });
  f.original = f.explorations.mutate(f.context, mutation(f, f.a, 'source-before-removal'));
  const original = resolve(f, f.a, f.original).local.revision;
  git(f.folder, 'worktree', 'remove', '--force', f.otherFolder);
  git(f.folder, 'branch', '-D', 'branch-b');
  f.refresh();
  const request = adoption(f, { key: 'fresh-after-source-removal' });
  const result = f.explorations.adopt(f.context, request);
  assert.equal(result.status, 'applied');
  assert.deepEqual(resolve(f, f.b, result).local.revision.assertion.content, original.assertion.content);
  assert.equal(result.adoption.source.operation_origin_ref, f.original.operation_origin_ref);
  const before = rows(f);
  assert.deepEqual(f.explorations.adopt(f.context, request), { ...result, status: 'duplicate' });
  assert.deepEqual(rows(f), before);
});
