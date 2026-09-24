# Worker Job and Result protocol v0

Wire version `1` is a provider-independent, bounded executable contract. Its
validators and pure transitions are exported through `src/index.mjs`. It consumes
the accepted identity, normalized event/provenance, causal source-vector, Working
Graph and compiled Policy artifact contracts. It performs no I/O, queue dispatch,
model execution, canonical writes, acceptance decisions, or storage transactions.

A successful Job means its executor returned a valid **proposal** under the
captured and current permissions. It does not resolve a Graph conflict, certify an
Acceptance, grant human authority, or accept the proposal as canonical truth.

## API

| API | Result |
| --- | --- |
| `validateWorkerJob(job)` | Strict wire structure, immutable refs and bounded values; returns `true` or throws. |
| `validateWorkerResult(result, job)` | Exact Job/input/schema binding, structured proposal fields and complete carried provenance; returns `true` or throws. |
| `workerResultDigest(body)` | SHA-256 of canonical JSON body, excluding `result_digest`. |
| `validateWorkerAdmission(job, context)` | `{status: 'allowed', capabilities, reason}` or `{status: 'denied', capabilities: null, reason}` against trusted current inputs. |
| `createWorkerJobState(job)` | Frozen initial `queued` state; no claim or authorization is implied. |
| `validateWorkerJobState(state)` | Structural/digest, attempt, receipt and terminal invariants. |
| `transitionWorkerJob(state, command, context)` | Frozen `{status, reason, state, effects}`; applies, rejects, or acknowledges an exact duplicate. |

All entrypoints validate JSON before reading nested values, reject accessors
without invoking getters, reject symbols/non-enumerable fields/sparse arrays,
cycles, unknown fields and versions, and leave inputs unchanged. Hashes use
recursively sorted object keys and preserve array order. Digests establish exact
identity, not authenticity; validators cannot establish that the supplied state,
source bytes, actor, authorization or policy are trustworthy.

The JSON traversal permits at most 250,000 values, nesting below 40 and strings
up to 16,384 characters. Jobs are at most 512 KiB, Results 1 MiB and reference
states 2 MiB. A Job contains 1–32 exact semantic revisions and 1–64 source events;
a Result contains at most 64 findings and 32 artifact refs. Attempts are bounded
to 1–32 per Job, lease duration to 1–600,000 ms, total Job lifetime to 24 hours.
These are protocol limits, not scheduler capacity or production SLO claims.

## Job envelope

Every required top-level field is present in the synthetic constructor at
`test/fixtures/worker-protocol/scenario.mjs`:

```js
{
  schema_version: 1, job_id, scope: { tenant_id, project_id }, worker_type,
  trigger: {
    policy_run_id,
    policy: { policy_id, version, content_hash, executable_hash },
    node_id, operation: { id, version, implementation_hash },
  },
  continuation: { policy: /* exact same artifact pin */, node_id },
  inputs: { graph_revision, revisions, source_events, watermarks },
  capability_ceiling: {
    allowed_principal_ids, allowed_operations, allowed_provider_ids,
    allowed_localities, sensitivity_ceiling,
  },
  output_schema: WORKER_OUTPUT_SCHEMA,
  created_at_ms, deadline_ms, retry: { max_attempts, lease_ms },
  idempotency_key,
}
```

The caller selects the policy from its trusted registry. Admission recompiles
its definition and trusted operation descriptors, verifies the whole artifact,
and matches both policy content and executable hashes. It checks the triggering
node is a WorkerNode, its operation ID/version/implementation hash matches, and
the separately named continuation node exists. Wire v1 continuation uses the same
immutable artifact. Version labels alone cannot authorize alternate code.

The continuation pin is a trusted routing declaration, not authorization to start
at an arbitrary node or bypass guards. A WorkerNode's enqueue-success edge need
not describe a later result route. The future ingress must validate the declared
business result route and legal entry of the new policy run before executing it;
this transport's existence check performs no routing or execution.

The Job's source events must equal the complete union of the pinned revisions'
normalized provenance events and access events. Exact event identity cannot be
rebound to other bytes. Events need accepted immutable replay eligibility and
source-object provenance; mutable pointers and invented/omitted provenance fail.
Accepted event payload digests bind content; materialization and actual byte
availability remain an adapter responsibility.

Inputs must belong to the same tenant, Project and Graph generation. Admission
requires the catalog retained by the current Graph, exact current GraphRevision,
and an identical `caught-up` captured source vector. Unknown and known-gap vectors
never imply current inputs. There is no timestamp-derived order across sources.

Explicitly competing or non-head revisions in that exact captured snapshot may
be read for reconciliation. Each exact revision is resolved with current source
access; competing revisions remain separate, including all their restrictions.
This is deliberately broader than the Graph's conservative
`validateWorkerGraphInput` helper, which requires uncontested current heads.
A later snapshot invalidates the captured Job even when unrelated state changed;
v1 does not silently rebase it or choose a winner. A later service can issue a new
Job with a new snapshot after an explicit policy decision.

