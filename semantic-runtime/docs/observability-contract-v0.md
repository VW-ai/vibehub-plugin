# Observability, engineering targets and resource budgets v0

Status: executable protocol and synthetic conformance fixtures, 2026-09-21.
Exported constants have `schema_version: 1`; “v0” names the delivery slice.
These are initial engineering requirements, **unproven until the capacity drill**.
They establish neither service availability nor provider speed, product value or
a commercial SLA. No collector, persistence adapter or model call is implemented.

The provider-independent module `src/core/observability-contract.mjs` implements
shared boundaries from Tech Design §§17,23,24,27,30. Platform, telemetry,
scheduler, audit and recovery Tickets consume these public contracts.

## Safe audit envelopes

`normalizeAuditEnvelope(input)` validates a strict envelope and returns a detached,
deeply frozen copy. Unknown fields fail closed; errors are fixed codes without
submitted values. Fields are version, stream/sequence/previous digest, audit ID,
canonical UTC millisecond timestamp, subject/status/reason enums, correlation and
finite nonnegative numeric measurements.

Every correlation includes `tenant_id` and `project_id`:

| Subject | Additional required correlation |
| --- | --- |
| Event | `event_id` |
| PolicyRun | `event_id`, `policy_run_id`, `policy_revision` |
| NodeAttempt | PolicyRun fields plus `node_id`, `node_attempt_id` |
| GraphRevision | `graph_revision_id` |
| Job | `job_id`; `job_attempt_id` when an attempt exists |
| Query | `query_id` |
| Package | `query_id`, `package_id`, `graph_revision_id` |

`source_id` and `session_id` are optional. Any supplied PolicyRun requires its
immutable SHA-256 policy revision and event; attempts require their parents. Jobs
can be audited at enqueue before an attempt exists. Carry all known causal
correlation, never invented placeholders. This contract does not resolve identity
or authorize access.

Audit IDs allow 128 ASCII letters/digits/underscore/hyphen. Identity catalog IDs
use a broader 200-character grammar. `auditCorrelationId(kind, tenantId,
logicalId)` deterministically maps version, typed field, tenant and logical ID to
`c_<sha256>`; for example, map `project:a/b` with kind `project_id`. Use the same
mapping across producers, including tenant IDs; never mix raw and aliased scopes
in one stream. Policy artifact digests keep their exact identity. An authorized
query can recompute aliases from its authorized catalog. Pass registered logical
IDs only: hashing credentials, prose or URLs is not redaction or authorization.

There is no raw message, prompt, response, free-text reason, stack, URL, path,
provider error body, hidden chain of thought or credential field. Synthetic
fixtures reject those fields and secret-shaped IDs. An allowlist cannot detect
arbitrary secrets disguised as legal IDs; trusted producers must construct
explicit envelopes and never spread payload objects. Raw evidence remains in
separately authorized source storage. Audit exports require scope/source access
and retention checks; aliases do not make exports public.

`appendAuditEnvelope(cursor, input)` returns a new immutable envelope and cursor.
Sequence 1 has null predecessor; subsequent appends require exact scope, stream,
next sequence and prior SHA-256 digest. Canonical hashing sorts object keys.
Corrections append new envelopes. Adapters must atomically append and CAS the
cursor, enforce unique audit IDs and authenticate producers. Hash chaining is
not a signature or protection against rewriting an entire history. Pruning must
retain an authorized chain anchor.

Envelope size is capped at 8192 UTF-8 bytes. Numeric fields include duration/queue
age, input/output/cached tokens, usage proxies, payload/package size, stable/total
prefix bytes and retries. Cached tokens cannot exceed input tokens; stable prefix
bytes cannot exceed total prefix bytes. Prefix bytes are a cache proxy, not an
actual KV hit measurement.

## Metrics and cardinality

`validateMetricLabels` permits only fixed-enum `subject`, `status`, `reason_code`.
Metric names come from a later fixed telemetry registry. IDs, policy revisions,
models and arbitrary strings are not metric labels; authorized audit queries
provide those breakdowns. `admitMetricSeries(existing, labels)` caps combinations
at 256 per metric and permits already admitted series when full. New-series
rejection returns `cardinality_limit`; increment one fixed unlabeled drop counter
without recursively labeling it with rejected values. One collector owns each
metric budget per 60-second window; exporters also need a longer-retention cap.
Never discard decision audit records to satisfy a metrics cap.

## Reproducible initial workload

`ALPHA_WORKLOAD` fixes `alpha-synthetic-v1`, seed 20260921. A future capacity
harness must hash its generated trace, seeded graph, policy artifact, build and
effective budgets before running. Changed inputs produce a new comparison,
never a retroactive pass of an old gate.

| Dimension | Requirement |
| --- | --- |
| Scope | 2 tenants × 2 projects; 2 repositories + 1 agent source per project (12 source registrations) |
| Graph | 10,000 entities + 50,000 relations/project; at most 64 query candidates |
| Clients | 16 active; maximum 32 simultaneous requests |
| Steady | 20 minutes; 4 events/s + 1 query/s total; round-robin projects |
| Burst | 60 seconds; 16 events/s + 4 queries/s total; same 80/20 mix |
| Recovery observation | 5 minutes after burst/fault removal, with steady traffic resumed |
| Bounds | Events typical 2 KiB/max 16 KiB; query max 4 KiB; package max 4096 tokens |
| Model path | Every fourth **project-local** event takes 2 calls; others terminate deterministically; 1024 input + 128 output tokens/call |
| Worker path | Additional 1 job/project/minute; synthetic execution 30 s, deadline 120 s |

