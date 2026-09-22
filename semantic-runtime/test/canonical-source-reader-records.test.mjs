import test from 'node:test';
import assert from 'node:assert/strict';
import { CANONICAL_RECORD_PROFILE, parseCanonicalRecord,
  evaluateCanonicalRecords } from '../src/core/canonical-records.mjs';

const WORKS_IDENTITY = 'sha256:008835b1bf673139d7651cd6539973c892915a4beb98663e3f6e234a790e0aed';
const WORKS_V2_IDENTITY = 'sha256:709165d9accd2779bf6c216d738a3223e33c8ee845fd18ed2db0f0773af96990';
const HUMAN_IDENTITY = 'sha256:0e01b5e6512e0c95709d7dacbb4f7b8a4670df1cccdf6c17754ccd6dcd582b37';
const CONTRACT_IDENTITY = 'sha256:d623d0c2b3db54e241086652e487a7b3a47a1a9faef20cb245acb04c0783f3db';
const CONTRACT_V2_IDENTITY = 'sha256:226b8fd9c5b91daca71a331e804f34ee4b9b541617083ffd5bba0e0136a065d9';
const clone = value => JSON.parse(JSON.stringify(value));

function context(context_id = 'decision-static', type = 'decision') {
  return { schema_version: 1, kind: 'context', context_id, type, state: 'active', summary: 'Static summary.',
    detail: 'Static detail 😀.', tags: ['synthetic'], source: { ref: 'conversation:synthetic', captured_at: '2026-09-22T00:00:00.000Z' },
    evidence: [{ ref: 'conversation:synthetic', note: 'Selected synthetic evidence.' }], relations: [] };
}
function authority() {
  return { ...context('authority-static', 'authority'), authority: { governs: ['src/core'], canonical: ['docs/policy.md'],
    update_rules: ['Update the selected artifact first.'], validation: ['Run the selected synthetic check.'], approval: 'human' } };
}
function room() {
  return { schema_version: 1, kind: 'room', room_id: 'room-static', description: 'Synthetic room.',
    boundary: 'Selected test records only.', anchors: ['src/core'], stale: true, stale_reason: 'Synthetic drift claim.' };
}
function ticketRecord({ advanced = false } = {}) {
  const acceptance = [
    { acceptance_id: 'works', revision: 1, identity: WORKS_IDENTITY, criterion: 'Works.', state: advanced ? 'retired' : 'active' },
    { acceptance_id: 'owner-approves', revision: 1, identity: HUMAN_IDENTITY,
      criterion: 'Owner approves.', authority: 'human', state: 'active' },
  ];
  if (advanced) acceptance.push({ acceptance_id: 'works', revision: 2, identity: WORKS_V2_IDENTITY,
    criterion: 'Works better.', state: 'active' });
  const contractRevisions = [{ revision: 1, identity: CONTRACT_IDENTITY,
    acceptance_revisions: [
      { acceptance_id: 'owner-approves', revision: 1, identity: HUMAN_IDENTITY },
      { acceptance_id: 'works', revision: 1, identity: WORKS_IDENTITY },
    ] }];
  if (advanced) contractRevisions.push({ revision: 2, identity: CONTRACT_V2_IDENTITY,
    acceptance_revisions: [
      { acceptance_id: 'owner-approves', revision: 1, identity: HUMAN_IDENTITY },
      { acceptance_id: 'works', revision: 2, identity: WORKS_V2_IDENTITY },
    ] });
  return { schema_version: 3, kind: 'ticket', ticket_id: 'ticket-static-profile', revision_state: 'bound',
    active_contract_revision: advanced ? 2 : 1, contract_revisions: contractRevisions,
    outcome: 'Prove the static public profile.', deliveries: [], context: 'Synthetic selected context.',
    acceptance, constraints: [], context_refs: [], relations: [], provenance_refs: ['synthetic:fixture'] };
}
function evidence(evidence_id, acceptance_id, identity, origin = 'agent') {
  return { schema_version: 2, kind: 'ticket_evidence', evidence_id, ticket_id: 'ticket-static-profile',
    acceptance_ids: [acceptance_id], binding_state: 'bound', binding_origin: 'native',
    acceptance_revisions: [{ acceptance_id, revision: 1, identity }], summary: 'Static evidence.',
    refs: [origin === 'human' ? 'conversation:explicit-owner-input' : 'test:static-vector'], origin,
    recorded_at: '2026-09-22T01:00:00.000Z' };
}
function outcome(status = 'successful') {
  const successful = status === 'successful';
  return { schema_version: 2, kind: 'ticket_outcome', outcome_id: 'contract-v1', ticket_id: 'ticket-static-profile',
    binding_state: 'bound', binding_origin: 'native', contract_revision: { revision: 1, identity: CONTRACT_IDENTITY },
    status, accepted_acceptance_ids: successful ? ['works', 'owner-approves'] : ['works'],
    unresolved_acceptance_ids: successful ? [] : ['owner-approves'],
    evidence_ids: successful ? ['evidence-works', 'evidence-owner'] : ['evidence-works'],
    summary: 'Static independent adjudication.', closed_at: '2026-09-22T02:00:00.000Z',
    independence: { source: 'subagent', note: 'A checked-in claim, not authenticated identity.' } };
}
function parse(record, kind, id) { return parseCanonicalRecord(JSON.stringify(record), { kind, id }); }
function selected(key, path, kind, id, result) { return { key, path, kind, id, result }; }
function closure({ humanOrigin = 'human', outcomeStatus = 'successful' } = {}) {
  const records = [
    selected('decision', '.vibehub/rooms/static/decision-static.yaml', 'context', 'decision-static', parse(context(), 'context', 'decision-static')),
    selected('authority', '.vibehub/rooms/static/authority-static.yaml', 'context', 'authority-static', parse(authority(), 'context', 'authority-static')),
    selected('room', '.vibehub/rooms/static/room.yaml', 'room', 'room-static', parse(room(), 'room', 'room-static')),
    selected('ticket', '.vibehub/tickets/ticket-static-profile.yaml', 'ticket', 'ticket-static-profile',
      parse(ticketRecord(), 'ticket', 'ticket-static-profile')),
    selected('proof', '.vibehub/evidence/ticket-static-profile/evidence-works.yaml', 'ticket_evidence', 'evidence-works',
      parse(evidence('evidence-works', 'works', WORKS_IDENTITY), 'ticket_evidence', 'evidence-works')),
    selected('owner-proof', '.vibehub/evidence/ticket-static-profile/evidence-owner.yaml', 'ticket_evidence', 'evidence-owner',
      parse(evidence('evidence-owner', 'owner-approves', HUMAN_IDENTITY, humanOrigin), 'ticket_evidence', 'evidence-owner')),
    selected('outcome', '.vibehub/outcomes/ticket-static-profile/contract-v1.yaml', 'ticket_outcome', 'contract-v1',
      parse(outcome(outcomeStatus), 'ticket_outcome', 'contract-v1')),
  ];
  return records;
}

