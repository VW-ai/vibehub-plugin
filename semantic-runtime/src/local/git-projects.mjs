import { execFileSync } from 'node:child_process';
import { realpathSync, statSync, existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fingerprint, sameScope } from '../core/contracts.mjs';
import { validateIdentityCatalog } from '../core/identity.mjs';
import { AccessAuthority, LOCAL_AUDIENCE } from '../domain/identity/access-authority.mjs';
import { DomainStore } from './domain-store.mjs';

export const GIT_ENROLLMENT_NAMESPACE = 'git-enrollment';
const error = code => Object.assign(new Error(`Git enrollment: ${code}`), { code });
const ownCodes = new Set(['unauthorized', 'invalid_folder', 'git_unavailable', 'git_inspection_failed',
  'unsupported_git_output', 'not_git', 'bare_repository', 'already_git', 'git_initialize_failed',
  'invalid_catalog', 'catalog_limit', 'checkout_not_found', 'continuity_declaration_required',
  'continuity_mismatch', 'discovery_changed', 'cas_conflict']);
function safe(e) { return ownCodes.has(e?.code) || /^store_|^cas_conflict$/.test(e?.code ?? '') ? e : error('git_inspection_failed'); }
function directory(path) {
  try {
    if (typeof path !== 'string' || !path || path.length > 4096 || /[\0\r\n]/.test(path)) throw error('invalid_folder');
    const result = realpathSync(resolve(path));
    if (!statSync(result).isDirectory()) throw error('invalid_folder');
    return result;
  } catch { throw error('invalid_folder'); }
}
function physical(path) {
  const s = statSync(path, { bigint: true });
  return `${s.dev}:${s.ino}:${s.birthtimeNs}`; // observed local instance, not historical certification
}
function git(path, args) {
  try {
    return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
      '-c', 'protocol.allow=never', '-c', 'init.templateDir=', '-C', path, ...args], {
      env: { PATH: process.env.PATH, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '' },
      encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) { throw error(e.code === 'ENOENT' ? 'git_unavailable' : 'git_inspection_failed'); }
}
function gitPath(folder, option) {
  const value = git(folder, ['rev-parse', '--path-format=absolute', option]).replace(/\n$/, '');
  if (!isAbsolute(value) || /[\0\r\n]/.test(value)) throw error('unsupported_git_output');
  return realpathSync(value);
}
function inspectUnchecked(folder) {
  const selected_path = directory(folder);
  let bare;
  try { bare = git(selected_path, ['rev-parse', '--is-bare-repository']).trim(); }
  catch (e) {
    if (e.code === 'git_unavailable') throw e;
    // Git's general exit code is not enough to diagnose non-Git vs corrupt metadata.
    let ancestor = selected_path;
    while (true) {
      if (existsSync(resolve(ancestor, '.git')) || existsSync(resolve(ancestor, 'HEAD')) && existsSync(resolve(ancestor, 'objects'))) throw error('git_inspection_failed');
      const parent = resolve(ancestor, '..'); if (parent === ancestor) break; ancestor = parent;
    }
    return { schema_version: 1, status: 'not_git', selected_path };
  }
  if (bare === 'true') return { schema_version: 1, status: 'bare', selected_path };
  const worktree_path = gitPath(selected_path, '--show-toplevel');
  const common_dir = gitPath(selected_path, '--git-common-dir');
  const worktrees = git(selected_path, ['worktree', 'list', '--porcelain', '-z']).split('\0\0').filter(Boolean).map(block => {
    const fields = {};
    for (const field of block.split('\0').filter(Boolean)) {
      const space = field.indexOf(' '), key = space < 0 ? field : field.slice(0, space);
      if (!['worktree', 'HEAD', 'branch', 'detached', 'bare', 'locked', 'prunable'].includes(key) || Object.hasOwn(fields, key)) throw error('unsupported_git_output');
      fields[key] = space < 0 ? true : field.slice(space + 1);
    }
    if (typeof fields.worktree !== 'string' || !isAbsolute(fields.worktree) || /[\0\r\n]/.test(fields.worktree)
      || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(fields.HEAD ?? '')) throw error('unsupported_git_output');
    let path = fields.worktree, git_dir = null, identity = null, status = 'unavailable';
    try {
      path = directory(path);
      if (gitPath(path, '--git-common-dir') !== common_dir) throw error('discovery_changed');
      git_dir = gitPath(path, '--git-dir'); identity = physical(git_dir); status = 'available';
    } catch (e) { if (e.code === 'discovery_changed') throw e; }
    return { path, git_dir, identity, head: /^0+$/.test(fields.HEAD) ? null : fields.HEAD,
      branch: typeof fields.branch === 'string' ? fields.branch : null, detached: fields.detached === true,
      unborn: /^0+$/.test(fields.HEAD), locked: fields.locked !== undefined, prunable: fields.prunable !== undefined, status };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const branches = git(selected_path, ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads/'])
    .split('\n').filter(Boolean).map(line => {
      const [name, oid, extra] = line.split('\0');
      if (!name.startsWith('refs/heads/') || /[\s\0]/.test(name) || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(oid) || extra !== undefined) throw error('unsupported_git_output');
      return { name, oid };
    }).sort((a, b) => a.name.localeCompare(b.name));
  if (worktrees.length > 128 || branches.length > 256) throw error('catalog_limit');
  const result = { schema_version: 1, status: 'git', selected_path, worktree_path, common_dir,
    common_identity: physical(common_dir), worktrees, branches };
  return { ...result, fingerprint: fingerprint(result) };
}

function inspect(folder) {
  try { return inspectUnchecked(folder); } catch (e) { throw safe(e); }
}

/** Explicit selected-folder registration. No watcher, activation or source-content read. */
export class GitProjectRegistry {
  #store; #authority;
  constructor({ store, authority }) {
    if (!(store instanceof DomainStore) || !(authority instanceof AccessAuthority)) throw error('unauthorized');
    this.#store = store; this.#authority = authority;
  }
  #grant(context, action, write = false) {
    const grant = this.#authority.inspect(context);
    if (!grant || grant.audience !== LOCAL_AUDIENCE || !grant.actions.includes(action)
      || !grant.actions.includes('store:read') || write && !grant.actions.includes('store:write')) throw error('unauthorized');
    return grant;
  }
  inspect(context, folder) {
    this.#grant(context, 'project:inspect');
    try { const result = inspect(folder); this.#grant(context, 'project:inspect'); return result; } catch (e) { throw safe(e); }
  }
  initialize(context, folder) {
    this.#grant(context, 'project:initialize', true);
    const before = inspect(folder);
    if (before.status !== 'not_git') throw error('already_git');
    this.#grant(context, 'project:initialize', true);
    if (inspect(before.selected_path).status !== 'not_git') throw error('discovery_changed');
    this.#grant(context, 'project:initialize', true);
    try { git(before.selected_path, ['init', '--quiet', '--template=', '--initial-branch=main']); }
    catch { throw error('git_initialize_failed'); }
    const result = inspect(before.selected_path);
    this.#grant(context, 'project:initialize', true); return result;
  }
  #read(context) {
    const row = this.#store.getRecord(context, GIT_ENROLLMENT_NAMESPACE, 'catalog');
    if (row) {
      const data = row.value;
      if (data?.schema_version !== 1 || typeof data.workspace_id !== 'string' || typeof data.installation_id !== 'string'
        || !Array.isArray(data.checkouts) || data.checkouts.length > 64
        || data.checkouts.some(c => !c || !['active', 'unavailable', 'removed'].includes(c.state)
          || ['repository_id', 'checkout_id', 'common_dir', 'common_identity', 'selected_path'].some(k => typeof c[k] !== 'string')
          || !Array.isArray(c.worktrees) || !Array.isArray(c.refs) || !Array.isArray(c.history)
          || c.worktrees.some(w => !w || typeof w.worktree_id !== 'string' || typeof w.path !== 'string')
          || c.refs.some(r => !r || typeof r.ref_incarnation_id !== 'string' || typeof r.name !== 'string'))) throw error('invalid_catalog');
    }
    return row;
  }
  get(context) { this.#grant(context, 'project:inspect'); return this.#read(context); }
  #expected(context, expectedVersion) {
    const row = this.#read(context);
    if ((row?.version ?? null) !== expectedVersion) throw error('cas_conflict');
    return row;
  }
  #persist(context, row, catalog, checkout, snapshot, grant, event, reused) {
    if (catalog.checkouts.length > 64 || catalog.checkouts.some(c => c.worktrees.length > 256 || c.refs.length > 512 || c.history.length > 512)) throw error('catalog_limit');
    // Recheck after discovery, before SQLite. This is not an atomic lock over external Git writers.
    if (snapshot && inspect(snapshot.selected_path).fingerprint !== snapshot.fingerprint) throw error('discovery_changed');
    this.#grant(context, 'project:enroll', true);
    const unchanged = row && fingerprint(row.value) === fingerprint(catalog);
    let version = row?.version;
    this.#store.transaction(context, tx => {
      const currentGrant = this.#grant(context, 'project:enroll', true);
      if (!sameScope(grant, currentGrant)) throw error('unauthorized');
      if ((tx.getRecord(GIT_ENROLLMENT_NAMESPACE, 'catalog')?.version ?? null) !== (row?.version ?? null)) throw error('cas_conflict');
      if (unchanged) return;
      version = tx.compareAndSwap(GIT_ENROLLMENT_NAMESPACE, 'catalog', row?.version ?? null, catalog);
      tx.appendSource(GIT_ENROLLMENT_NAMESPACE, `catalog-v${version}`, 'enrollment-change', {
        actor: grant.principal_id, checkout_id: checkout.checkout_id, catalog_version: version,
        event, catalog, observation: snapshot ?? null, assurance: 'observed', recorded_at: new Date().toISOString(),
      });
    });
    return { version, catalog, checkout_id: checkout.checkout_id, reused };
  }
  #reconcile(checkout, snapshot) {
    const gap = (kind, details) => checkout.history.push({ kind, ...details });
    const active = checkout.worktrees.filter(w => w.state !== 'removed');
    const seen = new Set();
    for (const observed of snapshot.worktrees) {
      let prior = active.find(w => w.path === observed.path);
      if (prior?.state === 'unavailable' && observed.status === 'available') {
        prior.state = 'removed'; gap('worktree_returned_after_gap', { worktree_id: prior.worktree_id, path: prior.path }); prior = null;
      }
      if (prior?.state === 'active' && observed.status === 'unavailable') {
        gap('worktree_unavailable', { worktree_id: prior.worktree_id, path: prior.path });
      }
      if (prior && observed.identity !== null && prior.identity !== null && prior.identity !== observed.identity) {
        prior.state = 'removed'; gap('worktree_replaced', { worktree_id: prior.worktree_id, path: prior.path }); prior = null;
      }
      if (!prior) {
        prior = { worktree_id: randomUUID(), ...observed, state: observed.status === 'available' ? 'active' : 'unavailable' };
        checkout.worktrees.push(prior);
      } else {
        const identity = observed.identity ?? prior.identity, git_dir = observed.git_dir ?? prior.git_dir;
        Object.assign(prior, observed, { identity, git_dir, state: observed.status === 'available' ? 'active' : 'unavailable' });
      }
      seen.add(prior.worktree_id);
    }
    for (const prior of active) if (!seen.has(prior.worktree_id) && prior.state !== 'removed') {
      prior.state = 'removed'; gap('worktree_disappeared', { worktree_id: prior.worktree_id, path: prior.path });
    }
    const refs = checkout.refs.filter(r => r.state === 'active');
    for (const prior of refs) if (!snapshot.branches.some(r => r.name === prior.name)) {
      prior.state = 'deleted'; gap('ref_disappeared', { ref_incarnation_id: prior.ref_incarnation_id, name: prior.name });
    }
    for (const branch of snapshot.branches) {
      const prior = refs.find(r => r.name === branch.name && r.state === 'active');
      if (prior) prior.oid = branch.oid;
      else checkout.refs.push({ ref_incarnation_id: randomUUID(), ...branch, state: 'active' });
    }
    checkout.state = 'active'; checkout.last_fingerprint = snapshot.fingerprint;
    checkout.assurance = 'observed'; checkout.historical_continuity = 'uncertified_between_observations';
  }
  enroll(context, { folder, expectedVersion = null } = {}) {
    const grant = this.#grant(context, 'project:enroll', true), row = this.#expected(context, expectedVersion);
    const snapshot = inspect(folder);
    if (snapshot.status !== 'git') throw error(snapshot.status === 'bare' ? 'bare_repository' : 'not_git');
    const catalog = row ? structuredClone(row.value) : { schema_version: 1, workspace_id: randomUUID(), installation_id: randomUUID(), checkouts: [] };
    let checkout = catalog.checkouts.find(c => c.common_dir === snapshot.common_dir && c.common_identity === snapshot.common_identity && c.state !== 'removed');
    const reused = Boolean(checkout);
    if (!checkout) {
      if (catalog.checkouts.some(c => c.common_identity === snapshot.common_identity && c.state !== 'removed')) throw error('continuity_declaration_required');
      for (const old of catalog.checkouts.filter(c => c.common_dir === snapshot.common_dir && c.state !== 'removed')) {
        old.state = 'removed'; old.history.push({ kind: 'checkout_replaced', common_dir: old.common_dir });
        old.worktrees.forEach(w => { w.state = 'removed'; }); old.refs.forEach(r => { r.state = 'deleted'; });
      }
      checkout = { repository_id: randomUUID(), checkout_id: randomUUID(), common_dir: snapshot.common_dir,
        common_identity: snapshot.common_identity, selected_path: snapshot.worktree_path, state: 'active', worktrees: [], refs: [], history: [] };
      catalog.checkouts.push(checkout);
    }
    if (!existsSync(checkout.selected_path)) {
      checkout.history.push({ kind: 'selected_worktree_changed', prior_path: checkout.selected_path, current_path: snapshot.worktree_path });
      checkout.selected_path = snapshot.worktree_path;
    }
    // Canonical selection keeps repeated main/linked enrollment idempotent.
    const normalized = { ...snapshot, selected_path: checkout.selected_path, worktree_path: checkout.selected_path };
    delete normalized.fingerprint;
    this.#reconcile(checkout, { ...snapshot, fingerprint: fingerprint(normalized) });
    return this.#persist(context, row, catalog, checkout, snapshot, grant, 'enrolled', reused);
  }
  refresh(context, { checkout_id, expectedVersion } = {}) {
    const grant = this.#grant(context, 'project:enroll', true), row = this.#expected(context, expectedVersion);
    const catalog = structuredClone(row?.value), checkout = catalog?.checkouts.find(c => c.checkout_id === checkout_id && c.state !== 'removed');
    if (!checkout) throw error('checkout_not_found');
    if (!existsSync(checkout.selected_path)) {
      // A feature worktree may be deleted while already enrolled siblings live on.
      // Only try those known paths; common/admin identity must still agree.
      for (const known of checkout.worktrees.filter(w => w.state === 'active' && w.path !== checkout.selected_path && existsSync(w.path))) {
        let survivor;
        try { survivor = inspect(known.path); } catch { continue; }
        if (survivor.status !== 'git' || survivor.common_dir !== checkout.common_dir
          || survivor.common_identity !== checkout.common_identity
          || !survivor.worktrees.some(w => w.path === known.path && w.identity !== null && w.identity === known.identity)) continue;
        checkout.history.push({ kind: 'selected_worktree_changed', prior_path: checkout.selected_path, current_path: survivor.worktree_path });
        checkout.selected_path = survivor.worktree_path;
        this.#reconcile(checkout, survivor);
        return this.#persist(context, row, catalog, checkout, survivor, grant, 'refreshed', true);
      }
      if (checkout.state !== 'unavailable') checkout.history.push({ kind: 'checkout_unavailable', common_dir: checkout.common_dir });
      checkout.state = 'unavailable';
      for (const worktree of checkout.worktrees.filter(w => w.path === checkout.selected_path && w.state === 'active')) {
        worktree.state = 'unavailable'; checkout.history.push({ kind: 'worktree_unavailable', worktree_id: worktree.worktree_id, path: worktree.path });
      }
      return this.#persist(context, row, catalog, checkout, null, grant, 'unavailable', true);
    }
    const snapshot = inspect(checkout.selected_path);
    if (snapshot.status !== 'git' || snapshot.common_dir !== checkout.common_dir || snapshot.common_identity !== checkout.common_identity) throw error('continuity_mismatch');
    this.#reconcile(checkout, snapshot);
    return this.#persist(context, row, catalog, checkout, snapshot, grant, 'refreshed', true);
  }
  associateMove(context, { checkout_id, prior_path, folder, expectedVersion } = {}) {
    const grant = this.#grant(context, 'project:enroll', true), row = this.#expected(context, expectedVersion);
    const catalog = structuredClone(row?.value), checkout = catalog?.checkouts.find(c => c.checkout_id === checkout_id && c.state !== 'removed');
    if (!checkout || checkout.selected_path !== prior_path) throw error('checkout_not_found');
    const snapshot = inspect(folder);
    if (snapshot.status !== 'git' || snapshot.common_identity !== checkout.common_identity) throw error('continuity_mismatch');
    const other = catalog.checkouts.find(c => c.checkout_id !== checkout_id && c.common_dir === snapshot.common_dir && c.state !== 'removed');
    if (other) throw error('continuity_mismatch');
    for (const worktree of checkout.worktrees.filter(w => w.state !== 'removed')) {
      const moved = snapshot.worktrees.find(w => w.identity !== null && w.identity === worktree.identity);
      if (moved) Object.assign(worktree, moved);
    }
    checkout.history.push({ kind: 'operator_declared_move', actor: grant.principal_id, prior_path,
      current_path: snapshot.worktree_path, prior_common_dir: checkout.common_dir, current_common_dir: snapshot.common_dir });
    checkout.selected_path = snapshot.worktree_path; checkout.common_dir = snapshot.common_dir;
    this.#reconcile(checkout, snapshot);
    return this.#persist(context, row, catalog, checkout, snapshot, grant, 'operator_declared_move', true);
  }
  identityCatalog(context) {
    const grant = this.#grant(context, 'project:inspect'), row = this.#read(context);
    if (!row) return null;
    const data = row.value, scope = { tenant_id: grant.tenant_id, project_id: grant.project_id };
    const active = data.checkouts.filter(c => c.state === 'active');
    const catalog = {
      schema_version: 1,
      tenants: [{ tenant_id: scope.tenant_id }], workspaces: [{ tenant_id: scope.tenant_id, workspace_id: data.workspace_id }],
      projects: [{ ...scope, workspace_id: data.workspace_id }],
      repositories: active.map(c => ({ tenant_id: scope.tenant_id, repository_id: c.repository_id })),
      memberships: active.map(c => ({ ...scope, membership_id: c.repository_id, repository_id: c.repository_id })),
      source_installations: [{ tenant_id: scope.tenant_id, workspace_id: data.workspace_id, source_installation_id: data.installation_id,
        kind: 'local', external_identity: { provider: 'vibehub', authority: 'local', object_id: data.installation_id },
        project_ids: [scope.project_id], membership_ids: active.map(c => c.repository_id) }],
      checkouts: active.map(c => ({ tenant_id: scope.tenant_id, checkout_id: c.checkout_id, repository_id: c.repository_id, source_installation_id: data.installation_id })),
      worktrees: active.flatMap(c => c.worktrees.filter(w => w.state === 'active').map(w => ({ tenant_id: scope.tenant_id,
        worktree_id: w.worktree_id, checkout_id: c.checkout_id, attributes: { path: w.path, branch: w.branch } }))),
      sessions: [], executions: [],
    };
    validateIdentityCatalog(catalog); return catalog;
  }
}
