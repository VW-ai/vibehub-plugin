# Phase 0 replay contracts

This is the first executable slice of PRD section 14 and Technical Design
section 29. It establishes an auditable experiment runner, not a completed
semantic-value benchmark. The original design drafts remain unchanged.

## Inputs

`--events` is a JSONL file. Each event has `schema_version: 1`, explicit
`tenant_id`, `project_id`, `event_id`, `type`, and a timestamp with timezone.
`source` requires `provider` and `ref`, with optional `session_id` and
`worktree_id`. `payload_ref` identifies recoverable source content;
`payload.text` supplies the text to evaluate. Optional `provenance` contains
repository, commit, and path. `impact` is `normal` (default) or `high`.

`acl` must specify `visibility: project` and a sensitivity of `PUBLIC`,
`INTERNAL`, `CONFIDENTIAL`, or `RESTRICTED`. This local experiment has no user
authentication or connector ACL resolver; explicit tenant/project scoping is
not an enterprise authorization system.

Supported event types cover agent messages, user intent, tools, file changes,
Git changes, lifecycle records, human decisions, and checkpoints. External
connectors are outside this slice. See `fixtures/synthetic/events.jsonl` for examples.
The normalizer copies only supported fields; embedded gold labels are discarded.

`--state` is an optional JSON array of acceptance/context candidates. Each has
`tenant_id`, `project_id`, `id`, `type` (`acceptance` or `context`), `text`,
`source_ref`, `acl`, and `available_at`. Supply the actual point-in-time content:
one identity may occur once per replay snapshot. Revision history and tombstones
are not implemented. Do not backdate a current artifact and use it as historical
input. Targets from another scope or the future never reach the judge.

`--labels` is an optional, separate evaluator-only JSON array:

```json
[
  {"event_id":"event-3","family":"acceptance_relevance","relevant":true,"target_ids":["acceptance-refresh"]}
]
```

Only supplied labels are scored. Labels must refer to events in this replay;
omitted labels mean unknown, not negative. Label contents never enter a judge
request. The original demo fixture is synthetic. Real trajectories need
deliberate selection, sanitization, point-in-time state, and independently
established labels.

`fixtures/peel/` is the first such selected corpus. Its event excerpts,
state snapshot, labels, sanitized source-provenance ledger, and curation ledger
are separate files. Automated
checks require 20 bounded chronological excerpts, one label per event and
family, point-in-time visibility for every relational target, positive and
negative examples in each family, and the absence of raw session identifiers,
local user paths, or credential-shaped content. The corpus is marked `real`
because it comes from observed Peel development; it is curated rather than a
raw trajectory export.

Every selected event and state candidate has a provenance entry with a stable
source identity, sanitized locator, and earliest authentic availability. Tests
bind state `available_at` to that ledger and reject events that predate their
source. The ledger remains evaluator-only and is never included in judge input.
Its locator contract is executable: Git locators bind commit/path/blob; local
record locators bind a semantic Ticket or Outcome ID to exact file bytes; and
private Codex turns resolve by hashing raw thread ID, turn ID, and lifecycle
phase from an ignored local index. The verifier also authenticates source time
from the Git commit, Outcome `closed_at`, or indexed Codex turn timestamp.
`verify-peel-provenance.mjs` implements all three paths.

## Policy and judge

`policies/phase0.json` is the default versioned graph. The Phase 0 executor
supports judge nodes and end nodes, validates a bounded acyclic graph, and
requires each of the four decision families to be declared once. `next` may be
a node ID or an action-to-node map covering `INGEST`, `IGNORE`, `DEFER`, and
`ESCALATE`. Additional node types from the design remain future work.

Each judge node supplies its question, confidence threshold, and timeout.
The default graph evaluates the four families independently; durability does
not gate acceptance or current-context relevance. Questions and thresholds
are experiment inputs, not learned or calibrated product defaults.

A judge implements `evaluate({event, stateRefs, question}, {signal})` and exposes
a serializable `descriptor`. Its bounded result contains:

```json
{
  "value": {"relevant":true,"target_ids":["acceptance-refresh"]},
  "confidence":0.92,
  "latency_ms":80,
  "provider":"example",
  "model":"example-v1",
  "reason_code":"acceptance_supported"
}
```

Targets must come from the supplied state. Positive relational decisions need
at least one target; non-relational/negative decisions have none. The core
validates results, respects deadlines, and sends an AbortSignal to adapters.
A blocking synchronous adapter cannot be preempted by a JavaScript timer;
future live adapters must honor cancellation and transport deadlines.

- `heuristic`: local lexical/type rules; uncalibrated fixed scores. Useful as
  a mechanical baseline and smoke test, not a substitute for semantic judging.
- `recorded`: a JSON object with `schema_version: 1` and `records`, each with
  `input_hash` and `result`. The hash covers the entire normalized event,
  visible state, and semantic question. Missing recordings defer the decision.
  Use audit `decisions[].input_hash` and `result` to construct a recording.