test('strict JSON-as-YAML parser accepts the public versions and binds selected kind and ID', () => {
  const vectors = [
    [context(), 'context', 'decision-static'], [authority(), 'context', 'authority-static'], [room(), 'room', 'room-static'],
    [ticketRecord(), 'ticket', 'ticket-static-profile'],
    [evidence('evidence-works', 'works', WORKS_IDENTITY), 'ticket_evidence', 'evidence-works'],
    [outcome(), 'ticket_outcome', 'contract-v1'],
  ];
  for (const [record, kind, id] of vectors) {
    const result = parse(record, kind, id);
    assert.equal(result.status, 'valid'); assert.equal(result.reason, null); assert.equal(result.record.kind, kind);
    assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.record));
  }
  const utf8 = parseCanonicalRecord(Buffer.from(JSON.stringify(context())), { kind: 'context', id: 'decision-static' });
  assert.equal(utf8.status, 'valid'); assert.match(utf8.record.detail, /😀/u);
});

test('parser rejects ambiguous bytes, duplicate keys, malformed JSON and non-inert options without diagnostics', () => {
  const duplicate = '{"schema_version":1,"kind":"context","kind":"context"}';
  assert.equal(parseCanonicalRecord(duplicate, { kind: 'context', id: 'decision-static' }).reason, 'duplicate_json_key');
  assert.equal(parseCanonicalRecord(Buffer.from([0xc3, 0x28]), { kind: 'context', id: 'decision-static' }).reason, 'invalid_utf8');
  assert.equal(parseCanonicalRecord('{"schema_version":NaN}', { kind: 'context', id: 'decision-static' }).reason, 'invalid_json');
  assert.equal(parseCanonicalRecord('schema_version: 1\nkind: context\n', { kind: 'context', id: 'decision-static' }).status,
    'unsupported');
  assert.equal(parseCanonicalRecord('{"value":"\ud800"}', { kind: 'context', id: 'decision-static' }).reason, 'invalid_utf8');
  const impossibleDate = context(); impossibleDate.source.captured_at = '2026-02-30T00:00:00Z';
  assert.equal(parse(impossibleDate, 'context', 'decision-static').reason, 'invalid_schema');
  let ran = false;
  const hostile = Object.defineProperty({ kind: 'context', id: 'decision-static' }, 'extra', {
    enumerable: true, get() { ran = true; return 'no'; },
  });
  assert.equal(parseCanonicalRecord('{}', hostile).reason, 'invalid_input'); assert.equal(ran, false);
  const proxy = new Proxy({}, { getPrototypeOf() { ran = true; throw new Error('CANARY'); } });
  assert.equal(parseCanonicalRecord('{}', proxy).reason, 'invalid_input'); assert.equal(ran, false);
  const nested = new Proxy({}, { get() { ran = true; throw new Error('NESTED_CANARY'); } });
  const nestedResult = parseCanonicalRecord('{}', { kind: nested, id: 'decision-static' });
  assert.equal(nestedResult.reason, 'invalid_input'); assert.equal(nestedResult.kind, null); assert.equal(ran, false);
});

