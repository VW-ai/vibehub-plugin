# Runtime identity contract v0

Wire version: `schema_version: 1`. Implementation: `src/core/identity.mjs`.
This contract separates semantic Project scope from repositories and from the
local or connector instances observing them. It implements the identity slice
of Tech Design §§5, 8.1, 15.1, 20 and 25; it does not establish canonical truth,
authentication, source access policy, or a database deployment.

## Entities and ownership

Every reference includes `tenant_id`. IDs are opaque, case-sensitive strings
matching `[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}`; callers allocate and persist them.
`identityKey(kind, tenantId, entityId)` serializes the tuple
`[1, kind, tenantId, entityId]` as JSON. Kind and tenant are part of identity;
concatenating path-like IDs with a separator is not an equivalent key.
The tenant's own entity ID must equal its `tenant_id`.

A complete active catalog contains all ten arrays below, including empty arrays.
`validateIdentityCatalog(catalog)` returns `true`, or throws `TypeError` for an
invalid schema, duplicate identity, dangling/cross-tenant reference, contradictory
ownership, duplicate external identity, or cyclic fork ancestry. Unknown fields
are rejected. All records may carry inert JSON `attributes` (object, depth below
16; individual strings at most 8192 characters). Attributes never resolve identity.

| Entity / array | ID field | Required relationship or metadata | Ownership |
| --- | --- | --- | --- |
| Tenant / `tenants` | `tenant_id` | None | Isolation root; no global cross-tenant deduplication |
| Workspace / `workspaces` | `workspace_id` | `tenant_id` | Tenant administrative grouping |
| Project / `projects` | `project_id` | `workspace_id` | Workspace semantic scope, including repository-free work |
| RepositoryIdentity / `repositories` | `repository_id` | Optional `external_identity`, `fork_of_repository_id` | Tenant source identity, independent of a Project or clone |
| ProjectRepositoryMembership / `memberships` | `membership_id` | `project_id`, `repository_id` | Explicit unique Project–Repository pair; many-to-many allowed |
| SourceInstallation / `source_installations` | `source_installation_id` | `workspace_id`, `kind`, `external_identity`, `project_ids`, `membership_ids` | One local or connector registration with explicit mappings |
| Checkout / `checkouts` | `checkout_id` | `repository_id`, `source_installation_id` | One enrolled local clone; requires a local installation |
| Worktree / `worktrees` | `worktree_id` | `checkout_id` | One worktree instance within a clone |
| Session / `sessions` | `session_id` | `project_id`, `source_installation_id`; optional `worktree_id` | One live host session registration in one Project |
| Execution / `executions` | `execution_id` | `session_id`; optional `repository_id`, `worktree_id` | One attempt within a session; may be Project-only |

An external identity is exactly `{ provider, authority, object_id }` using the
same identifier grammar. The authority distinguishes provider instances such
as separate Git servers. Adapters supply the provider's immutable object ID,
not an owner/name path or remote URL. For local installations it identifies a
persisted host registration. It contains no credential. The same provider tuple
may exist independently in different tenants; within one tenant/kind it must be
unique. Local-only repositories can omit external identity and use an enrolled
opaque Runtime ID until an explicit adapter mapping is established.

A source installation has `kind: "local" | "connector"`. Its `project_ids` are
explicitly mapped Projects in its Workspace. Its `membership_ids` select the
repository memberships available through that registration; every membership's
Project must also appear in `project_ids`. A connector's repository mappings
must use the same provider and authority as its external identity. A local host
can have memberships across different repository providers. Empty memberships
allow sources for Project-level work without Git repositories.

Sessions must use an installation mapped to their Project. Checkout and worktree
references must use that same installation and a mapped membership of the session
Project. An Execution cannot contradict its Session's worktree or repository. A
Session without a worktree can execute across the Project's explicitly mapped
repositories. Fork ancestry is informational, tenant-local and acyclic: it never
adds a Project membership or causes the fork to resolve as its upstream.

These mappings are identity facts, not permissions. The host/source adapter must
authenticate the caller, choose an authorized tenant, and supply an appropriate
catalog snapshot. Access checks and revocation run separately; a resolved identity
or candidate list must never serve as authorization.

## Identity lifecycle and mutable attributes

Paths, branch names, remote URLs, display names and host conversation IDs belong
under `attributes`. Never derive primary keys from them. Required ownership links
and enrolled provider identities are immutable for a given ID. Enrollment owners
must persist allocated IDs, reject attempted rebinding, and retain historical
references/tombstones. This module validates one active snapshot and cannot prove
identity continuity against absent history or mint safe IDs on behalf of a host.

