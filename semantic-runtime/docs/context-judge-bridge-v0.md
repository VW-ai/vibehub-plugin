# Selected Context relevance

`LocalJudgeRuntime.evaluateContext(context, request, {signal})` evaluates whether
an admitted event relates to selected typed Context revisions. It uses the same
provider settings, source policy, admission, budgets and bounded result as the
[existing Judge runtime](judge-runtime-v0.md). Evaluation writes no Graph state,
adoption, receipt, outbox item, ingress ACK or canonical record.

This is an in-process library entry. Query ranking, the App and host plugins do
not call it automatically. The full `executePolicyRun` interface is unchanged.

## Configuration and request

The constructor and request shape are unchanged. A compiled Policy artifact
must explicitly install `CONTEXT_JUDGE_NODE_OPERATION` (`semantic-context-judge`,
version `1`) and the chosen node must use it. Its only family is
`context_relevance`. The legacy descriptor keeps its identity, four families and
`evaluate` method. An artifact may install either descriptor or both; method
and node mismatches refuse before credentials or transport.

```js
const result = await runtime.evaluateContext(localCredential, {
  invocation_id, node_id, epoch, execution,
  exploration_id, execution_workspace_id,
  expected_binding_version, expected_catalog_version,
  expected_project_selection_version,
  at, event_id, target_refs, expected_source_fence,
});
```

The caller selects exact references and expected versions, never target text or
authorization evidence. The opaque local human/service credential requires
`context:read` in addition to all existing Judge dispatch permissions. Provider
destinations still need explicit source registration policies and actual source
ACL/sensitivity checks.

## Eligible Context and model input

At most eight unique targets may be selected. Each must be an actual owned
typed Context at the exact current exploration head, with both assertion and
projection status `candidate`, `validated` or `resolved`, no competitor and no
quarantine. Historical, stale, superseded, rejected, contested, foreign, denied
and untyped targets refuse without a send. A's supersession does not invalidate
the independently adopted B version.

The typed reader verifies the retained publication and lifecycle operation.
For adopted content it follows the exact immutable publication sources, up to
32 publications including the selected target, and verifies the original typed
transition. Longer chains refuse with a capacity error. This check does not
depend on the source exploration's current semantic status or head; generic
exploration writes cannot launder an invalid transition through adoption.
Configured canonical-reader proofs establish exact Ticket applicability and
actual support establishes code applicability. Unspecified dimensions remain
explicitly uncertain. Across targets, eight distinct Ticket selection pins may
be prepared; several keys on one pin share a proof while each Context's own
support is checked.

Each target's model text is exactly:

```text
role\nsummary\n\ndetail
```

This text must fit 4 KiB including separators. Larger valid Contexts are
ineligible for this entry; they are not truncated. The event uses its actual
retained, digest-checked snapshot (16 KiB maximum). Target aliases bind exact
revision references and have type `context`. The outgoing envelope is still
only event type/time/text, target alias/type/text and the configured question.
It excludes applicability, lineage, change rationale, canonical text, structural
paths, actor/source identifiers and ACL records. Approved text itself is sent
verbatim; no automatic secret recognition is implied.

The union of actual support and inherited access events is bounded to 32, with
32 source registrations and a 64 KiB model envelope. Existing inert JSON bounds
apply. No candidate can escape its source's local-only or provider restriction.

## Admission and result

Public materialization and canonical preparation finish before admission. A
private proof binds the actual Context selection, publication and applicability.
The fixed internal reader rechecks that proof inside the existing activation
admission, without nested public snapshots or a transaction across `await`.
It runs after asynchronous credential retrieval, immediately before transport,
and before exposing or caching the response. Source/grant revocation or a
changed head, binding, Git catalog, Project selection, fence or settings refuses
the result. Already-sent input cannot be recalled.

Selection metadata adds `input_profile: {id:'runtime-context', version:1}` and
`context_targets` containing the exact ref, assertion/projection status,
verified applicability and publication origin ref. It contains no target text.
Shared origin/current Project rules stay separately pinned and authorized;
`governance_evaluated:false` and `shared_material_sent:false` remain explicit.
Relevance does not establish truth, compliance or adoption.

Both methods share the same process-local scope/actor/invocation cache and
in-flight namespace. Their request identities bind the fixed profile and node,
so reusing an invocation ID through the other method conflicts. Authorized hits
reprepare and recheck current pins. Empty targets produce the local negative
result without credentials or a send. Existing deadlines, conservative
reservations, three configured routes, uncertain-result behavior, cache limits
and restart/eviction limitations are unchanged.

`executeContextJudgeNode({runtime,context,request,inputs,signal,deadline_ms})`
returns the existing typed outputs and flat reserved usage. Its inputs are an
actual event reference and a selection signal whose digest is
`graphHash([{id:'runtime-context',version:1}, normalizedRequest])`. These pins are
checked before a send; a supplied deadline can only tighten the runtime limit.

## Verification

`node --test test/context/context-judge*.test.mjs` uses disposable real Git/SQLite stores,
admitted events, typed Context mutation/adoption and recorded provider transport.
The existing Judge and Context suites cover the reused paths.

`npm run check:jev:context` is a separate opt-in synthetic check using a locally
supplied `TYPESAFE_API_KEY`. It makes four new one-attempt TypeSafe calls: relevant
own Context, unrelated event, adopted B after A supersession, and an in-flight
source revocation whose completed response must be discarded. The first three
report actual labels and matches; the fourth reports completion and refusal,
with no expected model label. Missing credentials, mismatches or incomplete
responses cannot count as a successful live check. No ordinary test, constructor
or verification command reads a credential or makes a live model call.

The [2026-09-22 measurement](measurements/jev-context-bridge-20260922.json) used
official `jev-1.13.0`: three of three expected labels, three cache hits with no
extra sends, and the completed fourth response discarded after revocation.
The three model calls took 159–287 ms; observed cost was unavailable. This fixed
synthetic composition check does not measure general retrieval quality.
