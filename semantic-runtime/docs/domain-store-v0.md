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
| `getSource(context, namespace, id)` / `tx.getSource(namespace, id)` | `{ kind, value }` or `null`; sources have no update/delete API. |
| `getSourceRange(context, namespace, options)` / `tx.getSourceRange(namespace, options)` | Bounded ordered `{ rows: [{ id, kind, value }], last_id }`; exact options below. |
| `readSnapshot(context, operation)` | Synchronous read-only callback with a frozen, scoped read handle; coherent view from its first SQLite read. |
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

## Selected reads and coherent views

```js
const page = store.readSnapshot(context, view => {
  const current = view.getRecord('graph', 'head');
  return view.getSourceRange('graph', {
    lower: 'commit/', upper: 'commit0', order: 'asc', limit: 64, after: null,
  });
});
```

All five range options are required; unknown fields or executable accessors are
rejected before reading options. `lower`, `upper` and non-null `after` use the
existing case-sensitive ASCII identifier grammar (1–200 characters). Bounds are
`lower <= id < upper` using SQLite BINARY order; `lower` must precede `upper`.
`order` is `asc` or `desc`, `limit` is an integer from 1 to 64, and `after` is null
or an ID inside those bounds. A non-null continuation excludes that ID and selects
greater IDs ascending or smaller IDs descending. It need not name an existing
row. Scope and namespace are mandatory in every query and derive from the same
opaque authorization as exact reads. The existing composite primary key supports
both directions; no table, index or migration is added.

`last_id` is null for an empty result or the last returned row's ID. It is only a
locator: it neither promises another page nor authenticates access or freezes
history. A later call uses current authorization and a new view unless it is
inside the same callback. There is no offset, wildcard query, total count, SQL
interface or caller-visible iterator. Graph temporal membership and historical
ACL interpretation remain the Graph adapter's responsibility.

Rows are consumed incrementally, up to the requested limit. Each JSON value keeps
the existing 1 MiB / 16-level / 50,000-node limit, and the **complete serialized
response**, including IDs and envelope, is additionally capped at 1 MiB. Overflow
throws `store_page_too_large` with no partial/truncated page; request a smaller
limit. Malformed selected rows fail closed. Selection does not validate unrelated
rows or silently omit invalid ones.

`readSnapshot` runs `BEGIN DEFERRED` on this store's connection, with its SQLite
snapshot established by the first read, not callback entry. Later reads in that
callback retain the same database view while other WAL connections commit.
The frozen handle exposes only `getRecord`, `getSource` and `getSourceRange` bound
to the caller's tenant/Project. Current grant checks occur at each handle access
and again before returning the callback result; revocation/expiry rejects the
whole operation. The handle expires on success and failure. Existing top-level
scoped reads compose in that same active view; they do not open nested snapshots.

Read and write callbacks cannot nest on one connection, close it or rebuild its
projection, even before the first read. Throws and rejected async/thenable results
roll back and leave the connection reusable. Async functions are refused before
execution; returned promises and thenable/accessor descriptors are rejected
without executing result getters or assimilating thenables. Callers remain
responsible for their own Promise rejection handling; no asynchronous work belongs
inside either callback. Write handles now expose the same exact/range source
reads, including their own uncommitted appends, with both write and read authority.
No network, model, filesystem or host operation belongs inside a snapshot.

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

`node --test test/domain-store-selected-reads.test.mjs` additionally exercises real
WAL snapshots across two independent connections, 2,048 retained source rows,
the actual bounded iterator and SQLite query plans in both directions, authority
and handle lifetime, aggregate capacity failures and connection recovery.

The opt-in `npm run check:jev:ingress` also uses this coherent view to materialize
an admitted synthetic event and its approved text after database restart. It
closes the view before dispatching JEV. The [2026-09-22 measurement](measurements/jev-selected-read-20260922.json)
completed and matched all eight fixed cases, with no retry or rate-limit response;
successful requests took 98–294 ms. This is a small regression measurement,
not a general accuracy or throughput claim, and does not mark the pending events
semantically complete.
