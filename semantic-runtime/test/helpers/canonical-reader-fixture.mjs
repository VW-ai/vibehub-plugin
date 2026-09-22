import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fixture as graphFixture, git, initialize, SCOPE, ACTIONS } from './graph-store-fixture.mjs';
import { CanonicalSourceReader } from '../../src/local/canonical-source-reader.mjs';

const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
export const digest = value => `sha256:${createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')}`;
export const READER_ACTIONS = [...ACTIONS, 'source:invalidation:read', 'source:invalidation:consume', 'source:invalidate', 'source:invalidation:capture'];
export function records() {
  const context = (id, type, extra = {}) => ({ schema_version: 1, kind: 'context', context_id: id, type, state: 'active',
    summary: `Synthetic ${id}`, detail: 'Selected synthetic project guidance.', tags: [],
    source: { ref: 'conversation:synthetic-explicit-input', captured_at: '2026-09-22T12:00:00.000Z' },
    evidence: [{ ref: 'conversation:synthetic-explicit-input', note: 'Synthetic explicit source.' }], relations: [], ...extra });
  const acceptance = ['automatic', 'human-choice'].map((acceptance_id, i) => {
    const a = { acceptance_id, revision: 1, criterion: `Synthetic criterion ${i + 1}`, authority: i ? 'human' : 'agent', state: 'active' };
    return { ...a, identity: digest({ ticket_id: 'example', acceptance_id, revision: 1, criterion: a.criterion, authority: a.authority, derived_from: [] }) };
  });
  const contract = { revision: 1, acceptance_revisions: acceptance.map(({ acceptance_id, revision, identity }) => ({ acceptance_id, revision, identity })) };
  contract.identity = digest({ ticket_id: 'example', revision: 1, acceptance_revisions: contract.acceptance_revisions });
  const ticket = { schema_version: 3, kind: 'ticket', ticket_id: 'example', revision_state: 'bound', maturity: 'firm',
    active_contract_revision: 1, contract_revisions: [contract], outcome: 'Synthetic outcome', deliveries: [], context: 'Synthetic fixture',
    acceptance, constraints: [], context_refs: [], relations: [], provenance_refs: ['synthetic:fixture'] };
  const evidence = acceptance.map((a, i) => ({ schema_version: 2, kind: 'ticket_evidence', evidence_id: i ? 'human-proof' : 'automatic-proof',
    ticket_id: 'example', acceptance_ids: [a.acceptance_id], binding_state: 'bound', binding_origin: 'native',
    acceptance_revisions: [{ acceptance_id: a.acceptance_id, revision: a.revision, identity: a.identity }], summary: 'Synthetic observed proof',
    refs: [i ? 'conversation:synthetic-human-input' : 'test:synthetic-pass'], origin: i ? 'human' : 'agent', recorded_at: '2026-09-22T12:00:00.000Z' }));
  return {
    room: { schema_version: 1, kind: 'room', room_id: 'demo', description: 'Synthetic room', boundary: 'Selected sample code', anchors: ['src'], stale: false },
    decision: context('choice', 'decision'), constraint: context('guardrail', 'constraint'),
    authority: context('source-rules', 'authority', { authority: { governs: ['src'], canonical: ['src/api.mjs'], update_rules: ['Update selected contract first.'], validation: ['Run selected tests.'], approval: 'none' } }),
    ticket, evidence: evidence[0], human: evidence[1],
    outcome: { schema_version: 2, kind: 'ticket_outcome', outcome_id: 'accepted', ticket_id: 'example', binding_state: 'bound', binding_origin: 'native',
      contract_revision: { revision: 1, identity: contract.identity }, status: 'successful', accepted_acceptance_ids: acceptance.map(a => a.acceptance_id),
      unresolved_acceptance_ids: [], evidence_ids: evidence.map(e => e.evidence_id), summary: 'Synthetic accepted source claim', closed_at: '2026-09-22T12:00:00.000Z', independence: { source: 'separate_session' } }
  };
}
export function writeRecords(folder, values) {
  for (const [key, value] of Object.entries(values)) {
    const path = join(folder, '.vibehub', `${key}.yaml`); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  }
}
export function makeReader(f, selection = f.selection) {
  return new CanonicalSourceReader({ store: f.store, authority: f.authority, repository_path: f.folder,
    execution: f.execution, registration_id: f.source.registration_id, selection });
}
export function readerFixture(t, { values = records() } = {}) {
  const f = graphFixture(t); f.context = f.issue({ actions: READER_ACTIONS }).context;
  writeRecords(f.folder, values); mkdirSync(join(f.folder, 'src')); writeFileSync(join(f.folder, 'src/api.mjs'), 'export const synthetic = true;\n');
  git(f.folder, 'add', '.'); git(f.folder, 'commit', '-m', 'selected synthetic canonical records'); f.commit = git(f.folder, 'rev-parse', 'HEAD');
  const catalog = f.registry.get(f.context), checkout = catalog.value.checkouts[0], worktree = checkout.worktrees[0];
  f.execution = { repository_id: checkout.repository_id, checkout_id: checkout.checkout_id, worktree_id: worktree.worktree_id };
  f.source = f.ingress.registerSource(f.context, { partition: { ...SCOPE, source_installation_id: catalog.value.installation_id, partition_id: 'canonical-records' },
    producer: { producer_id: 'canonical-reader', epoch: 'incarnation-1' }, producer_principal_id: 'owner', start_sequence: 0,
    mapping: { schema_version: 1, mapping_id: 'canonical-documents', revision: 'v1', event_types: { canonical_record: 'DOC_CHANGED', tombstone: 'SOURCE_TOMBSTONE', access: 'SOURCE_ACCESS_CHANGED' } },
    access: { enabled: true, allowed_principal_ids: ['owner', 'reader'], sensitivity: 'normal', allow_snapshots: false }, execution: f.execution });
  f.selection = { schema_profile: 'vibehub-records-v1', selection_id: 'selected-project-contract', policy_id: 'explicit-synthetic-policy-v1', object_format: 'sha1',
    records: Object.entries(values).map(([key, value]) => ({ key, kind: value.kind, id: value.context_id ?? value.room_id ?? value.evidence_id ?? value.outcome_id ?? value.ticket_id, path: `.vibehub/${key}.yaml` })) };
  f.genesis = initialize(f); f.reader = makeReader(f);
  f.request = { epoch: f.epoch, publisher_ref: f.publisher, expected_graph: f.genesis.receipt.next_graph,
    previous_selection: null, commit_oid: f.commit, idempotency_key: 'initial-selection', observation: { observed_at: '2026-09-22T12:00:00.000Z', sequence_start: 0 } };
  f.commitRecords = next => { writeRecords(f.folder, next); git(f.folder, 'add', '.'); git(f.folder, 'commit', '-m', 'synthetic canonical update'); return git(f.folder, 'rev-parse', 'HEAD'); };
  return f;
}
export { git, SCOPE };
