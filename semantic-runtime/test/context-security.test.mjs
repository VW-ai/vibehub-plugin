import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fixture, publish, contextRequest, content, canonicalRefs, gitCodeRef, read, selectedInput, adoption, rows,
  boundedFailure, head, CONTEXT_ACTIONS, SCOPE } from './helpers/context-fixture.mjs';
import { graphHash } from '../src/local/graph-inputs.mjs';
import { DomainStore } from '../src/adapters/sqlite/domain-store.mjs';
import { ContextInputs } from '../src/local/context-inputs.mjs';
import { bindRequest, pin } from './helpers/exploration-fixture.mjs';

test('all six methods require context read and mutations additionally require context write', t => {
  const f = fixture(t), request = contextRequest(f, f.a, 'private-domain'), result = f.contexts.mutate(f.context, request);
  const lackingRead = f.issue({ actions: CONTEXT_ACTIONS.filter(a => a !== 'context:read') }).context;
  const query = selectedInput(f, f.a, result), before = rows(f);
  for (const operation of [
    () => f.contexts.mutate(lackingRead, request),
    () => f.contexts.adopt(lackingRead, adoption(f, { source: result })),
    () => f.contexts.resolve(lackingRead, query),
    () => f.contexts.page(lackingRead, { exploration_id: f.a.exploration_id, at: head(f), mode: 'current', collection: { kind: 'heads' }, cursor: null, limit: 16 }),
    () => f.contexts.lineage(lackingRead, { ...query, cursor: null, limit: 16 }),
    () => f.contexts.getReceipt(lackingRead, { idempotency_key: request.idempotency_key })
  ]) boundedFailure(operation);
  const lackingWrite = f.issue({ actions: CONTEXT_ACTIONS.filter(a => a !== 'context:write') }).context;
  boundedFailure(() => f.contexts.mutate(lackingWrite, contextRequest(f, f.a, 'no-write')));
  boundedFailure(() => f.contexts.adopt(lackingWrite, adoption(f, { source: result })));
  assert.deepEqual(rows(f), before);
});

test('typed profile rejects unknown fields, invented authority and contradictory change semantics without effects', t => {
  const f = fixture(t), before = rows(f);
  const malformed = [
    { ...content('bad'), canonical: true },
    content('bad', { authority: true }), content('bad', { role: 'authority' }),
    content('bad', { summary: '' }), content('bad', { summary: 'x'.repeat(513) }),
    content('bad', { detail: 'x'.repeat(8193) }), content('bad', { reason: '' }),
    content('bad', { applicability: { project: 'owning', exploration: 'owning', tickets: { mode: 'exact', refs: [] }, code: { mode: 'any', refs: [] } } })
  ];
  for (const [i, value] of malformed.entries()) {
    const request = contextRequest(f, f.a, `bad-${i}`); request.operation.assertion.content = value;
    boundedFailure(() => f.contexts.mutate(f.context, request)); assert.deepEqual(rows(f), before);
  }
  for (const change of ['derive', 'branch', 'revise', 'supersede', 'invalidate', 'resolve']) {
    boundedFailure(() => publish(f, `contradiction-${change}`, { change })); assert.deepEqual(rows(f), before);
  }
  boundedFailure(() => f.contexts.adopt(f.context, adoption(f, { source: f.original, key: 'untyped-adoption' })));
  assert.deepEqual(rows(f), before);
});

test('public inert-data checks reject getters and Proxies before executing caller traps', t => {
  const f = fixture(t), request = contextRequest(f, f.a, 'inert'); let calls = 0;
  Object.defineProperty(request.operation.assertion.content.data, 'summary', { enumerable: true, get() { calls++; return 'unsafe'; } });
  boundedFailure(() => f.contexts.mutate(f.context, request)); assert.equal(calls, 0);
  const proxy = new Proxy({}, { getPrototypeOf() { calls++; return Object.prototype; }, ownKeys() { calls++; return []; }, get() { calls++; return null; } });
  boundedFailure(() => f.contexts.resolve(f.context, proxy)); assert.equal(calls, 0);
});

