import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BRANCH_SCOPE_VERSION, createBranchScope, validateBranchScope, applyBranchScopeChange,
  resolveExploration, recordTicketWorkspaceProvenance, selectExplorationView,
} from '../../src/index.mjs';

const scope = { tenant_id: 'acme', project_id: 'product' };
const hash = char => `sha256:${char.repeat(64)}`;
const copy = value => structuredClone(value);
function catalog() {
  const value = JSON.parse(readFileSync(new URL('../fixtures/identity/multi-source.json', import.meta.url)));
  value.worktrees.push({ tenant_id: 'acme', worktree_id: 'feature-recreated', checkout_id: 'api-clone-a', attributes: { path: '/synthetic/feature', branch: 'feature' } });
  for (const [suffix, worktree] of [['restart', 'feature-a'], ['other', 'feature-b'], ['clone', 'clone-b-main'], ['recreated', 'feature-recreated']]) {
    value.sessions.push({ tenant_id: 'acme', session_id: `session-${suffix}`, project_id: 'product', source_installation_id: 'laptop', worktree_id: worktree });
    value.executions.push({ tenant_id: 'acme', execution_id: `attempt-${suffix}`, session_id: `session-${suffix}`, repository_id: 'api', worktree_id: worktree });
  }
  return value;
}
function change(state, type, value) { return applyBranchScopeChange(state, { schema_version: 1, scope: state.scope, type, value }); }
function ref(ref_incarnation_id = 'ref-a', checkout_id = 'api-clone-a', repository_id = 'api') {
  return { ref_incarnation_id, checkout_id, repository_id, ref_name: 'refs/heads/feature', state: 'active' };
}
function exploration(exploration_id, repository_id = 'api') {
  return { exploration_id, base_revisions: { git: repository_id === null ? [] : [{ repository_id, commit: 'a'.repeat(40) }],
    shared_context: [{ context_id: 'project-contract', revision: 1, identity: hash('a') }] } };
}
function workspace(execution_workspace_id = 'workspace-a', worktree_id = 'feature-a', exploration_id = 'cloud', ref_incarnation_id = 'ref-a') {
  return { execution_workspace_id, exploration_id, source_installation_id: 'laptop', worktree_id, ref_incarnation_id, state: 'active' };
}
function setup() {
  let state = createBranchScope({ scope, catalog: catalog() });
  state = change(state, 'register_ref', ref());
  state = change(state, 'create_exploration', exploration('cloud'));
  state = change(state, 'enroll_ref', { exploration_id: 'cloud', ref_incarnation_id: 'ref-a' });
  state = change(state, 'register_execution_workspace', workspace());
  return state;
}
const acceptance = { acceptance_id: 'usable', revision: 2, identity: hash('b') };
function provenance(provenance_id, kind = 'participated', execution_id = 'attempt-a', execution_workspace_id = 'workspace-a') {
  return { provenance_id, kind, ticket: { ticket_id: 'ticket-1', contract_revision: 2, contract_identity: hash('c'), acceptance_revisions: [acceptance] },
    origin: { kind: 'execution', execution_id, execution_workspace_id }, evidence: [{ evidence_id: `evidence-${provenance_id}`, acceptance_revision: acceptance }] };
}
function record(state, value) { return recordTicketWorkspaceProvenance(state, { schema_version: 1, scope: state.scope, provenance: value }); }

