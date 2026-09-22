import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { LocalCredentialAuthority, LOCAL_AUDIENCE } from './auth.mjs';

const APPLICATION_ID = 0x56484453; // VHDS, separate from bootstrap and provider settings.
export const DOMAIN_SCHEMA_VERSION = 2;
export const SOURCE_KIND_PROJECTION_VERSION = 1;
const SAFE_CODES = new Set(['store_closed', 'store_busy', 'store_unavailable', 'store_unauthorized',
  'invalid_store_input', 'unknown_namespace', 'cas_conflict', 'duplicate_identity',
  'async_transaction', 'stale_transaction', 'nested_transaction', 'migration_required', 'incompatible_store']);
const failure = code => Object.assign(new Error(`Domain store: ${code}`), { code });
function bounded(error) {
  return failure(SAFE_CODES.has(error?.code) ? error.code
    : error?.errcode === 5 || error?.errcode === 6 ? 'store_busy' : 'store_unavailable');
}
function id(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(value)) throw failure('invalid_store_input');
  return value;
}
function json(value) {
  let entries = 0;
  const visit = (item, depth) => {
    if (++entries > 50_000 || depth > 16) throw failure('invalid_store_input');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (Array.isArray(item)) {
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (Object.getPrototypeOf(item) !== Array.prototype || Object.getOwnPropertySymbols(item).length
        || Object.keys(descriptors).length !== item.length + 1) throw failure('invalid_store_input');
      const encoded = [];
      for (let i = 0; i < item.length; i++) {
        const descriptor = descriptors[i];
        if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) throw failure('invalid_store_input');
        encoded.push(visit(descriptor.value, depth + 1));
      }
      return `[${encoded.join(',')}]`;
    }
    if (!item || typeof item !== 'object' || ![null, Object.prototype].includes(Object.getPrototypeOf(item))) throw failure('invalid_store_input');
    const encoded = [];
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (descriptor.get || descriptor.set || !descriptor.enumerable) throw failure('invalid_store_input');
      encoded.push(`${JSON.stringify(key)}:${visit(descriptor.value, depth + 1)}`);
    }
    if (Object.getOwnPropertySymbols(item).length) throw failure('invalid_store_input');
    return `{${encoded.join(',')}}`;
  };
  // Serialize validated descriptors directly: never invoke caller toJSON hooks.
  const encoded = visit(value, 0);
  if (Buffer.byteLength(encoded) > 1_048_576) throw failure('invalid_store_input');
  return encoded;
}
function parsed(value) { const result = JSON.parse(value); json(result); return result; }
function target(version) {
  if (!Number.isInteger(version) || version < 1 || version > DOMAIN_SCHEMA_VERSION) throw failure('incompatible_store');
  return version;
}
function inspect(db) {
  if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw failure('incompatible_store');
  const application = db.prepare('PRAGMA application_id').get().application_id;
  const version = db.prepare('PRAGMA user_version').get().user_version;
  const empty = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get().n === 0;
  if (application === 0 && version === 0 && empty) return 0;
  if (application !== APPLICATION_ID || version < 1 || version > DOMAIN_SCHEMA_VERSION) throw failure('incompatible_store');
  // These three tables are a versioned private schema, not an arbitrary SQLite
  // import format. Pin their full DDL (columns, PK/unique/checks and STRICT),
  // allowing only formatting/case differences. The v2 projection is disposable.
  const normalize = sql => sql.replace(/\s+/g, '').toLowerCase();
  for (const sql of MIGRATIONS[0].sql.split(';').map(value => value.trim()).filter(Boolean)) {
    const name = sql.match(/^CREATE TABLE (\w+)/)[1];
    const actual = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if (!actual || normalize(actual.sql) !== normalize(sql)) throw failure('incompatible_store');
  }
  return version;
}
const INDEX_SQL = `CREATE TABLE IF NOT EXISTS source_kind_index (
  tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, namespace TEXT NOT NULL, kind TEXT NOT NULL,
  source_count INTEGER NOT NULL CHECK (source_count >= 0),
  PRIMARY KEY(tenant_id,project_id,namespace,kind)) STRICT;`;
const MIGRATIONS = [
  { version: 1, name: 'records-sources-outbox', sql: `
    CREATE TABLE records(tenant_id TEXT NOT NULL,project_id TEXT NOT NULL,namespace TEXT NOT NULL,key TEXT NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),value TEXT NOT NULL CHECK(json_valid(value)),PRIMARY KEY(tenant_id,project_id,namespace,key)) STRICT;
    CREATE TABLE sources(tenant_id TEXT NOT NULL,project_id TEXT NOT NULL,namespace TEXT NOT NULL,id TEXT NOT NULL,
      kind TEXT NOT NULL,value TEXT NOT NULL CHECK(json_valid(value)),PRIMARY KEY(tenant_id,project_id,namespace,id)) STRICT;
    CREATE TABLE outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT,tenant_id TEXT NOT NULL,project_id TEXT NOT NULL,
      namespace TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL CHECK(json_valid(value)),acked INTEGER NOT NULL DEFAULT 0 CHECK(acked IN (0,1)),
      UNIQUE(tenant_id,project_id,namespace,id)) STRICT;` },
  { version: 2, name: 'disposable-source-kind-index-v1', sql: `${INDEX_SQL}
    INSERT INTO source_kind_index SELECT tenant_id,project_id,namespace,kind,count(*) FROM sources GROUP BY tenant_id,project_id,namespace,kind;` },
];
const plan = (from, to) => {
  if (from > to) throw failure('incompatible_store');
  return { from_version: from, to_version: to, steps: MIGRATIONS.filter(m => m.version > from && m.version <= to).map(({ version, name }) => ({ version, name })) };
};

