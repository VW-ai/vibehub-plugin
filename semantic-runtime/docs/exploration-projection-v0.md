# Local exploration projection v0

`LocalExplorationStore` binds a registered Git worktree to a selected exploration.
Each exploration owns a separate Working Graph generation: the same entity ID
in A and B describes two local hypotheses. Looking at B, changing the Project
view or merging Git does not adopt B into A. This authenticated in-process
module is not yet connected to the App, plugins, Policy consumer or Worker.
Runtime publication runs remain distinct from coding-host Sessions.

## Construction and commands

Use the existing migrated `DomainStore` with `exploration-projection`,
`working-graph`, `durable-ingress`, `source-invalidation`, `git-enrollment` and
`project-activation`. No new table or dependency is needed.

```js
const explorations = new LocalExplorationStore({
  store, authority,
  canonical_reader: { repository_path, execution, registration_id, selection },
});
```

The configuration uses the existing [canonical reader](canonical-source-reader-v0.md)
fields and limits. It is copied as inert data; the actual reader is constructed
with the same store/authority. One configuration digest is fixed per Project;
changing it needs later explicit migration. Construction does not activate,
capture, enroll or initialize anything.

Reads require local `exploration:read`, `graph:read`, `store:read`, `ingress:read`
and `source:invalidation:read`. Writes additionally require a human/service
`exploration:write`, `graph:write`, `store:write`, `project:inspect` and
`activation:admit` capability, an enabled epoch and actual enrollment.
`getBinding` also requires `project:inspect`. Register publishers through
the existing Graph `registerPublisherRun` API.

| Method | Inputs and effect |
| --- | --- |
| `bind` | `{epoch,idempotency_key,publisher_ref,execution,expected_catalog_version,expected_binding_version,exploration_id,shared_base}`. Null exploration creates service-owned IDs, genesis and binding atomically. An existing target gets a new binding while preserving its origin. Returns IDs, binding version, exact `graph_revision`, receipt. |
| `getBinding` | `{execution}` → `bound`, `unmapped`, `rebind_required` or `unavailable`, binding/version and observed catalog version. No physical inspection or implicit enrollment. |
| `mutate` | `{epoch,idempotency_key,publisher_ref,execution_workspace_id,expected_binding_version,expected_catalog_version,expected_project_selection_version,expected_graph,expected_source_fence,operation,coverage}`. Existing `assert`/`resolve`, source coverage and Graph CAS; returns Graph result/receipt plus immutable `operation_origin_ref`. |
| `setProjectSelection` | `{epoch,idempotency_key,expected_version,pin}` declares a current reader-verified selection by CAS. It writes no canonical source and changes no exploration origin/head. |
| `getReceipt` | `{idempotency_key}` returns the original caller's public receipt after current source/canonical authorization. |

Execution is `{repository_id,checkout_id,worktree_id}` from real enrollment.
CanonicalPin is `{at:GraphCommitAddress2,address:exact SemanticRevisionAddress,
record_keys}`. Existing-target bind requires `shared_base:null`, preserving the
origin. V0 allows one repository per exploration; Projects may contain many
repositories/explorations. Paths, branch names, remotes and source-event
citations never establish semantic origin.

Bind/genesis, ownership, binding retirement, operation origin, receipt and
outbox share the existing activation-admitted Graph transaction. Mutation
records actual publisher/workspace, fixed shared base and declared Project pin
alongside Graph effects. Keys are actor-scoped across all three write methods;
changed reuse rejects. Graph CAS mismatch has no effects. Same-generation
semantic competition retains the existing explicit-resolution behavior.

Exact committed retry precedes Git inspection and keeps the original A result
after switching to B, disabling capture or removing the directory. Current
credentials, source access and retained fence still apply. The private typed
operation record retains its Graph request; public mutation receipts retain
the existing Graph receipt shape.

## Git identity, history and views

Fresh writes read only selected Git metadata with bounded, nonblocking,
no-follow reads. They verify physical directories, HEAD, loose/packed ref and
detached/unborn state against actual registry identity. No source config,
hooks, index/worktree contents or network is read. Catalog/binding/selection
versions are checked inside the writer transaction. External Git and SQLite
do not share a lock: assurance is **observed**, and a switch after the final
observation remains a race boundary.

