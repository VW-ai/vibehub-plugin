# Absorbing whole documents into Context

Owner: `vibehub-ingest`. This reference is the process `$vibehub-ingest`
follows when the material handed over is one or more whole documents rather
than a stated claim. It is not a separate Skill and no user selects it.

Placement and trust are unchanged: every Context written here still obeys
`knowledge-governance.json`, and everything stays inside
`../../vibehub-setup/references/architecture-boundary.md` — no new store, no
manifest, no progress file. Segments, Rooms, Context, and Git are the whole
state.

## Why this exists

A document does not become Context by being read attentively. Left to
judgment, absorption stops when the reader feels finished, and feeling
finished is uncorrelated with having extracted the material. A 1369-line
product document once yielded five Context entries on its first pass and
thirty-two only after the human asked what had been lost; nothing in the
process had been violated, because the process did not exist.

The five passes below replace diligence with a countable obligation. The
source is cut into a finite, enumerable list of segments; every segment must
end in either a Context that cites it or a written reason it yielded none; and
the remainder is recomputed by a script rather than reported by whoever did
the work. **Stopping while segments remain uncovered is a violation of this
process, not a judgment call.**

## Pass 1 — Segment

For each source file:

```text
node ../../vibehub-core/scripts/vh.mjs source segment --repo <root> --path <file>
```

The script owns this pass entirely; there is no judgment in it. Markdown is
cut by heading hierarchy into `path#heading-slug` ids (content before the
first heading is `path#_preamble`); every other file type — HTML, code, plain
text — is cut into line windows of at most 60 lines snapped to a nearby blank
line, giving `path#L<start>-<end>`. Segments cover every line of the file
with no gap and no overlap. A binary file is refused outright by `source
segment`, and appears in Pass 5's coverage report marked `skipped` rather than
being silently dropped.

Determinism is the point: coverage in Pass 5 can only be recomputed because
the same file always cuts the same way. Keep each source's segment list for
the passes that follow.

## Pass 2 — Survey (writes nothing)

Read **every segment of every source** before anything is written. Produce a
topic list, one entry per topic:

- a short name,
- one sentence saying what the topic claims,
- the segment ids the topic appears in.

Nothing is written to `.vibehub/` in this pass — no Room, no Context, no note
file. The output is the topic list, held for Pass 3.

This pass exists to convert a question of diligence into a checkable one. The
segment list from Pass 1 is finite and enumerable, so "did you read all of it"
has an answer: every segment id appears in the survey's coverage or the survey
is incomplete. A topic list assembled from a skim will collapse in Pass 5,
where the uncovered count is computed from the same segment ids.

## Pass 3 — Propose the tree (the only human gate)

1. Cluster the surveyed topics into a Room tree. Assign every segment to
   exactly one Room — that assignment is what makes Pass 4 shardable and it is
   the reason this pass precedes extraction. Write the assignment into the
   Rooms as anchors: an anchor is either a path prefix or a segment id from
   Pass 1 (`docs/prd.md#4-fork-flow`, `demo.html#L118-177`), so sibling Rooms
   can each own their own slices of one large file. Two Rooms where neither
   contains the other must not anchor the same segment; that is what the
   overlapping-territory check enforces. When the material is a handful of
   files and the tree follows content, segment anchors are the normal case —
   anchoring every Room at the file and leaving the sub-Rooms with
   `anchors: []` collapses Pass 5's per-Room settlement onto the root.
2. Delegate the writing of the Rooms to `$vibehub-distill`, which owns Room
   shape, boundaries, anchors, and alignment stamps. It writes each one with
   the Room write operation — not by hand-editing a `room.yaml` — so every
   Room is validated and checked against the territory the existing Rooms
   already claim before it lands:

   ```text
   node ../../vibehub-core/scripts/vh.mjs room put --repo <root> --room <path> --input <room.json>
   ```

   The Rooms are empty shells: no Context has been written yet.
3. Present the written tree through `$vibehub-review`'s Room tree surface:

   ```text
   node ../../vibehub-core/scripts/vh-ui.mjs --repo <root> --rooms
   ```

   Where no browser is available, `$vibehub-review` presents the identical
   tree in the conversation from `room tree`. A Room showing `0 Context` is
   the expected state here, not an error. The surface is read-only and
   projects from `.vibehub/`, so the tree must be written before it can be
   shown; that is why distill writes first.
4. **Stop.** Wait for explicit human confirmation of the tree. Do not write a
   single Context before it. If the human asks for a different shape, revise
   and present again.

This is the only human gate in the pipeline. Tree shape is the expensive,
hard-to-reverse decision, and it is the one most often got wrong. It is cheap
to fix *here*: with zero Contexts inside them, moving or renaming a Room is
`git mv` plus a boundary edit, and Git is the rollback boundary. After Pass 4
the same change drags every Context in the Room behind it.

