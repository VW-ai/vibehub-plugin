# Explicit exploration adoption v0

`LocalExplorationStore.adopt` copies one exact authorized entity or relation
from exploration A into a new candidate in B. The source stays unchanged.
Looking at another exploration, merging Git branches, or receiving a positive
Judge result never invokes adoption automatically.

This is an authenticated in-process Runtime API. The existing local App and
coding-agent connectors do not yet expose this command. It reuses the Graph
writer, activation admission, existing exploration namespace and immutable
receipts; there is no new database table, service or model dependency.

## Command

```js
const result = explorations.adopt(context, {
  epoch,
  idempotency_key,
  publisher_ref,
  expected_source_fence,
  source: {
    exploration_id: sourceExploration,
    at: sourceCommit,                 // Exact historical selection is allowed.
    address: sourceRevision,
    expected_head: currentSourceHead, // Independent race precondition.
    shared_base: sourceOriginBase,
  },
  destination: {
    exploration_id: destinationExploration,
    execution_workspace_id,
    expected_binding_version,
    expected_catalog_version,
    expected_project_selection_version,
    expected_graph: currentDestinationHead,
    shared_base: destinationOriginBase,
  },
  endpoint_map: [], // An entity has no mappings; relation rules are below.
});
```

All fields are required. The opaque local human/service grant must include
`exploration:adopt` and `source:read`, alongside the existing exploration,
Graph, store, ingress, source-invalidation, Project and activation permissions.
Actor and scope come from that grant. The caller supplies no assertion, text,
ACL, publication identity or lineage proof.

A and B must have different owned Graph generations in the configured Project.
Their requested shared bases must match their immutable origins. Current and
historical reader-verified canonical pins are usable; an unavailable or
quarantined non-null pin refuses. Null retains the existing unknown-coverage
semantics. Adoption does not change either origin or the Project selection.

A fresh command requires B's actual enrolled worktree and current binding.
Reading historical A does not require its worktree to exist. Heads, ownership,
source fence, shared pins, Project selection and current grants are checked
again under the Graph-owned writer transaction. Physical Git assurance remains
observational: SQLite and Git do not share a lock.

## What gets copied

The exact A assertion must be readable, unquarantined and have status
`candidate`, `validated` or `resolved`. A specific candidate in a contested
view may be selected without resolving that contest. Selecting an older eligible
revision after later semantic changes is deliberate and supported.

B always receives a fresh service-derived item/assertion ID, status `candidate`,
no base revision and no foreign parents. Entity content is unchanged. Ordinary
support events are flattened from actual provenance, and canonical associations
remain explicit. A's accepted status never becomes B's acceptance authority.
Canonical-selection service metadata cannot be copied as ordinary knowledge.

A relation keeps its supported type/data and canonical artifact endpoints.
Every semantic endpoint must be mapped to an exact B endpoint previously adopted
from that same exact A endpoint. Adopt those items first, then supply up to two
unique `{source, destination}` mappings. The Runtime verifies the stored revision
origin, Graph receipt and exploration origin chain. Another authorized actor's
endpoint adoption is usable; copied receipt JSON, matching text, arbitrary B
items and implicit recursive adoption are insufficient.

Lifecycle access events stay separate from ordinary support. Actual active B
source-access projections must already include every captured A restriction,
including inherited endpoint support. A missing projection refuses; the existing
separately authorized lifecycle command can prepare B. Extra B restrictions
remain effective. The aggregate ordinary/access event limit is 32, in addition
to the existing selected-closure and inert-JSON bounds. Nothing is truncated.

## Effects, retry and retained access

One activation-admitted SQLite transaction commits the B Graph change, source
retention, audit, Graph receipt/outbox, and exploration origin/receipt/outbox.
The result contains the new revision, receipt, `operation_origin_ref`, and an
`adoption` summary with exact A selection/publication and verified endpoint map.
The adoption origin also retains actual B execution/workspace, publisher, base,
prior/next Graph and resulting revision. Original A records remain untouched.

Actor-scoped idempotency keys share the existing bind/mutate/selection namespace.
An identical normalized request returns the original result with `duplicate`;
a changed body or method conflicts. A different key means a new intent and
creates another B candidate. Concurrent distinct requests for one B head yield
one commit and a no-effects CAS refusal. Rejected commands return bounded domain
errors without source text or filesystem paths.

Committed retries and `getReceipt` resolve before fresh physical checks. They
survive restart, worktree/branch switching or deletion, Project disable and later
semantic changes. They still reauthorize the original exact A input, B result,
endpoint support, current/captured source access, shared pins and retained source
fence. Revocation, tombstone or conservative Project invalidation can therefore
withhold an old receipt without deleting immutable lineage. Retry never silently
substitutes today's content or moves the base.

## Verification

Deterministic tests use actual disposable Git worktrees and SQLite stores,
independent processes, before/after-commit SIGKILL, ACL/lifecycle and selected
metadata corruption cases. Run `npm run verify`, `npm run verify:standalone`,
then the separate root `npm run verify:artifact` check.

`npm run check:jev:adoption` takes `TYPESAFE_API_KEY` only from the local process
environment. It sends four fixed synthetic examples through `LocalJudgeRuntime`
to the official TypeSafe endpoint. It verifies that B cannot use A's foreign
revision before adoption, both branches judge their own exact target afterward,
and source revocation prevents another send. The adoption itself uses zero
model calls. The [retained live measurement](../measurements/jev-adoption-20260922.json)
records 4/4 expected decisions from `jev-1.13.0`, at 108–342 ms model time.
These examples are a transport/integration check, not a general accuracy claim.
