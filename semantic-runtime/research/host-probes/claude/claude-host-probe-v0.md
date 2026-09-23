# Claude Code host capability measurement v0

Measured 2026-09-22 on macOS, installed **Claude Code 2.1.278**. This probe uses
real programmatic host events and invocation-local hooks/MCP. It does not claim
an installed interactive plugin, TTY coverage, full conversation capture or a
completed Worker service.

```sh
node --test research/host-probes/claude/test/claude-host-probe.test.mjs
npm run probe:claude:live
```

Without the live flag, no Claude call runs. A live invocation creates a temporary
Git project and makes at most three `claude -p` calls: synthetic context
query/ack, a native `/compact` command, then a fresh process resuming exactly the
probe's new session UUID with a new hook-only context marker.
Each call has a 90-second deadline and there is no retry or fallback. The observed
run requested the `haiku` alias; no resolved-model identity or account/billing
type was read, so neither is certified by this measurement.

## Measured result

The final minimized host report is retained as
[`claude-host-compaction-20260922.json`](reports/claude-host-compaction-20260922.json).
The earlier two-turn measurement remains separately retained; it does not prove
fresh delivery after compaction.

The final three-call run exited 0 with successful result objects and the selected
session identity. The first and resumed turns returned exact assistant/result
acknowledgements. The first query returned a
nonce through MCP; `ack_context` accepted that nonce and its successful tool
result was observed separately from the assistant's final response. The final
response also included the synthetic marker provided only by the
`UserPromptSubmit` hook. Each invocation receives a different random marker;
the resumed marker does not occur in its user prompt or earlier conversation.
Matching the old marker therefore fails the next-turn receipt. Reports contain
only match booleans. No hook blocks, continues a stopped turn, or modifies user input.

| Observation | First call | Native `/compact` | Exact-ID resume after compaction |
| --- | --- | --- | --- |
| Process time | 6,539 ms | 17,939 ms | 3,178 ms |
| Init event | 450 ms | 17,530 ms | 488 ms |
| Projected stream events | 83 | 12 | 34 |
| MCP tool-use events | `get_context` at 2,508 ms; `ack_context` at 4,131 ms | None | None |
| Assistant final text | 5,923 ms | None | 2,635 ms |
| Successful result | 5,984 ms | 17,531 ms | 2,699 ms |
| Exact acknowledgement | MCP nonce + fresh hook marker | Native boundary at 17,530 ms | Different fresh hook marker |

The stream also contained message start/stop and content-block events, assistant
thinking/text/tool-use blocks, system hook start/response notifications and
status events. The report records types and timing only; it does not retain
thinking, text, arguments or tool-result bodies. Unknown system subtypes remain
unclassified instead of being assigned invented semantics.

The selected hooks actually executed in this order:

- First process: SessionStart, UserPromptSubmit, PreToolUse/PostToolUse twice,
  Stop, SessionEnd.
- Compaction: SessionStart(source `resume`), PreCompact(trigger `manual`),
  SessionStart(source `compact`), PostCompact(trigger `manual`), SessionEnd.
- Resumed process: SessionStart, UserPromptSubmit, Stop, SessionEnd.

Prompt presence was observed at UserPromptSubmit, tool-use identity presence at
tool hooks, and latest-assistant-message presence at Stop. SessionEnd was present
in the temporary hook metadata journal even though the print result had already
been emitted. PostCompact included a summary field; only its presence was
retained. Native `compact_boundary`, both manual hooks and a clean successful
host result are required by the probe's success gate. Model prose claiming
compaction is insufficient. The continued session received and acknowledged
fresh context after this real compaction; summary fidelity and automatic
threshold compaction remain untested.

The original two-call measurement used a shared marker and did not compact.
The first three-call follow-up verified fresh markers but returned no compact
boundary or compaction hooks while `--disable-slash-commands` was present
(6,828 / 1,028 / 3,392 ms; capability gate failed). Removing that flag only for
the literal native `/compact` phase produced the successful measurement above.
The first attempt's response body was intentionally discarded, so its exact
diagnostic is unknown; the changed flag is the observed configuration difference.
The final parser retains only allowlisted diagnostic categories, never raw errors.
These two follow-up runs used six invocations total; no large-context filling,
automatic retries, or further live calls were needed. Installed help restricts
`--autocompact` to `auto` or 100k–1M tokens, so a native manual command is the
bounded mechanism used here.

## Integration admission and capture scope

Invocation flags select `--restricted`, empty built-in `--tools`, two exact
allowed MCP tools, `--strict-mcp-config`, empty settings sources,
no Chrome and a synthetic system prompt. Explicit settings exclude ordinary
CLAUDE/AGENTS instructions and auto-memory, and supply only this probe's hooks.
Managed host policy still applies. `--disable-slash-commands` is present on both
model turns and omitted only for the literal `/compact` command, which requests
no third-party skill. MCP and hooks are configured for these three
processes only; nothing is globally installed or changed.