`model_event_selection` specifies project-local zero-based ordinals whose
remainder is 3 modulo 4. `selectAlphaWorkloadEvent(globalEventOrdinal)` is the
executable reference: route global ordinal modulo 4 to its project, then divide
by 4 (floor) for that project's local ordinal. Ordinals continue across phases.
Thus global events 12–15 first select one model event in **each** project;
selecting every fourth global event would incorrectly overload one project.
Each 60-second steady window uses 30 calls/34,560 tokens per project (120 calls/
138,240 tokens global); burst uses 120 calls/138,240 tokens per project (480 calls/
552,960 tokens global). Proxy units equal calls. Both fit unchanged default
project/global budgets. The synthetic trace regression checks every window of
both phases. Deliberate noisy-project saturation remains a separate drill.

Model durations come from a separately pinned capacity fixture and must be
reported. Synthetic transport measures Runtime under those delays, not JEV/
Haiku/Codex speed. Separately authorized live drills report route and observed
quota; they cannot silently replace failed live work with synthetic successes.
Nominal, saturation and deliberate fault scenarios are separate runs.

## Measurement and numerical gates

`ALPHA_SLO_TARGETS` fixes initial gates, measured separately in steady and burst
windows. Use monotonic local timing; cross-process clocks require documented
synchronization/error bounds or one collector clock. Report counts, histograms
and missing samples. Nearest-rank percentiles cover completed qualifying
operations, while failures/timeouts/still-pending work count against success;
report latency and success together, never discard failures to improve results.

| SLI | Start → end | P95 / P99 |
| --- | --- | --- |
| Durable ACK | Valid authorized request received → inbox/outbox committed durably and ACK sent | 200 / 500 ms |
| Event-to-candidate | ACK → first committed candidate for a fixture-prescribed candidate event | 1500 / 5000 ms |
| Query | Valid authorized request → compiled response with access recheck | 500 / 1500 ms |
| Event queue age | Durable enqueue → first processing attempt | 1000 / 3000 ms |
| Worker completion | Durable enqueue → accepted/fenced result committed through policy | 90 / 180 s |

ACK, query, prescribed candidate and worker success each require ≥99% of offered
qualifying work. Expected deterministic ignores are not candidate events.
Exhausted/stale/timed-out jobs are failures and leave candidates unresolved.
The 20-minute worker window has 80 jobs: report this count rather than imply
production tail confidence from a small sample. Report depth and oldest age
throughout; excess backlog must drain within 300 s after fault/burst removal
while steady load resumes. Fault scope is a single process or outbound provider.

PRD §11.1 separately proposes deterministic typical <10 ms, semantic decision
P50 <150 ms and fast cascade P95 <500 ms. These remain experimental node/model
aspirations. The end-to-end gates include persistence, network, queues and
compilation; they do not replace those aspirations or claim their attainment.
Synthetic conformance is independent of downstream usefulness, precision and
false hard-action gates in Tech Design §30.

## Budgets, diagnostics and recovery

`DEFAULT_RESOURCE_BUDGETS` and `normalizeResourceBudgets(overrides)` expose strict
immutable integer configuration; zero retries is allowed. Typos, non-finite
numbers and per-project limits greater than global limits are rejected.

| Resource | Per project / global |
| --- | --- |
| Queued events | 1000 / 5000 |
| Concurrent policy runs | 4 / 16 |
| Queued workers | 20 / 80 |
| Concurrent worker attempts | 1 / 4 |
| Model attempts/60-second window | 240 / 960 |
| Input + output tokens/window | 500,000 / 2,000,000 |
| Usage proxy units/window | 240 / 960 |

A policy run permits 4 total model attempts and 8192 total tokens; retries count
against both. Each call allows 2 retries after its first attempt. One provider
attempt is one proxy unit when tokens are unavailable. Reserve conservative
input/output bounds before calling, then reconcile reported usage. Missing usage
never authorizes an unbounded call. Fixed 60-second windows share an epoch and
include outstanding reservations; queue/concurrency limits still protect window
boundaries. Retry-after defaults to 5 s, worker deadline to 120 s; Job protocol
owns leases.

`decideResourceAdmission` checks one dimension. Adapters must atomically reserve
**all** applicable project/global dimensions before dispatch, rollback failed
reservations and schedule projects fairly. The pure helper is not a distributed
limiter. Retry count 0 is the first attempt, 1/2 are retries. `run_calls` and
`run_tokens` include earlier reservations, excluding the new requested amount.
Diagnostics include bounded codes, counts and limits:

- Full ingress queue: reject before ACK with retry-after; bounded local buffering
  and gap diagnostics preserve ordinary Agent work.
- Full policy/worker concurrency: defer durable accepted work without loss.
- Full worker queue: keep candidates unresolved and record `queue_full`.
- Call/token/retry exhaustion or known exhausted account: defer reasoning; never
  guess high-impact/canonical decisions or declare successful worker results.

`normalizeUsageObservation` separates account availability, consumed tokens or
usage proxies and an independent USD monetary estimate in microunits. Unknown
values are null, never zero. Unknown account availability allows bounded local
admission; a provider quota response stops/retries according to policy. Known
exhaustion defers. Subscription access implies neither unlimited capacity nor a
measured zero cost. Error bodies never enter diagnostics.

Ordinary process crash has **RPO 0 for acknowledged events** through inbox/outbox
replay. Backlog recovery ≤300 s is a separate target. Primary-store disaster
recovery has **RPO ≤300 s and RTO ≤900 s**, measured from latest recoverable commit
and disaster declaration to verified writable service respectively. That explicit
disaster allowance cannot excuse ACK loss during ordinary restart. Backup/restore
and capacity Tickets must prove targets or report failure; do not lower them
after a failed drill. No reliability claim follows from this protocol alone.

Run `node --test test/observability-contract.test.mjs` and
`npm run check:boundaries` from `semantic-runtime/`.
