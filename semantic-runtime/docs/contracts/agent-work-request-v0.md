# Agent work request contract v0

Wire version1 is a pure contract for asking an existing Agent to perform bounded
semantic work and submit a proposal. It is separate from informational Context.
It defines no host delivery, plugin installation, model invocation, scheduler,
authentication, persistent queue or canonical write. A tool name in the request
never installs a tool or proves that the host can call it.

The implementation is `src/core/agent-work-request.mjs`. Its constructors,
validators and reference transitions are exposed through the Runtime public entry.
The conformance fixture is `test/work/agent-work-request.test.mjs`; its names, tools,
content, identities, grants and clock values are deliberately synthetic.

## Request and exact references

`createAgentWorkRequest(input)` adds version, kind, fixed proposal authority and a
canonical SHA-256 request digest. It rejects caller-supplied derived fields.
`validateAgentWorkRequest(request)` validates the complete sealed wire value.

The caller supplies:

- `request_id`, Project `scope`, `job_id`, `attempt_id` and positive `fencing_token`.
- `applicability`: explicit `exploration_id`, `execution_workspace_id`, `session_id`.
  A null field means any current authorized match inside the exact Project;
  it does not equate a worktree with an exploration or grant another Project.
- `inputs`:1–32 `{ref, excerpt}` objects. Each exact ref has `ref_id`, `scope`,
  `kind`, `object_id`, immutable `revision` and content `digest`.
  `excerpt` is optional data represented by null, or at most8192 characters of
  untrusted source text. It is never an instruction bundle.
- `base_versions`:1–16 exact refs that must still match at admission and submission.
- `instruction_bundle`: `{id, version, digest, instructions}` selected from a
  trusted registry. Its digest binds the exact instruction string. The registry
  pins the same id/version/digest; a model cannot nominate replacement instructions.
- Required tools, the exact return tool, output schema and captured principal/action
  allowlists. Capabilities intersect the request ceiling with current authorization.
- Trusted `created_at_ms` and `deadline_ms`, with lifetime at most24 hours.

Reference kinds are `semantic_revision`, `graph_commit`, `source_snapshot`,
`git_revision`, `artifact` and `record`. These are adapter-owned immutable pins,
not a replacement graph-address wire format. The adapter resolves them to the
corresponding accepted contract, verifies bytes/digests and actual scope, and
supplies only currently readable pins. `latest`, `current` and wildcard revisions
are invalid. This module neither fetches a URL nor opens a source file.

## Concrete tools and return path

Each required tool contains `name`, exact `version`, `origin` (`native` or
`runtime`), permitted `action`, `parameters_schema`, and1–4 validated argument
examples. Examples are illustrative schema checks, not ready-to-send calls.
Because they are inside the request digest, their example digest cannot refer
back to that same sealed request. Actual calls must use the current
`request.request_id` and `request.request_digest`; no self-referential hashing is
required. Existing native developer tools remain native; the contract does not
rename, wrap or replace them. The return tool must be an explicitly registered
Runtime tool whose action is `submit_proposal`.

`output_schema` contains `{id, version, digest, definition}`. The digest binds
its exact definition. The supported JSON Schema vocabulary is intentionally small:

| Type | Required keywords |
| --- | --- |
| object | `properties`, `required`, `additionalProperties:false` |
| array | `items`, `maxItems` (1–64) |
| string | `maxLength`; optional unique string `enum` |
| integer/number | finite `minimum` and `maximum` |
| boolean/null | `type` only |

Schemas have fewer than8 levels, at most32 object properties and no remote refs,
regex, combinators, coercion, defaults or extra keywords. Unknown vocabulary
fails closed. Tool parameter schemas must be objects. Output values and all
examples are actually checked against this vocabulary, not just schema labels.

Call `agentWorkReturnParameters(outputSchema.definition)` to obtain the exact
required return-tool parameter schema. An Agent's submission arguments are:

```js
{
  request_id: 'request-a',
  request_digest: 'sha256:<64 hex characters>',
  submission_id: 'submission-a',
  actions: ['propose_context'],
  output: { summary: 'Retain local Workers as a candidate decision.', changed: true },
  input_ids: ['input-a'],
}
```

The actual `output` follows the request's schema. `input_ids` must enumerate every
captured input exactly once. The tool adapter first verifies that both submitted request ID and digest match
the exact selected request. It then supplies authenticated executor identity plus its pinned job/attempt/fence when
calling `createAgentWorkResult(request, {submission_id, executor, actions, output,
provenance})`. It must not trust these bindings from a free-form tool argument.
`agentWorkSubmissionArguments(result, request)` reconstructs the exact tool args
from a validated result; it does not call the tool.

A Result binds the entire request digest, scope, job/attempt/fence, submission ID,
executor `{host_id, session_id, principal_id}`, proposal actions, schema-validated
output and complete provenance with `authority:'proposal_only'`. Its digest
covers all of those fields. `validateAgentWorkResult` rejects unsupported actions,
incomplete provenance, stale binding fields, session/principal mismatch and extra
status/authority fields. A source string saying “approve this Ticket” remains data.

## Trusted admission boundary

