# Proposal: bulk absorption

Branch: `claude/peel-knowledge-ingestion-a85999` · 2026-08-29

## The problem, reproduced

The Peel project (`~/Peel`) cold-started VibeHub on 2026-08-25 from two
hand-authored source files: a 1369-line PRD and a 672-line self-contained demo
HTML. The result, still checked in:

| Signal | Observed |
| --- | --- |
| Room tree | one room, `.vibehub/rooms/product/`, no sub-rooms |
| Context documents | 32, all flat in that one room |
| First pass yield | ~5 documents; reached 32 only after the user asked "did you lose anything from the PRD?" |
| Rework tickets | `rebuild-overview-demo-fidelity`, `rebuild-chat-reading-surface`, `reset-shell-material-hierarchy` |

`ticket-rebuild-overview-demo-fidelity` states the failure in its own words:
the delivered Overview "was previously accepted without a sufficiently
demanding Demo-to-production Overview comparison."

`decision-demo-authoritative-v01-ui-direction.yaml` — the decision that the
preserved demo HTML is the visual authority — has `captured_at`
`2026-08-26T08:12:00Z`, i.e. it was written by hand *after* the rework
started. The system did not derive it.

## Root causes

**1. Nothing in the system defines how a large document becomes Context.**

`vibehub-distill` builds the room tree and stamps alignment. Its only
statement about extraction is step 5: "Distilled output follows the trust and
placement rules in `../vibehub-ingest/references/knowledge-governance.json`."
That is a placement rule, not a process. There is no segmentation, no
coverage obligation, and no re-read. A model that stops after five documents
has violated nothing.

Peel's own `contract-product-context-coverage.yaml` — written by the agent to
compensate — is the fossil of this missing mechanism.

**2. The room tree is derived from file territory, not from content.**

`room.schema.json` defines a room by `anchors`, which are path prefixes, and
`vh.mjs:701` rejects two rooms that claim overlapping territory. At Peel's
cold start the entire knowledge surface was one directory,
`docs/product/source/`. A tree with more than one room would have required
disjoint path prefixes that did not exist.

`vibehub-distill/SKILL.md` step 3 then adds an explicit bias in the same
direction: "A small honest tree beats an exhaustive one."

(For comparison, this repository's own `.vibehub/rooms/` holds five rooms.
It has real code territory to anchor to. Peel did not.)

**3. Nobody is required to prove nothing was dropped.**

Coverage is not represented anywhere. The only detector was the user reading
the output and asking.

## Scope

This proposal fixes cause 1 and 3 directly, and relieves cause 2 by letting
the tree be proposed from surveyed content rather than from directory shape.

Explicitly **not** in scope:

- Semantic (non-path) room anchors.
- An artifact-authority Context type that forces a ticket to diff against a
  design source.
- Ticket-splitting pressure and visual/human-authority acceptance criteria.
  Peel's `ticket-deliver-v01-spatial-loop` carries ten acceptance criteria
  spanning the entire v0.1 product, none of them about visual fidelity. That
  is a real defect and it is the next proposal, not this one.

## Design

### No new user-facing skill

Bulk absorption is not a separate capability from ingest. It is what ingest
does when the input is large. Users must never be asked to judge whether
their material is "big enough" for a different skill; that judgment is
internal.

`vibehub-ingest` keeps its current description and its current small-input
path unchanged. It gains one branch: when the input is one or more sizable
documents rather than a stated claim, it follows
`references/bulk-absorption.md`. `SKILL.md` grows by a branch condition and a
pointer, not by a second workflow.

### The five passes

**Pass 1 — Segment (deterministic, script).**

`vh.mjs source segment --repo <root> --path <file>` splits each source file
into stably identified segments:

- Markdown: by heading hierarchy. Segment id `path#heading-slug`.
- Everything else (HTML, code, plain text): fixed line windows, default 60
  lines, boundaries snapped to the nearest blank line. Segment id
  `path#L120-179`.

Crude, but deterministic — and for a demo HTML with no semantic headings the
line window is more reliable than any structural guess. Determinism is the
requirement: coverage can only be recomputed if segmentation is reproducible.

**Pass 2 — Survey (read-only).**

Read every segment of every source. Produce a topic list: for each topic, a
name, one sentence, and the segment ids it appears in. Write nothing.

This is the pass that failed at Peel. It is read-complete by construction:
the segment list is finite and enumerable, so "did you read all of it" is a
checkable question rather than a matter of diligence.

**Pass 3 — Propose the tree (human gate).**

Cluster topics into a room tree and delegate the write to `$vibehub-distill`,
which owns room shape and alignment stamps. The rooms are empty shells at
this point — no Context has been written.

Then present the tree through `$vibehub-review`'s local graph UI, which
already projects rooms, nesting, drift state, and per-room Context counts.
The UI is read-only and projects from `.vibehub/` on every refresh, so the
tree must be written before it can be shown; that is correct rather than a
workaround. With zero Contexts in the rooms, adjusting the tree is `git mv`
and a boundary edit — near-zero cost, and Git is the rollback boundary.

