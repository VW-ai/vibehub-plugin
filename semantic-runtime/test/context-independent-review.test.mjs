import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, publish, adoption, selectedInput, head, CONTEXT_ACTIONS, rows, canonicalRefs, contextRequest, capture } from './helpers/context-fixture.mjs';
import { records, digest } from './helpers/canonical-reader-fixture.mjs';

test('owned adopted Context reads preserve read authority while retained adoption receipts require adoption permissions', async t => {
  for (const missing of ['exploration:adopt', 'source:read']) await t.test(missing, t => {
    const f = fixture(t), original = publish(f, 'independent-adoption-authorization');
    const adopted = f.contexts.adopt(f.context, adoption(f, { source: original }));
    const query = selectedInput(f, f.b, adopted), before = rows(f);
    const restricted = f.issue({ actions: CONTEXT_ACTIONS.filter(action => action !== missing) }).context;
    assert.equal(f.contexts.resolve(restricted, query).local.item.transition.kind, 'adopt');
    assert.equal(f.contexts.page(restricted, { exploration_id: f.b.exploration_id, at: head(f, f.b),
      mode: 'current', collection: { kind: 'heads' }, cursor: null, limit: 16 }).local.items.length, 1);
    const lineage = f.contexts.lineage(restricted, { ...query, cursor: null, limit: 16 });
    assert.equal(lineage.local.links.find(link => link.role === 'adoption_source').availability, 'available');
    assert.throws(() => f.contexts.getReceipt(restricted, { idempotency_key: 'adopt-one' }), { code: 'exploration_unauthorized' });
    assert.deepEqual(rows(f), before);
  });
});

function distinctTickets(count) {
  const initial = records(), values = { authority: initial.authority };
  for (let index = 0; index < count; index++) {
    const ticket = structuredClone(initial.ticket); ticket.ticket_id = `independent-ticket-${index}`;
    for (const acceptance of ticket.acceptance) acceptance.identity = digest({ ticket_id: ticket.ticket_id,
      acceptance_id: acceptance.acceptance_id, revision: acceptance.revision, criterion: acceptance.criterion,
      authority: acceptance.authority, derived_from: [] });
    const contract = ticket.contract_revisions[0];
    contract.acceptance_revisions = ticket.acceptance.map(({ acceptance_id, revision, identity }) => ({ acceptance_id, revision, identity }));
    contract.identity = digest({ ticket_id: ticket.ticket_id, revision: contract.revision, acceptance_revisions: contract.acceptance_revisions });
    values[`ticket${index}`] = ticket;
  }
  return values;
}

test('nine actual Ticket records at one exact selection pin fit the lineage proof budget', t => {
  const f = fixture(t, { canonical: true, values: distinctTickets(9) }), parents = [];
  for (let index = 0; index < 9; index++) {
    const refs = canonicalRefs(f, `ticket${index}`);
    parents.push(publish(f, `independent-ticket-parent-${index}`, { canonical_refs: refs.canonical_refs,
      typed: { applicability: { project: 'owning', exploration: 'owning', tickets: { mode: 'exact', refs: [refs.ticket] },
        code: { mode: 'unspecified', refs: [] } } } }).revision);
  }
  const root = publish(f, 'independent-one-selection-root', { parents });
  const before = rows(f), result = f.contexts.lineage(f.context, { ...selectedInput(f, f.a, root), cursor: null, limit: 16 });
  const linked = result.local.links.filter(link => link.role === 'parent');
  assert.equal(linked.length, 9); assert.equal(result.local.next_cursor, null);
  assert.deepEqual(linked.map(link => link.item.applicability.tickets.refs[0].ticket_id).sort(),
    Array.from({ length: 9 }, (_, index) => `independent-ticket-${index}`).sort());
  assert.deepEqual(rows(f), before);
});

test('typed adoption cannot launder a false source transition admitted by the broader Graph API', t => {
  const f = fixture(t), first = publish(f, 'independent-real-creation');
  const malformed = f.explorations.mutate(f.context, contextRequest(f, f.a, 'independent-false-creation',
    { base: first.revision, change: 'create' }));
  assert.throws(() => f.contexts.resolve(f.context, selectedInput(f, f.a, malformed)), { code: 'context_transition_invalid' });
  const request = adoption(f, { source: malformed, key: 'independent-reject-false-creation' }), before = rows(f);
  assert.throws(() => f.contexts.adopt(f.context, request), { code: 'context_transition_invalid' });
  assert.deepEqual(rows(f), before);
});

test('a small 16-target lineage response does not aggregate duplicated private source proofs into its output budget', t => {
  const f = fixture(t), events = [f.event], parents = [];
  for (let index = 1; index < 32; index++) events.push(capture(f, f.source,
    { sequence: index, key: `independent-shared-event-${index}` }));
  for (let index = 0; index < 16; index++) parents.push(publish(f, `independent-shared-proof-parent-${index}`, { events }).revision);
  const root = publish(f, 'independent-shared-proof-root', { parents, events });
  const before = rows(f), result = f.contexts.lineage(f.context, { ...selectedInput(f, f.a, root), cursor: null, limit: 16 });
  assert.equal(result.local.links.length, 16); assert(result.local.next_cursor);
  assert(result.local.links.every(link => link.role === 'parent' && link.availability === 'available'));
  assert(Buffer.byteLength(JSON.stringify(result)) < 300000);
  assert.deepEqual(rows(f), before);
});
