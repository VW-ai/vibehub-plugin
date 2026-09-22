import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainStore } from '../src/index.mjs';
import { fixture, adoption, ADOPTION_ACTIONS } from './helpers/adoption-fixture.mjs';
import { rows, rejected, mutation, bindRequest, pin } from './helpers/exploration-fixture.mjs';

test('adoption rechecks source, destination, binding, Project and source access after preparation at writer admission', async t => {
  for (const kind of ['source-head', 'destination-head', 'binding', 'project-selection', 'source-access', 'disable']) await t.test(kind, t => {
    const f = fixture(t, { canonical: kind === 'project-selection' }), request = adoption(f), other = f.reopen();
    const transaction = DomainStore.prototype.transaction; let raced = false, afterRace;
    t.mock.method(f.store, 'transaction', function (context, callback) {
      if (!raced) {
        raced = true;
        if (kind === 'source-head' || kind === 'destination-head') {
          const binding = kind === 'source-head' ? f.a : f.b;
          const head = other.graph.getHead(other.context, { generation_id: binding.generation_id }).graph_revision;
          other.explorations.mutate(other.context, mutation(f, binding, `raced-${kind}`, { expected_graph: head }));
        } else if (kind === 'binding') other.explorations.bind(other.context, bindRequest(f, { key: 'raced-binding', execution: f.executionB }));
        else if (kind === 'project-selection') other.explorations.setProjectSelection(other.context,
          { epoch: f.epoch, idempotency_key: 'raced-project-selection', expected_version: null, pin: pin(f.canonical) });
        else if (kind === 'source-access') other.ingress.updateSourceAccess(other.context,
          { registration_id: f.source.registration_id, expectedVersion: f.source.version,
            access: { ...f.source.registration.access, enabled: false } });
        else { const state = other.activation.get(other.context); other.activation.setEnabled(other.context,
          { enabled: false, expectedVersion: state.version }); }
        afterRace = rows(f);
      }
      return transaction.call(this, context, callback);
    });
    rejected(() => f.explorations.adopt(f.context, request)); assert(raced); assert.deepEqual(rows(f), afterRace);
    assert.equal(f.explorations.getReceipt(f.context, { idempotency_key: request.idempotency_key }), null);
  });
});

test('adoption refuses expired/revoked current authority after preparation without any writes', async t => {
  for (const kind of ['expiry', 'revocation']) await t.test(kind, t => {
    const f = fixture(t), request = adoption(f), principal = f.issue({ actions: ADOPTION_ACTIONS });
    const before = rows(f), transaction = DomainStore.prototype.transaction; let raced = false;
    t.mock.method(f.store, 'transaction', function (context, callback) {
      raced = true;
      if (kind === 'expiry') f.clock.now += 3_600_001;
      else f.authority.revoke(principal.issued.credential_id);
      return transaction.call(this, context, callback);
    });
    rejected(() => f.explorations.adopt(principal.context, request)); assert(raced); assert.deepEqual(rows(f), before);
  });
});

test('adoption validates source and destination immutable shared bases independently and never promotes a Project selection', t => {
  const f = fixture(t, { canonical: true });
  // Origin null cannot be silently upgraded by a caller supplying a real pin.
  const request = adoption(f), before = rows(f);
  for (const side of ['source', 'destination']) {
    rejected(() => f.explorations.adopt(f.context, { ...request, [side]: { ...request[side], shared_base: pin(f.canonical) } }));
    assert.deepEqual(rows(f), before);
  }
  const adopted = f.explorations.adopt(f.context, request);
  const view = f.explorations.getSelection(f.context, { exploration_id: f.b.exploration_id, at: adopted.receipt.next_graph });
  assert.equal(view.shared.current_project.version, null); assert.equal(view.shared.current_project.pin, null);
});