test('scope enrollment is explicit; equal names across clones and repositories never unify explorations', () => {
  let state = setup();
  for (const [rid, checkout, repo, eid] of [['ref-b', 'api-clone-b', 'api', 'k8s'], ['ref-web', 'web-clone', 'web', 'web']]) {
    state = change(state, 'register_ref', ref(rid, checkout, repo));
    state = change(state, 'create_exploration', exploration(eid, repo));
    state = change(state, 'enroll_ref', { exploration_id: eid, ref_incarnation_id: rid });
  }
  assert.equal(BRANCH_SCOPE_VERSION, 1);
  assert.equal(resolveExploration(state, { scope, hints: { branch: 'feature', path: '/synthetic/feature', commit: 'a'.repeat(40) } }).status, 'unmapped');
  assert.deepEqual(resolveExploration(state, { scope, ref_incarnation_id: 'ref-b' }).exploration_ids, ['k8s']);
  assert.deepEqual(resolveExploration(state, { scope, ref_incarnation_id: 'ref-web' }).exploration_ids, ['web']);
  // Sharing is enrollment, never equality of ref names or commit hashes.
  state = change(state, 'enroll_ref', { exploration_id: 'cloud', ref_incarnation_id: 'ref-b' });
  assert.equal(resolveExploration(state, { scope, ref_incarnation_id: 'ref-b' }).status, 'ambiguous');
  assert.deepEqual(resolveExploration(state, { scope, ref_incarnation_id: 'ref-b', exploration_id: 'cloud' }).exploration_ids, ['cloud']);
  assert.equal(resolveExploration(state, { scope, ref_incarnation_id: 'ref-b', checkout_id: 'api-clone-a' }).reason, 'conflicting_evidence');
  assert.equal(resolveExploration(state, { scope, exploration_id: 'cloud', checkout_id: 'missing' }).status, 'unmapped');
  assert.equal(resolveExploration(state, { scope, exploration_id: 'cloud', checkout_id: 'web-clone' }).status, 'unmapped');
  assert.equal(resolveExploration(state, { scope, exploration_id: 'k8s', execution_workspace_id: 'workspace-a' }).status, 'ambiguous');
});

test('rename retains identity; delete/recreate at the same branch requires fresh ref and workspace IDs', () => {
  const initial = setup();
  let state = record(initial, provenance('old-origin', 'created'));
  state = change(state, 'rename_ref', { ref_incarnation_id: 'ref-a', ref_name: 'refs/heads/renamed' });
  assert.equal(state.execution_workspaces[0].execution_workspace_id, 'workspace-a');
  assert.equal(state.explorations[0].exploration_id, 'cloud');
  assert.equal(initial.refs[0].ref_name, 'refs/heads/feature');
  state = change(state, 'delete_ref', { ref_incarnation_id: 'ref-a' });
  assert.equal(resolveExploration(state, { scope, ref_incarnation_id: 'ref-a' }).status, 'unmapped');
  assert.equal(state.execution_workspaces[0].state, 'retired');
  assert.throws(() => change(state, 'register_ref', ref()), /duplicate identity/);
  state = change(state, 'register_ref', ref('ref-new'));
  assert.equal(resolveExploration(state, { scope, ref_incarnation_id: 'ref-new' }).status, 'unmapped');
  state = change(state, 'enroll_ref', { exploration_id: 'cloud', ref_incarnation_id: 'ref-new' });
  state = change(state, 'register_execution_workspace', workspace('workspace-new', 'feature-recreated', 'cloud', 'ref-new'));
  assert.equal(state.provenance[0].origin.execution_workspace_id, 'workspace-a');
  assert.equal(state.provenance[0].origin.execution_id, 'attempt-a');
  assert.throws(() => record(state, provenance('rebind-old', 'participated', 'attempt-a', 'workspace-new')), /workspace mismatch/);
  assert.equal(validateBranchScope(state), true);
});

test('branch switch is an explicit new workspace binding; detached HEAD never chooses main', () => {
  let state = setup();
  state = change(state, 'create_exploration', exploration('detached-experiment'));
  assert.throws(() => change(state, 'register_execution_workspace', workspace('detached', 'feature-a', 'detached-experiment', null)), /already active/);
  state = record(state, provenance('before-switch'));
  state = change(state, 'retire_execution_workspace', { execution_workspace_id: 'workspace-a' });
  state = change(state, 'register_execution_workspace', workspace('detached', 'feature-a', 'detached-experiment', null));
  assert.equal(resolveExploration(state, { scope, execution_workspace_id: 'workspace-a' }).status, 'unmapped');
  assert.deepEqual(resolveExploration(state, { scope, execution_workspace_id: 'detached' }).exploration_ids, ['detached-experiment']);
  assert.throws(() => record(state, provenance('after-switch', 'participated', 'attempt-a', 'detached')), /already bound/);
  state = record(state, provenance('new-execution', 'participated', 'attempt-restart', 'detached'));
  assert.equal(state.provenance[0].origin.execution_workspace_id, 'workspace-a');
});