`idempotency_key` is a scoped creation identity. A future durable enqueue adapter
must atomically enforce `(tenant_id, project_id, idempotency_key) -> job_digest`:
identical redelivery returns the existing Job; different contents reject. Merely
calling `createWorkerJobState` twice cannot enforce global uniqueness.

## Authorization and trust boundary

Admission context is supplied by the trusted service:

```js
{
  catalog, policy_artifact, current_graph,
  authorization: {
    schema_version: 1, scope, authorization_revision, revoked,
    capabilities: /* same shape as the captured capability_ceiling */,
  },
  worker: { scope, worker_id, principal_id, provider_id, model_id, locality },
}
```

`authorization` and `current_graph` are selected inside the service's authorized
read/commit boundary. They must never be taken from the worker's self-declared
request. Catalog mapping, model names, hashes and `actor.role` are not credentials.
Authentication, worker enrollment/worker-type eligibility, policy selection,
source lifecycle authority and current authorization lookup belong to adapters.

Effective access intersects original and current principal, operation, provider
and locality allowlists; it takes the lower original/current sensitivity ceiling.
The assigned worker must be in that intersection, retain `read_context` and at
least one proposal operation, and satisfy every source event's effective ACL and
sensitivity. Later widening never expands the Job ceiling. Revocation, unknown or
missing sources, empty intersection, cross-scope input, ACL tightening and
tombstones deny admission. Claim, start, heartbeat and completion recheck it.

Allowed operations are only `read_context`, `propose_candidate`,
`propose_resolution`, `propose_canonical` and `propose_plan`. `propose_canonical`
creates a proposal; it grants no canonical write. Current operation revocation
also rejects a previously permitted finding at completion. Confidence cannot
satisfy human-owned acceptance or expand authority.

## Job and Attempt state machines

A state retains an immutable Job plus its digest, monotonic `revision`,
`state_digest`, `last_now_ms`, bounded Attempt history and completion receipts.
The trusted adapter chooses `now_ms` (nonnegative integer milliseconds) and actor
scope/identity. Caller-supplied worker timestamps do not control lease validity.
No transition accepts time moving backward, including duplicate acknowledgements.

Commands include `type` and `expected_revision`. Worker commands additionally
bind `attempt_id` and `fencing_token`. `complete` includes the exact Result.
`claim` supplies a new `attempt_id`; the worker descriptor comes from admission.

| Actor | Command | Legal starting state | Effect |
| --- | --- | --- | --- |
| Runtime | `claim` | `queued` | Creates new leased Attempt, increments fence, reserves one attempt. |
| Lease owner | `start` | `leased` | Marks that Attempt and Job `running`. |
| Lease owner | `heartbeat` | `leased` or `running` | Renews only a still-live lease, capped at Job deadline. |
| Lease owner | `complete` | `running` | Successful Result ends Job `succeeded`; failed Result follows retry rules. |
| Runtime | `expire` | Any nonterminal state after Job deadline | Ends Job `expired`, ends live Attempt `expired`. |
| Runtime | `expire` | Live Attempt at/after lease expiry, before Job deadline | Ends Attempt `expired`; Job becomes `queued` or `dead-letter`. |
| Runtime | `cancel` | Nonterminal, before Job deadline | Ends Job and live Attempt `cancelled`. |
| Runtime | `supersede` | Nonterminal, before Job deadline | Ends Job and live Attempt `superseded`. |

A lease is expired at exactly `now_ms == lease_expires_at_ms`. Renewal cannot
revive it. A Result received after expiry rejects even if its own timestamp says
it finished earlier. A Job expires at exactly its total deadline, including while
queued; no `expired -> queued` Job transition exists. Only an **expired Attempt**
can be followed by a newly queued, still-valid Job and a new Attempt identity.
The fence is the monotonically increasing attempt ordinal within the Job.

Each persisted Attempt retains `failure: null` or the Result's exact classified
`{code, retryable}` failure. State validation requires every earlier Attempt to
be an expired lease before the Job deadline or a retryable failure. Success,
cancellation, supersession and nonretryable failure cannot precede another
Attempt. It derives the legal final Job status from that history; a completed
success cannot be relabeled cancelled or expired by recomputing its state digest.
An already queued retry may still receive a later runtime cancellation,
supersession or total-deadline transition, which is counted separately.

Temporal checks require expiry at or after the lease boundary, renewal within
the retained Attempt time plus lease duration, and Job/Attempt time agreement
unless a later queued termination exists. The revision must be at least the
number of retained claim/start/terminal transitions and any later queued
termination; an untouched Job has revision zero. Heartbeats can add revisions.
These checks reject impossible persisted shapes; trusted storage and CAS still
own authenticity and actual transition history.

