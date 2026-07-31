# OpenAI Codex host procedure

Codex and Claude Code consume one VibeHub runtime. They share the same packaged
skills, CLI, MCP server, runtime state, Git common-root repository identity,
worktree binding, operation receipts, and activation vocabulary. Never create
a host-specific state store or a second instruction/state language.

The managed block that setup owns in `AGENTS.md` is the Codex-facing project
instruction. Codex builds its instruction chain from the checkout at session
start, so after a changeful apply start a fresh Codex session in the exact
checkout that was inspected and applied.

## Install the native Codex plugin from this source tree

The source build creates a disposable local marketplace outside the authored
plugin tree. It copies the shared skills once and deploys the same CLI/MCP
runtime used by Claude Code; there is no second Codex implementation.

```bash
pnpm build:codex-marketplace
codex plugin marketplace add "$(pwd)/dist/codex-marketplace"
codex plugin add vibehub@vibehub-local
```

`build:codex-marketplace` writes a thin marketplace under
`dist/codex-marketplace`; the installed Plugin's versioned runtime launcher
loads the shared core/CLI/MCP packages. The build does not edit user HOME or a
target project. The two `codex plugin` commands are the explicit
machine-install step and update Codex's own local plugin state.
After installation:

1. Open an interactive Codex CLI in the target checkout and use `/hooks` to
   review the exact VibeHub plugin hook definitions and trust them. A Codex
   desktop task may launch and drive this CLI flow when its terminal and
   permission policy allow; otherwise, instruct the user to run it manually.
   The desktop app does not expose `/hooks`; it reuses trust stored in shared
   Codex configuration. Installing or enabling a plugin does not automatically
   trust hooks, and changed hook definitions require review again.
2. Exit the pre-trust CLI session and start a fresh task on the intended Codex
   surface in the target checkout so the trusted `SessionStart`, plugin skills,
   MCP server, and project instructions load together. Desktop users do not
   repeat hook approval.
3. Ask Codex to use `$vibehub-setup` for the exact checkout. Let the skill run
   the canonical `setup inspect`, `setup apply`, and `setup status` sequence.

If the marketplace was already added, rebuilding it is safe. Re-run
`codex plugin add vibehub@vibehub-local` to refresh Codex's installed copy,
then start another new task.

## Packaged host components

- `.codex-plugin/plugin.json` points at the canonical `skills/` tree.
- `codex/mcp.json` starts `./runtime/vibehub-runtime.mjs mcp` from plugin-root
  `cwd: "."`. The launcher resolves the version-matched shared MCP package,
  which requests the Codex client's workspace roots and derives repository
  identity from the one Git root; Claude/older clients retain the
  inherited-project-cwd fallback. No absolute development path is embedded.
- `codex/hooks.json` invokes the shared CLI with `--host codex`. Codex supplies
  `PLUGIN_ROOT` and compatibility `CLAUDE_PLUGIN_ROOT` to plugin hooks.
- The thin Plugin's CLI remains available through
  `runtime/vibehub-runtime.mjs cli`. Packaged Skill wrappers resolve that
  launcher from their own installed Plugin root when no explicit
  `VIBEHUB_BIN` or source-tree CLI is available.

If the MCP server is disabled, hook trust is pending, the project is untrusted,
or an enterprise policy permits managed hooks only, stop and report the exact
host condition. Do not bypass hook trust or hand-write activation evidence.

## Codex lifecycle evidence in this release

The Codex adapter intentionally uses three documented mechanical events:

| Event | VibeHub use |
| --- | --- |
| `SessionStart` | host-attributed session handshake, Ticket-first protocol when the canonical Ticket ledger exists or context-first protocol otherwise, pending context delivery |
| `UserPromptSubmit` | user-turn evidence, task-scoped checkpoint cadence, shadow checkpoint in Ticket-managed checkouts or reminder delivery in context-only checkouts, pending context delivery |
| `PostToolUse` matching `apply_patch` | successful edit footprints, off-scope reminder, pending context delivery |

The adapter maps Codex `turn_id` to a host-namespaced prompt identity for
idempotent checkpoint counting. `apply_patch` paths are mechanically extracted
from the patch; VibeHub does not parse arbitrary Bash commands to guess reads or
writes.

Connected requires a real, trusted Codex `SessionStart` ingestion after the
current instruction blocks for the exact checkout. Installed plugin files,
synthetic hook fixtures, a marketplace receipt, or persisted hook trust alone
do not prove Connected. Activated still requires a later meaningful query or
ingest receipt; Ticket frontier or Run activity and hook activity alone do not
prove context value.

Immediately after install or before the first trusted SessionStart,
`setup status` may correctly report `waiting` with Connected and Activated
`not_proven`. Re-run it from the fresh trusted session; never rewrite
persistent state to make the state advance.

## Deliberate capability boundary

Available on Codex now:

- project instructions through the managed `AGENTS.md` block;
- all packaged workflow skills and the shared MCP tool surface;
- the full CLI and the same deterministic operation receipts;
- host-attributed session and user-turn evidence;
- Ticket-first SessionStart guidance plus shadow checkpoint cadence when the
  canonical Ticket ledger exists;
- context-first SessionStart guidance plus checkpoint reminders when the
  Ticket ledger does not exist;
- governed Context query and durable cross-Ticket ingest in both modes;
- optional `register_scope` and `self_report` coordination in both modes;
- queued context delivery at SessionStart or UserPromptSubmit;
- successful `apply_patch` edit footprints, off-scope reminders, and
  post-edit delivery.

Intentionally absent from the Codex hook package in this release:

- `Stop`: no stop-time self-report, waiting transition, or immediate
  stop-boundary wake-up delivery;
- `SessionEnd`: no automatic session close or `done` transition;
- `Notification`: no automatic question event;
- Claude-specific `PostToolUseFailure` and `StopFailure`;
- inferred read footprints from Bash or hosted tools.

These absences are a bounded signal downgrade, not a reason to add a watcher,
poller, transcript parser, or semantic hook state machine. A Codex task can
therefore remain `running` until later evidence makes the read side derive it
as stale; report that limitation honestly.

## Forbidden on Codex

- Do not tail host logs, watch files, poll for activity, or parse arbitrary
  shell commands to imitate missing lifecycle evidence.
- Do not add `Stop`, `SessionEnd`, or failure events to the Codex config until
  their VibeHub semantics and attribution are separately validated.
- Do not write sessions or receipts by hand, edit managed markers, bypass hook
  trust, or present `not_proven` as proven.
- Keep intelligence in the workflow skills. Hooks record mechanical facts and
  deliver already-decided context; they do not decide what knowledge is
  durable.
