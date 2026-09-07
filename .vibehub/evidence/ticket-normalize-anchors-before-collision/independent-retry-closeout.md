# Independent retry closeout at 0fa73e2

Verdict: successful, 6/6 accepted. The first partial remains in Git commit ab1511f and its Evidence/probe/output are unchanged. This adjudication replaces the canonical Outcome only after rerunning the unchanged criteria.

- anchors-normalized-before-collision: accepted. Independently reran full suite including equivalent prefix and segment forms, both insertion orders, room put and project validate overlap rejection. Pure lexical normalization, existing overlap wording retained.
- repo-root-anchor-is-honest: accepted. Root variants are rejected by tests rerun independently; room schema explicitly chooses rejection.
- empty-territory-anchors-are-reported: accepted. Empty-path variants are rejected at write and repository reads, never silently filtered.
- vibehub-internals-not-anchorable: accepted. New independent retry probe verifies identical inode for .VIBEHUB and .vibehub evidence file on this macOS host. Directory, whole-file and segment anchors now fail room put, project validate, coverage and drift with internal-document errors, including manually written Rooms. A wider normalized prefix excludes nested .ViBeHuB and .gIt, retains .VIBEHUB-notes, and yields only the expected source segment. Symlink directory/file/segment aliases remain excluded. The predicate is shared by parse validation and source walk; reserved-name matching is case-insensitive, ordinary collision matching stays textual.
- existing-anchors-unchanged: accepted. Independently reran compare-baseline.mjs against frozen c192a47: complete validation, drift and coverage envelopes identical, all six Room alignment commit/hashes identical. Only newly minted checked_at excluded.
- regression: accepted. Full npm test 257 passed, zero failed/skipped, including 35 normalization tests and existing segment-anchor cases. project validate, skills validate, ticket validate all valid:true.

Constraints hold: no weakening of overlap logic, no segmentation algorithm changes, no filesystem access or symlink resolution in collision normalization. Read-time symlink guards remain separate. No source changes, acceptance changes, Peel access or Git commits by adjudicator.

Reproduce additional independent tests: node .vibehub/evidence/ticket-normalize-anchors-before-collision/independent-retry-probe.mjs "$PWD". The inode check deliberately requires a case-insensitive filesystem. Raw output: independent-retry-output.txt. Historical independent-case-probe.mjs intentionally asserts the earlier bug and is not a passing regression test of the fixed implementation.