test('repository-free Project work requires a named exploration and has no fabricated worktree', () => {
  const notesScope = { tenant_id: 'acme', project_id: 'notes' };
  let state = createBranchScope({ catalog: catalog(), scope: notesScope });
  state = change(state, 'create_exploration', exploration('notes-only', null));
  state = change(state, 'register_execution_workspace', { ...workspace('notes-space', null, 'notes-only', null), source_installation_id: 'notes-host' });
  state = record(state, provenance('notes', 'created', 'notes-attempt', 'notes-space'));
  assert.equal(resolveExploration(state, { scope: notesScope }).status, 'unmapped');
  assert.deepEqual(resolveExploration(state, { scope: notesScope, exploration_id: 'notes-only' }).exploration_ids, ['notes-only']);
  assert.equal(state.execution_workspaces[0].worktree_id, null);
});

test('Ticket origins preserve many sessions and exploration executions; completion does not accept', () => {
  let state = setup();
  state = record(state, provenance('created', 'created'));
  assert.throws(() => record(state, provenance('another-birthplace', 'created', 'attempt-restart')), /creation origin already recorded/);
  state = record(state, provenance('session-two', 'participated', 'attempt-restart'));
  state = record(state, provenance('completed', 'execution_completed', 'attempt-restart'));
  state = change(state, 'create_exploration', exploration('k8s'));
  state = change(state, 'register_execution_workspace', workspace('workspace-b', 'feature-b', 'k8s', null));
  state = record(state, provenance('other-exploration', 'participated', 'attempt-other', 'workspace-b'));
  state = record(state, provenance('reviewer-origin', 'acceptance_recorded', 'attempt-other', 'workspace-b'));
  assert.equal(state.provenance.length, 5);
  assert.deepEqual(new Set(state.provenance.map(p => p.ticket.ticket_id)), new Set(['ticket-1']));
  assert.equal(state.provenance.some(p => Object.hasOwn(p, 'status')), false);
  state = change(state, 'retire_execution_workspace', { execution_workspace_id: 'workspace-a' });
  assert.equal(state.provenance[0].origin.execution_workspace_id, 'workspace-a');
  const imported = { ...provenance('legacy'), origin: { kind: 'unknown' }, evidence: [] };
  state = record(state, imported);
  assert.deepEqual(state.provenance.at(-1).origin, { kind: 'unknown' });
  assert.throws(() => record(state, provenance('late')), /retired/);
});

test('Evidence is bound to the exact Acceptance revision, and identities cannot be overwritten', () => {
  let state = setup();
  const bad = copy(provenance('bad'));
  bad.evidence[0].acceptance_revision = { ...acceptance, revision: 1 };
  assert.throws(() => record(state, bad), /revision mismatch/);
  state = record(state, provenance('valid'));
  assert.throws(() => record(state, provenance('valid', 'execution_completed')), /duplicate identity/);
  assert.throws(() => change(state, 'create_exploration', { ...exploration('cloud'), base_revisions: { git: [], shared_context: [] } }), /duplicate identity/);
  assert.equal(Object.isFrozen(state.provenance[0].ticket.acceptance_revisions), true);
});

