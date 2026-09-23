import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { types } from 'node:util';
import { AccessAuthority, LOCAL_AUDIENCE } from '../../domain/identity/access-authority.mjs';

const APPLICATION_ID = 0x56484453; // VHDS, separate from bootstrap and provider settings.
export const DOMAIN_SCHEMA_VERSION = 2;
export const SOURCE_KIND_PROJECTION_VERSION = 1;
const SAFE_CODES = new Set(['store_closed', 'store_busy', 'store_unavailable', 'store_unauthorized',
  'invalid_store_input', 'unknown_namespace', 'cas_conflict', 'duplicate_identity',
  'async_transaction', 'stale_transaction', 'nested_transaction', 'migration_required', 'incompatible_store', 'store_page_too_large']);
const failure = code => Object.assign(new Error(`Domain store: ${code}`), { code });
function errorField(error, field) {
  // Callback-thrown values are arbitrary. Never evaluate getters, proxy traps
  // or caller formatting hooks while replacing an error with a bounded code.
  if (!error || (typeof error !== 'object' && typeof error !== 'function') || types.isProxy(error)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, field);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function bounded(error) {
  const code = errorField(error, 'code'), errcode = errorField(error, 'errcode');
  return failure(SAFE_CODES.has(code) ? code
    : errcode === 5 || errcode === 6 ? 'store_busy' : 'store_unavailable');
}
function id(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(value)) throw failure('invalid_store_input');
  return value;
}
function json(value) {
  let entries = 0;
  const visit = (item, depth) => {
    if (++entries > 50_000 || depth > 16) throw failure('invalid_store_input');
    if (types.isProxy(item)) throw failure('invalid_store_input');
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
function rangeOptions(input) {
  // Copy inert data before inspecting options; never evaluate input accessors.
  const value = JSON.parse(json(input));
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || Object.keys(value).sort().join(',') !== 'after,limit,lower,order,upper') throw failure('invalid_store_input');
  const { lower, upper, order, limit, after } = value;
  id(lower); id(upper);
  if (lower >= upper || !['asc', 'desc'].includes(order) || !Number.isSafeInteger(limit)
    || limit < 1 || limit > 64 || (after !== null && (id(after) < lower || after >= upper))) throw failure('invalid_store_input');
  return value;
}
const ASYNC_PROTOTYPES = new Set([Object.getPrototypeOf(async () => {}), Object.getPrototypeOf(async function* () {})]);
function synchronousOperation(operation) {
  if (typeof operation !== 'function') throw failure('async_transaction');
  // Bound async functions are not identified by util.types.isAsyncFunction,
  // but retain their async prototype. Inspect descriptors/prototypes, not
  // operation.constructor, whose getter could run before authorization.
  let current = operation, depth = 0;
  while (current !== null) {
    if (types.isProxy(current) || types.isAsyncFunction(current) || ASYNC_PROTOTYPES.has(current) || ++depth > 64) throw failure('async_transaction');
    const constructor = Object.getOwnPropertyDescriptor(current, 'constructor')?.value;
    const name = errorField(constructor, 'name');
    if (name === 'AsyncFunction' || name === 'AsyncGeneratorFunction') throw failure('async_transaction');
    current = Object.getPrototypeOf(current);
  }
}
function synchronousResult(result) {
  // Do not assimilate thenables or inspect result.then: both can execute code.
  // Returned promises remain their caller's responsibility, including rejection
  // handling. Async functions are rejected before their body runs.
  if (types.isPromise(result)) throw failure('async_transaction');
  let current = result, depth = 0;
  while (current !== null && (typeof current === 'object' || typeof current === 'function')) {
    if (types.isProxy(current) || ++depth > 64) throw failure('async_transaction');
    const descriptor = Object.getOwnPropertyDescriptor(current, 'then');
    if (descriptor) {
      if (descriptor.get || descriptor.set || typeof descriptor.value === 'function') throw failure('async_transaction');
      return;
    }
    current = Object.getPrototypeOf(current);
  }
}
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
  #db; #authority; #namespaces; #version; #closed = false; #inTransaction = false; #rangeStatements = new Set();
  constructor({ filePath, authority, namespaces }) {
    if (!(authority instanceof AccessAuthority) || !Array.isArray(namespaces) || !namespaces.length || namespaces.length > 64) throw failure('invalid_store_input');
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
  getSourceRange(context, namespace, options) {
    return this.#query(context, 'store:read', scope => {
      this.#key(namespace, 'range');
      const { lower, upper, order, limit, after } = rangeOptions(options);
      const ascending = order === 'asc';
      const parameters = [...scope, namespace, lower, upper, ...(after === null ? [] : [after]), limit];
      // Only validated direction and a fixed optional predicate enter SQL. The
      // existing composite primary key bounds both selection and ordering.
      const statement = this.#db.prepare(`SELECT id,kind,value FROM sources
        WHERE tenant_id=? AND project_id=? AND namespace=? AND id>=? AND id<?
        ${after === null ? '' : ascending ? 'AND id>?' : 'AND id<?'}
        ORDER BY id COLLATE BINARY ${ascending ? 'ASC' : 'DESC'} LIMIT ?`);
      const rows = [];
      let encodedRowsBytes = 0, last_id = null;
      // Node's SQLite iterator does not itself retain its StatementSync on
      // every supported runtime. Keep explicit ownership until iteration (or
      // early overflow/error) finishes; otherwise GC may finalize it mid-read.
      this.#rangeStatements.add(statement);
      try {
        for (const row of statement.iterate(...parameters)) {
          // Parse one bounded value at a time instead of materializing up to64MiB
          // through .all(). Aggregate overflow returns no partial page.
          if (Buffer.byteLength(row.value) > 1_048_576) throw failure('store_unavailable');
          const selected = { id: id(row.id), kind: id(row.kind), value: parsed(row.value) };
          encodedRowsBytes += Buffer.byteLength(JSON.stringify(selected)) + (rows.length ? 1 : 0);
          last_id = selected.id;
          if (encodedRowsBytes + Buffer.byteLength(JSON.stringify({ rows: [], last_id })) > 1_048_576) throw failure('store_page_too_large');
          rows.push(selected);
        }
      } finally { this.#rangeStatements.delete(statement); }
      this.#scope(context, 'store:read');
      return { rows, last_id };
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
    synchronousOperation(operation);
    if (this.#inTransaction) throw failure('nested_transaction');
    let active = false;
    const assertActive = () => { if (!active) throw failure('stale_transaction'); return this.#scope(context, 'store:write'); };
    try {
      this.#scope(context, 'store:write');
      this.#db.exec('BEGIN IMMEDIATE'); this.#inTransaction = true; active = true;
      const handle = Object.freeze({
        getRecord: (namespace, key) => { assertActive(); return this.getRecord(context, namespace, key); },
        getSource: (namespace, sourceId) => { assertActive(); return this.getSource(context, namespace, sourceId); },
        getSourceRange: (namespace, options) => { assertActive(); return this.getSourceRange(context, namespace, options); },
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
      synchronousResult(result);
      assertActive(); // Revocation or expiry during the callback must roll back all changes.
      this.#db.exec('COMMIT'); return result;
    } catch (error) {
      if (active) { try { this.#db.exec('ROLLBACK'); } catch {} }
      throw bounded(error);
    } finally { if (active) this.#inTransaction = false; active = false; }
  }
  readSnapshot(context, operation) {
    synchronousOperation(operation);
    if (this.#inTransaction) throw failure('nested_transaction');
    let active = false;
    const assertActive = () => { if (!active) throw failure('stale_transaction'); return this.#scope(context, 'store:read'); };
    try {
      this.#scope(context, 'store:read');
      this.#db.exec('BEGIN DEFERRED'); this.#inTransaction = true; active = true;
      const handle = Object.freeze({
        getRecord: (namespace, key) => { assertActive(); return this.getRecord(context, namespace, key); },
        getSource: (namespace, sourceId) => { assertActive(); return this.getSource(context, namespace, sourceId); },
        getSourceRange: (namespace, options) => { assertActive(); return this.getSourceRange(context, namespace, options); },
      });
      const result = operation(handle);
      synchronousResult(result);
      assertActive();
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
