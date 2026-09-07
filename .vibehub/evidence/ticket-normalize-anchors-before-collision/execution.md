# Anchor normalization execution evidence

Baseline: c192a4705fa09a174a86197bc99a1022c950502b.
Scope: ticket-normalize-anchors-before-collision; acceptance unchanged.

## Decision and behavior

- Reject repository-root anchors, including `.`, `./`, and `././`.
- Parse at the last hash as before; normalize only the path side. Empty and dot
  components are removed. Slugs and source segmentation are unchanged.
- Reject empty parsed paths, absolute paths, drive prefixes, backslashes, parent
  traversal, and `.vibehub` / `.git` path components. Parent traversal is rejected
  rather than collapsed to avoid conflating lexical paths and symlink traversal.
- Both room put and project validate use validateRoom and the same normalized
  collision function. Existing overlapping-territory wording is retained for
  valid overlapping anchors. Invalid root anchors fail validity, even alone.
- Coverage walks skip internal directories. Coverage and alignment skip paths
  traversing symlinks, including intermediate components. Collision decisions
  remain purely textual and do not call filesystem APIs.

## Reproduction and regression

Run `node --test test/anchor-normalization.test.mjs` (29 tests).
Tests cover equivalence in both insertion orders at write and repository validate,
root/empty/unsafe/internal anchor rejection at write and read, normalized segment
coverage, disjoint segments, nested internals, symlink aliases into internals,
and canonical alignment hashes with spelling-only re-put preserving the stamp.
The existing segment-anchor tests still cover nested Room containment, last-hash
paths, disjoint segments, and deliberately dropping alignment on re-put.

Full `npm test`: 251 passed, 0 failed, 0 skipped. Tests require local loopback
permission in this host sandbox. Both project validate and skills validate pass.
These counts were collected before appending this Ticket's Evidence/Outcome.

## Existing Room equivalence

Run `node .vibehub/evidence/ticket-normalize-anchors-before-collision/compare-baseline.mjs`.
It clones the baseline into temporary storage with Git history available for
historical Context references, then runs the old and new scripts on the SAME
frozen checkout. No source repo or Peel mutations. The first archive-only attempt
could not validate historical references; the final clone-based probe passed.

project validate: identical on all checked-in Rooms
room drift: identical on all checked-in Rooms
context coverage: identical on all checked-in Rooms
room align knowledge: identical commit and anchor hashes
room align marketing: identical commit and anchor hashes
room align marketing/video: identical commit and anchor hashes
room align product: identical commit and anchor hashes
room align ticket-lifecycle: identical commit and anchor hashes
room align workbench: identical commit and anchor hashes
baseline c192a4705fa09a174a86197bc99a1022c950502b; 6 Rooms; checked_at excluded only from freshly minted alignment stamps

The full project validation, drift, and coverage envelopes compare deep-equal.
Fresh alignment comparison excludes only checked_at (wall clock); commit and
all anchor hashes are compared. The original six Room files are not rewritten.

## Explicit boundaries

- Original anchor spelling is retained on disk; canonicalization happens on read.
- A syntactically valid prefix with no existing files (including a symlink-only
  path) remains allowed as declared territory; it covers no source files. This
  does not make root/empty/internal anchors valid. Missing segment anchors are
  reported in unresolved_anchors.
- Last-hash ambiguity for whole paths containing # is unchanged. Line-window
  segment movement and room put's deliberate replacement semantics are unchanged.
- Collision is over declared textual territory, not filesystem aliases, inode
  identity, case folding, or hard links. No realpath-based collision resolution.
- Coverage zero is not a semantic completeness or quality proof.
- Peel remains read-only: its same 5 modified + 9 untracked paths were observed.
- The Peel verification partial Outcome and no-prompted-recovery criterion are
  untouched. No new report store or source-segmentation format was introduced.
