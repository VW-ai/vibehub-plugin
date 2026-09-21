/** Pure identity contract. The caller supplies an authenticated, current catalog. */
export const IDENTITY_CONTRACT_VERSION = 1;

const TYPES = {
  tenant: ['tenants', 'tenant_id', []],
  workspace: ['workspaces', 'workspace_id', []],
  project: ['projects', 'project_id', ['workspace_id']],
  repository: ['repositories', 'repository_id', []],
  membership: ['memberships', 'membership_id', ['project_id', 'repository_id']],
  source_installation: ['source_installations', 'source_installation_id', ['workspace_id']],
  checkout: ['checkouts', 'checkout_id', ['repository_id', 'source_installation_id']],
  worktree: ['worktrees', 'worktree_id', ['checkout_id']],
  session: ['sessions', 'session_id', ['project_id', 'source_installation_id']],
  execution: ['executions', 'execution_id', ['session_id']],
};
const OPTIONAL = {
  repository: ['external_identity', 'fork_of_repository_id'],
  source_installation: ['kind', 'external_identity', 'project_ids', 'membership_ids'],
  session: ['worktree_id'],
  execution: ['repository_id', 'worktree_id'],
};
const FIELDS = Object.fromEntries(Object.entries(TYPES).map(([kind, [, id]]) => [id, kind]));
const fail = message => { throw new TypeError(`Identity contract: ${message}`); };
const assert = (condition, message) => { if (!condition) fail(message); };
const compareJson = (left, right) => {
  const a = JSON.stringify(left); const b = JSON.stringify(right);
  return a < b ? -1 : a > b ? 1 : 0;
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function id(value) {
  assert(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/.test(value), 'invalid identifier');
  return value;
}
function exactFields(value, allowed) {
  assert(object(value), 'expected plain object');
  assert(Object.keys(value).every(field => allowed.includes(field)), 'unknown field');
}
function externalIdentity(value) {
  exactFields(value, ['provider', 'authority', 'object_id']);
  for (const field of ['provider', 'authority', 'object_id']) id(value[field]);
  return JSON.stringify([value.provider, value.authority, value.object_id]);
}
function jsonValue(value, ancestors = new Set()) {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') { assert(value.length <= 8192, 'attribute string too long'); return; }
  if (typeof value === 'number') { assert(Number.isFinite(value), 'non-finite attribute'); return; }
  assert((Array.isArray(value) || object(value)) && !ancestors.has(value), 'attributes must be acyclic JSON');
  assert(ancestors.size < 16, 'attributes too deep');
  ancestors.add(value);
  for (const item of Object.values(value)) jsonValue(item, ancestors);
  ancestors.delete(value);
}

/** Collision-free tenant-scoped key; never use paths, remote URLs or branch names. */
export function identityKey(kind, tenantId, entityId) {
  assert(Object.hasOwn(TYPES, kind), 'unknown kind');
  id(tenantId); id(entityId);
  assert(kind !== 'tenant' || tenantId === entityId, 'tenant key must identify its own tenant');
  return JSON.stringify([IDENTITY_CONTRACT_VERSION, kind, tenantId, entityId]);
}

function buildIndex(catalog) {
  exactFields(catalog, ['schema_version', ...Object.values(TYPES).map(([collection]) => collection)]);
  assert(catalog.schema_version === IDENTITY_CONTRACT_VERSION, 'unsupported schema_version');
  const index = new Map();
  const externalKeys = new Set();
  for (const [kind, [collection, field, required]] of Object.entries(TYPES)) {
    assert(Array.isArray(catalog[collection]), `missing ${collection} array`);
    for (const record of catalog[collection]) {
      exactFields(record, ['tenant_id', field, ...required, ...(OPTIONAL[kind] ?? []), 'attributes']);
      id(record.tenant_id); id(record[field]);
      for (const parent of required) id(record[parent]);
      for (const parent of OPTIONAL[kind] ?? []) {
        if (parent.endsWith('_id') && record[parent] !== undefined) id(record[parent]);
      }
      if (record.attributes !== undefined) { assert(object(record.attributes), 'attributes must be an object'); jsonValue(record.attributes); }
      const key = identityKey(kind, record.tenant_id, record[field]);
      assert(!index.has(key), 'duplicate tenant-scoped key'); index.set(key, record);
      if (record.external_identity !== undefined) {
        const externalKey = JSON.stringify([record.tenant_id, kind, externalIdentity(record.external_identity)]);
        assert(!externalKeys.has(externalKey), 'duplicate external identity'); externalKeys.add(externalKey);
      }
      if (kind === 'source_installation') {
        assert(['local', 'connector'].includes(record.kind), 'invalid source installation kind');
        externalIdentity(record.external_identity);
        assert(Array.isArray(record.membership_ids) && new Set(record.membership_ids).size === record.membership_ids.length,
          'invalid source membership bindings');
        record.membership_ids.forEach(id);
        assert(Array.isArray(record.project_ids) && new Set(record.project_ids).size === record.project_ids.length,
          'invalid source project bindings');
        record.project_ids.forEach(id);
      }
    }
  }
  const get = (kind, tenant, value) => {
    const result = index.get(identityKey(kind, tenant, value));
    assert(result, `unknown same-tenant ${kind} reference`); return result;
  };
  const membershipFor = (tenant, project, repository) => catalog.memberships.find(record =>
    record.tenant_id === tenant && record.project_id === project && record.repository_id === repository);
  const sourceAllows = (source, membership) => membership && source.membership_ids.includes(membership.membership_id);
  const pairs = new Set();
  for (const [kind, [collection, field, parents]] of Object.entries(TYPES)) {
    for (const record of catalog[collection]) {
      const tenant = record.tenant_id;
      get('tenant', tenant, tenant);
      for (const parent of parents) get(FIELDS[parent], tenant, record[parent]);
      if (kind === 'repository' && record.fork_of_repository_id !== undefined) {
        const visited = new Set([record[field]]);
        let current = record;
        while (current.fork_of_repository_id !== undefined) {
          assert(!visited.has(current.fork_of_repository_id), 'fork relationship cycle');
          visited.add(current.fork_of_repository_id);
          current = get('repository', tenant, current.fork_of_repository_id);
        }
      }
      if (kind === 'membership') {
        const pair = JSON.stringify([tenant, record.project_id, record.repository_id]);
        assert(!pairs.has(pair), 'duplicate project repository membership'); pairs.add(pair);
      }
      if (kind === 'source_installation') {
        for (const projectId of record.project_ids) {
          assert(get('project', tenant, projectId).workspace_id === record.workspace_id, 'source binding crosses workspace');
        }
        for (const memberId of record.membership_ids) {
          const membership = get('membership', tenant, memberId);
          assert(get('project', tenant, membership.project_id).workspace_id === record.workspace_id,
            'source binding crosses workspace');
          assert(record.project_ids.includes(membership.project_id), 'source membership lacks project binding');
          const repository = get('repository', tenant, membership.repository_id);
          if (record.kind === 'connector') {
            assert(repository.external_identity?.provider === record.external_identity.provider
              && repository.external_identity?.authority === record.external_identity.authority,
            'connector repository differs from provider authority');
          }
        }
      }
      if (kind === 'checkout') {
        const source = get('source_installation', tenant, record.source_installation_id);
        assert(source.kind === 'local', 'checkout requires local source installation');
        assert(source.membership_ids.some(memberId => get('membership', tenant, memberId).repository_id === record.repository_id),
          'checkout repository is not bound to source');
      }
      if (kind === 'session' || kind === 'execution') {
        const session = kind === 'session' ? record : get('session', tenant, record.session_id);
        const source = get('source_installation', tenant, session.source_installation_id);
        const project = get('project', tenant, session.project_id);
        assert(source.workspace_id === project.workspace_id, 'session source crosses workspace');
        assert(source.project_ids.includes(project.project_id), 'session project is not bound to source');
        if (record.repository_id !== undefined) {
          get('repository', tenant, record.repository_id);
          assert(sourceAllows(source, membershipFor(tenant, project.project_id, record.repository_id)),
            'execution repository is not a bound project member');
        }
        if (record.worktree_id !== undefined) {
          const worktree = get('worktree', tenant, record.worktree_id);
          const checkout = get('checkout', tenant, worktree.checkout_id);
          assert(checkout.source_installation_id === source.source_installation_id, 'worktree source differs from session');
          assert(sourceAllows(source, membershipFor(tenant, project.project_id, checkout.repository_id)),
            'worktree repository is not a bound project member');
          assert(record.repository_id === undefined || record.repository_id === checkout.repository_id,
            'execution repository differs from worktree');
          assert(kind !== 'execution' || session.worktree_id === undefined || session.worktree_id === record.worktree_id,
            'execution worktree differs from session');
        }
        if (kind === 'execution' && record.repository_id !== undefined && session.worktree_id !== undefined) {
          const checkout = get('checkout', tenant, get('worktree', tenant, session.worktree_id).checkout_id);
          assert(checkout.repository_id === record.repository_id, 'execution repository differs from session worktree');
        }
      }
    }
  }
  return index;
}

/** Validate the complete active catalog; returns true, or throws TypeError. */
export function validateIdentityCatalog(catalog) { buildIndex(catalog); return true; }

/**
 * Resolve registered facts, never fuzzy path/URL/name matches. This is identity
 * resolution, not authentication or access authorization. Inputs are not mutated.
 */
export function resolveIdentity(catalog, observation) {
  const index = buildIndex(catalog);
  exactFields(observation, [...Object.keys(FIELDS), 'external_repository', 'hints']);
  id(observation.tenant_id);
  for (const field of Object.keys(FIELDS)) if (observation[field] !== undefined) id(observation[field]);
  if (observation.external_repository !== undefined) externalIdentity(observation.external_repository);
  if (observation.hints !== undefined) {
    exactFields(observation.hints, ['path', 'remote_url', 'branch', 'name']);
    for (const value of Object.values(observation.hints)) assert(typeof value === 'string' && value.length <= 8192, 'invalid hint');
  }
  const tenant = observation.tenant_id;
  const facts = { tenant_id: tenant };
  const evidence = [];
  const visited = new Set();
  let conflict = false;
  let unknown = false;
  const result = (status, reason, candidates = []) => ({
    schema_version: IDENTITY_CONTRACT_VERSION, status, reason,
    identity: status === 'resolved' ? { ...facts } : null,
    confidence: status === 'resolved' ? 'exact' : 'none',
    evidence: [...evidence].sort(compareJson),
    candidates: candidates.sort(compareJson),
    ignored_hints: Object.keys(observation.hints ?? {}).sort(),
  });
  const visit = (kind, entityId, basis) => {
    const key = identityKey(kind, tenant, entityId);
    const record = index.get(key);
    if (!record) { unknown = true; return; }
    const [, field, parents] = TYPES[kind];
    if (facts[field] !== undefined && facts[field] !== entityId) conflict = true;
    else facts[field] = entityId;
    if (!evidence.some(item => item.key === key && item.basis === basis)) evidence.push({ basis, kind, key });
    if (visited.has(key)) return;
    visited.add(key);
    for (const parent of parents) visit(FIELDS[parent], record[parent], 'registered_parent');
    if (['session', 'execution'].includes(kind)) {
      for (const parent of ['repository_id', 'worktree_id']) {
        if (record[parent] !== undefined) visit(FIELDS[parent], record[parent], 'registered_parent');
      }
    }
  };
  for (const [field, kind] of Object.entries(FIELDS)) {
    if (observation[field] !== undefined) visit(kind, observation[field], 'registered_id');
  }
  if (unknown) return result('unmapped', 'unknown_identity');
  if (conflict) return result('ambiguous', 'conflicting_evidence');
  const source = facts.source_installation_id === undefined ? null
    : index.get(identityKey('source_installation', tenant, facts.source_installation_id));
  if (observation.external_repository !== undefined) {
    if (!source) return result('unmapped', 'missing_source_installation');
    const externalKey = externalIdentity(observation.external_repository);
    const repository = catalog.repositories.find(record => record.tenant_id === tenant
      && record.external_identity !== undefined && externalIdentity(record.external_identity) === externalKey);
    if (!repository) return result('unmapped', 'unknown_external_repository');
    visit('repository', repository.repository_id, 'external_repository');
    if (conflict) return result('ambiguous', 'conflicting_evidence');
  }
  const members = catalog.memberships.filter(record => record.tenant_id === tenant
    && (facts.repository_id === undefined || record.repository_id === facts.repository_id)
    && (facts.project_id === undefined || record.project_id === facts.project_id)
    && (facts.membership_id === undefined || record.membership_id === facts.membership_id)
    && (facts.workspace_id === undefined || index.get(identityKey('project', tenant, record.project_id)).workspace_id === facts.workspace_id)
    && (!source || source.membership_ids.includes(record.membership_id)));
  if (facts.repository_id !== undefined || source) {
    const projects = (facts.repository_id === undefined && source
      ? source.project_ids.filter(projectId => facts.project_id === undefined || facts.project_id === projectId)
      : [...new Set(members.map(member => member.project_id))]).sort();
    if (projects.length === 0) return result('unmapped', 'no_project_binding');
    if (projects.length > 1) {
      const candidates = projects.map(projectId => ({ tenant_id: tenant,
        workspace_id: index.get(identityKey('project', tenant, projectId)).workspace_id, project_id: projectId,
        ...(facts.repository_id === undefined ? {} : { repository_id: facts.repository_id }) }));
      return result('ambiguous', 'multiple_project_bindings', candidates);
    }
    visit('project', projects[0], source ? 'source_binding' : 'project_membership');
    // A project/source can span many repositories. Never select one merely
    // because a current snapshot happens to contain only one membership.
    if (facts.repository_id !== undefined) {
      visit('membership', members[0].membership_id, source ? 'source_binding' : 'project_membership');
    }
  }
  if (facts.project_id === undefined) return result('unmapped', 'insufficient_identity');
  return result('resolved', 'registered_mapping');
}