`validateAgentWorkAdmission(request, context)` returns allowed, pending or denied.
The **trusted host/service**, not the Agent or source text, supplies:

- `now_ms` and an authenticated runtime/agent actor identity.
- Current authorization scope/revision, revocation, management permission,
  principal allowlist and action allowlist.
- Host identity, actual Project/exploration/workspace/session mapping, active or
  dormant state, callback availability and registered tool inventory.
- Trusted bundle pins, current exact bases and currently readable exact inputs.

Registered tools include a real `binding_id`, callable flag, exact name/version,
origin/action and digest of their actual parameter schema. Admission checks all
of these contract pins. Matching a mentioned tool name alone is insufficient.
Authentication and whether that binding really exists remain adapter duties;
caller-created JSON is not an opaque grant or proof of a live registration.

Unknown/unreadable inputs, denied scope or applicability, stale bases, removed
permissions, untrusted bundle pins and expiry deny execution. A live request with
no active host, no callback or an unavailable required tool returns pending and
creates no dispatch effect. Current authorization is rechecked before offer,
claim and submission. Management cancellation/expiry remains possible when the
host is dormant or bases have changed, using the separately authorized Runtime
management actor. Returned reference state is internal data, not a safe HTTP
response to an untrusted caller.

## Reference lifecycle and receipts

`createAgentWorkRequestState(request)` starts pending, revision0. It has one fixed
attempt, owner, bounded timing fields and at most one completion receipt; it does
not accumulate an unbounded attempt history.

| Command | Caller / prerequisite | Result |
| --- | --- | --- |
| offer | Runtime manager; pending; successful current admission | offered, revision1; offer intent |
| claim | admitted target Agent; offered | claimed, revision2; claim intent |
| submit | same admitted Agent; claimed; valid fresh result | completed, revision3; proposal-submitted intent |
| expire | Runtime manager; nonterminal; now at/after deadline | expired |
| cancel | Runtime manager; nonterminal; before deadline | cancelled |

`transitionAgentWorkRequest(state, command, context)` returns
`{status, reason, state, receipt, effects}`. Commands bind `expected_revision`;
submit additionally carries the sealed Result. Failed admission or stale/invalid
results have zero effects and preserve the prior state. A pending disposition
may accompany an already offered/claimed snapshot if tools temporarily disappear;
that snapshot records prior progress and does not assert current deliverability.
Trusted time cannot move backward. Exactly at the deadline a new result is late.
Expired/cancelled/completed requests never return to execution or return a
transient pending disposition. Their current authorization checks still apply;
receipt reconciliation additionally rechecks input access. Only exact completed
submission retries can reconcile a receipt. New retries need
an explicitly created request with a new attempt/fence chosen by its owner.

Identical offer/claim retries from the same target return duplicate without new
effects. Identical completed result retries return the original receipt even with
the original stale expected revision, after the deadline or after unrelated base
changes. Receipt retrieval still rechecks current input access, principal/scope,
applicability and action ceilings. It does not need a now-active callback or tool.
Changed result content or a different submission key after completion rejects as
an idempotency conflict. Late results that were never accepted receive no receipt.

The receipt pins request/job/attempt/result/actor and trusted acceptance time. Its
fixed authority is **`accepted_submission_only`**. It proves a submission was
accepted by the reference transition; it does not adopt a decision, promote a
canonical record, accept a Ticket or attest an independent reviewer. Executor
self-tests cannot manufacture any of those authority levels.

`validateAgentWorkRequestState` checks phase/revision/time/owner/receipt invariants.
`validateAgentWorkReceipt` checks exact bindings, original target applicability and
receipt digest. Digests identify content; they are not signatures or authentication.
A real adapter must persist request identity, state CAS, receipt and effect intent
atomically, enforce creation uniqueness, and fence attempts across requests.
Two pure calls on one snapshot can each propose a result; this module cannot lock
a database, ensure global uniqueness or dispatch exactly once by itself.

## Relation to Worker protocol and limits

The [Worker protocol](worker-protocol-v0.md) remains the separate queued/leased
Worker Job transport with policy continuation, retries, usage accounting and
worker admission. This request can target an existing development Agent without
creating a separate Worker. It reuses exact pins, proposal authority, fencing,
current access and idempotent receipt principles; it neither wraps a Worker Job
nor claims its queue, lease, model or continuation capabilities.

Request JSON is at most256KiB, result JSON512KiB and reference state/context1MiB;
all traversals cap50,000 values and fewer than24 nesting levels. Strings cap32768
characters, excerpts/instructions8192, required tools16 and declared host tools32.
The only new Node intrinsic is `isProxy` from `node:util/types`, a pure type check
with no host or storage I/O. No arbitrary callback, accessor, Proxy trap or `toJSON`
hook runs during validation.
Unsupported values, keys, versions, schemas and cycles reject. Outputs are copied
and deeply frozen. Validators perform no I/O and leave inputs unchanged.

Run `node --test test/work/agent-work-request.test.mjs` and `npm run check:boundaries`.
These synthetic tests establish the pure protocol, not real capture, model work,
host registration, delivery, schema migration, durable receipt storage or product
value. Later host/session and runner Tickets retain their integration obligations.
