import test from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { CanonicalSourceReader } from '../src/application/sources/canonical-source-reader.mjs';
import { GitProvenance } from '../src/adapters/git-provenance.mjs';
import { readerFixture, records, writeRecords, makeReader, git, digest, READER_ACTIONS } from './helpers/canonical-reader-fixture.mjs';
import { exactRevisionAddress } from '../src/core/working-graph.mjs';

const code = (operation, expected) => assert.throws(operation, error => error.code === expected);
const head = f => f.graph.getHead(f.context, { generation_id: f.request.expected_graph.generation_id }).graph_revision;
const nextRequest = (f, prior, commit, changes = {}) => ({ ...f.request, idempotency_key: 'next-selection', commit_oid: commit,
  expected_graph: prior.graph_revision, previous_selection: prior.selection,
  observation: { ...f.request.observation, sequence_start: f.selection.records.length }, ...changes });
const lookup = (selection, key) => selection.assertion.content.data.records.find(e => e.key === key);

test('canonical reader uses real immutable ingress and one Graph mutation; restart and exact retry retain selected citations', t => {
  const f = readerFixture(t), before = head(f), result = f.reader.refresh(f.context, f.request);
  assert.equal(result.status, 'applied'); assert.notDeepEqual(head(f), before); assert.equal(result.selection.assertion.parents.length, 0);
  assert.equal(result.selection.assertion.canonical_refs.length, 8); assert.equal(result.selection.provenance.events.length, 8);
  assert.equal(result.selection.assertion.content.data.source_watermark.completion, 'unknown');
  assert.equal(lookup(result.selection, 'outcome').record.status, 'successful');
  assert.equal(f.ingress.listPending(f.context, { limit: 64 }).length, 8);
  assert.equal(f.reader.resolve(f.context, { at: result.graph_revision, address: result.address }).status, 'current');
  const reopened = f.reopen(); reopened.context = reopened.issue({ actions: READER_ACTIONS }).context;
  Object.assign(reopened, { folder: f.folder, execution: f.execution, source: f.source, selection: f.selection });
  const reader = makeReader(reopened), duplicate = reader.refresh(reopened.context, f.request);
  assert.equal(duplicate.status, 'duplicate'); assert.deepEqual(duplicate.receipt, result.receipt);
  assert.deepEqual(reader.resolve(reopened.context, { at: result.graph_revision, address: result.address }).selection, result.selection);
});

test('changed valid selected records refresh together, deletion is a path tombstone and old citations remain exact', t => {
  const f = readerFixture(t), first = f.reader.refresh(f.context, f.request), values = records();
  values.room.stale = true; values.room.stale_reason = 'Observed source drift'; values.decision.summary = 'Changed selected decision';
  writeRecords(f.folder, values); unlinkSync(join(f.folder, '.vibehub/constraint.yaml'));
  git(f.folder, 'add', '.'); git(f.folder, 'commit', '-m', 'selected deletion and change');
  const second = f.reader.refresh(f.context, nextRequest(f, first, git(f.folder, 'rev-parse', 'HEAD')));
  assert.equal(second.status, 'applied'); assert.equal(lookup(second.selection, 'decision').record.summary, values.decision.summary);
  assert.equal(lookup(second.selection, 'constraint').record, null);
  assert.equal(lookup(second.selection, 'authority').record.type, 'authority');
  assert.equal(second.selection.assertion.events.filter(e => e.payload.path === null).length, 1);
  assert.equal(second.selection.assertion.events.some(e => e.event_type === 'SOURCE_TOMBSTONE'), false);
  const historical = f.reader.resolve(f.context, { at: first.graph_revision, address: first.address });
  assert.equal(historical.status, 'historical'); assert.equal(lookup(historical.selection, 'constraint').record.type, 'constraint');
});

test('a successful committed retry needs no Git reads after disable; new refresh requires activation', t => {
  const f = readerFixture(t), first = f.reader.refresh(f.context, f.request);
  const state = f.activation.get(f.context); f.activation.setEnabled(f.context, { enabled: false, expectedVersion: state.version });
  renameSync(f.folder, `${f.folder}-removed`);
  const duplicate = f.reader.refresh(f.context, f.request); assert.equal(duplicate.status, 'duplicate'); assert.deepEqual(duplicate.receipt, first.receipt);
  code(() => f.reader.refresh(f.context, nextRequest(f, first, f.commit)), 'project_disabled');
});

