import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executePolicyRun, createInMemoryPolicyTransactionPort, graphRevisionAddress,
  resolveWorkingGraphAddress,
} from '../../src/index.mjs';
import { kernelFixture } from '../fixtures/policy-kernel/scenario.mjs';

test('public kernel commits one Graph mutation and retries the exact command after its base becomes historical', async () => {
  const fixture = kernelFixture();
  const transaction = createInMemoryPolicyTransactionPort({ graph: fixture.graph });
  const before = graphRevisionAddress(fixture.graph);
  const first = await executePolicyRun({ ...fixture, transaction });
  assert.equal(first.status, 'committed');
  assert.equal(first.action, 'INGEST');
  const after = transaction.inspect();
  assert.notDeepEqual(graphRevisionAddress(after.graph), before);
  assert.equal(after.commands.length, 1);
  assert.equal(after.receipts.length, 1);
  assert.equal(after.audits.length, 1);
  const revision = after.graph.snapshots.at(-1).entities[0].head;
  const read = resolveWorkingGraphAddress(after.graph, revision, {
    principal_id: 'alice', current_graph: after.graph,
  });
  assert.equal(read.status, 'resolved');
  assert.equal(read.revision.assertion.status, 'candidate');
  assert.equal(read.revision.provenance.events[0].event_id, fixture.event.event_id);
  const duplicate = await executePolicyRun({ ...fixture, transaction });
  assert.equal(duplicate.status, 'committed');
  assert.deepEqual(duplicate.receipt, first.receipt);
  assert.deepEqual(transaction.inspect(), after);
  assert.deepEqual(graphRevisionAddress(fixture.graph), before);
});

test('competing public policy invocations cannot both commit against one Graph revision', async () => {
  const fixture = kernelFixture();
  const transaction = createInMemoryPolicyTransactionPort({ graph: fixture.graph });
  const results = await Promise.all(['a', 'b'].map(suffix => executePolicyRun({
    ...fixture, run_id: `run-${suffix}`, idempotency_key: `invoke-${suffix}`, transaction,
  })));
  assert.equal(results.filter(result => result.status === 'committed').length, 1);
  assert.equal(results.filter(result => result.reason_code === 'graph_revision_mismatch').length, 1);
  const stored = transaction.inspect();
  assert.equal(stored.graph.snapshots.length, fixture.graph.snapshots.length + 1);
  assert.equal(stored.commands.length, 1);
  assert.equal(stored.receipts.length, 1);
  assert.equal(stored.audits.length, 1);
});

test('public transaction cancellation before publication leaves Graph, receipt, audit and outbox unchanged', async () => {
  const fixture = kernelFixture({ action: 'ESCALATE' });
  const cancellation = new AbortController();
  const transaction = createInMemoryPolicyTransactionPort({
    graph: fixture.graph, beforeCommit: async () => cancellation.abort(),
  });
  const original = transaction.inspect();
  const result = await executePolicyRun({ ...fixture, transaction, signal: cancellation.signal });
  assert.notEqual(result.status, 'committed');
  assert.deepEqual(transaction.inspect(), original);
});

test('public escalation creates one auditable intent without changing semantic state or duplicating delivery', async () => {
  const fixture = kernelFixture({ action: 'ESCALATE' });
  const transaction = createInMemoryPolicyTransactionPort({ graph: fixture.graph });
  const first = await executePolicyRun({ ...fixture, transaction });
  assert.equal(first.status, 'committed');
  const stored = transaction.inspect();
  assert.deepEqual(stored.graph, fixture.graph);
  assert.equal(stored.outbox.length, 1);
  assert.equal(stored.outbox[0].kind, 'policy_escalation');
  assert.equal(stored.outbox[0].command_digest, first.receipt.payload_digest);
  assert.equal(stored.audits[0].correlation.policy_revision, fixture.artifact.content_hash);
  await executePolicyRun({ ...fixture, transaction });
  assert.deepEqual(transaction.inspect(), stored);
});

test('public kernel reconciles a committed action after cancellation interrupts receipt delivery', async () => {
  const fixture = kernelFixture();
  const transaction = createInMemoryPolicyTransactionPort({ graph: fixture.graph });
  const cancellation = new AbortController();
  const delayedAcknowledgement = {
    async commit(command, options) {
      await transaction.commit(command, options);
      cancellation.abort();
      return new Promise(() => {});
    },
  };
  const interrupted = await executePolicyRun({ ...fixture,
    transaction: delayedAcknowledgement, signal: cancellation.signal,
  });
  assert.equal(interrupted.status, 'indeterminate');
  assert.equal(interrupted.reason_code, 'commit_unconfirmed');
  assert.equal(interrupted.receipt, null);
  const observed = transaction.lookup(interrupted.command_ref);
  assert.equal(observed.status, 'committed');
  const committed = transaction.inspect();
  assert.equal(committed.graph.snapshots.length, fixture.graph.snapshots.length + 1);
  assert.equal(committed.receipts.length, 1);
  const retried = await executePolicyRun({ ...fixture, transaction });
  assert.equal(retried.status, 'committed');
  assert.deepEqual(retried.receipt, observed.receipt);
  assert.deepEqual(transaction.inspect(), committed);
});
