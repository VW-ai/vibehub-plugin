# Selected local Judge invocation

`LocalJudgeRuntime.evaluate(context, request)` runs one selected Judge node from
an actual compiled Policy artifact. It composes the existing authenticated
ingress, exploration, source invalidation, activation and provider-settings
modules. It returns a decision or a bounded refusal/defer result. It performs no
Graph write, canonical promotion, ingress ACK or autonomous scheduling.

Typed `runtime_context` revisions use the separate
[`evaluateContext` entry](context-judge-bridge-v0.md), which shares this dispatch
path and requires its own installed operation descriptor. The legacy target
profile below is unchanged.

This is an in-process service. The setup App, host plugins and full durable
Policy executor do not call it yet. The existing `executePolicyRun` still
rejects Judge/Worker nodes; its full-snapshot v1 interface is unchanged.

## Construction and selected input

The owner supplies actual `DomainStore`, `LocalCredentialAuthority` and
`ProviderSettings` instances, the existing canonical-reader configuration and:

```js
{
  schema_version: 1,
  scope: { tenant_id, project_id },
  settings_project_id,
  artifact, // exact compilePolicyArtifact output containing JUDGE_NODE_OPERATION
  egress_policy: {
    policy_id, revision, max_sensitivity: 'INTERNAL',
    allowed_providers: ['typesafe'],
    sources: [{ registration_id, local_only: false,
      allowed_providers: ['typesafe'], text_policy: 'selected-fields' }]
  }
}
```

The constructor freezes this configuration, validates the compiled artifact and
requires the installed operation descriptor exactly. Each selected node defines
`family`, `question_id`, `question_version`, `question_text`,
`confidence_threshold` and `impact: normal|high`. The owner explicitly binds the
tenant/Project scope to the separate provider-settings Project identifier.

Requests contain references and expected versions, never caller-supplied model
text, authority proof, provider routes or callbacks:

```js
{
  invocation_id, node_id, epoch,
  execution: { repository_id, checkout_id, worktree_id },
  exploration_id, execution_workspace_id,
  expected_binding_version, expected_catalog_version,
  expected_project_selection_version, // null when undeclared
  at, // exact current GraphCommitAddress2
  event_id,
  target_refs, // exact local SemanticRevisionAddress[]
  expected_source_fence
}
```

The event comes from durable ingress with a retained, digest-verified text
snapshot. Relational targets must be current, unambiguous local candidate
entities with `content.semantic_type: 'judge-target'` and this exact data shape:

```js
{ schema_version: 1, kind: 'judge_target',
  target_kind: 'acceptance' /* or 'context' */, text }
```

`acceptance_relevance` accepts acceptance targets; `context_relevance` accepts
context targets. `durable_cross_ticket_value` and
`independently_schedulable_work` require an empty target list. Each relational
target gets an alias derived from its exact revision hash. Returned target IDs
must validate against those aliases before being mapped to supplied revisions.
A relational call with no targets returns a local negative result with no
credential lookup or model send.

The outgoing model state contains only event type/timestamp/text and selected
target alias/type/text, plus the installed question. Source principal ACLs,
supporting provenance, inherited access sources and current source registration
versions are checked locally. Explicit source policy controls local-only,
destination providers and permitted selected text. Text approved by that policy
is forwarded verbatim; this is not automatic PII/secret/path recognition.

The origin canonical base and current Project selection are pinned and checked
separately. They contribute metadata to the result but no canonical text to the
model. `governance_evaluated: false` and `shared_material_sent: false` are explicit.
Relevance judgment does not prove compliance with Project rules.

## Admission, routing and budgets

An invocation requires an actual human/service grant for the fixed Judge,
source, store, ingress, Graph, exploration, invalidation, Project and activation
actions. The runtime checks scope, current Graph head, workspace binding,
observed Git catalog, Project selection and source fence. It materializes bounded
public reads outside the final admission, then checks an instance-private
retained proof inside the actual activation admission. No SQLite view spans a
provider await; callers cannot manufacture proof JSON.

The current settings digest and retained input proof are checked before key
use, after the secure-store await, at the SDK fetch boundary, on result return
and on completed-cache reuse. A changed pin refuses the result. The runtime
does not rebase or retry it against new inputs. Physical Git observation and
external network transmission are not one atomic transaction: a subsequent
change cannot recall already-sent input.

