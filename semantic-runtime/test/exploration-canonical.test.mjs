import test from 'node:test';
import assert from 'node:assert/strict';
import { renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { CanonicalSourceReader } from '../src/application/sources/canonical-source-reader.mjs';
import { composeLocalServices } from '../src/application/support/local-runtime-composition.mjs';
import { readerFixture, records, writeRecords, git, READER_ACTIONS } from './helpers/canonical-reader-fixture.mjs';
import { mutation } from './helpers/graph-store-fixture.mjs';

const config = f => ({ repository_path: f.folder, execution: f.execution, registration_id: f.source.registration_id, selection: f.selection });
const helper = (f, canonical_reader = config(f)) => composeLocalServices({
  store: f.store,
  authority: f.authority,
  canonical_reader,
}).canonical;
const pin = (f, read, record_keys = f.selection.records.map(record => record.key)) => ({ at: read.graph_revision, address: read.address, record_keys });
const code = (fn, expected) => assert.throws(fn, error => error.code === expected);
function view(f, canonical, proof, keys = null, snapshot = f.store.readSnapshot.bind(f.store)) {
  let error;
  try { return snapshot(f.context, tx => {
    try { canonical.assert(tx, f.context, proof); return canonical.material(proof, keys); }
    catch (caught) { error = caught; throw caught; }
  }); } catch (caught) { throw error ?? caught; }
}
const nextRequest = (f, prior, commit_oid) => ({ ...f.request, idempotency_key: 'next-selection', commit_oid,
  expected_graph: prior.graph_revision, previous_selection: prior.selection,
  observation: { ...f.request.observation, sequence_start: f.selection.records.length } });

test('canonical proof retains actual reader evaluation and every configured active Authority despite filters', t => {
  const f = readerFixture(t), canonical = helper(f), first = f.reader.refresh(f.context, f.request);
  const proof = canonical.prepare(f.context, pin(f, first, ['decision']), { requireCurrent: true });
  assert.equal(canonical.config_digest, first.selection.assertion.content.data.config_digest);
  assert.deepEqual(canonical.summary(proof), { pin: canonical.pin(pin(f, first, ['decision'])), status: 'current', source_fence: 0 });
  code(() => canonical.material(proof), 'exploration_canonical_unchecked');
  const filtered = view(f, canonical, proof, []);
  assert.equal(filtered.status, 'current');
  assert.deepEqual(filtered.returned_record_keys, ['authority']);
  assert.deepEqual(filtered.authority_record_keys, ['authority']);
  assert.equal(filtered.coverage.status, 'partial'); assert.equal(filtered.coverage.scope, 'configured_selection');
  assert.equal(filtered.configured_record_keys.length, 8);
  assert.deepEqual(filtered.data.records, first.selection.assertion.content.data.records.filter(entry => entry.key === 'authority'));
  assert.equal(filtered.data.evaluation_status, first.selection.assertion.content.data.evaluation_status);
  assert.deepEqual(filtered.data.bindings, first.selection.assertion.content.data.bindings);
  const complete = view(f, canonical, canonical.prepare(f.context, pin(f, first)));
  assert.equal(complete.coverage.status, 'selected'); assert.deepEqual(complete.data, first.selection.assertion.content.data);
});

test('immutable origin and later Project pins retain independently typed exact historical and current rule material', t => {
  const f = readerFixture(t), canonical = helper(f), first = f.reader.refresh(f.context, f.request), values = records();
  values.authority.authority.update_rules = ['New selected authority rule.'];
  const second = f.reader.refresh(f.context, nextRequest(f, first, f.commitRecords(values)));
  const origin = view(f, canonical, canonical.prepare(f.context, pin(f, first, [])), []);
  const current = view(f, canonical, canonical.prepare(f.context, pin(f, second, [])), []);
  assert.equal(origin.status, 'historical'); assert.equal(current.status, 'current');
  assert.deepEqual(origin.data.records[0].record.authority.update_rules, ['Update selected contract first.']);
  assert.deepEqual(current.data.records[0].record.authority.update_rules, ['New selected authority rule.']);
  assert.notDeepEqual(origin.pin, current.pin);
  code(() => canonical.prepare(f.context, pin(f, first), { requireCurrent: true }), 'canonical_selection_mismatch');
  const activation = f.activation.get(f.context);
  f.activation.setEnabled(f.context, { enabled: false, expectedVersion: activation.version });
  renameSync(f.folder, `${f.folder}-removed`);
  assert.equal(view(f, canonical, canonical.prepare(f.context, pin(f, first))).status, 'historical');
});

test('null and incomplete selected coverage never claims absence of all Project rules', t => {
  const f = readerFixture(t), canonical = helper(f);
  const unavailable = view(f, canonical, canonical.prepare(f.context, null));
  assert.equal(unavailable.status, 'unavailable'); assert.equal(unavailable.coverage.status, 'unavailable');
  assert.equal(unavailable.data, null); assert.equal(unavailable.configured_record_keys.length, 8);
  const first = f.reader.refresh(f.context, f.request);
  unlinkSync(join(f.folder, '.vibehub/constraint.yaml'));
  git(f.folder, 'add', '.'); git(f.folder, 'commit', '-m', 'selected missing synthetic constraint');
  const second = f.reader.refresh(f.context, nextRequest(f, first, git(f.folder, 'rev-parse', 'HEAD')));
  const partial = view(f, canonical, canonical.prepare(f.context, pin(f, second)));
  assert.equal(partial.status, 'current'); assert.equal(partial.coverage.status, 'partial');
  assert.equal(partial.data.records.find(entry => entry.key === 'constraint').record, null);
  assert.deepEqual(partial.authority_record_keys, ['authority']);
});

test('current source-fence and ACL checks suppress the entire captured material after revocation', t => {
  const f = readerFixture(t), canonical = helper(f), first = f.reader.refresh(f.context, f.request);
  const proof = canonical.prepare(f.context, pin(f, first));
  assert.equal(view(f, canonical, proof).status, 'current');
  f.ingress.updateSourceAccess(f.context, { registration_id: f.source.registration_id, expectedVersion: f.source.version,
    access: { ...f.source.registration.access, allowed_principal_ids: [] } });
  code(() => view(f, canonical, proof), 'stale_invalidation_fence');
  code(() => canonical.material(proof), 'exploration_canonical_unchecked');
  const quarantined = canonical.prepare(f.context, pin(f, first));
  assert.equal(canonical.status(quarantined), 'quarantined');
  const hidden = view(f, canonical, quarantined);
  assert.equal(hidden.data, null); assert.deepEqual(hidden.canonical_refs, []);
  assert.deepEqual(hidden.authority_record_keys, []); assert.equal(hidden.coverage.status, 'unavailable');
  assert(!JSON.stringify(hidden).includes('Update selected contract first.'));
  code(() => canonical.prepare(f.context, pin(f, first), { requireCurrent: true }), 'stale_invalidation_fence');
});

test('final transaction check uses direct getters and detects a canonical head changed since real reader preparation', t => {
  const f = readerFixture(t), canonical = helper(f), first = f.reader.refresh(f.context, f.request);
  const proof = canonical.prepare(f.context, pin(f, first));
  const snapshot = f.store.readSnapshot.bind(f.store), originalResolve = CanonicalSourceReader.prototype.resolve;
  let reads = 0, ranges = 0;
  const getSource = f.store.getSource.bind(f.store), getRecord = f.store.getRecord.bind(f.store), getRange = f.store.getSourceRange.bind(f.store);
  f.store.getSource = (...args) => { reads++; return getSource(...args); };
  f.store.getRecord = (...args) => { reads++; return getRecord(...args); };
  f.store.getSourceRange = (...args) => { ranges++; return getRange(...args); };
  CanonicalSourceReader.prototype.resolve = () => { throw new Error('Nested reader call'); };
  f.store.readSnapshot = () => { throw new Error('Nested database snapshot'); };
  try { assert.equal(view(f, canonical, proof, null, snapshot).status, 'current'); }
  finally { f.store.readSnapshot = snapshot; CanonicalSourceReader.prototype.resolve = originalResolve; }
  assert(reads < 400, `bounded selected getters: ${reads}`); assert(ranges < 40, `bounded selected ranges: ${ranges}`);
  const values = records(); values.decision.summary = 'Changed synthetic decision';
  f.reader.refresh(f.context, nextRequest(f, first, f.commitRecords(values)));
  code(() => view(f, canonical, proof), 'canonical_graph_changed');
  code(() => canonical.material(proof), 'exploration_canonical_unchecked');
});

test('canonical configuration is copied, sorted and inert; exact pins and private proofs cannot be forged', t => {
  const f = readerFixture(t), configured = structuredClone(config(f)); configured.selection.records.reverse();
  const canonical = helper(f, configured), expected = helper(f).config_digest;
  assert.equal(canonical.config_digest, expected);
  configured.selection.records[0].key = 'changed'; configured.execution.worktree_id = 'changed';
  assert.equal(canonical.config_digest, expected);
  let invoked = false;
  const poison = {}; Object.defineProperty(poison, 'repository_path', { enumerable: true, get() { invoked = true; return f.folder; } });
  assert.throws(() => helper(f, poison));
  assert.throws(() => helper(f, new Proxy({}, { getPrototypeOf() { invoked = true; return Object.prototype; } })));
  assert.equal(invoked, false);
  const first = f.reader.refresh(f.context, f.request), selected = pin(f, first);
  code(() => canonical.pin({ ...selected, record_keys: ['unknown'] }), 'canonical_selection_mismatch');
  code(() => canonical.pin({ ...selected, record_keys: ['authority', 'authority'] }), 'invalid_canonical_reader_input');
  code(() => canonical.pin({ ...selected, record_keys: Array(17).fill('authority') }), 'invalid_canonical_reader_input');
  code(() => canonical.pin({ ...selected, address: { ...selected.address, kind: 'semantic_entity' } }), 'invalid_canonical_reader_input');
  code(() => canonical.material({ status: 'current', selection: first.selection }), 'invalid_exploration_canonical_proof');
  const proof = canonical.prepare(f.context, selected), other = helper(f);
  code(() => other.summary(proof), 'invalid_exploration_canonical_proof');
  const wrongActor = f.issue({ principal: 'reader', actions: READER_ACTIONS }).context;
  let caught;
  f.store.readSnapshot(wrongActor, tx => { try { canonical.assert(tx, wrongActor, proof); } catch (error) { caught = error; } });
  assert.equal(caught.code, 'invalid_exploration_canonical_proof');
  code(() => canonical.material(proof), 'exploration_canonical_unchecked');
});

test('plausible canonical Graph JSON without a matching retained reader issuance cannot become shared authority', t => {
  const f = readerFixture(t), canonical = helper(f), first = f.reader.refresh(f.context, f.request);
  const assertion = structuredClone(first.selection.assertion);
  assertion.assertion_id = 'forged-reader-assertion'; assertion.base_revision = first.address;
  assertion.content.data.records.find(entry => entry.key === 'authority').record.authority.update_rules = ['Forged local rule.'];
  const forged = f.graph.mutate(f.context, mutation(f, first.graph_revision, assertion));
  assert.equal(forged.status, 'applied');
  code(() => canonical.prepare(f.context, { at: forged.receipt.next_graph, address: forged.revision, record_keys: ['authority'] }), 'canonical_selection_mismatch');
});

test('inactive or unusable Authority records retain evaluator status without being elevated by a key filter', t => {
  const f = readerFixture(t), canonical = helper(f), first = f.reader.refresh(f.context, f.request), values = records();
  values.authority.state = 'superseded';
  writeRecords(f.folder, values); git(f.folder, 'add', '.'); git(f.folder, 'commit', '-m', 'historical synthetic authority');
  const second = f.reader.refresh(f.context, nextRequest(f, first, git(f.folder, 'rev-parse', 'HEAD')));
  const material = view(f, canonical, canonical.prepare(f.context, pin(f, second, [])), []);
  assert.deepEqual(material.authority_record_keys, []); assert.deepEqual(material.data.records, []);
  assert.equal(material.coverage.status, 'partial');
});
