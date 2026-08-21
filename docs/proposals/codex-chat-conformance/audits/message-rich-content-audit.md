# Independent audit: message and rich-content rendering

## Audit identity and verdict

- Reviewer: `/root/audit_chat_message_rendering` (independent specialized subagent)
- Audited commit: `35f450bf606de9e82f891d4850d13334cfb5917d`
- Scope: message/reasoning streaming, Markdown and code, file diffs, image/media,
  memory citations, selection/Quote/Add to chat, replay/live identity, unknown-item
  fallback, DOM bounds and rendering-specific accessibility
- Verdict: **FAIL — correction required before the current matrix can claim message
  and rich-content conformance**

The patch materially improves the carrier: completed items replace their streamed
form, unknown completed items remain inspectable, raw HTML is escaped before the
small Markdown transform, selected text is no longer destroyed immediately, and
command/diff/unknown `pre` disclosures have per-string bounds. Those improvements
do not close the exact accepted contract. Two highest-severity defects remain in
runtime state/identity, and multiple supported rich-content paths are still
unbounded, silently reduced or not covered by executable renderer tests.

## Sources and review method

The binding baseline was the checked-in
[`chat-ui-contract.json`](../../codex-native-chat/chat-ui-contract.json), the
accepted native-Chat Outcome, the two checked-in Chat fixtures, and the exact
implementation at the commit above. Protocol claims were checked against the
[OpenAI Codex app-server README pinned at the accepted upstream commit](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/app-server/README.md)
and its [pinned app-server protocol source](https://github.com/openai/codex/tree/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/app-server-protocol).
The official lifecycle says that an item is scoped by Thread/Turn, deltas address
the started item, and `item/completed` is authoritative. The accepted local
contract consequently defines item identity as
`thread.id + turn.id + item.id`; that composite identity is the audit oracle.

Focused verification produced the following results:

- `node --test test/codex-chat-conformance.test.mjs`: 4/4 passed.
- The Chat and shell-focused pair passed 10 checks and failed one environment
  startup check because the local `codex app-server` process exited before the
  loopback host became ready. No runtime/browser result is inferred from that
  environmental failure.
- A direct reducer probe applied the same `item.id` to two different
  Thread/Turn pairs. The model retained one item, and `canonicalTimeline()` for
  Thread A rendered Thread B's text. The exact output was
  `liveItemCount: 1` with the surviving `_turnId: "turn-b"` and text `"B"`.

## Conformance results

| Area | Result | Severity | Exact finding |
| --- | --- | --- | --- |
| Stable identity, replay and dedupe | **Fail** | Highest | `liveItems` is one global `Map` keyed only by `itemId`; `canonicalTimeline` also dedupes replay/live by bare `item.id`. Switching from one running Thread to another running Thread does not clear the map, so live content from the first Thread can appear in the second. This contradicts the accepted composite identity and can hide, overwrite or cross-contaminate transcript content. |
| Completed-item authority | Pass within one uncontended id | — | `item/completed` replaces the accumulated object and marks it non-live. The proof does not survive duplicate ids across Thread/Turn scopes until the identity defect is fixed. |
| Streaming agent text and reasoning | **Partial** | Highest | Deltas fold correctly and a selected transcript temporarily freezes repaint; open disclosures are restored. However every paint still replaces the complete `.surface` with `innerHTML`. That destroys focus and assistive-technology position inside a response/activity, re-announces a large `aria-live` region, and can defer all visible progress indefinitely while a selection remains active. There is no executable DOM test for selection, disclosure, focus or announcement behavior. |
| Markdown and links | **Partial** | Medium | Escape-first output and the HTTP(S)-only link transform are sound. The hand-written transform supports a useful subset, but the matrix's blanket `pass` is too strong: emphasis is only bold, list/quote structure is line-local, and malformed/fenced input has no renderer-level fixture. This is acceptable for a research carrier only when recorded as partial rather than Codex-quality parity. |
| Code and diff | **Fail** | Highest | Fenced agent code is inserted without any character bound; CSS `max-height` bounds only visible height. Diffs are bounded per `change.diff`, but the number of changes and aggregate DOM are unbounded. A large supported reply/diff can still monopolize the DOM. |
| Images and generated images | **Fail** | Highest | A non-`data:image/` `image` falls through to the generic mention branch and renders `@undefined`. Replay image count and data-URL length are not bounded. `imageGeneration` renders prompt/status only and drops the accepted result affordance. Supported image content is therefore either misrepresented, unbounded or silently omitted. |
| Memory citations | **Fail** | Highest | Path, line range and note are escaped and visible, but source Thread ids are irreversibly shortened to 12 characters with no full accessible value/copy affordance. Citation count, note length and aggregate DOM are unbounded. This does not satisfy the accepted Outcome's exact source-Thread identity or the contract's bounded citation disclosure. |
| Selection, Quote and Add to chat | **Partial** | Medium | Selection and whole-answer actions exist and quote text is bounded. The UI stores `threadId` and `itemId`, but submission serializes only Markdown quote text; the source identity is discarded after send, and whole-answer lookup is ambiguous under bare-item identity. This is a usable ordinary Chat quote, not yet a source-addressable comment/quote interaction. Selection behavior is proved only by source-regex assertions. |
| Tool/search rich results | **Partial** | Highest | Tool text is truncated, but truncation is silent because only `boundedText(result).text` is rendered; image or other content entries are dropped. Web-search results have the same silent truncation. The matrix says omitted characters are disclosed for tool output, which is false for these paths. |
| Unknown completed item fallback | Pass by source inspection | — | The type remains visible, the raw payload is escaped and bounded to 8,000 characters, and no success is invented. Unknown deltas remain non-mutating. A DOM-level regression fixture is still required before calling the renderer behavior executable. |
| Long output / bounded DOM | **Fail** | Highest | The 240-item tail and several per-string caps are useful, but they do not bound total mounted characters, citation/media/change counts, fenced code, agent prose or aggregate rich items. The claimed global DOM bound does not exist. |
| Rendering accessibility | **Partial** | Highest | Buttons and citations have labels and code copy is keyboard reachable. Full-surface live replacement can remove focus from code-copy/disclosure controls, the full `surface` is `aria-live="polite"`, and scrollable `pre` regions have no keyboard-focus contract. These behaviors need a real browser/accessibility test, not a source pattern. See [WCAG 2.2 keyboard guidance](https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html). |
| Executable renderer regression coverage | **Fail** | Highest | The four new tests execute only the reducer/bound helper. The renderer test asserts that strings such as `selectionchange` and CSS class names exist; `renderMarkdown`, `renderItem`, citation/media output, Quote behavior and focus preservation are never executed. The fixtures omit duplicate cross-Thread identity, unknown rendering, large code/diff/tool/citation/media inputs and malformed Markdown. The Ticket requires tests that fail on silently dropped supported items; the current suite cannot do that. |

## Highest-severity findings in source

### 1. The runtime model violates its own identity contract

[`chat-model.mjs`](../../../../apps/codex-first-shell-prototype/chat-model.mjs)
stores every started/completed/delta item under `model.liveItems.get(itemId)` and
dedupes replay using `new Set(replay.map(item => item.id))`. Thread id is filtered
only before dispatch in the browser; it is not part of model identity. The browser
also owns only one global `liveItems` map, and `openThread()` clears it only when the
newly opened Thread is not running. Two concurrently running Threads therefore
share one item namespace and one visible live tail.

Required correction:

1. Key reducer state by an exact composite key containing `threadId`, `turnId` and
   `itemId`, or keep a per-Thread model whose internal key includes Turn and item.
2. Make `canonicalTimeline(thread, ...)` select only state for `thread.id` and dedupe
   against `(thread, turn, item)`, never bare `item.id`.
3. Carry the same key through Copy, Quote, disclosure identity and replay
   reconciliation.
4. Add executable tests with colliding item ids across two Threads and two Turns,
   including switching between two simultaneously running Threads.

### 2. “Bounded rich output” is currently a collection of local caps, not a DOM bound

[`app.js`](../../../../apps/codex-first-shell-prototype/app.js) calls
`renderMarkdown(item.text)` directly for agent messages and reasoning. Its fenced
code branch escapes but never bounds the code string. Diff strings are bounded one
at a time while `changes.map(...)` is unlimited. Citation entries and replay media
are unlimited. Tool and web result branches slice text but omit the truncation
notice. An arbitrarily large legal replay can consequently allocate an arbitrarily
large HTML string and DOM even though the viewport looks clipped.

Required correction:

1. Define and test aggregate budgets per mounted item and per mounted timeline,
   plus count caps for changes, citations and media.
2. Apply bounds before Markdown parsing and expose an explicit continuation or
   omitted-content affordance; do not silently slice.
3. Validate replay media MIME, URL class and length before mounting. Render a named,
   inspectable unsupported-image fallback instead of `@undefined`.
4. Render or explicitly defer generated-image/tool-image results rather than
   silently dropping protocol content.
5. Keep durable app-server replay authoritative; bounds apply only to the mounted
   projection.

### 3. The current tests do not execute the renderer contract

[`codex-chat-conformance.test.mjs`](../../../../test/codex-chat-conformance.test.mjs)
tests reducer helpers and then searches implementation text with regular
expressions. A test that finds `selectionchange`, `.quote-selection` or
`data-request-form` continues to pass if the interaction is inaccessible, emits the
wrong content, loses focus, or drops a supported part. This explains why the
identity and rich-output defects coexist with a fully green focused suite.

Required correction:

1. Extract the message/rich renderer behind a pure, exported item-to-view-model or
   item-to-safe-fragment seam.
2. Add DOM/browser assertions for exact Markdown escaping and links, citation
   identity, each media type, visible truncation, unknown fallback, selection and
   Quote, disclosure/focus preservation, and live-to-replay replacement.
3. Include adversarial large/malformed fixtures and a supported-content census that
   fails whenever a known rich part disappears.

## Relevant open-source comparison

No implementation code or asset was copied during this audit.

| Candidate | Independently relevant fact | Use / reject boundary |
| --- | --- | --- |
| [assistant-ui/assistant-ui](https://github.com/assistant-ui/assistant-ui) | MIT, actively maintained at the audit date; production-oriented React Thread/message/Composer primitives. The accepted survey records React 18/19 plus Radix, Zustand, Zod, its Markdown package and safe-content-frame in the dependency/security surface. | Selectively adapt message-part, auto-scroll, branch/action and safe Markdown interaction patterns. Do not adopt its runtime abstraction or let it become Codex transcript truth. |
| [yunhaoli24/codex-gateway](https://github.com/yunhaoli24/codex-gateway) | MIT, app-server-specific and active at the audit date; its repository exposes virtualized Chat, diff/image/tool/sub-agent boundaries. It also carries a materially larger Nuxt/SSH/SQLite/CodeMirror/xterm and remote-host security surface. | Reimplement the composite identity, virtualized timeline and typed rich-item boundaries; reject whole-product adoption and its remote execution/storage layer. |
| [lezi-fun/codex-webui](https://github.com/lezi-fun/codex-webui) | MIT and active at the audit date; direct app-server client with marked/DOMPurify, xterm and Playwright coverage. It still brings a Bun/WebSocket server and a broader sanitizer/terminal dependency surface. | Reference its executable Markdown/approval/mobile cases and sanitizer posture. Do not adopt its server/runtime or assume its maturity makes wholesale reuse safe. |

These maintained candidates reinforce the existing recommendation: keep the small
versioned Codex reducer authoritative, but stop growing an untested regex renderer.
A mature Markdown/sanitization primitive and a virtualized typed-part view can be
adopted selectively without importing a second Agent runtime.

## Prioritized recommendation

1. **P0 — identity:** implement Thread/Turn/item composite keys and cross-Thread
   isolation before any conformance Evidence is recorded.
2. **P0 — executable renderer:** add real DOM/browser conformance tests and rich
   fixtures; source-pattern assertions may remain smoke tests only.
3. **P0 — aggregate bounds and supported-part truth:** bound agent/code/diff,
   citation/media/tool content with visible truncation, and add honest image/result
   fallbacks.
4. **P0 — streaming stability:** patch the affected item or otherwise preserve
   selection, disclosure, focus and announcement scope without replacing the full
   live region on every frame.
5. **P1 — citation/quote identity:** expose the full citation source Thread
   accessibly; keep exact quote source identity through the UI interaction while
   truthfully serializing only supported Codex input to app-server.
6. **P1 — Markdown quality:** replace the hand-written parser with a narrowly
   configured, license-compatible Markdown/sanitization path and test malformed
   input. This is behavioral correctness work, not visual polish.

Until P0 items are corrected and rerun against the same stable implementation
commit, the matrix entries `thread-replay-identity`, `selection-during-stream`,
`markdown-rich-content`, `citations-attachments`, `bounded-rich-output` and the
renderer portion of `unknown-items` must not be recorded as full passes.