test('changed idempotency pins reject before new Git reads or effects', t => {
  const f = readerFixture(t), first = f.reader.refresh(f.context, f.request), before = head(f);
  code(() => f.reader.refresh(f.context, { ...f.request, observation: { ...f.request.observation, sequence_start: 200 } }), 'canonical_idempotency_conflict');
  assert.deepEqual(head(f), before); assert.equal(f.ingress.listPending(f.context, { limit: 64 }).length, 8);
  assert.equal(first.status, 'applied');
});

test('source policy changes quarantine typed exact reads and successful receipt retry', t => {
  const f = readerFixture(t), first = f.reader.refresh(f.context, f.request);
  f.ingress.updateSourceAccess(f.context, { registration_id: f.source.registration_id, expectedVersion: f.source.version,
    access: { ...f.source.registration.access, enabled: false } });
  assert.equal(f.reader.resolve(f.context, { at: first.graph_revision, address: first.address }).status, 'quarantined');
  code(() => f.reader.refresh(f.context, f.request), 'stale_invalidation_fence');
});

test('a divergent commit does not advance a selection, but an independently selected view can read it', t => {
  const f = readerFixture(t), first = f.reader.refresh(f.context, f.request), ancestor = git(f.folder, 'rev-parse', 'HEAD^');
  git(f.folder, 'checkout', '-b', 'divergent', ancestor); writeRecords(f.folder, records());
  mkdirSync(join(f.folder, 'src'), { recursive: true }); writeFileSync(join(f.folder, 'src/api.mjs'), 'export const divergent = true;\n');
  git(f.folder, 'add', '.'); git(f.folder, 'commit', '-m', 'synthetic divergent records'); const commit = git(f.folder, 'rev-parse', 'HEAD');
  const before = head(f), result = f.reader.refresh(f.context, nextRequest(f, first, commit));
  assert.equal(result.status, 'not_advanced'); assert.deepEqual(head(f), before);
  const selected = makeReader(f, { ...f.selection, selection_id: 'explicit-divergent-view' });
  const separate = selected.refresh(f.context, { ...nextRequest(f, first, commit), previous_selection: null });
  assert.equal(separate.status, 'applied'); assert.notEqual(separate.selection.entity_id, first.selection.entity_id);
});

test('unsupported JSON-as-YAML forms project explicit no-content states', t => {
  const f = readerFixture(t), first = f.reader.refresh(f.context, f.request);
  writeFileSync(join(f.folder, '.vibehub/decision.yaml'), 'kind: context\ncontext_id: choice\n');
  writeFileSync(join(f.folder, '.vibehub/constraint.yaml'), '{"kind":"context","kind":"context"}');
  git(f.folder, 'add', '.'); git(f.folder, 'commit', '-m', 'unsupported selected forms');
  const second = f.reader.refresh(f.context, nextRequest(f, first, git(f.folder, 'rev-parse', 'HEAD')));
  assert.equal(second.status, 'applied'); assert.equal(lookup(second.selection, 'decision').record, null); assert.equal(lookup(second.selection, 'constraint').record, null);
});

test('record configuration bounds and getters are rejected without executing them', t => {
  const f = readerFixture(t); let invoked = false;
  const config = { ...f.selection, records: [...f.selection.records, ...Array.from({ length: 9 }, (_, i) => ({ key: `extra-${i}`, kind: 'context', id: `extra-${i}`, path: `extra-${i}.yaml` }))] };
  code(() => makeReader(f, config), 'canonical_capacity');
  const poisoned = { ...f.request }; Object.defineProperty(poisoned, 'commit_oid', { enumerable: true, get() { invoked = true; return f.commit; } });
  code(() => f.reader.refresh(f.context, poisoned), 'invalid_canonical_reader_input'); assert.equal(invoked, false);
});