An unchanged rescan is usable. Known branch switches, detached HEAD changes,
first commit after unborn and removed/recreated worktrees/refs require explicit
rebinding. Unborn origins retain `{state:'unborn',commit:null}`. External linked
worktrees are supported; independent clones stay distinct. Unobserved historical
continuity is not certified. Prior origins, bindings and exact versions remain.

Unscoped Graph initialize/assert/resolve writes reject owned generations even
without the exploration namespace. Existing unowned Graphs and authorized
historical reads remain valid. Narrow `source_access` and rebuild paths retain
their authorization/activation/enrollment checks without the bound worktree.

`resolve({exploration_id,at,address,shared_keys})` and
`page({exploration_id,at,collection,cursor,limit,shared_keys})` put the existing
Graph result under `local`. `shared.origin_base` and `shared.current_project`
separately retain exact pins and current/historical/quarantined/unavailable
status. `shared_keys:null` uses the pin's optional selection. Every active usable
Authority inside the configured selection is included despite optional filters.
Coverage is explicitly selected/partial/unavailable, never all Project rules.
Candidate text cannot replace governing authority.

`getSelection({exploration_id,at})` returns the same checked shared selection
without selecting a local entity. This lets a Judge with zero relational targets
pin its origin/Project metadata without inventing a target. Shared results now
include `current_project.version` for exact consumer preconditions; this version
is separate from the immutable canonical Graph pin.

Actual reader issuance and source proof are rechecked against captured Graph
head, current source fence and access inside the final database view. Failed
checks return no previously fetched fragment. Missing/quarantined material
stays explicit; null selection does not mean there are no rules. The reader's
conservative Project-wide fence remains: invalidation can quarantine a fixed
origin pin. Fresh writes depending on it reject; v0 does not update that base.

`list({cursor,limit})` pages Project metadata and exact exploration heads, with
no main-branch default or semantic payload fan-out. Its cursor pins scope,
configuration and the first-page append high-water mark. Heads and availability
describe the current selected read. Stored binding counts and the latest
binding's availability are distinct, not a claim of live team presence.

Individual immutable rows/indexes replace cumulative snapshots. Pages select
1–32 candidates; canonical selection stays at most 16 records. Existing depth
16, 50,000-node, 1 MiB aggregate and 32-element semantic-support limits apply,
including nested responses. Overflow rolls back rather than truncating proof.
Unknown formats/corrupt selected indexes reject. No automatic repair, pruning,
adoption, base advancement or canonical promotion occurs.

Mutable binding/Project-selection pointers are checked against the latest
immutable declaration in a bounded key range; the append horizon is checked
against the final exploration index row. A lost or rolled-back pointer cannot
be interpreted as an initial empty state. The Graph ownership marker has a
paired immutable witness in the same namespace, so loss of either row blocks
ordinary legacy writes too. These checks detect selected metadata damage; they
do not claim protection from a privileged actor coherently rewriting SQLite.

Real temporary Git/SQLite, independent processes and SIGKILL fixtures verify
storage/routing. The opt-in synthetic JEV check measures model composition
separately from deterministic acceptance.

Run `npm run check:jev:exploration` with `TYPESAFE_API_KEY` supplied locally.
It sends four fixed synthetic cases from two actual isolated exploration
Graphs and one additional delayed-result probe to the official TypeSafe route.
Only selected event text, target ID/text and question reach the model. The
probe switches/rebinds the worktree while the fifth call is pending and verifies
that its result cannot be published under the old binding. This does not
implement the Policy consumer or certify product-level semantic quality.

The [retained scale measurement](measurements/exploration-projection-20260922.json)
keeps 601 origins, a 600-origin page horizon and at most 32 range rows per page.
The [live JEV report](measurements/jev-exploration-20260922.json) records four
matching cases and the fifth completed evaluation rejected after rebinding,
with no retries or rate-limit responses. Its pending evaluation may include
request pacing; it does not prove the Git switch preceded the provider's exact
network send. Final suite results are retained in the
[verification report](measurements/exploration-projection-verification-20260922.json).