| Change | Identity behavior |
| --- | --- |
| Clone or worktree path moves | Preserve IDs only when the adapter proves continuity of its enrolled instance; update path attributes |
| Branch rename/switch or detached HEAD | Preserve worktree; update branch/ref attributes; commits remain separate provenance |
| Remote URL spelling/protocol changes | Preserve repository when immutable provider ID or trusted enrollment still matches |
| Remote changes to a different repository | Resolve/enroll that repository explicitly; a URL attribute cannot rebind existing repository identity |
| Repository rename or transfer within a provider | Preserve repository ID if provider/authority/object ID and tenant remain unchanged; recheck access separately |
| Transfer across tenant, provider, or server | New tenant key or explicit new enrollment; no URL-based merge or automatic aliasing |
| New clone, even at a formerly used path | New checkout; the enrolled repository may remain the same |
| Worktree deletion and recreation at the same path/branch | New worktree ID; checkout/repository survive when their enrolled instances survive |
| Session process restart or resume of the same host conversation | New Session registration and Execution IDs; conversation correlation remains an attribute |
| Retry that is a new execution attempt | New Execution ID; retrying delivery of the same attempt retains that ID |
| Installation uninstall/reinstall or copied registration on another host | New registration; never silently reuse a cloned host token |
| Change Project ownership, membership endpoints, or session Project | New explicit identity/mapping and historical retention, not editing immutable parent links |

Removing an instance from the active catalog makes its old ID `unmapped`; it must
not fall through to a replacement at the same path. Historical events require the
appropriate retained catalog/revision, rather than interpreting old provenance
through current mutable names. Cross-snapshot storage and fencing belong to the
later event/store/session protocols.

## Pure resolution API

```js
const result = resolveIdentity(catalog, {
  tenant_id: 'acme',
  worktree_id: 'feature-a',
});
// result.status === 'resolved'
// result.identity includes project_id, membership_id, repository_id,
// source_installation_id, checkout_id, worktree_id, workspace_id and tenant_id.
```

An observation accepts any of the ID fields in the table, optionally
`external_repository: { provider, authority, object_id }`, and optional
`hints: { path, remote_url, branch, name }`. Inputs and the supplied catalog are
not mutated. Resolution performs no I/O and imports no host/provider/store code.
All supplied stable IDs must exist in the selected tenant. Every asserted ID and
its registered parents must agree; no observation overrides another.

Connector object observations require a known source installation (directly or
through registered parents) and match an exact provider tuple. The resolver then
checks its mapped memberships. Matching a remote URL, path, display name, Git
ancestry or branch is never enough, even if only one candidate exists.

| Result | Meaning |
| --- | --- |
| `resolved` / `registered_mapping` | One Project is supported by explicit IDs and registered mappings; `identity` is the resolved field set; `confidence: "exact"` |
| `ambiguous` / `multiple_project_bindings` | Multiple Projects remain; `identity: null`, `confidence: "none"`; `candidates` contains sorted tenant/workspace/Project scopes, and repository if known |
| `ambiguous` / `conflicting_evidence` | Supplied IDs or their registered parents contradict; no preferred identity or guessed candidate |
| `unmapped` | Unknown identity, missing installation, unknown external repository, no Project binding, or insufficient stable identity; `identity: null`, `confidence: "none"` |

`confidence` is categorical identity assurance, not a model probability or a claim
about trust. Every result includes deterministic `evidence` entries with `basis`,
`kind`, and tenant-scoped `key`; paths and attributes are excluded. Basis is one
of `registered_id`, `registered_parent`, `external_repository`, `source_binding`,
or `project_membership`. `ignored_hints` lists only hint field names. Invalid
input throws a bounded error without echoing field values. Catalog ordering does
not change results. Ambiguous/unmapped observations are ordinary return values,
whereas malformed schemas are caller errors.

Repository-only input may resolve through its one explicit membership, or be
ambiguous when it belongs to several Projects. Installation-only input may resolve
its one mapped Project or be ambiguous across Projects. Project-only input is
valid for Project Context. Neither Project-only nor installation-only input invents
a repository ID or membership, even when the snapshot has a single repository.
A supplied Project ID never proves membership of a supplied unrelated repository.

## Conformance

`test/fixtures/identity/multi-source.json` is fully synthetic. It includes two
tenants with reused local IDs, one Project with API/web/fork repositories, a
repository shared with another Project, two clones, multiple worktrees, a connector,
and a repository-free notes Project. The test suite adds malformed and lifecycle
variants and verifies explicit failure rather than inferred scope.

```sh
node --test test/identity/identity.test.mjs
npm run check:boundaries
```

The contract is independently usable; Phase 0 replay envelopes and provider
adapters retain their current behavior until their own integration Tickets adopt
these identities.
