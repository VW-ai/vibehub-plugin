# Card corner signal contract proposal

Status: **proposal only — owner decision required**. Nothing in the production
Workbench, Ticket projection, routing, Skill behavior, or v0.8 file format is
changed by this artifact.

## Recommendation

Use one Human-facing phase axis—**Context stability and forward motion**:

- **DRAFT**: the Context or path still needs change. This includes an unblocked
  draft, a blocked Task, and a materially deviated Task.
- **READY**: the Task is stable and the next actor can act. The next actor may
  be an Agent or a person.
- **RUNNING**: the work loop is advancing. Trusted execution and independent
  closeout live in the same continuous phase.
- **DONE**: an independent successful Outcome accepts the current contract.

The upper-right corner is one bounded secondary slot, not another lifecycle.
Its priority is **DEVIATED > BLOCKED > actionable NEEDS YOU > VERIFYING >
WAITING > empty**. The same slot changes meaning only where the primary phase
makes that meaning honest. `NEEDS YOU` means stabilize Context on DRAFT, be the
next actor on READY, and answer a boundary reached mid-flow on RUNNING.

Live presence is a separate small affordance. It never consumes the slot and
never changes durable Ticket truth.

Raw Ticket status, next_action, Evidence, Outcome, archive, delivery, and
historical source remain exact and inspectable beneath this Human presentation.

## Exact derivation

The first matching row wins:

| Priority | Canonical / trusted fact | Primary | Corner slot |
| --- | --- | --- | --- |
| 1 | Successful Outcome / `DONE` | DONE | empty |
| 2 | Non-success Outcome / `REPLAN` | DRAFT | DEVIATED |
| 3 | Unresolved direct dependency / `WAIT` | DRAFT | BLOCKED |
| 4 | `maturity:draft` / `REFINE` | DRAFT | empty by default |
| 5 | `CLOSE_OUT` | RUNNING | VERIFYING |
| 6 | Trusted, unexpired execute/closeout runtime is active | RUNNING | runtime-derived or empty |
| 7 | Firm reachable work / `EXECUTE` | READY | empty |
| 8 | Firm reachable work / `NEEDS_HUMAN` | READY | NEEDS YOU |

The executable [`phase-model.mjs`](phase-model.mjs) and
[`fixtures.json`](fixtures.json) are the normative proposal. They cover stale
and untrusted presence, closeout with and without a live Agent, blocker clear,
Run end, failed closeout, reopening, long-lived history, and every accepted
primary/slot combination.

## What v0.8 can show today

The all-scope corpus at proposal time contains 64 `DONE|DONE`, 6
`READY|CLOSE_OUT`, 4 `BLOCKED|WAIT`, 3 `REFINE|REFINE`, 2 `READY|EXECUTE`, and
1 `READY|NEEDS_HUMAN`. There is no non-success Outcome in the corpus and the
production host exposes no trusted runtime/presence capability.

Therefore a no-schema implementation can honestly map:

- `DONE → DONE`
- `REPLAN → DRAFT + DEVIATED`
- `WAIT → DRAFT + BLOCKED`
- `REFINE → DRAFT`
- `EXECUTE → READY`
- `NEEDS_HUMAN → READY + NEEDS YOU`
- `CLOSE_OUT → RUNNING + VERIFYING`, but **not live**

It cannot honestly claim queued, executing, waiting-tool, Run end,
pre-Outcome failure, a live closeout Agent, or stale-TTL behavior.

## DRAFT + NEEDS YOU decision

Do not infer it from `authority: human`. Human authority can represent future
or terminal sign-off, and today BLOCKED/REFINE correctly project that boundary
as `UPCOMING`, not actionable. Two truthful paths remain:

1. Current fallback: model the input as its own Human-decision Ticket. That
   Ticket becomes `READY + NEEDS YOU`; its dependent remains `DRAFT + BLOCKED`.
2. Recommended future source: an explicit trusted planning runtime/current
   human-boundary projection with `ticketId`, `runId`, `operation:plan`,
   `state:waiting_human`, source, observation time, and expiry.

The same additive runtime capability enables `RUNNING + NEEDS YOU`. It must use
`operation: plan|execute|closeout` and
`state: queued|running|waiting_tool|waiting_human|completed|failed`, so active
planning cannot falsely turn DRAFT into RUNNING.

## Material deviation threshold

For v0.8, every independent non-success Outcome (`partial`, `failed`, or
`deviated`) is material and returns the card to `DRAFT + DEVIATED`. A transient
tool retry, temporary wait, resumable Run failure, or implementation-path
adjustment inside the current contract is runtime detail, not DEVIATED. A
finer policy requires explicit additive metadata; prose must never be guessed.

## Quiet visual budget

The review board reuses the approved compact card anatomy: ID, bounded outcome
copy, top accent, lower-left causal counts, lower-right primary phase, and one
upper-right signal. It spends color on only four families beyond neutrals:

- one action blue shared by READY and RUNNING (shape, copy, and trusted motion
  distinguish them);
- proof green for DONE;
- attention amber for NEEDS YOU;
- exception red for DEVIATED.

DRAFT and BLOCKED stay neutral and rely on dashed/locked geometry. Every fact
has icon plus text. Selection is a neutral outline. On narrow layouts, targets
are at least 44px. Reduced motion replaces the live pulse with a static ring.

Open [`index.html`](index.html) to review wide and narrow production-shaped
frames; `?viewport=narrow` opens the narrow frame directly. Cards are clickable
and keyboard reachable; focus updates the Inspector
with the exact derivation, explanation, action, raw v0.8 facts, and accessible
name. The causal-focus control demonstrates selected versus dimmed cards.

## Protected decision and implementation sequence

The smallest protected Human decision is the exact four-phase derivation,
corner taxonomy/priority, short action language, and visual budget above. After
that decision, keep downstream work split:

1. additive Human presentation projection over unchanged v0.8 fields;
2. optional trusted ephemeral runtime capability;
3. Graph/Overview/Inspector/accessibility implementation;
4. Skill routing that preserves executor versus independent closeout judgment;
5. compatibility, installed-host parity, exact-source, and browser regressions.

The graph-density proposal may reuse this hierarchy, but clusters, semantic
zoom, and card-copy compression must not add another badge or primary phase.
