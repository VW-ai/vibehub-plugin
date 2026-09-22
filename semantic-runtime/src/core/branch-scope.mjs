import { validateIdentityCatalog, resolveIdentity } from './identity.mjs';
import { canonical } from './contracts.mjs';

export const BRANCH_SCOPE_VERSION = 1;
const assert = (ok, message) => { if (!ok) throw new TypeError(`Branch scope: ${message}`); };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
function json(v, seen = new Set(), budget = { n: 0 }) {
  assert(++budget.n <= 100000 && seen.size < 24, 'JSON limit exceeded');
  if (v === null || typeof v === 'boolean') return;
  if (typeof v === 'string') { assert(v.length <= 8192, 'string limit exceeded'); return; }
  if (typeof v === 'number') { assert(Number.isFinite(v), 'nonfinite number'); return; }
  assert((object(v) || Array.isArray(v)) && !seen.has(v), 'acyclic JSON required');
  assert(Object.getOwnPropertySymbols(v).length === 0, 'symbol field');
  for (const [key, desc] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
    if (Array.isArray(v) && key === 'length') continue;
    assert(Object.hasOwn(desc, 'value') && desc.enumerable, 'JSON data property required');
    assert(!Array.isArray(v) || /^(0|[1-9]\d*)$/.test(key) && Number(key) < v.length, 'array property');
  }
  if (Array.isArray(v)) assert(Object.keys(v).length === v.length, 'sparse array');
  seen.add(v); Object.values(v).forEach(x => json(x, seen, budget)); seen.delete(v);
}
function fields(v, required, optional = []) {
  assert(object(v) && required.every(k => Object.hasOwn(v, k)), 'missing field');
  assert(Object.keys(v).every(k => required.includes(k) || optional.includes(k)), 'unknown field');
}
const id = v => assert(typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(v), 'invalid identifier');
const digest = v => assert(typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v), 'invalid digest');
const revision = v => assert(Number.isSafeInteger(v) && v > 0, 'invalid revision');
const list = (v, max = 512) => assert(Array.isArray(v) && v.length <= max, 'bounded array required');
const same = (a, b) => canonical(a) === canonical(b);
const clone = v => JSON.parse(canonical(v));
function frozen(v) { if (v && typeof v === 'object') { Object.values(v).forEach(frozen); Object.freeze(v); } return v; }
const output = v => frozen(clone(v));
function scope(v) { fields(v, ['tenant_id', 'project_id']); id(v.tenant_id); id(v.project_id); }
function bound(v, state) { scope(v); assert(same(v, state.scope), 'cross-Project reference'); }
function exactRef(v, name) { fields(v, [name, 'revision', 'identity']); id(v[name]); revision(v.revision); digest(v.identity); }
function unique(records, field) {
  list(records); records.forEach(r => id(r[field]));
  assert(new Set(records.map(r => r[field])).size === records.length, 'duplicate identity');
}
const find = (rows, field, value) => { const row = rows.find(r => r[field] === value); assert(row, 'unknown reference'); return row; };
function catalogRecord(state, collection, field, value) {
  return find(state.catalog[collection].filter(r => r.tenant_id === state.scope.tenant_id), field, value);
}
function mapped(state, values) {
  const result = resolveIdentity(state.catalog, { ...state.scope, ...values });
  assert(result.status === 'resolved' && result.identity.project_id === state.scope.project_id, 'unmapped Project identity');
  return result.identity;
}
function validRef(state, r) {
  fields(r, ['ref_incarnation_id', 'repository_id', 'checkout_id', 'ref_name', 'state']);
  ['ref_incarnation_id', 'repository_id', 'checkout_id'].forEach(k => id(r[k]));
  assert(typeof r.ref_name === 'string' && r.ref_name.startsWith('refs/heads/') && r.ref_name.length <= 1024
    && !/[\s\x00-\x1f]/.test(r.ref_name), 'invalid ref attribute');
  assert(['active', 'deleted'].includes(r.state), 'invalid ref state');
  mapped(state, { repository_id: r.repository_id, checkout_id: r.checkout_id });
}
function validExploration(state, e) {
  fields(e, ['exploration_id', 'base_revisions']); id(e.exploration_id);
  fields(e.base_revisions, ['git', 'shared_context']);
  list(e.base_revisions.git, 64); list(e.base_revisions.shared_context, 128);
  unique(e.base_revisions.git, 'repository_id'); unique(e.base_revisions.shared_context, 'context_id');
  for (const base of e.base_revisions.git) {
    fields(base, ['repository_id', 'commit']); id(base.repository_id);
    assert(typeof base.commit === 'string' && /^([a-f0-9]{40}|[a-f0-9]{64})$/.test(base.commit), 'exact Git base required');
    mapped(state, { repository_id: base.repository_id });
  }
  e.base_revisions.shared_context.forEach(r => exactRef(r, 'context_id'));
}
function validWorkspace(state, w) {
  fields(w, ['execution_workspace_id', 'exploration_id', 'source_installation_id', 'worktree_id', 'ref_incarnation_id', 'state']);
  ['execution_workspace_id', 'exploration_id', 'source_installation_id'].forEach(k => id(w[k]));
  find(state.explorations, 'exploration_id', w.exploration_id);
  assert(['active', 'retired'].includes(w.state), 'invalid execution workspace state');
  const identity = mapped(state, { source_installation_id: w.source_installation_id,
    ...(w.worktree_id === null ? {} : { worktree_id: w.worktree_id }) });
  if (w.ref_incarnation_id !== null) {
    const ref = find(state.refs, 'ref_incarnation_id', w.ref_incarnation_id);
    assert(w.state !== 'active' || ref.state === 'active', 'active workspace on deleted ref');
    assert(w.worktree_id !== null && identity.checkout_id === ref.checkout_id, 'workspace/ref checkout mismatch');
    assert(state.enrollments.some(e => e.exploration_id === w.exploration_id && e.ref_incarnation_id === w.ref_incarnation_id), 'unenrolled ref');
  }
}
function validProvenance(state, p) {
  fields(p, ['provenance_id', 'kind', 'ticket', 'origin', 'evidence']); id(p.provenance_id);
  assert(['created', 'participated', 'execution_completed', 'acceptance_recorded'].includes(p.kind), 'invalid provenance kind');
  fields(p.ticket, ['ticket_id', 'contract_revision', 'contract_identity', 'acceptance_revisions']);
  id(p.ticket.ticket_id); revision(p.ticket.contract_revision); digest(p.ticket.contract_identity);
  unique(p.ticket.acceptance_revisions, 'acceptance_id');
  p.ticket.acceptance_revisions.forEach(r => exactRef(r, 'acceptance_id'));
  if (p.origin.kind === 'unknown') fields(p.origin, ['kind']);
  else {
    fields(p.origin, ['kind', 'execution_workspace_id', 'execution_id']);
    assert(p.origin.kind === 'execution', 'invalid provenance origin');
    const workspace = find(state.execution_workspaces, 'execution_workspace_id', p.origin.execution_workspace_id);
    const identity = mapped(state, { execution_id: p.origin.execution_id });
    assert(identity.source_installation_id === workspace.source_installation_id
      && (identity.worktree_id ?? null) === workspace.worktree_id, 'execution workspace mismatch');
  }
  unique(p.evidence, 'evidence_id');
  for (const evidence of p.evidence) {
    fields(evidence, ['evidence_id', 'acceptance_revision']); id(evidence.evidence_id);
    exactRef(evidence.acceptance_revision, 'acceptance_id');
    assert(p.ticket.acceptance_revisions.some(a => same(a, evidence.acceptance_revision)), 'Evidence/Acceptance revision mismatch');
  }
}