function tombstone(f, selection) {
  const source = f.ingress.getRegistration(f.context, { registration_id: f.source.registration_id });
  const object = selection.assertion.events[0].payload.object, retryKey = 'explicit-old-object-tombstone';
  const acl = { revision: 'guard-1', allowed_principal_ids: ['owner', 'reader'] };
  const event = { schema_version: 1, kind: 'raw_event',
    event_id: f.ingress.eventIdFor(f.context, { registration_id: source.registration_id, idempotency_key: retryKey }),
    partition: source.registration.partition, source_native_event_id: retryKey, idempotency_key: retryKey, source_event_type: 'tombstone',
    occurred_at: null, observed_at: '2026-09-22T12:10:00.000Z', producer: { ...source.registration.producer, sequence: f.selection.records.length },
    causal_parents: [], identity: f.execution, payload: { kind: 'git_revision', object, path: null, digest: selection.assertion.content.data.source_proofs[0].raw_commit_digest },
    provenance: { delivery: { channel: 'local_git', delivery_id: retryKey }, source_objects: [{ object, acl, sensitivity: 'normal' }] }, acl, sensitivity: 'normal' };
  return f.ingress.submitSourceLifecycle(f.context, { registration_id: source.registration_id, epoch: f.epoch, expectedVersion: source.version,
    event, access_state: 'tombstoned', access: null });
}

test('a retained prior proof permits a new allowed descendant after its old commit source is revoked', t => {
  const f = readerFixture(t), first = f.reader.refresh(f.context, f.request), values = records();
  values.decision.detail = 'A new authorized version'; const commit = f.commitRecords(values); tombstone(f, first.selection);
  assert.equal(f.reader.resolve(f.context, { at: first.graph_revision, address: first.address }).status, 'quarantined');
  const next = nextRequest(f, first, commit, { observation: { ...f.request.observation, sequence_start: 9 } });
  const second = f.reader.refresh(f.context, next); assert.equal(second.status, 'applied');
  assert.equal(lookup(second.selection, 'decision').record.detail, values.decision.detail);
  assert.equal(second.selection.assertion.parents.length, 0); assert.equal(second.selection.provenance.events.length, 8);
});

test('a source access change during Git reads rejects without publishing or returning source text', t => {
  const f = readerFixture(t), before = head(f), original = GitProvenance.prototype.readFileAtCommit;
  let changed = false;
  GitProvenance.prototype.readFileAtCommit = function (options) {
    const result = original.call(this, options);
    if (!changed) { changed = true; f.ingress.updateSourceAccess(f.context, { registration_id: f.source.registration_id, expectedVersion: f.source.version,
      access: { ...f.source.registration.access, allowed_principal_ids: [] } }); }
    return result;
  };
  try { assert.throws(() => f.reader.refresh(f.context, f.request), e => ['source_access_denied', 'stale_invalidation_fence'].includes(e.code)); }
  finally { GitProvenance.prototype.readFileAtCommit = original; }
  assert.deepEqual(head(f), before);
});

test('a partial ingress attempt reuses exact receipts and still has a single atomic Graph publication', t => {
  const f = readerFixture(t), before = head(f);
  // Trusted test fault after two successful durable admissions; no production hook.
  const ctor = f.ingress.constructor, original = ctor.prototype.submit; let count = 0;
  ctor.prototype.submit = function (...args) { if (++count === 3) throw Object.assign(new Error('selected synthetic fault'), { code: 'store_unavailable' }); return original.apply(this, args); };
  try { code(() => f.reader.refresh(f.context, f.request), 'store_unavailable'); }
  finally { ctor.prototype.submit = original; }
  assert.deepEqual(head(f), before); assert.equal(f.ingress.listPending(f.context, { limit: 64 }).length, 2);
  const result = f.reader.refresh(f.context, f.request); assert.equal(result.status, 'applied');
  assert.equal(f.ingress.listPending(f.context, { limit: 64 }).length, 8); assert.equal(result.selection.provenance.events.length, 8);
});

test('sixteen selected records are bounded independently of a thousand unrelated files', t => {
  const values = records();
  for (let i = 0; i < 8; i++) values[`extra-${i}`] = { ...values.decision, context_id: `extra-${i}` };
  const f = readerFixture(t, { values }); mkdirSync(join(f.folder, 'unrelated'));
  for (let i = 0; i < 1000; i++) writeFileSync(join(f.folder, 'unrelated', `${i}.txt`), 'Unselected synthetic data.');
  git(f.folder, 'add', '.'); git(f.folder, 'commit', '-m', 'large unrelated tree');
  const result = f.reader.refresh(f.context, { ...f.request, commit_oid: git(f.folder, 'rev-parse', 'HEAD'), observation: { ...f.request.observation, sequence_start: null } });
  assert.equal(result.status, 'applied'); assert.equal(result.selection.assertion.content.data.records.length, 16);
  assert.equal(result.metrics.selected_paths, 17); assert(result.metrics.commands <= 64);
  assert(result.selection.assertion.content.data.source_watermark.positions.every(p => p.sequence === null));
  const tooMany = { ...f.selection, records: [...f.selection.records, { key: 'seventeenth', kind: 'context', id: 'seventeenth', path: '.vibehub/seventeenth.yaml' }] };
  code(() => makeReader(f, tooMany), 'canonical_capacity');
});

