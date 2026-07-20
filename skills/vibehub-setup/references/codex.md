# OpenAI Codex host procedure

Codex and Claude Code consume one VibeHub runtime. They share the same packaged
skills, CLI, MCP server, SQLite database (default
`~/.vibehub/workbench.db`, or `VIBEHUB_DB`), Git common-root repository
identity, worktree binding, operation receipts, and activation vocabulary.
Never create a Codex-specific database or a second instruction/state language.

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

`build:codex-marketplace` rebuilds the shared core/CLI/MCP package `dist`
directories and writes the marketplace under
`dist/codex-marketplace`; it does not edit user HOME or a target
project. The two `codex plugin` commands are the explicit machine-install step
and update Codex's own local plugin state.
After installation:

1. Start a new Codex task in the target checkout so the plugin skills, MCP
   server, and project instructions load together.
2. Open `/hooks`, review the exact VibeHub plugin hook definitions, and trust
   them. Installing or enabling a plugin does not automatically trust hooks;
   changed hook definitions require review again.
3. Ask Codex to use `$vibehub-setup` for the exact checkout. Let the skill run
   the canonical `setup inspect`, `setup apply`, and `setup status` sequence.

If the marketplace was already added, rebuilding it is safe. Re-run
`codex plugin add vibehub@vibehub-local` to refresh Codex's installed copy,
then start another new task.

## Packaged host components

- `.codex-plugin/plugin.json` points at the canonical `skills/` tree.
- `codex/mcp.json` starts `./packages/mcp/dist/stdio.js` from plugin-root
  `cwd: "."`. The shared MCP requests the Codex client's workspace roots and
  derives repository identity from the one Git root; Claude/older clients
  retain the inherited-project-cwd fallback. No absolute development path is
  embedded.
- `codex/hooks.json` invokes the shared CLI with `--host codex`. Codex supplies
  `PLUGIN_ROOT` and compatibility `CLAUDE_PLUGIN_ROOT` to plugin hooks.
- The packaged CLI remains available beneath
  `packages/cli/dist/main.js`. The setup skill resolves it from its own
  installed plugin root when no explicit `VIBEHUB_BIN` or PATH executable is
  available.

If the MCP server is disabled, hook trust is pending, the project is untrusted,
or an enterprise policy permits managed hooks only, stop and report the exact
host condition. Do not bypass hook trust or hand-write activation evidence.

## Codex lifecycle evidence in this release

The Codex adapter intentionally uses three documented mechanical events:

| Event | VibeHub use |
| --- | --- |
| `SessionStart` | host-attributed session handshake, session protocol, pending context delivery |
| `UserPromptSubmit` | user-turn evidence, task-scoped checkpoint cadence, pending context delivery |
| `PostToolUse` matching `apply_patch` | successful edit footprints, off-scope reminder, pending context delivery |

The adapter maps Codex `turn_id` to a host-namespaced prompt identity for
idempotent checkpoint counting. `apply_patch` paths are mechanically extracted
from the patch; VibeHub does not parse arbitrary Bash commands to guess reads or
writes.

Connected requires a real, trusted Codex `SessionStart` ingestion after the
current instruction blocks for the exact checkout. Installed plugin files,
synthetic hook fixtures, a marketplace receipt, or `/hooks` approval alone do
not prove Connected. Activated still requires a later meaningful query or
ingest receipt; hook activity alone does not prove context value.

Immediately after install or before the first trusted SessionStart,
`setup status` may correctly report `waiting` with Connected and Activated
`not_proven`. Re-run it from the fresh trusted session; never rewrite the
database to make the state advance.

## Deliberate capability boundary

Available on Codex now:

- project instructions through the managed `AGENTS.md` block;
- all six packaged workflow skills and all six MCP capabilities;
- the full CLI and the same deterministic operation receipts;
- host-attributed session and user-turn evidence;
- checkpoint reminders and queued context delivery at SessionStart or
  UserPromptSubmit;
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