Routes are the existing explicit bindings: `typesafe/jev-latest`,
`vercel/typesafe-ai/jev`, and `openrouter/typesafe/jev-1.13`. Keys enter SDK
construction only inside `ProviderSettings.useCredential`. SDK logging,
automatic retries, redirects and provider fallbacks are disabled. The runtime
owns at most three attempts, using only configured and authorized routes.
Only HTTP 429/5xx can take another attempt or the next configured fallback;
auth, schema, policy, missing credential and low-confidence failures cannot.

One monotonic deadline covers preparation, credential lookup, sends, retries and
backoff. It is the minimum artifact/node/settings timeout and optional bridge
deadline. Each attempt conservatively reserves the full node token/cost budget
against artifact totals; failures do not refund it. These are admission proxies,
not provider-enforced billing caps or a whole-Policy-run ledger. Observed usage
is separate: missing telemetry and uncertain billed work are `null`, including
timeout after dispatch. Reported token/cost overflow defers the result.

Limits: 32 targets/support events/source registrations; event text 16 KiB;
each target 4 KiB; combined model input 64 KiB. Overflow is rejected without
truncation. Inert request/config/result JSON retains the existing 1 MiB,
50,000-node and depth-16 bounds.

## Result, cache and node bridge

Results carry status, exact selection/settings/policy/DecisionSchema pins,
input hash, validated decision, exact target refs, branch, recommendation,
bounded attempts/latencies and reserved/observed usage. They contain no selected
text, credential or raw provider body/error. A valid low-confidence result takes
`uncertain` and recommends `DEFER`, or `ESCALATE` for high-impact work. The caller
must use the existing public exploration mutation API to publish a candidate.

The completed-success cache holds at most 128 entries and 8 MiB; at most eight
invocations may be in flight. Its namespace is exact scope + authenticated
actor/kind + invocation ID. An equal in-flight duplicate is refused with
`invocation_in_progress`; changed retained-key reuse conflicts. Cache reuse
re-materializes the request and checks current permissions and every retained
pin. Key rotation/removal alone does not hide a previously completed authorized
result: cache hits make no provider request or credential lookup. Their attempts
and usage describe the original evaluation, with `cache: 'hit'` identifying reuse.
Failure and low confidence are not cached. Eviction/restart permits another send;
there is no durable or cross-process deduplication claim.

`executeJudgeNode({runtime,context,request,inputs,signal,deadline_ms})` is the
narrow typed bridge. Its inputs are the exact `event_ref` (observation key and
event digest) and a `signal_ref` digest of the normalized request. They are
checked before model dispatch. Success returns typed relevant/confidence,
candidates and decision-digest outputs with positive/negative/uncertain branch.
Failure returns a bounded `error_ref` and `handler_error`. The bridge reports
flat conservative `{tokens,cost_microunits}` usage compatible with the existing
handler contract. It does not manufacture a legacy Graph snapshot.

## Verification

`node --test test/judge-*.test.mjs verification/live/jev/test/jev-judge-check.test.mjs` exercises actual
local stores, actual SDK request/response shapes with recorded transport, and
negative authorization/race/failure paths. The existing Policy kernel tests
continue to prove the legacy full-run exclusion.

`npm run check:jev:judge` is opt-in and reads a locally supplied
`TYPESAFE_API_KEY`. It creates temporary synthetic Git worktrees, stores and
provider settings; existing user configuration is untouched. Eight fixed cases
cover all four families; a ninth revokes access immediately after the actual
fetch boundary is entered and requires the completed output to be discarded.
It also checks completed-cache reuse and explicit candidate publication. No
private repository or trace is selected. Reports contain only bounded decisions,
hashes, usage and measurements. Other routes remain recorded-transport tests
unless separately measured live.

The [2026-09-22 live measurement](measurements/jev-judge-runtime-20260922.json)
used official `jev-1.13.0`: 8/8 expected decisions, eight cache hits without extra
sends, four explicit candidate writes, and one completed-but-refused result
after source revocation. Successful model calls took 104–349 ms. This small
fixed synthetic sample checks composition; it is not a downstream-value study.