test('record and same-commit artifact selection permits exactly thirty-two unique paths', t => {
  const authority = records().authority;
  authority.authority.canonical = Array.from({ length: 31 }, (_, i) => `src/artifact-${i}.mjs`);
  const f = readerFixture(t, { values: { authority } });
  for (const path of authority.authority.canonical) writeFileSync(join(f.folder, path), 'export const synthetic = true;');
  git(f.folder, 'add', '.'); git(f.folder, 'commit', '-m', 'bounded artifact closure');
  const first = f.reader.refresh(f.context, { ...f.request, commit_oid: git(f.folder, 'rev-parse', 'HEAD') });
  assert.equal(first.status, 'applied'); assert.equal(first.metrics.selected_paths, 32);
  authority.authority.canonical.push('src/thirty-third.mjs');
  const commit = f.commitRecords({ authority }), before = head(f);
  code(() => f.reader.refresh(f.context, nextRequest(f, first, commit)), 'canonical_capacity');
  assert.deepEqual(head(f), before); assert.equal(f.ingress.listPending(f.context, { limit: 64 }).length, 1);
});

test('per-record and aggregate byte limits reject before any ingress or Graph publication', t => {
  const values = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`large-${i}`, { ...records().decision, context_id: `large-${i}`, detail: 'x'.repeat(60000) }]));
  const f = readerFixture(t, { values }), before = head(f);
  code(() => f.reader.refresh(f.context, f.request), 'canonical_capacity');
  assert.deepEqual(head(f), before); assert.equal(f.ingress.listPending(f.context, { limit: 64 }).length, 0);
  values['large-0'].detail = 'x'.repeat(66000); const commit = f.commitRecords(values);
  code(() => f.reader.refresh(f.context, { ...f.request, commit_oid: commit }), 'canonical_capacity');
  assert.deepEqual(head(f), before); assert.equal(f.ingress.listPending(f.context, { limit: 64 }).length, 0);
});

test('generic Graph writes cannot impersonate issued canonical data or replace a retained prior proof', t => {
  const f = readerFixture(t), first = f.reader.refresh(f.context, f.request);
  let expected = first.graph_revision;
  for (const missingProof of [true, false]) {
    const forged = structuredClone(first.selection.assertion);
    forged.assertion_id = missingProof ? 'forged-without-proof' : 'forged-changed-digest';
    forged.base_revision = first.address;
    forged.content.data.records.find(e => e.key === 'decision').record.detail = 'Generic Graph input, never verified from Git.';
    if (missingProof) forged.content.data.request_digest = `sha256:${'d'.repeat(64)}`;
    const publication = f.graph.mutate(f.context, { epoch: f.epoch, publisher_ref: f.publisher.publisher_ref,
      expected_graph: expected, idempotency_key: forged.assertion_id, operation: { kind: 'assert', assertion: forged }, coverage: null });
    expected = publication.receipt.next_graph;
    code(() => f.reader.resolve(f.context, { at: expected, address: publication.revision }), 'canonical_selection_mismatch');
    const forgedRevision = f.graph.resolve(f.context, { at: expected, address: publication.revision }).revision;
    code(() => f.reader.refresh(f.context, { ...f.request, expected_graph: expected, previous_selection: forgedRevision,
      idempotency_key: forged.assertion_id }), 'canonical_selection_mismatch');
  }
});

test('existing Graph and storage capacity limits leave admitted facts but never a new selection', t => {
  const values = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`large-${i}`, { ...records().decision,
    context_id: `large-${i}`, tags: Array.from({ length: 1500 }, (_, tag) => `tag-${tag}`) }]));
  const f = readerFixture(t, { values }), before = head(f);
  writeRecords(f.folder, Object.fromEntries(Object.entries(values).map(([key, value]) => [key, JSON.stringify(value)])));
  git(f.folder, 'add', '.'); git(f.folder, 'commit', '-m', 'compact bounded records exceed graph node plan');
  f.request.commit_oid = git(f.folder, 'rev-parse', 'HEAD');
  assert.throws(() => f.reader.refresh(f.context, f.request), error => ['graph_capacity', 'graph_plan_rejected', 'invalid_store_input'].includes(error.code));
  assert.deepEqual(head(f), before); assert.equal(f.ingress.listPending(f.context, { limit: 64 }).length, 16);
});