/** A bounded identity contract, not persistence, authentication or a Ticket state machine. */
export function validateBranchScope(state) {
  json(state);
  fields(state, ['schema_version', 'scope', 'catalog', 'refs', 'explorations', 'enrollments', 'execution_workspaces', 'provenance']);
  assert(state.schema_version === BRANCH_SCOPE_VERSION, 'unsupported version'); scope(state.scope);
  validateIdentityCatalog(state.catalog); mapped(state, {});
  unique(state.refs, 'ref_incarnation_id'); state.refs.forEach(r => validRef(state, r));
  const activeRefs = state.refs.filter(r => r.state === 'active').map(r => canonical([r.checkout_id, r.ref_name]));
  assert(new Set(activeRefs).size === activeRefs.length, 'duplicate active ref in checkout');
  unique(state.explorations, 'exploration_id'); state.explorations.forEach(e => validExploration(state, e));
  list(state.enrollments);
  for (const enrollment of state.enrollments) {
    fields(enrollment, ['exploration_id', 'ref_incarnation_id']);
    const e = find(state.explorations, 'exploration_id', enrollment.exploration_id);
    const r = find(state.refs, 'ref_incarnation_id', enrollment.ref_incarnation_id);
    assert(e.base_revisions.git.some(b => b.repository_id === r.repository_id), 'ref missing selected repository base');
  }
  assert(new Set(state.enrollments.map(canonical)).size === state.enrollments.length, 'duplicate enrollment');
  unique(state.execution_workspaces, 'execution_workspace_id'); state.execution_workspaces.forEach(w => validWorkspace(state, w));
  const activeWorktrees = state.execution_workspaces.filter(w => w.state === 'active' && w.worktree_id !== null).map(w => w.worktree_id);
  assert(new Set(activeWorktrees).size === activeWorktrees.length, 'worktree already active in another execution workspace');
  unique(state.provenance, 'provenance_id'); state.provenance.forEach(p => validProvenance(state, p));
  const createdTickets = state.provenance.filter(p => p.kind === 'created').map(p => p.ticket.ticket_id);
  assert(new Set(createdTickets).size === createdTickets.length, 'Ticket creation origin already recorded');
  const executionWorkspaces = new Map();
  for (const p of state.provenance.filter(p => p.origin.kind === 'execution')) {
    const previous = executionWorkspaces.get(p.origin.execution_id);
    assert(previous === undefined || previous === p.origin.execution_workspace_id, 'execution already bound to another workspace');
    executionWorkspaces.set(p.origin.execution_id, p.origin.execution_workspace_id);
  }
  return true;
}

