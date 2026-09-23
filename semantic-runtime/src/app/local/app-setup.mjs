import { createHash, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DomainStore, migrateDomainStore } from '../../adapters/sqlite/domain-store.mjs';
import { AccessAuthority, LOCAL_AUDIENCE } from '../../domain/identity/access-authority.mjs';
import { scopedReference } from '../../domain/identity/service-access.mjs';
import { GitProjectRegistry, GIT_ENROLLMENT_NAMESPACE } from '../../adapters/git/git-projects.mjs';
import { ProjectActivation, ACTIVATION_NAMESPACE } from '../../application/project/project-activation.mjs';
import { ProviderSettings, PROVIDER_MODELS, validateProviderConfig } from '../../adapters/providers/provider-settings.mjs';
import { MacOSSecretStore } from '../../adapters/secrets/macos-secret-store.mjs';

export const SETUP_ERROR_CODES = Object.freeze(['setup_unauthorized', 'setup_closed', 'setup_busy', 'setup_failed',
  'invalid_setup_input', 'invalid_setup_catalog', 'project_not_found', 'project_limit', 'preview_expired',
  'preview_changed', 'enrollment_incomplete', 'invalid_folder', 'not_git', 'bare_repository', 'already_git',
  'git_unavailable', 'git_inspection_failed', 'git_initialize_failed', 'unsupported_git_output', 'catalog_limit',
  'checkout_not_found', 'continuity_mismatch', 'discovery_changed', 'cas_conflict', 'project_not_enrolled',
  'invalid_activation_state', 'activation_epoch_exhausted', 'secure_store_unavailable', 'settings_store_unavailable',
  'invalid_config', 'unsupported_provider', 'unsupported_model', 'unsupported_capability', 'invalid_fallbacks',
  'invalid_timeout', 'invalid_attempts', 'invalid_credential', 'store_unavailable', 'store_busy']);
const knownCodes = new Set(SETUP_ERROR_CODES);
const fail = code => Object.assign(new Error(`App setup: ${code}`), { code });
const safe = error => fail(knownCodes.has(error?.code) ? error.code : 'setup_failed');
const NS = 'app-setup';
const TENANT = 'local-owner';
const CONTROL = 'app-control';
const OWNER = 'local-owner';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id = value => typeof value === 'string' && /^project-[a-f0-9-]{36}$/.test(value);
const publicProject = ({ project_id, name, folder, state, error }) => ({ project_id, name, folder, state, error });
const fields = {
  'projects.list': [], 'folder.inspect': ['folder'], 'folder.initialize': ['preview_id'],
  'projects.enroll': ['preview_id', 'name'], 'projects.retry': ['project_id'],
  'project.read': ['project_id'], 'project.refresh': ['project_id', 'checkout_id', 'expectedVersion'],
  'project.activation': ['project_id', 'enabled', 'expectedVersion'],
  'provider.configure': ['project_id', 'config'], 'provider.replace': ['project_id', 'provider', 'secret'],
  'provider.remove': ['project_id', 'provider'],
};
function exact(action, input) {
  if (!Object.hasOwn(fields, action) || !input || Object.getPrototypeOf(input) !== Object.prototype
    || Object.keys(input).length !== fields[action].length || !fields[action].every(k => Object.hasOwn(input, k))) throw fail('invalid_setup_input');
  if (Object.hasOwn(input, 'project_id') && !id(input.project_id)) throw fail('project_not_found');
  if (Object.hasOwn(input, 'expectedVersion') && input.expectedVersion !== null
    && (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)) throw fail('invalid_setup_input');
  if (Object.hasOwn(input, 'provider') && !Object.hasOwn(PROVIDER_MODELS, input.provider)) throw fail('unsupported_provider');
  if (Object.hasOwn(input, 'enabled') && typeof input.enabled !== 'boolean') throw fail('invalid_setup_input');
  if (action === 'project.refresh' && (typeof input.checkout_id !== 'string' || input.checkout_id.length > 200)) throw fail('invalid_setup_input');
  if (action === 'provider.configure') validateProviderConfig(input.config);
  if (action === 'provider.replace' && (typeof input.secret !== 'string' || !input.secret.length
    || Buffer.byteLength(input.secret) > 8192 || /[\r\n\0]/.test(input.secret))) throw fail('invalid_credential');
}
/** Collision-safe tuple binding; this is a local config key, never a secret reference. */
export const setupProviderKey = (tenant, project) => `project-${hash([tenant, project])}`;

