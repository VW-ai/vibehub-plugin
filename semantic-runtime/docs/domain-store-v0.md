# Scoped SQLite domain store

This is a small persistence foundation for local modules. It is not an ORM, the
Semantic Working Graph, a job scheduler or the production domain schema. It
uses Node's built-in SQLite and an independent `VHDS` application ID/file.
Pass the file path explicitly under the App's ignored local data directory;
never point it at bootstrap, provider-settings or a user's unrelated database.

The trusted local process owner first inspects `planDomainStore({ filePath })`
and explicitly runs `migrateDomainStore({ filePath })`. Planning opens an existing
file read-only and does not create a missing path or execute migrations. It
returns current/target versions and named steps. SQLite may use its normal WAL
coordination files when a database is open elsewhere; the plan does not write
domain data or change the schema. Foreign, newer or corrupt stores fail with
bounded errors and are never replaced.
The three required core table definitions are pinned to their versioned DDL,
including columns, primary/unique keys, JSON/check constraints and STRICT mode;
formatting/case differences are allowed. A missing or changed core table fails
plan, open and migration without replacement. The disposable v2 projection is
deliberately excluded from that compatibility check so it can be rebuilt.

`new DomainStore({ filePath, authority, namespaces })` opens an already migrated
store. `authority` is the accepted `LocalCredentialAuthority`; `namespaces` is a
bounded allowlist owned by the consuming domain module, for example
`['git-enrollment']`. The process owner can close the store. Administrative open,
plan/migrate and close do not expose domain rows. All domain reads and writes
require an opaque authenticated context, exact `vibehub-local-api` audience and
`store:read` or `store:write` action. Tenant/Project come only from the authority,
never from caller-supplied SQL or a row key. Each call checks expiry/revocation;
transactions check again before commit. Existing contexts do not gain access by
copying or editing them.

## Repository API

```js
store.transaction(context, tx => {
  const current = tx.getRecord('git-enrollment', 'catalog');
  tx.compareAndSwap('git-enrollment', 'catalog', current?.version ?? null, nextCatalog);
  tx.appendSource('git-enrollment', 'observation-id', 'worktree-observation', source);
  tx.enqueue('git-enrollment', 'notice-id', { catalogChanged: true });
});
```

The synchronous callback runs inside `BEGIN IMMEDIATE` and atomically commits
records, immutable sources and outbox entries. Async/thenable callbacks and
nested transactions are rejected. Transaction handles stop working as soon as
their callback ends, including rollback. A callback exception, expiry or
revocation before commit rolls back every write. `store_busy` is bounded after
the one-second SQLite busy timeout; the domain caller decides whether to retry.
Do not hold a transaction while doing network, model or filesystem work.

| Method | Result / contract |
| --- | --- |
| `getRecord(context, namespace, key)` / `tx.getRecord(namespace, key)` | `{ version, value }` or `null`; requires read permission. |
| `tx.compareAndSwap(namespace, key, expectedVersion, value)` | Returns next version; `null` creates only if absent; stale positive version gives `cas_conflict`. |
| `getSource(context, namespace, id)` | `{ kind, value }` or `null`; sources have no update/delete API. |
| `tx.appendSource(namespace, id, kind, value)` | Appends one immutable source; duplicate identity is rejected even if bytes match. |
| `pendingOutbox(context, namespace, { limit })` | Ordered unacknowledged `{ id, value }` records, limit 1–256. |
| `tx.enqueue(namespace, id, value)` | Unique durable outbox identity; duplicate is rejected even after acknowledgement. |
| `tx.ack(namespace, id)` | `true` on first acknowledgement; `false` when missing/already acknowledged. |
| `sourceCounts(context, namespace)` | Versioned disposable source-kind counts for exactly this scope. |
| `rebuildSourceKindIndex(context)` | Rebuilds this Project's source-kind index from retained sources in one transaction. |

IDs use the existing bounded identifier grammar. Namespaces must be registered;
JSON values are at most 1 MiB, 16 levels and 50,000 nodes. Only inert JSON data is
accepted: no undefined, nonfinite number, BigInt, Date, custom prototypes,
accessors, sparse arrays, symbols or `toJSON` hooks. Serialization reads validated
data descriptors and never invokes user serialization hooks. Persisted malformed
JSON and database errors are replaced with bounded codes, without input text,
credentials or SQLite diagnostic messages. This is not automatic recognition of
secrets inside ordinary strings; source adapters own sanitization and policy.

Keys and uniqueness include tenant, Project and namespace. There is no unscoped
list, arbitrary SQL API or network endpoint. Domain modules own the schemas of
their JSON, identity continuity, history/tombstones, source ACLs and business
idempotency. Outbox acknowledgement is a durable local receipt, not a distributed
exactly-once delivery claim.

## Migration and projection versions

- Schema v1 creates records, immutable sources and the durable outbox.
- Schema v2 adds source-kind projection v1 and backfills it from immutable rows.
  It changes no source bytes and has no destructive transition.

Migration steps and `user_version` advance together in a SQLite transaction.
A failed application rolls back; rerun the explicit migration after resolving
the local failure. Open handles do not hot-upgrade: close them before migration
and reopen afterward. WAL plus FULL synchronous mode preserves completed
transactions. An interrupted uncommitted writer rolls back on restart.

The projection is disposable. Corrupted counts can be rebuilt for one Project;
if its table was dropped, rebuilding recreates it and populates only the
authorized Project. Other Projects rebuild under their own contexts. Rebuilding
does not change source JSON bytes or treat the counts as semantic knowledge.
Later domain projections must declare their own version, source dependencies
and rebuild contract.

Downgrade is refused. Before future destructive upgrades, close writers and take
a consistent SQLite backup (not a lone `.sqlite` copy while WAL writes are
active). Restore only with the matching application version, or apply an
explicit forward-fix migration. Every future destructive transition needs its
own tested data-retention/backup/compatibility policy; v2 invents none.

`node --test test/domain-store.test.mjs` uses real temporary databases and two
independent child processes for CAS races and SIGKILL-before-commit recovery.
It verifies migration failure/retry, scope isolation, read-only planning,
atomic record/source/outbox writes, projection rebuild, malformed inputs,
revocation/expiry, stale handles and bounded errors. No models or real secrets
are used.