- `jev`: a live Vercel AI Gateway adapter using AI SDK 7's
  `experimental_evaluate` with `typesafe-ai/jev`. It sends minimized event and
  visible candidate text, evaluates relational targets as parallel boolean
  questions in one request, and maps returned probabilities into the shared
  judge result. It pins routing to `typesafe-ai`, honors the Policy Graph's
  AbortSignal, and caps relational requests at 32 targets. Zero Data Retention
  is opt-in because Vercel restricts it by plan. This adapter is selected
  explicitly with `--judge jev`; heuristic and recorded replay stay offline.

- `haiku`: a live Vercel AI Gateway adapter using AI SDK 7 structured output
  with `anthropic/claude-haiku-4.5`. It receives the same minimized state and
  ordered semantic questions as JEV, validates an exact probability vector,
  and maps it into the same bounded decision contract. Its self-reported
  probabilities are uncalibrated and are compared through actions and labels,
  not treated as numerically equivalent to JEV probabilities.

- `claude-cli-haiku`: a transport fallback pinned to
  `claude-haiku-4-5-20251001`. It invokes `claude -p` with the identical prompt
  and JSON schema while disabling tools, Skills, settings, and session
  persistence. The subprocess runs outside the repository. CLI latency and cost
  remain transport-specific observations and cannot be interpreted as Gateway
  provider performance.

- `typesafe-direct-jev`: the official `@typesafe-ai/sdk` transport using
  `jev-latest` and batched Noul questions over the same minimized state. SDK
  logging and automatic retry are disabled. Runtime pacing, checkpointing, and
  bounded 429/5xx retry remain outside semantic core, and resolved model version
  plus token usage are retained as bounded audit metadata.

Recorded inputs omit policy version/threshold/timeout so routing can be compared
without rerunning a model. Changing event content, candidate content, or question
invalidates the corresponding recording. A recording hash identifies the ledger.
The JEV adapter uses the documented Vercel evaluation API contract. Live
requests still require an explicit dataset selection and provider/data policy;
the synthetic smoke fixture is not evidence that a private trajectory is safe
to send or that JEV is calibrated for this workload.

The Peel live benchmarks send only the checked-in sanitized fixture. Their
versioned benchmark policy preserves the four Phase 0 questions and thresholds
but allows a longer transport timeout than the local smoke policy. The
JEV-versus-Haiku comparison reuses the accepted JEV audit, sends new requests
only to Haiku, and refuses mismatched dataset, state, label, semantic question,
confidence threshold, graph, or decision input hashes. It may use a longer
transport deadline for `claude -p`; deadline and full policy hashes remain in
the audit so CLI startup latency is not confused with model quality. Its
transport serializes requests, applies bounded Retry-After-aware
retry only when a transport exposes 429 or 5xx status, and checkpoints validated successes by
model behavior descriptor plus normalized input hash. Generated reports, caches,
and SQLite audits remain ignored local state.

The Gateway-versus-official-direct JEV comparator reuses two completed audits
and performs no model request. It requires identical tenant, project, dataset,
point-in-time state, labels, semantic policy, and all 80 normalized decision
input hashes. Its bounded ignored report includes action and quality changes,
decision disagreements, route-specific latency, direct retry/rate-limit/token
observations, requested and resolved model identifiers, and an explicit caveat
that adapter/API behavior is part of the measured route.

## State and failures

Confident positives become candidates. Confident negatives are ignored.
Low confidence defers, or requests escalation for high-impact events. Timeout,
missing recording, invalid targets, and malformed results always defer with a
bounded error category. Escalation is an audited request, not a running worker.

The SQLite adapter uses WAL and tenant/project/run-scoped keys. It writes each
event, its decisions, candidates, and relations in one transaction. Candidate
state cannot be promoted through this API. The candidate sensitivity is at
least that of every input visible to its decision.

Runs preserve policy snapshots/hashes, input/state/recording fingerprints,
source pointers, model metadata, results, actions, and timing. Event text stays
in the supplied source file; it is not copied into SQLite. Keep those sources
and state snapshots under the chosen retention policy for reproducibility.
Audit output contains source references and should be treated as private data.

A failed store write marks the run failed; completed event audits remain visible.
An interrupted process may leave a `running` record. Neither incomplete status
can be compared as a successful run. Rerun under a new run ID after resolving
the failure. Completed runs reject further writes through the store API.

## Evaluation and remaining gate

Reports show decision actions, candidate/error counts, observed adapter time,
and optional per-family classification/target precision and recall. Abstentions
are counted explicitly; they reduce positive recall and have separate coverage.
An undefined metric denominator yields `null`, never invented perfect accuracy.

Observed replay time is distinct from the provider-reported `latency_ms` in a
recorded result. Neither should be presented as a measured JEV latency.
Downstream task success and repeated-work reduction remain `null`, and
`productization_gate` remains `not_evaluated`.

Completing Phase 0 still requires the PRD's real trajectory corpus, a real
semantic judge, long-context/embedding/current-workflow baselines, and controlled
downstream evaluation. Fixed-trajectory replay alone cannot establish that an
Agent would make fewer tool calls or complete more tasks.

Implementation references: [Node SQLite](https://nodejs.org/api/sqlite.html)
and [Acorn parser](https://github.com/acornjs/acorn/tree/master/acorn).
