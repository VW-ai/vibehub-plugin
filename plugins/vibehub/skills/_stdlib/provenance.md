# Provenance and evidence

Every draft or candidate needs immutable evidence with a source reference and
at least one of: exact quote, evidence reference, or content hash.

Use exact quotes for authored decisions and constraints. For code evidence,
record the canonical repo-relative path, content hash, and symbol/line range
when stable. Preserve producer, produced time, task and request identity through
the dispatcher context.

Optional anchor fields remain strict: omit an unknown symbol;
`symbol: null` is invalid. If an operation requires a stable symbol/range that the evidence cannot
support, defer that anchor or keep the file unresolved rather than writing null,
an empty string, a guessed symbol, or an arbitrary line.

Confidence expresses strength of support, not desired distribution. Route low
confidence to review. Do not block a valid write merely to meet a histogram.

Separate statements:

- **observed**: directly supported by the source;
- **authored rationale**: quoted or explicitly attributed;
- **inference**: label it as inferred and state the evidence;
- **unknown**: preserve the gap. Honest WHAT/context is valid when WHY is not
  available; never fabricate rationale.
