import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, contextRequest, selectedInput, head, content, canonicalRefs, CONTEXT_ACTIONS } from './helpers/context-fixture.mjs';
import { GraphInputs } from '../src/local/graph-inputs.mjs';
import { composeLocalServices } from '../src/local/local-runtime-composition.mjs';
import { readContextSelection, planContextSelection, validateContextReadRequest } from '../src/local/context-reader.mjs';

const append = (f, name, options = {}) => f.explorations.mutate(f.context, contextRequest(f, f.a, name, options));
function reader(f) {
  const { canonical, inputs: explorations } = composeLocalServices({
    store: f.store,
    authority: f.authority,
    canonical_reader: f.config,
  });
  const inputs = new GraphInputs({ store: f.store, authority: f.authority });
  return { inputs, run(kind, request, planning = false) {
    const source_fence = f.feed.head(f.context).sequence;
    let domainError;
    try {
      return f.store.readSnapshot(f.context, view => {
        try { return (planning ? planContextSelection : readContextSelection)({
          view, context: f.context, inputs, explorations, config_digest: canonical.config_digest, request, kind,
          read_pins: { project_selection: explorations.projectSelection(view, f.context), source_fence } }); }
        catch (error) { domainError = error; throw error; }
      });
    } catch (error) { throw domainError ?? error; }
  } };
}

test('selected Context reader separates exact assertion status, projection and authorized source refs', t => {
  const f = fixture(t), first = append(f, 'selected-first');
  const next = append(f, 'selected-correction', { base: first.revision, status: 'validated' });
  const selected = reader(f), request = selectedInput(f, f.a, first);
  const current = selected.run('resolve', request);
  assert.equal(current.local.item.assertion_status, 'candidate');
  assert.equal(current.local.item.projection.status, 'validated');
  assert.equal(current.local.item.historical_role, 'historical');
  assert.deepEqual(current.local.item.projection.head, next.revision);
  assert.equal(current.local.item.sources.events[0].event_id, f.event.event_id);
  assert.equal(current.local.item.publication.operation_origin_ref, first.operation_origin_ref);
  const historical = selected.run('resolve', { ...request, at: first.receipt.next_graph, mode: 'as_of' });
  assert.equal(historical.local.item.historical_role, 'head');
  assert.deepEqual(historical.selection.observed_head, head(f));
});

test('raw lineage preparation performs zero semantic reads and one final 16-target page uses 17 selected ports', t => {
  const f = fixture(t), parents = [];
  for (let i = 0; i < 16; i++) parents.push(append(f, `selected-parent-${i}`).revision);
  const derived = append(f, 'selected-derived', { parents }), selected = reader(f);
  const request = { ...selectedInput(f, f.a, derived), cursor: null, limit: 16 };
  const acceptedEvent = selected.inputs.acceptedEvent;
  selected.inputs.acceptedEvent = () => { throw new Error('raw preparation attempted an authorized semantic read'); };
  const planned = selected.run('lineage', request, true);
  assert.equal(planned.revisions.length, 17);
  selected.inputs.acceptedEvent = acceptedEvent;
  const catalogFromPin = selected.inputs.catalogFromPin; let selectedPorts = 0;
  selected.inputs.catalogFromPin = function (...args) { selectedPorts++; return catalogFromPin.apply(this, args); };
  const actual = selected.run('lineage', request);
  assert.equal(actual.local.links.length, 16); assert(actual.local.next_cursor);
  assert(actual.local.links.every(link => link.role === 'parent' && link.availability === 'available'));
  assert.equal(selectedPorts, 17);
  assert.deepEqual(actual.revisions, planned.revisions);
});

test('Context reader refuses false transition labels written through the broader exploration API', t => {
  const f = fixture(t), first = append(f, 'transition-first');
  const forged = append(f, 'transition-forged', { base: first.revision, change: 'create' });
  assert.throws(() => reader(f).run('resolve', selectedInput(f, f.a, forged)), { code: 'context_transition_invalid' });
  const nullBase = append(f, 'transition-recreated', { entity_id: first.revision.entity_id, change: 'create' });
  assert.throws(() => reader(f).run('resolve', selectedInput(f, f.a, nullBase)), { code: 'context_transition_invalid' });
});

