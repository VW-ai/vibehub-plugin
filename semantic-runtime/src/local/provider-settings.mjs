import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export const PROVIDER_MODELS = Object.freeze({
  openrouter: 'typesafe/jev-1.13', vercel: 'typesafe-ai/jev', typesafe: 'jev-latest',
});
export const JUDGE_CAPABILITY = 'semantic-judge-v0';
const APP_ID = 0x56485053;
const fail = code => Object.assign(new Error(`Provider settings: ${code}`), { code });
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
function exact(value, keys) {
  if (!plain(value) || Object.keys(value).some(key => !keys.includes(key))) throw fail('invalid_config');
}
function project(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw fail('invalid_project');
  return value;
}
function provider(value) {
  if (!Object.hasOwn(PROVIDER_MODELS, value)) throw fail('unsupported_provider');
  return value;
}
function route(value) {
  exact(value, ['provider', 'model', 'capability']);
  provider(value.provider);
  if (value.model !== PROVIDER_MODELS[value.provider]) throw fail('unsupported_model');
  if (value.capability !== JUDGE_CAPABILITY) throw fail('unsupported_capability');
  return { provider: value.provider, model: value.model, capability: value.capability };
}
export function validateProviderConfig(value) {
  exact(value, ['primary', 'fallbacks', 'timeout_ms', 'max_attempts']);
  const primary = route(value.primary);
  if (!Array.isArray(value.fallbacks) || value.fallbacks.length > 2) throw fail('invalid_fallbacks');
  const fallbacks = value.fallbacks.map(route);
  if (new Set([primary, ...fallbacks].map(item => item.provider)).size !== fallbacks.length + 1) throw fail('invalid_fallbacks');
  if (!Number.isSafeInteger(value.timeout_ms) || value.timeout_ms < 100 || value.timeout_ms > 120_000) throw fail('invalid_timeout');
  if (!Number.isSafeInteger(value.max_attempts) || value.max_attempts < 1 || value.max_attempts > 3) throw fail('invalid_attempts');
  return { primary, fallbacks, timeout_ms: value.timeout_ms, max_attempts: value.max_attempts };
}
function reference(projectId, routeId) {
  return `vhcred_${createHash('sha256').update(JSON.stringify([projectId, routeId])).digest('hex')}`;
}

// One local service owns this store. Only non-secret config and opaque references
// are persisted. The caller must keep this database in its ignored local data dir.
export class ProviderSettings {
  #db; #secrets; #pending = Promise.resolve();
  constructor({ filePath, secretStore }) {
    if (!secretStore || ['put', 'remove', 'status', 'use'].some(op => typeof secretStore[op] !== 'function')) throw fail('invalid_secret_store');
    try {
      mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
      this.#db = new DatabaseSync(filePath);
      chmodSync(filePath, 0o600);
      const id = this.#db.prepare('PRAGMA application_id').get().application_id;
      const version = this.#db.prepare('PRAGMA user_version').get().user_version;
      if ((id !== 0 && id !== APP_ID) || version > 1) throw fail('unsupported_store');
      if (id === 0 && this.#db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length) throw fail('unsupported_store');
      this.#db.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS provider_settings(project_id TEXT PRIMARY KEY, config TEXT, credentials TEXT NOT NULL);
        PRAGMA application_id=${APP_ID}; PRAGMA user_version=1;`);
    } catch {
      try { this.#db?.close(); } catch {}
      throw fail('settings_store_unavailable');
    }
    this.#secrets = secretStore;
  }
  #row(projectId) {
    project(projectId);
    try {
      const row = this.#db.prepare('SELECT config, credentials FROM provider_settings WHERE project_id=?').get(projectId);
      if (!row) return { config: null, credentials: {} };
      const credentials = JSON.parse(row.credentials);
      if (!plain(credentials) || Object.entries(credentials).some(([key, value]) => !Object.hasOwn(PROVIDER_MODELS, key) || value !== reference(projectId, key))) throw fail('invalid_store');
      return { config: row.config ? validateProviderConfig(JSON.parse(row.config)) : null, credentials };
    } catch { throw fail('settings_store_unavailable'); }
  }
  #write(projectId, row) {
    try {
      this.#db.prepare('INSERT INTO provider_settings VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET config=excluded.config, credentials=excluded.credentials')
        .run(projectId, row.config ? JSON.stringify(row.config) : null, JSON.stringify(row.credentials));
    } catch { throw fail('settings_store_unavailable'); }
  }
  #serial(fn) {
    const operation = this.#pending.then(fn);
    this.#pending = operation.catch(() => {});
    return operation;
  }
  configure(projectId, config) {
    project(projectId);
    const validated = validateProviderConfig(config);
    return this.#serial(() => { const row = this.#row(projectId); row.config = validated; this.#write(projectId, row); return structuredClone(validated); });
  }
  getConfig(projectId) { return this.#row(projectId).config; }
  resolveRoute(projectId, selectedProvider) {
    const config = this.getConfig(projectId);
    if (!config) throw fail('project_not_configured');
    const selected = selectedProvider === undefined ? config.primary : [config.primary, ...config.fallbacks].find(item => item.provider === selectedProvider);
    if (!selected) throw fail('route_not_allowed');
    return { ...selected, timeout_ms: config.timeout_ms, max_attempts: config.max_attempts };
  }
  replaceCredential(projectId, routeId, secret) {
    project(projectId); provider(routeId);
    if (typeof secret !== 'string' || secret.length < 1 || Buffer.byteLength(secret) > 8192 || /[\r\n\0]/.test(secret)) throw fail('invalid_credential');
    return this.#serial(async () => {
      const ref = reference(projectId, routeId);
      try { await this.#secrets.put(ref, secret); } catch { throw fail('secure_store_unavailable'); }
      const row = this.#row(projectId); row.credentials[routeId] = ref; this.#write(projectId, row);
      return { state: 'configured' };
    });
  }
  removeCredential(projectId, routeId) {
    project(projectId); provider(routeId);
    return this.#serial(async () => {
      try { await this.#secrets.remove(reference(projectId, routeId)); } catch { throw fail('secure_store_unavailable'); }
      const row = this.#row(projectId); delete row.credentials[routeId]; this.#write(projectId, row);
      return { state: 'missing' };
    });
  }
  async credentialStatus(projectId, routeId) {
    provider(routeId);
    const ref = this.#row(projectId).credentials[routeId];
    if (!ref) return { state: 'missing' };
    try {
      const result = await this.#secrets.status(ref);
      return { state: result === 'configured' ? 'configured' : result === 'missing' ? 'missing' : 'error' };
    } catch { return { state: 'error' }; }
  }
  // Trusted runtime-only callback. Never expose this method or its return value
  // as a browser read-key endpoint. SDK construction happens inside the callback.
  async useCredential(projectId, routeId, operation) {
    this.resolveRoute(projectId, routeId);
    if (typeof operation !== 'function') throw fail('invalid_operation');
    const ref = this.#row(projectId).credentials[routeId];
    if (!ref) throw fail('credential_missing');
    try { return await this.#secrets.use(ref, operation); }
    catch (error) {
      throw fail(error?.code === 'credential_missing' ? 'credential_missing'
        : error?.code === 'credential_rejected' || [401, 403].includes(error?.statusCode ?? error?.status) ? 'credential_rejected'
          : 'credential_operation_failed');
    }
  }
  async close() { await this.#pending; this.#db.close(); }
}