test('re-enable uses a fresh epoch and publisher while old pinned requests cannot be relabeled', t => {
  const f = readerFixture(t, { values: { decision: records().decision } }), first = f.reader.refresh(f.context, f.request);
  const enabled = f.activation.get(f.context);
  const disabled = f.activation.setEnabled(f.context, { enabled: false, expectedVersion: enabled.version });
  const active = f.activation.setEnabled(f.context, { enabled: true, expectedVersion: disabled.version });
  const publisher = f.graph.registerPublisherRun(f.context, { epoch: active.state.epoch, run_key: 'reader-re-enabled' });
  code(() => f.reader.refresh(f.context, { ...f.request, epoch: active.state.epoch, publisher_ref: publisher }), 'canonical_idempotency_conflict');
  code(() => f.reader.refresh(f.context, nextRequest(f, first, f.commit)), 'stale_activation_epoch');
  const next = f.reader.refresh(f.context, nextRequest(f, first, f.commit, { epoch: active.state.epoch, publisher_ref: publisher }));
  assert.equal(next.status, 'applied'); assert.equal(next.selection.assertion.execution_id, publisher.execution_id);
  assert.notEqual(publisher.execution_id, f.publisher.execution_id);
});

test('refresh adopts changed Authority rules and appended Contract revisions while old acceptance remains historical', t => {
  const f = readerFixture(t), first = f.reader.refresh(f.context, f.request), values = records();
  const originalContract = structuredClone(values.ticket.contract_revisions[0]);
  const originalAcceptance = structuredClone(values.ticket.acceptance[0]);
  values.authority.authority.update_rules.push('Review the changed API contract before editing implementation.');
  values.authority.authority.validation = ['Run the selected revised contract check.'];
  values.ticket.acceptance[0].state = 'retired';
  const revised = { ...originalAcceptance, revision: 2, criterion: 'Synthetic revised behavior is verified.', state: 'active' };
  revised.identity = digest({ ticket_id: values.ticket.ticket_id, acceptance_id: revised.acceptance_id, revision: 2,
    criterion: revised.criterion, authority: revised.authority, derived_from: [] });
  values.ticket.acceptance.push(revised);
  const nextContract = { revision: 2, acceptance_revisions: values.ticket.acceptance.filter(a => a.state === 'active')
    .map(({ acceptance_id, revision, identity }) => ({ acceptance_id, revision, identity }))
    .sort((a, b) => a.acceptance_id.localeCompare(b.acceptance_id)) };
  nextContract.identity = digest({ ticket_id: values.ticket.ticket_id, revision: 2, acceptance_revisions: nextContract.acceptance_revisions });
  values.ticket.contract_revisions.push(nextContract); values.ticket.active_contract_revision = 2;
  const second = f.reader.refresh(f.context, nextRequest(f, first, f.commitRecords(values)));
  assert.equal(second.status, 'applied');
  assert.deepEqual(lookup(second.selection, 'authority').record.authority.update_rules, values.authority.authority.update_rules);
  assert.deepEqual(lookup(second.selection, 'authority').record.authority.validation, values.authority.authority.validation);
  const ticket = lookup(second.selection, 'ticket').record;
  assert.equal(ticket.active_contract_revision, 2); assert.deepEqual(ticket.contract_revisions[0], originalContract);
  assert.deepEqual(ticket.acceptance[0], { ...originalAcceptance, state: 'retired' });
  assert.deepEqual(ticket.contract_revisions[1], nextContract);
  const outcome = second.selection.assertion.content.data.bindings.find(binding => binding.kind === 'ticket_outcome');
  assert.equal(outcome.status, 'historical'); assert.equal(outcome.reason, 'outcome_contract_historical');
  const historical = f.reader.resolve(f.context, { at: first.graph_revision, address: first.address });
  assert.equal(historical.status, 'historical');
  assert.deepEqual(lookup(historical.selection, 'ticket').record.contract_revisions, [originalContract]);
  assert.equal(lookup(historical.selection, 'ticket').record.acceptance[0].state, 'active');
  assert.deepEqual(lookup(historical.selection, 'authority').record.authority.update_rules, records().authority.authority.update_rules);
});

