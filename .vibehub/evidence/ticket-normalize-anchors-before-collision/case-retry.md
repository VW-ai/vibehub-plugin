# Case-alias retry

First independent Outcome: partial (5/6), preserved in commit ab1511f, with
independent-case-probe.mjs, its captured output and independent-closeout.md.
The original probe intentionally asserts the failure and remains unchanged.

Retry plan independently validated: only Ticket context and its evidence
reference were extended. Acceptance and constraints are unchanged, and the
partial Outcome remains until a new independent adjudication.

The internal component predicate now reserves .vibehub and .git without ASCII
case distinctions, and the source directory walker calls that same predicate.
This closes the case-insensitive-filesystem alias and excludes mixed-case
internal directories on case-sensitive filesystems as well. Ordinary file names
and collision comparisons are not case-folded. No filesystem calls were added
to anchor normalization or collision. Schema states this reserved-name policy.

Six added regressions: five mixed-case internal anchors fail at write, validation,
coverage and drift; one wider-prefix walk excludes .VIBEHUB and .GiT while
retaining .VIBEHUB-notes. These tests are portable and do not depend on the host
being case-insensitive. The earlier independent inode-based probe supplies the
real macOS failure evidence; the new independent adjudication must test its fix.

Execution results after the retry:
- Focused normalization suite: 35 pass, 0 fail, 0 skip.
- Full npm test: 257 pass, 0 fail, 0 skip (loopback permission enabled).
- project validate and skills validate: valid:true.
- compare-baseline.mjs: full validation/drift/coverage envelopes identical on
  frozen c192a47, six Rooms' fresh alignment commit/hashes identical; only newly
  generated checked_at excluded from stamp comparison.
- git diff --check: clean.

No Peel source or verification criterion/Outcome changes. No segmentation
changes, no relaxed overlap, and no implicit preservation/restamping on room put.
