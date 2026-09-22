# Typed Context lifecycle v0

`LocalContextStore` supplies typed decisions, constraints, observations, evidence
and questions over the existing exploration-owned Graph. It uses the same
immutable revisions, publication receipts, source restrictions and atomic SQLite
transaction as `LocalExplorationStore`. There is no additional database table,
namespace or background process.

This is an in-process domain API for later App/plugin/query integration. It does
not extract Context from conversations, resolve entity identity, rank a query,
run a Worker or promote anything to canonical project authority. The existing
selected Judge accepts `judge-target` / `judge_target`; this new `runtime_context`
profile is not yet a supported Judge target.

## Public surface

```js
import { LocalContextStore } from '@vibehub/semantic-runtime';
const contexts = new LocalContextStore({ store, authority, canonical_reader });
```

The configured canonical reader is the same actual repository/registration/
selection configuration used by `LocalExplorationStore`. Every operation needs a
current opaque local grant with `context:read` and the underlying Graph/store/
exploration/source actions. Writes also need `context:write` and a human or service
principal. These facade grants do not revoke an existing lower-level capability.
Ordinary reads of an adopted B revision use current semantic/source read access.
Reading or retrying the original adoption receipt additionally retains the
adoption/source permissions of that command.

| Method | Request and result |
| --- | --- |
| `mutate(context, request)` | Exact existing exploration mutation request, restricted to typed Context assert/resolve. Returns its original Graph result/receipt. |
| `adopt(context, request)` | Exact existing adoption request with a typed entity source and empty `endpoint_map`. Requires `exploration:adopt` and `source:read`. |
| `resolve(context, {exploration_id, at, address, mode})` | Logical/exact entity address, `mode: current` or `as_of`; returns one selected item or an explicit denied/not-found/unsupported result. |
| `page(context, {exploration_id, at, mode, collection, cursor, limit})` | Heads, one entity's history, or one entity's conflicts; limit 1–16. |
| `lineage(context, {exploration_id, at, address, mode, cursor, limit})` | Selected root and a page of direct outgoing links; limit 1–16. |
| `getReceipt(context, {idempotency_key})` | Original actor-scoped receipt fields with a verified read-time `shared` view; null for an unknown key. |

There are no role filters, `shared_keys`, archive/hide flags, free-form adoption
rationale, transaction hooks or implicit branch selection. Collection shapes are
`{kind:'heads'}`, `{kind:'history',entity_kind:'entity',entity_id}` and
`{kind:'conflicts',entity:{entity_kind:'entity',entity_id}}`.

## Meaning and applicability

An entity assertion carries this exact content profile:

```js
{
  semantic_type: 'context',
  data: {
    schema_version: 1,
    kind: 'runtime_context',
    role: 'decision',
    summary: 'Use the local subscription executor for this exploration.',
    detail: 'The canonical project decision remains a separate selection.',
    applicability: {
      project: 'owning',
      exploration: 'owning',
      tickets: { mode: 'unspecified', refs: [] },
      code: { mode: 'unspecified', refs: [] }
    },
    change: { kind: 'create', reason: 'An explicitly sourced working decision.' }
  }
}
```

Roles are `decision|constraint|observation|evidence|question`. Summary/reason are
nonempty (512/2,048 characters maximum); detail is at most 8,192 characters.
Unknown fields, getters, Proxies, invalid JSON and unsupported versions refuse.
The pure `validateContextContent1` returns normalized, sorted applicability refs;
the Graph command retains its submitted identity and original immutable bytes.

Owning Project/exploration IDs come from the actual grant and generation owner.
The declared exploration can instead be `unspecified`. Ticket/code dimensions
require `unspecified`, `any`, or `exact`: the first reports uncertainty, the
second explicitly declares no narrower selection, and the last requires 1–8
unique references. Missing fields never become `any`.

- Ticket refs are `{at,address,record_key}` selecting an actual configured,
  reader-issued, usable Ticket record. The projection returns its Ticket ID,
  exact Contract revision/identity, selection status and canonical event ref.
  The assertion's actual support must include that canonical event, either
  directly or through an authorized parent.
- Code refs are `{event_digest}` matching an actual `canonical_refs` Git revision
  event. The projection returns repository, object format, commit OID, path and
  event ref. This cites an observed immutable version; it does not infer current
  HEAD, working-tree contents or semantic ancestry.