test('schema versions, unknown fields, selected identity and unsupported bindings remain explicit', () => {
  const future = context(); future.schema_version = 2;
  assert.deepEqual(parse(future, 'context', 'decision-static').status, 'unsupported');
  const extra = context(); extra.unknown = true;
  assert.equal(parse(extra, 'context', 'decision-static').reason, 'invalid_schema');
  assert.equal(parse(context(), 'context', 'other-context').reason, 'selected_id_mismatch');
  assert.equal(parseCanonicalRecord(JSON.stringify(context()), { kind: 'room', id: 'decision-static' }).reason,
    'selected_kind_mismatch');
  const segment = room(); segment.anchors = ['src/core#L1-2'];
  assert.equal(parse(segment, 'room', 'room-static').reason, 'segment_anchor_unsupported');
  const reconstructed = evidence('evidence-works', 'works', WORKS_IDENTITY); reconstructed.binding_origin = 'reconstructed';
  assert.equal(parse(reconstructed, 'ticket_evidence', 'evidence-works').reason, 'unsupported_binding');
  const legacy = ticketRecord(); legacy.revision_state = 'legacy-pending-reconstruction';
  delete legacy.active_contract_revision; delete legacy.contract_revisions;
  assert.equal(parse(legacy, 'ticket', 'ticket-static-profile').reason, 'unsupported_binding');
});

