import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IDENTITY_CONTRACT_VERSION, identityKey, validateIdentityCatalog, resolveIdentity } from '../src/core/identity.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/identity/multi-source.json', import.meta.url), 'utf8'));
const catalog = () => structuredClone(fixture);
const resolve = observation => resolveIdentity(fixture, { tenant_id: 'acme', ...observation });

test('versioned catalog covers the complete identity hierarchy and tenant-scoped keys', () => {
  assert.equal(IDENTITY_CONTRACT_VERSION, 1);
  assert.equal(validateIdentityCatalog(fixture), true);
  assert.notEqual(identityKey('project', 'acme', 'product'), identityKey('project', 'other', 'product'));
  assert.notEqual(identityKey('project', 'a/b', 'c'), identityKey('project', 'a', 'b/c'));
  assert.throws(() => identityKey('path', 'acme', 'product'), /unknown kind/);
  assert.throws(() => identityKey('tenant', 'acme', 'other'), /own tenant/);
  for (const field of Object.keys(fixture).filter(key => key !== 'schema_version')) {
    const invalid = catalog(); delete invalid[field];
    assert.throws(() => validateIdentityCatalog(invalid), /missing .* array/);
  }
});

test('one project owns multiple memberships while clones and worktrees keep distinct identities', () => {
  for (const [worktree, checkout, repository] of [
    ['feature-a', 'api-clone-a', 'api'], ['feature-b', 'api-clone-a', 'api'],
    ['clone-b-main', 'api-clone-b', 'api'], ['web-main', 'web-clone', 'web'],
  ]) {
    const result = resolve({ worktree_id: worktree });
    assert.equal(result.status, 'resolved');
    assert.equal(result.identity.project_id, 'product');
    assert.equal(result.identity.repository_id, repository);
    assert.equal(result.identity.checkout_id, checkout);
    assert.equal(result.identity.worktree_id, worktree);
    assert.equal(result.confidence, 'exact');
    assert.ok(result.evidence.some(item => item.basis === 'source_binding'));
  }
});

test('repository membership ambiguity must be narrowed explicitly', () => {
  const ambiguous = resolve({ repository_id: 'api' });
  assert.equal(ambiguous.status, 'ambiguous');
  assert.equal(ambiguous.reason, 'multiple_project_bindings');
  assert.equal(ambiguous.identity, null);
  assert.equal(ambiguous.confidence, 'none');
  assert.deepEqual(ambiguous.candidates.map(item => item.project_id), ['product', 'shared']);
  const selected = resolve({ repository_id: 'api', project_id: 'shared' });
  assert.equal(selected.status, 'resolved');
  assert.equal(selected.identity.membership_id, 'shared-api');
  assert.equal(resolve({ repository_id: 'web', project_id: 'shared' }).status, 'unmapped');
  assert.equal(resolve({ repository_id: 'api', workspace_id: 'research' }).status, 'unmapped');
});

test('project and source identities never invent repository membership', () => {
  for (const observation of [{ project_id: 'product' }, { source_installation_id: 'laptop' }]) {
    const result = resolve(observation);
    assert.equal(result.status, 'resolved');
    assert.equal(result.identity.project_id, 'product');
    assert.equal(result.identity.repository_id, undefined);
    assert.equal(result.identity.membership_id, undefined);
  }
  const single = catalog();
  single.source_installations.push({ tenant_id: 'acme', source_installation_id: 'web-only',
    workspace_id: 'engineering', kind: 'local',
    external_identity: { provider: 'agent-host', authority: 'host-registration', object_id: 'web-only' },
    project_ids: ['product'], membership_ids: ['product-web'] });
  const singleResult = resolveIdentity(single, { tenant_id: 'acme', source_installation_id: 'web-only' });
  assert.equal(singleResult.identity.project_id, 'product');
  assert.equal(singleResult.identity.repository_id, undefined);
  assert.equal(singleResult.identity.membership_id, undefined);
  const notes = resolve({ execution_id: 'notes-attempt' });
  assert.equal(notes.status, 'resolved');
  assert.equal(notes.identity.project_id, 'notes');
  assert.equal(notes.identity.repository_id, undefined);
  assert.equal(resolve({ source_installation_id: 'connector' }).status, 'ambiguous');
});

