# Codex-native Chat parity research

## Decision

VibeHub should feel like Codex because it is a Codex client, not because it imitates
a screenshot. The official app-server owns Threads, Turns, items, approvals and
execution. VibeHub adds Task and Context actions around that substrate. The first
production implementation should combine a small versioned Codex event adapter with
selectively adapted, license-compatible headless UI primitives; it must not import a
second Agent runtime or transcript store.

The pinned baseline is `@openai/codex` 0.147.0 at commit
`be6e8eac029b183056b7e4402879f15d2c85f61b`, generated schema SHA-256
`f3dec1e031d99a420b137b903f02196d4325eece57620c925bb7130b25f168d2`.
The checked-in executable mapping is
[`chat-ui-contract.json`](proposals/codex-native-chat/chat-ui-contract.json).

## First-party interaction inventory

| Interaction | Directly observed / official capability | VibeHub relevance |
| --- | --- | --- |
| New, resume, fork, archive and delete Thread | `thread/start`, `thread/resume`, `thread/fork`, `thread/read`, `thread/list`, `thread/archive`, `thread/delete` | Threads remain Codex objects; Task linkage references identity only. |
| User and Agent Turns | `turn/start`, `turn/steer`, `turn/interrupt`, `turn/started`, `turn/completed` | Task execution may own one linked Thread/Run without redefining the Turn. |
| Streaming answer | `item/started`, `item/agentMessage/delta`, `item/completed` | The UI may stream, but durable replay is app-server truth. |
| Reasoning and plan | reasoning summary/content deltas, `plan`, `item/plan/delta`, `turn/plan/updated` | Render as disclosures/progress, never as VibeHub Subtasks. |
| Commands and terminal | `commandExecution`, output delta, terminal interaction, process output/exit | Compact activity with expandable output and exact status. |
| Files and diff | `fileChange`, patch/output updates, `turn/diff/updated` | Reviewable changes are execution facts, not Evidence until explicitly recorded. |
| MCP and dynamic tools | `mcpToolCall`, `dynamicToolCall`, tool progress/result/error | Group repeated activity; retain server/tool identity and read-only hints. |
| Approval and human input | command/file approval and `item/tool/requestUserInput` server requests | Inline Turn boundary; distinct from durable Task `NEEDS YOU`. |
| Delegated work | `collabAgentToolCall`, `subAgentActivity`, receiver Threads and states | Show agent roster/progress without turning internal work into Task nodes. |
| Search/image/generation/wait | `webSearch`, `imageView`, `imageGeneration`, `sleep` | Quiet activity cards with honest result boundaries. |
| Review and compaction | entered/exited review mode, `contextCompaction` | Timeline boundaries; compaction is not loss or completion. |
| Attachments | text, image, localImage, audio, localAudio, skill and mention inputs | Familiar Composer; ordinary audio is supported. |
| Realtime audio | realtime requests/events exist, but the current authenticated probe reports unsupported | Hide realtime controls; do not imply a capability from schema presence. |
| Retry and error | `error { willRetry }`, warning/config/model reroute events | Retrying remains live; terminal failure remains inspectable and starts no fake Turn. |
| Reconnect and replay | event cursor plus `thread/read` reconciliation | Replayed history never produces live presence. |

The official app-server README says all items share `item/started` and
`item/completed`, and the completed item is authoritative. It also requires inline,
Turn-scoped approval handling. That lifecycle is the reducer contract rather than a
visual convention. Sources: [OpenAI Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md), [protocol source](https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol), and the exact locally generated 0.147.0 schemas.

## Open-source reuse audit

Repository metadata was checked on 2026-08-21. Stars are only a maintenance signal,
not a quality claim.

| Project | License / maintenance | Useful unit | Dependency and security surface | Decision |
| --- | --- | --- | --- | --- |
| [assistant-ui/assistant-ui](https://github.com/assistant-ui/assistant-ui) | MIT; ~11.7k stars; active 2026-08-20; React 18/19 | headless Thread, Composer, attachments, auto-scroll, reasoning/tool groups, branch actions | its own runtime abstraction plus Radix, Zustand, Zod and safe-content-frame | Selectively adapt UI primitives in production; do not let its runtime own Codex events. |
| [yunhaoli24/codex-gateway](https://github.com/yunhaoli24/codex-gateway) | MIT; active 2026-08-19; small but app-server-specific | stable item identity, delta merge, Thread history/timeline, virtualized Chat, approval/diff/sub-agent component boundaries | large Nuxt/SSH/SQLite/CodeMirror/xterm gateway product | Reimplement the bounded reducer and display semantics; reject whole-product adoption. |
| [lezi-fun/codex-webui](https://github.com/lezi-fun/codex-webui) | MIT; active 2026-08-14; small | direct app-server transport, sanitizer, xterm, Playwright approval/composer/theme/mobile coverage | Bun/WebSocket server plus marked, DOMPurify, KaTeX and xterm | Reference compact transport and E2E cases; insufficient maturity to adopt wholesale. |
| [seo-rii/codex-webui](https://github.com/seo-rii/codex-webui) | MIT; active 2026-08-20; very small | Svelte Chat state, Markdown and code-diff workspace | Rust/Svelte build and low adoption | Reference only. |
| [Pedregoneric/codex-webui](https://github.com/Pedregoneric/codex-webui) | MIT; active 2026-08-01; very small | mobile/Tailscale layout ideas | bespoke remote access and no meaningful adoption | Reference only. |
| [vercel/chatbot](https://github.com/vercel/chatbot) | Apache-2.0; ~20.8k stars; mature | generic ChatGPT-like density, message actions and attachment layout | Next.js, AI SDK, auth/database/cloud assumptions; not Codex protocol-aware | Reference general layout only. |
| [0xcaff/codex-web](https://github.com/0xcaff/codex-web) | no repository license observed; ~260 stars | app-server web-client ideas | reuse rights are absent | Do not copy code; behavior reference only. |

No candidate justifies importing proprietary Codex Desktop code, icons, assets or
private APIs. Familiarity comes from information hierarchy, pacing and official
protocol behavior.

## Production architecture

1. `codex-adapter` pins and translates the generated schema.
2. `codex-chat-model` folds `thread/read` plus live notifications into stable item
   identities. Completed items replace live items authoritatively.
3. `codex-chat-ui` renders sanitized Markdown and independently escaped command,
   diff and tool disclosures. Unknown items remain visible and inspectable.
4. A production virtual timeline mounts only the visible window and preserves the
   user's scroll position; the research carrier bounds the rendered tail to 240.
5. VibeHub actions reference exact Thread/Turn/item/selection identity. They never
   create a parallel transcript and ordinary Chat remains useful without VibeHub.

## Required v1 and deferrals

V1 requires real replay, streaming text, reasoning, plans, command/tool/file groups,
diff, approvals, human input, delegated-agent progress, attachment/audio Composer,
Send/Stop, error/retry/interruption/completion, Light/Dark, narrow layout, focus and
reconnect. Final branch comparison, realtime voice, every unstable auto-review shape,
and final Task/Room composition remain downstream work.

Stop and replan if the pinned schema changes without a generated adapter update, an
approval cannot round-trip, replay and live cannot share stable item identity, a UI
library requires replacing app-server truth, sanitization permits raw HTML, or
ordinary Chat becomes dependent on VibeHub Task state.