test('Ticket identities, append-only history and active membership are independently verified', () => {
  const valid = ticketRecord();
  valid.acceptance[0].presentation = { label: 'Presentation only' };
  assert.equal(parse(valid, 'ticket', 'ticket-static-profile').status, 'valid');
  const changed = ticketRecord(); changed.acceptance[0].criterion = 'Changed without revision.';
  assert.equal(parse(changed, 'ticket', 'ticket-static-profile').reason, 'invalid_schema');
  const wrongContract = ticketRecord(); wrongContract.contract_revisions[0].identity = `sha256:${'0'.repeat(64)}`;
  assert.equal(parse(wrongContract, 'ticket', 'ticket-static-profile').reason, 'invalid_schema');
  const missingMember = ticketRecord(); missingMember.contract_revisions[0].acceptance_revisions.pop();
  assert.equal(parse(missingMember, 'ticket', 'ticket-static-profile').reason, 'invalid_schema');
  const gap = ticketRecord(); gap.acceptance[0].revision = 2;
  assert.equal(parse(gap, 'ticket', 'ticket-static-profile').reason, 'invalid_schema');
});

test('evaluation prepass exposes same-commit Authority artifact requirements without treating Room stale as revocation', () => {
  const records = closure();
  const prepass = evaluateCanonicalRecords(records, { artifacts: [] });
  assert.equal(prepass.profile, CANONICAL_RECORD_PROFILE); assert.equal(prepass.status, 'partial');
  assert.deepEqual(prepass.artifact_requirements, ['docs/policy.md']);
  assert.equal(prepass.entries.find(item => item.key === 'authority').status, 'unavailable');
  assert.equal(prepass.entries.find(item => item.key === 'room').status, 'usable');
  const verified = evaluateCanonicalRecords(records, {
    artifacts: [{ path: 'docs/policy.md', status: 'present', entry_type: 'regular_blob' }],
  });
  assert.equal(verified.status, 'usable'); assert.equal(verified.canonical_refs.length, records.length);
  assert.equal(verified.entries.find(item => item.key === 'room').record.stale, true);
  const binding = verified.bindings.find(item => item.kind === 'ticket_outcome');
  assert.equal(binding.status, 'verified'); assert.equal(binding.independence_claim.source, 'subagent');
});

test('Authority absent, unavailable and non-blob proofs affect usability without filesystem inference', () => {
  const entry = closure().filter(item => item.key === 'authority');
  const unavailable = evaluateCanonicalRecords(entry, {
    artifacts: [{ path: 'docs/policy.md', status: 'unavailable', entry_type: 'regular_blob' }],
  });
  assert.equal(unavailable.status, 'partial'); assert.equal(unavailable.entries[0].status, 'unavailable');
  for (const proof of [
    { path: 'docs/policy.md', status: 'absent', entry_type: 'regular_blob' },
    { path: 'docs/policy.md', status: 'present', entry_type: 'symlink' },
  ]) {
    const result = evaluateCanonicalRecords(entry, { artifacts: [proof] });
    assert.equal(result.status, 'invalid'); assert.equal(result.entries[0].reason, 'authority_artifact_invalid');
  }
});

