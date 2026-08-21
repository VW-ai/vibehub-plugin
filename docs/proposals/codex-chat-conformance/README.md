# Codex Chat conformance gap closure

This is an incremental audit of the authenticated Codex-first shell against the
already accepted native-Chat inventory and renderer contract. It does not recreate
the source inventory or claim that visual resemblance is behavioral parity.

## What changed

The current carrier had six highest-severity gaps even though its first protocol
mapping was sound:

1. streamed full-transcript replacement could destroy an active text selection and
   reset activity disclosures;
2. selection and whole-response Quote / Add to chat did not exist;
3. `item/tool/requestUserInput` used `window.prompt`, showed one question only and
   lost option structure;
4. MCP progress deltas were silently ignored;
5. Escape did not invoke the documented exact Stop action while Composer owned the
   active Turn; and
6. CSS clipped rich output visually but allowed unbounded command, diff, tool and
   unknown payloads into the DOM.

The implementation now uses an executable reducer and pure rich-content renderer
shared by the actual browser surface and Node tests. It reconciles replay and live
state by compound Thread / Turn / item identity,
replaces completed items authoritatively, retains interruption boundaries, handles
MCP progress, leaves unknown deltas non-mutating and enforces one aggregate mounted
DOM budget across response text, citations, file changes and media. Generated, tool
and unsupported image results either render from an explicitly supported source or
show a truthful fallback. Full citation Thread identity remains accessible and
copyable. Keyed timeline reconciliation preserves selection, focus and disclosure
posture during streaming (with a bounded selection deferral),
adds quoted response context to the ordinary Composer, renders all user-input
questions inline, restores terminal failures as an explicitly new Turn, auto-grows
the Composer, adds code copy and implements the contract's focus-scoped Escape Stop.

Task semantics did not enter this path. A quote is normal Chat input; it creates no
VibeHub Task, Evidence or Outcome. The disabled `Remember` and `Make Task` controls
remain truthful future bridges.

## Truthful remaining gaps

- The escape-first Markdown carrier is intentionally smaller than a mature
  CommonMark renderer; nested/malformed constructs remain a medium-severity
  production-shell gap.
- Quote carries exact Thread / Turn / item identity in the active browser session.
  Durable source-identity serialization remains a medium-severity production gap.
- The research carrier retains a bounded 240-item tail. True viewport
  virtualization belongs in the production shell.
- Model and collaboration-mode pickers remain absent rather than falsely enabled.
- Ordinary audio remains supported; realtime voice remains hidden because the
  pinned runtime probe reports it unsupported.
- Final visual-system work remains separate from this interaction contract.

The machine-readable before/after result is
[`conformance-matrix.json`](conformance-matrix.json). Browser/runtime results are
recorded in `browser-runtime-review.md` after the exact implementation commit is
exercised.

## Independent audit packets

Three reviewers must inspect the same stable implementation commit and write one
separately attributable report each under [`audits/`](audits/README.md):

- message and rich-content rendering;
- execution, tools and approvals; and
- Composer, navigation and accessibility.

The executor does not author those reports. Their convergence may change the
matrix and implementation before Evidence is recorded.

The first independent message/rich-content audit found six P0 gaps in the interim
commit. Those findings remain unchanged in the reviewer-owned report; the current
implementation corrects compound identity, aggregate bounds, generated/tool image
fallbacks, full citation identity, executable rich-renderer tests and keyed streaming
updates before final Evidence is considered.