/** Administrative metadata only; does not create a missing file or run DDL. */
export function planDomainStore({ filePath, targetVersion = DOMAIN_SCHEMA_VERSION }) {
  target(targetVersion); let db;
  try {
    if (typeof filePath !== 'string' || !filePath.trim()) throw failure('invalid_store_input');
    if (!existsSync(filePath)) return plan(0, targetVersion);
    db = new DatabaseSync(filePath, { readOnly: true });
    return plan(inspect(db), targetVersion);
  } catch (error) { throw bounded(error); } finally { db?.close(); }
}

/** Explicit owner operation. Domain APIs never auto-upgrade or downgrade. */
export function migrateDomainStore({ filePath, targetVersion = DOMAIN_SCHEMA_VERSION }) {
  target(targetVersion); let db;
  try {
    if (typeof filePath !== 'string' || !filePath.trim()) throw failure('invalid_store_input');
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    db = new DatabaseSync(filePath);
    db.exec('PRAGMA busy_timeout=1000; BEGIN IMMEDIATE;');
    const migration = plan(inspect(db), targetVersion);
    for (const step of migration.steps) db.exec(`${MIGRATIONS[step.version - 1].sql} PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${step.version};`);
    db.exec('COMMIT; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    chmodSync(filePath, 0o600);
    return migration;
  } catch (error) { try { db?.exec('ROLLBACK'); } catch {} throw bounded(error); }
  finally { db?.close(); }
}

export class DomainStore {
  #db; #authority; #namespaces; #version; #closed = false; #inTransaction = false;
  constructor({ filePath, authority, namespaces }) {
    if (!(authority instanceof LocalCredentialAuthority) || !Array.isArray(namespaces) || !namespaces.length || namespaces.length > 64) throw failure('invalid_store_input');
    namespaces.forEach(id);
    this.#authority = authority; this.#namespaces = new Set(namespaces);
    try {
      if (typeof filePath !== 'string' || !existsSync(filePath)) throw failure('migration_required');
      this.#db = new DatabaseSync(filePath);
      this.#version = inspect(this.#db);
      if (!this.#version) throw failure('migration_required');
      this.#db.exec('PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL;');
    } catch (error) { this.#db?.close(); throw bounded(error); }
  }
  #scope(context, action) {
    if (this.#closed) throw failure('store_closed');
    const grant = this.#authority.inspect(context);
    if (!grant || grant.audience !== LOCAL_AUDIENCE || !grant.actions.includes(action)) throw failure('store_unauthorized');
    return [grant.tenant_id, grant.project_id];
  }
  #key(namespace, key) {
    if (!this.#namespaces.has(namespace)) throw failure('unknown_namespace');
    return [namespace, id(key)];
  }
  #query(context, action, fn) {
    try { return fn(this.#scope(context, action)); } catch (error) { throw bounded(error); }
  }
  getRecord(context, namespace, key) {
    return this.#query(context, 'store:read', scope => {
      const row = this.#db.prepare('SELECT version,value FROM records WHERE tenant_id=? AND project_id=? AND namespace=? AND key=?').get(...scope, ...this.#key(namespace, key));
      if (!row) return null;
      if (!Number.isSafeInteger(row.version) || row.version < 1) throw failure('store_unavailable');
      return { version: row.version, value: parsed(row.value) };
    });
  }
  getSource(context, namespace, sourceId) {
    return this.#query(context, 'store:read', scope => {
      const row = this.#db.prepare('SELECT kind,value FROM sources WHERE tenant_id=? AND project_id=? AND namespace=? AND id=?').get(...scope, ...this.#key(namespace, sourceId));
      return row ? { kind: id(row.kind), value: parsed(row.value) } : null;
    });
  }
  pendingOutbox(context, namespace, { limit = 100 } = {}) {
    return this.#query(context, 'store:read', scope => {
      this.#key(namespace, 'list');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw failure('invalid_store_input');
      return this.#db.prepare('SELECT id,value FROM outbox WHERE tenant_id=? AND project_id=? AND namespace=? AND acked=0 ORDER BY sequence LIMIT ?')
        .all(...scope, namespace, limit).map(row => ({ id: id(row.id), value: parsed(row.value) }));
    });
  }
  sourceCounts(context, namespace) {
    return this.#query(context, 'store:read', scope => {
      this.#key(namespace, 'counts');
      if (this.#version < 2) throw failure('migration_required');
      const counts = this.#db.prepare('SELECT kind,source_count FROM source_kind_index WHERE tenant_id=? AND project_id=? AND namespace=? ORDER BY kind').all(...scope, namespace);
      return { projection_version: SOURCE_KIND_PROJECTION_VERSION, counts: counts.map(row => {
        if (!Number.isSafeInteger(row.source_count) || row.source_count < 0) throw failure('store_unavailable');
        return { kind: id(row.kind), count: row.source_count };
      }) };
    });
  }
  transaction(context, operation) {
    if (typeof operation !== 'function' || operation.constructor?.name === 'AsyncFunction') throw failure('async_transaction');
    if (this.#inTransaction) throw failure('nested_transaction');
    let active = false;
    const assertActive = () => { if (!active) throw failure('stale_transaction'); return this.#scope(context, 'store:write'); };
    try {
      this.#scope(context, 'store:write');
      this.#db.exec('BEGIN IMMEDIATE'); this.#inTransaction = true; active = true;
      const handle = Object.freeze({
        getRecord: (namespace, key) => { assertActive(); return this.getRecord(context, namespace, key); },
        compareAndSwap: (namespace, key, expectedVersion, value) => {
          const scope = assertActive(), address = this.#key(namespace, key), encoded = json(value);
          if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || expectedVersion >= Number.MAX_SAFE_INTEGER)) throw failure('invalid_store_input');
          const current = this.#db.prepare('SELECT version FROM records WHERE tenant_id=? AND project_id=? AND namespace=? AND key=?').get(...scope, ...address);
          if ((current?.version ?? null) !== expectedVersion) throw failure('cas_conflict');
          const version = (expectedVersion ?? 0) + 1;
          this.#db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?) ON CONFLICT(tenant_id,project_id,namespace,key) DO UPDATE SET version=excluded.version,value=excluded.value').run(...scope, ...address, version, encoded);
          return version;
        },
        appendSource: (namespace, sourceId, kind, value) => {
          const scope = assertActive(), address = this.#key(namespace, sourceId), encoded = json(value); id(kind);
          if (this.#db.prepare('SELECT 1 FROM sources WHERE tenant_id=? AND project_id=? AND namespace=? AND id=?').get(...scope, ...address)) throw failure('duplicate_identity');
          this.#db.prepare('INSERT INTO sources VALUES (?,?,?,?,?,?)').run(...scope, ...address, kind, encoded);
          if (this.#version >= 2) this.#db.prepare('INSERT INTO source_kind_index VALUES (?,?,?,?,1) ON CONFLICT(tenant_id,project_id,namespace,kind) DO UPDATE SET source_count=source_count+1').run(...scope, namespace, kind);
        },
        enqueue: (namespace, outboxId, value) => {
          const scope = assertActive(), address = this.#key(namespace, outboxId), encoded = json(value);
          if (this.#db.prepare('SELECT 1 FROM outbox WHERE tenant_id=? AND project_id=? AND namespace=? AND id=?').get(...scope, ...address)) throw failure('duplicate_identity');
          this.#db.prepare('INSERT INTO outbox(tenant_id,project_id,namespace,id,value) VALUES (?,?,?,?,?)').run(...scope, ...address, encoded);
        },
        ack: (namespace, outboxId) => {
          const scope = assertActive(), address = this.#key(namespace, outboxId);
          return this.#db.prepare('UPDATE outbox SET acked=1 WHERE tenant_id=? AND project_id=? AND namespace=? AND id=? AND acked=0').run(...scope, ...address).changes === 1;
        },
      });
      const result = operation(handle);
      if (result && typeof result.then === 'function') { Promise.resolve(result).catch(() => {}); throw failure('async_transaction'); }
      assertActive(); // Revocation or expiry during the callback must roll back all changes.
      this.#db.exec('COMMIT'); return result;
    } catch (error) {
      if (active) { try { this.#db.exec('ROLLBACK'); } catch {} }
      throw bounded(error);
    } finally { if (active) this.#inTransaction = false; active = false; }
  }
  rebuildSourceKindIndex(context) {
    this.#scope(context, 'store:write');
    if (this.#version < 2) throw failure('migration_required');
    return this.transaction(context, () => {
      const scope = this.#scope(context, 'store:write');
      this.#db.exec(INDEX_SQL);
      this.#db.prepare('DELETE FROM source_kind_index WHERE tenant_id=? AND project_id=?').run(...scope);
      this.#db.prepare('INSERT INTO source_kind_index SELECT tenant_id,project_id,namespace,kind,count(*) FROM sources WHERE tenant_id=? AND project_id=? GROUP BY tenant_id,project_id,namespace,kind').run(...scope);
      return { projection_version: SOURCE_KIND_PROJECTION_VERSION };
    });
  }
  close() {
    if (this.#inTransaction) throw failure('nested_transaction');
    if (!this.#closed) { this.#db.close(); this.#closed = true; }
  }
}