## Pass 4 — Extract

Walk **every** segment, in segment order, Room by Room. For each segment emit
zero or more atomic Context documents, one claim each, through the normal
ingest write:

```text
node ../../vibehub-core/scripts/vh.mjs context put --repo <root> --room <path> --input <context.json>
```

Two obligations make the walk auditable:

- **Every emitted Context cites its segment id** — the exact
  `path#heading-slug` or `path#L<start>-<end>` from Pass 1 — in `source.ref`
  or in an `evidence[].ref`. A bare file path counts as covering the whole
  file and defeats the point; cite the segment.
- **Every segment that yields zero Contexts carries a stated reason.** Record
  it as an entry in the `coverage_exceptions` array of the Room that owns the
  anchor covering that segment:

  ```json
  { "segment": "docs/product/prd.md#8-appendix-changelog",
    "reason": "Release changelog; no durable claim." }
  ```

  Add it by putting the Room again with the entry included, the same way the
  Room was created — `room put` replaces the whole document and writes exactly
  what it is given, so read the current `room.yaml` first and carry every
  existing field through, **`alignment` included**. `room put` never stamps an
  alignment of its own, on purpose: what a stamp says stays a property of what
  the caller wrote. So a re-put that omits `alignment` silently drops the
  Room's stamp and the Room reports `UNKNOWN` / never aligned in `room drift`,
  with no error at the write. Carry the block through verbatim; do not
  re-run `room align` to repair it, which would restamp against the current
  HEAD and claim an alignment that was never checked.

  ```text
  node ../../vibehub-core/scripts/vh.mjs room put --repo <root> --room <path> --input <room.json>
  ```

  Exceptions are read repository-wide, exactly as citations are: the entry
  settles that segment's count wherever the segment is counted, so it is
  declared once, in the Room that owns the anchor, and never copied into
  another Room that anchors a different part of the same file.

  "Nothing worth keeping" without a reason is not an exception, it is a skip.
  An exception is a claim the writer is accountable for, which is why it is
  checked in rather than held in the head of whoever ran the pass.

Placement follows the governance rule as always: lowest owning Room, lowest
common ancestor for a claim spanning several, and never dropped somewhere it
does not belong.

## Pass 5 — Settle

```text
node ../../vibehub-core/scripts/vh.mjs context coverage --repo <root>
```

The command recomputes, for every segment of every anchored source file,
whether it is cited by at least one Context or exempted by a
`coverage_exceptions` entry, and reports `uncovered_total` with the uncovered
segment ids per Room. Add `--room <room-path>` to settle one Room at a time.

**Absorption is not complete while `uncovered_total` is non-zero.** A non-zero
total is a work list, not a score: return to Pass 4 for those exact segment
ids, and either extract them or record an exception with a reason. Report the
result only from the command's own output.

Nothing is cached. The report is recomputable at any time, on any checkout, by
anyone — including CI.

## Running the passes in parallel

Passes 2 and 4 may be sharded across subagents where the harness provides
them. **Subagents are an optimization and never a requirement.** Where they
are unavailable, execute the identical steps sequentially in the same order —
same output, different wall clock. Never make the pipeline's correctness
depend on their presence.

**Pass 4 shards by Room, never by segment.** A claim that appears in three
chapters, handed to three blind per-segment workers, is extracted three times
into duplicate Contexts with inconsistent ids and no relations between them.
Pass 3 has already assigned every segment to a Room, so a per-Room worker sees
all the segments for its own subject and can guarantee de-duplication and
relations inside its Room. The orchestrator reconciles cross-Room duplicates
when the shards merge. Workers write to disjoint Room directories, so their
`context put` calls do not contend.

Pass 2 may shard by source file or by segment range, since it writes nothing;
the orchestrator merges the topic lists and reconciles topics that appear in
more than one shard before Pass 3.

Two rules make sharding safe:

- **A subagent's completion report is not evidence.** "All segments
  extracted" is a claim about a process the orchestrator did not witness.
- **Pass 5 is computed, not reported.** A worker that skipped segments shows
  up as uncovered segment ids under its own Room, whatever its report said.

Coverage is therefore a precondition for parallelism rather than an addition
to it. Do not shard until Pass 3's Room assignment exists, and do not accept a
shard's result on its word.

## Guardrails

- Never write a Context before the human has confirmed the tree.
- Never declare absorption complete from memory, a plan, or a subagent's
  report. Only `context coverage` output ends the run.
- Never invent a second store, manifest, progress file, or hidden state to
  track which segments are done; the citations and `coverage_exceptions` in
  the checked-in documents are the whole record.
- Never widen a segment citation to a bare file path to make the count fall.