export function createBranchScope(input) {
  json(input); fields(input, ['catalog', 'scope']);
  const state = { schema_version: BRANCH_SCOPE_VERSION, ...clone(input), refs: [], explorations: [],
    enrollments: [], execution_workspaces: [], provenance: [] };
  validateBranchScope(state); return output(state);
}

/** Every operation retains history; caller-allocated IDs may never be rebound. */
export function applyBranchScopeChange(state, change) {
  validateBranchScope(state); json(change);
  fields(change, ['schema_version', 'scope', 'type', 'value']);
  assert(change.schema_version === BRANCH_SCOPE_VERSION, 'unsupported version'); bound(change.scope, state);
  const next = clone(state), value = clone(change.value);
  switch (change.type) {
    case 'register_ref': assert(value.state === 'active', 'new ref must be active'); next.refs.push(value); break;
    case 'create_exploration': next.explorations.push(value); break;
    case 'enroll_ref': {
      assert(find(next.refs, 'ref_incarnation_id', value.ref_incarnation_id).state === 'active', 'deleted ref');
      next.enrollments.push(value); break;
    }
    case 'rename_ref': {
      fields(value, ['ref_incarnation_id', 'ref_name']);
      const ref = find(next.refs, 'ref_incarnation_id', value.ref_incarnation_id);
      assert(ref.state === 'active', 'deleted ref'); ref.ref_name = value.ref_name; break;
    }
    case 'delete_ref': {
      fields(value, ['ref_incarnation_id']);
      find(next.refs, 'ref_incarnation_id', value.ref_incarnation_id).state = 'deleted';
      next.execution_workspaces.filter(w => w.ref_incarnation_id === value.ref_incarnation_id).forEach(w => { w.state = 'retired'; });
      break;
    }
    case 'register_execution_workspace': {
      assert(value.state === 'active', 'new execution workspace must be active');
      if (value.ref_incarnation_id !== null) assert(find(next.refs, 'ref_incarnation_id', value.ref_incarnation_id).state === 'active', 'deleted ref');
      next.execution_workspaces.push(value); break;
    }
    case 'retire_execution_workspace': {
      fields(value, ['execution_workspace_id']);
      find(next.execution_workspaces, 'execution_workspace_id', value.execution_workspace_id).state = 'retired'; break;
    }
    default: assert(false, 'unsupported change');
  }
  validateBranchScope(next); return output(next);
}

