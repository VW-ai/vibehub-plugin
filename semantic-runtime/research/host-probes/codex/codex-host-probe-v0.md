# Codex host capability measurement v0

Measured 2026-09-22 on macOS with **Codex CLI 0.155.1**. This is a reproducible
integration inventory for the Collector Ticket, not an installed Codex plugin
or capture of the user's existing Desktop conversations.

## Reproduce the selected synthetic path

```sh
node --test test/codex-host-probe.test.mjs
node scripts/probe-codex-host.mjs --live-synthetic
```

Without the explicit live flag the script prints usage and makes no model call.
The live probe creates an empty temporary Git repository, supplies a tiny local
stdio MCP server, starts one short `codex exec --json` turn, and resumes only
the exact newly returned thread ID in a second CLI process. Maximum: two turns,
90 seconds each, no retry. An unavailable CLI/login/model is a failed observation,
not permission to read credentials, reauthenticate or choose another provider.

User config and exec rules are ignored for this invocation. Shell/unified exec,
web, plugins, apps, multi-agent and image tools are disabled; project instruction
loading is zero and the skills catalog budget is one token. Explicit developer
instructions prohibit exploration of files, environment, credentials or other
sessions. Child environment excludes API keys. Codex owns its normal saved-login
handling; the probe never opens auth files or checks account credentials. It does
not verify account type or billing route. These are invocation overrides, not
changes to the user's configuration.

The temporary repository is removed in `finally`. The CLI's normal persisted
history may retain this **synthetic** thread so exact-ID resume can work; the
probe does not scan or delete host history. It never uses `--last`, thread lists,
existing IDs, transcript paths, or project payloads.

## Actual observations

Both CLI processes exited 0, completed their turns and emitted the exact requested
assistant acknowledgements. The second process returned the same thread identity.
No timeout, malformed stream or error event occurred.
The [sanitized report](measurements/codex-host-20260922.json) retains only the
allowlisted timing/lifecycle fields described below.

| Observation | First turn | Exact-ID resume / next turn |
| --- | --- | --- |
| Process duration | 21,105 ms | 6,292 ms |
| Thread / turn start | 683 / 710 ms | 158 / 162 ms |
| MCP item started/completed pairs | 9,682–9,683 ms; 16,929–16,931 ms | None requested or observed |
| Assistant completed | 20,011 ms | 5,618 ms |
| Turn completed | 20,036 ms | 5,632 ms |
| Exact synthetic assistant ack | `VH_CONTEXT_ACK` | `VH_NEXT_TURN_ACK` |

The MCP fixture registers `get_context` and `ack_context` with concrete schemas.
Query returns a fixed synthetic fact and a fresh nonce; acknowledgement succeeds
only for that nonce after query. The requested first-turn sequence produced two
completed MCP items and the final ack. Output deliberately omits tool bodies and
tool names; this observation is not an independent durable service receipt. The
separate next-turn ack proves explicit next-turn input reached this resumed
synthetic session, not unsolicited delivery into arbitrary running sessions.

One additional first-turn `item.completed` was outside the probe's known item
allowlist. It remains an opaque event in the report; it is not evidence of a
user message, reasoning coverage or a silently recognized new host unit.

## Capture and delivery matrix

| Capability | Result / limitation |
| --- | --- |
| User input | Probe owns the outgoing synthetic prompt. CLI JSONL in these runs did not provide a user-message item. A Collector must capture admitted input at a supported boundary separately. |
| Assistant output | Completed `agent_message` observed in both runs. No assistant delta or start event was observed; intermediate/raw model coverage is unproven. |
| Tool lifecycle | MCP item start and completion observed; each pair retained the same host item identity within that invocation. Shell, edits, subagents and other tool categories were not exercised. |
| Ordering | Report sequence and elapsed time reflect stdout arrival within each process. They are not global or causal clocks. |
| Event identity | Thread continuity observed across two processes. Item labels are local to each report; cross-process item uniqueness and replay stability are unproven. A future adapter needs an invocation/turn namespace and its own durable ingress identity. |
| Restart | Clean completion then exact-ID resume passed. Crash mid-turn, transport reconnect, missed-item replay and duplicate suppression were not exercised. |
| Query/tool registration | Real stdio MCP server and two tool lifecycles observed. No installation or broad recorder was required. |
| Return delivery | Explicit resumed next-turn input and assistant acknowledgement passed. This does not validate an app-server callback, hook context insertion or arbitrary push. |
| Compaction | Not triggered or observed. Capability remains a gap for the later Collector. |
| Desktop/plugin integration | Not tested; owning a new CLI session is different from observing the user's existing Desktop sessions. |

The [official non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode)
describes CLI JSONL and exact-ID resume. The observations above are narrower than
all event types the documentation lists. In particular, JSONL output is not a
guarantee that every underlying model message becomes a public host event.

## Other reusable host surfaces

Local `codex app-server generate-json-schema --experimental --out <temp-dir>`
confirmed the installed binary's `thread/start.dynamicTools`, `item/tool/call`
request/response, `turn/start`, `thread/read`, `thread/resume` and
`thread/compact/start` schemas. `ThreadStartParams.json` SHA-256:
`25f490368ec6df52a2a3b82a5469d2413307eb93439121b309f415b5648eee7a`.
These schemas were generated outside the repository; no generated dependency was
added. App-server itself lacks exec's `--ignore-user-config` flag in this release,
so the live probe selected the isolated exec path.

The [official App Server reference](https://learn.chatgpt.com/docs/app-server)
documents experimental dynamic-tool callbacks, item lifecycle notifications,
explicit turn/steer inputs, paginated history and compaction items. These are
useful alternatives when VibeHub owns the app-server connection. Schema presence
and documentation do not establish live callback delivery, restart replay or
access to unrelated Desktop sessions. Raw internal event mode is not selected.

[Official hooks documentation](https://learn.chatgpt.com/docs/hooks) describes
prompt, tool, stop and compaction hooks, plus host-supported context additions at
particular lifecycle points. It also warns that the transcript format is unstable.
Hooks are the candidate for an installed plugin, but none were installed or
triggered here. A stop hook's latest assistant text cannot establish complete
message capture. Hook trust, payload/version support, latency, failure isolation
and compaction coverage require later real plugin conformance.

The installed `@openai/codex` package metadata identifies version 0.155.1 and
Apache-2.0 licensing. We reuse its executable protocol, not copied internals;
the probe adds no SDK or parser dependency. Third-party token-usage/transcript
parsers were not selected: their counters cannot prove semantic-unit coverage,
and this task has no authorization to crawl existing private traces.

## Collection boundaries and remaining work

The report allows only event kind, known item kind, per-run pseudonymous item
label, sequence/time, process outcome and exact-synthetic-ack booleans. It drops
message text, tool arguments/results, diagnostics, raw host IDs, usage payloads,
paths and unknown item bodies. Canary tests verify that these fields cannot
reappear through the report projection. This is metadata minimization, not a
general secret scanner for future message ingestion. MCP fixture responses and
prompts are synthetic and the only intended provider input from this project.

No production cursor is implemented. Stdout observations are lost if the probe
crashes; the host's saved conversation is not a VibeHub ACK or replay contract.
The later Collector needs selected-project activation, durable local ingress,
bounded redaction/materialization, explicit missed-event gaps, verified host
identity mapping and restart reconciliation. It must not attach to private
history automatically or infer success from this one two-turn measurement.

Configuration controls were checked against the installed help and
[official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
Any changed host version requires rerunning the probe; it must not inherit this
version's observed coverage automatically.