test('connector resolution requires explicit installation and immutable provider identity', () => {
  const external = { provider: 'git-host', authority: 'git.example', object_id: '102' };
  assert.equal(resolve({ external_repository: external }).reason, 'missing_source_installation');
  const result = resolve({ source_installation_id: 'connector', external_repository: external });
  assert.equal(result.identity.repository_id, 'web');
  assert.equal(result.identity.project_id, 'product');
  assert.ok(result.evidence.some(item => item.basis === 'external_repository'));
  assert.equal(resolve({ source_installation_id: 'connector', external_repository: { ...external, authority: 'other.example' } }).status, 'unmapped');
  assert.equal(resolve({ source_installation_id: 'connector', repository_id: 'api', external_repository: external }).reason, 'conflicting_evidence');
});

test('fork and upstream remain separate even with overlapping names and URLs', () => {
  const input = catalog();
  input.repositories.find(item => item.repository_id === 'api-fork').attributes = input.repositories[0].attributes;
  const result = resolveIdentity(input, { tenant_id: 'acme', source_installation_id: 'connector',
    external_repository: { provider: 'git-host', authority: 'git.example', object_id: '103' } });
  assert.equal(result.identity.repository_id, 'api-fork');
  assert.equal(result.identity.membership_id, 'product-fork');
  assert.equal(result.evidence.some(item => item.key === identityKey('repository', 'acme', 'api')), false);
});

test('paths, branch names, URLs and names are hints that cannot select scope', () => {
  const hints = { path: '/synthetic/feature', branch: 'feature', remote_url: 'https://git.example/team/api.git', name: 'team/api' };
  const result = resolve({ hints });
  assert.equal(result.status, 'unmapped');
  assert.equal(result.reason, 'insufficient_identity');
  assert.deepEqual(result.ignored_hints, ['branch', 'name', 'path', 'remote_url']);
  assert.equal(resolve({ workspace_id: 'engineering', hints }).status, 'unmapped');
  assert.equal(resolve({ worktree_id: 'feature-a', hints: { path: '/somewhere/else' } }).identity.worktree_id, 'feature-a');
});

test('path moves, remote changes and repository rename/transfer preserve enrolled identities', () => {
  const input = catalog();
  const before = resolveIdentity(input, { tenant_id: 'acme', execution_id: 'attempt-a' });
  input.worktrees[0].attributes = { path: '/synthetic/moved', branch: 'renamed' };
  input.checkouts[0].attributes = { path: '/synthetic/clone-moved' };
  input.repositories[0].attributes = { name: 'new-owner/new-name', remote_url: 'ssh://git.example/new-owner/new-name' };
  const after = resolveIdentity(input, { tenant_id: 'acme', execution_id: 'attempt-a' });
  assert.deepEqual(after, before);
});

test('worktree recreation and session restart require fresh enrolled IDs', () => {
  const input = catalog();
  input.worktrees[0].worktree_id = 'feature-a-recreated';
  input.sessions[0].session_id = 'session-restarted';
  input.sessions[0].worktree_id = 'feature-a-recreated';
  input.executions[0] = { tenant_id: 'acme', execution_id: 'attempt-restarted', session_id: 'session-restarted', worktree_id: 'feature-a-recreated' };
  for (const stale of [{ worktree_id: 'feature-a' }, { session_id: 'session-a' }, { execution_id: 'attempt-a' }]) {
    assert.equal(resolveIdentity(input, { tenant_id: 'acme', ...stale }).reason, 'unknown_identity');
  }
  const current = resolveIdentity(input, { tenant_id: 'acme', execution_id: 'attempt-restarted' });
  assert.equal(current.identity.repository_id, 'api');
  assert.equal(current.identity.checkout_id, 'api-clone-a');
  assert.equal(current.identity.worktree_id, 'feature-a-recreated');
});