test('a stale expected Graph rejects selection publication after bounded durable observation', t => {
  const f = readerFixture(t, { values: { decision: records().decision } }), first = f.reader.refresh(f.context, f.request);
  const decision = { ...records().decision, detail: 'Observed newer bytes from an explicitly selected commit.' };
  const proposed = nextRequest(f, first, f.commitRecords({ decision }), { expected_graph: f.genesis.receipt.next_graph });
  const result = f.reader.refresh(f.context, proposed);
  assert.equal(result.status, 'graph_revision_mismatch'); assert.deepEqual(result.graph_revision, first.graph_revision);
  assert.deepEqual(head(f), first.graph_revision); assert.equal(f.ingress.listPending(f.context, { limit: 64 }).length, 2);
  const retained = f.reader.resolve(f.context, { at: first.graph_revision, address: first.address });
  assert.equal(retained.status, 'current'); assert.equal(lookup(retained.selection, 'decision').record.detail, records().decision.detail);
});

test('rewind and incomplete ancestry fail closed through the reader without admitting new observations', t => {
  const f = readerFixture(t, { values: { decision: records().decision } }), first = f.reader.refresh(f.context, f.request);
  const rewind = f.reader.refresh(f.context, nextRequest(f, first, git(f.folder, 'rev-parse', `${f.commit}^`)));
  assert.equal(rewind.status, 'not_advanced'); assert.equal(rewind.reason, 'not_descendant');
  const rawPath = join(f.root, 'incomplete-commit.txt');
  writeFileSync(rawPath, `tree ${git(f.folder, 'rev-parse', `${f.commit}^{tree}`)}\nparent ${'e'.repeat(40)}\nauthor Synthetic Fixture <fixture@example.invalid> 1700000000 +0000\ncommitter Synthetic Fixture <fixture@example.invalid> 1700000000 +0000\n\nSynthetic missing ancestry.\n`);
  const incomplete = git(f.folder, 'hash-object', '-w', '-t', 'commit', rawPath);
  const missing = f.reader.refresh(f.context, nextRequest(f, first, incomplete, { idempotency_key: 'incomplete-ancestry' }));
  assert.equal(missing.status, 'not_advanced'); assert.equal(missing.reason, 'unavailable');
  assert.deepEqual(head(f), first.graph_revision); assert.equal(f.ingress.listPending(f.context, { limit: 64 }).length, 1);
  assert.equal(f.reader.resolve(f.context, { at: first.graph_revision, address: first.address }).status, 'current');
});

test('retained typed historical and current selections survive actual source Git garbage collection', t => {
  const f = readerFixture(t, { values: { decision: records().decision } }), first = f.reader.refresh(f.context, f.request);
  const decision = { ...records().decision, detail: 'Selected newer synthetic decision.' };
  const secondCommit = f.commitRecords({ decision }), second = f.reader.refresh(f.context, nextRequest(f, first, secondCommit));
  git(f.folder, 'checkout', '--orphan', 'replacement-root'); git(f.folder, 'rm', '-rf', '.');
  writeFileSync(join(f.folder, 'replacement.txt'), 'Unrelated replacement source tree.');
  git(f.folder, 'add', '.'); git(f.folder, 'commit', '-m', 'unrelated replacement root');
  git(f.folder, 'branch', '-D', 'main'); git(f.folder, 'reflog', 'expire', '--expire=now', '--all'); git(f.folder, 'gc', '--prune=now');
  assert.throws(() => git(f.folder, 'cat-file', '-e', `${f.commit}^{commit}`));
  assert.throws(() => git(f.folder, 'cat-file', '-e', `${secondCommit}^{commit}`));
  const historical = f.reader.resolve(f.context, { at: first.graph_revision, address: first.address });
  const current = f.reader.resolve(f.context, { at: second.graph_revision, address: second.address });
  assert.equal(historical.status, 'historical'); assert.deepEqual(historical.selection, first.selection);
  assert.equal(current.status, 'current'); assert.deepEqual(current.selection, second.selection);
  const unavailable = f.reader.refresh(f.context, nextRequest(f, second, secondCommit, { idempotency_key: 'gc-new-refresh',
    observation: { ...f.request.observation, sequence_start: 2 } }));
  assert.equal(unavailable.status, 'not_advanced'); assert.equal(unavailable.reason, 'unavailable');
  assert.deepEqual(head(f), second.graph_revision); assert.equal(f.ingress.listPending(f.context, { limit: 64 }).length, 2);
});