test('native Evidence and successful Outcome require exact complete closure and human-origin support', () => {
  const noHuman = evaluateCanonicalRecords(closure({ humanOrigin: 'agent' }), {
    artifacts: [{ path: 'docs/policy.md', status: 'present', entry_type: 'regular_blob' }],
  });
  assert.equal(noHuman.status, 'invalid');
  assert.equal(noHuman.bindings.find(item => item.kind === 'ticket_outcome').reason, 'human_evidence_missing');

  const noIndependence = closure();
  const independentOutcome = outcome(); delete independentOutcome.independence;
  noIndependence.at(-1).result = parse(independentOutcome, 'ticket_outcome', 'contract-v1');
  const missingClaim = evaluateCanonicalRecords(noIndependence, {
    artifacts: [{ path: 'docs/policy.md', status: 'present', entry_type: 'regular_blob' }],
  });
  assert.equal(missingClaim.status, 'invalid');
  assert.equal(missingClaim.bindings.find(item => item.kind === 'ticket_outcome').reason, 'independence_claim_missing');

  const wrong = closure();
  const proof = wrong.find(item => item.key === 'proof');
  const altered = evidence('evidence-works', 'works', `sha256:${'1'.repeat(64)}`);
  proof.result = parse(altered, 'ticket_evidence', 'evidence-works');
  const misbound = evaluateCanonicalRecords(wrong, {
    artifacts: [{ path: 'docs/policy.md', status: 'present', entry_type: 'regular_blob' }],
  });
  assert.equal(misbound.status, 'invalid');
  assert.ok(misbound.bindings.some(item => item.reason === 'evidence_binding_mismatch'));

  const tainted = closure();
  const fakeSupport = evidence('evidence-works', 'works', WORKS_IDENTITY);
  fakeSupport.acceptance_ids.push('invented-criterion');
  fakeSupport.acceptance_revisions.push({ acceptance_id: 'invented-criterion', revision: 1,
    identity: `sha256:${'2'.repeat(64)}` });
  tainted.find(item => item.key === 'proof').result = parse(fakeSupport, 'ticket_evidence', 'evidence-works');
  const completeEvidenceCheck = evaluateCanonicalRecords(tainted, {
    artifacts: [{ path: 'docs/policy.md', status: 'present', entry_type: 'regular_blob' }],
  });
  assert.equal(completeEvidenceCheck.status, 'invalid');
  const taintedOutcome = completeEvidenceCheck.bindings.find(item => item.kind === 'ticket_outcome');
  assert.equal(taintedOutcome.status, 'misbound'); assert.equal(taintedOutcome.reason, 'evidence_binding_mismatch');

  const missing = closure().filter(item => item.key !== 'owner-proof');
  const unavailable = evaluateCanonicalRecords(missing, {
    artifacts: [{ path: 'docs/policy.md', status: 'present', entry_type: 'regular_blob' }],
  });
  assert.equal(unavailable.status, 'partial');
  assert.equal(unavailable.bindings.find(item => item.kind === 'ticket_outcome').reason, 'evidence_unavailable');
});

test('partial Outcome is historical and cannot become a successful acceptance claim', () => {
  const result = evaluateCanonicalRecords(closure({ outcomeStatus: 'partial' }), {
    artifacts: [{ path: 'docs/policy.md', status: 'present', entry_type: 'regular_blob' }],
  });
  assert.equal(result.status, 'partial');
  const binding = result.bindings.find(item => item.kind === 'ticket_outcome');
  assert.equal(binding.status, 'historical'); assert.equal(binding.reason, 'outcome_not_successful');
});

test('an exact successful Outcome for an older Contract remains historical while a forged active binding is rejected', () => {
  const older = closure();
  older.find(item => item.key === 'ticket').result = parse(ticketRecord({ advanced: true }), 'ticket', 'ticket-static-profile');
  const historical = evaluateCanonicalRecords(older, {
    artifacts: [{ path: 'docs/policy.md', status: 'present', entry_type: 'regular_blob' }],
  });
  assert.equal(historical.status, 'partial');
  const oldBinding = historical.bindings.find(item => item.kind === 'ticket_outcome');
  assert.equal(oldBinding.status, 'historical'); assert.equal(oldBinding.reason, 'outcome_contract_historical');

  const forged = clone(older);
  const selectedOutcome = outcome(); selectedOutcome.contract_revision = { revision: 2, identity: CONTRACT_V2_IDENTITY };
  forged.find(item => item.key === 'outcome').result = parse(selectedOutcome, 'ticket_outcome', 'contract-v1');
  const invalid = evaluateCanonicalRecords(forged, {
    artifacts: [{ path: 'docs/policy.md', status: 'present', entry_type: 'regular_blob' }],
  });
  assert.equal(invalid.status, 'invalid');
  assert.equal(invalid.bindings.find(item => item.kind === 'ticket_outcome').reason, 'evidence_binding_mismatch');
});