function viewFixture(state = setup()) {
  state = change(state, 'create_exploration', exploration('k8s'));
  const claim = (assertion_id, exploration_id, governing = false) => ({ assertion_id, scope, exploration_id, revision: 1, identity: hash('d'), governing });
  return { state, input: { scope, exploration_id: 'cloud',
    assertions: [claim('governing', null, true), claim('selected', null), claim('not-selected', null),
      claim('cloud-a', 'cloud'), claim('cloud-b', 'cloud'), claim('k8s-a', 'k8s')],
    shared_assertion_ids: ['selected'],
    issues: [
      { kind: 'incompatible', left_assertion_id: 'cloud-a', right_assertion_id: 'k8s-a' },
      { kind: 'concurrent', left_assertion_id: 'cloud-a', right_assertion_id: 'cloud-b' },
      { kind: 'governing_violation', left_assertion_id: 'k8s-a', right_assertion_id: 'governing' },
    ] } };
}
test('views separate shared pins, local hypotheses and notices without adopting another exploration', () => {
  const { state, input } = viewFixture();
  const view = selectExplorationView(state, input);
  assert.deepEqual(view.shared.map(a => a.assertion_id), ['governing', 'selected']);
  assert.deepEqual(view.local.map(a => a.assertion_id), ['cloud-a', 'cloud-b']);
  assert.equal(view.other_explorations[0].exploration_id, 'k8s');
  assert.equal(view.cross_scope_notices.length, 1);
  assert.equal(view.same_scope_issues[0].kind, 'concurrent');
  assert.equal(view.governing_violations[0].left_assertion_id, 'k8s-a');
  assert.equal(input.assertions.some(a => a.contested), false);
  const overview = selectExplorationView(state, { ...input, exploration_id: null });
  assert.equal(overview.view, 'project_overview');
  assert.equal(overview.other_explorations.length, 2);
  assert.deepEqual(overview.local, []);
});

test('all entry points deny cross-Project references and invalid catalog mappings', () => {
  const state = setup(), otherScope = { ...scope, project_id: 'shared' };
  assert.throws(() => resolveExploration(state, { scope: otherScope, exploration_id: 'cloud' }), /cross-Project/);
  assert.throws(() => applyBranchScopeChange(state, { schema_version: 1, scope: otherScope, type: 'create_exploration', value: exploration('outside') }), /cross-Project/);
  assert.throws(() => recordTicketWorkspaceProvenance(state, { schema_version: 1, scope: otherScope, provenance: provenance('outside') }), /cross-Project/);
  const { state: views, input } = viewFixture();
  input.assertions[0].scope = otherScope;
  assert.throws(() => selectExplorationView(views, input), /cross-Project/);
  assert.throws(() => change(state, 'register_execution_workspace', { ...workspace('invalid', null, 'cloud', null), source_installation_id: 'notes-host' }), /unmapped Project identity/);
  assert.throws(() => record(state, provenance('wrong-project', 'participated', 'notes-attempt')), /unmapped Project identity/);
});

test('malformed, oversized, accessor and ambiguous inputs fail without mutating state', () => {
  const state = setup();
  assert.throws(() => createBranchScope({ catalog: catalog(), scope, extra: true }), /unknown field/);
  assert.throws(() => validateBranchScope({ ...state, schema_version: 2 }), /unsupported version/);
  assert.throws(() => change(state, 'register_ref', ref('duplicate-active')), /duplicate active ref/);
  let called = false;
  const malicious = { scope, get exploration_id() { called = true; return 'cloud'; } };
  assert.throws(() => resolveExploration(state, malicious), /data property/);
  assert.equal(called, false);
  assert.throws(() => validateBranchScope({ ...state, enrollments: new Array(513).fill(state.enrollments[0]) }), /bounded array/);
  assert.equal(resolveExploration(state, { scope, execution_workspace_id: 'workspace-a', ref_incarnation_id: 'absent' }).reason, 'conflicting_evidence');
  const { state: views, input } = viewFixture();
  input.shared_assertion_ids = ['cloud-a'];
  assert.throws(() => selectExplorationView(views, input), /Project-scoped/);
  assert.equal(validateBranchScope(state), true);
});