export function resolveExploration(state, observation) {
  validateBranchScope(state); json(observation);
  fields(observation, ['scope'], ['exploration_id', 'execution_workspace_id', 'checkout_id', 'ref_incarnation_id', 'hints']);
  bound(observation.scope, state);
  const stableFields = ['exploration_id', 'execution_workspace_id', 'checkout_id', 'ref_incarnation_id'];
  stableFields.filter(k => observation[k] !== undefined).forEach(k => id(observation[k]));
  if (observation.hints !== undefined) {
    fields(observation.hints, [], ['branch', 'path', 'commit']);
    Object.values(observation.hints).forEach(v => assert(typeof v === 'string', 'invalid hint'));
  }
  const answer = (status, reason, ids = []) => output({ status, reason, exploration_ids: ids.sort(), ignored_hints: Object.keys(observation.hints ?? {}).sort() });
  let candidates = state.explorations.map(e => e.exploration_id);
  if (observation.exploration_id !== undefined) {
    if (!candidates.includes(observation.exploration_id)) return answer('unmapped', 'unknown_exploration');
    candidates = [observation.exploration_id];
  }
  if (observation.checkout_id !== undefined) {
    const mappedCheckout = resolveIdentity(state.catalog, { ...state.scope, checkout_id: observation.checkout_id });
    if (mappedCheckout.status !== 'resolved') return answer('unmapped', 'unknown_checkout');
  }
  if (observation.execution_workspace_id !== undefined) {
    const w = state.execution_workspaces.find(w => w.execution_workspace_id === observation.execution_workspace_id);
    if (!w || w.state !== 'active') return answer('unmapped', 'inactive_or_unknown_execution_workspace');
    if (observation.exploration_id !== undefined && w.exploration_id !== observation.exploration_id) return answer('ambiguous', 'conflicting_evidence');
    if (observation.ref_incarnation_id !== undefined && w.ref_incarnation_id !== observation.ref_incarnation_id) return answer('ambiguous', 'conflicting_evidence');
    if (observation.checkout_id !== undefined && (w.worktree_id === null
      || catalogRecord(state, 'worktrees', 'worktree_id', w.worktree_id).checkout_id !== observation.checkout_id)) return answer('ambiguous', 'conflicting_evidence');
    candidates = candidates.filter(id => id === w.exploration_id);
  }
  if (observation.ref_incarnation_id !== undefined) {
    const ref = state.refs.find(r => r.ref_incarnation_id === observation.ref_incarnation_id);
    if (!ref || ref.state !== 'active') return answer('unmapped', 'inactive_or_unknown_ref');
    if (observation.checkout_id !== undefined && ref.checkout_id !== observation.checkout_id) return answer('ambiguous', 'conflicting_evidence');
    candidates = candidates.filter(id => state.enrollments.some(e => e.exploration_id === id && e.ref_incarnation_id === ref.ref_incarnation_id));
  }
  if (!['exploration_id', 'execution_workspace_id', 'ref_incarnation_id'].some(k => observation[k] !== undefined)) return answer('unmapped', 'explicit_enrollment_required');
  if (observation.checkout_id !== undefined && observation.ref_incarnation_id === undefined && observation.execution_workspace_id === undefined) {
    candidates = candidates.filter(id => state.enrollments.some(e => e.exploration_id === id
      && state.refs.some(r => r.ref_incarnation_id === e.ref_incarnation_id && r.checkout_id === observation.checkout_id && r.state === 'active')));
  }
  return candidates.length === 1 ? answer('resolved', 'explicit_enrollment', candidates)
    : answer(candidates.length ? 'ambiguous' : 'unmapped', candidates.length ? 'multiple_explorations' : 'no_matching_enrollment', candidates);
}

