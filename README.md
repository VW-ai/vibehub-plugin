# VibeHub Workbench

VibeHub is a local-first context runtime for coding agents. Native Claude Code
and OpenAI Codex plugin manifests package one shared set of skills, one MCP
server, one CLI, and one SQLite database. The browser workbench is an optional
reader and intervention client: closing it never stops capture, retrieval, or
delivery.

SQLite is the only source of truth. JSON or Markdown output is an export for
people and tools, not a fallback database.

## Requirements

- Node.js 20 or newer
- pnpm 10.8.1
- Git
- Claude Code or OpenAI Codex for native plugin integration

## Install from source

```bash
pnpm install --frozen-lockfile
pnpm build
```

Initialize a repository and verify the local runtime:

```bash
node packages/cli/dist/main.js init --repo /path/to/repository
node packages/cli/dist/main.js doctor --repo /path/to/repository --json
```

`init` owns VibeHub's SQLite schema and managed plugin assets. It does not
silently replace user-owned Claude configuration. Re-running it is safe; use
`doctor --json` for machine-readable health and repair guidance.

Install this directory as a Claude Code plugin using Claude's local plugin
workflow. The plugin manifest is `.claude-plugin/plugin.json`; hooks, MCP, and
all six VibeHub workflow skills ship with the same directory.

### Install in OpenAI Codex

Build one disposable local marketplace from the same authored plugin tree:

```bash
pnpm build:codex-marketplace
codex plugin marketplace add "$(pwd)/dist/codex-marketplace"
codex plugin add vibehub@vibehub-local
```

The builder rebuilds the shared package `dist` outputs and writes the
marketplace under `dist/codex-marketplace`; it does not edit `~/.codex`,
`~/.agents`, or any target project. The two explicit `codex plugin` commands
perform the machine install. Start a new Codex task after installing, open
`/hooks`, and trust the reviewed VibeHub hook definitions. Then ask Codex to
use `$vibehub-setup` for the exact project checkout.

Codex reads `.codex-plugin/plugin.json`, which points at the same `skills/`
tree and at host-specific thin configs:

- `codex/mcp.json` starts the packaged MCP by installed relative path; the
  server derives repository identity from the Codex client's workspace roots;
- `codex/hooks.json` records `SessionStart`, `UserPromptSubmit`, and successful
  `apply_patch` completion through the shared CLI with explicit Codex host
  attribution.

This initial Codex hook boundary deliberately excludes `Stop`, `SessionEnd`,
notifications, and failure-only Claude events. It therefore does not claim
stop-time wake-up, automatic `done`, or complete read-footprint parity. See
`skills/vibehub-setup/references/codex.md` for the exact evidence and
degradation contract.

## Headless operation

The CLI and MCP server call the same deterministic core. No API key or LLM is
required by either executable.

```bash
# Refresh git/team facts in SQLite.
node packages/cli/dist/main.js team sync --repo /path/to/repository --json

# Inspect the runtime's current map without opening the app.
node packages/cli/dist/main.js snapshot --repo /path/to/repository
node packages/cli/dist/main.js inspect --repo /path/to/repository

# Write an explicit disposable export.
node packages/cli/dist/main.js snapshot \
  --repo /path/to/repository \
  --out /tmp/vibehub-snapshot.json
```

`team snapshot` remains a compatibility alias for existing integrations.

Agent knowledge creation, distillation, and querying are owned by the three
skills. Hooks decide when to remind the agent; MCP capabilities validate and
persist deterministic operations. Workflow intelligence does not live in hook
descriptions or the CLI.

### MCP v0.2 operation surface

The advertised tools are `register_scope`, `self_report`, `kb_retrieve`,
`kb_operation`, `distill_operation`, and `get_manual`. `kb_operation` and
`distill_operation` are thin adapters over the same versioned operations used
by the CLI; use `vibehub-ingest` and `vibehub-distill` for semantic workflow.

MCP v0.2 removes the legacy `kb_record` and `kb_apply_distillation` names.
Neither legacy tool could honestly satisfy the current evidence-backed,
versioned persistence contracts. Clients must route canonical KB writes
through `kb_operation` and distillation runs through `distill_operation` (or
the equivalent `vibehub kb` / `vibehub distill` CLI commands).