The `meaning` field preserves the declared content. A separate `applicability`
field contains verified refs, actual owner scope/exploration and named uncertain
dimensions. Source refs come from actual authorized provenance. A role such as
`constraint`, a `validated` state or matching text grants no canonical authority.

## Transitions and lineage

| Typed change | Actual immutable operation |
| --- | --- |
| create | New candidate entity, null base, no parents. |
| derive | New candidate entity with supporting parents. |
| branch | New candidate entity with one exact typed Context parent in the same generation. |
| revise | Same entity with an exact base; candidate, validated or rejected. |
| supersede | Same entity/base, new assertion status `superseded`. |
| invalidate | Same entity/base, new assertion status `stale`. |
| resolve | Actual Graph resolve, current base, complete competitor parents and exact conflict digest; status `resolved`. |
| adopt | Existing explicit A→B command creates a new B candidate; actual verified origin identifies this transition. |

A current Graph with an old semantic base retains a real conflict; a stale
expected Graph cannot publish. A base is concurrency/lineage, while parents are
support: a corrected claim can use fresh authorized evidence and an unreadable
old base without copying the old content or inheriting its restrictions.

Adoption preserves A's content unchanged. B's `transition.kind` is therefore
`adopt`, with structural reason `explicit_adoption` and prose reason
`not_recorded`; copied `meaning.change` still describes A's assertion. B owns its
instance and applicability, while the source link identifies A's exact version
and real publication. A later supersession in A does not modify B.

Lineage exposes base, parent, publication, current conflict, actual resolution,
adoption-source and captured source-lifecycle links. It verifies the immutable
revision → commit receipt → Graph command/receipt → exploration operation chain.
It never infers a historical publisher from the current branch or uses another
actor's private receipt API. Forward history uses `page(history)`.

An independently readable root can return a known denied target reference with
`availability:'unavailable'`, without its text, actor or rationale. Corrupt
required origins/receipts/indexes fail closed. Ordinary untyped Graph entries
remain unsupported; they are not silently migrated.

## Time, authority and bounds

`at` always pins the local Graph commit. `current` additionally requires the
current local head to equal `at`; `as_of` reads the exact local historical view.
Each item distinguishes immutable assertion status, projection head/status/
competitors and `historical_role`. The observed current head is returned
separately. An older candidate assertion is not presented as the current choice.

All successful materialized reads include separate `shared.origin_base` and
`shared.current_project` views, exact pins/status/coverage, and a `governing` list
with actual usable active Authority records and artifacts. The immutable origin
base may be historical; the current Project declaration and ACLs are read-time
facts. This is not a global historical snapshot. Coverage describes configured
records only; null, unavailable and partial selections remain explicit.

Semantic invalidation is distinct from the existing separately authorized
source-access/tombstone operation. Current source restrictions apply to history
and receipts too. Hiding a card, closing a Ticket, merging code or deleting a
worktree does not silently retract or promote Context.

Pages inspect at most `limit` underlying candidates and may be empty with a
continuation. Lineage enumerates at most 128 direct edge candidates and
materializes at most 16 targets plus its root. The preparation pass uses raw
bounded locators, then the final authorized pass makes at most 17 semantic
point reads, each retaining the existing 256-port-call ceiling. At most eight
distinct Ticket selection pins are prepared per response. Current grants,
source fence, selected heads, canonical proofs and Project pointer are checked
before returning. Cursors bind scope/configuration/exploration/selection/mode/
position and read-time Project/fence pins; they carry no authority.

Inherited JSON limits remain 1 MiB, depth below 16 and 50,000 nodes; each public
response also has the aggregate byte limit. The Graph support limit remains 32.
Overflow refuses rather than dropping provenance.

## Verification

`node --test test/context-*.test.mjs` exercises actual Git/SQLite fixtures,
profile/proof validation, transitions, A/B independence, applicability, authority,
permissions, historical pages, lineage and race/continuation bounds. Existing
process harnesses verify two-writer idempotency and SIGKILL before commit and
after commit before reply for typed mutations and adoption.

The existing four-case real JEV adoption regression was rerun after this
integration using fixed synthetic text: 4/4 matched, with source revocation
refused before sending. See
[the measurement](measurements/jev-context-regression-20260922.json). This is
regression evidence for the existing Judge path, not new typed Context support.