/** Facts only: acceptance_recorded never means this module accepted a Ticket. */
export function recordTicketWorkspaceProvenance(state, record) {
  validateBranchScope(state); json(record); fields(record, ['schema_version', 'scope', 'provenance']);
  assert(record.schema_version === BRANCH_SCOPE_VERSION, 'unsupported version'); bound(record.scope, state);
  const p = record.provenance; validProvenance(state, p);
  if (p.origin.kind === 'execution') {
    const w = find(state.execution_workspaces, 'execution_workspace_id', p.origin.execution_workspace_id);
    assert(w.state === 'active', 'cannot append work to a retired workspace');
    const prior = state.provenance.filter(r => r.origin.kind === 'execution' && r.origin.execution_id === p.origin.execution_id);
    assert(prior.every(r => r.origin.execution_workspace_id === p.origin.execution_workspace_id), 'execution already bound to another workspace');
  }
  const next = clone(state); next.provenance.push(clone(p)); validateBranchScope(next); return output(next);
}

/** Partition already-authorized assertion references; never infer semantic truth. */
export function selectExplorationView(state, input) {
  validateBranchScope(state); json(input);
  fields(input, ['scope', 'exploration_id', 'assertions', 'shared_assertion_ids', 'issues']); bound(input.scope, state);
  if (input.exploration_id !== null) find(state.explorations, 'exploration_id', input.exploration_id);
  unique(input.assertions, 'assertion_id'); list(input.shared_assertion_ids); list(input.issues);
  for (const a of input.assertions) {
    fields(a, ['assertion_id', 'scope', 'exploration_id', 'revision', 'identity', 'governing']); bound(a.scope, state);
    revision(a.revision); digest(a.identity); assert(typeof a.governing === 'boolean', 'invalid governing flag');
    if (a.exploration_id !== null) { find(state.explorations, 'exploration_id', a.exploration_id); assert(!a.governing, 'governing assertion must be shared'); }
  }
  assert(new Set(input.shared_assertion_ids).size === input.shared_assertion_ids.length, 'duplicate selection');
  input.shared_assertion_ids.forEach(id => assert(find(input.assertions, 'assertion_id', id).exploration_id === null, 'shared selection must be Project-scoped'));
  const shared = input.assertions.filter(a => a.exploration_id === null && (a.governing || input.shared_assertion_ids.includes(a.assertion_id)));
  const explorations = state.explorations.map(e => ({ exploration_id: e.exploration_id,
    assertions: input.assertions.filter(a => a.exploration_id === e.exploration_id) }));
  const result = { scope: state.scope, view: input.exploration_id === null ? 'project_overview' : 'exploration',
    shared, local: input.exploration_id === null ? [] : explorations.find(e => e.exploration_id === input.exploration_id).assertions,
    other_explorations: explorations.filter(e => e.exploration_id !== input.exploration_id), same_scope_issues: [], governing_violations: [], cross_scope_notices: [] };
  for (const issue of input.issues) {
    fields(issue, ['kind', 'left_assertion_id', 'right_assertion_id']);
    assert(['concurrent', 'incompatible', 'governing_violation'].includes(issue.kind), 'invalid issue kind');
    const left = find(input.assertions, 'assertion_id', issue.left_assertion_id), right = find(input.assertions, 'assertion_id', issue.right_assertion_id);
    assert(left.assertion_id !== right.assertion_id, 'self issue');
    if (issue.kind === 'governing_violation') {
      assert(left.governing || right.governing, 'missing governing constraint'); result.governing_violations.push(issue);
    } else if (left.exploration_id === right.exploration_id) result.same_scope_issues.push(issue);
    else result.cross_scope_notices.push(issue);
  }
  return output(result);
}