Repository request IDs bind operation plus canonical actor, task (or null), and
input; timestamps are deliberately excluded. Once `repoId` and `requestId` are
syntactically usable, success, typed handler failure, input-validation failure,
and unsupported-operation failure all reserve and replay that identity.
Context failures without both a positive repository ID and canonical request
ID cannot address a receipt and therefore remain unreceipted.

For MCP operation adapters, `requestId` is an optional top-level tool argument,
separate from operation `input`. Supply it only when the caller needs stable
logical replay; otherwise the capability generates a collision-resistant UUID.
MCP transport correlation IDs are never persisted as repository request IDs.

## Optional workbench UI

The current app host is for local development and dogfood. It is not a native
downloadable build yet. Point it at one explicit repository; it reads the same
SQLite runtime through the browser-safe bridge and never substitutes fixtures
when the runtime is unavailable.

```bash
VIBEHUB_REPO=/path/to/repository pnpm --filter @vibehub/workbench-app dev
```

## Verification

```bash
# Build; typecheck; run unit tests; exercise the production main.tsx entry with
# Playwright; scan the production bundle; verify the packaged plugin; then run
# the headless dogfood flow.
pnpm verify

# Copy only workbench/ to a temporary directory, install from its own lockfile,
# then run the full gate there. This is the subtree/repository split gate.
pnpm verify:isolated

# Build the local Codex marketplace and verify that the installed Codex CLI
# accepts and installs it in an isolated HOME/CODEX_HOME.
pnpm verify:codex-plugin

# Exercise init, hooks, MCP context CRU, snapshot/App bridge, and Stop delivery
# against an isolated temporary Git repository and SQLite state.
pnpm dogfood
```

The Playwright production lane boots the real `src/main.tsx` entry; the
historical harness suite remains separate parity evidence. The production
bundle gate rejects fixture imports—including dynamic chunks—and scans emitted
JavaScript for fixture or canned-data markers. The artifact smoke validates the
Claude manifest, `hooks/hooks.json`, and `.mcp.json`, plus the Codex manifest
and thin host configs. One shared artifact builder stages the CLI, MCP, and
skills once. The Claude smoke expands `CLAUDE_PLUGIN_ROOT` and invokes the
configured hook and MCP commands; corrupt-path negatives prove the configs—not
verifier-local shortcuts—are the invocation source. The Codex smoke builds a
local marketplace, points a real installed `codex` CLI at isolated
`HOME`/`CODEX_HOME`, and requires marketplace plus plugin ingestion to succeed.
It then starts a real `codex app-server` thread in an isolated Git repository
and requires the installed VibeHub MCP status to reach `ready`; a verifier-local
`node` launch is not accepted as host evidence.
The remaining checks create SQLite through the packaged native dependency and
run sync and snapshot outside the source monorepo without starting the App.

The bundled `plugin-creator` preflight currently trails Codex 0.144.1 in three
known ways: it rejects the documented `hooks` manifest field, requires
`mcpServers` to use the default root `.mcp.json` instead of a manifest-selected
host config, and treats progressive resource directories such as `_stdlib`,
`contracts`, and `scripts` as independent skills that need their own
`SKILL.md`. The checked-in skill graph validator, structural assertions, and
real local Codex ingestion are the release gates for those exact drift cases.
Re-run the bundled preflight too; any finding outside this enumerated set still
fails review.

`pnpm verify:isolated` copies only this `workbench/` subtree, installs solely
from its own workspace and lockfile, and invokes that same complete `verify`
matrix.

Set `VIBEHUB_KEEP_TMP=1` to retain a failed isolated copy or artifact for
inspection. Set `VIBEHUB_OFFLINE=1` only when all required package tarballs are
already available in the pnpm store.

## Repository boundary

Everything required by the future public repository lives under this directory.
Code here must not import server-side VibeHub packages. Until dogfood validates
the boundary, development remains in the monorepo and preserves history for a
later `git subtree split`.

## License

Apache-2.0. See [LICENSE](LICENSE).