/** Small owner-only setup composition. No collectors, model dispatch or generic store port. */
export class LocalAppSetup {
  #auth; #store; #git; #activation; #providers; #now; #fault;
  #previews = new WeakMap(); #pending = Promise.resolve(); #queued = 0; #closing = false; #close;
  #providerGuard = () => { throw fail('setup_unauthorized'); };
  #ownerGuard = () => { throw fail('setup_unauthorized'); };
  #ownerExpiry = 0;
  constructor({ dataDir, authority, secretStore, now = Date.now, fault = () => {} }) {
    if (!(authority instanceof AccessAuthority) || typeof dataDir !== 'string' || !dataDir
      || typeof now !== 'function' || typeof fault !== 'function') throw fail('invalid_setup_input');
    this.#auth = authority; this.#now = now; this.#fault = fault;
    try {
      // Explicit setup mode owns these two files; no implicit migration of other stores.
      const filePath = join(dataDir, 'setup.sqlite');
      migrateDomainStore({ filePath });
      this.#store = new DomainStore({ filePath, authority, namespaces: [NS, GIT_ENROLLMENT_NAMESPACE, ACTIVATION_NAMESPACE] });
      this.#git = new GitProjectRegistry({ store: this.#store, authority });
      this.#activation = new ProjectActivation({ store: this.#store, authority, now });
      this.#providers = new ProviderSettings({ filePath: join(dataDir, 'providers.sqlite'),
        secretStore: secretStore ?? new MacOSSecretStore({ buildDir: join(dataDir, 'keychain') }),
        beforeDispatch: () => this.#providerGuard() });
    } catch (error) { this.#store?.close(); throw safe(error); }
  }
  #capabilities() {
    return { secure_store: process.platform === 'darwin' ? 'macos-keychain' : 'unsupported',
      plugins: 'not_connected', workers: 'not_connected', models: 'unverified' };
  }
  #with(project, actions, operation) {
    this.#ownerGuard();
    const scope = { tenant_id: TENANT, project_id: project };
    const ttl_ms = Math.min(60_000, this.#ownerExpiry - this.#now() - 1);
    if (!Number.isSafeInteger(ttl_ms) || ttl_ms < 1) throw fail('setup_unauthorized');
    const issued = this.#auth.issue({ principal_id: OWNER, kind: 'human', scope, actions, ttl_ms });
    try {
      if (issued.expires_at > this.#ownerExpiry) throw fail('setup_unauthorized');
      const result = this.#auth.authorize(issued.credential, { scope, audience: LOCAL_AUDIENCE, action: actions[0],
        kinds: ['human'], boundary: 'http', reference: scopedReference('http', scope, 'setup') });
      if (!result.allowed) throw fail('setup_unauthorized');
      try { return operation(result.context); }
      catch (error) { this.#ownerGuard(); throw error; }
    } finally { this.#auth.revoke(issued.credential_id); }
  }
  #catalog() {
    return this.#with(CONTROL, ['store:read'], context => {
      const row = this.#store.getRecord(context, NS, 'projects');
      if (!row) return { version: null, value: { schema_version: 1, projects: [] } };
      const data = row.value;
      if (data?.schema_version !== 1 || !Array.isArray(data.projects) || data.projects.length > 64
        || new Set(data.projects.map(p => p?.project_id)).size !== data.projects.length
        || data.projects.some(p => !p || !id(p.project_id) || typeof p.name !== 'string' || !p.name || p.name.length > 80
          || typeof p.folder !== 'string' || !isAbsolute(p.folder) || p.folder.length > 4096
          || !['reserved', 'enrolling', 'ready', 'error'].includes(p.state)
          || typeof p.common_identity !== 'string' || typeof p.common_dir !== 'string'
          || typeof p.fingerprint !== 'string' || p.error !== null && !knownCodes.has(p.error))) throw fail('invalid_setup_catalog');
      return row;
    });
  }
  #updateCatalog(row, projects) {
    return this.#with(CONTROL, ['store:read', 'store:write'], context => this.#store.transaction(context,
      tx => tx.compareAndSwap(NS, 'projects', row.version, { schema_version: 1, projects })));
  }
  #project(project) {
    const p = this.#catalog().value.projects.find(p => p.project_id === project);
    if (!p) throw fail('project_not_found');
    return p;
  }
  #state(project, state, error = null) {
    const row = this.#catalog();
    const target = row.value.projects.find(p => p.project_id === project);
    if (!target) throw fail('project_not_found');
    if (target.state === state && target.error === error) return;
    this.#updateCatalog(row, row.value.projects.map(p => p === target ? { ...p, state, error } : p));
  }
  #gitRead(project) {
    return this.#with(project, ['project:inspect', 'store:read'], context => this.#git.get(context));
  }
  #reconcile(project) {
    const p = this.#project(project), row = this.#gitRead(project);
    if (row && !row.value.checkouts.some(c => c.common_identity === p.common_identity && c.common_dir === p.common_dir)) throw fail('invalid_setup_catalog');
    if (row && p.state !== 'ready') this.#state(project, 'ready');
    return row;
  }
  #inspect(folder) {
    if (typeof folder !== 'string' || !isAbsolute(folder) || folder.length > 4096 || /[\0\r\n]/.test(folder)) throw fail('invalid_folder');
    return this.#with(CONTROL, ['project:inspect', 'store:read'], context => this.#git.inspect(context, folder));
  }
  #previewHash(inspection) {
    // Non-Git paths have no repository fingerprint, so also bind the physical folder.
    const s = statSync(inspection.selected_path, { bigint: true });
    return hash([inspection, `${s.dev}:${s.ino}:${s.birthtimeNs}`]);
  }
  #preview(owner, folder, inspection) {
    const item = { preview_id: randomUUID(), folder, inspection, hash: this.#previewHash(inspection), expires: this.#now() + 120_000 };
    this.#previews.set(owner, item);
    return { preview_id: item.preview_id, inspection };
  }
  #takePreview(owner, previewId) {
    const item = this.#previews.get(owner);
    if (!item || item.preview_id !== previewId || item.expires <= this.#now()) throw fail('preview_expired');
    this.#previews.delete(owner);
    if (this.#previewHash(this.#inspect(item.folder)) !== item.hash) throw fail('preview_changed');
    return item;
  }
  #finishEnrollment(project, check) {
    const p = this.#project(project);
    if (this.#reconcile(project)) return { project_id: project, reused: true };
    try {
      const inspection = this.#inspect(p.folder);
      if (inspection.status !== 'git' || inspection.fingerprint !== p.fingerprint
        || inspection.common_identity !== p.common_identity || inspection.common_dir !== p.common_dir) throw fail('preview_changed');
      check(); this.#state(project, 'enrolling'); this.#fault('before_enrollment'); check();
      this.#with(project, ['project:enroll', 'project:inspect', 'store:read', 'store:write'], context =>
        this.#git.enroll(context, { folder: p.folder, expectedVersion: null }));
      this.#fault('after_enrollment'); check();
      this.#state(project, 'ready'); return { project_id: project, reused: false };
    } catch (error) {
      // Persist only a bounded diagnostic. Never undo Git or choose another Project.
      try { check(); this.#state(project, 'error', safe(error).code); } catch {}
      throw error;
    }
  }
  execute(action, input, assertOwner) {
    let owner;
    try {
      if (this.#closing) throw fail('setup_closed');
      if (typeof assertOwner !== 'function') throw fail('setup_unauthorized');
      try { owner = assertOwner(); } catch { throw fail('setup_unauthorized'); }
      if (!owner || typeof owner !== 'object' || !Number.isSafeInteger(owner.expires_at)
        || owner.expires_at <= this.#now()) throw fail('setup_unauthorized');
      exact(action, input);
      if (this.#queued >= 32) throw fail('setup_busy');
    } catch (error) { return Promise.reject(safe(error)); }
    // Copy typed input: callers cannot change a queued target or key after admission.
    const values = structuredClone(input);
    const ownerCheck = () => {
      if (this.#closing) throw fail('setup_closed');
      try { if (assertOwner() !== owner || owner.expires_at <= this.#now()) throw fail('setup_unauthorized'); } catch { throw fail('setup_unauthorized'); }
    };
    const check = () => {
      ownerCheck();
      if (Object.hasOwn(values, 'project_id')) this.#project(values.project_id);
    };
    this.#queued++;
    const operation = this.#pending.then(async () => {
      this.#ownerExpiry = owner.expires_at;
      this.#ownerGuard = ownerCheck;
      try {
        check(); this.#providerGuard = check;
        const result = await this.#execute(action, values, owner, check); check(); return result;
      }
      finally { this.#providerGuard = this.#ownerGuard = () => { throw fail('setup_unauthorized'); }; this.#ownerExpiry = 0; }
    }).catch(error => { throw safe(error); }).finally(() => { values.secret = undefined; this.#queued--; });
    this.#pending = operation.catch(() => {});
    return operation;
  }
  async #execute(action, input, owner, check) {
    const project = input.project_id;
    if (action === 'projects.list') {
      for (const p of this.#catalog().value.projects) if (p.state !== 'ready') this.#reconcile(p.project_id);
      return { projects: this.#catalog().value.projects.map(publicProject), capabilities: this.#capabilities() };
    }
    if (action === 'folder.inspect') return this.#preview(owner, input.folder, this.#inspect(input.folder));
    if (action === 'folder.initialize') {
      const preview = this.#takePreview(owner, input.preview_id); check();
      const inspection = this.#with(CONTROL, ['project:initialize', 'store:read', 'store:write'], context =>
        this.#git.initialize(context, preview.folder));
      return this.#preview(owner, preview.folder, inspection);
    }
    if (action === 'projects.enroll') {
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80 || /[\0\r\n]/.test(input.name)) throw fail('invalid_setup_input');
      const { inspection } = this.#takePreview(owner, input.preview_id);
      if (inspection.status !== 'git') throw fail(inspection.status === 'bare' ? 'bare_repository' : 'not_git');
      const row = this.#catalog(), prior = row.value.projects.find(p => p.common_identity === inspection.common_identity);
      if (prior) {
        if (prior.common_dir !== inspection.common_dir) throw fail('continuity_mismatch');
        if (prior.state === 'ready' || this.#reconcile(prior.project_id)) return { project_id: prior.project_id, reused: true };
        // A fresh explicit preview may renew the base of an unstarted attempt,
        // but must never redirect its already allocated Project to another folder.
        if (prior.folder !== inspection.selected_path) throw fail('preview_changed');
        this.#updateCatalog(row, row.value.projects.map(p => p === prior ? { ...p, fingerprint: inspection.fingerprint } : p));
        return this.#finishEnrollment(prior.project_id, check);
      }
      if (row.value.projects.length >= 64) throw fail('project_limit');
      const p = { project_id: `project-${randomUUID()}`, name: input.name.trim(), folder: inspection.selected_path,
        common_identity: inspection.common_identity, common_dir: inspection.common_dir, fingerprint: inspection.fingerprint,
        state: 'reserved', error: null };
      check(); this.#updateCatalog(row, [...row.value.projects, p]);
      this.#fault('after_reservation');
      return this.#finishEnrollment(p.project_id, check);
    }
    if (action === 'projects.retry') return this.#finishEnrollment(project, check);
    if (action === 'project.refresh') return this.#with(project, ['project:enroll', 'project:inspect', 'store:read', 'store:write'],
      context => this.#git.refresh(context, { checkout_id: input.checkout_id, expectedVersion: input.expectedVersion }));
    if (action === 'project.activation') {
      if (input.enabled) {
        // Explicit enable refreshes only known checkouts; a missing path cannot look enabled-ready.
        const row = this.#gitRead(project);
        if (!row) throw fail('project_not_enrolled');
        for (const c of row.value.checkouts.filter(c => c.state !== 'removed')) {
          const current = this.#gitRead(project); check();
          this.#with(project, ['project:enroll', 'project:inspect', 'store:read', 'store:write'], context =>
            this.#git.refresh(context, { checkout_id: c.checkout_id, expectedVersion: current.version }));
        }
      }
      check();
      return this.#with(project, ['activation:write', 'project:inspect', 'store:read', 'store:write'],
        context => this.#activation.setEnabled(context, { enabled: input.enabled, expectedVersion: input.expectedVersion }));
    }
    const key = setupProviderKey(TENANT, project);
    if (action === 'provider.configure') return this.#providers.configure(key, input.config);
    if (action === 'provider.replace') return this.#providers.replaceCredential(key, input.provider, input.secret);
    if (action === 'provider.remove') return this.#providers.removeCredential(key, input.provider);
    if (action === 'project.read') {
      const p = this.#project(project), git = this.#gitRead(project);
      const activation = this.#with(project, ['activation:read', 'store:read'], context => this.#activation.get(context));
      const config = this.#providers.getConfig(key), statuses = {};
      for (const provider of Object.keys(PROVIDER_MODELS)) { check(); statuses[provider] = await this.#providers.credentialStatus(key, provider); }
      return { project: publicProject(p), git, activation, providers: { config, statuses, verified: false }, capabilities: this.#capabilities() };
    }
    throw fail('invalid_setup_input');
  }
  close() {
    this.#closing = true;
    this.#close ??= this.#pending.then(async () => { await this.#providers.close(); this.#store.close(); this.#previews = new WeakMap(); });
    return this.#close;
  }
}
