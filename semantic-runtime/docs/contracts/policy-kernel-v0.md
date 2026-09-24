# Bounded Policy execution kernel v0

The public `executePolicyRun`, `validatePolicyActionCommand`, and
`createInMemoryPolicyTransactionPort` implement the non-model subset of
[Policy artifacts](policy-artifacts-v0.md), version `POLICY_KERNEL_VERSION = 1`.
The existing Phase 0 evaluator is unchanged. This is a volatile conformance
kernel, not a hosted service, durable journal, Worker scheduler or sandbox.

```js
const transaction = createInMemoryPolicyTransactionPort({ graph });
const result = await executePolicyRun({
  artifact, handlers, transaction, event: normalizedEvent,
  snapshot: graph.snapshots.at(-1), // full immutable GraphRevision, not its address
  run_id: 'run-1', idempotency_key: 'logical-invocation-1',
  recorded_at: '2026-09-21T23:00:00.000Z',
  limits: { max_retrievals: 10, max_output_bytes: 100000 },
});
```

`artifact` is exactly the compiler's frozen schema-2 result. The kernel recompiles
and compares it, checks runtime compatibility, and requires every installed
`{ operation, execute }` descriptor to equal its pinned ID, version, signatures,
configuration schema and implementation hash. This is a trusted composition
attestation; a hash cannot prove arbitrary JavaScript has the promised behavior.
Any Judge or Worker node rejects the whole artifact before invocation, including
an unselected branch. Later Tickets own their execution protocols.

The event uses the accepted normalized-event contract and must match the
snapshot scope. Snapshot structural validation does not replace the trusted
adapter's full Working Graph history and current-authorization validation.
Inputs, snapshots, handler values and results are cloned and frozen. Unknown
fields, accessors, non-JSON values, cycles and oversized wire values fail closed.
Invalid configuration rejects before execution; runtime faults return bounded
results. Providers, credentials, storage handles and host APIs are never passed
to handlers.

## Handlers, ports and deterministic routing

`execute({ node, node_id, inputs, event, snapshot, signal, attempt, fence,
deadline_ms })` returns a value or Promise. Success is
`{ outputs, branch?, command?, usage? }`. An exclusive operation chooses one
declared branch; parallel and Action operations omit `branch`. Only Action
handlers return `command`, and its action must equal the node's declaration.
Guard failure is its explicitly declared deny branch, never an inferred approval.

Primitive ports are exact boolean, finite number or string. Opaque ports have
these executable forms; the compiler remains independent of their bodies:

| Port | Kernel value |
| --- | --- |
| `event_ref` | `{kind:'event_ref', observation_key, event_digest}` for the input event |
| `snapshot_ref` | Exact `graphRevisionAddress(snapshot)` |
| `signal_ref` | `{kind:'signal_ref', digest:'sha256:…'}` |
| `candidates_ref` | `{kind:'candidates_ref', refs:[exact semantic revisions]}` in this scope/generation |
| `error_ref` | `{kind:'error_ref', code, node_id}` with a fixed kernel code |

`job_ref` is unsupported. Default entry inputs are supplied for event/snapshot
ports; other entry types require explicit `inputs`. Candidate pins are bounded
references, not authorization to read their contents or deliver them to a host.

The scheduler launches a canonically ordered frontier concurrently, then
adjudicates results in the artifact's topological order. Routing, output charging,
retry admission and all-join arrivals use that order, not Promise completion
order. All-joins accept one arrival per named fork branch, merge disjoint input
ports, and run once. Exclusive convergence follows the compiler's `any` joins.
The first adjudicated error cancels peers and discards unadjudicated outputs.
This deliberately favors reproducibility over the fastest error notification;
an earlier ordered attempt may need to hit its bounded deadline first.

The trace records only adjudicated nodes and attempts, typed output digests and
branches or fixed failure codes. Its hash excludes wall-clock observations and
raw handler exceptions. The same pinned deterministic handlers, artifact, input
and budget outcomes give the same trace under reverse branch completion.
Deadline/cancellation outcomes themselves necessarily depend on the clock and
external cancellation input. Run and attempt fences prevent late completions
from routing, retrying, changing the returned trace or submitting another command.

## Budgets and failure edges

