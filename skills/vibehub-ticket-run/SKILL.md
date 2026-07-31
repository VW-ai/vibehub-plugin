---
name: vibehub-ticket-run
description: Execute one ready VibeHub Ticket from its exact Git-native context package, maintain its bounded Run lease, and append acceptance-linked evidence for independent closeout. Use when an Agent should select or resume executable Ticket work without acting as a scheduler or certifying its own completion.
---

# VibeHub Ticket Run

Execute one Ticket as a fresh Agent. The Ticket is the executable context
package; conversation history is optional context, never hidden authority.

## Prerequisites

1. Read `../_stdlib/operations.md` and `../_stdlib/reporting.md`.
2. Read the exact operation entries in
   `../contracts/operation-contracts.json` before constructing any input.
3. Resolve the repository, worktree, actor, task, and delegated boundaries.
4. Require a named branch and an exact current source. A detached checkout,
   stale source, missing context, or unresolved protected boundary is not
   executable.

## Workflow

1. Call `ticket.frontier.read`. Select only a Ticket reported as ready; do not
   invent priority, poll continuously, or coordinate a queue.

   ```text
   node ../scripts/vh-ticket.mjs frontier.read --repo [root] --actor [actor] --request [id] --input [empty.json]
   ```

2. Refresh one coherent view with `ticket.graph.snapshot`, then inspect the
   exact Ticket with `ticket.subject.inspect` and load every page of
   `ticket.trace.list`. Verify its current revision, direct prerequisites,
   acceptance IDs, existing evidence, protected boundaries, and active Run
   facts. Unavailable traces are unknown, not empty.
3. Call `ticket.context.compile` against that exact source and Ticket revision.
   Treat its returned binding ID and digest as the only execution packet. Read
   the compiled files and boundaries before editing; do not supplement a
   missing required reference from remembered conversation. Refresh to the
   source returned after compilation; the pre-compilation source is stale for
   later Git-native writes.
4. Claim the exact binding with `ticket.run.claim` against that refreshed
   source. Preserve the returned
   `runId`, `generation`, and `leaseToken` unchanged. Another current claim,
   stale binding, changed compiled context—including ignored files—or failed
   envelope means no work begins. If the one-time lease token is lost, do not
   guess or recover it from receipts; stop using that Run and allow its lease
   to expire.
5. Execute autonomously inside the Ticket's delegated product, technical,
   permission, and risk boundaries. Investigate objectively adjudicable
   engineering choices without escalating them merely because they are hard.
   Heartbeat with `ticket.run.heartbeat` before the lease can expire and at
   meaningful long-running boundaries; do not create a daemon or background
   scheduler.
6. Test the implemented behavior in proportion to risk. For every current
   acceptance criterion, append bounded proof with `ticket.evidence.append`
   against the exact Run lease. Cite repository paths or commits, include a
   digest when available, and distinguish observation from proof. Repository
   evidence paths must be ordinary symlink-free worktree files, never `.git`
   administration data. An operation envelope with `ok: true` proves
   persistence, not that acceptance passed. Carry the refreshed source after
   each append; never reuse an older source for the next evidence record.
7. If work exposes a genuine product/principle choice, permission boundary,
   material risk, or deviation from an accepted design, stop that path and
   append the exact evidence. Release and hand the Run to independent closeout
   before changing the graph, so the deviation remains attributable to its
   exact execution subject. After closeout, use `$vibehub-ticket-plan` in a
   fresh planning pass to represent newly discovered or blocking work and
   `$vibehub-ticket-review` when an exact human Decision is required. Do not
   encode the choice in prose, self-authorize it, or edit Ticket documents by
   hand.
8. Release or hand off the lease with `ticket.run.release`. Use
   `lease_released` for normal completion, an intentional handoff, or a blocked
   stop; use `stale_binding` when the execution binding moved, `superseded`
   when replacement work took ownership, and `operator_cancelled` for an
   explicit cancellation. Put case-specific detail in the report or evidence,
   not a new release value. Release after evidence is recorded or as soon as
   the Run becomes stale or blocked. Never call
   `ticket.closeout.append`; the executor cannot certify its own completion.
9. Report through the five-section protocol. Keep healthy mechanics brief.
   Expand any stale source, conflict, deviation, failed evidence write, or
   protected decision that is waiting.

## Guardrails

- Never execute a blocked, active, stale, or unknown Ticket as ready.
- Never reuse a lease token across a new generation or source.
- Never claim success from code changes, tests, a release, or evidence alone.
- Never add dogfood gates, generic workflow stages, schedulers, or daemons.
- Never mutate Ticket YAML directly; use the public Ticket operations and
  Ticket Skills.
