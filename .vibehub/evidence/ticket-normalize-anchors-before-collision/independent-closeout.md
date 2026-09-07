# Independent closeout at 7f3d6cd

Verdict: partial, 5/6 accepted. Implementation and criteria were not modified.

- anchors-normalized-before-collision: accepted. Independently ran the full suite including both insertion orders, room put and hand-written Room project validation, for dot components, repeated/trailing slashes, prefix/segment and segment/segment equivalence. Existing overlapping-territory wording retained. Collision normalization is lexical; no filesystem API is called by parseAnchor/anchorsCollide.
- repo-root-anchor-is-honest: accepted. Root variants rejected; policy is explicit in room schema.
- empty-territory-anchors-are-reported: accepted. #, /, /// and empty-path segment variants rejected at write and validation.
- vibehub-internals-not-anchorable: NOT accepted. On this macOS case-insensitive filesystem, .VIBEHUB/evidence/probe/notes.md and .vibehub/evidence/probe/notes.md have the same inode. All three upper-case alias anchor shapes (directory, whole file, segment) are accepted at room put and project validate; context coverage absorbs the internal document and reports one segment and no unresolved anchors. isInternalSourcePath uses case-sensitive component equality. Disclosure of case-folding limits cannot satisfy this unconditional internal-material criterion. No collision case-folding policy is adjudicated here.
- existing-anchors-unchanged: accepted. Independently reran compare-baseline.mjs against frozen c192a47: complete project validation, drift and coverage envelopes deep-equal; all six Room alignment commit/hashes identical. Only newly minted checked_at timestamps excluded.
- regression: accepted. Required named regression cases exist and were rerun successfully; missing uppercase-internal regression is reflected in the fourth criterion, not concealed by the passing suite.

Independent execution: npm test 251 passed, zero failed/skipped. project validate, skills validate and ticket validate valid:true. Source segmentation code unchanged; existing segment-anchor tests pass. Separate independent symlink probe confirms directory, whole-file and segment aliases into internals produce zero segments, with the segment alias in unresolved_anchors.

Reproduce failure: node .vibehub/evidence/ticket-normalize-anchors-before-collision/independent-case-probe.mjs "$PWD". Requires a case-insensitive filesystem. The probe creates a fresh scratch repository, verifies equal inode, records full envelopes for three internal aliases, and tests symlink controls. Its assertions intentionally establish the bug observed at 7f3d6cd. Raw output is in independent-case-output.txt.

No Peel access or mutation. No change to Peel verification Outcome or criteria. No source fixes or Git commits made by adjudicator.