test('exact Ticket and Git version applicability uses actual reader issued source records and preserves citations', t => {
  const f = fixture(t, { canonical: true }), refs = canonicalRefs(f), code = gitCodeRef(f);
  refs.canonical_refs.push(code.artifact);
  const applicability = { project: 'owning', exploration: 'owning', tickets: { mode: 'exact', refs: [refs.ticket] }, code: { mode: 'exact', refs: [code.ref] } };
  const result = publish(f, 'versioned-meaning', { canonical_refs: refs.canonical_refs, typed: { applicability } });
  const selected = read(f, f.a, result); assert.equal(selected.local.status, 'resolved');
  assert.deepEqual(selected.local.item.meaning.applicability, applicability);
  const verified = selected.local.item.applicability;
  assert.equal(verified.status, 'specified'); assert.deepEqual(verified.uncertain_dimensions, []);
  assert.deepEqual(verified.scope, SCOPE); assert.equal(verified.exploration_id, f.a.exploration_id);
  assert.equal(verified.tickets.refs[0].ticket_id, 'example');
  assert.equal(verified.tickets.refs[0].contract_revision.revision, 1);
  assert.match(verified.tickets.refs[0].contract_revision.identity, /^sha256:[0-9a-f]{64}$/);
  assert.equal(verified.tickets.refs[0].selection_status, 'current');
  assert.deepEqual(verified.tickets.refs[0].ref, refs.ticket);
  assert.equal(verified.code.refs[0].commit_oid, code.object.oid);
  assert.equal(verified.code.refs[0].path, code.path);
  assert.equal(verified.code.refs[0].repository_id, f.execution.repository_id);
  const before = rows(f);
  for (const [name, altered, canonical_refs] of [
    ['missing-support', applicability, []],
    ['unknown-record', { ...applicability, tickets: { mode: 'exact', refs: [{ ...refs.ticket, record_key: 'not-configured' }] } }, refs.canonical_refs],
    ['wrong-record-kind', { ...applicability, tickets: { mode: 'exact', refs: [{ ...refs.ticket, record_key: 'authority' }] } }, refs.canonical_refs],
    ['forged-code', { ...applicability, code: { mode: 'exact', refs: [{ event_digest: `sha256:${'0'.repeat(64)}` }] } }, refs.canonical_refs],
    ['snapshot-not-git', { ...applicability, code: { mode: 'exact', refs: [{ event_digest: graphHash(f.event) }] } }, refs.canonical_refs],
    ['forged-selection', { ...applicability, tickets: { mode: 'exact', refs: [{ ...refs.ticket, address: { ...refs.ticket.address, revision_digest: `sha256:${'1'.repeat(64)}` } }] } }, refs.canonical_refs]
  ]) {
    boundedFailure(() => publish(f, name, { canonical_refs, typed: { applicability: altered } })); assert.deepEqual(rows(f), before);
  }
});

test('source permission loss prevents current, history and retained receipt disclosure without erasing metadata', t => {
  const f = fixture(t), request = contextRequest(f, f.a, 'revoked'), first = f.contexts.mutate(f.context, request);
  f.ingress.updateSourceAccess(f.context, { registration_id: f.source.registration_id, expectedVersion: f.source.version,
    access: { ...f.source.registration.access, allowed_principal_ids: [] } });
  const before = rows(f);
  for (const mode of ['current', 'as_of']) {
    let denied;
    try { denied = read(f, f.a, first, { mode }); } catch (error) { assert(/^[a-z_]+$/.test(error.code)); continue; }
    assert.equal(denied.local.status, 'denied'); assert.equal(denied.local.item, null);
    assert(!JSON.stringify(denied).includes('Synthetic revoked'));
  }
  boundedFailure(() => f.contexts.getReceipt(f.context, { idempotency_key: request.idempotency_key }));
  boundedFailure(() => f.contexts.mutate(f.context, request)); assert.deepEqual(rows(f), before);
});

test('selected publication facts cannot be resealed with a different publisher identity', t => {
  const f = fixture(t), result = publish(f, 'actual-origin');
  const original = f.store.getSource(f.context, 'exploration-projection', result.operation_origin_ref).value;
  const { identity: _identity, ...body } = original; body.publisher_execution_id = 'forged-execution';
  const corrupt = { ...body, identity: graphHash(body) }, db = new DatabaseSync(f.filePath);
  try { assert.equal(db.prepare('UPDATE sources SET value=? WHERE tenant_id=? AND project_id=? AND namespace=? AND id=?').run(
    JSON.stringify(corrupt), SCOPE.tenant_id, SCOPE.project_id, 'exploration-projection', result.operation_origin_ref).changes, 1); }
  finally { db.close(); }
  const before = rows(f); boundedFailure(() => read(f, f.a, result)); assert.deepEqual(rows(f), before);
});

