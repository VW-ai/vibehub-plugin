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

The third audit exposed that mounted-output bounds were not browser-state bounds
and that several controls were only structural. The corrected carrier now caps
live Maps, deltas and file-change arrays; keeps Composer text, Quote identity and
attachments in a bounded Thread-owned draft store; routes live submission through
exact `turn/steer`; and implements pinned `thread/fork`. The narrow Sidebar and all
overlay panels share explicit inert, modal, scrim, Escape and focus-return posture.
An opt-in deterministic browser guard operates those controls and reports its
structured result instead of treating source inspection as interaction proof.

The production shell (`apps/codex-first-shell/`) then closed the five partial
checks and the navigation gap that remained open at `fac258a`. A
selection-preserving patch policy replaces the timer-bounded whole-paint
deferral: the entry a live selection touches keeps its mounted node while the
rest of the Turn streams, and releasing the selection reconciles it. Quote source
identity serializes into the Turn input itself, so durable Thread history carries
the exact Thread, Turn and item and any replay renders it. The escape-first
Markdown renderer is now a line-start block parser with nested lists, nested
quotes, line-start fences and delimiter-bounded inline rules. Request-user-input
drafts survive intentional route changes. The Composer growth ceiling has one
CSS owner. The `?thread=` query follows the visible Thread after every in-app
navigation. Each upgrade has an exact node test and, except Markdown, a real-DOM
guard check named in the matrix proof fields; the mounted 240-item bound now
discloses itself, and a test pins that no model, mode or realtime control exists.

Task semantics did not enter this path. A quote is normal Chat input; it creates no
VibeHub Task, Evidence or Outcome. The disabled `Remember` and `Make Task` controls
remain truthful future bridges.

## Truthful remaining gaps

- The escape-first Markdown carrier renders nested lists, nested quotes and
  line-start fences with bounded malformed-input handling, but it remains
  intentionally smaller than CommonMark: tables, setext headings and indented
  code fall back to literal escaped text.
- Theme preference intentionally resets with the page because the carrier does
  not claim browser storage as a second persistence authority. Document-root
  theme tokens do cover Search, Inbox, Review, toast and selection overlays.
- The carrier retains a bounded 240-item tail and discloses how many earlier
  items are not mounted. True viewport virtualization remains deferred.
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

The independent execution/tool/approval audit then found six additional P0
families. The corrected carrier now classifies every pinned notification/request in
a checked-in census, renders structured Turn plans and aggregate diffs, retires
transient state on authoritative completion, detects event-window gaps/runtime
generation changes, reconciles externally resolved requests, and uses a versioned
discriminated request registry. Command/file approvals expose material context and
separate Decline from Cancel-and-interrupt. Human input preserves keyed DOM state,
distinguishes blocking/secret/Other semantics, and validates every question.
Unsupported dynamic tools and future requests receive an immediate truthful
response rather than a false command-approval card. Tool/delegated non-text or
identity-bearing output remains visible or has an explicit fallback.

The independent Composer/navigation/accessibility audit found six further P0
families: conflicting running submission, cross-Thread Composer state, a trapped
narrow Sidebar, unbounded live reducer state, a dead Thread action and no browser
interaction guard. All six now have concrete corrections. The audit report remains
immutable and correctly records its FAIL verdict against the earlier commit. The
final application commit then passed the 25-check real-DOM guard, wide Light/Dark
review and a bounded authenticated Codex steer, interrupt and Fork flow recorded in
[`browser-runtime-review.md`](browser-runtime-review.md). The production
closure extended that guard to 35 checks at 1280 and 36 in the narrow review
frame; those runs are recorded in the same review.