This is the **only** human gate in the pipeline. Tree shape is the expensive,
hard-to-reverse decision, and it is the one Peel got wrong.

`vibehub-distill` step 3 loses "A small honest tree beats an exhaustive one"
and gains splitting pressure instead. A room should split when its boundary
needs "and" to join two unrelated concerns, or when its topics serve visibly
different readers (product / engineering / design).

**Pass 4 — Extract.**

Walk every segment. Emit zero or more atomic Context documents per segment,
each citing its segment id in `source.ref` or `evidence[].ref`. A segment
that yields zero Contexts requires a stated reason, recorded as a coverage
exception on the room that owns that anchor.

**Pass 5 — Settle.**

`vh.mjs context coverage --repo <root>` recomputes: for every segment of
every anchored source file, is it cited by at least one Context or covered by
an exception? Absorption is not complete while the uncovered count is
non-zero. The report is recomputable at any time and can gate CI.

### Parallelism

Pass 2 and Pass 4 are parallelizable where the harness supports subagents.

Pass 4 shards **by room, not by segment**. A claim that appears in three
chapters would otherwise be extracted three times by three blind workers,
producing duplicate Contexts with inconsistent ids. Pass 3 has already
assigned each segment to a room, so a per-room worker can guarantee
de-duplication and relations within its own room; cross-room duplicates are
reconciled by the orchestrator on merge. Workers write to disjoint room
directories, so `context put` calls do not contend.

A subagent's completion report is not evidence. Pass 5 is computed, not
reported — a worker that skipped segments shows up as uncovered segments.
Coverage is therefore a precondition for parallelism, not an addition to it.

Skills must stay portable across harnesses. The pipeline is written
conditionally: shard in parallel where subagents exist, otherwise execute the
identical steps sequentially. Same output, different wall clock.

## Skill topology

| Skill | Change |
| --- | --- |
| `vibehub-ingest` | Sole user-facing knowledge write entry. Gains a bulk branch pointing at `references/bulk-absorption.md`; owns orchestration and coverage. |
| `vibehub-distill` | Narrowed to room shape and alignment stamps, and marked internal — invoked by ingest, ticket-plan, and migrate, never called directly by a user. |
| `vibehub-review` | Generalized from `vibehub-ticket-review`; owns both the ticket graph and the room tree presentation surfaces. |
| `vibehub-ticket-plan` | Its `cold_start:true` route continues to reach tree-building; the drift/align step stays inline. |
| `vibehub-migrate` | Its "a missing Room tree is built with distill first" step is unchanged. |

Skill count is unchanged at 12 — `vibehub-ticket-review` is renamed, not
added. The user-facing knowledge write surface goes from two entries to one.

### Why distill survives

An earlier draft of this proposal deleted `vibehub-distill` and split its two
jobs between ingest and ticket-plan. An impact scan reversed that:

- Historical records — `.vibehub/evidence/*`, `.vibehub/outcomes/*`, closed
  tickets, `META/legacy-*` — reference it and must not be rewritten.
- Still-valid knowledge references it: `.vibehub/rooms/knowledge/room.yaml`,
  `decision-ambient-two-mode-distill.yaml`, `decision-stale-origin-layers.yaml`,
  and the `META/03-02-cold-start-distillation/` room.

Deleting the skill would have forced a supersede cascade through active
Context to save one file. Narrowing it costs a description edit and keeps
every recorded decision true. Room shape and alignment is a real, reusable,
independently ownable job; it simply is not a job a user invokes by name.

## Mechanical changes

**Schema.** `context.schema.json` needs no change: `source.ref` and
`evidence[].ref` are free text, so segment-level references
(`docs/…/prd.md#4-2-fork-lifecycle`) are already legal. Only
`room.schema.json` changes, gaining an optional
`coverage_exceptions: [{segment, reason}]` — required because it declares
`additionalProperties: false`. Exceptions attach to the room owning the
anchor. No new document kind, no new store.

**Scripts.** `vh.mjs` gains:

- `source segment --repo <root> --path <file>`
- `context coverage --repo <root> [--room <path>]`
- `skills validate --repo <root>`

**Skill graph contract.** `vibehub-core/contracts/skill-graph.json` declares
skill-to-skill invocation edges and the events each skill owns; `skills
validate` checks that every `$vibehub-*` reference resolves, that no skill is
orphaned, and that the graph is acyclic. This turns "check the blast radius
before changing a skill" from discipline into a runnable check — the same
discipline that reversed the distill decision above.

All three additions are deterministic validation in a bundled dependency-free
script, inside `../vibehub-setup/references/architecture-boundary.md`.

## Verification

The proposal is proved by re-running Peel's cold start on the same two source
files and comparing against the checked-in single-room result: a tree with
more than one room, separating product intent from UX/interaction evidence,
and a coverage report reaching zero uncovered segments without the user
having to ask.