test('absent, unavailable, invalid and unsupported selected records stay typed and never expose source text', () => {
  const base = { kind: 'context', id: 'decision-static', record: null, byte_length: 0 };
  const entries = [
    selected('absent', '.vibehub/rooms/static/absent.yaml', 'context', 'decision-static',
      { ...base, status: 'absent', reason: 'proved_absent' }),
  ];
  const absent = evaluateCanonicalRecords(entries, { artifacts: [] });
  assert.equal(absent.status, 'partial'); assert.equal(absent.entries[0].status, 'absent');
  assert.equal(absent.entries[0].record, null); assert.deepEqual(absent.canonical_refs, []);

  const unsupportedRecord = room(); unsupportedRecord.anchors = ['src/core#segment'];
  const unsupported = parse(unsupportedRecord, 'room', 'room-static');
  const selectedUnsupported = evaluateCanonicalRecords([
    selected('unsupported', '.vibehub/rooms/static/room.yaml', 'room', 'room-static', unsupported),
  ], { artifacts: [] });
  assert.equal(selectedUnsupported.status, 'partial'); assert.equal(selectedUnsupported.entries[0].record, null);

  const malformed = parseCanonicalRecord('{', { kind: 'context', id: 'decision-static' });
  const invalid = evaluateCanonicalRecords([
    selected('invalid', '.vibehub/rooms/static/invalid.yaml', 'context', 'decision-static', malformed),
  ], { artifacts: [] });
  assert.equal(invalid.status, 'invalid'); assert.equal(invalid.entries[0].record, null);
});

test('record count and aggregate byte limits reject atomically without truncation', () => {
  const tooMany = Array.from({ length: 17 }, (_, index) => {
    const record = context(`decision-${index}`); return selected(`entry-${index}`, `.vibehub/rooms/static/decision-${index}.yaml`,
      'context', record.context_id, parse(record, 'context', record.context_id));
  });
  assert.equal(evaluateCanonicalRecords(tooMany, { artifacts: [] }).reason, 'invalid_input');

  const large = Array.from({ length: 5 }, (_, index) => {
    const record = context(`large-${index}`); record.detail = 'x'.repeat(54000);
    const result = parse(record, 'context', record.context_id); assert.equal(result.status, 'valid');
    return selected(`large-${index}`, `.vibehub/rooms/static/large-${index}.yaml`, 'context', record.context_id, result);
  });
  const aggregate = evaluateCanonicalRecords(large, { artifacts: [] });
  assert.equal(aggregate.status, 'invalid'); assert.equal(aggregate.reason, 'aggregate_too_large');

  const oversized = context(); oversized.detail = 'x'.repeat(65536);
  assert.equal(parse(oversized, 'context', 'decision-static').reason, 'record_too_large');
});

test('evaluator rejects hostile arrays and nested result records before traps or accessors run', () => {
  let ran = false;
  const proxyArray = new Proxy([], { get() { ran = true; throw new Error('ARRAY_CANARY'); } });
  assert.equal(evaluateCanonicalRecords(proxyArray, { artifacts: [] }).reason, 'invalid_input'); assert.equal(ran, false);
  const result = parse(context(), 'context', 'decision-static');
  const recordProxy = new Proxy(result.record, { ownKeys() { ran = true; throw new Error('RECORD_CANARY'); } });
  const forged = { ...result, record: recordProxy };
  const evaluated = evaluateCanonicalRecords([
    selected('decision', '.vibehub/rooms/static/decision-static.yaml', 'context', 'decision-static', forged),
  ], { artifacts: [] });
  assert.equal(evaluated.reason, 'invalid_input'); assert.equal(ran, false);
  const artifacts = [];
  Object.defineProperty(artifacts, '0', { enumerable: true, get() { ran = true; throw new Error('ARTIFACT_CANARY'); } });
  artifacts.length = 1;
  assert.equal(evaluateCanonicalRecords(closure(), { artifacts }).reason, 'invalid_input'); assert.equal(ran, false);
});
