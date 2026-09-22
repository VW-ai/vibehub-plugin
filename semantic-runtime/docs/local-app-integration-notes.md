# Local app integration notes

Checked 2026-09-21. Research and local CLI inspection, not a running app or a
successful live integration. No credentials, private transcripts, login state or
model endpoints were accessed for this check.

## Product contract

The app launches locally, registers a selected Git folder, discovers the same
repository's linked worktrees and lets the user explicitly activate VibeHub for
that Project. It configures model API routes separately from local subscription
executors. Codex and Claude Code are the first interactive integrations and the
first local executor choices. A user needs only their chosen subscription.
Tickets specify outcomes, constraints, context and acceptance; development
methods and additional skills remain the executor's choice.

The semantic pipeline is still event ingress → Policy Graph → scoped Working
Graph → query/Context Compiler → delivery. Policy can submit bounded heavy work
to a local executor and validate its returned proposal. The app and plugins use
these services rather than duplicating policy in their UI.

## Reuse candidates and evidence

| Boundary | Primary evidence | Implication |
| --- | --- | --- |
| OpenRouter | [Official AI SDK provider](https://github.com/OpenRouterTeam/ai-sdk-provider) supports evaluation via `decisionModel` / `evaluationModel`; the Decisions API is alpha. | Reuse the maintained package, pin versions and explicitly preserve its answer mapping/rounding and errors. Installed Runtime AI SDK is 7.0.107; dependency compatibility still needs a test. Do not silently use the default Gateway. |
| Vercel | [AI SDK integration](https://vercel.com/docs/ai-gateway/sdks-and-apis/ai-sdk) and [authentication](https://vercel.com/docs/ai-gateway/authentication-and-byok) document Gateway API keys for local clients. | Reuse existing Gateway adapters, exposing explicit route/model settings rather than requiring a Vercel deployment. |
| TypeSafe | [Official JavaScript SDK](https://docs.typesafe.ai/sdk/javascript) documents `@typesafe-ai/sdk` and `TypeSafeClient.systemOne`. | Existing Runtime dependency 0.6.0 and direct JEV adapter are reusable; verify capability/error mapping rather than assuming every provider is identical. |
| Codex executor | [App Server authentication](https://learn.chatgpt.com/docs/app-server#auth-endpoints) documents managed ChatGPT login, account notifications and rate-limit reads. | Prefer CLI-owned managed login. Auth state/reauth can be presented without exporting tokens. App Server and noninteractive exec are separate possible transports. |
| Claude executor | [Programmatic Claude Code](https://code.claude.com/docs/en/headless) documents `-p`, structured output and permissions. `--bare` does not use subscription login. | A subscription worker must not blindly copy an API-key-only bare-mode example. Probe the installed CLI's actual auth/permission/working-directory behavior. |

Observed local versions: Codex CLI 0.155.1, Claude Code 2.1.278. Read-only help
showed `codex app-server`, `codex exec --json --output-schema`, and
`claude -p --output-format stream-json --json-schema`. This is capability
inventory only; neither login validity nor a completed Worker job was tested.
`codex server exec` is not the command shape observed in this installation.

The selected repository currently has 12 registered worktrees, several outside
its root. Enrollment must use Git's common-directory identity and registered
worktree inventory, not recursive subfolder discovery. Repository identity,
branch/ref incarnation, worktree execution identity and Session remain distinct.
A branch with no checkout has no live filesystem to collect. Independent clones
need explicit association; a shared remote URL is insufficient identity proof.

## Boundaries to verify

- Provider secrets enter through the app into local secure storage; configuration
  and logs contain only references and redacted status. Worker subscription login
  remains owned by the corresponding CLI. Never substitute one credential type
  or billing route for another without explicit configuration.
- App Project activation gates collection, dispatch, result admission and delivery.
  Disable fences late results, preserves history and coding, and records gaps.
  Re-enable does not implicitly scrape or transmit disabled-period conversations.
- A plugin install is not evidence of every-message capture. Measure Codex and
  Claude lifecycle coverage separately, including restart, compaction and gaps.
- Background Worker events carry an internal origin and cannot recursively
  trigger the user-session Collector. Use bounded selected input and tools,
  structured candidates, current source/activation checks and durable receipts.
- Local execution still calls the selected model service. Queue/backpressure,
  auth expiry, quota, cancellation and stale results need visible outcomes;
  uninterrupted coding does not imply infinite or synchronous background work.
- First app onboarding requires Git, with an explicit initialize action for a
  non-Git folder. Existing files survive. GitHub linking remains optional and
  does not imply a remote, initial commit, push or uploading project context.

## Search ledger

Registry preflight: local `opencli list -f yaml`; no appropriate dedicated
provider-doc adapter selected. Five web search queries: OpenRouter AI SDK and
structured output; Vercel AI Gateway/AI SDK/key; TypeSafe SDK/JEV; Codex App
Server/auth/exec; Claude Code headless/auth/hooks. Retained the six primary
pages linked above and checked local CLI help. Secondary search results were
not used as technical evidence. No packages or plugins were installed.