test('read wire and cursors reject hidden fields, getters, proxies and mismatched selected collections', t => {
  const f = fixture(t), result = append(f, 'cursor-root'), selected = reader(f);
  const request = selectedInput(f, f.a, result);
  for (const options of [{ ...request, shared_keys: [] }, { ...request, mode: 'latest' },
    new Proxy(request, {}), { ...request, get address() { throw new Error('getter executed'); } }]) {
    assert.throws(() => validateContextReadRequest(options, 'resolve'), { code: 'context_invalid_request' });
  }
  const page = { exploration_id: f.a.exploration_id, at: head(f), mode: 'as_of', collection: { kind: 'heads' }, cursor: null, limit: 1 };
  const first = selected.run('page', page); assert(first.local.next_cursor);
  assert.throws(() => selected.run('page', { ...page, cursor: first.local.next_cursor,
    collection: { kind: 'history', entity_kind: 'entity', entity_id: result.revision.entity_id } }), { code: 'context_cursor_mismatch' });
  const cursor = structuredClone(first.local.next_cursor); cursor.read_pins.source_fence++;
  assert.throws(() => selected.run('page', { ...page, cursor }), { code: 'context_cursor_mismatch' });
});

test('public Context reads validate requests before composing the canonical reader', t => {
  const f = fixture(t);
  assert.throws(() => f.graph.resolveContext(f.context, null, null), {
    code: 'context_invalid_request', category: 'rejected', message: 'Local Graph: context_invalid_request',
  });
  const selected = append(f, 'reader-order');
  assert.throws(() => f.graph.resolveContext(f.context, selectedInput(f, f.a, selected), null), {
    code: 'invalid_graph_input', category: 'rejected', message: 'Local Graph: invalid_graph_input',
  });
});

test('selected Ticket proof is reused per opaque context and pin while each content checks only its own support', t => {
  const f = fixture(t, { canonical: true }), refs = canonicalRefs(f);
  const { canonical, contexts } = composeLocalServices({ store: f.store, authority: f.authority, canonical_reader: f.config });
  const prepare = canonical.prepare; let reads = 0;
  canonical.prepare = function (...args) { reads++; return prepare.apply(this, args); };
  const applicability = { project: 'owning', exploration: 'owning', tickets: { mode: 'exact', refs: [refs.ticket] }, code: { mode: 'unspecified', refs: [] } };
  const first = append(f, 'proof-one', { typed: { applicability }, canonical_refs: refs.canonical_refs });
  const second = append(f, 'proof-two', { typed: { applicability }, canonical_refs: refs.canonical_refs });
  const union = [refs.ticket, { ...refs.ticket, record_key: 'decision' }];
  const one = contexts.prepare(f.context, content('proof-one', { applicability }), union);
  const two = contexts.prepare(f.context, content('proof-two', { applicability }), union);
  assert.equal(reads, 1, 'one selected canonical read for both contents and their union of keys');
  for (const [result, proof] of [[first, one], [second, two]]) {
    const revision = f.graph.resolve(f.context, { at: head(f), address: result.revision }).revision;
    const projected = f.store.readSnapshot(f.context, view => contexts.assert(view, f.context, proof,
      { assertion: revision.assertion, provenance: revision.provenance }));
    assert.equal(projected.tickets.refs.length, 1); assert.equal(projected.tickets.refs[0].ref.record_key, 'ticket');
  }
  const nextContext = f.issue({ actions: CONTEXT_ACTIONS }).context;
  contexts.prepare(nextContext, content('proof-one', { applicability }), union);
  assert.equal(reads, 2, 'a different opaque grant object cannot reuse the old proof');
  contexts.prepare(f.context, content('proof-one', { applicability }));
  contexts.prepare(f.context, content('proof-one', { applicability }));
  assert.equal(reads, 4, 'independent preparations without a batch always select fresh facts');
  f.clock.now += 4000000;
  assert.throws(() => contexts.prepare(f.context, content('proof-one', { applicability }), union), { code: 'context_unauthorized' });
});