test('conflicting observations cannot override registered parents or source bindings', () => {
  for (const observation of [
    { worktree_id: 'feature-a', repository_id: 'web' },
    { execution_id: 'attempt-a', worktree_id: 'web-main' },
    { session_id: 'session-a', project_id: 'shared' },
    { project_id: 'product', workspace_id: 'research' },
    { checkout_id: 'api-clone-a', source_installation_id: 'connector' },
  ]) assert.equal(resolve(observation).reason, 'conflicting_evidence');
  assert.equal(resolve({ source_installation_id: 'laptop', project_id: 'shared', repository_id: 'api' }).reason, 'no_project_binding');
  assert.equal(resolve({ project_id: 'missing', repository_id: 'web' }).reason, 'unknown_identity');
});

test('tenant boundary applies to every lookup and returned evidence', () => {
  const result = resolve({ tenant_id: 'other', repository_id: 'api' });
  assert.equal(result.identity.tenant_id, 'other');
  assert.ok(result.evidence.every(item => JSON.parse(item.key)[2] === 'other'));
  assert.equal(resolve({ tenant_id: 'other', worktree_id: 'feature-a' }).reason, 'unknown_identity');
  assert.equal(resolve({ tenant_id: 'missing', project_id: 'product' }).reason, 'unknown_identity');
  const invalid = catalog(); invalid.projects[0].workspace_id = 'only-other';
  invalid.workspaces.push({ tenant_id: 'other', workspace_id: 'only-other' });
  assert.throws(() => validateIdentityCatalog(invalid), /same-tenant workspace/);
});

test('invalid catalogs reject ownership mismatches, duplicate mappings and fork cycles', () => {
  const mutations = [
    data => { data.schema_version = 2; },
    data => { data.repositories.push(structuredClone(data.repositories[0])); },
    data => { data.repositories[1].external_identity = data.repositories[0].external_identity; },
    data => { data.memberships.push({ ...data.memberships[0], membership_id: 'duplicate' }); },
    data => { data.repositories[0].fork_of_repository_id = 'api-fork'; },
    data => { data.source_installations[0].project_ids.push('notes'); },
    data => { data.source_installations[0].project_ids = []; },
    data => { data.source_installations[1].external_identity.authority = 'wrong.example'; },
    data => { data.checkouts[0].source_installation_id = 'connector'; },
    data => { data.sessions[0].source_installation_id = 'notes-host'; },
    data => { data.executions[0].repository_id = 'web'; },
    data => { data.executions[0].worktree_id = 'feature-b'; },
  ];
  for (const mutate of mutations) { const data = catalog(); mutate(data); assert.throws(() => validateIdentityCatalog(data), TypeError); }
});

test('schema rejects unknown fields and invalid values without echoing inputs', () => {
  assert.throws(() => resolve({ project: 'product' }), /unknown field/);
  assert.throws(() => resolve({ tenant_id: '' }), /invalid identifier/);
  assert.throws(() => resolve({ hints: { token: 'sensitive-value' } }), error => !error.message.includes('sensitive-value'));
  const invalid = catalog(); invalid.projects[0].attributes = { nonJson: undefined };
  assert.throws(() => validateIdentityCatalog(invalid), /acyclic JSON/);
  const unsupported = catalog(); unsupported.projects[0].attributes = new Date();
  assert.throws(() => validateIdentityCatalog(unsupported), /attributes must be an object/);
});

test('resolution is deterministic under catalog order and does not mutate caller inputs', () => {
  const input = catalog(); const snapshot = structuredClone(input);
  const observation = { tenant_id: 'acme', worktree_id: 'feature-a' };
  const first = resolveIdentity(input, observation);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(observation, { tenant_id: 'acme', worktree_id: 'feature-a' });
  for (const value of Object.values(input)) if (Array.isArray(value)) value.reverse();
  assert.deepEqual(resolveIdentity(input, observation), first);
  first.identity.project_id = 'changed';
  assert.equal(resolveIdentity(input, observation).identity.project_id, 'product');
});