A failed Result marks its Attempt `failed`. A retryable failure requeues the Job
while attempts remain; exhaustion ends it `dead-letter`. Nonretryable failure
ends it `failed`. Permission denial, cancellation and budget exhaustion cannot
be marked retryable. Other classified failures are bounded enum values, without
provider error bodies. Terminal Jobs (`succeeded`, `failed`, `expired`,
`cancelled`, `superseded`, `dead-letter`) never return to execution.

Expected revision, identity/fence, ownership, current authority, live lease and
terminal checks reject invalid races without effects. Two pure calls against the
same queued snapshot may each propose a claim. A durable store must CAS the
expected revision and commit exactly one resulting state with its outbox and
accounting. This reference function cannot lock a database or fence a remote
executor by itself. The adapter must not dispatch both proposed claims.

## Result envelope and idempotency

A Result contains exact `scope`, `job_id`, `job_digest`, Attempt identity/fence,
`result_id`/`result_digest`, copied `trigger`, exact `consumed_inputs`, and
`output_schema`. Its executor descriptor must equal the leased descriptor;
`timings` contain start, finish and duration with exact internal arithmetic.
The reported start must match the actual start transition, finish cannot exceed
trusted receipt time, and receipt must occur while the lease and Job are live.

Structured findings contain only `finding_id`, proposal `operation`, `summary`,
`confidence`, and explicit input-revision/source-event/artifact indexes. The Result
also enumerates **all** input and source indexes in its `provenance`, with fixed
`authority: 'proposal_only'`. Omitted or invented refs, out-of-scope artifacts,
unknown fields, hidden reasoning fields, unsupported actions and authority/status
elevation reject. Summaries and source text are untrusted data, never commands.

Artifact refs contain version `1`, exact scope, `artifact_id`, immutable `revision`,
`digest`, `kind: 'candidate' | 'proposal'`, and source indexes. They contain no
mutable URL/latest lookup. A downstream business Worker must pin its instruction
bundle and output-schema digests in the trusted Worker operation config (which
participates in the policy's content/executable hashes). It can return a separately
schema-validated structured business document through one of these exact artifact
refs—for example reconciliation statuses and exact resolution parents. It must
not encode the business protocol solely into summary text. This transport does
not retrieve artifact bytes or pretend to validate those future business schemas;
materialization, digest verification and the separately pinned business validator
remain prerequisites to consuming them. No generic executable payload is added.

`usage` reuses `normalizeUsageObservation`: account entitlement, actual measured
consumption and estimated monetary cost remain distinct. Unknown token counts,
proxy units or cost remain `null`, not zero. Each admitted completion, including
failed/retried attempts, creates one receipt and one `record_usage` effect. Exact
redelivery returns `duplicate` with the same state and **zero** extra effects,
even with the original stale `expected_revision`. Different content under the same
Result ID or Attempt conflicts. Result and Attempt IDs have separate namespaces.

Claim emits `attempt_reserved`. Expired/unreported attempts retain that reservation
and unknown consumption; this contract never refunds them or assumes zero usage.
Rejected stale or late Results create no effects here. Later result-ingress and
accounting adapters must retain bounded late-result audit and measured consumption
without promoting the Result or charging a prior receipt twice. Late audit cannot
bypass the expired Attempt fence. Durable aggregate budgets, fairness, quotas and
exactly-once accounting across crashes belong to the scheduler/journal adapters.

Success additionally emits `result_available` with only Result ID/digest and
proposal authority. It does not mutate the Graph or original PolicyRun snapshot.
A continuation is a separately validated policy run on a new explicit snapshot,
using the pinned policy/node; result reception is not canonical promotion.

Effects are internal commit intents, not arbitrary callbacks or raw audit payloads.
A telemetry adapter must use the existing fixed `normalizeAuditEnvelope` allowlist
and correlation aliases, never copy Result bodies, summaries or provider errors
into audit. Replay may retain proposal data in its isolated generation; the
existing causal replay effect allowlist continues to forbid real Job/provider,
callback, live cursor and canonical dispatch. This module performs no such effects.

## Verification

```sh
node --test test/work/worker-protocol.test.mjs test/work/worker-protocol-integration.test.mjs
npm run check:boundaries
```

The sanitized fixture uses a real compiled synthetic WorkerNode artifact,
normalized events and Working Graph snapshots. Conformance covers explicit
competing assertions, exact immutable pins, current ACL/source changes, unknown
and gapped watermarks, original capability ceilings, actor and attempt fencing,
backward time, queued expiry, lease renewal/expiry/retry exhaustion, cancellation
races, competing CAS proposals, duplicate terminal accounting, unknown usage,
strict provenance, scoped artifact refs and candidate-only effects. Public-entry
integration connects these contracts without importing plugin internals.
