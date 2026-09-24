# Durable Project activation

`ProjectActivation` is the authoritative local switch and an atomic admission
primitive. It composes the accepted DomainStore/auth/Git registry. It does not
install a Collector, start a model job or inject a host message by itself.

```js
import { ProjectActivation } from '@vibehub/semantic-runtime';
const activation = new ProjectActivation({ store, authority });
const current = activation.get(appContext);
const enabled = activation.setEnabled(appContext, {
  enabled: true, expectedVersion: current.version,
});
const receipt = activation.withAdmission(hostContext, {
  epoch: enabled.state.epoch, stage: 'capture', execution,
}, tx => {
  // Store a sanitized event and its durable intent in the same transaction.
  tx.appendSource('events', eventId, 'captured-event', event);
  return { event_id: eventId };
});
```

The process owner registers `project-activation`, `git-enrollment` and the
consumer's domain namespaces in the **same** DomainStore. The callback is trusted
service code; never accept an executable callback or raw store operation from a
plugin/model/HTTP client. There is no HTTP endpoint or UI in this module.

## Authority and current state

`get(context)` returns `{ version, state }`; absent state is disabled at epoch 0
with null version and no fabricated observation interval. Reads require
`activation:read` and `store:read`. `setEnabled(context, { enabled,
expectedVersion })` requires `activation:write`, store read/write and a human or
App-service principal. Host adapters cannot toggle even if incorrectly given
that action. Enable additionally requires `project:inspect` and at least one
active enrolled checkout/worktree. Disable remains available without active Git
paths or Git-inspection permission. No operation performs a Git subprocess.

All scope comes from a current opaque LocalCredentialAuthority context with the
local API audience. Expiry/revocation is checked at entry and again within/before
committing the store transaction. Local model API keys are not these credentials.
Plugin installation, source text and a model's inference never change the switch.

`setEnabled` returns `{ version, state, changed }`. Explicit expected-version CAS
applies even to a same-state no-op, preventing a stale cached command from winning.
An actual change increments the safe-integer epoch and row version together;
unchanged commands append nothing. Exhaustion/malformed state fails closed.
A lost response is reconciled by `get`; callers do not blindly retry with a new
expected version. No per-request command ledger is required.

Each transition has an immutable source ID `transition-<epoch>` in the activation
namespace. It includes actor, previous epoch/ref and the new state. Disabling
records `disabled_since`; re-enabling records a `last_gap` with both transition
refs/times and `backfill: none`. Source history remains available through
`store.getSource`, so later gaps do not erase earlier transitions. Timestamps are
display/audit metadata: epoch and CAS provide ordering even if the clock changes.
No transition implies the App observed all work during an outage.

## Atomic admission and its limits

`withAdmission(context, { epoch, stage, execution? }, callback)` supports `capture`,
`dispatch`, `result` and `delivery`. It requires `activation:admit`,
`project:inspect`, store read/write and a current enrolled Project. It opens one
synchronous SQLite transaction, checks the current state and exact captured
epoch, then calls the trusted callback with that transaction. An optional
execution tuple must contain exactly `repository_id`, `checkout_id` and
`worktree_id` matching active current enrollment in that same transaction.
Consumers that require execution provenance must supply it; Project-level jobs
need not invent a worktree. Newly enrolled worktrees inherit the Project switch.

Disabled/stale epochs return `{ admitted: false, reason, epoch }` without calling
the callback. Successful commits return `{ admitted: true, epoch, value }`.
Invalid input/membership/auth/store failures throw bounded errors without payload
or database diagnostic text. Async/thenable callbacks, stale handles, callback
exceptions and revoked/expired contexts roll back all record/source/outbox
writes. Consumers must not mutate activation/enrollment inside a callback; those
conditions are checked again before commit.

For two real writers, SQLite serializes admission and disable. An admitted
mutation committed first stays historical; a commit attempted after disable is
fenced, even after re-enable. A pre-disable delivery intent may remain stored,
but its actual sender must recheck the current epoch before sending. Epoch is
freshness metadata, not authentication, source ACL approval, semantic acceptance
or a replacement for the independent Worker attempt fencing token.

Do not run a model, network, shell or host call inside the transaction. An
external call already started cannot be recalled by this switch. Consumers must
recheck at their actual dispatch/injection boundary, propagate cancellation,
and gate late returned results before any semantic mutation. There is no global
atomicity between SQLite and an external host; a delivery intent is not a host
receipt. The later ingress/runner/delivery integrations must test these real
boundaries themselves. Native coding does not depend on this module succeeding.

## Cancellation coordinator protocol

Disable atomically enqueues `cancel-<disabled epoch>` alongside the transition,
with `before_epoch`, its transition ref and default `leave_cancelled` recovery.
One trusted App cancellation coordinator owns this namespace's outbox. Individual
Collectors/Workers do not acknowledge the shared notice independently. Store
handles are trusted internal capabilities; the App's public handlers must not
expose generic outbox acknowledgement to plugin callers.

The coordinator reads persisted pending local queue envelopes, selects bounded
batches whose activation epoch precedes `before_epoch`, and records progress
with their updates in one DomainStore transaction. Envelopes carry activation
metadata beside the exact immutable Worker Job/ref/digest; Worker wire v1 is not
changed. Use existing runtime `cancel` for eligible nonterminal Jobs and
`expire` when their deadline has passed. Preserve terminal success/history and
existing Worker attempt fences. Persist cursor/idempotent progress so a crash
resumes remaining work. Acknowledge the notice in the transaction completing
those relevant local updates; never acknowledge merely on fetching it.

The tests implement a **fixture** coordinator using bounded persisted synthetic
queues and existing Worker transitions. Restart/duplicate processing retains
progress and cannot reopen a terminal Job. ACK means local processing/handoff;
it is not evidence an external process stopped. A production coordinator loop
and real queues belong to the runner/ingress/delivery modules.

## Explicit recovery protocol

Re-enable defaults to leaving old work cancelled/fenced. Every old envelope keeps
its original epoch; never relabel it as new. For deliberate recovery, an
App-authorized request must name a selected list of at most 64 previously
persisted pending-work references. Under the new enabled epoch, resolve every
reference from the local queue, check it was eligible pre-disable work, rerun
current source/access/base validation and construct **new** Job/request identities
linked to the originals. Deduplicate that recovery request; reject missing,
already completed, invalid, duplicated or newly inaccessible references.

The synthetic composition tests exercise this protocol; it is not a production
recovery scheduler or a generic callback API for remote clients. Cancelled Worker
Jobs never reopen. The analogous Agent Work Request lifecycle is still planned;
this module claims no shipped request implementation. Neither a reference list
nor enabling the Project authorizes scanning/importing private sessions from a
disabled interval or App outage. There is no automatic backfill.

## Verification and integration boundary

`test/project/project-activation.test.mjs` uses temporary Git/SQLite, opaque grants and
synthetic queue state. It checks all four stages, current enrollment, no-op/CAS,
restart, revoked/expired authority, rollback, delayed results/delivery, explicit
gaps and cancellation/recovery composition. No model calls, private traces,
installation or background process are required.

This version stores one small schema-v1 state, immutable transition sources and
outbox notices in the accepted database. DomainStore limits apply; there is no
new database or framework. Future incompatible state changes need an explicit
versioned migration. Actual source authorization, model routing, capture ACKs,
provider cancellation and host delivery remain responsibilities of their
consumers, which must call this gate instead of relying on a cached UI switch.