test('typed write admission rechecks real binding, Project, source and opaque authority after preparation', async t => {
  for (const kind of ['binding', 'project', 'source', 'disable', 'revocation', 'expiry']) await t.test(kind, t => {
    const f = fixture(t, { canonical: kind === 'project' }), request = contextRequest(f, f.a, `admission-${kind}`);
    const principal = f.issue({ actions: CONTEXT_ACTIONS }), other = f.reopen();
    const transaction = DomainStore.prototype.transaction; let raced = false, afterRace;
    t.mock.method(f.store, 'transaction', function (context, callback) {
      if (!raced) {
        raced = true;
        if (kind === 'binding') other.explorations.bind(other.context, bindRequest(f, { key: 'new-binding' }));
        else if (kind === 'project') other.explorations.setProjectSelection(other.context,
          { epoch: f.epoch, idempotency_key: 'new-project-pin', expected_version: null, pin: pin(f.canonical) });
        else if (kind === 'source') other.ingress.updateSourceAccess(other.context,
          { registration_id: f.source.registration_id, expectedVersion: f.source.version,
            access: { ...f.source.registration.access, allowed_principal_ids: [] } });
        else if (kind === 'disable') { const state = other.activation.get(other.context);
          other.activation.setEnabled(other.context, { enabled: false, expectedVersion: state.version }); }
        else if (kind === 'revocation') f.authority.revoke(principal.issued.credential_id);
        else f.clock.now += 3_600_001;
        afterRace = rows(f);
      }
      return transaction.call(this, context, callback);
    });
    boundedFailure(() => f.contexts.mutate(principal.context, request)); assert(raced);
    assert.deepEqual(rows(f), afterRace);
    assert(!JSON.stringify(afterRace).includes(request.idempotency_key));
  });
});

test('typed reads refuse source, Project or selected Graph movement between preparation and selected read', async t => {
  for (const kind of ['source', 'project', 'head']) await t.test(kind, t => {
    const f = fixture(t, { canonical: kind === 'project' }), first = publish(f, 'read-race');
    const query = selectedInput(f, f.a, first), other = f.reopen(), prepare = ContextInputs.prototype.prepare;
    let raced = false, afterRace;
    t.mock.method(ContextInputs.prototype, 'prepare', function (...args) {
      const prepared = prepare.apply(this, args);
      if (!raced) {
        raced = true;
        if (kind === 'source') other.ingress.updateSourceAccess(other.context,
          { registration_id: f.source.registration_id, expectedVersion: f.source.version,
            access: { ...f.source.registration.access, allowed_principal_ids: [] } });
        else if (kind === 'project') other.explorations.setProjectSelection(other.context,
          { epoch: f.epoch, idempotency_key: 'read-project-pin', expected_version: null, pin: pin(f.canonical) });
        else other.contexts.mutate(other.context, contextRequest(f, f.a, 'new-read-head'));
        afterRace = rows(f);
      }
      return prepared;
    });
    boundedFailure(() => f.contexts.resolve(f.context, query)); assert(raced); assert.deepEqual(rows(f), afterRace);
  });
});

test('current opaque authority is rechecked after domain materialization and no stale payload escapes', t => {
  const f = fixture(t), first = publish(f, 'post-materialization-private'), principal = f.issue({ actions: CONTEXT_ACTIONS });
  const query = selectedInput(f, f.a, first), before = rows(f), verify = ContextInputs.prototype.assert; let revoked = false;
  t.mock.method(ContextInputs.prototype, 'assert', function (...args) {
    const result = verify.apply(this, args);
    if (!revoked) { revoked = true; f.authority.revoke(principal.issued.credential_id); }
    return result;
  });
  boundedFailure(() => f.contexts.resolve(principal.context, query)); assert(revoked); assert.deepEqual(rows(f), before);
});

test('a missing required immutable publication cannot become an incomplete successful Context view', t => {
  const f = fixture(t), first = publish(f, 'missing-publication'), query = selectedInput(f, f.a, first);
  const db = new DatabaseSync(f.filePath);
  try { assert.equal(db.prepare('DELETE FROM sources WHERE namespace=? AND id=?').run('exploration-projection', first.operation_origin_ref).changes, 1); }
  finally { db.close(); }
  const before = rows(f);
  for (const method of [
    () => f.contexts.resolve(f.context, query),
    () => f.contexts.lineage(f.context, { ...query, cursor: null, limit: 16 }),
    () => f.contexts.page(f.context, { exploration_id: f.a.exploration_id, at: query.at, mode: 'as_of', collection: { kind: 'heads' }, cursor: null, limit: 16 })
  ]) boundedFailure(method);
  assert.deepEqual(rows(f), before);
});