`admitClaudeCollection` is a tested admission fixture, not the future authenticated
Collector. A trusted launcher registration supplies canonical project root,
selected session, activation and origin; admitted interactive events must match
all four. Worker, probe, unknown, disabled, other-project and other-session events
are rejected. The model's payload cannot select the origin. Real probe hook rows
all matched the temporary project/session and all had `collection_admitted:
false`, since their trusted origin was `probe`.

Later integration must obtain those facts from authenticated host enrollment and
the App's activation epoch. A caller-created JavaScript registration object is
not proof of access, identity continuity or activation. This fixture demonstrates
the exclusion rule without installing a recorder or pretending that these
programmatic tests are user-development events.

## Identity, ordering and failure limits

Stream UUIDs and assistant message IDs were present; multiple assistant blocks
in one model message shared that message ID. Reports replace raw IDs with
per-invocation labels. Session selection was checked against the explicit new UUID
in all three processes, including the compaction boundary. These observations do not prove durable replay identity,
cross-session uniqueness or crash deduplication. User echo is an input receipt;
tool results also use a user-unit envelope, so a Collector must distinguish them.

Stream order is local stdout arrival order. Hook journal timestamps are separate
wall-clock measurements, not a total causal clock. The journal and stdout are
not a transaction. A crash can lose either; no VibeHub cursor, durable ACK,
outbox or missed-event recovery was implemented. Clean exit/resume passed;
mid-turn interruption, crash resume and interrupted compaction recovery remain untested.

The bounded report projection drops raw IDs, paths, transcript pointers, prompt
and assistant text, tool bodies, diagnostics and usage objects. Canary tests
verify projection omissions. This is not a universal secret scanner. The probe
never reads credentials or existing transcripts. The CLI retains ownership of
saved login; `--bare` is deliberately absent because it disables subscription
login. API key environment variables are not inherited by the child.

The temporary project, hook journal and invocation state are removed in
`finally`. Claude's own persisted **synthetic** conversation can remain so the
explicit resume works; no other host session is listed, scanned or removed.

## Maintained mechanisms and product gaps

The [official programmatic usage guide](https://code.claude.com/docs/en/headless)
documents stream-json and saved-session continuation, and distinguishes bare
mode's API-key path from normal saved-login behavior. We reused the installed
executable instead of adding another SDK. This three-call observation applies to
programmatic mode; the interactive TTY and a real plugin require their own test.

The [official hooks reference](https://code.claude.com/docs/en/hooks) defines
prompt/tool/session lifecycle payloads and supported additional-context output.
This run verified those selected hooks and prompt-time context delivery. It did
not test unsolicited push into a running turn, automatic compaction, subagents,
hook failure recovery or changes to hooks during an existing interactive session.
Registering a hook is not evidence that every model message is exposed.
The [built-in commands reference](https://code.claude.com/docs/en/commands)
documents `/compact`; the hooks reference identifies it as the manual trigger.
The live result above measures that specific path instead of inferring it from
the presence of hook settings.

The [CLI reference](https://code.claude.com/docs/en/cli-reference) and installed
help expose invocation-only MCP/settings/plugin options, replayed user messages
and stream events. These probes supply their configuration before each process
starts; hot reload, plugin install/update and dynamic registration after startup
are untested. A production plugin should use maintained hooks/MCP first, then
measure coverage, latency and failure isolation in the user's normal workflow.

[Memory documentation](https://code.claude.com/docs/en/memory) specifies ordinary
instruction exclusions and managed-policy exceptions. Those exclusions reduce
incidental project input here; no private instruction or auth file was inspected.
The installed package's LICENSE says all rights reserved, with use governed by
Anthropic's [legal agreements](https://code.claude.com/docs/en/legal-and-compliance).
No Claude implementation or transcript parser was copied or redistributed, and
no dependency was added. A future packaged distribution must review its actual
distribution and service-use terms rather than assuming Apache/MIT licensing.

Search ledger: `opencli list -f yaml` preflight had no dedicated Anthropic docs
adapter. Official-domain web search used two queries once: “Claude Code
stream-json replay-user-messages hooks restricted MCP” and “Claude Code license
proprietary license”. Primary documentation above was opened directly; local
version/help/package metadata supplied the release-specific observations.
Follow-up preflight repeated the registry check, directly opened the official
headless, hooks, interactive-mode and commands pages, and used two compaction
queries. Only the linked primary documentation and local host measurements are
used for the follow-up conclusions.