Artifact timeout/attempt/token/cost limits bound the run; invocation `limits` may
only tighten them. Additional limits are `max_node_visits` (at most artifact
`max_nodes`), `max_retrievals` (default 64) and `max_output_bytes` (default 1 MB).
All are finite integers. Every attempt reserves its full declared token and cost
proxy ceilings before invocation, even if it fails or is cancelled. Optional
`usage:{tokens,cost_microunits}` must fit those ceilings and cannot refund them.
Retrieval attempts and UTF-8 bytes of actual returned values are counted by the
kernel. Bytes include action payloads and explicit error outputs.

An explicit `{outputs, error:{code:'handler_error',retryable:true}}` may retry
within that node's attempt cap; its outputs must match `error_outputs`. Thrown
exceptions, malformed values and timeouts do not request a retry. Retrying never
resets the original run deadline or budget. Node timeouts are per attempt as
defined by the artifact; the absolute run deadline remains the outer ceiling.

Nonterminal faults take their compiled `on_error` DEFER/ESCALATE edge. The kernel
validates error-port values, retaining matching inputs or generating `error_ref`
for intrinsic failures. Unavailable required error ports produce an intrinsic
failed/DEFER result. The error terminal is a fixed system-generated command,
recorded as `system_terminal` attempt 0; no handler/retry runs beyond an exhausted
budget. Whole-run deadline or external cancellation before action commit returns
intrinsic deferred/DEFER without a receipt. Actions have no schema-2 error edge;
their handler or CAS failure therefore returns intrinsic failed/deferred results.

Async waits are bounded and cancellable. A synchronously blocking trusted handler
cannot be preempted in the same JavaScript isolate; its result is still rejected
if it returns past its fixed attempt deadline. CPU isolation, provider meters and
side effects secretly captured by an untrusted closure require another boundary.

## Typed atomic commands and receipt uncertainty

INGEST carries `{action:'INGEST', assertion}` with a structurally valid candidate
assertion. IGNORE, DEFER and ESCALATE carry `{action,reason_code}`. INJECT carries
`{action:'INJECT',recommendation:{mode:'silent'|'soft',refs}}`; it recommends
context and cannot perform hard injection or canonical writes. Graph admission,
source access, execution identity and semantic base checks remain in the graph
transaction. These intents confer no canonical truth or acceptance authority.

Every command pins scope/generation, logical idempotency key, run/node, exact
policy content/executable hashes, normalized event, expected GraphRevision,
stable `recorded_at` and typed payload. `payload_digest` binds the complete
command body. Preserve all those values across an identical retry. The port
checks a prior receipt before current CAS, so retrying an applied INGEST against
its now-historical base returns the original receipt. Changed body under the
same key rejects, including changed policy, event, run, timestamp or graph base.

`transaction.commit(command,{signal,isCurrent})` owns one linearization point:
Graph revisions/current projection, command, audit, receipt and outbox publish
together. It must recheck cancellation and the run fence at that point, after
any asynchronous work. Confirmed replies are `committed` with a typed receipt,
`graph_revision_mismatch`, `idempotency_conflict`, `cancelled` before publication,
or `not_committed` for a proven pre-publication failure. A CAS mismatch does not
silently rebase the command or claim a semantic Conflict was stored.

If acknowledgement is lost, malformed, rejected, or interrupted after dispatch,
the kernel returns `status:'indeterminate', reason_code:'commit_unconfirmed'`,
the requested action and exact `command_ref`. Cancellation is not rollback.
Reconcile that identity through `lookup(command_ref)` or retry the identical
command; never invent a fresh key. A `not_found` lookup is a read-time observation,
not proof that an arbitrary durable adapter has no in-flight commit.

The in-memory reference port serializes commits, returns immutable `inspect()`
state and exact `lookup()` receipts, and supports `beforeCommit` fault injection.
An interrupted precommit hook releases its queue and can never publish later.
INGEST updates the pure Working Graph; IGNORE changes only command/audit/receipt.
INJECT, DEFER and ESCALATE additionally append typed outbox intents referencing
the command digest, with no external delivery. Audit envelopes use the existing
strict allowlist, aliased correlation IDs and exact policy digest; raw events,
payloads and generation details remain in authorized command records.

`node --test test/decisions/policy-kernel.test.mjs test/decisions/policy-kernel-integration.test.mjs`
covers all typed handlers/actions, reverse completion/failure/retry order,
budgets, deadlines, guards, joins, late results, atomic faults, CAS, exact retries,
and post-commit acknowledgement loss. All inputs are synthetic; no model,
network, real persistence, host delivery, crash resume or provider claim occurs.
